import { apiFetch, type ApiCall } from "./channel.ts";

export interface InboxItemEvent {
    type: "inbox_item";
    id: number;
    source: "agent" | "system";
    agent: string | null;
    title: string;
    level: "info" | "warn" | "action";
}
interface InboxChangedEvent {
    type: "inbox_changed";
    unread: number;
}
export interface ApprovalEvent {
    type: "approval";
    kind: "approval" | "question";
    agent: string;
    session: number | null;
    room?: string | number;
    gate?: string;
    tool: string;
}
interface DeviceEnrolledEvent {
    type: "device_enrolled";
    id: string;
    name: string;
    sas: string;
}
interface DeviceActivatedEvent {
    type: "device_activated";
    id: string;
}
interface DeviceRevokedEvent {
    type: "device_revoked";
    id: string;
}
interface RoomMessageEvent {
    type: "room_message";
    room: string | number;
    seq: number;
}
interface RoomChangedEvent {
    type: "room_changed";
    room: string | number;
}
interface InteractionEvent {
    type: "interaction";
    id: string;
    kind: "delegate";
    status: string;
}
interface ApprovalResolvedEvent {
    type: "approval_resolved";
    gate: string;
    outcome: string;
}
interface AgentChangedEvent {
    type: "agent_changed";
    name: string;
}
interface ChatChangedEvent {
    type: "chat_changed";
    agent: string;
    session: number;
}
/** The detail of `mimi:chat-changed`: every chat of one agent that changed within one 150 ms burst. */
export interface ChatChangedDetail {
    agent: string;
    sessions: number[];
}
interface UsageChangedEvent {
    type: "usage_changed";
    agent: string;
}
interface LimitsChangedEvent {
    type: "limits_changed";
    model: string;
}
interface ReadyEvent {
    type: "ready";
}
interface PingEvent {
    type: "ping";
}
type GatewayEvent =
    | InboxItemEvent
    | InboxChangedEvent
    | ApprovalEvent
    | DeviceEnrolledEvent
    | DeviceActivatedEvent
    | DeviceRevokedEvent
    | RoomMessageEvent
    | RoomChangedEvent
    | InteractionEvent
    | ApprovalResolvedEvent
    | AgentChangedEvent
    | ChatChangedEvent
    | UsageChangedEvent
    | LimitsChangedEvent
    | ReadyEvent
    | PingEvent;

interface EventHandlers {
    onInboxItem?: (e: InboxItemEvent) => void;
    onApproval?: (e: ApprovalEvent) => void;
}

// a chunk boundary is not a line boundary; a half-line left in the buffer at stream end is dropped rather than guessed at
async function* lines(c: ApiCall): AsyncGenerator<string> {
    if (!c.res.body) throw new Error("GET /events answered without a body");
    const reader = c.res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buf += dec.decode(chunk.value, { stream: true });
            let nl = buf.indexOf("\n");
            while (nl >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                nl = buf.indexOf("\n");
                if (line) yield line;
            }
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}

const MAX_BACKOFF_MS = 30_000;

// "ready" opens the stream on first connect and on every reconnect; both mean "you may have missed events", so it maps to the resync signal every live view listens for
const WINDOW_EVENT: Partial<Record<GatewayEvent["type"], string>> = {
    ready: "mimi:resync",
    inbox_item: "mimi:inbox-changed",
    inbox_changed: "mimi:inbox-changed",
    approval: "mimi:approvals-changed",
    approval_resolved: "mimi:approvals-changed",
    device_enrolled: "mimi:paired-devices-changed",
    device_activated: "mimi:paired-devices-changed",
    device_revoked: "mimi:paired-devices-changed",
    room_message: "mimi:room-changed",
    room_changed: "mimi:room-changed",
    interaction: "mimi:interactions-changed",
    agent_changed: "mimi:agent-changed",
    chat_changed: "mimi:chat-changed",
    usage_changed: "mimi:usage-changed",
    // a new price reprices every cost on screen, so whatever shows one refetches at once
    limits_changed: "mimi:usage-changed",
};

// never throws: every failure is swallowed into the backoff loop, since the stream going quiet must not take the rest of the app down
export function subscribeEvents(handlers: EventHandlers): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let agentBurst: ReturnType<typeof setTimeout> | null = null;
    let usageBurst: ReturnType<typeof setTimeout> | null = null;
    const chatBursts = new Map<string, { sessions: number[]; timer: ReturnType<typeof setTimeout> }>();

    const dispatch = (ev: GatewayEvent): void => {
        if (ev.type === "inbox_item") handlers.onInboxItem?.(ev);
        if (ev.type === "approval") handlers.onApproval?.(ev);
        const name = WINDOW_EVENT[ev.type];
        if (!name) return;
        // agent_changed comes in bursts (every agent reconnecting after a gateway restart): listeners refetch whole lists, so one signal per 100 ms
        if (ev.type === "agent_changed") {
            agentBurst ??= setTimeout(() => { agentBurst = null; window.dispatchEvent(new CustomEvent(name)); }, 100);
            return;
        }
        // every model call reports usage, and what listens refetches the dashboard: one trailing signal per 3 s
        if (ev.type === "usage_changed") {
            usageBurst ??= setTimeout(() => { usageBurst = null; window.dispatchEvent(new CustomEvent(name)); }, 3000);
            return;
        }
        // a turn, its title and a list edit each announce the chat; per agent they fold into one list refetch
        if (ev.type === "chat_changed") {
            const burst = chatBursts.get(ev.agent);
            if (burst) {
                if (!burst.sessions.includes(ev.session)) burst.sessions.push(ev.session);
                return;
            }
            const sessions = [ev.session];
            const timer = setTimeout(() => {
                chatBursts.delete(ev.agent);
                window.dispatchEvent(new CustomEvent<ChatChangedDetail>(name, { detail: { agent: ev.agent, sessions } }));
            }, 150);
            chatBursts.set(ev.agent, { sessions, timer });
            return;
        }
        window.dispatchEvent(new CustomEvent(name, { detail: ev }));
    };

    void (async () => {
        let backoff = 1000;
        while (!stopped) {
            controller = new AbortController();
            try {
                const c = await apiFetch("/events", { signal: controller.signal });
                if (!c.res.ok) throw new Error(`GET /events → ${c.res.status}`);
                for await (const line of lines(c)) {
                    let ev: GatewayEvent;
                    try {
                        ev = JSON.parse(line) as GatewayEvent;
                    } catch {
                        continue; // a line we cannot parse is a line we must not act on
                    }
                    // "ready" is the gateway's first line once it really subscribed us; a 200 that ends without it (hub full) stays on the backoff
                    if (ev.type === "ready") backoff = 1000;
                    dispatch(ev);
                }
            } catch {
                // unpaired, refused, or the stream simply ended — fall through to the backoff
            }
            if (stopped) return;
            await new Promise((r) => setTimeout(r, backoff));
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
    })();

    return () => {
        stopped = true;
        controller?.abort();
        if (agentBurst) clearTimeout(agentBurst);
        if (usageBurst) clearTimeout(usageBurst);
        for (const burst of chatBursts.values()) clearTimeout(burst.timer);
        chatBursts.clear();
    };
}
