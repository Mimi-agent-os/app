import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import {
    cachedDetail, deleteInboxItem, discuss, getInboxItem, listExchangeAgents, listInbox, listInteractions, markAllRead,
    markRead, readInteraction, type InboxCard, type InteractionPage, type InteractionRow,
} from "../inbox-api.ts";
import { AgentMark, BackButton, Btn, Empty, Pill, type PillTone } from "../components/ui.tsx";
import { Icon } from "../components/icon.tsx";
import { CopyTextButton, Markdown } from "../components/markdown.tsx";
import ApprovalRequests from "../components/approval-requests.tsx";
import { ConnLine } from "../components/nav-bar.tsx";
import { useToast } from "../components/toast.tsx";
import { errorMessage, parse, when } from "../shared.ts";
import { go, goLater } from "../route.ts";
import { androidApp } from "../tauri.ts";
import "../inbox.css";

interface InboxProps {
    /** The approval to open expanded: one that has no chat to be answered in. */
    gate?: string | undefined;
    /** From the URL, so Back and a reload keep it. */
    tab?: "activity" | undefined;
    onAgent?: ((agent: string) => void) | undefined;
    onChat?: ((agent: string, conversation: number) => void) | undefined;
    onOpenInterface?: ((agent: string, route?: string) => void) | undefined;
}

const levelTone = (level: InboxCard["level"]): PillTone => (level === "info" ? "info" : level === "warn" ? "warn" : "bad");

function InboxRow({ item, expanded, body, reading, discussing, onToggle, onDiscuss, onChat, onOpenInterface, onDelete }: {
    item: InboxCard;
    expanded: boolean;
    body: string | undefined;
    reading: boolean;
    discussing: boolean;
    onToggle: (item: InboxCard) => void;
    onDiscuss: (item: InboxCard) => void;
    onChat: InboxProps["onChat"];
    onOpenInterface: InboxProps["onOpenInterface"];
    onDelete: (item: InboxCard) => void;
}): ReactElement {
    const target = item.target;
    const chatSession = target?.kind === "chat" ? target.session : undefined;
    return <article className={item.readAt === null ? "item inbox-row unread" : "item inbox-row"}>
        <div className="meta" style={{ flexWrap: "wrap" }}>
            {item.readAt === null && <span className="dot unread" aria-hidden="true" title="unread" />}
            <Pill tone={levelTone(item.level)}>{item.level}</Pill>
            {item.agent !== null && <AgentMark agent={item.agent} />}
            <span>{item.agent ?? "System"}</span>
            <span>{when(item.createdAt)}</span>
        </div>
        <strong className="ttl">{item.title}</strong>
        {expanded
            ? <div className="inbox-body">{body === undefined ? <span className="dim3">Loading…</span> : <Markdown text={body} />}</div>
            : <p className="dim3 inbox-preview">{item.preview || "No preview available."}</p>}
        <div className="acts" style={{ flexWrap: "wrap" }}>
            <Btn sm disabled={reading} onClick={() => onToggle(item)}>{reading ? "Loading…" : expanded ? "Collapse" : "Read"}</Btn>
            {target && chatSession !== undefined
                ? <Btn kind="quiet" sm onClick={() => onChat?.(target.agent, chatSession)}>Open chat</Btn>
                // a system notice has no agent to talk it over with
                : item.agent !== null && <Btn kind="quiet" sm disabled={discussing} onClick={() => onDiscuss(item)}>{discussing ? "Starting…" : "Discuss"}</Btn>}
            {target?.kind === "app" && !androidApp && <Btn kind="quiet" sm onClick={() => onOpenInterface?.(target.agent, target.route)}>Open app</Btn>}
            <Btn kind="quiet" sm onClick={() => onDelete(item)}>Delete</Btn>
        </div>
    </article>;
}

function InboxList({ onChat, onOpenInterface }: Pick<InboxProps, "onChat" | "onOpenInterface">): ReactElement {
    const toast = useToast();
    const [items, setItems] = useState<InboxCard[] | null>(null);
    const [unread, setUnread] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [hidden, setHidden] = useState<Set<number>>(() => new Set());
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [markingAll, setMarkingAll] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState("");
    const [bodies, setBodies] = useState<Record<number, string>>({});
    const [reading, setReading] = useState<Set<number>>(() => new Set());
    const readingRef = useRef(new Set<number>());
    const [discussing, setDiscussing] = useState<Set<number>>(() => new Set());
    const discussingRef = useRef(new Set<number>());
    const pendingDelete = useRef(new Map<number, ReturnType<typeof setTimeout>>());
    const current = useRef<InboxCard[] | null>(null);
    const hasMoreRef = useRef(false);
    const request = useRef<AbortController | null>(null);
    // a change pushed while a load is in flight: that load may have read before it, so one update follows
    const stale = useRef(false);
    const live = useRef(true);

    const load = useCallback(async (more = false, update = false): Promise<void> => {
        if (more && request.current) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const previous = current.current;
        const before = more ? previous?.at(-1)?.id : undefined;
        (more ? setLoadingMore : setLoading)(true);
        setLoadError("");
        try {
            const page = await listInbox({ limit: 50, ...(before !== undefined ? { before } : {}) }, controller.signal);
            if (!live.current || controller.signal.aborted) return;
            let merged = page.items;
            let more2 = page.hasMore;
            if (more && previous) {
                const known = new Set(previous.map((row) => row.id));
                merged = [...previous, ...page.items.filter((row) => !known.has(row.id))];
            } else if (update && previous) {
                const floor = page.hasMore ? (page.items.at(-1)?.id ?? 0) : 0;
                merged = [...page.items, ...previous.filter((row) => row.id < floor)];
                more2 = page.hasMore && hasMoreRef.current;
            }
            current.current = merged;
            hasMoreRef.current = more2;
            setItems(merged);
            setUnread(page.unread);
            setHasMore(more2);
        } catch (e) {
            if (live.current && !controller.signal.aborted) setLoadError(errorMessage(e, "Could not load the inbox. Try again."));
        } finally {
            if (request.current === controller) {
                request.current = null;
                if (live.current) { setLoading(false); setLoadingMore(false); }
                if (live.current && stale.current) { stale.current = false; void load(false, true); }
            }
        }
    }, []);

    useEffect(() => {
        live.current = true;
        stale.current = false;
        void load();
        const changed = (): void => { if (request.current) stale.current = true; else void load(false, true); };
        const resync = (): void => { void load(); };
        window.addEventListener("mimi:inbox-changed", changed);
        window.addEventListener("mimi:resync", resync);
        return () => {
            live.current = false;
            request.current?.abort();
            window.removeEventListener("mimi:inbox-changed", changed);
            window.removeEventListener("mimi:resync", resync);
        };
    }, [load]);

    const toggleRead = async (item: InboxCard): Promise<void> => {
        if (item.id in bodies) { setBodies((old) => { const next = { ...old }; delete next[item.id]; return next; }); return; }
        if (readingRef.current.has(item.id)) return;
        readingRef.current.add(item.id);
        setReading(new Set(readingRef.current));
        setActionError("");
        try {
            const full = await getInboxItem(item.id);
            if (live.current) setBodies((old) => ({ ...old, [item.id]: full.body }));
            if (item.readAt === null) void markRead(item.id).catch(() => undefined);
        } catch (e) {
            if (live.current) setActionError(errorMessage(e, "Could not read this item. Try again."));
        } finally {
            readingRef.current.delete(item.id);
            if (live.current) setReading(new Set(readingRef.current));
        }
    };

    const openDiscuss = async (item: InboxCard): Promise<void> => {
        if (discussingRef.current.has(item.id)) return;
        discussingRef.current.add(item.id);
        setDiscussing(new Set(discussingRef.current));
        setActionError("");
        const land = goLater();
        try {
            const { agent, conversation } = await discuss(item.id);
            land({ at: "chat", agent, id: conversation });
        } catch (e) {
            if (live.current) setActionError(errorMessage(e, "Could not start a discussion for this item."));
        } finally {
            discussingRef.current.delete(item.id);
            if (live.current) setDiscussing(new Set(discussingRef.current));
        }
    };

    // purely client-side: the row hides at once, and only a real DELETE — 3s later, unless undone — is irreversible
    const removeItem = (item: InboxCard): void => {
        setHidden((old) => new Set(old).add(item.id));
        const timer = setTimeout(() => {
            pendingDelete.current.delete(item.id);
            void deleteInboxItem(item.id).catch((e) => {
                if (!live.current) return;
                setHidden((old) => { const next = new Set(old); next.delete(item.id); return next; });
                setActionError(errorMessage(e, "Could not delete this item. Try again."));
            });
        }, 3000);
        pendingDelete.current.set(item.id, timer);
        toast("Message deleted", {
            label: "Undo",
            run: () => {
                const t = pendingDelete.current.get(item.id);
                if (!t) return;
                clearTimeout(t);
                pendingDelete.current.delete(item.id);
                setHidden((old) => { const next = new Set(old); next.delete(item.id); return next; });
            },
        });
    };

    const onMarkAll = async (): Promise<void> => {
        if (markingAll) return;
        setMarkingAll(true);
        setActionError("");
        try {
            await markAllRead();
        } catch (e) {
            if (live.current) setActionError(errorMessage(e, "Could not mark all items read."));
        } finally {
            if (live.current) setMarkingAll(false);
        }
    };

    const visible = (items ?? []).filter((item) => !hidden.has(item.id));

    return <div style={{ display: "grid", gap: 14 }}>
        <div className="inbox-head">
            <div><h2>Reports</h2><span className="dim3">{unread > 0 ? `${unread} unread` : "You’re all caught up"}</span></div>
            <div className="inbox-actions">
                <Btn kind="quiet" sm icon="refresh" disabled={loading} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</Btn>
                {unread > 0 && <Btn sm disabled={markingAll} onClick={() => void onMarkAll()}>{markingAll ? "Marking…" : "Mark all read"}</Btn>}
            </div>
        </div>
        {loadError && <div role="alert"><Empty title="Could not refresh the inbox" icon="warn">{loadError}</Empty></div>}
        {actionError && <div role="alert"><Empty title="Could not update the inbox" icon="warn">{actionError}</Empty></div>}
        {items === null && !loadError && <div role="status"><Empty icon="queue">Loading inbox…</Empty></div>}
        {items !== null && visible.length === 0 && !loadError && <Empty title="Inbox is clear" icon="check">Reports and requests from your agents and the gateway will appear here.</Empty>}
        {visible.map((item) => <InboxRow
            key={item.id}
            item={item}
            expanded={item.id in bodies}
            body={bodies[item.id]}
            reading={reading.has(item.id)}
            discussing={discussing.has(item.id)}
            onToggle={(row) => void toggleRead(row)}
            onDiscuss={(row) => void openDiscuss(row)}
            onChat={onChat}
            onOpenInterface={onOpenInterface}
            onDelete={removeItem}
        />)}
        {hasMore && <div style={{ padding: 12 }}><Btn sm disabled={loadingMore} onClick={() => void load(true)}>{loadingMore ? "Loading…" : "Load older items"}</Btn></div>}
    </div>;
}

function interactionTime(value: string): string {
    const date = parse(value);
    return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

// matches the trailing marker the gateway appends to a capped args/result blob
const TRUNCATION_MARKER = "\n…[truncated]";

function jsonBlock(label: string, raw: string | undefined): ReactElement | null {
    if (raw === undefined) return null;
    const truncated = raw.endsWith(TRUNCATION_MARKER);
    const body = truncated ? raw.slice(0, -TRUNCATION_MARKER.length) : raw;
    let pretty = body;
    try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch { /* not valid JSON on its own — show as received */ }
    return <div className="md">
        <div className="md-code">
            <div className="md-code-head"><span>{label}</span><CopyTextButton text={body} label={`copy ${label.toLowerCase()}`} /></div>
            <pre><code>{pretty}</code></pre>
        </div>
        {truncated && <p className="dim3">Truncated at 256 KiB.</p>}
    </div>;
}

function InteractionFeed({ onAgent, onChat }: Pick<InboxProps, "onAgent" | "onChat">): ReactElement {
    const [agent, setAgent] = useState("");
    const [roster, setRoster] = useState<string[] | null>(null);
    const [page, setPage] = useState<InteractionPage | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
    // the details live in inbox-api's cache, outside React: a read that lands bumps this to draw it and re-check the open rows
    const [landed, setLanded] = useState(0);
    const reading = useRef(new Set<string>());
    const request = useRef<AbortController | null>(null);
    const stale = useRef(false);
    const live = useRef(true);
    const generation = useRef(0);
    const rosterRequest = useRef(0);

    useEffect(() => {
        let alive = true;
        const refresh = (): void => {
            const serial = ++rosterRequest.current;
            void listExchangeAgents()
                .then((rows) => { if (alive && serial === rosterRequest.current) setRoster(rows.map((row) => row.name)); })
                .catch(() => { if (alive && serial === rosterRequest.current) setRoster([]); });
        };
        refresh();
        window.addEventListener("mimi:agent-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
        return () => {
            alive = false;
            rosterRequest.current++;
            window.removeEventListener("mimi:agent-changed", refresh);
            window.removeEventListener("mimi:resync", refresh);
        };
    }, []);

    useEffect(() => {
        if (roster && agent && !roster.includes(agent)) setAgent("");
    }, [roster, agent]);

    const load = useCallback(async (): Promise<void> => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        setError("");
        try {
            const next = await listInteractions(agent || undefined, controller.signal);
            if (!live.current || controller.signal.aborted) return;
            setPage(next);
        } catch (e) {
            if (live.current && !controller.signal.aborted) setError(errorMessage(e, "Could not load agent exchanges. Try again."));
        } finally {
            if (request.current === controller) {
                request.current = null;
                if (live.current) setLoading(false);
                if (live.current && stale.current) { stale.current = false; void load(); }
            }
        }
    }, [agent]);

    useEffect(() => {
        live.current = true;
        generation.current += 1;
        setPage(null);
        setOpen(new Set());
        stale.current = false;
        void load();
        const changed = (): void => { if (request.current) stale.current = true; else void load(); };
        window.addEventListener("mimi:interactions-changed", changed);
        window.addEventListener("mimi:resync", changed);
        return () => {
            live.current = false;
            generation.current += 1;
            request.current?.abort();
            window.removeEventListener("mimi:interactions-changed", changed);
            window.removeEventListener("mimi:resync", changed);
        };
    }, [load]);

    // a failed read closes its row again, so nothing retries until the owner opens it
    const read = async (row: InteractionRow): Promise<void> => {
        if (reading.current.has(row.id)) return;
        const started = generation.current;
        reading.current.add(row.id);
        setError("");
        try {
            await readInteraction(row);
        } catch (e) {
            if (live.current && started === generation.current) {
                setOpen((old) => new Set([...old].filter((id) => id !== row.id)));
                setError(errorMessage(e, "Could not read this exchange. Try again."));
            }
        } finally {
            reading.current.delete(row.id);
            if (live.current) setLanded((n) => n + 1);
        }
    };

    // an open row is read when nothing is cached for it as it stands: as it opens, after a refresh moves it on, after a read made for its older state lands
    useEffect(() => {
        for (const row of page?.interactions ?? []) if (open.has(row.id) && cachedDetail(row) === undefined) void read(row);
    }, [page, open, landed]);

    return <div style={{ display: "grid", gap: 14 }}>
        <div className="inbox-head">
            <div><h2>Delegation</h2><span className="dim3">Work delegated between your agents</span></div>
            <div className="inbox-actions">
                {roster !== null && roster.length > 0 && (
                    <label className="inbox-activity-filter">Agent
                        <select aria-label="Filter by agent" value={agent} onChange={(event) => setAgent(event.target.value)}>
                            <option value="">All agents</option>
                            {roster.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                    </label>
                )}
                <Btn kind="quiet" sm icon="refresh" disabled={loading} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</Btn>
            </div>
        </div>
        {error && <div role="alert"><Empty title="Could not refresh exchanges" icon="warn">{error}</Empty></div>}
        {!page && !error && <div role="status"><Empty icon="chat">Loading exchanges…</Empty></div>}
        {page?.interactions.length === 0 && !error && <Empty title={agent ? "No matching delegations" : "No delegations yet"} icon={agent ? "search" : "chat"}>
            {agent ? "Try another agent." : "Work delegated between your agents will appear here."}
        </Empty>}
        {page?.interactions.map((row) => {
            const expanded = open.has(row.id);
            const detail = expanded ? cachedDetail(row) : undefined;
            const status = row.handled || row.status === "handled" ? "Handled"
                : ({ sent: "Sent", answered: "Answered", failed: "Failed", denied: "Denied" } as Record<string, string>)[row.status] ?? row.status;
            return <article className="item" key={row.id}>
                <div className="meta" style={{ flexWrap: "wrap" }}><span className="mono" style={{ overflowWrap: "anywhere" }}>{row.from} → {row.to}</span><span>{interactionTime(row.createdAt)}</span></div>
                {row.kind === "a2a"
                    ? <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <strong className="mono">{row.command ?? "?"}</strong>
                        <Pill tone={row.status === "failed" || row.status === "denied" ? "bad" : "plain"}>{status}</Pill>
                        {row.durationMs !== undefined && <span className="dim3">{row.durationMs >= 1000 ? `${Math.round(row.durationMs / 100) / 10}s` : `${Math.round(row.durationMs)}ms`}</span>}
                    </div>
                    : <div style={{ display: "flex", gap: 8, alignItems: "center" }}><strong>Delegation</strong><Pill tone={row.status === "failed" ? "bad" : "plain"}>{status}</Pill></div>}
                <div className="acts"><Btn sm onClick={() => setOpen((old) => old.has(row.id) ? new Set([...old].filter((id) => id !== row.id)) : new Set([...old, row.id]))}>{expanded ? "Collapse" : "Read exchange"}</Btn></div>
                {expanded && detail === undefined && <p className="dim3" role="status">Loading the exchange…</p>}
                {expanded && detail === null && <p>This exchange is no longer available.</p>}
                {detail && <div style={{ display: "grid", gap: 10, fontSize: 12 }}>
                    <span className="dim3">Updated {interactionTime(detail.statusChangedAt)}</span>
                    <dl style={{ display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "6px 12px", margin: 0, overflowWrap: "anywhere" }}>
                        <dt>Exchange</dt><dd className="mono" style={{ margin: 0 }}>{detail.id}</dd>
                        {detail.originCallId && <><dt>Origin call</dt><dd className="mono" style={{ margin: 0 }}>{detail.originCallId}</dd></>}
                        {detail.originConversation !== undefined && <><dt>Origin chat</dt><dd style={{ margin: 0 }}>{detail.from} · #{detail.originConversation}</dd></>}
                        {detail.targetConversation !== undefined && <><dt>Recipient chat</dt><dd style={{ margin: 0 }}>{detail.to} · #{detail.targetConversation}</dd></>}
                        {detail.gate && <><dt>Approval reference</dt><dd className="mono" style={{ margin: 0 }}>{detail.gate}</dd></>}
                    </dl>
                    {detail.kind === "a2a" && <div style={{ display: "grid", gap: 10 }}>{jsonBlock("Arguments", detail.args)}{jsonBlock("Result", detail.result)}</div>}
                    <div className="acts" style={{ flexWrap: "wrap" }}>
                        {onChat && detail.originConversation !== undefined && <Btn kind="quiet" sm onClick={() => onChat(detail.from, detail.originConversation!)}>Open origin chat</Btn>}
                        {onChat && detail.targetConversation !== undefined && <Btn kind="quiet" sm onClick={() => onChat(detail.to, detail.targetConversation!)}>Open recipient chat</Btn>}
                        {onAgent && <Btn kind="quiet" sm onClick={() => onAgent(detail.to)}>Open agent</Btn>}
                    </div>
                </div>}
            </article>;
        })}
        {page?.hasMore && <p className="inbox-note">Showing the latest 100 exchanges.</p>}
        {!!page?.interactions.length && <details className="inbox-note"><summary><Icon name="info" sm />What do the statuses mean?</summary><p>Handled means the recipient has processed the delegation. Neither status confirms that a task succeeded.</p></details>}
    </div>;
}

const INBOX_TABS = [{ v: "reports", label: "Reports" }, { v: "activity", label: "Activity" }] as const;

function Inbox({ gate, tab: activity, onAgent, onChat, onOpenInterface }: InboxProps): ReactElement {
    const tab = activity ?? "reports";
    // mounted on first visit and then only hidden, so the feed keeps its place across a switch
    const [activitySeen, setActivitySeen] = useState(tab === "activity");
    if (tab === "activity" && !activitySeen) setActivitySeen(true);
    const pick = (next: "reports" | "activity"): void => go({ at: "inbox", tab: next === "activity" ? next : undefined, gate }, { replace: true });
    return <div className="view inbox-view">
        {/* a place's root has no ‹: only Inbox opened on a gate was pushed over another screen */}
        <header className="head">{gate !== undefined && <BackButton />}<div className="head-main"><h1 className="head-title">Inbox</h1><ConnLine /></div></header>
        <nav className="tabs" role="tablist" aria-label="Inbox" onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next = tab === "reports" ? "activity" : "reports";
            pick(next);
            e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
        }}>
            {INBOX_TABS.map((t) => (
                <button key={t.v} type="button" role="tab" data-tab={t.v} aria-selected={tab === t.v} tabIndex={tab === t.v ? 0 : -1} onClick={() => pick(t.v)}>
                    {t.label}
                </button>
            ))}
        </nav>
        <div className="scroll" role="tabpanel" aria-label={tab === "reports" ? "Reports" : "Activity"}><div className="page">
            <ApprovalRequests open={gate} onOpenChat={onChat} />
            <div hidden={tab !== "reports"}><InboxList onChat={onChat} onOpenInterface={onOpenInterface} /></div>
            {activitySeen && <div hidden={tab !== "activity"}><InteractionFeed onAgent={onAgent} onChat={onChat} /></div>}
        </div></div>
    </div>;
}

export default memo(Inbox);
