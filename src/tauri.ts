// the one feature-detection seam for "am I inside the Tauri shell": __TAURI_INTERNALS__ is there in every v2 webview without withGlobalTauri

/** Raw bytes go out as the command's whole body, and a raw reply (tauri::ipc::Response) comes back as an ArrayBuffer. */
type TauriInvoke = (cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => Promise<unknown>;

/** The Android shell's system bars, cutout and keyboard, in CSS px (tauri/android/MainActivity.kt). */
export interface ShellInsets {
    t: number;
    r: number;
    b: number;
    l: number;
    ime: number;
}

interface TauriWindow {
    __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
    mimiShell?: { insets: () => string; lightBars: (light: boolean) => void };
}

/** The Android shell's own bridge: `insets` answers JSON ShellInsets for the first paint, later changes arrive as a `mimi:insets` event. */
export const androidShell = (window as unknown as TauriWindow).mimiShell;

/** The Android app: a phone shell with no desktop application menu, where mini-apps do not run yet (no Interfaces tab, no Web view in a chat). */
export const androidApp = /Android/.test(navigator.userAgent) && tauriInvoke() !== null;

/** `null` outside Tauri — every caller's fallback branch. */
export function tauriInvoke(): TauriInvoke | null {
    const w = window as unknown as TauriWindow;
    return typeof w.__TAURI_INTERNALS__?.invoke === "function" ? w.__TAURI_INTERNALS__.invoke : null;
}
