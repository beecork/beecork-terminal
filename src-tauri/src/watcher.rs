// Watches the project folder and emits `fs-changed` to the frontend whenever
// relevant files change — driving the live diff refresh.
//
// Watch strategy is platform-specific on purpose:
//   • macOS (FSEvents) / Windows (ReadDirectoryChangesW) watch a whole subtree
//     recursively from a SINGLE stream, so we place one Recursive watch on the
//     root. Adding a NonRecursive watch per directory instead is pathological on
//     macOS: `notify` tears down and rebuilds the entire FSEvents stream on every
//     `.watch()` call, so watching thousands of dirs pegs a CPU core.
//   • Linux (inotify) has no native recursion and a per-descriptor cost, so there
//     we keep a NonRecursive watch per non-ignored directory (and add watches for
//     newly-created dirs) — which also avoids placing watches inside
//     node_modules/.git/target and exhausting inotify on large repos.
//
// Either way we refuse to watch filesystem-wide roots (`/`, the home dir): a
// Finder-launched app has cwd `/`, and watching that would walk the whole disk.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
// NOT `#[cfg(linux)]`: `drain_window` inspects the event kind on every platform.
use notify::EventKind;
use tauri::{AppHandle, Emitter, Manager};

const IGNORED: &[&str] = &[".git", "node_modules", "target", "dist", ".DS_Store"];

/// How long to gather filesystem events before emitting one batch. A bulk
/// operation — a `git checkout`, an `npm install`, an agent rewriting a tree —
/// delivers roughly one notify event per path, and without this each one crossed
/// IPC and woke the webview separately. 100 ms sits well inside the frontend's
/// 300 ms per-subscriber debounce, so the live diff is no slower in practice.
const COALESCE_MS: u64 = 100;

/// Lets the UI re-root the watcher when the terminal `cd`s elsewhere. Holds the
/// sender into the live watch loop; `set_watch_root` posts a `Reroot` to it.
#[derive(Default)]
pub struct WatchControl {
    tx: Mutex<Option<Sender<WatchMsg>>>,
}

enum WatchMsg {
    Event(notify::Result<notify::Event>),
    Reroot(PathBuf),
}

fn is_ignored(p: &Path) -> bool {
    p.components().any(|comp| {
        matches!(comp, std::path::Component::Normal(os)
            if IGNORED.contains(&os.to_string_lossy().as_ref()))
    })
}

/// Refuse filesystem-wide roots. A Finder-launched app has cwd `/`, so without
/// this guard `watch_root` would walk (nearly) the entire disk on startup —
/// pinning a core forever. We wait for the UI to send a real project folder via
/// `set_watch_root` instead. Rejects `/`, the home dir, and any ancestor of home
/// (e.g. `/Users`). A GUI launch still gets HOME even when it gets no shell cwd,
/// so `fs::home()` is reliable enough to keep us out of all of `~`.
fn too_broad_to_watch(p: &Path) -> bool {
    is_broad_root(p, crate::fs::home().as_deref())
}

/// Pure core of [`too_broad_to_watch`], split out so it is unit-testable without
/// touching the process environment. A root is "too broad" if it is `/`, the home
/// directory, or any ancestor of home (e.g. `/Users`) — because a Finder launch
/// gives cwd `/`, and watching that walks the whole disk. If `p` is home itself or
/// an ancestor of home, then `home` starts with `p`.
fn is_broad_root(p: &Path, home: Option<&Path>) -> bool {
    if p == Path::new("/") {
        return true;
    }
    matches!(home, Some(home) if home.starts_with(p))
}

/// Register watches for `root` using the platform's efficient strategy. See the
/// module header for why this differs by OS.
fn watch_root(watcher: &mut RecommendedWatcher, root: &Path) {
    #[cfg(target_os = "linux")]
    {
        watch_tree(watcher, root);
    }
    #[cfg(not(target_os = "linux"))]
    {
        // One recursive stream covers the whole subtree cheaply. Events from
        // node_modules/.git/target still arrive but are filtered before emit.
        let _ = watcher.watch(root, RecursiveMode::Recursive);
    }
}

/// Can we actually place a watch on `p`? Split out so the `set_watch_root`
/// command can answer the UI with the same predicate the loop applies.
fn watchable(p: &Path) -> bool {
    p.is_dir() && !too_broad_to_watch(p)
}

/// A directory we can descend into — must be a real directory, NOT a symlink
/// (following symlinks lets a hostile repo escape the tree and loop / exhaust
/// inotify). `symlink_metadata` does not follow the leaf.
#[cfg(target_os = "linux")]
fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

/// Add NonRecursive watches to `dir` and every non-ignored, non-symlink
/// subdirectory beneath it. Linux/inotify only — see the module header.
#[cfg(target_os = "linux")]
fn watch_tree<W: Watcher>(watcher: &mut W, dir: &Path) {
    let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            // `file_type` here does NOT follow symlinks, so symlinked dirs are
            // skipped (avoids watch loops).
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let name = e.file_name();
                if IGNORED.contains(&name.to_string_lossy().as_ref()) {
                    continue;
                }
                watch_tree(watcher, &e.path());
            }
        }
    }
}

/// Gather `first` plus everything arriving within `window` into ONE deduplicated,
/// ignore-filtered path list. Returns `(paths, reroot)`.
///
/// Three things here are load-bearing:
///   • A `Reroot` returns IMMEDIATELY rather than waiting out the window, so
///     re-rooting stays exactly as responsive as it was — the file browser must
///     not visibly lag the terminal's `cd`.
///   • `on_create` runs per EVENT, not per batch: the batch is just strings and
///     has lost the event kinds, and Linux/inotify depends on this call to watch
///     newly-created directories.
///   • An empty returned list means "nothing relevant changed" and the caller
///     must NOT emit it — an empty payload is the re-root signal (`events.ts`).
fn drain_window(
    first: WatchMsg,
    rx: &Receiver<WatchMsg>,
    window: Duration,
    mut on_create: impl FnMut(&Path),
) -> (Vec<String>, Option<PathBuf>) {
    let mut batch: BTreeSet<String> = BTreeSet::new();
    let mut pending = Some(first);
    let deadline = Instant::now() + window;
    while let Some(msg) = pending.take() {
        match msg {
            WatchMsg::Event(Ok(event)) => {
                if matches!(event.kind, EventKind::Create(_)) {
                    for p in &event.paths {
                        on_create(p);
                    }
                }
                batch.extend(
                    event
                        .paths
                        .iter()
                        .filter(|p| !is_ignored(p))
                        .map(|p| p.to_string_lossy().into_owned()),
                );
            }
            WatchMsg::Event(Err(_)) => {}
            WatchMsg::Reroot(new) => return (batch.into_iter().collect(), Some(new)),
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        pending = rx.recv_timeout(left).ok();
    }
    (batch.into_iter().collect(), None)
}

/// Build a fresh watcher wired to `tx`. Dropping the returned watcher releases
/// all of its kernel watches, which is how re-rooting cleans up the old tree.
fn make_watcher(tx: Sender<WatchMsg>) -> Option<RecommendedWatcher> {
    notify::recommended_watcher(move |res| {
        let _ = tx.send(WatchMsg::Event(res));
    })
    .ok()
}

/// Blocking watch loop — run this on its own thread.
pub fn watch_project(app: AppHandle) {
    let (tx, rx) = channel();
    // Publish the sender so `set_watch_root` can reach this loop.
    if let Some(ctrl) = app.try_state::<WatchControl>() {
        // Poison-tolerant, like the pty session map: a panic elsewhere must not
        // permanently sever the UI's only way to re-root the watcher, which
        // would leave the file browser and the live diff pointing at the old
        // folder for the rest of the session with no error anywhere.
        *ctrl.tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx.clone());
    }

    let mut root = crate::fs::project_root();
    let mut watcher = match make_watcher(tx.clone()) {
        Some(w) => w,
        None => return,
    };
    // Only watch a real project root. If we launched with a filesystem-wide cwd
    // (Finder → `/`), stay idle until the UI sends a proper folder via reroot.
    if too_broad_to_watch(&root) {
        eprintln!("watcher: refusing to watch broad root {root:?}; awaiting set_watch_root");
    } else {
        watch_root(&mut watcher, &root);
    }

    loop {
        let Ok(first) = rx.recv() else { return }; // all senders dropped
        let (changed, reroot) = drain_window(
            first,
            &rx,
            Duration::from_millis(COALESCE_MS),
            |p| {
                let _ = p; // used on Linux only
                // On Linux, keep the tree covered as new directories appear
                // (inotify is non-recursive). On macOS/Windows the recursive
                // watch already covers new subdirs, so there is nothing to add.
                #[cfg(target_os = "linux")]
                if !is_ignored(p) && is_real_dir(p) {
                    watch_tree(&mut watcher, p);
                }
            },
        );
        // NEVER emit an empty list here: an empty payload is the RE-ROOT signal
        // ("everything changed") and bypasses every subscriber's path filter.
        if !changed.is_empty() {
            let _ = app.emit("fs-changed", changed);
        }
        if let Some(new) = reroot {
            // A same-folder re-root stays a no-op: App re-fires `set_watch_root`
            // on every `terminalCwd` change, and emitting here would cost a full
            // re-list plus a `git_status` on every status tick that re-reports
            // the same cwd.
            if new != root {
                if watchable(&new) {
                    // Drop the old watcher (releasing all its watches) and build a
                    // fresh one rooted at `new`, so the live diff follows the
                    // terminal when it cd's outside the launch directory.
                    if let Some(w) = make_watcher(tx.clone()) {
                        watcher = w;
                        root = new;
                        watch_root(&mut watcher, &root);
                    }
                } else {
                    // Refusing the WATCH is deliberate (see `too_broad_to_watch`);
                    // the panel silently freezing because of it is not. The UI has
                    // already moved to `new` — it listed it, ran `git_status` on
                    // it — so it must not keep showing the OLD folder's data just
                    // because we declined to watch the new one. Say so, and still
                    // refresh once below.
                    eprintln!(
                        "watcher: refusing broad/absent root {new:?}; live updates are off there"
                    );
                }
                // Empty payload = "everything changed" (a re-root), so
                // path-filtered subscribers still refresh.
                let _ = app.emit("fs-changed", Vec::<String>::new());
            }
        }
    }
}

/// Re-root the file watcher to follow the active terminal's working directory.
///
/// Returns whether that folder is one we will actually watch. The loop is the
/// real decider, but its verdict is `watchable`, whose only non-trivial half is
/// the pure `too_broad_to_watch` predicate — so answering here is honest and
/// saves the UI a round trip. `false` means "the panel is correct right now but
/// will not update itself here", which the panel says out loud instead of
/// silently freezing.
///
/// `command(async)` because `is_dir()` is a stat — see the threading rule in
/// CLAUDE.md. It was sync while it only took a lock and sent on a channel.
#[tauri::command(async)]
pub fn set_watch_root(control: tauri::State<WatchControl>, root: String) -> bool {
    let p = PathBuf::from(root);
    if let Some(tx) = control.tx.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = tx.send(WatchMsg::Reroot(p.clone()));
    }
    watchable(&p)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The predicate `set_watch_root` answers the UI with, and the loop applies.
    #[test]
    fn watchable_refuses_broad_and_absent_roots() {
        // `/` short-circuits in `is_broad_root` before HOME is consulted, so this
        // is hermetic.
        assert!(!watchable(Path::new("/")));
        // The `is_dir()` half — a path that is not a directory at all.
        assert!(!watchable(Path::new("/no/such/dir/here")));
    }

    // Guards the CPU-runaway regression: a Finder launch (cwd `/`) must never make
    // the watcher walk the whole disk. `/`, home, and home's ancestors are refused.
    #[test]
    fn refuses_filesystem_wide_roots() {
        let home = Path::new("/Users/me");
        assert!(is_broad_root(Path::new("/"), Some(home)), "root /");
        assert!(is_broad_root(Path::new("/Users"), Some(home)), "ancestor of home");
        assert!(is_broad_root(home, Some(home)), "home itself");
        assert!(is_broad_root(Path::new("/"), None), "root even without HOME");
    }

    #[test]
    fn allows_real_project_folders() {
        let home = Path::new("/Users/me");
        assert!(!is_broad_root(Path::new("/Users/me/Coding/app"), Some(home)));
        assert!(!is_broad_root(Path::new("/opt/app"), Some(home)));
        assert!(!is_broad_root(Path::new("/opt/app"), None));
    }

    fn ev(kind: EventKind, paths: &[&str]) -> WatchMsg {
        let mut e = notify::Event::new(kind);
        for p in paths {
            e = e.add_path(PathBuf::from(*p));
        }
        WatchMsg::Event(Ok(e))
    }

    #[test]
    fn coalesces_a_burst_into_one_deduplicated_batch() {
        let (tx, rx) = channel();
        tx.send(ev(EventKind::Any, &["/p/b.rs", "/p/a.rs"])).unwrap();
        tx.send(ev(EventKind::Any, &["/p/a.rs"])).unwrap(); // repeat
        tx.send(ev(EventKind::Any, &["/p/node_modules/x.js"])).unwrap(); // ignored
        let (paths, reroot) = drain_window(
            ev(EventKind::Any, &["/p/a.rs"]),
            &rx,
            Duration::from_millis(20),
            |_| {},
        );
        assert_eq!(paths, vec!["/p/a.rs".to_string(), "/p/b.rs".to_string()]);
        assert!(reroot.is_none());
    }

    // A reroot must not wait out the window, or the file browser visibly lags
    // the terminal's `cd`. Paths gathered before it still come back.
    #[test]
    fn a_reroot_ends_the_window_immediately() {
        let (tx, rx) = channel();
        tx.send(WatchMsg::Reroot(PathBuf::from("/new"))).unwrap();
        let start = Instant::now();
        let (paths, reroot) = drain_window(
            ev(EventKind::Any, &["/p/a.rs"]),
            &rx,
            Duration::from_secs(5),
            |_| {},
        );
        assert!(start.elapsed() < Duration::from_secs(1), "must not wait out the window");
        assert_eq!(reroot, Some(PathBuf::from("/new")));
        assert_eq!(paths, vec!["/p/a.rs".to_string()]);
    }

    // Linux/inotify watches new directories through this hook, and it must fire
    // per EVENT — the batch is strings and has lost the event kinds.
    #[test]
    fn create_events_report_every_path_to_the_hook() {
        let (tx, rx) = channel();
        tx.send(ev(EventKind::Create(notify::event::CreateKind::Folder), &["/p/two"]))
            .unwrap();
        let mut seen: Vec<String> = Vec::new();
        drain_window(
            ev(EventKind::Create(notify::event::CreateKind::Folder), &["/p/one"]),
            &rx,
            Duration::from_millis(20),
            |p| seen.push(p.to_string_lossy().into_owned()),
        );
        assert_eq!(seen, vec!["/p/one".to_string(), "/p/two".to_string()]);
    }

    // An all-ignored burst must yield NO batch — never an empty one, which the
    // frontend reads as "everything changed" and which bypasses path filters.
    #[test]
    fn an_all_ignored_burst_yields_no_paths() {
        let (_tx, rx) = channel();
        let (paths, reroot) = drain_window(
            ev(EventKind::Any, &["/p/.git/HEAD"]),
            &rx,
            Duration::from_millis(20),
            |_| {},
        );
        assert!(paths.is_empty());
        assert!(reroot.is_none());
    }

    #[test]
    fn ignores_build_and_vcs_dirs() {
        assert!(is_ignored(Path::new("/p/node_modules/x/y.js")));
        assert!(is_ignored(Path::new("/p/.git/HEAD")));
        assert!(is_ignored(Path::new("/p/target/debug/app")));
        assert!(!is_ignored(Path::new("/p/src/main.rs")));
    }
}
