// PTY bridge: spawns a real pseudo-terminal in Rust, streams its output to the
// webview over a Tauri Channel, and accepts input / resize from the frontend.

use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

/// Events streamed to the frontend over a Tauri Channel.
/// Serialized as `{ "event": "output", "data": "<base64>" }` etc.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    /// base64-encoded raw bytes from the pty
    Output(String),
    /// the child process exited (exit code, or -1 if unknown)
    Exit(i32),
}

/// The live pty, if one is running. Only one terminal for now (the spike).
#[derive(Default)]
pub struct PtyState {
    inner: Mutex<Option<PtyHandle>>,
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
    on_event: Channel<PtyEvent>,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Kill any existing pty before starting a new one.
    if let Some(mut old) = state.inner.lock().unwrap().take() {
        let _ = old.child.kill();
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    // Default to the user's login shell; they can then run `claude`, etc.
    let program =
        shell.unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    let mut cmd = CommandBuilder::new(program);
    cmd.env("TERM", "xterm-256color");
    // Open the shell in the same folder the file browser is rooted at.
    let dir = cwd.unwrap_or_else(|| crate::fs::project_root().to_string_lossy().into_owned());
    cmd.cwd(dir);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    // Drop the slave so the child is the only holder — lets us detect EOF.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Reader thread: pump pty output → base64 → Channel until EOF.
    let ch = on_event.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if ch.send(PtyEvent::Output(encoded)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = ch.send(PtyEvent::Exit(-1));
    });

    *state.inner.lock().unwrap() = Some(PtyHandle {
        master: pair.master,
        writer,
        child,
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, data: String) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    if let Some(h) = guard.as_mut() {
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
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    if let Some(h) = guard.as_ref() {
        h.master
            .resize(size(cols, rows))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyState>) -> Result<(), String> {
    if let Some(mut h) = state.inner.lock().unwrap().take() {
        let _ = h.child.kill();
    }
    Ok(())
}
