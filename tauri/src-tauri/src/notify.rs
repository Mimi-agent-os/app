use tauri::ipc::Request;
use tauri::WebviewWindow;
use tauri_plugin_notification::NotificationExt;

/// Raises a system banner and resolves "shown" once it is handed over. A bundled macOS build delivers it itself: a newer
/// banner with the same `tag` takes the place of the older one, and a click brings the window back and hands `route` to
/// the pult. Elsewhere, and in a dev build, the notification plugin shows it and a click only activates the app.
#[tauri::command]
pub fn notify(app: tauri::AppHandle, window: WebviewWindow, request: Request<'_>, title: String, body: String, tag: Option<String>, route: Option<String>) -> Result<&'static str, String> {
    crate::apps::pult_only(&window, &request)?;
    #[cfg(target_os = "macos")]
    if mac::NATIVE.load(std::sync::atomic::Ordering::Acquire) {
        mac::notify(&app, title, body, tag, route)?;
        return Ok("shown");
    }
    // the plugin's banners neither replace one another nor report a click
    #[cfg(not(target_os = "macos"))]
    let _ = (tag, route);
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())?;
    Ok("shown")
}

// The notification plugin reports no click on the desktop, and macOS only activates the app, which leaves a window closed
// to the Dock hidden. So a bundled build delivers its own banners and hears every click through one delegate, however
// many banners sit in Notification Center: nothing waits on a banner.
// NSUserNotification is deprecated since macOS 11, yet still delivers banners and reports their clicks.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub mod mac {
    use std::sync::atomic::{AtomicBool, Ordering};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{
        ns_string, NSDictionary, NSObject, NSObjectProtocol, NSString, NSUserNotification, NSUserNotificationCenter, NSUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Manager};

    /// Set once the delegate is in place; until then (a dev build, an app run outside its bundle) banners go through the plugin.
    pub static NATIVE: AtomicBool = AtomicBool::new(false);

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and Delegate does not implement Drop
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = AppHandle]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn activated(&self, center: &NSUserNotificationCenter, notification: &NSUserNotification) {
                center.removeDeliveredNotification(notification);
                let Some(window) = self.ivars().get_webview_window("main") else { return };
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let route = notification.userInfo().and_then(|info| info.objectForKey(ns_string!("route")));
                if let Some(route) = route.as_deref().and_then(AnyObject::downcast_ref::<NSString>) {
                    let detail = serde_json::Value::from(route.to_string());
                    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent(\"mimi:notification-open\", {{ detail: {detail} }}))"));
                }
            }

            // the pult already decides when a banner is wanted; macOS would otherwise hold back every banner while mimi is
            // the active app, its window closed to the Dock included
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn present(&self, _center: &NSUserNotificationCenter, _notification: &NSUserNotification) -> bool {
                true
            }
        }
    );

    /// Called once from the builder's setup, on the main thread.
    pub fn init(app: &AppHandle) {
        // a dev build runs outside a bundle, and only a bundle has a notification center
        if tauri::is_dev() {
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else { return };
        // nil for a release binary run straight from target/, which the binding's non-null return would not survive
        let center: Option<Retained<NSUserNotificationCenter>> = unsafe { msg_send![NSUserNotificationCenter::class(), defaultUserNotificationCenter] };
        let Some(center) = center else { return };
        let delegate: Retained<Delegate> = unsafe { msg_send![super(Delegate::alloc(mtm).set_ivars(app.clone())), init] };
        // SAFETY: the delegate is never released, below
        unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
        // the center holds its delegate weakly: this one lives as long as the app
        std::mem::forget(delegate);
        NATIVE.store(true, Ordering::Release);
    }

    pub fn notify(app: &AppHandle, title: String, body: String, tag: Option<String>, route: Option<String>) -> Result<(), String> {
        let id = match tag.filter(|tag| !tag.is_empty()) {
            Some(tag) => tag,
            None => {
                let mut raw = [0u8; 16];
                getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
                raw.iter().map(|b| format!("{b:02x}")).collect()
            }
        };
        app.run_on_main_thread(move || {
            let center = NSUserNotificationCenter::defaultUserNotificationCenter();
            let id = NSString::from_str(&id);
            // the banner it stands for is taken off rather than replaced in place, so the new one is presented again
            for old in center.deliveredNotifications().to_vec() {
                if old.identifier().is_some_and(|old| *old == *id) {
                    center.removeDeliveredNotification(&old);
                }
            }
            let banner = NSUserNotification::new();
            banner.setTitle(Some(&NSString::from_str(&title)));
            banner.setInformativeText(Some(&NSString::from_str(&body)));
            banner.setIdentifier(Some(&id));
            if let Some(route) = route {
                let route = NSString::from_str(&route);
                let info = NSDictionary::<NSString, AnyObject>::from_slices(&[ns_string!("route")], &[&route]);
                // SAFETY: userInfo maps strings to objects, which this dictionary is
                unsafe { banner.setUserInfo(Some(&info)) };
            }
            center.deliverNotification(&banner);
        })
        .map_err(|e| e.to_string())
    }
}
