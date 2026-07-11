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

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(target_os = "linux")]
use notify::EventKind;
use tauri::{AppHandle, Emitter, Manager};

const IGNORED: &[&str] = &[".git", "node_modules", "target", "dist", ".DS_Store"];

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

/// The user's home directory, if the environment exposes it. A GUI (Finder)
/// launch still gets HOME even when it gets no shell cwd, so this is reliable
/// enough to keep us from watching all of `~`.
fn home_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Refuse filesystem-wide roots. A Finder-launched app has cwd `/`, so without
/// this guard `watch_root` would walk (nearly) the entire disk on startup —
/// pinning a core forever. We wait for the UI to send a real project folder via
/// `set_watch_root` instead. Rejects `/`, the home dir, and any ancestor of home
/// (e.g. `/Users`).
fn too_broad_to_watch(p: &Path) -> bool {
    is_broad_root(p, home_path().as_deref())
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
        *ctrl.tx.lock().unwrap() = Some(tx.clone());
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

    for msg in rx {
        match msg {
            WatchMsg::Event(Ok(event)) => {
                // On Linux, keep the tree covered as new directories appear (inotify
                // is non-recursive). On macOS/Windows the recursive watch already
                // covers new subdirs, so there is nothing to re-add.
                #[cfg(target_os = "linux")]
                if matches!(event.kind, EventKind::Create(_)) {
                    for p in &event.paths {
                        if !is_ignored(p) && is_real_dir(p) {
                            watch_tree(&mut watcher, p);
                        }
                    }
                }
                // Emit the changed (non-ignored) paths so the frontend can skip
                // refetches that don't concern it (e.g. an editor watching one file).
                let changed: Vec<String> = event
                    .paths
                    .iter()
                    .filter(|p| !is_ignored(p))
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if !changed.is_empty() {
                    let _ = app.emit("fs-changed", changed);
                }
            }
            WatchMsg::Event(Err(_)) => {}
            WatchMsg::Reroot(new) => {
                if new != root && new.is_dir() && !too_broad_to_watch(&new) {
                    // Drop the old watcher (releasing all its watches) and build a
                    // fresh one rooted at `new`, so the live diff follows the
                    // terminal when it cd's outside the launch directory.
                    if let Some(w) = make_watcher(tx.clone()) {
                        watcher = w;
                        root = new;
                        watch_root(&mut watcher, &root);
                        // Empty payload = "everything changed" (a re-root), so
                        // path-filtered subscribers still refresh.
                        let _ = app.emit("fs-changed", Vec::<String>::new());
                    }
                }
            }
        }
    }
}

/// Re-root the file watcher to follow the active terminal's working directory.
#[tauri::command]
pub fn set_watch_root(control: tauri::State<WatchControl>, root: String) {
    if let Some(tx) = control.tx.lock().unwrap().as_ref() {
        let _ = tx.send(WatchMsg::Reroot(PathBuf::from(root)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn ignores_build_and_vcs_dirs() {
        assert!(is_ignored(Path::new("/p/node_modules/x/y.js")));
        assert!(is_ignored(Path::new("/p/.git/HEAD")));
        assert!(is_ignored(Path::new("/p/target/debug/app")));
        assert!(!is_ignored(Path::new("/p/src/main.rs")));
    }
}
