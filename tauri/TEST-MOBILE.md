# Test the mobile app (Android on macOS)

The Android app builds as a debug APK or a signed release APK, and can wake the phone with a notification.
It runs the same control panel as the desktop app; agent interfaces (mini-apps) open in the macOS desktop app.

## One-time setup

1. Android Studio, then SDK Manager: the latest platform, Platform-Tools, Command-line Tools,
   NDK (Side by side) and the Emulator.
2. `rustup target add aarch64-linux-android`
3. `cargo install tauri-cli --version "^2.0.0" --locked`
4. `brew install --cask temurin@21`: the generated project's Gradle 8.14 builds with Java 17 to 24, and Android Studio bundles Java 25.

On macOS, `pnpm android:apk` finds Android Studio's SDK and NDK and a JDK 21 (or 17) in their default
locations; set `ANDROID_HOME`, `NDK_HOME` or `JAVA_HOME` when yours are elsewhere.

## A debug APK

```sh
cd app && pnpm android:apk
```

It checks the prerequisites, builds the control panel, runs `cargo tauri android init` on the first run,
builds an arm64 debug APK and copies it to `tauri/out/mimi-android-debug.apk`. Send the file to the
phone and open it, or `adb install -r tauri/out/mimi-android-debug.apk` over USB debugging.

## Release APK

Once, a signing key. Back it up: every update of an installed app must be signed with the same key.

```sh
mkdir -p ~/.android && "$(/usr/libexec/java_home -v 21)/bin/keytool" -genkeypair -v \
  -keystore ~/.android/mimi-release.jks -alias mimi -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=mimi"
```

```sh
cd app && pnpm android:release
```

It builds an arm64 release APK, signs it with that key (apksigner asks for the password) and writes
`tauri/out/mimi-android.apk`; `MIMI_ANDROID_KEYSTORE` and `MIMI_ANDROID_KEY_ALIAS` point elsewhere. The
key differs from the debug one, so remove a debug install first with `adb uninstall os.mimi.app`, then
pair again. It dials plain `http://`, a bare IP address included: the script allows cleartext in the
generated project, and the channel is end-to-end encrypted (Noise + ML-KEM) on any transport.

## Connect and pair

- Over USB or the emulator: `adb reverse tcp:46464 tcp:46464`, then `mimi start` and `mimi pair`.
  The forward makes the device's `127.0.0.1:46464` the Mac's gateway.
- Over Wi-Fi: `mimi start --lan 0.0.0.0`, then `mimi pair --address http://<Mac LAN IP>:46464`.
  Allow Node in the macOS firewall prompt.

Paste the link into the Connect screen.

## Phone notifications

With the app closed, the gateway can wake the phone over Firebase Cloud Messaging. The notification has
a fixed text, "mimi: Something needs you. Open the app for more.", so chat content stays in the encrypted
channel. Tapping it opens the app. Once:

1. Create a project in the [Firebase console](https://console.firebase.google.com) (Analytics can stay off).
2. Add an Android app with the package name `os.mimi.app`, download its `google-services.json` and
   put it in `app/tauri/android/` (gitignored).
3. Project settings > Service accounts > Generate new private key. Put the whole key in the gateway's
   `.env` on one line, in single quotes: `FCM_SERVICE_ACCOUNT_KEY='{"type":"service_account",…}'`
   (`jq -c . key.json` prints it on one line), then restart the gateway.
4. Rebuild the APK (`pnpm android:apk` or `pnpm android:release`) and install it.
5. In the app: Settings > This device > Phone notifications > On, and allow notifications.

The APK includes push when `google-services.json` is in place; otherwise the build prints a note and
leaves phone notifications off. Debug and release builds share the package name, so one Firebase app
serves both.

## Live reload

```sh
cd app && node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 1420 --strictPort
adb reverse tcp:1420 tcp:1420 && adb reverse tcp:46464 tcp:46464
cd app/tauri && cargo tauri android dev
```

Re-run the `adb reverse` lines after reconnecting the device; a blank screen usually means they
need re-running. `android dev` bypasses `scripts/desktop.mjs`, so run `pnpm android:apk` once
first: it puts the app's own `tauri/android/MainActivity.kt` (system bar insets, text zoom) and
`PushPlugin.kt` (which the app needs to start) into the generated project.

## Debug

- WebView: `chrome://inspect/#devices` in desktop Chrome, for debug builds.
- Logs: `adb logcat | grep -iE "tauri|chromium|rust"`.
- Clean slate: `adb uninstall os.mimi.app` (removes the device key; pair again).

Back to the [desktop README](README.md).
