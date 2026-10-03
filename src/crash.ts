// The root error boundary: a render error anywhere shows one calm screen with a way out, never a blank, unmounted app.
import { Component, createElement } from "react";
import type { ReactNode } from "react";

import { CHAT_CACHE_KEY, PLACE_KEY, RECENT_CHATS_KEY } from "./shared.ts";

// createElement, not JSX: the screen that must always draw leans on nothing but React and the stylesheet
export class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    override state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    override render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        const clear = (): void => {
            try {
                for (const key of [CHAT_CACHE_KEY, RECENT_CHATS_KEY, PLACE_KEY]) localStorage.removeItem(key);
            } catch {
                // private mode: nothing was cached to begin with
            }
            // the place that crashed is not reopened: the reload lands at Home
            history.replaceState(history.state, "", "#/");
            location.reload();
        };
        return createElement("div", { className: "crash", role: "alert" },
            createElement("div", { className: "empty" },
                createElement("h3", null, "Something went wrong"),
                createElement("div", { className: "empty-copy" },
                    "Reload to try again. If it keeps happening, clear the cached chat lists: your agents send them again, and this device stays paired."),
                createElement("div", { className: "empty-actions" },
                    createElement("button", { type: "button", className: "btn sm", onClick: () => location.reload() }, "Reload"),
                    createElement("button", { type: "button", className: "btn sm quiet", onClick: clear }, "Clear cached lists"))));
    }
}
