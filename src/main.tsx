import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// layout.css after styles.css: the shell builds on the primitives
import "./styles.css";
import "./layout.css";
import { App } from "./App.tsx";
import { redialNow } from "./channel.ts";
import { RootBoundary } from "./crash.ts";
import { attachAppDoor } from "./mini-apps.ts";
import { renewPushToken } from "./push.ts";
import { guardHistory } from "./route.ts";
import { androidApp, androidShell, tauriInvoke, type ShellInsets } from "./tauri.ts";
import "./theme.ts";

const invoke = tauriInvoke();
// before anything renders: a launched interface's frame URL waits on the desktop shell's answer; frame isolation is verified in macOS WebKit only
if (invoke && /Mac/.test(navigator.platform)) {
    attachAppDoor();
    guardHistory();
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");
createRoot(root).render(
    <StrictMode>
        <RootBoundary>
            <App />
        </RootBoundary>
    </StrictMode>,
);

// --vvh is the height the keyboard leaves visible: iOS pans the page instead of shrinking it (the pan is undone), the edge-to-edge Android shell covers it and reports its height
const viewport = window.visualViewport;
const style = document.documentElement.style;
let keyboard = 0;
const fit = (): void => {
    // a pinch zoom shrinks the visual viewport too, and a window not laid out yet has none: neither may resize the app
    if (!viewport || Math.abs(viewport.scale - 1) > 0.01 || viewport.height === 0) return;
    style.setProperty("--vvh", `${viewport.height - keyboard}px`);
    if (viewport.offsetTop > 0 || scrollY > 0) scrollTo(0, 0);
};
viewport?.addEventListener("resize", fit);
viewport?.addEventListener("scroll", fit);
const inset = (at: ShellInsets): void => {
    for (const side of ["t", "r", "b", "l"] as const) style.setProperty(`--sys-${side}`, `${at[side]}px`);
    keyboard = at.ime;
    fit();
};
window.addEventListener("mimi:insets", (e) => inset((e as CustomEvent<ShellInsets>).detail));
if (androidShell) inset(JSON.parse(androidShell.insets()) as ShellInsets);
else fit();

// a phone back from the background, or a network that came back, dials at once
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) redialNow();
});
window.addEventListener("online", redialNow);

// a file dropped anywhere but a drop zone would open in the window in place of the app
for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
        const drag = event as DragEvent;
        if (drag.defaultPrevented || !drag.dataTransfer?.types.includes("Files")) return;
        drag.preventDefault();
        drag.dataTransfer.dropEffect = "none";
    });
}

if (androidApp) renewPushToken();

// the desktop webview opens no new windows: a web or mail link an agent wrote opens in the system browser instead
if (invoke) {
    document.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!(link instanceof HTMLAnchorElement)) return;
        const url = URL.canParse(link.href) ? new URL(link.href) : null;
        if (!url || !/^(https?|mailto):$/.test(url.protocol) || url.origin === location.origin) return;
        event.preventDefault();
        // the shell plugin's injected script would open a target=_blank link a second time, by a command the pult is not granted
        event.stopPropagation();
        invoke("open_link", { url: url.href }).catch((e: unknown) => console.warn("could not open the link", e));
    }, true);
}

