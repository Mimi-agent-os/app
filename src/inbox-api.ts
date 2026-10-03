import type { AgentSummary } from "./api.ts";
import { apiFetch, checkedFetch, readJson, refusal } from "./channel.ts";

interface NotifyTarget {
    kind: "chat" | "app";
    agent: string;
    session?: number;
    route?: string;
}

/** WITHOUT body — the listing keeps rows light; `preview` is the first 280 chars, plain text. */
export interface InboxCard {
    id: number;
    source: "agent" | "system";
    agent: string | null;
    title: string;
    preview: string;
    level: "info" | "warn" | "action";
    target: NotifyTarget | null;
    createdAt: string;
    readAt: string | null;
}

type InboxItem = InboxCard & { body: string };

interface InboxPage {
    items: InboxCard[];
    unread: number;
    hasMore: boolean;
}

function card(value: unknown): InboxCard {
    const row = value as Partial<InboxCard> | null;
    if (!row || typeof row.id !== "number" || (row.source !== "agent" && row.source !== "system")
        || typeof row.title !== "string" || typeof row.preview !== "string"
        || (row.level !== "info" && row.level !== "warn" && row.level !== "action")
        || typeof row.createdAt !== "string") {
        throw new Error("The gateway returned an invalid inbox item.");
    }
    return row as InboxCard;
}

export async function listInbox(
    options: { limit?: number; before?: number; unread?: boolean } = {},
    signal?: AbortSignal,
): Promise<InboxPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.before !== undefined) query.set("before", String(options.before));
    if (options.unread) query.set("unread", "1");
    const qs = query.toString();
    const body = await readJson<{ items?: unknown[]; unread?: number; hasMore?: boolean }>(await checkedFetch(
        `/inbox${qs ? `?${qs}` : ""}`,
        { signal: signal ?? null },
    ));
    if (!Array.isArray(body.items) || typeof body.unread !== "number" || typeof body.hasMore !== "boolean") {
        throw new Error("The gateway returned an invalid inbox list.");
    }
    return { items: body.items.map(card), unread: body.unread, hasMore: body.hasMore };
}

export async function getInboxItem(id: number, signal?: AbortSignal): Promise<InboxItem> {
    const body = await readJson<Partial<InboxItem> | null>(await checkedFetch(`/inbox/${id}`, { signal: signal ?? null }));
    if (typeof body?.body !== "string") throw new Error("The gateway returned an inbox item without a body.");
    return { ...card(body), body: body.body };
}

export async function markRead(id: number): Promise<void> {
    const body = await readJson<{ ok?: boolean }>(await checkedFetch(`/inbox/${id}/read`, { method: "POST" }));
    if (body.ok !== true) throw new Error("The gateway did not confirm this inbox item was read.");
    window.dispatchEvent(new CustomEvent("mimi:inbox-changed"));
}

export async function markAllRead(): Promise<number> {
    const body = await readJson<{ ok?: boolean; marked?: number }>(await checkedFetch("/inbox/read-all", { method: "POST" }));
    if (body.ok !== true || typeof body.marked !== "number") throw new Error("The gateway did not confirm the inbox update.");
    window.dispatchEvent(new CustomEvent("mimi:inbox-changed"));
    return body.marked;
}

export async function deleteInboxItem(id: number): Promise<void> {
    const body = await readJson<{ ok?: boolean }>(await checkedFetch(`/inbox/${id}`, { method: "DELETE" }));
    if (body.ok !== true) throw new Error("The gateway did not confirm this inbox item was deleted.");
    window.dispatchEvent(new CustomEvent("mimi:inbox-changed"));
}

export async function discuss(id: number): Promise<{ agent: string; conversation: number }> {
    const body = await readJson<{ agent?: string; conversation?: number }>(await checkedFetch(`/inbox/${id}/discuss`, { method: "POST" }));
    if (typeof body.agent !== "string" || !body.agent || typeof body.conversation !== "number" || !Number.isSafeInteger(body.conversation) || body.conversation <= 0) {
        throw new Error("The gateway returned an invalid chat for this discussion.");
    }
    window.dispatchEvent(new CustomEvent("mimi:inbox-changed"));
    return { agent: body.agent, conversation: body.conversation };
}


interface Interaction {
    id: string;
    kind?: "delegate" | "a2a";
    from: string;
    to: string;
    createdAt: string;
    status: string;
    statusChangedAt: string;
    originConversation?: number;
    originCallId?: string;
    targetConversation?: number;
    handled?: boolean;
    gate?: string;
    /** a2a rows only. */
    command?: string;
    /** a2a rows only — raw JSON text, capped at 256 KiB with a trailing truncation marker. */
    args?: string;
    /** a2a rows only — raw JSON text, capped at 256 KiB with a trailing truncation marker. */
    result?: string;
    /** a2a rows only. */
    durationMs?: number;
}

/** A row as Activity lists it: `args` and `result` come only with the detail, read when the row is opened. */
export type InteractionRow = Omit<Interaction, "args" | "result">;

export interface InteractionPage {
    interactions: InteractionRow[];
    hasMore: boolean;
}

function interaction(value: unknown): Interaction {
    const row = value as Partial<Interaction> | null;
    if (!row || typeof row.id !== "string" || !row.id
        || typeof row.from !== "string" || !row.from || typeof row.to !== "string" || !row.to
        || typeof row.status !== "string" || !row.status
        || typeof row.createdAt !== "string" || typeof row.statusChangedAt !== "string") {
        throw new Error("The gateway returned an invalid exchange record.");
    }
    for (const ref of [row.originConversation, row.targetConversation]) {
        if (ref !== undefined && (typeof ref !== "number" || !Number.isSafeInteger(ref) || ref <= 0)) {
            throw new Error("The gateway returned an invalid exchange reference.");
        }
    }
    if (row.kind !== undefined && row.kind !== "delegate" && row.kind !== "a2a") {
        throw new Error("The gateway returned an unknown exchange kind.");
    }
    for (const text of [row.command, row.args, row.result]) {
        if (text !== undefined && typeof text !== "string") throw new Error("The gateway returned an invalid exchange field.");
    }
    if (row.durationMs !== undefined && (typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs) || row.durationMs < 0)) {
        throw new Error("The gateway returned an invalid exchange duration.");
    }
    return row as Interaction;
}

export async function listExchangeAgents(signal?: AbortSignal): Promise<AgentSummary[]> {
    const rows = await readJson<AgentSummary[]>(await checkedFetch("/agents", { signal: signal ?? null }));
    if (!Array.isArray(rows)) throw new Error("Could not load the agent list.");
    return rows.filter((agent) => agent.status === "approved");
}

// Activity shows the latest 100 exchanges and no more: older ones stay in gateway.db
export async function listInteractions(agent?: string, signal?: AbortSignal): Promise<InteractionPage> {
    const query = new URLSearchParams({ limit: "100" });
    if (agent) query.set("agent", agent);
    const body = await readJson<{ interactions?: unknown[]; hasMore?: boolean }>(await checkedFetch(`/interactions?${query}`, { signal: signal ?? null }));
    if (!Array.isArray(body.interactions) || typeof body.hasMore !== "boolean") {
        throw new Error("The gateway returned an invalid interaction list.");
    }
    return { interactions: body.interactions.map(interaction), hasMore: body.hasMore };
}

// the latest details read, kept across collapse and remounts (one can carry 512 KiB), each for the row state it was read at; a stamp has one-second grain, so status counts too
const details = new Map<string, { status: string; statusChangedAt: string; detail: Interaction | null }>();
const DETAILS_KEPT = 20;

/** The detail read for this row as the list shows it now; `undefined` means it must be read. */
export function cachedDetail(row: InteractionRow): Interaction | null | undefined {
    const kept = details.get(row.id);
    return kept && (kept.detail === null || (kept.status === row.status && kept.statusChangedAt === row.statusChangedAt)) ? kept.detail : undefined;
}

/** `null` means the exchange has since been pruned — a normal outcome, not a failure. */
export async function readInteraction(row: InteractionRow, signal?: AbortSignal): Promise<Interaction | null> {
    const call = await apiFetch(`/interactions/${encodeURIComponent(row.id)}`, { signal: signal ?? null });
    if (!call.res.ok && call.res.status !== 404) {
        throw new Error(await refusal(call) || `Could not read this exchange (${call.res.status}).`);
    }
    const detail = call.res.ok ? interaction(await readJson<unknown>(call)) : null;
    if (detail && detail.id !== row.id) throw new Error("The gateway returned a different exchange. Refresh before opening it.");
    details.delete(row.id);
    details.set(row.id, { status: row.status, statusChangedAt: row.statusChangedAt, detail });
    if (details.size > DETAILS_KEPT) details.delete(details.keys().next().value as string);
    return detail;
}
