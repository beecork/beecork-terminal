// Git-backed change detection for the live diff view: which files changed
// (for coloring the tree) and the HEAD version of a file (for the line diff).
//
// Both commands are `#[tauri::command(async)]` on purpose. A plain
// `#[tauri::command]` executes INLINE on the IPC/main thread, and everything
// here shells out to `git` — `git_status` runs on every debounced filesystem
// change while an agent edits, and `git_file_original` runs twice per file
// opened. Off the main thread, a slow repo stalls the diff, not the window.

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

/// A `git` invocation hardened against a hostile repository's config.
///
/// What this covers, precisely — the previous comment here overclaimed:
///   • `core.fsmonitor` and `core.pager`, both command-valued and both RCE
///     vectors a malicious `.git/config` could otherwise use — disabled by `-c`,
///     which beats `include.path`/`includeIf` on the command line.
///   • `--no-optional-locks` keeps us from taking `.git/index.lock` (we run
///     `git status` in the background on every fs change, which would race the
///     agent's own git commands) and, verified, additionally blocks the index
///     write that would fire a `post-index-change` hook — so `core.hooksPath` is
///     not a live vector here. Don't re-chase it.
///
/// What this does NOT cover: `filter.<name>.clean|.process`, which `git status`
/// runs when it re-hashes a worktree file. Those are neutralized per-invocation
/// by `filter_neutralizers` below, applied where they matter (`git_status`).
/// `git_file_original` needs none — `cat-file -s` and `show HEAD:<path>` do not
/// apply filters.
fn git() -> Command {
    let mut c = Command::new("git");
    c.arg("--no-optional-locks");
    c.args(["-c", "core.fsmonitor=false", "-c", "core.pager=cat"]);
    c
}

/// `-c` overrides that disable every `filter.<name>.*` driver visible to this
/// repository.
///
/// `git status` re-hashes any worktree file whose stat data differs from the
/// index, and hashing runs the `filter.<name>.clean`/`.process` command that an
/// in-tree `.gitattributes` selects. `.gitattributes` alone cannot define that
/// command — but a repo delivered with its `.git/` intact (a zip or tarball, a
/// synced folder, a restored backup; `git clone` never transfers config) carries
/// the local config that can, and our background `git status` then runs it with
/// no click and no visible git command. Listing config executes nothing, and an
/// empty override makes git treat the driver as absent while `status` still
/// reports the file correctly.
///
/// ALL scopes, deliberately NOT `--local`: `--local` does not expand
/// `include.path`, so a hostile `.git/config` can hide the driver in an included
/// file and list clean — verified, `--local` misses exactly that. Overriding the
/// user's own global drivers is the accepted cost.
fn filter_neutralizers(dir: &Path) -> Vec<String> {
    let Ok(out) = git().arg("-C").arg(dir).args(["config", "--list", "-z"]).output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    neutralizers_from_config(&String::from_utf8_lossy(&out.stdout))
}

/// Pure half of [`filter_neutralizers`], split out so it can be unit-tested
/// without a repository (same shape as `parse_status`). In `config --list -z`
/// each record is `key\nvalue`, or a bare `key` when the line has no `=`.
fn neutralizers_from_config(text: &str) -> Vec<String> {
    let mut names: Vec<&str> = Vec::new();
    for record in text.split('\0') {
        let key = record.split('\n').next().unwrap_or("");
        let Some(rest) = key.strip_prefix("filter.") else {
            continue;
        };
        // `filter.<name>.<setting>` — <name> may itself contain dots, so it is
        // everything between the first and the LAST dot.
        let Some((name, _setting)) = rest.rsplit_once('.') else {
            continue;
        };
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
        .iter()
        .flat_map(|n| {
            [
                format!("filter.{n}.clean="),
                format!("filter.{n}.smudge="),
                format!("filter.{n}.process="),
            ]
        })
        .collect()
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
        // Panic-proof: an entry always begins with a 2-char ASCII status code, a
        // space, then the path — but guard the slices so a misaligned token (e.g.
        // an orphaned multibyte original path) can never panic on a char boundary.
        let (Some(xy), Some(rel)) = (entry.get(0..2), entry.get(3..)) else {
            continue;
        };
        // Rename/copy entries carry the original path as an extra token. The R/C
        // code can appear in EITHER the index (X) or worktree (Y) column — e.g.
        // `git add -N` then rename yields " R" — so check both, not just the X.
        if xy.contains('R') || xy.contains('C') {
            let _ = parts.next();
        }
        result.push(FileStatus {
            path: base.join(rel).to_string_lossy().into_owned(),
            status: classify(xy).to_string(),
        });
    }
    result
}

#[tauri::command(async)]
pub fn git_status(root: Option<String>) -> Result<Vec<FileStatus>, String> {
    let start = root.map(PathBuf::from).unwrap_or_else(project_root);
    let dir = repo_root(&start);

    let mut cmd = git();
    cmd.arg("-C").arg(&dir);
    // Hostile-repo hardening — see `filter_neutralizers`. Side effect accepted
    // deliberately: this also disables git-lfs's clean filter, so LFS-tracked
    // files show as modified in the tree tint. Nothing that works today breaks —
    // the diff view is ALREADY wrong for LFS (`show HEAD:<path>` yields the
    // pointer file, not the content) and LFS blobs exceed `read_file`'s 2 MB cap.
    for n in filter_neutralizers(&dir) {
        cmd.arg("-c").arg(n);
    }
    let out = cmd
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
#[tauri::command(async)]
pub fn git_file_original(path: String, root: Option<String>) -> Result<String, String> {
    let start = root.map(PathBuf::from).unwrap_or_else(project_root);
    let dir = repo_root(&start);

    let rel = Path::new(&path)
        .strip_prefix(&dir)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| PathBuf::from(&path));
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    let spec = format!("HEAD:{}", rel_str);

    // Check the blob size BEFORE reading it. `git show` via .output() buffers the
    // WHOLE committed blob into memory, so a hostile repo that commits a giant
    // file could OOM us just by having it clicked. (This command is `async` now,
    // so it no longer blocks the UI thread — the memory ceiling is why the guard
    // stays.) `git cat-file -s <spec>` prints only the object size.
    let size_out = git()
        .arg("-C")
        .arg(&dir)
        .arg("cat-file")
        .arg("-s")
        .arg(&spec)
        .output()
        .map_err(|e| e.to_string())?;
    if !size_out.status.success() {
        // Not a committed blob (new/untracked file) — no baseline.
        return Ok(String::new());
    }
    let size: usize = String::from_utf8_lossy(&size_out.stdout)
        .trim()
        .parse()
        .unwrap_or(usize::MAX);
    if size > MAX_BASELINE {
        return Ok(String::new());
    }

    let out = git()
        .arg("-C")
        .arg(&dir)
        .arg("show")
        .arg(&spec)
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
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
    fn parse_z_output_with_worktree_rename_multibyte() {
        // A worktree-column rename (" R") carrying a multibyte original path — the
        // exact shape (`git add -N` after a rename of a non-ASCII file) that used
        // to panic on `&entry[0..2]`. Must parse, consuming the orig-path token.
        let base = Path::new("/repo");
        let text = " R renamed-target.txt\0中文原名.txt\0 M other.rs\0";
        let out = parse_status(text, base);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "/repo/renamed-target.txt");
        assert_eq!(out[0].status, "renamed");
        assert_eq!(out[1].path, "/repo/other.rs");
        assert_eq!(out[1].status, "modified");
    }

    // A hostile repo's `filter.<name>.clean` runs during `git status`'s re-hash.
    // Every configured driver must be neutralized — including one whose name
    // contains dots, and one listed with no value.
    #[test]
    fn neutralizes_every_configured_filter_driver() {
        let text = "core.bare\nfalse\0filter.lfs.clean\ngit-lfs clean -- %f\0\
                    filter.bare.clean\0filter.dotted.name.process\n/bin/sh\0";
        let out = neutralizers_from_config(text);
        for n in ["lfs", "bare", "dotted.name"] {
            for k in ["clean", "smudge", "process"] {
                assert!(out.contains(&format!("filter.{n}.{k}=")), "missing filter.{n}.{k}");
            }
        }
        assert_eq!(out.len(), 9, "3 settings for each of 3 drivers, no duplicates");
    }

    #[test]
    fn ignores_config_that_is_not_a_filter_driver() {
        assert!(neutralizers_from_config("core.pager\nless\0user.name\nx\0").is_empty());
        // `filter.foo` has no setting segment — not a driver key.
        assert!(neutralizers_from_config("filter.foo\nbar\0").is_empty());
        assert!(neutralizers_from_config("").is_empty());
    }

    #[test]
    fn parse_skips_short_and_empty() {
        assert!(parse_status("", Path::new("/r")).is_empty());
        assert!(parse_status("\0\0", Path::new("/r")).is_empty());
    }
}
