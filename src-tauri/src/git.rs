// Git-backed change detection for the live diff view: which files changed
// (for coloring the tree) and the HEAD version of a file (for the line diff).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::fs::project_root;

const MAX_BASELINE: usize = 2_000_000;

#[derive(Serialize)]
pub struct FileStatus {
    /// absolute path, so it matches file-tree entry paths
    path: String,
    /// "untracked" | "added" | "modified" | "deleted" | "renamed"
    status: String,
}

/// A `git` invocation hardened against a hostile repository's local config:
/// `-c` overrides repo config, neutralizing the `core.fsmonitor` hook and
/// `core.pager` RCE vectors that a malicious `.git/config` could otherwise use.
fn git() -> Command {
    let mut c = Command::new("git");
    c.args(["-c", "core.fsmonitor=false", "-c", "core.pager=cat"]);
    c
}

/// Resolve the actual repository root (git emits repo-root-relative paths), so
/// diffs are correct even when the app is opened in a subdirectory.
fn repo_root(start: &Path) -> PathBuf {
    if let Ok(out) = git()
        .arg("-C")
        .arg(start)
        .args(["rev-parse", "--show-toplevel"])
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return PathBuf::from(s);
            }
        }
    }
    start.to_path_buf()
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

/// Pure parser for `git status --porcelain=v1 -z` output — split out so it can
/// be unit-tested without invoking git. `base` is the repo root paths join to.
pub fn parse_status(text: &str, base: &Path) -> Vec<FileStatus> {
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
        result.push(FileStatus {
            path: base.join(rel).to_string_lossy().into_owned(),
            status: classify(xy).to_string(),
        });
    }
    result
}

#[tauri::command]
pub fn git_status(root: Option<String>) -> Result<Vec<FileStatus>, String> {
    let start = root.map(PathBuf::from).unwrap_or_else(project_root);
    let dir = repo_root(&start);

    let out = git()
        .arg("-C")
        .arg(&dir)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .map_err(|e| e.to_string())?;

    // Not a git repo (or git missing) → no changes, handled gracefully.
    if !out.status.success() {
        return Ok(vec![]);
    }

    let text = String::from_utf8_lossy(&out.stdout);
    Ok(parse_status(&text, &dir))
}

/// The committed (HEAD) contents of a file, for use as the diff baseline.
/// Returns an empty string for new/untracked files, or when the baseline is
/// too large to diff usefully.
#[tauri::command]
pub fn git_file_original(path: String, root: Option<String>) -> Result<String, String> {
    let start = root.map(PathBuf::from).unwrap_or_else(project_root);
    let dir = repo_root(&start);

    let rel = Path::new(&path)
        .strip_prefix(&dir)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| PathBuf::from(&path));
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    let out = git()
        .arg("-C")
        .arg(&dir)
        .arg("show")
        .arg(format!("HEAD:{}", rel_str))
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
        if out.stdout.len() > MAX_BASELINE {
            return Ok(String::new());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Ok(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_codes() {
        assert_eq!(classify("??"), "untracked");
        assert_eq!(classify(" M"), "modified");
        assert_eq!(classify("A "), "added");
        assert_eq!(classify(" D"), "deleted");
        assert_eq!(classify("R "), "renamed");
    }

    #[test]
    fn parse_z_output_with_rename() {
        // "R  new\0old\0 M other.rs\0"  — rename consumes the following token.
        let base = Path::new("/repo");
        let text = "R  a/new.rs\0a/old.rs\0 M b/other.rs\0";
        let out = parse_status(text, base);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "/repo/a/new.rs");
        assert_eq!(out[0].status, "renamed");
        assert_eq!(out[1].path, "/repo/b/other.rs");
        assert_eq!(out[1].status, "modified");
    }

    #[test]
    fn parse_skips_short_and_empty() {
        assert!(parse_status("", Path::new("/r")).is_empty());
        assert!(parse_status("\0\0", Path::new("/r")).is_empty());
    }
}
