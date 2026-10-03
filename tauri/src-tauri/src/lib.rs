use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_shell::ShellExt;

mod apps;
mod notify;
mod push;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(push::init())
        .manage(apps::Apps::default())
        .register_asynchronous_uri_scheme_protocol(apps::SCHEME, apps::serve)
        .invoke_handler(tauri::generate_handler![notify::notify, push::push_token, quit_app, open_link, apps::apps_attach, apps::app_body, apps::app_respond])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the mimi desktop client");
}
