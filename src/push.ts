/** Phone notifications in the Android app: FCM's token for this install, held by the gateway while the switch is on. */
import { apiFetch, refusal, subscribe } from "./channel.ts";
import { tauriInvoke } from "./tauri.ts";

const PUSH_KEY = "mimi-os:push";

export function pushEnabled(): boolean {
    try {
        return localStorage.getItem(PUSH_KEY) === "on";
    } catch {
        return false;
    }
}

/** Android asks for the notification permission first (13 and later), so this can wait on the owner. */
async function register(): Promise<void> {
    const token = await tauriInvoke()?.("push_token");
    if (typeof token !== "string") throw new Error("The app gave no notification token.");
    const call = await apiFetch("/devices/me/push", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
    });
    if (!call.res.ok) throw new Error(await refusal(call) || `The gateway did not take this phone's notification token (${call.res.status}).`);
}

/** The switch moves only once the gateway holds or dropped the token, so it never shows a state the gateway does not have. */
export async function setPush(on: boolean): Promise<void> {
    if (on) {
        await register();
    } else {
        const call = await apiFetch("/devices/me/push", { method: "DELETE" });
        if (!call.res.ok) throw new Error(await refusal(call) || `The gateway did not drop this phone's notification token (${call.res.status}).`);
    }
    try {
        if (on) localStorage.setItem(PUSH_KEY, "on");
        else localStorage.removeItem(PUSH_KEY);
    } catch {
        // private storage: the gateway already holds or dropped the token, only the switch forgets it on the next start
    }
}

/** FCM rotates tokens: while the switch is on, each app start hands the current one to the gateway once the channel is up. */
export function renewPushToken(): void {
    if (!pushEnabled()) return;
    const stop = subscribe(({ state }) => {
        if (state !== "ready") return;
        stop();
        register().catch((e: unknown) => console.warn("could not renew the notification token", e));
    });
}
