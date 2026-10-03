// The one owner of location: the URL hash names the place, and this device remembers where the owner was.
import { useSyncExternalStore } from "react";

import type { ConversationInfo } from "./api.ts";
import type { IconName } from "./components/icon.tsx";
import { navigate } from "./motion.ts";
import { isDelegation, PLACE_KEY, RECENT_CHATS_KEY } from "./shared.ts";

export const SETTINGS_SECTIONS = ["connection", "access", "health", "models", "limits", "usage", "device"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The Settings index in order; a change of `group` draws a hairline between rows. */
export const SETTINGS_INDEX: readonly { v: SettingsSection; label: string; icon: IconName; hint: string; group: string }[] = [
    { v: "connection", label: "Connection", icon: "settings", hint: "Gateway URLs, switching between them, and forgetting this pairing", group: "Gateway" },
    { v: "access", label: "Access", icon: "key", hint: "Devices and agent access", group: "Gateway" },
    { v: "health", label: "Health", icon: "dash", hint: "Agents that are down and requests that need your attention", group: "Gateway" },
    { v: "models", label: "Models", icon: "models", hint: "Available models and provider connections", group: "Models & cost" },
    { v: "limits", label: "Limits & prices", icon: "dash", hint: "Model prices and daily limits", group: "Models & cost" },
    { v: "usage", label: "Usage", icon: "dash", hint: "All model usage, including internal processing", group: "Models & cost" },
    { v: "device", label: "This device", icon: "settings", hint: "Appearance and notifications for this device", group: "This device" },
];

export type AgentTab = "chats" | "interfaces" | "settings";

export type Route =
    | { at: "home" }
    | { at: "chat"; agent: string; id: number }
    | { at: "new"; agent: string }
    | { at: "agent"; agent: string; tab?: AgentTab | undefined; app?: string | undefined; appRoute?: string | undefined }
    // parked: parsed so old links land, never rendered
    | { at: "rooms"; room?: string | undefined }
    // gate: the approval to open expanded, one that has no chat to be answered in; no tab is Reports
    | { at: "inbox"; tab?: "activity" | undefined; gate?: string | undefined }
    // no section: the index, a phone's Settings root
    | { at: "settings"; section?: SettingsSection | undefined };

/** Above this width the home list is a sidebar beside the screen; at or below it, Home and each screen stack. */
export const WIDE = "(min-width: 901px)";

const SECTION_KEY = "mimi-os:settings-tab";
const RECENT_MAX = 30;

// ── the hash grammar ──────────────────────────────────────────────────────────

/** `null` for anything that names no place: an unknown path, a malformed escape, a `#pair=` link. */
export function parseRoute(hash: string): Route | null {
    const text = hash.replace(/^#/, "");
    if (text === "" || text === "/") return { at: "home" };
    const cut = text.includes("?") ? text.indexOf("?") : text.length;
    // one parameter at most: an interface's own route, or the gate Inbox opens on
    const [key, raw] = cut < text.length ? text.slice(cut + 1).split(/=(.*)/s) : [];
    let parts: string[];
    let value: string | undefined;
    try {
        parts = text.slice(0, cut).split("/").map(decodeURIComponent);
        value = raw === undefined ? undefined : decodeURIComponent(raw);
    } catch {
        return null;
    }
    const [lead, head, name, sub, app, ...extra] = parts;
    if (lead !== "" || extra.length > 0 || parts.slice(1).includes("")) return null;
    if (key !== undefined && !(key === "route" && value !== undefined && sub === "interfaces") && !(key === "gate" && value && head === "inbox")) return null;
    const appRoute = key === "route" ? value : undefined;

    if (head === "inbox" && name === undefined) return key === "gate" ? { at: "inbox", gate: value } : { at: "inbox" };
    if (head === "inbox" && name === "activity" && sub === undefined) return key === "gate" ? { at: "inbox", tab: name, gate: value } : { at: "inbox", tab: name };
    if (head === "r" && sub === undefined) return { at: "rooms", room: name };
    if (head === "settings" && sub === undefined) {
        if (name === undefined) return { at: "settings" };
        const section = SETTINGS_SECTIONS.find((known) => known === name);
        return section ? { at: "settings", section } : null;
    }
    if (head !== "a" || name === undefined) return null;
    if (sub === undefined) return { at: "agent", agent: name };
    if (sub === "interfaces") return { at: "agent", agent: name, tab: sub, app, appRoute };
    if (app !== undefined) return null;
    if (sub === "new") return { at: "new", agent: name };
    if (sub === "chats" || sub === "settings") return { at: "agent", agent: name, tab: sub };
    const id = Number(sub);
    return /^[1-9]\d*$/.test(sub) && Number.isSafeInteger(id) ? { at: "chat", agent: name, id } : null;
}

export function formatRoute(route: Route): string {
    switch (route.at) {
        case "home":
            return "#/";
        case "chat":
            return `#/a/${encodeURIComponent(route.agent)}/${route.id}`;
        case "new":
            return `#/a/${encodeURIComponent(route.agent)}/new`;
        case "agent": {
            const interfaces = route.tab === "interfaces";
            const app = interfaces && route.app !== undefined ? `/${encodeURIComponent(route.app)}` : "";
            const query = interfaces && route.appRoute !== undefined ? `?route=${encodeURIComponent(route.appRoute)}` : "";
            return `#/a/${encodeURIComponent(route.agent)}${route.tab ? `/${route.tab}` : ""}${app}${query}`;
        }
        case "rooms":
            return route.room === undefined ? "#/r" : `#/r/${encodeURIComponent(route.room)}`;
        case "inbox": {
            const path = route.tab === "activity" ? "#/inbox/activity" : "#/inbox";
            return route.gate === undefined ? path : `${path}?gate=${encodeURIComponent(route.gate)}`;
        }
        case "settings":
            return route.section === undefined ? "#/settings" : `#/settings/${route.section}`;
    }
}

/** The screen a phone's Back and ‹ climb to from this one when no earlier entry is the app's; Home is the root and has none. */
export function parentOf(route: Route): Route | null {
    if (route.at === "home") return null;
    // a new chat that cannot open falls back to the agent it was asked of
    if (route.at === "new") return { at: "agent", agent: route.agent };
    if (route.at === "settings" && route.section !== undefined) return { at: "settings" };
    return { at: "home" };
}

/** Where a parked gate is answered: its chat, else Inbox opened on it; rooms are parked, so a room gate is answered in Inbox too. */
export const gateRoute = (agent: string, room: string | number | undefined, chat: number | undefined, gate?: string | undefined): Route =>
    room === undefined && chat !== undefined ? { at: "chat", agent, id: chat } : { at: "inbox", gate };

// ── what this device remembers ────────────────────────────────────────────────

/** Only a place the owner talks in is reopened on launch, never Settings, Inbox, a new chat or a room. */
const talkPlace = (route: Route | null): route is Extract<Route, { at: "chat" | "agent" }> => route?.at === "chat" || route?.at === "agent";

function lastPlace(): Extract<Route, { at: "chat" | "agent" }> | null {
    try {
        const place = parseRoute(localStorage.getItem(PLACE_KEY) ?? "");
        return talkPlace(place) ? place : null;
    } catch {
        return null;
    }
}

/** The chats this device viewed across agents, most recent last. */
export function recentChats(): readonly (readonly [string, number])[] {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(RECENT_CHATS_KEY) ?? "[]");
        return Array.isArray(raw)
            ? raw.filter((pair): pair is [string, number] => Array.isArray(pair) && typeof pair[0] === "string" && Number.isSafeInteger(pair[1]) && pair[1] > 0)
            : [];
    } catch {
        return [];
    }
}

function writeChats(pairs: readonly (readonly [string, number])[]): void {
    try {
        localStorage.setItem(RECENT_CHATS_KEY, JSON.stringify(pairs.slice(-RECENT_MAX)));
    } catch {
        // private mode: the agent row just opens the agent page instead of the last chat
    }
}

// this window's own memory, seeded from the device's (the last pair per agent wins): a chat viewed in another window never swaps the one kept here
const viewed = new Map<string, number>(recentChats());

/** The chat the agent row reopens. */
export const lastChat = (agent: string): number | undefined => viewed.get(agent);

/** Called with the open chat's row once the list holds it, so a chat that does not exist is never remembered. */
export function rememberChat(agent: string, chat: Pick<ConversationInfo, "id" | "archived" | "title" | "titleByUser">): void {
    // an archived chat or a delegation thread is never where the agent row lands
    const lands = !chat.archived && !isDelegation(chat);
    if (lands) viewed.set(agent, chat.id);
    else if (viewed.get(agent) === chat.id) viewed.delete(agent);
    const others = recentChats().filter(([name, id]) => name !== agent || id !== chat.id);
    writeChats(lands ? [...others, [agent, chat.id]] : others);
}

/** A chat deleted or gone: nothing reopens it any more. */
export function forgetChat(agent: string, id: number): void {
    if (viewed.get(agent) === id) viewed.delete(agent);
    writeChats(recentChats().filter(([name, chat]) => name !== agent || chat !== id));
}

/** The Settings section the home list returns to; never models by default. */
export function lastSettings(): SettingsSection {
    try {
        const stored = localStorage.getItem(SECTION_KEY);
        return SETTINGS_SECTIONS.find((known) => known === stored) ?? "health";
    } catch {
        return "health";
    }
}

/** Where a URL naming no place opens: the last place talked in, else the last chat, else the first agent, Settings only with none. */
export function landing(agents: readonly string[]): Route {
    const place = lastPlace();
    if (place && agents.includes(place.agent)) return place;
    const chat = recentChats().findLast(([agent]) => agents.includes(agent));
    if (chat) return { at: "chat", agent: chat[0], id: chat[1] };
    const first = agents[0];
    return first === undefined ? { at: "settings", section: "access" } : { at: "agent", agent: first };
}

// ── the live location ─────────────────────────────────────────────────────────

interface Place {
    route: Route | null;
    hash: string;
    /** Bumped by every navigation, a repeat of the same one included, so arrival effects refire. */
    nav: number;
    /** This entry's depth in the history the app wrote; 0 is the entry it opened on. */
    index: number;
}

// every entry the app writes carries its depth, so Back knows whether a previous entry of this app exists
const entryIndex = (): number => {
    const i: unknown = (history.state as { i?: unknown } | null)?.i;
    return typeof i === "number" ? i : 0;
};

// an open overlay's entry repeats the screen's hash and depth, and counts the overlays up to and including it
const heldDepth = (): number => {
    const held: unknown = (history.state as { held?: unknown } | null)?.held;
    return typeof held === "number" ? held : 0;
};

// a reload over an open overlay opens on that overlay's entry: it is left as it is, and reconcile() at the bottom steps off it
if (heldDepth() === 0) {
    const start = parseRoute(location.hash);
    const phone = !matchMedia(WIDE).matches;
    // the entry the app opens on is stamped, so any entry without a stamp is one the address bar added; it lands at once when a place is remembered, so Back never returns to a blank entry, and the phone keeps Home
    const opened = start?.at === "home" && !phone ? lastPlace() : null;
    history.replaceState({ i: entryIndex() }, "", opened ? formatRoute(opened) : location.hash);
    // a phone opened deep (a link, a reload of its first entry) gets Home and the parents stacked under it, so Back climbs and leaves only from Home
    if (phone && start && start.at !== "home" && entryIndex() === 0) {
        const chain: Route[] = [];
        for (let up: Route | null = start; up; up = parentOf(up)) chain.unshift(up);
        chain.forEach((route, i) => {
            if (i === 0) history.replaceState({ i }, "", formatRoute(route));
            else history.pushState({ i }, "", formatRoute(route));
        });
    }
}

let place: Place = { route: parseRoute(location.hash), hash: location.hash, nav: 0, index: entryIndex() };
const listeners = new Set<() => void>();
// a pop back to a place's root is on its way: it lands before anything else moves, and takes over the entry it lands on
let unwind: Route | null = null;
// back() is on its way to the previous entry
let stepping = false;
// set by guardHistory(): only the pult may move history
let guarded = false;

export const snapshot = (): Place => place;

// the place is recorded at once, so here(), goLater() and a repeated popstate agree immediately; React hears of it inside the transition
function settle(route: Route | null, index: number): void {
    place = { route, hash: location.hash, nav: place.nav + 1, index };
    try {
        if (talkPlace(route)) localStorage.setItem(PLACE_KEY, formatRoute(route));
        if (route?.at === "settings" && route.section !== undefined) localStorage.setItem(SECTION_KEY, route.section);
    } catch {
        // private mode: the app still moves, it just forgets where it was
    }
}

function publish(): void {
    for (const listener of listeners) listener();
}

// a step can land on a mini-app frame's own entry, which moves only the frame and fires no popstate here: one still unheard is given up
function watchStep(): void {
    const from = `${entryIndex()} ${heldDepth()} ${location.hash}`;
    setTimeout(() => {
        if ((stepping || popping || unwind) && `${entryIndex()} ${heldDepth()} ${location.hash}` === from) sync();
    }, 300);
}

/** A push animates forward; a replace (landing, redirects, tab switches) lands at once. Call it from an event or an async continuation, never from render. */
export function go(route: Route, { replace = false }: { replace?: boolean } = {}): void {
    // a chat id can come straight from an agent's list, and only a positive integer names a chat
    if (route.at === "chat" && !(Number.isSafeInteger(route.id) && route.id > 0)) return;
    if (unwind) return;
    // an overlay is still up (a sheet's item, a notification tapped over it): it closes, and the move waits until its entry is gone, so none is buried under the new place
    if (holds.length > 0 || heldDepth() > 0) {
        for (const hold of holds.splice(0).reverse()) hold.back();
        afters.push(() => go(route, { replace }));
        queueMicrotask(reconcile);
        return;
    }
    // a phone keeps Home at depth 0 and Inbox (either tab) and the Settings index at 1; going to one pops back to it, capped by the history the browser kept
    const phone = !matchMedia(WIDE).matches;
    const depth = route.at === "home" ? 0 : (route.at === "inbox" && route.gate === undefined) || (route.at === "settings" && route.section === undefined) ? 1 : -1;
    const down = Math.min(place.index - depth, history.length - 1);
    if (phone && depth >= 0 && down > 0) {
        unwind = route;
        history.go(-down);
        watchStep();
        return;
    }
    const hash = formatRoute(route);
    if (replace || hash === location.hash || (phone && place.index === depth)) {
        if (hash !== location.hash) history.replaceState({ i: place.index }, "", hash);
        settle(route, place.index);
        publish();
        return;
    }
    history.pushState({ i: place.index + 1 }, "", hash);
    settle(route, place.index + 1);
    navigate(publish, "forward");
}

/** Taken before an await: the returned go is a no-op once anyone has navigated since. */
export function goLater(): (route: Route, opts?: { replace?: boolean }) => void {
    const nav = place.nav;
    return (route, opts) => {
        if (place.nav === nav) go(route, opts);
    };
}

export const here = (): Route | null => place.route;

/** A place that stopped existing is swapped for `to` in place, so Back skips it; never once the owner has left it. */
export function leave(gone: Route, to: Route): void {
    const now = here();
    if (now && formatRoute(now) === formatRoute(gone)) go(to, { replace: true });
}

/** Every screen's ‹ and the phone's Back key: the previous entry when this app wrote one, else the parent in place of this entry. */
export function back(): void {
    if (unwind) return;
    const up = place.route && parentOf(place.route);
    if (place.index > 0) {
        stepping = true;
        history.back();
        watchStep();
    } else if (up) go(up, { replace: true });
}

/** Where nothing but the pult can move history, as in the macOS desktop app (main.tsx), a pop the pult did not start comes from a mini-app frame's history.back() or go(): it is undone. */
export function guardHistory(): void {
    guarded = true;
}

// ── overlays: each holds an entry of its own, so Back closes it and leaves the screen under it ──

/** An open overlay; `back` closes it when Back takes its entry. */
export interface Hold {
    back: () => void;
}

// open overlays, oldest first; above the screen's own entry history keeps one per overlay, each stamped with its count
const holds: Hold[] = [];
const overlayListeners = new Set<() => void>();
// what waits for history to match `holds`: a dialog's answer, a move asked for while an overlay was up
const afters: (() => void)[] = [];
let popping = false;

export function holdBack(back: () => void): Hold {
    const hold = { back };
    holds.push(hold);
    queueMicrotask(reconcile);
    return hold;
}

/** The overlay closed on its own: its entry goes, and `then` runs once it has. Safe to call twice, or after Back took the entry. */
export function releaseBack(hold: Hold, then?: () => void): void {
    const at = holds.indexOf(hold);
    if (at >= 0) holds.splice(at, 1);
    if (then) afters.push(then);
    queueMicrotask(reconcile);
}

// history follows `holds` a tick late, so a release and a hold in one tick (StrictMode's rehearsal, a sheet giving way to a dialog) share one entry
function reconcile(): void {
    for (const listener of overlayListeners) listener();
    if (popping) return;
    const have = heldDepth();
    if (have > holds.length) {
        popping = true;
        history.go(holds.length - have);
        watchStep();
        return;
    }
    for (let held = have + 1; held <= holds.length; held++) history.pushState({ i: place.index, held }, "", location.hash);
    for (const then of afters.splice(0)) then();
}

// Back, Forward and a hand-edited hash; popstate and hashchange can both fire for one step, and a pairing link is redeemed by channel.ts on reload
function sync(e?: Event): void {
    if (location.hash.startsWith("#pair=")) return;
    // a foreign pop: the place goes back on top of the entry it landed on, and reconcile() restores the overlays' entries
    if (guarded && e?.type === "popstate" && !popping && !unwind && !stepping) {
        if (location.hash !== place.hash || entryIndex() !== place.index) {
            history.pushState({ i: entryIndex() + 1 }, "", place.hash);
            place = { ...place, index: entryIndex() };
            publish();
        }
        reconcile();
        return;
    }
    stepping = false;
    // Back took an overlay's entry: that overlay closes, the screen under it stays
    if (!popping) for (const hold of holds.splice(heldDepth()).reverse()) hold.back();
    popping = false;
    const root = unwind;
    unwind = null;
    // a pop to a place's root lands on the entry at its depth, whatever that held
    if (root && location.hash !== formatRoute(root)) history.replaceState({ i: entryIndex() }, "", formatRoute(root));
    if (location.hash !== place.hash) {
        // an entry with no stamp was typed into the address bar: it sits one step past the entry it left
        const typed = typeof (history.state as { i?: unknown } | null)?.i !== "number";
        if (typed) history.replaceState({ i: place.index + 1 }, "", location.hash);
        const index = entryIndex();
        const direction = index < place.index ? "back" : "forward";
        settle(parseRoute(location.hash), index);
        // a place's root lands at once, as a replace does; Safari's own swipe-back already slid the page, and a second slide would play it twice
        if (root || (e && "hasUAVisualTransition" in e && e.hasUAVisualTransition)) publish();
        else navigate(publish, direction);
    }
    reconcile();
}
window.addEventListener("popstate", sync);
window.addEventListener("hashchange", sync);
reconcile();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export const useRoute = (): Place => useSyncExternalStore(subscribe, snapshot);

function watchOverlays(listener: () => void): () => void {
    overlayListeners.add(listener);
    return () => { overlayListeners.delete(listener); };
}

/** True while an overlay (a menu, a dialog, the palette) holds a Back entry. */
export const useOverlayUp = (): boolean => useSyncExternalStore(watchOverlays, () => holds.length > 0);
