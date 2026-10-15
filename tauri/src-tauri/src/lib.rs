#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
#[cfg(target_os = "macos")]
use std::time::Duration;

use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_shell::ShellExt;

mod apps;
mod notify;
mod push;

// the window was closed from native fullscreen: a Dock click brings it back the same way
#[cfg(target_os = "macos")]
static REOPEN_FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn quit_app(app: AppHandle, window: WebviewWindow, request: Request<'_>) -> Result<(), String> {
    apps::pult_only(&window, &request)?;
    app.exit(0);
    Ok(())
}

// called from Rust, the shell plugin's open skips its own URL scope: this scheme check is the only one
#[allow(deprecated)]
#[tauri::command]
fn open_link(app: AppHandle, window: WebviewWindow, request: Request<'_>, url: Url) -> Result<(), String> {
    apps::pult_only(&window, &request)?;
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err("not a web or mail link".into());
    }
    app.shell().open(url.as_str(), None).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The desktop carries the pult as its own frontend and dials the gateway over the channel;
    // mini-apps load from mimiapp:// (apps.rs) and the pult carries their requests over that same channel.
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(push::init())
        .manage(apps::Apps::default())
        .register_asynchronous_uri_scheme_protocol(apps::SCHEME, apps::serve)
        .invoke_handler(tauri::generate_handler![notify::notify, push::push_token, quit_app, open_link, apps::apps_attach, apps::app_body, apps::app_respond])
        .setup(|_app| {
            // the one delegate every macOS banner click comes back through, for the app's lifetime
            #[cfg(target_os = "macos")]
            notify::mac::init(_app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // on macOS the window closes to the Dock, its WebView and channel still up so banners keep coming; Cmd+Q and quit_app quit
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.is_fullscreen().unwrap_or(false) {
                    // a window hidden in native fullscreen leaves its Space black: leave it, then hide once the animation is over
                    REOPEN_FULLSCREEN.store(true, Ordering::Relaxed);
                    let _ = window.set_fullscreen(false);
                    let window = window.clone();
                    std::thread::spawn(move || {
                        for _ in 0..40 {
                            std::thread::sleep(Duration::from_millis(50));
                            if !window.is_fullscreen().unwrap_or(true) {
                                break;
                            }
                        }
                        std::thread::sleep(Duration::from_millis(700));
                        let _ = window.hide();
                    });
                } else {
                    let _ = window.hide();
                }
            }
            #[cfg(not(target_os = "macos"))]
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the mimi desktop client");
    app.run(|_app, _event| {
        // a click on the Dock icon brings back the window closed to the Dock
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
            if let Some(window) = _app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                if REOPEN_FULLSCREEN.swap(false, Ordering::Relaxed) {
                    let _ = window.set_fullscreen(true);
                }
            }
        }
    });
}
