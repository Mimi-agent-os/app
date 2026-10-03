use tauri::ipc::Request;
use tauri::WebviewWindow;
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub fn notify(app: tauri::AppHandle, window: WebviewWindow, request: Request<'_>, title: String, body: String) -> Result<(), String> {
    crate::apps::pult_only(&window, &request)?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
