// Git-backed change detection for the live diff view: which files changed
// (for coloring the tree) and the HEAD version of a file (for the line diff).

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::fs::project_root;

#[derive(Serialize)]
pub struct FileStatus {
    /// absolute path, so it matches file-tree entry paths
    path: String,
    /// "untracked" | "added" | "modified" | "deleted" | "renamed"
    status: String,
}

fn classify(xy: &str) -> &'static str {
    if xy == "??" {
        return "untracked";
    }
    if xy.contains('D') {
        "deleted"
    } else if xy.contains('A') {
        "added"
    } else if xy.contains('R') {
        "renamed"
    } else {
        "modified"
    }
}

#[tauri::command]
pub fn git_status(root: Option<String>) -> Result<Vec<FileStatus>, String> {
    let dir = root.map(PathBuf::from).unwrap_or_else(project_root);

    let out = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .map_err(|e| e.to_string())?;

    // Not a git repo (or git missing) → no changes, handled gracefully.
    if !out.status.success() {
        return Ok(vec![]);
    }

    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut parts = text.split('\0');
    let mut result = Vec::new();

    while let Some(entry) = parts.next() {
        if entry.len() <= 3 {
            continue;
        }
        let xy = &entry[0..2];
        let rel = &entry[3..];
        // Rename/copy entries carry the original path as an extra token.
        if xy.starts_with('R') || xy.starts_with('C') {
            let _ = parts.next();
        }
        let abs = dir.join(rel);
        result.push(FileStatus {
            path: abs.to_string_lossy().into_owned(),
            status: classify(xy).to_string(),
        });
    }

    Ok(result)
}

/// The committed (HEAD) contents of a file, for use as the diff baseline.
/// Returns an empty string for new/untracked files (no baseline).
#[tauri::command]
pub fn git_file_original(path: String, root: Option<String>) -> Result<String, String> {
    let dir = root.map(PathBuf::from).unwrap_or_else(project_root);

    let rel = std::path::Path::new(&path)
        .strip_prefix(&dir)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| PathBuf::from(&path));
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    let out = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .arg("show")
        .arg(format!("HEAD:{}", rel_str))
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Ok(String::new())
    }
}
