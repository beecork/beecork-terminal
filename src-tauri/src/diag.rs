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
//! (the same directories Tauri's `app_log_dir()` names; Settings shows the path
//! and reveals the file). It holds, per run, a `[launch]` line (version, OS,
//! arch) and a `[ready]` line; every Rust panic on ANY thread with its location
//! and backtrace — `set_hook` is process-global, so the pty writer and reader
//! threads, the watcher and the async runtime are all covered — and whatever
//! the webview reports through `log_event`: uncaught JS errors, unhandled
//! promise rejections, and React render crashes caught by `ErrorBoundary`
//! (`src/lib/diag.ts`).
//!
//! `[launch]` is written by `init`, the FIRST line of `run()` — before GTK,
//! WebKit or WebView2 initialise — and `[ready]` by `ready`, from `setup`,
//! which Tauri calls only AFTER the config windows and their webviews exist.
//! That ordering is the point: window creation is exactly where Linux hangs
//! (a process that is alive with a window that never fills in — CLAUDE.md
//! "Linux") and where a signature or architecture problem kills a Mac launch.
//! So a `[launch]` with no `[ready]` after it means "the window never came
//! up", and the log dir is resolved here with `dirs` rather than through an
//! `AppHandle` precisely so the launch line can predate all of that.
//!
//! What it cannot see: a native crash below Rust — a segfault inside WebKit or
//! WebView2, a stack overflow, a kill by Gatekeeper. Those reach only the OS
//! crash reporter (Console.app → Crash Reports on macOS; Reliability Monitor /
//! Event Viewer on Windows). Even then the two markers place the death.
//!
//! Everything in here runs INSIDE the panic hook, so nothing in here may panic:
//! no `unwrap`, no `expect`, every I/O error dropped on the floor.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Must equal `identifier` in tauri.conf.json — it names the log directory the
/// same way Tauri names every other per-app directory. Pinned by a test that
/// reads the config file.
const APP_ID: &str = "com.beecork.terminal";
const LOG_NAME: &str = "beecork-terminal.log";
/// Roll the file to `.log.1` past this size so it never grows without bound and
/// stays small enough to attach to a message.
const ROLL_AT_BYTES: u64 = 1_000_000;
/// The webview can send anything (a stack trace, a giant JSON payload it choked
/// on); keep one entry bounded so a runaway error can't fill the disk.
const MAX_EVENT_BYTES: usize = 16 * 1024;
/// What ONE RUN may append before the log stops accepting entries from it.
/// Deliberately far below `ROLL_AT_BYTES` so a single run can cause AT MOST ONE
/// roll — and therefore can never destroy the previous run's `.log.1`, and its
/// own `[launch]`/`[ready]`/`[painted]` are always in one of the two files.
/// Before this, a repeating panic wrote an UNBOUNDED backtrace per occurrence:
/// the watcher emits up to ten batches a second (`watcher::COALESCE_MS`), so a
/// deterministic panic in a command it drives filled the 1 MB budget in about
/// four seconds and erased `.log.1` about four seconds later — leaving the user
/// with N copies of one stack and none of the three markers that are the
/// actual diagnosis.
const RUN_BUDGET_BYTES: u64 = 256 * 1024;
/// Charged against the budget on top of each entry's own text, for the timestamp
/// and the tag. Without it a storm of one-byte entries blows past
/// `ROLL_AT_BYTES` in per-line overhead alone while the budget still reads as
/// unspent — 256K one-byte entries is ~13 MB of timestamps.
const ENTRY_OVERHEAD: u64 = 64;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Where the log directory is: what Tauri's `app_log_dir()` resolves to on each
/// OS (macOS `~/Library/Logs/<id>`, elsewhere `<local data dir>/<id>/logs`),
/// computed without Tauri so it is available before anything else exists.
fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library/Logs").join(APP_ID))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|d| d.join(APP_ID).join("logs"))
    }
}

/// Open the log and install the panic hook. Call once, as the FIRST line of
/// `run()`: everything after it — GTK/WebKit init, window creation, plugins,
/// the watcher thread — is then on record, and the `[launch]` line predates
/// the step that hangs or dies on the platforms we cannot see.
pub fn init() {
    let Some(dir) = log_dir() else {
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
        append("PANIC", &panic_body(thread.name().unwrap_or("?"), info, &backtrace));
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

/// The window and its webview exist. Call from `setup`, which Tauri runs only
/// after creating the config windows — so `[launch]` without `[ready]` is the
/// signature of a window that never came up.
pub fn ready() {
    append("ready", "window and webview created");
}

/// Where the log lives — `None` before `init`, or when no log directory could be
/// created (a read-only home, a sandbox).
pub fn path() -> Option<&'static Path> {
    LOG_PATH.get().map(|p| p.as_path())
}

fn append(kind: &str, message: &str) {
    let Some(path) = LOG_PATH.get() else {
        return;
    };
    // `launch` and `ready` are written once per run by this file itself, and
    // `linux-smoke.yml` greps for both — CLAUDE.md calls those strings an
    // interface. A panic storm between `init()` and `setup()` must never cost us
    // either one, so they skip the gate entirely. Everything else goes through
    // it, `painted` included: that one arrives from the webview through
    // `log_event`, so it is not ours to treat as once-per-run.
    if kind == "launch" || kind == "ready" {
        append_to(path, kind, message);
        return;
    }
    match GATE.admit(kind, message) {
        Admit::Write => append_to(path, kind, message),
        Admit::Final => {
            append_to(path, kind, message);
            append_to(
                path,
                kind,
                "… this run's log budget is spent — further entries are dropped so the markers above survive",
            );
        }
        Admit::Repeat(n) => append_to(path, kind, &format!("… the entry above repeated {n}×")),
        Admit::Drop => {}
    }
}

/// The `[PANIC]` body, bounded exactly like a webview event. A `force_capture()`
/// backtrace is tens of KB, and the panic that matters is the one that REPEATS —
/// see `RUN_BUDGET_BYTES`. `bounded` cuts from the tail, so the thread name, the
/// panic location and the message always survive.
fn panic_body(
    thread: &str,
    info: &dyn std::fmt::Display,
    backtrace: &dyn std::fmt::Display,
) -> String {
    bounded(format!("thread '{thread}': {info}\n{backtrace}"))
}

/// One entry: `2026-09-12 19:40:03Z [kind] message`. A multi-line message (a
/// backtrace, a component stack) stays multi-line; the timestamp starts a new
/// entry, so the file is still easy to scan by eye.
fn append_to(path: &Path, kind: &str, message: &str) {
    roll_if_large(path);
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    // ONE `write_all`, not `writeln!`. `f` is an unbuffered `File`, and
    // `Write::write_fmt` drives `fmt::write`, whose adapter calls `write_all`
    // once per literal piece and once per argument — six syscalls for this
    // format string. `O_APPEND` makes each land atomically at the end of the
    // file, but nothing groups them, so a second thread appending at the same
    // moment interleaves at a piece boundary: `[`, `PANIC` and `]` are three
    // different pieces, so the TAG ITSELF could be split in half. `[PANIC]` is
    // an interface — `linux-smoke.yml` greps for it, and so does whoever reads a
    // log a user sent. Concurrent appends are the norm here: the panic hook is
    // process-global and fires on any thread, and `log_event` is an async
    // command running on a tokio worker alongside it — and a cascade where
    // several threads fail together is exactly when the log matters most. A
    // single `write(2)` to a regular file under `O_APPEND` is serialized by the
    // kernel against other appenders, so one buffer is one atomic entry.
    let line = format!("{} [{kind}] {}\n", timestamp(), message.trim_end());
    let _ = f.write_all(line.as_bytes());
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

/// What the gate says to do with an entry.
#[derive(Debug, PartialEq, Eq)]
enum Admit {
    /// Write it.
    Write,
    /// Write it, then one line saying this run's budget is spent.
    Final,
    /// Byte-identical to the entry before it — write only a running count.
    Repeat(u64),
    /// Write nothing (an unreported repeat, or past the budget).
    Drop,
}

/// Collapses consecutive identical entries and caps what one run may write.
///
/// ATOMICS ONLY — never a `Mutex`, `RwLock`, `RefCell` or `OnceLock` holding a
/// lock. This is reached from inside the panic hook, where a poisoned lock, a
/// contended lock or a re-entrant borrow is precisely the failure the file
/// exists to record. Nothing here allocates, indexes, unwraps, or can overflow:
/// every arithmetic operation wraps or saturates rather than panicking in a
/// debug build.
///
/// Two threads panicking with DIFFERENT messages thrash `last` and neither
/// collapses. That is a degradation, not a break — the budget is the hard
/// backstop, and the realistic case is one repeating fault driven by the watcher
/// on one thread.
struct Gate {
    /// Hash of the last admitted entry; `0` means "nothing yet", which is why
    /// `entry_hash` never returns 0.
    last: AtomicU64,
    /// How many times that entry has repeated since.
    repeats: AtomicU64,
    /// Text bytes admitted this run, each charged `ENTRY_OVERHEAD` on top.
    bytes: AtomicU64,
}

impl Gate {
    const fn new() -> Self {
        Self {
            last: AtomicU64::new(0),
            repeats: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        }
    }

    fn admit(&self, kind: &str, message: &str) -> Admit {
        let h = entry_hash(kind, message);
        if self.last.swap(h, Ordering::Relaxed) == h {
            // `fetch_add` wraps rather than panicking; `saturating_add` keeps the
            // `+ 1` from panicking in a debug build. Both are unreachable (2^64
            // repeats), and both are written this way because "nothing here may
            // panic" has to hold by construction, not by argument.
            let n = self.repeats.fetch_add(1, Ordering::Relaxed).saturating_add(1);
            // Report at 1, 2, 4, 8 …: the count stays current within a factor of
            // two even when the process is killed mid-storm — a total flushed
            // only on the NEXT distinct entry would be lost exactly then — and a
            // billion repeats cost thirty lines. Repeat lines are not charged to
            // the budget: they are O(log N) per distinct message and ~40 bytes.
            return if n.is_power_of_two() {
                Admit::Repeat(n)
            } else {
                Admit::Drop
            };
        }
        self.repeats.store(0, Ordering::Relaxed);
        let charge = (message.len() as u64).saturating_add(ENTRY_OVERHEAD);
        let before = self.bytes.fetch_add(charge, Ordering::Relaxed);
        if before >= RUN_BUDGET_BYTES {
            Admit::Drop
        } else if before.saturating_add(charge) >= RUN_BUDGET_BYTES {
            Admit::Final
        } else {
            Admit::Write
        }
    }
}

/// Process-global, `const`-initialised: no lazy init, so there is no
/// initialisation path that could run — or fail — inside the panic hook.
static GATE: Gate = Gate::new();

/// FNV-1a over `kind` and `message`: allocation-free, branch-free and wrapping —
/// what the panic hook needs, and no new dependency for eight lines (the same
/// reasoning as the transcribed `civil_from_days` below). We only ever compare
/// it with the IMMEDIATELY PRECEDING hash, so collision quality beyond
/// "different text hashes differently" is irrelevant. Never returns 0, which
/// `Gate::last` reserves for "nothing logged yet".
fn entry_hash(kind: &str, message: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in kind.bytes().chain(message.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h | 1
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
    fn app_id_matches_the_tauri_config() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains(&format!("\"identifier\": \"{APP_ID}\"")),
            "APP_ID must equal tauri.conf.json's identifier — the log directory is named by it"
        );
    }

    #[test]
    fn log_dir_is_where_tauri_would_put_it() {
        let d = log_dir().expect("a home directory exists on the test machine");
        let s = d.to_string_lossy();
        assert!(s.contains(APP_ID), "{s}");
        if cfg!(target_os = "macos") {
            assert!(s.contains("Library/Logs"), "{s}");
        } else {
            assert!(s.ends_with("logs"), "{s}");
        }
    }

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

    // M6: the log used to destroy itself fastest under exactly the conditions it
    // exists for — a REPEATING fault. These pin the two mechanisms that stop it.
    // A local `Gate`, never the `GATE` static: cargo runs these in one process in
    // parallel, so shared state would make them pollute each other.

    #[test]
    fn the_panic_body_is_bounded_like_any_other_entry() {
        let huge = "F".repeat(MAX_EVENT_BYTES * 4); // a force_capture() backtrace
        let body = panic_body("worker", &"panicked at src/x.rs:1:1: boom", &huge);
        assert!(body.ends_with("… [truncated]"));
        assert!(body.len() <= MAX_EVENT_BYTES + "… [truncated]".len());
        // The head must survive: it carries the thread, the location and the message.
        assert!(body.starts_with("thread 'worker': panicked at src/x.rs:1:1: boom"));
    }

    #[test]
    fn consecutive_identical_entries_collapse_to_a_doubling_count() {
        let g = Gate::new();
        assert_eq!(g.admit("PANIC", "same"), Admit::Write);
        // Reported at 1, 2, 4, 8 … so the count survives a kill mid-storm.
        let reported: Vec<u64> = (0..16)
            .filter_map(|_| match g.admit("PANIC", "same") {
                Admit::Repeat(n) => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(reported, vec![1, 2, 4, 8, 16]);
        // A different entry starts a fresh streak rather than being swallowed.
        assert_eq!(g.admit("PANIC", "other"), Admit::Write);
    }

    #[test]
    fn one_run_cannot_spend_more_than_its_budget() {
        let g = Gate::new();
        let chunk = "x".repeat(8 * 1024);
        let mut written = 0u64;
        let mut final_seen = false;
        // Distinct messages, so repeat-suppression cannot be what stops it.
        for i in 0..200 {
            match g.admit("PANIC", &format!("{i}{chunk}")) {
                Admit::Write => written += 1,
                Admit::Final => {
                    final_seen = true;
                    written += 1;
                }
                Admit::Drop => {}
                Admit::Repeat(_) => panic!("distinct messages must not read as repeats"),
            }
        }
        assert!(final_seen, "the run must announce that its budget is spent");
        // Far below the ~122 entries that would reach ROLL_AT_BYTES, so one run
        // can cause at most one roll and never destroys the previous run's log.
        assert!(written < 40, "wrote {written} entries");
    }

    #[test]
    fn the_launch_and_ready_markers_are_never_gated() {
        // Not a Gate test: `append` routes them around it entirely, because
        // linux-smoke.yml greps for both and a panic storm must not cost either.
        let g = Gate::new();
        for _ in 0..5 {
            // Proof the gate WOULD have swallowed them, which is why append skips it.
            g.admit("launch", "same");
        }
        assert_eq!(g.admit("launch", "same"), Admit::Drop);
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
