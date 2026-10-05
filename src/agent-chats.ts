// The shell's one list of every agent's chats: fetched per agent, refreshed on chat_changed, cached so an offline agent keeps its titles, and watched for turns that finish.
import { useSyncExternalStore } from "react";

import { createConversation, listConversations, patchConversation, type AgentSummary, type ConversationInfo } from "./api.ts";
import type { ApprovalSummary } from "./approval-api.ts";
import type { ChatChangedDetail } from "./events.ts";
import { lastChat, type Route } from "./route.ts";
import { CHAT_CACHE_KEY, clock, errorMessage, isDelegation, parse } from "./shared.ts";

/** `rows` is null until the first answer or cache; `stale` rows are cached or from before a failed refresh. */
interface AgentChats {
    rows: readonly ConversationInfo[] | null;
    stale: boolean;
    error: string;
}

export const NO_CHATS: AgentChats = Object.freeze({ rows: null, stale: false, error: "" });

/** The detail of `mimi:reply-finished`: a chat this device saw busy that a later list shows idle. */
export interface ReplyFinishedDetail {
    agent: string;
    id: number;
    title: string | null;
}

interface AgentStateWord {
    word: string;
    tone: "warn" | "accent" | "mute";
}

/** What the owner can change on a chat from a row or the chat header. */
export type ChatEdit = Parameters<typeof patchConversation>[2];

/** The most rows the home list shows under one agent; the cache holds as many. */
export const HOME_MAX = 10;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

// the map is replaced on every change, and only the changed agent's entry is a new object, so memoized readers of other agents skip the render
let chats: ReadonlyMap<string, AgentChats> = new Map();
const listeners = new Set<() => void>();
const flights = new Map<string, { done: Promise<void>; queued: Promise<readonly ConversationInfo[]> | null }>();
const opening = new Map<string, Promise<number>>();
const retries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();
// the owner's edits the gateway has not confirmed, or confirmed after the running fetch began: laid over every list that may predate them.
// `settled` is the tick of the gateway's answer (Infinity while in flight); `fields` null is a deleted chat
const edits = new Map<string, { id: number; fields: Partial<ConversationInfo> | null; settled: number }[]>();
// orders fetch starts against edit answers
let tick = 0;
let started = false;

const byRecent = (a: ConversationInfo, b: ConversationInfo): number =>
    a.updatedAt === b.updatedAt ? b.id - a.id : a.updatedAt < b.updatedAt ? 1 : -1;

// rows come from an agent's own session list and back from localStorage: one the list could not render or address is dropped
function chatRow(value: unknown): ConversationInfo | null {
    if (typeof value !== "object" || value === null) return null;
    const { id, title, archived, pinned, createdAt, updatedAt, messages, busy, awaitingApproval, titleByUser, activeTurnSeq } =
        value as Partial<Record<keyof ConversationInfo, unknown>>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
    if (title !== null && typeof title !== "string") return null;
    if (typeof archived !== "boolean" || typeof pinned !== "boolean" || typeof busy !== "boolean"
        || typeof awaitingApproval !== "boolean" || typeof titleByUser !== "boolean") return null;
    if (typeof messages !== "number" || !Number.isSafeInteger(messages) || messages < 0) return null;
    if (typeof createdAt !== "string" || typeof updatedAt !== "string"
        || Number.isNaN(parse(createdAt).getTime()) || Number.isNaN(parse(updatedAt).getTime())) return null;
    if (activeTurnSeq !== undefined && (typeof activeTurnSeq !== "number" || !Number.isSafeInteger(activeTurnSeq))) return null;
    return { id, title, archived, pinned, createdAt, updatedAt, messages, busy, awaitingApproval, titleByUser, activeTurnSeq };
}

function readCache(): Record<string, unknown> {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(CHAT_CACHE_KEY) ?? "{}");
        return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
    } catch {
        return {};
    }
}

function writeCache(cache: Record<string, unknown>): void {
    try {
        localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify(cache));
    } catch {
        // private mode: an offline agent just shows no titles
    }
}

function write(agent: string, entry: AgentChats): void {
    const next = new Map(chats);
    next.set(agent, entry);
    chats = next;
    for (const listener of listeners) listener();
}

/** Starts tracking these agents' chats (seeded from the cache, then fetched) and stops tracking any agent left out. */
export function startAgentChats(agents: readonly string[]): void {
    if (!started) {
        started = true;
        window.addEventListener("mimi:chat-changed", (e) => {
            const { agent } = (e as CustomEvent<ChatChangedDetail>).detail;
            if (chats.has(agent)) refreshAgent(agent).catch(() => undefined);
        });
        window.addEventListener("mimi:resync", () => {
            for (const agent of chats.keys()) refreshAgent(agent).catch(() => undefined);
        });
        // an agent that reconnected can answer again
        window.addEventListener("mimi:agent-changed", () => {
            for (const [agent, entry] of chats) if (entry.stale || entry.error) refreshAgent(agent).catch(() => undefined);
        });
    }
    const gone = [...chats.keys()].filter((agent) => !agents.includes(agent));
    const added = agents.filter((agent) => !chats.has(agent));
    if (gone.length === 0 && added.length === 0) return;
    const cache = readCache();
    const next = new Map(chats);
    for (const agent of gone) {
        next.delete(agent);
        delete cache[agent];
        clearTimeout(retries.get(agent)?.timer);
        retries.delete(agent);
        edits.delete(agent);
    }
    for (const agent of added) {
        const cached = cache[agent];
        next.set(agent, Array.isArray(cached)
            ? { rows: cached.flatMap((row: unknown) => chatRow(row) ?? []).toSorted(byRecent), stale: true, error: "" }
            : { rows: null, stale: false, error: "" });
    }
    chats = next;
    for (const listener of listeners) listener();
    if (gone.length > 0) writeCache(cache);
    for (const agent of added) refreshAgent(agent).catch(() => undefined);
}

/** Fetches one agent's chats; a call while one is in flight shares a single fetch queued behind it. Rejects on failure, keeping the last rows as stale and retrying with backoff. */
export function refreshAgent(agent: string): Promise<readonly ConversationInfo[]> {
    const flight = flights.get(agent);
    if (flight) return (flight.queued ??= flight.done.then(() => refreshAgent(agent)));
    const began = ++tick;
    const run = listConversations(agent, true).then(
        (list) => {
            // an edit answered before this fetch began is already in the list; the rest are laid over it
            const pending = (edits.get(agent) ?? []).filter((e) => e.settled > began);
            edits.set(agent, pending);
            let rows = list.flatMap((row: unknown) => chatRow(row) ?? []);
            for (const e of pending) rows = e.fields ? rows.map((c) => (c.id === e.id ? { ...c, ...e.fields } : c)) : rows.filter((c) => c.id !== e.id);
            rows = rows.toSorted(byRecent);
            // an agent dropped meanwhile is not brought back
            if (!chats.has(agent)) return rows;
            // a row seen busy that is idle now finished a turn: cached rows are stored idle, and a delegation thread answers an agent, not the owner
            const wasBusy = new Set(chats.get(agent)?.rows?.filter((c) => c.busy).map((c) => c.id));
            clearTimeout(retries.get(agent)?.timer);
            retries.delete(agent);
            write(agent, { rows, stale: false, error: "" });
            for (const c of rows) {
                if (wasBusy.has(c.id) && !c.busy && !isDelegation(c)) {
                    window.dispatchEvent(new CustomEvent<ReplyFinishedDetail>("mimi:reply-finished", { detail: { agent, id: c.id, title: c.title } }));
                }
            }
            const cache = readCache();
            cache[agent] = homeChats(rows, undefined, HOME_MAX).shown.map((c) => ({ ...c, busy: false, awaitingApproval: false }));
            writeCache(cache);
            return rows;
        },
        (e: unknown) => {
            const was = chats.get(agent);
            if (was) {
                write(agent, { rows: was.rows ?? [], stale: true, error: errorMessage(e) });
                // one retry pending per agent, backing off; any refresh that succeeds meanwhile cancels it
                const attempt = retries.get(agent)?.attempt ?? 0;
                clearTimeout(retries.get(agent)?.timer);
                const timer = setTimeout(() => {
                    if (chats.has(agent)) refreshAgent(agent).catch(() => undefined);
                }, Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt));
                retries.set(agent, { timer, attempt: attempt + 1 });
            }
            throw e;
        },
    );
    const entry = { done: run.then(() => undefined, () => undefined), queued: null };
    flights.set(agent, entry);
    // registered before any queued refresh, so the queued one finds this flight gone and starts its own
    void entry.done.then(() => { if (flights.get(agent) === entry) flights.delete(agent); });
    return run;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export const useAgentChats = (): ReadonlyMap<string, AgentChats> => useSyncExternalStore(subscribe, () => chats);

export const useChats = (agent: string): AgentChats => useSyncExternalStore(subscribe, () => chats.get(agent) ?? NO_CHATS);

/** Pin, rename or archive: the list changes at once and the gateway is told after. On a refusal the row goes back and this rejects, so the caller can say why. */
export async function editChat(agent: string, id: number, edit: ChatEdit): Promise<void> {
    const entry = chats.get(agent);
    const row = entry?.rows?.find((c) => c.id === id);
    if (!entry?.rows || !row) return;
    const fields: Partial<ConversationInfo> = edit.title === undefined ? { ...edit } : { ...edit, titleByUser: true };
    const was = Object.fromEntries(Object.keys(fields).map((key) => [key, row[key as keyof ConversationInfo]]));
    const mine = { id, fields, settled: Infinity };
    edits.set(agent, [...(edits.get(agent) ?? []), mine]);
    write(agent, { ...entry, rows: entry.rows.map((c) => (c.id === id ? { ...c, ...fields } : c)) });
    try {
        const { ok } = await patchConversation(agent, id, edit);
        if (!ok) throw new Error("The gateway no longer has this chat.");
        mine.settled = ++tick;
    } catch (e) {
        edits.set(agent, (edits.get(agent) ?? []).filter((x) => x !== mine));
        const now = chats.get(agent);
        if (now?.rows) write(agent, { ...now, rows: now.rows.map((c) => (c.id === id ? { ...c, ...was } : c)) });
        // what the gateway did hold is read back, in case the refusal was only partial
        refreshAgent(agent).catch(() => undefined);
        throw e;
    }
}

/** A chat the gateway already deleted; a list fetched before the delete cannot bring it back. */
export function dropChat(agent: string, id: number): void {
    edits.set(agent, [...(edits.get(agent) ?? []), { id, fields: null, settled: ++tick }]);
    const entry = chats.get(agent);
    if (!entry?.rows?.some((c) => c.id === id)) return;
    write(agent, { ...entry, rows: entry.rows.filter((c) => c.id !== id) });
}

/**
 * The rows under an agent on the home list: every pinned chat, then the most recent, `limit` rows in all but never fewer than 3 recent.
 * The open chat always shows: an empty one right after the pinned, any other in its place by recency.
 */
export function homeChats(
    rows: readonly ConversationInfo[], open: number | undefined, limit = 3,
): { shown: ConversationInfo[]; total: number; hidden: number } {
    const listed = rows.filter((c) => !c.archived && !isDelegation(c) && c.messages > 0);
    const pinned = listed.filter((c) => c.pinned);
    const recent = listed.filter((c) => !c.pinned).slice(0, Math.max(limit - pinned.length, 3));
    const here = rows.find((c) => c.id === open && !pinned.includes(c) && !recent.includes(c));
    const shown = here === undefined ? [...pinned, ...recent]
        : here.messages === 0 ? [...pinned, here, ...recent]
        : [...pinned, ...rows.filter((c) => c === here || recent.includes(c))];
    return { shown, total: listed.length, hidden: listed.filter((c) => !shown.includes(c)).length };
}

/** The one word an agent row carries; the loudest true state wins. */
export function agentState(me: Pick<AgentSummary, "connected" | "lastSeen" | "paused">, gated: boolean, busy: boolean): AgentStateWord | null {
    if (gated) return { word: "needs you", tone: "warn" };
    if (busy) return { word: "responding", tone: "accent" };
    if (!me.connected) return { word: me.lastSeen ? `offline since ${clock(me.lastSeen)}` : "offline", tone: "mute" };
    if (me.paused) return { word: "paused", tone: "mute" };
    return null;
}

/** Where the folded rail's agent opens: its soonest gate's chat, the chat last viewed, the most recent chat, else the agent page. */
export function agentLanding(agent: string, approvals: readonly ApprovalSummary[]): Route {
    const gate = approvals
        .filter((a) => a.agent === agent && a.room === undefined)
        .toSorted((a, b) => a.deadline - b.deadline)
        .find((a) => a.conversation !== undefined);
    if (gate?.conversation !== undefined) return { at: "chat", agent, id: gate.conversation };
    const rows = chats.get(agent)?.rows ?? [];
    const last = lastChat(agent);
    const kept = rows.find((c) => c.id === last && !c.archived && !isDelegation(c));
    const recent = kept ?? rows.find((c) => !c.archived && !isDelegation(c) && c.messages > 0);
    return recent ? { at: "chat", agent, id: recent.id } : { at: "agent", agent };
}

/** Every "new chat" door: the agent's untouched chat is reused, so abandoned empty rows never pile up; a second press while one is found shares it. */
export function openEmptyChat(agent: string): Promise<number> {
    const known = opening.get(agent);
    if (known) return known;
    const reusable = (c: ConversationInfo): boolean => !c.archived && !c.busy && c.messages === 0 && c.title === null;
    const flight = (async (): Promise<number> => {
        const found = chats.get(agent)?.rows?.find(reusable) ?? (await refreshAgent(agent)).find(reusable);
        if (found) return found.id;
        const { id } = await createConversation(agent);
        // the chat exists either way; a failed refresh only leaves the list stale
        await refreshAgent(agent).catch(() => undefined);
        return id;
    })().finally(() => opening.delete(agent));
    opening.set(agent, flight);
    return flight;
}
