import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const shellRoot = path.join(root, "tauri");
const nativeRoot = path.join(shellRoot, "src-tauri");
const [action = "doctor", ...extra] = process.argv.slice(2);
const args = extra.filter((value, index) => index !== 0 || value !== "--");
const supported = ["doctor", "dev", "check", "test-build", "build", "icons", "android-apk", "android-release"];
const android = action === "android-apk" || action === "android-release";
const release = action === "android-release";
const keystore = path.resolve(process.env.MIMI_ANDROID_KEYSTORE || path.join(homedir(), ".android", "mimi-release.jks"));
const keyAlias = process.env.MIMI_ANDROID_KEY_ALIAS || "mimi";
const children = new Set();

function stopChildren() {
    for (const child of children) {
        if (!child.pid || child.exitCode !== null) continue;
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        else child.kill();
    }
}
process.once("SIGINT", () => { stopChildren(); process.exit(130); });
process.once("SIGTERM", () => { stopChildren(); process.exit(143); });

if (!supported.includes(action)) {
    console.error(`Unknown desktop command: ${action}. Choose ${supported.join(", ")}.`);
    process.exit(1);
}

// Android Studio's stock macOS locations, so a default install needs no shell profile edits
if (android && process.platform === "darwin") {
    const jbr = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
    process.env.ANDROID_HOME ??= path.join(homedir(), "Library/Android/sdk");
    if (!process.env.JAVA_HOME) {
        // the generated project's Gradle 8.14 refuses Java 25, which Android Studio's JBR now is
        const jdk = ["21", "17"].map((version) => spawnSync("/usr/libexec/java_home", ["-F", "-v", version], { encoding: "utf8" })).find((result) => result.status === 0)?.stdout.trim();
        if (jdk || existsSync(jbr)) process.env.JAVA_HOME = jdk || jbr;
    }
    const ndkRoot = path.join(process.env.ANDROID_HOME, "ndk");
    const ndks = existsSync(ndkRoot) ? readdirSync(ndkRoot).sort() : [];
    if (!process.env.NDK_HOME && ndks.length) process.env.NDK_HOME = path.join(ndkRoot, ndks.at(-1));
}

const tools = [["Rust", "rustc", ["--version"]], ["Cargo", "cargo", ["--version"]], ["Tauri CLI", "cargo", ["tauri", "--version"]]];
const checks = tools.map(([label, command, argv]) => {
    const result = spawnSync(command, argv, { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const output = (result.stdout || result.stderr || "").trim();
    const versionSupported = label !== "Tauri CLI" || /\btauri(?:-cli)?\s+2\./.test(output);
    return { name: label, ok: result.status === 0 && versionSupported, detail: result.status === 0 ? `${output.split(/\r?\n/)[0]}${versionSupported ? "" : "; version 2 is required"}` : result.error?.code === "ENOENT" ? "Not found on PATH" : output || result.error?.message || "Could not run" };
});
checks.unshift({ name: "Node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version });
// mini-apps run on per-app mimiapp:// origins, verified on macOS only; Linux and Android stay out over Tauri's iframe limits there
const previewPlatforms = { darwin: "macOS desktop (mini-apps on per-app mimiapp:// origins)", win32: "Windows desktop preview (mini-apps not yet verified)" };
if (!android) checks.push({ name: "Platform", ok: process.platform in previewPlatforms, detail: previewPlatforms[process.platform] ?? `${process.platform}; the desktop targets macOS and Windows` });
for (const entry of ["node_modules/vite/bin/vite.js", "node_modules/typescript/bin/tsc"]) {
    checks.push({ name: "UI dependency", ok: existsSync(path.join(root, entry)), detail: entry });
}
const config = JSON.parse(readFileSync(path.join(nativeRoot, "tauri.conf.json"), "utf8"));
checks.push({ name: "Frontend is the bundled control panel", ok: config.build.frontendDist === "../panel", detail: config.build.frontendDist });
checks.push({ name: "Icon source", ok: existsSync(path.join(nativeRoot, "icons", "icon.png")), detail: "tauri/src-tauri/icons/icon.png" });
if (android) {
    const targets = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "";
    for (const [name, value, hint] of [["Android SDK", process.env.ANDROID_HOME, "install Android Studio, or set ANDROID_HOME"], ["Android NDK", process.env.NDK_HOME, "Android Studio > SDK Manager > SDK Tools > NDK (Side by side), or set NDK_HOME"]]) {
        checks.push({ name, ok: !!value && existsSync(value), detail: value || hint });
    }
    const javaHome = process.env.JAVA_HOME;
    const [, major, minor] = (javaHome ? spawnSync(path.join(javaHome, "bin", "java"), ["-version"], { encoding: "utf8", timeout: 15_000 }).stderr ?? "" : "").match(/version "(\d+)(?:\.(\d+))?/) ?? [];
    const java = Number(major === "1" ? minor : major);
    const javaOk = java >= 17 && java <= 24;
    checks.push({ name: "Java", ok: javaOk, detail: javaOk ? `${javaHome} (Java ${java})` : `${javaHome ? `${javaHome} is ${java ? `Java ${java}` : "not a runnable JDK"}; ` : ""}Gradle 8.14 needs Java 17-24: brew install --cask temurin@21, then unset JAVA_HOME or point it there; in Android Studio set Settings > Build Tools > Gradle > Gradle JDK to 21` });
    checks.push({ name: "Rust Android target", ok: targets.includes("aarch64-linux-android"), detail: targets.includes("aarch64-linux-android") ? "aarch64-linux-android" : "run: rustup target add aarch64-linux-android" });
}
const buildToolsRoot = process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "build-tools") : "";
const buildTools = release && existsSync(buildToolsRoot) ? readdirSync(buildToolsRoot).filter((version) => existsSync(path.join(buildToolsRoot, version, "apksigner"))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((version) => path.join(buildToolsRoot, version)).at(-1) : undefined;
if (release) {
    const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "keytool") : "keytool";
    checks.push({ name: "Android build-tools", ok: !!buildTools, detail: buildTools ?? "install Android SDK Build-Tools in Android Studio > SDK Manager > SDK Tools" });
    checks.push({ name: "Release keystore", ok: existsSync(keystore), detail: existsSync(keystore) ? `${keystore}, alias ${keyAlias}` : `create it once: mkdir -p "${path.dirname(keystore)}" && "${keytool}" -genkeypair -v -keystore "${keystore}" -alias ${keyAlias} -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=mimi". Back it up: without it every phone must uninstall the app (and pair again) to update` });
}

for (const check of checks) console.log(`${check.ok ? "OK" : "MISSING"}  ${check.name}: ${check.detail}`);
if (process.platform === "win32") console.log("Windows also requires Visual Studio Build Tools (Desktop development with C++) and Microsoft Edge WebView2 Runtime.");
if (checks.some((check) => !check.ok)) {
    if (checks.some((check) => check.name === "Cargo" && check.ok) && checks.some((check) => check.name === "Tauri CLI" && !check.ok)) {
        console.error('Install Tauri CLI v2 on this machine: cargo install tauri-cli --version "^2.0.0" --locked');
        console.error("Then verify cargo tauri --version and rerun the desktop command.");
    }
    console.error(`Prerequisites are incomplete. See ${android ? "tauri/TEST-MOBILE.md" : "tauri/README.md"}; no tools were installed and no native build was started.`);
    process.exit(1);
}
if (action === "doctor") process.exit(0);

async function run(command, argv, cwd = shellRoot, env = process.env) {
    const child = spawn(command, argv, { cwd, env, stdio: "inherit", shell: false });
    children.add(child);
    const status = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
    });
    children.delete(child);
    if (status !== 0) throw new Error(`${command} ${argv.join(" ")} exited with ${status}.`);
}

let preview;
try {
    if (action !== "icons") await run("cargo", ["tauri", "icon", "src-tauri/icons/icon.png"]);
    if (action === "check") {
        await run("cargo", ["check", ...args], nativeRoot);
        await run("cargo", ["test", "--lib", ...args], nativeRoot);
    } else if (action === "icons") {
        await run("cargo", ["tauri", "icon", "src-tauri/icons/icon.png", ...args]);
    } else if (action === "dev") {
        const endpoint = "http://127.0.0.1:1420";
        try {
            await fetch(`${endpoint}/app/`, { signal: AbortSignal.timeout(500) });
            throw new Error("Port 1420 is already in use. Stop that server before starting desktop:dev.");
        } catch (error) {
            if (error.message.startsWith("Port 1420")) throw error;
        }
        preview = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "1420", "--strictPort"], { cwd: root, stdio: "inherit", shell: false });
        children.add(preview);
        let previewError;
        preview.on("error", (error) => { previewError = error; });
        for (let attempt = 0; attempt < 60; attempt++) {
            if (previewError) throw previewError;
            if (preview.exitCode !== null) throw new Error("The desktop UI development server stopped before it was ready.");
            const ready = await fetch(`${endpoint}/app/`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false);
            if (ready) break;
            if (attempt === 59) throw new Error("The desktop UI development server did not become ready.");
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await run("cargo", ["tauri", "dev", ...args], shellRoot);
    } else {
        await run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"], root);
        // relative base: the bundled control panel loads from tauri://localhost/, not from a gateway /app/ path
        await run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--base", "./", "--outDir", "tauri/panel", "--emptyOutDir"], root);
        if (android) {
            if (!existsSync(path.join(nativeRoot, "gen", "android"))) {
                await run("cargo", ["tauri", "android", "init", "--ci"]);
                // a second pass writes the icons into the Android project that init just created
                await run("cargo", ["tauri", "icon", "src-tauri/icons/icon.png"]);
            }
            // init writes MainActivity once and gen/ is untracked, so the app's own (insets, text zoom, bar icons) goes over it on every build
            const activity = path.join(nativeRoot, "gen", "android", "app", "src", "main", "java", "os", "mimi", "app", "MainActivity.kt");
            if (!existsSync(activity)) throw new Error(`The Tauri Android template changed: ${activity} is gone, so tauri/android/MainActivity.kt has no place to go and the app would draw under the system bars; update the copy in scripts/desktop.mjs.`);
            copyFileSync(path.join(shellRoot, "android", "MainActivity.kt"), activity);
            const gen = path.join(nativeRoot, "gen", "android");
            const services = path.join(shellRoot, "android", "google-services.json");
            const push = existsSync(services);
            // push.rs registers PushPlugin on every Android build, so a build without Firebase gets the stub that only says so
            copyFileSync(path.join(shellRoot, "android", push ? "PushPlugin.kt" : "no-push/PushPlugin.kt"), path.join(path.dirname(activity), "PushPlugin.kt"));
            if (push) {
                copyFileSync(services, path.join(gen, "app", "google-services.json"));
                copyFileSync(path.join(shellRoot, "android", "ic_stat_mimi.xml"), path.join(gen, "app", "src", "main", "res", "drawable", "ic_stat_mimi.xml"));
                const firebase = [
                    ["build.gradle.kts", /^\s*classpath\("com\.android\.tools\.build:gradle:[^"]+"\)/m, '        classpath("com.google.gms:google-services:4.4.4")'],
                    ["app/build.gradle.kts", /^\s*id\("com\.android\.application"\)/m, '    id("com.google.gms.google-services")'],
                    ["app/build.gradle.kts", /^dependencies \{/m, '    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))\n    implementation("com.google.firebase:firebase-messaging")'],
                    // no FCM token, and so no call to Google, before the owner turns phone notifications on
                    ["app/src/main/AndroidManifest.xml", /^\s*<application\b[^>]*>/m, '        <meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />'],
                    // FCM's fallback is the launcher icon, whose opaque ground the status bar shows as a blank disc
                    ["app/src/main/AndroidManifest.xml", /^\s*<application\b[^>]*>/m, '        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_mimi" />'],
                ];
                for (const [file, anchor, lines] of firebase) {
                    const target = path.join(gen, file);
                    const source = readFileSync(target, "utf8");
                    if (source.includes(lines)) continue;
                    if (!anchor.test(source)) throw new Error(`The Tauri Android template changed: ${target} has nothing matching ${anchor}, so Firebase Messaging could not be wired in and phone notifications would not work; update the push patch in scripts/desktop.mjs.`);
                    writeFileSync(target, source.replace(anchor, (line) => `${line}\n${lines}`));
                }
            } else {
                console.log("Phone notifications are off in this build: put google-services.json in tauri/android/ to turn them on (tauri/TEST-MOBILE.md).");
            }
            if (release) {
                const gradle = path.join(nativeRoot, "gen", "android", "app", "build.gradle.kts");
                const source = readFileSync(gradle, "utf8");
                const cleartext = /(defaultConfig \{\s*manifestPlaceholders\["usesCleartextTraffic"\] = )"(true|false)"/;
                const manifest = readFileSync(path.join(nativeRoot, "gen", "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
                if (!cleartext.test(source) || !manifest.includes('android:usesCleartextTraffic="${usesCleartextTraffic}"')) {
                    throw new Error(`The Tauri Android template changed: ${gradle} no longer sets manifestPlaceholders["usesCleartextTraffic"] first in defaultConfig, or AndroidManifest.xml no longer reads it. A release built from it could not dial a gateway over http, so none was built; update the cleartext patch in scripts/desktop.mjs.`);
                }
                if (source.match(cleartext)?.[2] === "false") writeFileSync(gradle, source.replace(cleartext, '$1"true"'));
            }
            await run("cargo", ["tauri", "android", "build", ...(release ? [] : ["--debug"]), "--apk", "--target", "aarch64", ...args]);
            const outputs = path.join(nativeRoot, "gen", "android", "app", "build", "outputs", "apk");
            const built = readdirSync(outputs, { recursive: true }).filter((file) => file.endsWith(release ? "-release-unsigned.apk" : "-debug.apk")).map((file) => path.join(outputs, file));
            const newest = built.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
            if (!newest) throw new Error(`No ${release ? "unsigned release" : "debug"} APK found under ${outputs}.`);
            const apk = path.join(shellRoot, "out", release ? "mimi-android.apk" : "mimi-android-debug.apk");
            mkdirSync(path.dirname(apk), { recursive: true });
            if (release) {
                const aligned = newest.replace(/-unsigned\.apk$/, "-aligned.apk");
                // apksigner is a script that runs `java` from PATH, and macOS's /usr/bin/java may find no JDK
                const env = { ...process.env, PATH: `${path.join(process.env.JAVA_HOME, "bin")}${path.delimiter}${process.env.PATH}` };
                await run(path.join(buildTools, "zipalign"), ["-p", "-f", "4", newest, aligned]);
                rmSync(apk, { force: true });
                await run(path.join(buildTools, "apksigner"), ["sign", "--ks", keystore, "--ks-key-alias", keyAlias, "--v4-signing-enabled", "false", "--out", apk, aligned], shellRoot, env);
                await run(path.join(buildTools, "apksigner"), ["verify", "--print-certs", apk], shellRoot, env);
                console.log(`\nAPK: ${apk}`);
                console.log("It is signed with the release key, not the debug one: remove a debug install first with adb uninstall os.mimi.app (it drops that pairing; pair again).");
                console.log("Then send the file to the phone and open it, or: adb install -r tauri/out/mimi-android.apk. Later releases install over it.");
                console.log("It dials plain http too: set the address the phone dials with mimi public-url http://<host>:<port> on the gateway, then mimi pair.");
            } else {
                copyFileSync(newest, apk);
                const lan = Object.values(networkInterfaces()).flat().find((net) => net?.family === "IPv4" && !net.internal)?.address ?? "<this Mac's LAN IP>";
                console.log(`\nAPK: ${apk}`);
                console.log("Send it to the phone (Telegram, Drive, USB) and open it; allow installs from that app once.");
                console.log("Or, with the phone on USB debugging: adb install -r tauri/out/mimi-android-debug.apk");
                console.log(`Gateway over Wi-Fi: mimi start --lan 0.0.0.0, then enter http://${lan}:46464 on the connect screen.`);
            }
        } else {
            const mac = process.platform === "darwin";
            await run("cargo", ["tauri", "build", ...(action === "test-build" ? ["--debug", "--no-bundle"] : ["--bundles", mac ? "app" : "nsis"]), ...args]);
            if (action === "test-build") console.log(`Test executable: tauri/src-tauri/target/debug/${mac ? "mimi" : "mimi.exe"}`);
            else console.log(mac ? "App: tauri/src-tauri/target/release/bundle/macos/mimi.app" : "Installer: tauri/src-tauri/target/release/bundle/nsis/");
            console.log("The desktop app carries the control panel; it dials a gateway address you enter on the Connect screen.");
        }
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    stopChildren();
}
