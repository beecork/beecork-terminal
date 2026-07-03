// Watches the project folder and emits `fs-changed` to the frontend whenever
// relevant files change — driving the live diff refresh.

use std::path::Path;
use std::sync::mpsc::channel;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// Directories whose churn we never care about (build output, deps, VCS).
fn is_relevant(p: &Path) -> bool {
    for comp in p.components() {
        if let std::path::Component::Normal(os) = comp {
            let s = os.to_string_lossy();
            if matches!(
                s.as_ref(),
                ".git" | "node_modules" | "target" | "dist" | ".DS_Store"
            ) {
                return false;
            }
        }
    }
    true
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

    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        return;
    }

    // `watcher` stays alive for as long as this loop runs.
    for res in rx {
        if let Ok(event) = res {
            if event.paths.iter().any(|p| is_relevant(p)) {
                let _ = app.emit("fs-changed", ());
            }
        }
    }
}
