// Watches the project folder and emits `fs-changed` to the frontend whenever
// relevant files change — driving the live diff refresh.
//
// We register a NonRecursive watch per non-ignored directory rather than one
// Recursive watch on the root, so we never place kernel watches inside
// node_modules/.git/target — which on Linux would exhaust inotify on large
// repos and silently kill the live diff.

use std::path::Path;
use std::sync::mpsc::channel;

use notify::{EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

const IGNORED: &[&str] = &[".git", "node_modules", "target", "dist", ".DS_Store"];

fn is_ignored(p: &Path) -> bool {
    p.components().any(|comp| {
        matches!(comp, std::path::Component::Normal(os)
            if IGNORED.contains(&os.to_string_lossy().as_ref()))
    })
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

/// Blocking watch loop — run this on its own thread.
pub fn watch_project(app: AppHandle) {
    let root = crate::fs::project_root();
    let (tx, rx) = channel();

    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => return,
    };

    watch_tree(&mut watcher, &root);

    for res in rx {
        if let Ok(event) = res {
            // Track newly-created non-ignored directories so the tree keeps
            // being watched as the repo grows.
            if matches!(event.kind, EventKind::Create(_)) {
                for p in &event.paths {
                    if !is_ignored(p) && p.is_dir() {
                        watch_tree(&mut watcher, p);
                    }
                }
            }
            if event.paths.iter().any(|p| !is_ignored(p)) {
                let _ = app.emit("fs-changed", ());
            }
        }
    }
}
