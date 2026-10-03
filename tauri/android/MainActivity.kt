package os.mimi.app

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

// scripts/desktop.mjs copies this over the generated MainActivity on every Android build: tauri/src-tauri/gen is untracked
class MainActivity : TauriActivity() {
  // the latest insets in CSS px, read by the page for its first paint
  @Volatile private var insets = """{"t":0,"r":0,"b":0,"l":0,"ime":0}"""

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // the page's own ground runs under a 3-button bar, with no grey scrim from the system
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
    // the keyboard is reported as insets, never handled by panning the window: main.tsx takes its height off --vvh
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // the design is set in px: the system font scale must not inflate it
    webView.settings.textZoom = 100
    webView.addJavascriptInterface(Shell(), "mimiShell")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, all ->
      val bars = all.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = all.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val px = webView.resources.displayMetrics.density
      // the keyboard covers the bottom bar, so with it up nothing is inset at the bottom
      val bottom = if (ime > 0) 0 else bars.bottom
      insets = """{"t":${bars.top / px},"r":${bars.right / px},"b":${bottom / px},"l":${bars.left / px},"ime":${ime / px}}"""
      webView.evaluateJavascript("dispatchEvent(new CustomEvent('mimi:insets',{detail:$insets}))", null)
      // the WebView never sees the bars or the keyboard, so it neither resizes nor reports them through env(): --sys-* is the only source
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(webView)
  }

  inner class Shell {
    @JavascriptInterface fun insets(): String = this@MainActivity.insets

    // the status and navigation bar icons follow the app's theme, not the system's
    @JavascriptInterface fun lightBars(light: Boolean) = runOnUiThread {
      WindowCompat.getInsetsController(window, window.decorView).run {
        isAppearanceLightStatusBars = light
        isAppearanceLightNavigationBars = light
      }
    }
  }
}
