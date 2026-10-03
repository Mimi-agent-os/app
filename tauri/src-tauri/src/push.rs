//! Phone push: the app's own Android plugin (tauri/android/PushPlugin.kt) asks for the notification permission and hands back FCM's token for this install.

use tauri::ipc::Request;
use tauri::plugin::{Builder, TauriPlugin};
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{WebviewWindow, Wry};

#[cfg(target_os = "android")]
struct Push(tauri::plugin::PluginHandle<Wry>);

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct Token {
    token: String,
}

pub fn init() -> TauriPlugin<Wry> {
    let builder = Builder::new("push");
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        app.manage(Push(api.register_android_plugin("os.mimi.app", "PushPlugin")?));
        Ok(())
    });
    builder.build()
}

#[tauri::command]
pub async fn push_token(window: WebviewWindow, request: Request<'_>) -> Result<String, String> {
    crate::apps::pult_only(&window, &request)?;
    #[cfg(target_os = "android")]
    {
        let reply: Token = window.state::<Push>().0.run_mobile_plugin_async("token", ()).await.map_err(|e| e.to_string())?;
        Ok(reply.token)
    }
    #[cfg(not(target_os = "android"))]
    Err("phone notifications exist only in the Android app".into())
}
