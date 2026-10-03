package os.mimi.app

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

// scripts/desktop.mjs copies this in place of ../PushPlugin.kt when there is no google-services.json: push.rs registers the class on every Android build
@TauriPlugin
class PushPlugin(activity: Activity) : Plugin(activity) {
  @Command
  fun token(invoke: Invoke) {
    invoke.reject("This build has no phone notifications: it was made without google-services.json (see tauri/TEST-MOBILE.md).")
  }
}
