mod fs;
mod git;
mod pty;
mod sound;
mod watcher;

use pty::PtyState;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .manage(sound::SoundState::new())
        .manage(watcher::WatchControl::default())
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
            pty::pty_status_all,
            sound::play_sound,
            fs::get_root,
            fs::home_dir,
            fs::reveal_path,
            fs::open_url,
            fs::rename_path,
            fs::create_path,
            fs::delete_path,
            fs::list_dir,
            fs::read_file,
            fs::file_size,
            fs::write_file,
            git::git_status,
            git::git_file_original,
            watcher::set_watch_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
