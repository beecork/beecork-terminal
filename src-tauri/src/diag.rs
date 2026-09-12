//! The crash & error log — the only record of what went wrong on a machine we
//! will never see.
//!
//! The app sends nothing anywhere (no telemetry, by design: it watches people's
//! source trees), and none of the places a crash would normally surface exist
//! for an installed copy: `main.rs` hides the console on Windows, a Finder /
//! launchd launch has no stderr, a panic inside an async command is swallowed by
//! the runtime (the invoke just never answers), and a panic on the main thread
//! closes the window with no message. A user's whole report is "it crashed".
//! This module gives every install one local file they can send us:
//!
//!   macOS    ~/Library/Logs/com.beecork.terminal/beecork-terminal.log
//!   Windows  %LOCALAPPDATA%\com.beecork.terminal\logs\beecork-terminal.log
//!   Linux    ~/.local/share/com.beecork.terminal/logs/beecork-terminal.log
//!
//! (all `app_log_dir()`; Settings shows the path and reveals the file). It holds
//! one line per launch (version, OS, arch), every Rust panic on ANY thread with
//! its location and backtrace — `set_hook` is process-global, so the pty writer
//! and reader threads, the watcher and the async runtime are all covered — and
//! whatever the webview reports through `log_event`: uncaught JS errors,
//! unhandled promise rejections, and React render crashes caught by
//! `ErrorBoundary` (`src/lib/diag.ts`).
//!
//! What it cannot see: a native crash below Rust — a segfault inside WebKit or
//! WebView2, a stack overflow, a kill by Gatekeeper. Those reach only the OS
//! crash reporter (Console.app → Crash Reports on macOS; Reliability Monitor /
//! Event Viewer on Windows). Even then the launch line helps: a launch with no
//! later entry, at the time of the report, says the process died outside Rust.
//!
//! Everything in here runs INSIDE the panic hook, so nothing in here may panic:
//! no `unwrap`, no `expect`, every I/O error dropped on the floor.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const LOG_NAME: &str = "beecork-terminal.log";
/// Roll the file to `.log.1` past this size so it never grows without bound and
/// stays small enough to attach to a message.
const ROLL_AT_BYTES: u64 = 1_000_000;
/// The webview can send anything (a stack trace, a giant JSON payload it choked
/// on); keep one entry bounded so a runaway error can't fill the disk.
const MAX_EVENT_BYTES: usize = 16 * 1024;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Wire the log file and the panic hook. Call once, first thing in `setup` — a
/// panic in anything registered after it (the updater plugin, the watcher
/// thread) is then on record.
pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if LOG_PATH.set(dir.join(LOG_NAME)).is_err() {
        return; // already initialised
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let backtrace = std::backtrace::Backtrace::force_capture();
        append(
            "PANIC",
            &format!(
                "thread '{}': {info}\n{backtrace}",
                thread.name().unwrap_or("?")
            ),
        );
        // Still print it where a `tauri dev` run or a terminal launch can see it.
        previous(info);
    }));
    append(
        "launch",
        &format!(
            "Beecork Terminal {} on {} {}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
}

/// Where the log lives — `None` before `init`, or when no log directory could be
/// created (a read-only home, a sandbox).
pub fn path() -> Option<&'static Path> {
    LOG_PATH.get().map(|p| p.as_path())
}

fn append(kind: &str, message: &str) {
    if let Some(path) = LOG_PATH.get() {
        append_to(path, kind, message);
    }
}

/// One entry: `2026-09-12 19:40:03Z [kind] message`. A multi-line message (a
/// backtrace, a component stack) stays multi-line; the timestamp starts a new
/// entry, so the file is still easy to scan by eye.
fn append_to(path: &Path, kind: &str, message: &str) {
    roll_if_large(path);
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(f, "{} [{kind}] {}", timestamp(), message.trim_end());
}

fn roll_if_large(path: &Path) {
    let large = std::fs::metadata(path)
        .map(|m| m.len() > ROLL_AT_BYTES)
        .unwrap_or(false);
    if large {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

/// Cut a message at `MAX_EVENT_BYTES` on a char boundary, marking the cut.
fn bounded(mut message: String) -> String {
    if message.len() > MAX_EVENT_BYTES {
        let mut cut = MAX_EVENT_BYTES;
        while !message.is_char_boundary(cut) {
            cut -= 1;
        }
        message.truncate(cut);
        message.push_str("… [truncated]");
    }
    message
}

/// `YYYY-MM-DD HH:MM:SSZ` from std alone — no chrono in the tree for one line.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    timestamp_at(secs)
}

fn timestamp_at(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian. Howard
/// Hinnant's `civil_from_days`, transcribed; exact for every date we can log.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// An entry from the webview — the errors it has no other outlet for. `kind` is
/// a short tag (`js-error`, `js-rejection`, `react-crash`); anything else in it
/// is dropped so the file's `[kind]` column stays greppable.
#[tauri::command(async)]
pub fn log_event(kind: String, message: String) {
    let kind: String = kind
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    let kind = if kind.is_empty() { "webview" } else { kind.as_str() };
    append(kind, &bounded(message));
}

#[derive(Serialize)]
pub struct DiagInfo {
    version: String,
    os: String,
    arch: String,
    /// `None` when there is no log file (see `path`).
    log_path: Option<String>,
}

/// What Settings shows under "Diagnostics" — version, platform, log location.
/// A pure lookup, so it stays a sync command (see the threading rule in fs.rs).
#[tauri::command]
pub fn diag_info() -> DiagInfo {
    DiagInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        log_path: path().map(|p| p.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_utc_civil_dates() {
        assert_eq!(timestamp_at(0), "1970-01-01 00:00:00Z");
        assert_eq!(timestamp_at(1_700_000_000), "2023-11-14 22:13:20Z");
        assert_eq!(timestamp_at(951_782_400), "2000-02-29 00:00:00Z"); // leap day
        assert_eq!(timestamp_at(1_789_244_417), "2026-09-12 20:20:17Z");
    }

    #[test]
    fn entries_append_one_per_line_and_keep_multiline_bodies() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.log");
        append_to(&p, "launch", "Beecork Terminal 0.0.0 on test x");
        append_to(&p, "PANIC", "thread 'main': panicked at x.rs:1:1:\nboom\n   0: frame\n");
        let s = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = s.lines().collect();
        assert!(lines[0].ends_with("Z [launch] Beecork Terminal 0.0.0 on test x"));
        assert!(lines[1].contains("[PANIC] thread 'main': panicked at x.rs:1:1:"));
        assert_eq!(lines[2], "boom");
        assert_eq!(lines[3], "   0: frame", "trailing newline trimmed, body kept");
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn rolls_the_file_once_it_is_large() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.log");
        std::fs::write(&p, vec![b'x'; ROLL_AT_BYTES as usize + 1]).unwrap();
        append_to(&p, "launch", "fresh");
        assert!(std::fs::read_to_string(&p).unwrap().contains("[launch] fresh"));
        let rolled = std::fs::metadata(d.path().join("t.log.1")).unwrap();
        assert_eq!(rolled.len(), ROLL_AT_BYTES + 1);
    }

    #[test]
    fn bounds_an_event_on_a_char_boundary() {
        let big = "é".repeat(MAX_EVENT_BYTES); // 2 bytes each
        let b = bounded(big);
        assert!(b.ends_with("… [truncated]"));
        assert!(b.len() <= MAX_EVENT_BYTES + "… [truncated]".len());
        assert_eq!(bounded("short".into()), "short");
    }
}
