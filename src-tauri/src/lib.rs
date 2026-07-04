mod fs;
mod git;
mod pty;
mod watcher;

use pty::PtyState;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .manage(PtyState::default())
        .on_window_event(|window, event| {
            // Closing a window kills the PTY sessions it owns (no orphans).
            if let WindowEvent::Destroyed = event {
                pty::kill_by_owner(window.state::<PtyState>().inner(), window.label());
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let handle = app.handle().clone();
            std::thread::spawn(move || watcher::watch_project(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_status,
            pty::pty_status_all,
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
