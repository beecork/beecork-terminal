// Filesystem commands for the file-browser panel: list a directory, read a
// file for viewing/editing, and write it back.

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
    path: String,
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

#[tauri::command]
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

    Ok(Listing {
        path: dir.to_string_lossy().into_owned(),
        entries,
    })
}

#[tauri::command]
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

#[tauri::command]
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
                return Err("The file changed on disk since you opened it.".into());
            }
        }
    }
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&meta))
}
