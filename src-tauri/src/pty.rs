// PTY bridge: spawns real pseudo-terminals in Rust, one per session id, streams
// their output to the webview over Tauri Channels, and accepts input / resize.
// Sessions keep running in the background until explicitly killed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

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
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<PtyState>,
    id: String,
    on_event: Channel<PtyEvent>,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Replace any existing session with this id (e.g. a dev remount).
    if let Some(mut old) = state.sessions.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    let program =
        shell.unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    let mut cmd = CommandBuilder::new(program);
    cmd.env("TERM", "xterm-256color");
    let dir = cwd.unwrap_or_else(|| crate::fs::project_root().to_string_lossy().into_owned());
    cmd.cwd(dir);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let ch = on_event.clone();
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
    });

    state.sessions.lock().unwrap().insert(
        id,
        PtyHandle {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut guard = state.sessions.lock().unwrap();
    if let Some(h) = guard.get_mut(&id) {
        h.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        h.writer.flush().map_err(|e| e.to_string())?;
    }
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
    if let Some(mut h) = state.sessions.lock().unwrap().remove(&id) {
        let _ = h.child.kill();
    }
    Ok(())
}
