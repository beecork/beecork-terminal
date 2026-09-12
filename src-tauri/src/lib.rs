mod agents;
mod diag;
mod fs;
mod git;
mod pty;
mod sound;
mod watcher;

use pty::PtyState;
use tauri::{Manager, WindowEvent};

/// WebKitGTK 2.42+ renders through a DMA-BUF backing store by default, and where
/// it can't negotiate one it produces NO FRAMES AT ALL — the GTK window opens,
/// the web process is alive, and the content area stays blank forever. That is
/// the single most common way a Tauri app "doesn't load" on Linux, and it is
/// what our own AppImage hits: it bundles Ubuntu 22.04's GTK + WebKit but NOT
/// libEGL/libgbm/libdrm, so a mismatched host driver (NVIDIA's proprietary
/// stack, a VM with no GPU passthrough, a remote desktop) is negotiating with a
/// two-year-old WebKit. There is no error — just a grey window.
///
/// Falling back costs us the DMA-BUF path only. On WebKitGTK versions that still
/// have the older accelerated backing store we keep GPU compositing (and so
/// xterm's WebGL renderer); on newer ones that dropped it, compositing goes and
/// xterm falls back to its DOM renderer — which `TerminalPane` already handles,
/// because it wraps `new WebglAddon()` in a try/catch for exactly this. A
/// slower terminal beats a blank window.
///
/// Only set when the environment hasn't already spoken, so a user whose driver
/// is fine can hand the DMA-BUF path back with `WEBKIT_DISABLE_DMABUF_RENDERER=0`.
/// MUST run before GTK/WebKit initialise — i.e. before `Builder::run`.
#[cfg(target_os = "linux")]
fn prefer_working_webkit_renderer() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    prefer_working_webkit_renderer();

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
            // First, so a panic in anything below is on record (see diag.rs).
            diag::init(app.handle());
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
            pty::pty_cd,
            pty::pty_insert_paths,
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
            diag::log_event,
            diag::diag_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
