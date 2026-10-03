// The bar of places (Agents, Inbox, Settings) and ConnLine, the connection in every header while the app is not online.
import { useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";

import type { AgentSummary } from "../api.ts";
import { getSnapshot, subscribe } from "../channel.ts";
import { formatRoute, go, landing, lastSettings, WIDE, type Route } from "../route.ts";
import { DesktopMenu } from "./desktop-menu.tsx";
import { Icon, type IconName } from "./icon.tsx";

type Place = "agents" | "inbox" | "settings";

export function NavBar({ route, rail, agents, needs, unread, waiting }: {
    route: Route | null;
    /** The folded desktop sidebar: icons only, stacked under the agent marks. */
    rail: boolean;
    /** Admitted agents, null until they load: the desktop's Agents cell lands among them. */
    agents: readonly AgentSummary[] | null;
    /** Approvals waiting anywhere. */
    needs: number;
    /** Unread Inbox reports. */
    unread: number;
    /** Devices waiting for approval in Settings > Access. */
    waiting: number;
}): ReactElement {
    const { state } = useSyncExternalStore(subscribe, getSnapshot);
    // a chat, a new chat and an agent page belong to Agents
    const at: Place = route?.at === "inbox" ? "inbox" : route?.at === "settings" ? "settings" : "agents";

    const open = (place: Place): void => {
        const wide = matchMedia(WIDE).matches;
        const root: Route = place === "inbox" ? { at: "inbox" }
            : place === "settings" ? (wide ? { at: "settings", section: lastSettings() } : { at: "settings" })
            : wide && agents ? landing(agents.map((a) => a.name)) : { at: "home" };
        // a phone's tap resets the place to its root; the desktop pane keeps whatever the place already shows
        if (place !== at || (!wide && (route === null || formatRoute(root) !== formatRoute(route)))) {
            go(root);
            return;
        }
        for (const el of document.querySelectorAll(place === "agents" ? ".home-scroll" : ".work .scroll")) el.scrollTo({ top: 0 });
    };

    const offline = state !== "ready";
    const cells: readonly { place: Place; label: string; icon: IconName; badge: ReactNode; said: string }[] = [
        { place: "agents", label: "Agents", icon: "chat", badge: needs > 0 && <span className="count warn">{needs}</span>, said: needs > 0 ? `, ${needs} waiting for you` : "" },
        { place: "inbox", label: "Inbox", icon: "queue", badge: unread > 0 && <span className="count">{unread > 99 ? "99+" : unread}</span>, said: unread > 0 ? `, ${unread} unread` : "" },
        {
            place: "settings",
            label: "Settings",
            icon: "settings",
            badge: offline ? <span className={state === "connecting" ? "dot degraded" : "dot down"} /> : waiting > 0 && <span className="count warn">{waiting}</span>,
            said: offline ? ", not connected" : waiting > 0 ? `, ${waiting} ${waiting === 1 ? "device waits" : "devices wait"} for approval` : "",
        },
    ];

    return (
        <nav className={rail ? "bar rail" : "bar"} aria-label="Places">
            {cells.map((c) => (
                <button key={c.place} type="button" className="bar-cell" aria-current={at === c.place ? "page" : undefined}
                    aria-label={`${c.label}${c.said}`} title={rail ? c.label : undefined} onClick={() => open(c.place)}>
                    <span className="bar-icon"><Icon name={c.icon} />{c.badge}</span>
                    <span className="bar-label">{c.label}</span>
                </button>
            ))}
            {rail && <DesktopMenu rail />}
        </nav>
    );
}

/** Silent while online. Otherwise it takes the place of `children` (a chat's state word) in a header's sub-line, and a tap opens Settings > Connection. */
export function ConnLine({ children }: { children?: ReactNode }): ReactNode {
    const { state } = useSyncExternalStore(subscribe, getSnapshot);
    const word = state === "connecting" ? "Connecting…" : state === "reconnecting" ? "Offline. Retrying" : state === "incompatible" ? "Gateway needs an update" : null;
    if (word === null) return children ?? null;
    return (
        <button type="button" className="conn-line" data-state={state} title="Connection settings" onClick={() => go({ at: "settings", section: "connection" })}>
            <span className="dot" /><span className="conn-line-word">{word}</span>
        </button>
    );
}
