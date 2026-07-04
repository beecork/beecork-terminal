// Watches the project folder and emits `fs-changed` to the frontend whenever
// relevant files change — driving the live diff refresh.
//
// We register a NonRecursive watch per non-ignored directory rather than one
// Recursive watch on the root, so we never place kernel watches inside
// node_modules/.git/target — which on Linux would exhaust inotify on large
// repos and silently kill the live diff.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
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

/// A directory we can descend into — must be a real directory, NOT a symlink
/// (following symlinks lets a hostile repo escape the tree and loop / exhaust
/// inotify). `symlink_metadata` does not follow the leaf.
fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

/// Add NonRecursive watches to `dir` and every non-ignored, non-symlink
/// subdirectory beneath it.
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
    watch_tree(&mut watcher, &root);

    for msg in rx {
        match msg {
            WatchMsg::Event(Ok(event)) => {
                // Track newly-created non-ignored directories so the tree keeps
                // being watched as the repo grows. Skip symlinked dirs (no-follow)
                // so a repo-planted symlink can't send us walking outside the tree.
                if matches!(event.kind, EventKind::Create(_)) {
                    for p in &event.paths {
                        if !is_ignored(p) && is_real_dir(p) {
                            watch_tree(&mut watcher, p);
                        }
                    }
                }
                if event.paths.iter().any(|p| !is_ignored(p)) {
                    let _ = app.emit("fs-changed", ());
                }
            }
            WatchMsg::Event(Err(_)) => {}
            WatchMsg::Reroot(new) => {
                if new != root && new.is_dir() {
                    // Drop the old watcher (releasing all its watches) and build a
                    // fresh one rooted at `new`, so the live diff follows the
                    // terminal when it cd's outside the launch directory.
                    if let Some(w) = make_watcher(tx.clone()) {
                        watcher = w;
                        root = new;
                        watch_tree(&mut watcher, &root);
                        let _ = app.emit("fs-changed", ());
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
