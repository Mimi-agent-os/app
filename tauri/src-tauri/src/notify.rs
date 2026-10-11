use tauri::ipc::Request;
use tauri::WebviewWindow;

/// Raises a system banner. On macOS it resolves "clicked" once the owner clicks it, the window closed to the Dock
/// brought back first, or "closed" once it goes away unclicked; elsewhere it resolves "shown" when handed over.
#[tauri::command]
pub async fn notify(app: tauri::AppHandle, window: WebviewWindow, request: Request<'_>, title: String, body: String) -> Result<&'static str, String> {
    crate::apps::pult_only(&window, &request)?;
    #[cfg(target_os = "macos")]
    return mac::notify(app, title, body).await;
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())?;
        Ok("shown")
    }
}

// The notification plugin has no click on the desktop: macOS only activates the app, which leaves a window closed to
// the Dock hidden. notify-rust (the plugin's own backend) waits for the click instead.
#[cfg(target_os = "macos")]
mod mac {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use notify_rust::{Notification, NotificationResponse};
    use tauri::Manager;

    // every banner waited on is polled on the main thread while it stays in Notification Center; past this many,
    // a banner is sent without waiting (a click on it still activates mimi)
    const WAITING_MAX: usize = 8;
    static WAITING: AtomicUsize = AtomicUsize::new(0);

    pub async fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<&'static str, String> {
        // as the plugin does: a dev build is not a bundle, so its banners go out as Terminal's; the first call wins
        let _ = notify_rust::set_application(if tauri::is_dev() { "com.apple.Terminal" } else { &app.config().identifier });
        let clicked = tauri::async_runtime::spawn_blocking(move || {
            let handle = Notification::new().summary(&title).body(&body).show().map_err(|e| e.to_string())?;
            if WAITING.fetch_add(1, Ordering::SeqCst) >= WAITING_MAX {
                WAITING.fetch_sub(1, Ordering::SeqCst);
                drop(handle);
                return Ok(false);
            }
            let mut clicked = false;
            let waited = handle.wait_for_response(|r: &NotificationResponse| clicked = matches!(r, NotificationResponse::Default | NotificationResponse::Action(_)));
            WAITING.fetch_sub(1, Ordering::SeqCst);
            waited.map_err(|e| e.to_string())?;
            Ok::<bool, String>(clicked)
        })
        .await
        .map_err(|e| e.to_string())??;
        if !clicked {
            return Ok("closed");
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        Ok("clicked")
    }
}
