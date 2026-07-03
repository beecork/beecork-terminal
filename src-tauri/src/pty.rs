// PTY bridge: spawns real pseudo-terminals in Rust, one per session id, streams
// their output to the webview over Tauri Channels, and accepts input / resize.
// Sessions keep running in the background until explicitly killed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Distinguishes handles that reused the same session id, so a dying reader
/// thread only reaps the session it actually owns (not a fresh respawn).
static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    /// base64-encoded raw bytes from the pty
    Output(String),
    /// the child process exited
    Exit(i32),
}

/// One live pty per session id. Sessions persist until killed.
#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtyHandle>>,
}

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    /// Wrapped so `pty_write` can clone it out of the map and write WITHOUT
    /// holding the global sessions lock across a blocking write.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// The window label that owns this session, for window-close teardown.
    owner: String,
    token: u64,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Platform-appropriate default shell when the webview doesn't specify one.
fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

/// Remove a session under lock, then kill+reap it with the lock released.
fn take_and_reap(state: &PtyState, id: &str) {
    let removed = state.sessions.lock().unwrap().remove(id);
    if let Some(mut h) = removed {
        let _ = h.child.kill();
        let _ = h.child.wait();
    }
}

/// Kill every session owned by a given window label (called on window close).
pub fn kill_by_owner(state: &PtyState, label: &str) {
    let removed: Vec<PtyHandle> = {
        let mut g = state.sessions.lock().unwrap();
        let ids: Vec<String> = g
            .iter()
            .filter(|(_, h)| h.owner == label)
            .map(|(k, _)| k.clone())
            .collect();
        ids.into_iter().filter_map(|id| g.remove(&id)).collect()
    };
    for mut h in removed {
        let _ = h.child.kill();
        let _ = h.child.wait();
    }
}

#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<PtyState>,
    app: AppHandle,
    window: tauri::Window,
    id: String,
    on_event: Channel<PtyEvent>,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let owner = window.label().to_string();
    // Replace any existing session with this id (e.g. a dev remount).
    take_and_reap(&state, &id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    let program = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(program);
    cmd.env("TERM", "xterm-256color");
    let dir = cwd.unwrap_or_else(|| crate::fs::project_root().to_string_lossy().into_owned());
    cmd.cwd(dir);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let token = SEQ.fetch_add(1, Ordering::Relaxed);

    // Reader thread: pump output, then on EOF reap the child + drop the session.
    let ch = on_event.clone();
    let app = app.clone();
    let thread_id = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if ch.send(PtyEvent::Output(encoded)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = ch.send(PtyEvent::Exit(-1));
        // Reap only if the map still holds THIS handle (not a respawn).
        if let Some(state) = app.try_state::<PtyState>() {
            let removed = {
                let mut g = state.sessions.lock().unwrap();
                if g.get(&thread_id).map(|h| h.token) == Some(token) {
                    g.remove(&thread_id)
                } else {
                    None
                }
            };
            if let Some(mut h) = removed {
                let _ = h.child.wait();
            }
        }
    });

    state.sessions.lock().unwrap().insert(
        id,
        PtyHandle {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
            owner,
            token,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    // Clone the writer handle out from under the map lock, then write without
    // holding it — so one blocked session can't freeze the others.
    let writer = {
        let guard = state.sessions.lock().unwrap();
        match guard.get(&id) {
            Some(h) => h.writer.clone(),
            None => return Ok(()),
        }
    };
    let mut w = writer.lock().unwrap();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.sessions.lock().unwrap();
    if let Some(h) = guard.get(&id) {
        h.master
            .resize(size(cols, rows))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyState>, id: String) -> Result<(), String> {
    take_and_reap(&state, &id);
    Ok(())
}
