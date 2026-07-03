mod fs;
mod git;
mod pty;
mod watcher;

use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || watcher::watch_project(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fs::get_root,
            fs::list_dir,
            fs::read_file,
            fs::write_file,
            git::git_status,
            git::git_file_original,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
