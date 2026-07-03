// Filesystem commands for the file-browser panel: list a directory, read a
// file for viewing/editing, and write it back.

use std::cmp::Ordering;
use std::path::PathBuf;

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
pub fn read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 {
        return Err("File too large to open (over 2 MB).".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // Crude binary sniff: a NUL byte in the head means "not text".
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("Binary file — not shown.".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}
