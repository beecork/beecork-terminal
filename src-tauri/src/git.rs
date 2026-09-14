// Git-backed change detection for the live diff view: which files changed
// (for coloring the tree) and the HEAD version of a file (for the line diff).
//
// Both commands are `#[tauri::command(async)]` on purpose. A plain
// `#[tauri::command]` executes INLINE on the IPC/main thread, and everything
// here shells out to `git` — `git_status` runs on every debounced filesystem
// change while an agent edits, and `git_file_original` runs twice per file
// opened. Off the main thread, a slow repo stalls the diff, not the window.

use std::ffi::OsString;
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
    // Windows: we are a GUI-subsystem process (see the `windows_subsystem`
    // attribute in main.rs), so we own no console — and spawning a console
    // program without this flag allocates a NEW one, which flashes on screen as
    // a black box and steals focus. `git status` runs on every filesystem event
    // the watcher reports, so an agent editing files made the screen strobe.
    // Must be on EVERY git spawn, which is the point of funnelling them here.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — run the child with no console of its own.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// `-c` overrides that disable every `filter.<name>.*` driver visible to this
/// repository — or `None` when we could not establish them, which `git_status`
/// treats as "do not run git here at all".
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
///
/// FOUR ways this guard was bypassed, every one proven by execution against a
/// real repository. Do not "simplify" any of them away:
///
///  1. `-c key=value` splits at the FIRST `=` — git's own source says a
///     subsection containing `=` is not representable that way. A driver named
///     `a=b` turned our `filter.a=b.clean=` into the inert key `filter.a`, and
///     the real driver ran.
///  2. Worse, the discarded tail is ATTACKER-CONTROLLED. A repo whose entire
///     config is `[filter "z"] required=false` plus a section NAMED
///     `z.process=<command> #` makes our own override parse as
///     `filter.z.process = <command> #.clean=` — and git SPAWNS it. The guard
///     assembled the filter command out of a section name; for that repo,
///     running with no guard at all was SAFER than running with this one. So a
///     name containing `=` is not expressible here at any price: refuse the whole
///     status (`None`) rather than emit an argument git will re-split.
///  3. The listing was decoded with `String::from_utf8_lossy`, so a driver named
///     with a non-UTF-8 byte became U+FFFD and the override named a DIFFERENT
///     driver. Parsed from raw bytes now — unix argv is bytes, so `-c` carries
///     the real name verbatim (verified). Windows argv is WTF-16 and cannot, so
///     a non-UTF-8 name is a refusal there.
///  4. An EMPTY driver name — `[filter ""]`, selected by a `.gitattributes` line
///     `* filter=` — lists as the key `filter..clean`, and a `!name.is_empty()`
///     condition dropped it, emitting no override at all. `-c 'filter..process='`
///     neutralizes it perfectly well; the code just declined to try.
///
/// `filter.<name>.process=` is the setting that does the actual blocking — it
/// beats even a non-empty `clean` set afterwards. All three are emitted anyway.
fn filter_neutralizers(dir: &Path) -> Option<Vec<OsString>> {
    let out = git()
        .arg("-C")
        .arg(dir)
        .args(["config", "--list", "-z"])
        .output()
        .ok()?;
    if !out.status.success() {
        // Fails CLOSED. "I could not find out what to neutralize" is not "there
        // is nothing to neutralize" — the same distinction `running_known` draws
        // in pty.rs, except here the permissive answer sits directly in front of
        // remote code execution.
        return None;
    }
    neutralizers_from_config(&out.stdout)
}

/// Pure half of [`filter_neutralizers`], split out so it can be unit-tested
/// without a repository (same shape as `parse_status`). Operates on the RAW
/// bytes of `config --list -z` — not `&str`: a lossy decode was bypass 3.
/// Records are NUL-separated and each is `key\nvalue`, or a bare `key` when the
/// entry has no value.
///
/// Splitting on those two bytes is safe because a driver name can contain
/// neither: git turns `\n` inside a subsection into a literal `n` and rejects a
/// real newline outright, and a NUL truncates git's OWN key (a `[filter "x\0y"]`
/// section lists as `filter.x` and never runs). So this parser sees exactly what
/// git sees.
///
/// `None` means "a name I cannot express as a `-c` override"; the caller must
/// then not run git at all.
fn neutralizers_from_config(bytes: &[u8]) -> Option<Vec<OsString>> {
    let mut names: Vec<&[u8]> = Vec::new();
    for record in bytes.split(|&b| b == 0) {
        let key = match record.iter().position(|&b| b == b'\n') {
            Some(i) => &record[..i],
            None => record,
        };
        let Some(rest) = key.strip_prefix(&b"filter."[..]) else {
            continue;
        };
        // `filter.<name>.<setting>` — <name> may itself contain dots, so it is
        // everything between the first and the LAST dot. It may also be EMPTY,
        // which is a real and exploitable driver (bypass 4).
        let Some(dot) = rest.iter().rposition(|&b| b == b'.') else {
            continue;
        };
        let name = &rest[..dot];
        // Bypasses 1 and 2 — inexpressible AND an injection vector. Refuse the
        // whole repository rather than emit an argument git will re-split.
        if name.contains(&b'=') {
            return None;
        }
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let mut out = Vec::with_capacity(names.len() * 3);
    for name in names {
        for setting in [&b".clean="[..], &b".smudge="[..], &b".process="[..]] {
            let mut arg = Vec::with_capacity(7 + name.len() + setting.len());
            arg.extend_from_slice(b"filter.");
            arg.extend_from_slice(name);
            arg.extend_from_slice(setting);
            out.push(arg_from_bytes(arg)?);
        }
    }
    Some(out)
}

/// unix argv is bytes, so a driver name survives verbatim however it is spelled.
#[cfg(unix)]
fn arg_from_bytes(b: Vec<u8>) -> Option<OsString> {
    use std::os::unix::ffi::OsStringExt;
    Some(OsString::from_vec(b))
}

/// Windows argv is WTF-16: a non-UTF-8 name cannot be carried through it at all
/// — the bytes would be re-encoded and the override would name a DIFFERENT
/// driver, which is exactly the failure that made `from_utf8_lossy` a bypass.
/// Refuse rather than pretend. (There is no raw-byte environment there either,
/// so an env-var transport is no help; this is a platform limit, not a choice.)
#[cfg(not(unix))]
fn arg_from_bytes(b: Vec<u8>) -> Option<OsString> {
    String::from_utf8(b).ok().map(OsString::from)
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
    // Hostile-repo hardening — see `filter_neutralizers`. FAIL CLOSED: `None`
    // means we could not establish the overrides (the config listing failed, or
    // a driver name cannot be expressed as a `-c` argument). Running `git status`
    // anyway is the one thing we must not do, because the re-hash is what runs
    // `filter.<name>.clean`. Losing the tree's git tint is the same graceful
    // degradation the not-a-git-repo path already gives.
    //
    // Side effect accepted deliberately: this also disables git-lfs's clean
    // filter, so LFS-tracked files show as modified in the tree tint. Nothing
    // that works today breaks — the diff view is ALREADY wrong for LFS
    // (`show HEAD:<path>` yields the pointer file, not the content) and LFS
    // blobs exceed `read_file`'s 2 MB cap.
    let Some(neutralizers) = filter_neutralizers(&dir) else {
        return Ok(vec![]);
    };
    for n in neutralizers {
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

    /// The neutralizers as UTF-8, for assertions. Only valid where the test's own
    /// fixture is UTF-8 — the non-UTF-8 case below compares raw bytes instead.
    fn neuts(config: &[u8]) -> Vec<String> {
        neutralizers_from_config(config)
            .expect("expressible")
            .iter()
            .map(|o| o.to_string_lossy().into_owned())
            .collect()
    }

    // A hostile repo's `filter.<name>.clean` runs during `git status`'s re-hash.
    // Every configured driver must be neutralized — including one whose name
    // contains dots, and one listed with no value.
    #[test]
    fn neutralizes_every_configured_filter_driver() {
        let config = b"core.bare\nfalse\0filter.lfs.clean\ngit-lfs clean -- %f\0\
                       filter.bare.clean\0filter.dotted.name.process\n/bin/sh\0";
        let out = neuts(config);
        for n in ["lfs", "bare", "dotted.name"] {
            for k in ["clean", "smudge", "process"] {
                assert!(out.contains(&format!("filter.{n}.{k}=")), "missing filter.{n}.{k}");
            }
        }
        assert_eq!(out.len(), 9, "3 settings for each of 3 drivers, no duplicates");
    }

    #[test]
    fn ignores_config_that_is_not_a_filter_driver() {
        assert!(neuts(b"core.pager\nless\0user.name\nx\0").is_empty());
        // `filter.foo` has no setting segment — not a driver key.
        assert!(neuts(b"filter.foo\nbar\0").is_empty());
        assert!(neuts(b"").is_empty());
    }

    // ---- the four proven bypasses; each one executed code before the fix ------

    // Bypass 1: git splits `-c key=value` at the FIRST `=`, so `filter.a=b.clean=`
    // set the inert key `filter.a` and the real driver ran. Inexpressible → refuse.
    #[test]
    fn a_driver_name_containing_equals_refuses_the_whole_repository() {
        assert!(neutralizers_from_config(b"filter.a=b.clean\n/bin/sh\0").is_none());
    }

    // Bypass 2, and the reason refusal is not merely conservative: the tail git
    // discards is attacker-controlled. This config defines NO command anywhere —
    // only a section NAME — and the old code emitted
    // `-c filter.z.process=/bin/sh #.clean=`, which git parsed as
    // `filter.z.process = /bin/sh #.clean=` and SPAWNED. For this input, running
    // with no guard at all was safer than running with the guard.
    #[test]
    fn a_section_name_cannot_inject_a_filter_command() {
        let config = b"filter.z.required\nfalse\0filter.z.process=/bin/sh #.required\nfalse\0";
        assert!(neutralizers_from_config(config).is_none());
    }

    // Bypass 3: `String::from_utf8_lossy` turned a non-UTF-8 name into U+FFFD, so
    // the override named a DIFFERENT driver. The bytes must survive verbatim.
    #[cfg(unix)]
    #[test]
    fn a_non_utf8_driver_name_survives_as_raw_bytes() {
        use std::os::unix::ffi::OsStrExt;
        let out = neutralizers_from_config(b"filter.\xff.clean\n/bin/sh\0").expect("unix argv is bytes");
        assert!(
            out.iter().any(|o| o.as_bytes() == b"filter.\xff.process="),
            "the real driver name must be carried through, not U+FFFD"
        );
        assert!(
            !out.iter().any(|o| o.as_bytes().starts_with("filter.\u{FFFD}".as_bytes())),
            "a lossy decode would name a driver that does not exist"
        );
    }

    // Bypass 4: `[filter ""]`, selected by a `.gitattributes` line `* filter=`,
    // lists as `filter..clean`. A `!name.is_empty()` condition dropped it and
    // emitted nothing at all, though `-c 'filter..process='` neutralizes it fine.
    #[test]
    fn an_empty_driver_name_is_still_neutralized() {
        let out = neuts(b"filter..clean\n/bin/sh\0");
        assert!(out.contains(&"filter..process=".to_string()), "got {out:?}");
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn parse_skips_short_and_empty() {
        assert!(parse_status("", Path::new("/r")).is_empty());
        assert!(parse_status("\0\0", Path::new("/r")).is_empty());
    }
}
