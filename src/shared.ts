// What every view does the same way: dates, counts, plurals, the mounted guard, the error box and the device keys.
import { createElement, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";

import type { ConversationInfo } from "./api.ts";

// an absent key is the third state, "follow the OS": main.tsx reads `stored ?? system`
export const THEME_KEY = "mimi-os:theme";

/** "off" disables system notifications; absent or anything else means on — the OS permission is the real gate. */
export const NOTIFY_KEY = "mimi-os:notify";

// what this device caches about chats: every agent's rows, the chats viewed lately, the last place talked in; "Clear cached lists" drops all three
export const CHAT_CACHE_KEY = "mimi-os:chat-titles";
export const RECENT_CHATS_KEY = "mimi-os:last-chat";
export const PLACE_KEY = "mimi-os:last-place";

/** The shortcut modifier as this keyboard prints it: ⌘ on Apple, Ctrl+ elsewhere. */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** A touch screen typing on a soft keyboard: Return there is a new line, and the Send button sends. */
export const SOFT_KEYS = "(hover: none) and (pointer: coarse)";

export function errorMessage(error: unknown, fallback = "Something went wrong. Please retry."): string {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    if (typeof error === "string" && error.trim()) {
        return error;
    }
    return fallback;
}

// A room, Access and the bell can decide the same thing at once: one decision makes one write, an identical repeat shares it, a different one is refused.
export function singleFlight<R>(
    flights: Map<string, { tag: string; flight: Promise<R> }>, key: string, tag: string, changedEvent: string, run: () => Promise<R>,
): Promise<R> {
    const existing = flights.get(key);
    if (existing) return existing.tag === tag ? existing.flight
        : Promise.reject(new Error("A decision is already in progress. Wait for its updated status."));
    const flight = run().finally(() => {
        if (flights.get(key)?.flight === flight) flights.delete(key);
        window.dispatchEvent(new CustomEvent(changedEvent));
    });
    flights.set(key, { tag, flight });
    return flight;
}

export function notifyEnabled(): boolean {
    try {
        return localStorage.getItem(NOTIFY_KEY) !== "off";
    } catch {
        return true;
    }
}

// "on" shows the compaction seams and per-response model traces a normal chat hides
const DEV_KEY = "mimi-os:dev";
const DEV_CHANGED = "mimi:dev-changed";

export function devDetails(): boolean {
    try {
        return localStorage.getItem(DEV_KEY) === "on";
    } catch {
        return false;
    }
}

export function setDevDetails(on: boolean): void {
    try {
        if (on) localStorage.setItem(DEV_KEY, "on");
        else localStorage.removeItem(DEV_KEY);
    } catch {
        // private window — the setting just does not persist
    }
    window.dispatchEvent(new CustomEvent(DEV_CHANGED));
}

/** Re-renders its user when the developer-details setting flips, from any view. */
export function useDevDetails(): boolean {
    const [on, setOn] = useState(devDetails);
    useEffect(() => {
        const sync = (): void => setOn(devDetails());
        window.addEventListener(DEV_CHANGED, sync);
        return () => window.removeEventListener(DEV_CHANGED, sync);
    }, []);
    return on;
}

/** A thread an agent opened by delegating: the gateway titles it "← task" and marks the title as set by hand. */
export const isDelegation = (c: Pick<ConversationInfo, "title" | "titleByUser">): boolean =>
    c.titleByUser && (c.title?.startsWith("← ") ?? false);

// the gateway speaks UTC as a bare "YYYY-MM-DD HH:MM:SS"; the Z keeps it from parsing as local time
export const parse = (utc: string): Date => new Date(`${utc.replace(" ", "T")}Z`);

/** Today keeps just the time; anything older keeps its date, so "09:00" can never quietly mean "three days ago". */
export function when(utc: string): string {
    const d = parse(utc);
    const opts: Intl.DateTimeFormatOptions =
        d.toDateString() === new Date().toDateString()
            ? { hour: "2-digit", minute: "2-digit" }
            : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" };
    return d.toLocaleString(undefined, opts);
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const YEAR = new Intl.DateTimeFormat("en-US", { year: "numeric" });

/** How long ago, as short as a list row can hold: "now", "5m", "14:02", "Mon", "Sep 3", "2025". */
export function ago(utc: string, now = Date.now()): string {
    const d = parse(utc);
    const today = new Date(now);
    const ms = now - d.getTime();
    if (ms < 60_000) return "now";
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (d.toDateString() === today.toDateString()) return TIME.format(d);
    if (ms < 6 * 86_400_000) return WEEKDAY.format(d);
    return d.getFullYear() === today.getFullYear() ? DAY.format(d) : YEAR.format(d);
}

/** A moment named in a sentence: "14:02" today, "Sep 3" this year, "Sep 3, 2025" before. */
export function clock(utc: string, now = Date.now()): string {
    const d = parse(utc);
    const today = new Date(now);
    if (d.toDateString() === today.toDateString()) return TIME.format(d);
    return d.getFullYear() === today.getFullYear() ? DAY.format(d) : DATE.format(d);
}

/** Time left on a gate as "4:12", or "11:59:08" for a question's hours, never below "0:00". */
export function countdown(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const seconds = String(s % 60).padStart(2, "0");
    if (s < 3600) return `${Math.floor(s / 60)}:${seconds}`;
    return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${seconds}`;
}

/** 128000 → «128k», 32768 → «32.8k»: the fraction is carried only when there is one. */
export const kilo = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);

export const number = new Intl.NumberFormat("en-US");

export const isPositiveInt = (text: string): boolean =>
    /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text)) && Number(text) > 0;

/** English counts: only 1 takes the singular. */
export function plural(n: number, one: string, many: string): string {
    return n === 1 ? one : many;
}

// setters a request captured must not run after unmount; StrictMode runs the cleanup once on mount, so the effect re-arms the ref
export function useMounted(): RefObject<boolean> {
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    return mounted;
}

// createElement, not JSX, so everything shared stays one .ts file
export const Err = ({ children }: { children: ReactNode }): ReactElement => createElement("div", { className: "err" }, children);
