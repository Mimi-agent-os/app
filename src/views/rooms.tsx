import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

import { events, type AgentSummary, type GateAction, type TurnEvent } from "../api.ts";
import { ApiError } from "../channel.ts";
import { useDialog } from "../components/dialog.tsx";
import { Icon } from "../components/icon.tsx";
import { Markdown } from "../components/markdown.tsx";
import { Btn, Empty, Skeleton, useEntering } from "../components/ui.tsx";
import {
    answerRoomApproval,
    attachRoom,
    changeRoomParticipant,
    createRoom,
    getRoom,
    listRooms,
    roomMessages,
    sendRoomMessage,
    stopRoom,
    supportsRooms,
    type Room,
    type RoomMessage,
} from "../rooms-api.ts";
import "../rooms.css";
import { errorMessage, parse } from "../shared.ts";
import { goLater, leave } from "../route.ts";

interface RoomsProps {
    roomId?: string | undefined;
    agents: readonly AgentSummary[];
    onOpenRoom: (id: string) => void;
    onOpenAgent?: ((agent: string) => void) | undefined;
}

const drafts = new Map<string, string>();
const recipients = new Map<string, string>();

export default function Rooms({ roomId, agents, onOpenRoom, onOpenAgent }: RoomsProps): ReactElement {
    const dialog = useDialog();
    const [available, setAvailable] = useState<boolean | null>(null);
    const [rooms, setRooms] = useState<Room[] | null>(null);
    const entering = useEntering(rooms !== null);
    const [error, setError] = useState("");
    const [creating, setCreating] = useState(false);
    const [showList, setShowList] = useState(roomId === undefined);
    const [search, setSearch] = useState("");
    const lifetime = useRef<AbortController | null>(null);
    const creatingRef = useRef(false);
    const request = useRef(0);

    const updateRoom = useCallback((room: Room): void => {
        // a thread update landing before the first list read must not stand in for that list
        setRooms((current) => current === null ? current : [room, ...current.filter((row) => row.id !== room.id)]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)));
    }, []);

    const reload = useCallback(async (signal: AbortSignal): Promise<void> => {
        const serial = ++request.current;
        try {
            const supported = await supportsRooms(signal);
            if (signal.aborted || serial !== request.current) return;
            setAvailable(supported);
            if (!supported) return;
            const rows = await listRooms(signal);
            if (signal.aborted || serial !== request.current) return;
            setRooms(rows);
            setError("");
        } catch (e) {
            if (!signal.aborted && serial === request.current) setError(errorMessage(e));
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void reload(controller.signal);
        // a change landing mid-refresh may postdate what that refresh read: it earns exactly one more pass
        let refreshing = false;
        let again = false;
        const refresh = (): void => {
            if (refreshing) { again = true; return; }
            refreshing = true;
            void reload(controller.signal).finally(() => {
                refreshing = false;
                if (again && !controller.signal.aborted) { again = false; refresh(); }
            });
        };
        window.addEventListener("mimi:room-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
        return () => {
            controller.abort();
            window.removeEventListener("mimi:room-changed", refresh);
            window.removeEventListener("mimi:resync", refresh);
        };
    }, [reload]);

    useEffect(() => setShowList(roomId === undefined), [roomId]);

    const create = async (): Promise<void> => {
        if (creatingRef.current) return;
        creatingRef.current = true;
        const title = await dialog.prompt({
            title: "New conversation",
            placeholder: "Conversation name (optional)",
            ok: "Create",
        });
        if (title === null || lifetime.current?.signal.aborted) {
            creatingRef.current = false;
            return;
        }
        setCreating(true);
        setError("");
        const signal = lifetime.current?.signal;
        const land = goLater();
        try {
            const room = await createRoom(title || undefined, signal);
            if (signal?.aborted) return;
            setRooms((current) => [room, ...(current ?? []).filter((row) => row.id !== room.id)]);
            setSearch("");
            land({ at: "rooms", room: room.id });
        } catch (e) {
            if (!signal?.aborted) setError(errorMessage(e));
        } finally {
            creatingRef.current = false;
            if (!signal?.aborted) setCreating(false);
        }
    };

    const query = search.trim().toLocaleLowerCase();
    const matchingRooms = rooms?.filter((room) => `${room.title ?? ""} ${room.participants.join(" ")}`.toLocaleLowerCase().includes(query)) ?? [];

    return (
        <div className="view rooms-view" data-list={showList ? "on" : "off"}>
            <aside className="rooms-list" aria-label="Shared conversations">
                <div className="rooms-list-heading">
                    <div><h2>Conversations</h2><span>Shared with your agents</span></div>
                    {available === true && <Btn kind="accent" icon="plus" title="New conversation" disabled={creating} onClick={() => void create()} />}
                </div>
                {rooms === null && !error && available !== false && <div className="rooms-search is-skel" aria-hidden="true"><Icon name="search" sm /><span className="rooms-search-skel"><Skeleton className="inline" h={10} w="58%" /></span></div>}
                {!!rooms?.length && <label className="rooms-search"><Icon name="search" sm /><input type="search" aria-label="Search conversations" placeholder="Find a conversation…" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); setSearch(""); } }} /></label>}
                {error && <div className="rooms-error" role="alert">{error}<Btn sm icon="refresh" onClick={() => {
                    setError("");
                    if (lifetime.current) void reload(lifetime.current.signal);
                }}>Retry</Btn></div>}
                {available === false ? <Empty>Shared conversations are not available on this gateway yet.</Empty>
                    : rooms === null ? (error ? null : <div className="rooms-list-items" aria-hidden="true">{[0, 1, 2, 3].map((n) => <div key={n} className="rooms-list-item is-skel">
                        <span className="rooms-list-avatar" />
                        <span className="rooms-list-copy"><span className="rooms-list-name"><Skeleton className="inline" h={11} w={`${70 - n * 8}%`} /></span>
                        <span className="rooms-list-preview"><Skeleton className="inline" h={9} w={`${52 - n * 6}%`} /></span></span>
                    </div>)}</div>)
                    : rooms.length === 0 ? <div className="rooms-list-empty"><Empty title="A place to start" icon="chat">Bring your agents into one conversation.</Empty>
                        <Btn kind="accent" icon="plus" disabled={creating} onClick={() => void create()}>New conversation</Btn></div>
                    : matchingRooms.length === 0 ? <div className="rooms-search-empty"><Icon name="search" /><strong>No conversations found</strong><p>Try a title or an agent name.</p><Btn sm kind="quiet" onClick={() => setSearch("")}>Clear search</Btn></div>
                    : <div className="rooms-list-items">{matchingRooms.map((room, i) => <button
                        type="button"
                        key={room.id}
                        style={{ "--i": i } as CSSProperties}
                        className={`rooms-list-item${room.id === roomId ? " on" : ""}${entering ? " entering" : ""}`}
                        aria-current={room.id === roomId ? "page" : undefined}
                        onClick={() => { setShowList(false); onOpenRoom(room.id); }}
                    >
                        <span className="rooms-list-avatar" aria-hidden="true"><Icon name="chat" sm /></span>
                        <span className="rooms-list-copy"><span className="rooms-list-name">{room.title || "Untitled conversation"}</span>
                        <span className="rooms-list-preview">{room.busy ? `@${room.busy.agent} is responding…` : room.participants.map((name) => `@${name}`).join(", ") || "Just you · choose an agent"}</span></span>
                        {room.busy && <span className="rooms-list-busy" aria-hidden="true" />}
                    </button>)}</div>}
            </aside>
            <section className="rooms-main" aria-label="Conversation">
                {available === true && roomId !== undefined
                    ? <RoomThread key={roomId} id={roomId} agents={agents} onUpdate={updateRoom} onBack={() => setShowList(true)} onOpenAgent={onOpenAgent} />
                    : <div className="rooms-welcome"><span className="rooms-welcome-symbol"><Icon name="chat" /></span><span className="rooms-eyebrow">A shared space</span><h2>Make room for a good idea.</h2><p>Start a conversation and choose which agent responds. Everyone you add shares its published history.</p>
                        {available === true && <Btn kind="accent" icon="plus" disabled={creating} onClick={() => void create()}>New conversation</Btn>}
                        {available === false && <p>Shared conversations are not available on this gateway yet.</p>}
                    </div>}
            </section>
        </div>
    );
}

interface RoomThreadProps {
    id: string;
    agents: readonly AgentSummary[];
    onUpdate: (room: Room) => void;
    onBack: () => void;
    onOpenAgent?: ((agent: string) => void) | undefined;
}

interface PendingGate {
    gate: string;
    agent: string;
    actions: GateAction[];
    deadline: number;
}

function RoomThread({ id, agents, onUpdate, onBack, onOpenAgent }: RoomThreadProps): ReactElement {
    const [room, setRoom] = useState<Room | null>(null);
    const [messages, setMessages] = useState<RoomMessage[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [error, setError] = useState("");
    const [draft, setDraft] = useState(() => {
        if (drafts.has(id)) return drafts.get(id) ?? "";
        try { return sessionStorage.getItem(`mimi-os:room-draft:${id}`) ?? ""; }
        catch { return ""; }
    });
    const [recipient, setRecipient] = useState(() => recipients.get(id) ?? "");
    const [responseChosen, setResponseChosen] = useState(() => recipients.has(id));
    const [caret, setCaret] = useState(0);
    const [mentionDismissed, setMentionDismissed] = useState(false);
    const [mentionIndex, setMentionIndex] = useState(0);
    const [agentPickerOpen, setAgentPickerOpen] = useState(false);
    const [recipientChoice, setRecipientChoice] = useState<string | null>(null);
    const [recipientError, setRecipientError] = useState("");
    const [working, setWorking] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [participantPending, setParticipantPending] = useState(false);
    const [addAgent, setAddAgent] = useState("");
    const [gate, setGate] = useState<PendingGate | null>(null);
    const lifetime = useRef(new AbortController());
    const stream = useRef<AbortController | null>(null);
    const pendingStream = useRef<AbortController | null>(null);
    const sendingRef = useRef(false);
    const stoppingRef = useRef(false);
    const participantsRef = useRef(false);
    const olderRef = useRef(false);
    const history = useRef<RoomMessage[] | null>(null);
    const historyRevision = useRef(0);
    const request = useRef(0);
    const thread = useRef<HTMLDivElement | null>(null);
    const box = useRef<HTMLTextAreaElement | null>(null);
    const composer = useRef<HTMLFormElement | null>(null);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const nearBottom = useRef(true);
    const prependHeight = useRef<number | null>(null);
    const participantMenu = useRef<HTMLDetailsElement | null>(null);
    const composerHelp = useRef<HTMLDetailsElement | null>(null);
    const busy = working ?? room?.busy?.agent ?? null;
    const joined = room?.participants ?? [];
    const approvedAgents = agents.filter((agent) => agent.status === "approved");
    const availableAgents = approvedAgents.filter((agent) => !joined.includes(agent.name));
    const mention = mentionDismissed ? null : /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(draft.slice(0, caret));
    const pickerShown = agentPickerOpen || mention !== null;
    const mentions = pickerShown ? approvedAgents.filter((agent) => agent.name.toLowerCase().startsWith((agentPickerOpen ? "" : mention?.[1] ?? "").toLowerCase())) : [];
    const mentionAt = Math.min(mentionIndex, mentions.length - 1);
    const recipientUnavailable = recipient !== "" && (!joined.includes(recipient) || !agents.some((agent) => agent.name === recipient && agent.status === "approved"));

    const refresh = useCallback(async (signal: AbortSignal): Promise<Room | null> => {
        const serial = ++request.current;
        const observedStream = stream.current;
        const mayReconcile = observedStream !== null && pendingStream.current !== observedStream;
        const [next, page] = await Promise.all([getRoom(id, signal), roomMessages(id, undefined, signal)]);
        if (signal.aborted || serial !== request.current) return null;
        setRoom(next);
        onUpdate(next);
        if (!next.busy && mayReconcile && stream.current === observedStream) {
            stream.current = null;
            observedStream.abort();
            setWorking(null);
            setGate(null);
        }
        const current = history.current;
        const incoming = new Map(page.messages.map((message) => [message.seq, message]));
        const overlaps = current?.some((message) => incoming.has(message.seq)) ?? false;
        if (!current?.length || !overlaps) {
            // A disconnected screen may miss whole pages; never join disjoint history windows.
            history.current = [...incoming.values()].sort((a, b) => a.seq - b.seq);
            historyRevision.current += 1;
            prependHeight.current = null;
            setHasMore(page.hasMore);
        } else {
            history.current = [...new Map([...current, ...page.messages].map((message) => [message.seq, message])).values()].sort((a, b) => a.seq - b.seq);
            if (history.current[0]!.seq < current[0]!.seq) setHasMore(page.hasMore);
        }
        setMessages(history.current);
        return next;
    }, [id, onUpdate]);

    const consume = useCallback(async (source: AsyncGenerator<TurnEvent>, controller: AbortController, agent: string): Promise<void> => {
        setWorking(agent);
        setGate(null);
        try {
            for await (const event of source) {
                if (controller.signal.aborted || lifetime.current.signal.aborted) break;
                if (event.type === "approval_required") {
                    setGate({ gate: event.gate, agent, actions: event.actions, deadline: event.deadline });
                } else if (event.type === "approval_resolved") {
                    setGate((current) => current?.gate === event.gate ? null : current);
                } else if (event.type === "error") {
                    setError(event.message);
                    break;
                } else if (event.type === "done") {
                    break;
                }
                // Only persisted, authored messages enter the transcript; turn events also contain internal work.
            }
        } catch (e) {
            if (!controller.signal.aborted && !lifetime.current.signal.aborted && !(e instanceof ApiError && e.status === 409)) {
                setError(`Connection interrupted: ${errorMessage(e)}`);
            }
        } finally {
            if (stream.current === controller) stream.current = null;
            if (!controller.signal.aborted && !lifetime.current.signal.aborted) {
                setWorking(null);
                setGate(null);
                try { await refresh(lifetime.current.signal); }
                catch (e) { if (!lifetime.current.signal.aborted) setError(errorMessage(e)); }
            }
        }
    }, [refresh]);

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        let refreshing = false;
        let again = false;
        const sync = async (): Promise<void> => {
            if (controller.signal.aborted) return;
            if (refreshing) { again = true; return; }
            refreshing = true;
            try {
                const next = await refresh(controller.signal);
                if (next?.busy && !stream.current && !sendingRef.current && !controller.signal.aborted) {
                    const connection = new AbortController();
                    stream.current = connection;
                    void consume(attachRoom(id, connection.signal), connection, next.busy.agent);
                }
            } catch (e) {
                // a room that no longer exists is left for the list, so Back and the landing stop reopening it
                if (e instanceof ApiError && e.status === 404) leave({ at: "rooms", room: id }, { at: "rooms" });
                else if (!controller.signal.aborted) setError(errorMessage(e));
            } finally {
                refreshing = false;
                if (again) { again = false; void sync(); }
            }
        };
        const updated = (event: Event): void => {
            const detail = (event as CustomEvent<{ room?: string | number }>).detail;
            if (String(detail?.room) === id) void sync();
        };
        const resync = (): void => void sync();
        void sync();
        window.addEventListener("mimi:room-changed", updated);
        window.addEventListener("mimi:resync", resync);
        return () => {
            controller.abort();
            stream.current?.abort();
            stream.current = null;
            pendingStream.current = null;
            window.removeEventListener("mimi:room-changed", updated);
            window.removeEventListener("mimi:resync", resync);
        };
    }, [id, refresh, consume]);

    useEffect(() => {
        drafts.set(id, draft);
        try {
            if (draft) sessionStorage.setItem(`mimi-os:room-draft:${id}`, draft);
            else sessionStorage.removeItem(`mimi-os:room-draft:${id}`);
        } catch {
            // Keep the in-memory draft when browser storage is unavailable.
        }
    }, [id, draft]);

    useEffect(() => {
        if (responseChosen) recipients.set(id, recipient);
        else recipients.delete(id);
    }, [id, recipient, responseChosen]);

    useEffect(() => {
        const close = (event: PointerEvent): void => {
            const menu = participantMenu.current;
            if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
            const help = composerHelp.current;
            if (help?.open && event.target instanceof Node && !help.contains(event.target)) help.open = false;
            if (event.target instanceof Node && !composer.current?.contains(event.target)) {
                setAgentPickerOpen(false);
                setMentionDismissed(true);
            }
        };
        const escape = (event: KeyboardEvent): void => {
            const menu = participantMenu.current?.open ? participantMenu.current : composerHelp.current;
            if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !menu?.open || document.querySelector('[aria-modal="true"]')) return;
            event.preventDefault();
            menu.open = false;
            menu.querySelector("summary")?.focus();
        };
        window.addEventListener("pointerdown", close);
        window.addEventListener("keydown", escape);
        return () => {
            window.removeEventListener("pointerdown", close);
            window.removeEventListener("keydown", escape);
        };
    }, []);

    useLayoutEffect(() => {
        const element = thread.current;
        if (!element) return;
        if (prependHeight.current !== null) {
            element.scrollTop += element.scrollHeight - prependHeight.current;
            prependHeight.current = null;
        } else if (nearBottom.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [messages, gate, busy]);

    useLayoutEffect(() => {
        if (!box.current) return;
        box.current.style.height = "auto";
        box.current.style.height = `${Math.min(box.current.scrollHeight, 140)}px`;
    }, [draft]);

    const send = async (): Promise<void> => {
        const text = draft.trim();
        if (!text || !room || !responseChosen || sendingRef.current || participantsRef.current || recipientChoice !== null || recipientUnavailable || (recipient && (busy || stream.current))) return;
        sendingRef.current = true;
        setSending(true);
        setError("");
        const submitted = draft;
        const to = recipient || undefined;
        const controller = to ? new AbortController() : lifetime.current;
        let accepted = false;
        if (to) {
            stream.current = controller;
            pendingStream.current = controller;
        }
        try {
            const call = await sendRoomMessage(id, text, to, controller.signal);
            if (controller.signal.aborted || lifetime.current.signal.aborted) return;
            accepted = true;
            if (pendingStream.current === controller) pendingStream.current = null;
            setDraft((current) => current === submitted ? "" : current);
            nearBottom.current = true;
            if (to) {
                setWorking(to);
                void consume(events(call), controller, to);
            } else {
                await call.res.body?.cancel();
            }
            await refresh(lifetime.current.signal);
        } catch (e) {
            if (!accepted && to && stream.current === controller) stream.current = null;
            if (!controller.signal.aborted && !lifetime.current.signal.aborted) {
                setError(accepted ? `Message sent; could not refresh the conversation. ${errorMessage(e)}`
                    : e instanceof ApiError ? e.message
                    : `Could not confirm delivery. Check the conversation before sending again. ${errorMessage(e)}`);
                void refresh(lifetime.current.signal).catch(() => undefined);
            }
        } finally {
            if (pendingStream.current === controller) pendingStream.current = null;
            sendingRef.current = false;
            if (!lifetime.current.signal.aborted) setSending(false);
        }
    };

    const changeParticipant = async (agent: string, add: boolean): Promise<boolean> => {
        if (!agent || participantsRef.current) return false;
        participantsRef.current = true;
        setParticipantPending(true);
        setError("");
        const signal = lifetime.current.signal;
        try {
            const next = await changeRoomParticipant(id, agent, add, signal);
            if (signal.aborted) return false;
            if (next.participants.includes(agent) !== add) throw new Error("The gateway did not confirm the participant change. Refresh the conversation before trying again.");
            request.current += 1;
            setRoom(next);
            onUpdate(next);
            setAddAgent("");
            if (!add && recipient === agent) {
                setRecipient("");
                setResponseChosen(false);
            }
            return true;
        } catch (e) {
            if (!signal.aborted) setError(errorMessage(e));
            return false;
        } finally {
            participantsRef.current = false;
            if (!signal.aborted) setParticipantPending(false);
        }
    };

    const chooseRecipient = async (agent: string, removeMention = false): Promise<void> => {
        if (participantsRef.current || !room) return;
        const selectedMention = removeMention && mention ? {
            draft, start: caret - (mention[1]?.length ?? 0) - 1, end: caret,
        } : null;
        setRecipientError("");
        if (agent && !joined.includes(agent)) {
            setRecipientChoice(agent);
            if (!(await changeParticipant(agent, true))) {
                if (!lifetime.current.signal.aborted) setRecipientError(`Could not add @${agent}. Your draft is kept. Select the agent again to retry, or choose Note only.`);
                return;
            }
        }
        if (lifetime.current.signal.aborted) return;
        setRecipient(agent);
        setResponseChosen(true);
        setRecipientChoice(null);
        setAgentPickerOpen(false);
        setMentionDismissed(true);
        if (selectedMention && draftRef.current === selectedMention.draft) {
            const text = selectedMention.draft.slice(0, selectedMention.start) + selectedMention.draft.slice(selectedMention.end);
            setDraft((current) => current === selectedMention.draft ? text : current);
            setCaret(selectedMention.start);
            requestAnimationFrame(() => {
                if (lifetime.current.signal.aborted) return;
                box.current?.focus();
                box.current?.setSelectionRange(selectedMention.start, selectedMention.start);
            });
        } else {
            box.current?.focus();
        }
    };

    const openAgentPicker = (): void => {
        if (composerHelp.current) composerHelp.current.open = false;
        setAgentPickerOpen(true);
        setMentionDismissed(false);
        setMentionIndex(0);
        requestAnimationFrame(() => box.current?.focus());
    };

    const loadOlder = async (): Promise<void> => {
        const first = history.current?.[0];
        if (!first || olderRef.current) return;
        olderRef.current = true;
        setLoadingOlder(true);
        const signal = lifetime.current.signal;
        const revision = historyRevision.current;
        try {
            const page = await roomMessages(id, first.seq, signal);
            if (signal.aborted || revision !== historyRevision.current) return;
            prependHeight.current = thread.current?.scrollHeight ?? null;
            const current = history.current ?? [];
            history.current = [...new Map([...current, ...page.messages].map((message) => [message.seq, message])).values()].sort((a, b) => a.seq - b.seq);
            setMessages(history.current);
            if (!page.messages.length || !current[0] || history.current[0]!.seq < current[0].seq) setHasMore(page.hasMore);
        } catch (e) {
            if (!signal.aborted) setError(errorMessage(e));
        } finally {
            olderRef.current = false;
            if (!signal.aborted) setLoadingOlder(false);
        }
    };

    const stop = async (): Promise<void> => {
        if (stoppingRef.current || !busy) return;
        stoppingRef.current = true;
        setStopping(true);
        const signal = lifetime.current.signal;
        try {
            await stopRoom(id, signal);
            await refresh(signal);
        } catch (e) {
            if (!signal.aborted) setError(errorMessage(e));
        } finally {
            stoppingRef.current = false;
            if (!signal.aborted) setStopping(false);
        }
    };

    return (
        <div className="room-conversation">
            <header className="room-heading">
                <span className="room-back"><Btn icon="back" title="All conversations" onClick={onBack} /></span>
                <div className="room-heading-copy"><h2>{room?.title || "Conversation"}</h2><p>{joined.length ? `You, ${joined.map((name) => `@${name}`).join(", ")}` : "Your shared conversation"}</p></div>
                {room && <details className="room-participants" ref={participantMenu}>
                    <summary aria-label={`Participants, ${joined.length} ${joined.length === 1 ? "agent" : "agents"}`}><span className="room-participant-avatars" aria-hidden="true">{joined.slice(0, 2).map((name) => <span key={name}>{name.slice(0, 1).toUpperCase()}</span>)}</span><span>{joined.length ? `${joined.length} ${joined.length === 1 ? "agent" : "agents"}` : "Add agents"}</span><Icon name="chevron" sm /></summary>
                    <div className="room-participant-panel">
                        <h3>Participants</h3>
                        <p className="rooms-muted">Participants can read this conversation's published history. Adding an agent does not ask it to respond.</p>
                        <div className="room-participant-row"><span>You</span><span className="rooms-muted">Owner</span></div>
                        {joined.map((agent) => <div className="room-participant-row" key={agent}>
                            {onOpenAgent ? <button className="room-agent-link" type="button" onClick={() => onOpenAgent(agent)}>{agent}</button> : <span>{agent}</span>}
                            <button className="btn sm quiet" type="button" disabled={participantPending} aria-label={`Remove ${agent} from this conversation`} onClick={() => void changeParticipant(agent, false)}>Remove</button>
                        </div>)}
                        {availableAgents.length > 0 ? <form className="room-add-agent" onSubmit={(event) => { event.preventDefault(); void changeParticipant(addAgent, true); }}>
                            <label htmlFor={`room-add-${id}`}>Add agent</label>
                            <div><select id={`room-add-${id}`} value={addAgent} disabled={participantPending} onChange={(event) => setAddAgent(event.target.value)}>
                                <option value="">Choose agent…</option>
                                {availableAgents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}{agent.connected ? "" : " · offline"}</option>)}
                            </select><button className="btn accent" type="submit" disabled={!addAgent || participantPending}>Add</button></div>
                        </form> : <p className="rooms-muted">{joined.length ? "All approved agents have joined." : "Approve an agent to add it here."}</p>}
                    </div>
                </details>}
            </header>
            {error && <div className="rooms-error room-error" role="alert"><span>{error}</span><Btn sm icon="refresh" onClick={() => {
                setError("");
                void refresh(lifetime.current.signal).catch((e: unknown) => {
                    if (!lifetime.current.signal.aborted) setError(errorMessage(e));
                });
            }}>Refresh</Btn></div>}
            <div className="room-transcript" ref={thread} onScroll={() => {
                const element = thread.current;
                if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
            }}>
                <div className="room-messages">
                    {hasMore && <div className="room-load-older"><Btn sm disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : "Earlier messages"}</Btn></div>}
                    {messages === null ? (error ? null : [0, 1, 2].map((n) => (
                        <article key={n} className="room-message" aria-hidden="true">
                            <div className="who"><span className="room-author-avatar"><Skeleton w={16} h={16} /></span><Skeleton w={84} h={11} /></div>
                            <div className="body"><div style={{ display: "grid", gap: 8 }}><Skeleton h={13} w="90%" /><Skeleton h={13} w={n % 2 ? "64%" : "78%"} /></div></div>
                        </article>
                    )))
                        : messages.length === 0 ? <div className="room-start"><span className="rooms-welcome-symbol"><Icon name="chat" /></span><span className="rooms-eyebrow">Your next idea starts here</span><h3>Start the conversation</h3>
                            <p>{joined.length ? "Pick who responds. Share what’s on your mind." : "Choose your first agent, then ask away."}</p>
                            <Btn kind="accent" disabled={!room || participantPending} onClick={openAgentPicker}>Choose agent</Btn>
                        </div>
                        : messages.map((message) => {
                            const at = parse(message.createdAt);
                            return <article key={message.seq} className={`room-message${message.author.kind === "human" ? " u" : ""}${message.author.kind === "system" ? " room-system" : ""}`}>
                            <div className="who">
                                <span className="room-author-avatar" aria-hidden="true">{message.author.kind === "human" ? "Y" : message.author.kind === "agent" ? (message.author.agent ?? "A").slice(0, 2).toUpperCase() : "S"}</span>
                                <span className="room-author-name">{message.author.kind === "human" ? "You" : message.author.kind === "agent" ? `@${message.author.agent ?? "agent"}` : "System"}</span>
                                {message.author.kind === "agent" && <span className="room-author-kind">Agent</span>}
                                {!Number.isNaN(at.getTime()) && <time className="room-message-time" dateTime={at.toISOString()} title={at.toLocaleString()}>{at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
                            </div>
                            <div className="body">{message.author.kind === "human" ? message.text : <Markdown text={message.text} />}</div>
                            {message.author.kind === "agent" && message.meta && (message.meta.registryModel || message.meta.requestedModel || message.meta.reportedModel || message.meta.callDurationMs !== undefined || message.meta.turnDurationMs !== undefined) && <details className="room-message-details">
                                <summary><Icon name="models" sm /><span>{message.meta.registryModel || "Response details"}</span><Icon name="chevron" sm /></summary>
                                {message.meta.requestedModel && <span>Requested model: {message.meta.requestedModel}</span>}
                                {message.meta.reportedModel && <span>Reported model: {message.meta.reportedModel}</span>}
                                {message.meta.callDurationMs !== undefined && <span>Final model call: {(message.meta.callDurationMs / 1_000).toFixed(1)} s</span>}
                                {message.meta.turnDurationMs !== undefined && <span>Total response: {(message.meta.turnDurationMs / 1_000).toFixed(1)} s</span>}
                            </details>}
                        </article>; })}
                    {busy && <div className="room-working" role="status"><span className="dot ok" />{gate ? `${busy} needs your approval` : `${busy} is responding…`}</div>}
                    {gate && <RoomApproval key={gate.gate} gate={gate} signal={lifetime.current.signal} onResolved={() => setGate((current) => current?.gate === gate.gate ? null : current)} />}
                </div>
            </div>
            <form ref={composer} className="room-composer" onSubmit={(event) => { event.preventDefault(); if (responseChosen) void send(); else openAgentPicker(); }}>
                {pickerShown && <div className="room-mentions">
                    <div className="room-mentions-heading">Choose who responds <button type="button" aria-label="Close agent picker" onClick={() => { setAgentPickerOpen(false); setMentionDismissed(true); box.current?.focus(); }}>Close</button></div>
                    <p className="room-mentions-note">Adding an agent shares this conversation's published history. Responses start when you send.</p>
                    <div id={`room-mentions-${id}`} role="listbox" aria-label="Choose responding agent">
                    {mentions.map((agent, index) => <button type="button" role="option" key={agent.name} id={`room-mention-${id}-${index}`}
                        aria-selected={index === mentionAt} className={index === mentionAt ? "on" : ""}
                        disabled={participantPending}
                        onMouseDown={(event) => event.preventDefault()} onClick={() => void chooseRecipient(agent.name, true)}>
                        <span className="room-mention-name">@{agent.name}<span className="room-mention-membership">{joined.includes(agent.name) ? "In conversation" : "Add agent"}</span></span>
                        <span>{agent.connected ? joined.includes(agent.name) ? "Responds after you send" : "Will be able to read published history" : "Offline · can join now and respond when connected"}</span>
                    </button>)}
                    </div>
                    {mentions.length === 0 && <p className="room-mentions-note">{approvedAgents.length ? "No approved agents match this name." : "No approved agents are available yet."}</p>}
                    <button type="button" className="room-note-option" disabled={participantPending} onClick={() => void chooseRecipient("")}><Icon name="chat" sm /><span><strong>Note only</strong><small>Save to this conversation without an agent reply</small></span></button>
                </div>}
                <div className="room-composer-top">
                    <button type="button" className={`room-recipient${responseChosen || recipientChoice ? " selected" : ""}`} aria-label="Responding agent" aria-haspopup="listbox" aria-expanded={pickerShown} aria-controls={pickerShown ? `room-mentions-${id}` : undefined} disabled={!room || sending || participantPending} onClick={() => {
                        if (pickerShown) { setAgentPickerOpen(false); setMentionDismissed(true); }
                        else openAgentPicker();
                    }}><span className="room-recipient-symbol" aria-hidden="true">{responseChosen && !recipient && !recipientChoice ? <Icon name="chat" sm /> : "@"}</span><span>{recipientChoice ? `Add ${recipientChoice}` : recipient || (responseChosen ? "Note only" : "Choose agent")}</span><Icon name="chevron" sm /></button>
                    <details className="room-composer-help" ref={composerHelp}><summary aria-label="How conversations work"><Icon name="info" sm /></summary><div><strong>One shared conversation</strong><p>Choose an agent or type @ to select who responds. Adding an agent shares the published history; a response starts only when you send.</p><p>Choose Note only to save a message without an agent reply.</p><span>Enter to send · Shift + Enter for a new line</span></div></details>
                </div>
                <textarea
                    ref={box}
                    aria-label="Message to the conversation"
                    aria-autocomplete="list"
                    aria-controls={mentions.length > 0 ? `room-mentions-${id}` : undefined}
                    aria-activedescendant={mentions.length > 0 ? `room-mention-${id}-${mentionAt}` : undefined}
                    placeholder={recipient ? `Message @${recipient}…` : responseChosen ? "Write a note…" : "Write a message, or @ to choose…"}
                    value={draft}
                    rows={1}
                    disabled={!room}
                    onChange={(event) => { setDraft(event.target.value); setCaret(event.target.selectionStart); setMentionDismissed(false); setMentionIndex(0); }}
                    onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                    onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                        if (pickerShown && event.key === "Escape") { event.preventDefault(); setMentionDismissed(true); setAgentPickerOpen(false); return; }
                        if (mentions.length > 0) {
                            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                event.preventDefault();
                                setMentionIndex((mentionAt + (event.key === "ArrowDown" ? 1 : -1) + mentions.length) % mentions.length);
                                return;
                            }
                            if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                                event.preventDefault();
                                const selected = mentions[mentionAt];
                                if (selected) void chooseRecipient(selected.name, true);
                                return;
                            }
                        }
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                            event.preventDefault();
                            if (responseChosen) void send(); else openAgentPicker();
                        }
                    }}
                />
                <div className="room-composer-actions">
                    <span className="room-composer-caption">{participantPending && recipientChoice ? `Adding @${recipientChoice}…` : recipientChoice ? "Agent not added yet" : !responseChosen ? "Choose a responder above" : recipient ? <><kbd>↵</kbd> to send</> : "Saved here · no agent reply"}</span>
                    <div className="room-send-actions">
                        {busy && <Btn icon="stop" title={`Stop ${busy}`} disabled={stopping} onClick={() => void stop()} />}
                        <button className="btn primary" type="submit" aria-label={sending ? "Sending…" : recipient ? `Ask @${recipient}` : responseChosen ? "Save note" : "Send"} disabled={!room || !responseChosen || !draft.trim() || sending || participantPending || recipientChoice !== null || recipientUnavailable || Boolean(recipient && busy)} title={recipient && busy ? `${busy} is responding. Wait, or choose Note only.` : undefined}>
                            <span className="room-send-label">{sending ? "Sending…" : recipient ? "Ask" : responseChosen ? "Save note" : "Send"}</span><Icon name="send" sm />
                        </button>
                    </div>
                </div>
                {recipientError && <p className="room-composer-note" role="alert">{recipientError}<button type="button" className="btn sm quiet" disabled={participantPending} onClick={() => { if (recipientChoice) void chooseRecipient(recipientChoice, true); }}>Retry agent</button></p>}
                {recipientUnavailable && <p className="room-composer-note">Choose an approved participant to respond, or select Note only.</p>}
            </form>
        </div>
    );
}

function RoomApproval({ gate, signal, onResolved }: { gate: PendingGate; signal: AbortSignal; onResolved: () => void }): ReactElement {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const [now, setNow] = useState(Date.now);
    const pendingRef = useRef(false);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, []);
    const expired = !Number.isFinite(gate.deadline) || now >= gate.deadline;

    const answer = async (allow: boolean): Promise<void> => {
        if (pendingRef.current || expired) return;
        if (Date.now() >= gate.deadline) {
            setNow(Date.now());
            return;
        }
        pendingRef.current = true;
        setPending(true);
        setError("");
        try {
            await answerRoomApproval(gate.gate, Object.fromEntries(gate.actions.map((action) => [action.id, allow && selected.has(action.id)])), signal);
            if (!signal.aborted) onResolved();
        } catch (e) {
            if (!signal.aborted) setError(errorMessage(e));
        } finally {
            pendingRef.current = false;
            if (!signal.aborted) setPending(false);
        }
    };

    return <section className="room-approval" aria-label={`Approval requested by ${gate.agent}`}>
        <h3>Review {gate.agent}’s request</h3>
        <p className="rooms-muted">{expired ? "This request expired. Waiting for the latest state…" : "Select the actions you allow."}</p>
        {gate.actions.map((action) => <div className="room-approval-action" key={action.id}>
            <label><input type="checkbox" checked={selected.has(action.id)} disabled={pending || expired} onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(action.id); else next.delete(action.id);
                return next;
            })} />{action.tool}</label>
            <pre>{JSON.stringify(action.args, null, 2)}</pre>
        </div>)}
        {error && <p className="rooms-error" role="alert">{error}</p>}
        <div className="room-approval-actions">
            <Btn kind="quiet" disabled={pending || expired} onClick={() => void answer(false)}>Deny all</Btn>
            <Btn kind="accent" disabled={pending || expired || selected.size === 0} onClick={() => void answer(true)}>{pending ? "Saving…" : `Allow selected${selected.size ? ` (${selected.size})` : ""}`}</Btn>
        </div>
    </section>;
}
