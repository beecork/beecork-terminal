// PTY bridge: spawns real pseudo-terminals in Rust, one per session id, streams
// their output to the webview over Tauri Channels, and accepts input / resize.
// Sessions keep running in the background until explicitly killed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
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
    /// Input is enqueued here and drained by a dedicated per-session writer
    /// thread. `pty_write` only sends (never blocks), so a child that isn't
    /// reading stdin can't stall the IPC/main thread, and FIFO channel order
    /// preserves keystroke order.
    input: Sender<Vec<u8>>,
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

/// Where a shell opens when no cwd is supplied and none is configured. A bundled
/// `.app` launches with cwd `/` (the drive root — a useless place to land), so we
/// fall back to the user's home directory instead. Only `/` if HOME is unset.
fn fallback_cwd() -> String {
    let var = if cfg!(target_os = "windows") { "USERPROFILE" } else { "HOME" };
    std::env::var(var).unwrap_or_else(|_| "/".to_string())
}

/// Does the inherited environment already select a UTF-8 character set? Follows
/// POSIX precedence — LC_ALL wins, then LC_CTYPE, then LANG — and the first *set*
/// (non-empty) one decides: a UTF-8 value means we're covered, a non-UTF-8 value
/// means the user deliberately chose a non-UTF-8 locale and we leave it be. Pure,
/// so it's unit-tested.
fn env_selects_utf8(lc_all: Option<&str>, lc_ctype: Option<&str>, lang: Option<&str>) -> bool {
    for v in [lc_all, lc_ctype, lang] {
        match v {
            Some(v) if !v.is_empty() => {
                let low = v.to_ascii_lowercase();
                return low.contains("utf-8") || low.contains("utf8");
            }
            _ => continue,
        }
    }
    false
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
    // Present as ourselves, not whatever terminal launched the app. The child
    // inherits our full environment (portable-pty copies std::env::vars_os),
    // so an inherited TERM_PROGRAM=Apple_Terminal makes /etc/zshrc source
    // Apple's shell-session integration *inside our pty* — the "Restored
    // session:" banner and per-tab history files fought over with the real
    // Terminal. Give the child a clean, honest identity instead.
    cmd.env("TERM_PROGRAM", "Beecork");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env("COLORTERM", "truecolor");
    // Scrub the identity markers of whatever host terminal launched us, so tools
    // that feature-detect a terminal (iTerm2 integration, Windows Terminal, VS
    // Code) don't mistake our pty for that host and emit foreign escapes.
    for k in [
        "TERM_SESSION_ID",
        "LC_TERMINAL",
        "LC_TERMINAL_VERSION",
        "ITERM_SESSION_ID",
        "ITERM_PROFILE",
        "WT_SESSION",
        "WT_PROFILE_ID",
        "VSCODE_GIT_IPC_HANDLE",
        "VSCODE_GIT_ASKPASS_NODE",
    ] {
        cmd.env_remove(k);
    }
    // Only drop GIT_ASKPASS when it routes into VS Code — leave a deliberate one.
    if std::env::var("GIT_ASKPASS")
        .map(|v| {
            let v = v.to_lowercase();
            v.contains("vscode") || v.contains("code")
        })
        .unwrap_or(false)
    {
        cmd.env_remove("GIT_ASKPASS");
    }
    // Guarantee the shell a UTF-8 locale. A Finder/Dock-launched .app inherits NO
    // locale (unlike a terminal-launched dev build, which gets the user's LANG),
    // so the shell falls back to single-byte C mode and mangles every multibyte
    // character — Georgian, emoji, accents — rendering each as <XXXX> and
    // desyncing the line editor's cursor math on history recall. Every real
    // terminal sets this. We only fill a *fallback* when the inherited env doesn't
    // already select UTF-8, so a user's own locale choice is never overridden.
    #[cfg(unix)]
    if !env_selects_utf8(
        std::env::var("LC_ALL").ok().as_deref(),
        std::env::var("LC_CTYPE").ok().as_deref(),
        std::env::var("LANG").ok().as_deref(),
    ) {
        // en_US.UTF-8 always exists on macOS; C.UTF-8 is the portable default
        // elsewhere. Only LC_CTYPE is set — the one category that governs
        // multibyte handling — so we don't force message language on the user.
        let utf8 = if cfg!(target_os = "macos") { "en_US.UTF-8" } else { "C.UTF-8" };
        cmd.env("LC_CTYPE", utf8);
    }
    let dir = cwd.unwrap_or_else(fallback_cwd);
    cmd.cwd(dir);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let token = SEQ.fetch_add(1, Ordering::Relaxed);

    // Writer thread: the only place that blocks on pty input. `pty_write` merely
    // enqueues, so a child that isn't draining stdin can never stall the caller.
    // Ends when the sender is dropped (session teardown).
    let (input, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    // Insert the live handle BEFORE starting the reader thread, so that if the
    // child exits instantly the reader's token-guarded reap finds this entry
    // (otherwise it would miss and leave a zombie + stale map entry).
    state.sessions.lock().unwrap().insert(
        id.clone(),
        PtyHandle {
            master: pair.master,
            input,
            child,
            owner,
            token,
        },
    );

    // Reader thread: pump output, then on EOF reap the child + drop the session.
    let ch = on_event.clone();
    let app = app.clone();
    let thread_id = id;
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
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    // Enqueue to the session's writer thread and return immediately — never block
    // the IPC/main thread on a pty whose child isn't draining stdin. The channel
    // is unbounded, so the send can't block; FIFO order preserves keystrokes.
    let tx = {
        let guard = state.sessions.lock().unwrap();
        match guard.get(&id) {
            Some(h) => h.input.clone(),
            None => return Ok(()),
        }
    };
    let _ = tx.send(data.into_bytes());
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

#[derive(Serialize)]
pub struct PtyStatus {
    /// the shell's working directory (so the file browser follows `cd`)
    cwd: Option<String>,
    /// the foreground command running at the prompt (e.g. "claude"), if any
    running: Option<String>,
}

/// Live status for many sessions at once. ONE narrow process refresh serves the
/// whole batch, so the 2s poll costs a single cheap syscall burst rather than a
/// full process-table scan per session.
#[tauri::command]
pub fn pty_status_all(
    state: tauri::State<PtyState>,
    ids: Vec<String>,
) -> HashMap<String, PtyStatus> {
    let targets: Vec<(String, u32, Option<u32>)> = {
        let g = state.sessions.lock().unwrap();
        ids.into_iter()
            .filter_map(|id| session_pids(g.get(&id)?).map(|(s, f)| (id, s, f)))
            .collect()
    };
    statuses_for(targets)
}

const RUNTIMES: &[&str] = &[
    "node", "deno", "bun", "python", "python3", "ruby", "perl", "sh", "bash", "zsh", "fish", "env",
];
/// Agent names we label prettily when detected. This is *cosmetic labeling only*:
/// the busy/idle dot is driven by webview output-activity (frontend), not this
/// process check, so it stays fully agent-agnostic. This `running` label feeds
/// only the session title (displayName) and the "come look" attention path;
/// unknown tools fall back to their own command name. See the decision brief.
const KNOWN_TOOLS: &[&str] = &["claude", "codex", "aider", "gemini", "ollama", "cursor"];

/// The shell pid and the tty's current foreground pid for a session. The
/// foreground pid comes straight from the terminal (`tcgetpgrp`): it equals the
/// shell when the shell owns the terminal (idle prompt), otherwise it's the
/// running command's process-group leader — no child-guessing.
fn session_pids(h: &PtyHandle) -> Option<(u32, Option<u32>)> {
    let shell = h.child.process_id()?;
    // The tty's foreground process group is a unix concept (`tcgetpgrp`);
    // portable-pty only exposes `process_group_leader` on unix. On Windows we
    // don't detect the foreground command yet — so the `running` label is absent
    // there (the busy dot is output-activity based and works cross-platform; cwd
    // tracking works too).
    #[cfg(unix)]
    let fg = h.master.process_group_leader().map(|p| p as u32);
    #[cfg(not(unix))]
    let fg = None;
    Some((shell, fg))
}

/// Resolve cwd + running-command for a batch of (id, shell_pid, fg_pid) targets
/// with a SINGLE narrow sysinfo refresh (only the pids we care about).
fn statuses_for(targets: Vec<(String, u32, Option<u32>)>) -> HashMap<String, PtyStatus> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut pids: Vec<Pid> = Vec::with_capacity(targets.len() * 2);
    for (_, shell, fg) in &targets {
        pids.push(Pid::from_u32(*shell));
        if let Some(f) = fg {
            pids.push(Pid::from_u32(*f));
        }
    }
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing()
            .with_cwd(UpdateKind::Always)
            .with_cmd(UpdateKind::Always),
    );
    targets
        .into_iter()
        .map(|(id, shell, fg)| {
            let cwd = sys
                .process(Pid::from_u32(shell))
                .and_then(|p| p.cwd())
                .map(|c| c.to_string_lossy().into_owned());
            // fg == shell → shell owns the terminal → idle prompt.
            let running = match fg {
                Some(f) if f != shell => sys.process(Pid::from_u32(f)).and_then(command_label),
                _ => None,
            };
            (id, PtyStatus { cwd, running })
        })
        .collect()
}

/// Pretty label for a foreground process (reads its argv/name, then classifies).
fn command_label(p: &sysinfo::Process) -> Option<String> {
    let argv: Vec<String> = p.cmd().iter().map(|c| c.to_string_lossy().into_owned()).collect();
    let name = p.name().to_string_lossy().into_owned();
    classify_command(&name, &argv)
}

fn basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

fn script_stem(s: &str) -> &str {
    s.trim_end_matches(".js")
        .trim_end_matches(".mjs")
        .trim_end_matches(".cjs")
        .trim_end_matches(".ts")
        .trim_end_matches(".py")
        .trim_end_matches(".rb")
}

/// Label a foreground command from its process name + argv. Pure, so it's unit-
/// tested. Recognizes a known tool by the *basename of argv[0]* (exact, never a
/// substring over the whole line), and a runtime-wrapped tool (`node …/claude`)
/// by the stem of the first non-flag argument; falls back to the command's own
/// basename. `None` only when there's nothing to name.
fn classify_command(name: &str, argv: &[String]) -> Option<String> {
    let arg0_base = argv.first().map(|a| basename(a));
    // Direct invocation: `claude`, `codex`, …
    if let Some(b) = arg0_base {
        if KNOWN_TOOLS.contains(&b) {
            return Some(b.to_string());
        }
    }
    let cmd_name = arg0_base.unwrap_or(name);
    // Runtime wrapper (`node script.js`, `python manage.py`): name it by the
    // script it runs, not the runtime.
    if RUNTIMES.contains(&cmd_name) {
        if let Some(arg) = argv.iter().skip(1).find(|a| !a.starts_with('-')) {
            let stem = script_stem(basename(arg));
            if !stem.is_empty() {
                return Some(stem.to_string());
            }
        }
    }
    // Fallback: the command's own basename.
    if cmd_name.is_empty() {
        None
    } else {
        Some(cmd_name.to_string())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn resolves_own_status() {
        // Verifies the narrow process query works (cwd of our own process).
        let id = "self".to_string();
        let map = super::statuses_for(vec![(id.clone(), std::process::id(), None)]);
        assert!(map.get(&id).unwrap().cwd.as_deref().is_some_and(|c| !c.is_empty()));
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn utf8_locale_detection() {
        use super::env_selects_utf8 as u;
        // Nothing set (Finder-launched app) → needs a fallback.
        assert!(!u(None, None, None));
        // A UTF-8 value in any category is enough.
        assert!(u(None, None, Some("en_US.UTF-8")));
        assert!(u(None, Some("UTF-8"), None));
        assert!(u(Some("ka_GE.utf8"), None, None));
        // Precedence: the first *set* category decides. LC_ALL=C wins over a
        // UTF-8 LANG, so we must NOT claim UTF-8 (LC_ALL would override it anyway).
        assert!(!u(Some("C"), None, Some("en_US.UTF-8")));
        // LC_CTYPE=C beats a UTF-8 LANG for character handling.
        assert!(!u(None, Some("C"), Some("en_US.UTF-8")));
        // Empty strings are treated as unset and skipped.
        assert!(u(Some(""), Some(""), Some("en_US.UTF-8")));
        assert!(!u(Some(""), None, Some("POSIX")));
    }

    // Empirically confirm the running-command / foreground-group signal (which
    // feeds the session label + the "come look" attention path, not the dot): an
    // interactive shell's foreground process group (tcgetpgrp, via
    // process_group_leader) equals the shell at the prompt and DIFFERS while a
    // foreground command runs.
    #[cfg(unix)]
    #[test]
    fn foreground_group_tracks_the_running_command() {
        use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
        use std::io::{Read, Write};
        use std::time::Duration;

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-i");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let shell_pid = child.process_id().unwrap() as i32;

        // Drain output so the pty never blocks the shell.
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while reader.read(&mut buf).map(|n| n > 0).unwrap_or(false) {}
        });
        let mut writer = pair.master.take_writer().unwrap();

        let fg = |m: &Box<dyn MasterPty + Send>| m.process_group_leader();
        std::thread::sleep(Duration::from_millis(400));
        let idle = fg(&pair.master);
        writer.write_all(b"sleep 3\n").unwrap();
        writer.flush().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let busy = fg(&pair.master);
        let _ = child.kill();

        assert_eq!(idle, Some(shell_pid), "at the prompt the fg group is the shell");
        assert!(
            busy.is_some() && busy != Some(shell_pid),
            "while `sleep` runs the fg group should differ from the shell (idle={idle:?}, busy={busy:?})"
        );
    }

    #[test]
    fn classify_direct_tool() {
        assert_eq!(super::classify_command("claude", &argv(&["claude"])), Some("claude".into()));
        assert_eq!(
            super::classify_command("claude", &argv(&["/opt/homebrew/bin/claude"])),
            Some("claude".into())
        );
    }

    #[test]
    fn classify_runtime_wrapped_tool() {
        assert_eq!(
            super::classify_command("node", &argv(&["node", "/opt/bin/claude"])),
            Some("claude".into())
        );
    }

    #[test]
    fn classify_plain_runtime_script() {
        assert_eq!(
            super::classify_command("python3", &argv(&["python3", "manage.py", "runserver"])),
            Some("manage".into())
        );
    }

    #[test]
    fn classify_path_containing_tool_name_is_not_a_false_match() {
        // A file argument merely *containing* a tool name must not label the session.
        assert_eq!(
            super::classify_command("vim", &argv(&["vim", "/Users/me/notes/claude-tips.md"])),
            Some("vim".into())
        );
    }

    #[test]
    fn classify_unknown_command() {
        assert_eq!(super::classify_command("htop", &argv(&["htop"])), Some("htop".into()));
    }
}
