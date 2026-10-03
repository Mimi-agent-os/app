package os.mimi.app

import android.Manifest
import android.app.Activity
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.messaging.FirebaseMessaging

// scripts/desktop.mjs copies this into the generated project when tauri/android/google-services.json exists; src-tauri/src/push.rs registers it
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun token(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
      requestPermissionForAlias("notifications", invoke, "asked")
    } else {
      asked(invoke)
    }
  }

  @PermissionCallback
  private fun asked(invoke: Invoke) {
    if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
      invoke.reject("Android blocks notifications from mimi. Allow them in the system settings, then turn this on again.")
      return
    }
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      if (task.isSuccessful) {
        invoke.resolve(JSObject().put("token", task.result))
      } else {
        invoke.reject("Firebase gave this phone no token: ${task.exception?.message ?: "no reason given"}")
      }
    }
  }
}
