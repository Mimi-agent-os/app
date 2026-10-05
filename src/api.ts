// the one place that talks to the gateway; errors are thrown, never swallowed into an empty object
import type { QuestionRequiredEvent, QuestionResolvedEvent } from "@mimi-os/protocol";

import { ApiError, apiFetch, readJson, refusal, type ApiCall } from "./channel.ts";

export interface AgentSummary {
    name: string;
    model: string;
    /** True when that model is the gateway's default rather than one the agent names in code. */
    inherited: boolean;
    // enforced server-side too; the gateway re-reads gateway.db on every poll rather than caching it
    paused: boolean;
    // whether the agent's own process holds a live wire connection right now
    connected: boolean;
    /** UTC "YYYY-MM-DD HH:MM:SS", or null when never seen. */
    lastSeen: string | null;
    /** One line from the agent's agent.json; absent when it declares none. */
    description?: string | undefined;
    /** Admission, enforced gateway-side regardless of what this says. */
    status: PinStatus;
    /** Standing rights, checked on both ends of every cross-agent call. */
    perms: PinPerms;
    /** Lowercase hex sha256 of the avatar the agent ships, kept while it is offline; null when it has none. */
    avatar: string | null;
}

export interface ModelSummary {
    name: string;
    modelUid?: string | null;
    provider: string;
    endpoint: string;
    modelId?: string;
    contextTokens: number;
    isDefault: boolean;
    params: Record<string, unknown>;
    keyEnv: string;
    keySet: boolean;
    /** The model accepts images in a user message; attachment is disabled against a model without it. */
    vision: boolean;
}

export interface ParamField {
    key: string;
    type: "number" | "boolean" | "string" | "json";
    hint?: string;
}

/** One registered adapter, as /api/providers describes it for selection UIs. */
export interface ProviderInfo {
    kind: string;
    keyRequirement?: "required" | "optional" | "none";
    /** Assumed when omitted — a hosted gateway has exactly one endpoint. */
    defaultEndpoint?: string;
    /** Absent = this adapter needs no key at all. */
    keyEnv?: string;
    needsModelId?: boolean;
    endpointHint?: string;
    modelIdHint?: string;
    params: ParamField[];
    /** Unknown params pass validation (gateway pass-through) — the editor offers raw JSON. */
    openParams?: boolean;
    /** Sent only when the adapter declares a keyEnv, never the value itself. */
    keySet?: boolean;
}

interface NewModel {
    name: string;
    provider: string;
    endpoint?: string;
    modelId?: string;
    contextTokens: number;
    params?: Record<string, unknown>;
    vision?: boolean;
    /** Written once into the encrypted mimi/.env server-side; never readable back. */
    apiKey?: string;
}

// `name` renames the gateway's registry row, its default pointer, agent model policies and key env; agents name models in code (runAgent({ model })), so no agent file is rewritten
export interface ModelPatch {
    name?: string;
    endpoint?: string;
    modelId?: string;
    contextTokens?: number;
    params?: Record<string, unknown>;
    vision?: boolean;
    /** Write-only: replaces the provider key in the encrypted mimi/.env; never readable back. */
    apiKey?: string;
}

/** The key fields appear only when `apiKey` was sent. */
export interface ModelPatched {
    ok: boolean;
    vision?: boolean;
    keyEnv?: string;
    rebuilt?: number;
    /** Chats mid-turn that keep the OLD key until that turn ends. */
    busy?: number[];
    renamed?: { from: string; to: string; agents: string[]; busy: number[] };
}

export interface PingResult {
    ok: boolean;
    /** Reported for failures too — how a timeout is told apart from a refusal. */
    ms: number;
    text?: string | undefined;
    error?: string | undefined;
}

// mirrored rather than imported — the browser bundle must not reach into the server's path aliases; timestamps are UTC "YYYY-MM-DD HH:MM:SS"

/** Precedence order, first match wins: down (no socket / no health frame) → degraded (connected but not approved) → ok. */
export type Health = "ok" | "degraded" | "down";

interface DashboardAgent {
    name: string;
    description?: string | undefined;
    health: Health;
    status: PinStatus;
    /** Empty when `health` is ok. */
    why: string;
    connected: boolean;
    lastActivity: string | null;
    /** Spent on the owner's day: input + output. */
    tokensToday: number;
    /** Those tokens in dollars at each model's current price; 0 on unpriced models. */
    costToday: number;
    paused: boolean;
    avatar: string | null;
}

// tool arguments are deliberately absent — they can hold an email body, and this is polled into a page showing every agent
// a chat gate names its conversation, a room gate its room, never both
interface DashboardApproval {
    agent: string;
    conversation?: number | undefined;
    room?: string | undefined;
    tool: string;
    /** UTC "YYYY-MM-DD HH:MM:SS"; durations are measured against the snapshot's own `at`, never the browser's clock. */
    since: string;
}

/** The owner's day on the gateway (its MIMI_TZ): every "today", daily bucket and model limit runs on it. `resetsAt` is the ISO 8601 UTC instant the next day starts. */
export interface DayInfo {
    today: string;
    timeZone: string;
    resetsAt: string;
}

export interface DashboardSnapshot {
    at: string;
    day: DayInfo;
    /** Every agent's spend on the owner's day, one no longer pinned included; model checks are not an agent's. */
    today: { tokens: number; cost: number };
    // == approvals.length below, so a "2 awaiting approval" strip can never disagree with the rows under it
    waiting: { approvals: number };
    agents: DashboardAgent[];
    approvals: DashboardApproval[];
}

// ── pins: agent admission ────────────────────────────────────────────────────

type PinStatus = "approved" | "blocked";

export interface PinPerms {
    delegate: boolean;
    discoverable: boolean;
}

/** Mirrors PinCard in gateway/src/registry/admission.ts. */
export interface PinCard {
    name: string;
    fingerprint: string;
    status: PinStatus;
    perms: PinPerms;
    pinnedAt: string;
    lastSeen: string | null;
    lastFrom: string | null;
    // the agent socket registry, read fresh on every poll
    connected: boolean;
}

const pinPath = (name: string): string => `/pins/${encodeURIComponent(name)}`;

export const listPins = (): Promise<PinCard[]> => get<PinCard[]>("/pins");

/** Closes the live socket at once, alongside the status flip. */
export const blockPin = (name: string): Promise<PinCard> => post<PinCard>(`${pinPath(name)}/block`);

export const patchPinPerms = (name: string, perms: Partial<PinPerms>): Promise<PinCard> =>
    send<PinCard>("PATCH", pinPath(name), { perms });

/** 404 when there was no pin under that name. */
export const revokePin = (name: string): Promise<{ ok: boolean; revoked: string }> =>
    send<{ ok: boolean; revoked: string }>("DELETE", pinPath(name));

// ── agent invites: the way an agent gets admitted ───────────────────────────

/** Never logged or toasted — `uri` carries the pairing secret. Single-use, 24h TTL, RAM-only on the gateway. */
export interface AgentInvite {
    uri: string;
    id: string;
    name: string;
    expiresAt: string;
}

/** 400 when `name` fails `isAgentName`. Re-inviting an existing name replaces that pin's key on redemption. */
export const createAgentInvite = (name: string): Promise<AgentInvite> => post<AgentInvite>("/agent-invites", { name });

/** The agent invites still open on the gateway — no `uri` here, the secret is shown once at creation. */
export interface AgentInviteSummary {
    id: string;
    name: string;
    expiresAt: string;
}
export const listAgentInvites = (): Promise<AgentInviteSummary[]> =>
    get<{ invites: AgentInviteSummary[] }>("/agent-invites").then((r) => r.invites);

/** 404 when there was no open invite under that id. */
export const cancelAgentInvite = (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>("DELETE", `/agent-invites/${encodeURIComponent(id)}`);

// ── chats ───────────────────────────────────────────────────────────────────

/** `title` is null until the first message names it server-side. */
export interface ConversationInfo {
    id: number;
    title: string | null;
    archived: boolean;
    pinned: boolean;
    createdAt: string;
    /** UTC "YYYY-MM-DD HH:MM:SS" of the last message or edit; every list sorts by it. */
    updatedAt: string;
    messages: number;
    /** Live registry, not the db — the cue to re-attach via attachTurn instead of offering a composer that would 409. */
    busy: boolean;
    awaitingApproval: boolean;
    /** Mirrors the db's `title_by_user` — once a human names it, no auto-title may overwrite it again. */
    titleByUser: boolean;
    /** The running turn's sequence, present only while `busy`. */
    activeTurnSeq?: number | undefined;
}

/** `arguments` is the raw JSON string the model produced, shown not parsed — a model can emit JSON we'd fail to parse. */
interface ToolCall {
    /** What a later tool_result event pairs back onto. */
    id?: string;
    name: string;
    arguments: string;
}

/** Keyed by `id` so a batch of several parked calls can answer "allow" on one without meaning it for its neighbours. */
export interface GateAction {
    id: string;
    tool: string;
    args: Record<string, unknown>;
}

// this union is the streaming contract: the gateway writes one of these per line, closing the response when the turn ends
export type TurnEvent =
    | { type: "turn_started"; turnSeq: number }
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool_calls"; calls: ToolCall[] }
    /** A progress cue — the batch already listed the calls. */
    | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
    | { type: "tool_result"; id: string; name: string; text: string }
    | { type: "compacted"; covers: unknown; messages: number }
    /** The provider failed mid-round and the fallback model is redoing it; whatever the failed attempt streamed must be dropped (see `dropAttempt` in chat.tsx). */
    | { type: "restart"; reason?: string; model?: string }
    | { type: "log"; text: string }
    | {
          type: "approval_required";
          /** Unique within the chat and rides back in the answer — a stale tab cannot resolve a gate that already expired; the server 409s if the parked gate differs. */
          gate: string;
          actions: GateAction[];
          /** Epoch ms; server-authoritative, so a replay after reload counts down the real remaining time, not a fresh 5:00. */
          deadline: number;
      }
    /** Keyed by action id. Needed for the replay log: a page that re-attaches mid-turn rebuilds the thread from the log alone, and without this an answered gate would replay as still-waiting and re-answering it would 409. */
    | { type: "approval_resolved"; gate: string; decisions: Record<string, boolean> }
    /** ask_owner parks the turn on a question gate, answered on POST /approvals/:gate/reply; both replay on attach like an approval. */
    | QuestionRequiredEvent
    | QuestionResolvedEvent
    | { type: "error"; message: string }
    | { type: "done"; answer: string; finalCallId?: string; registryModel?: string; requestedModel?: string; reportedModel?: string; completionTokens?: number; callDurationMs?: number; turnDurationMs?: number; rounds?: number };

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(15_000);
    const c = await apiFetch(path, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!c.res.ok) {
        const said = await refusal(c);
        throw new ApiError(c.res.status, `GET ${path} → ${c.res.status}${said ? `: ${said}` : ""}`);
    }
    return readJson<T>(c);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const c = await apiFetch(path, {
        method,
        ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!c.res.ok) {
        const said = await refusal(c);
        throw new ApiError(c.res.status, `${method} ${path} → ${c.res.status}${said ? `: ${said}` : ""}`);
    }
    return readJson<T>(c);
}

const post = <T>(path: string, body?: unknown): Promise<T> => send<T>("POST", path, body);

export const listAgents = (): Promise<AgentSummary[]> => get<AgentSummary[]>("/agents");
export const listModels = (): Promise<ModelSummary[]> => get<ModelSummary[]>("/models");

/** Spent is `totalTokens`, input + output. `cost` is dollars at each model's current price, never stored. `estimatedCalls` ended without a usage report and carry the gateway's estimate. */
export interface UsageTotals {
    calls: number;
    estimatedCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
}

/** `model` is the provider's model id, "" when the call never named one. */
export interface UsageCell extends UsageTotals {
    agent: string;
    model: string;
    registryModel: string | null;
}

export interface UsageStats {
    /** "" when `days` is 0 (all history, no lower bound). */
    sinceDay: string;
    /** Clamped to 0…365; 0 = all history, 1 = the owner's today. */
    days: number;
    agent: string | null;
    day: DayInfo;
    rows: UsageCell[];
    /** With `group=registry`; `modelUid` null is spend no registry row chose. */
    registryRows?: (UsageTotals & { modelUid: string | null; registryModel: string | null })[];
    totals: UsageTotals;
}

/** Days with no calls are simply absent: the bar strip fills gaps itself. */
export interface UsageDay extends UsageTotals {
    day: string;
    model: string;
    registryModel: string | null;
}

export interface UsageDaily {
    agent: string | null;
    sinceDay: string;
    day: DayInfo;
    rows: UsageDay[];
}

/** `days: 0` asks for all history. */
export const getUsage = (days: number, group?: "registry", signal?: AbortSignal, agent?: string | null): Promise<UsageStats> =>
    get<UsageStats>(`/stats/usage?days=${days}${group ? `&group=${group}` : ""}${agent == null ? "" : `&agent=${encodeURIComponent(agent)}`}`, signal);

/** Clamped to 1…365 server-side: every day becomes one bar. */
export const getUsageDaily = (days: number, signal?: AbortSignal, agent?: string | null): Promise<UsageDaily> =>
    get<UsageDaily>(`/stats/daily?days=${days}${agent == null ? "" : `&agent=${encodeURIComponent(agent)}`}`, signal);

export const getDashboard = (): Promise<DashboardSnapshot> => get<DashboardSnapshot>("/dashboard");

const agentPath = (agent: string): string => `/agents/${encodeURIComponent(agent)}`;

const AVATAR_TYPES = ["image/png", "image/webp", "image/jpeg"];

export async function getAgentAvatar(agent: string, sha256: string): Promise<Blob> {
    const path = `${agentPath(agent)}/avatar?v=${sha256}`;
    const c = await apiFetch(path);
    if (!c.res.ok) throw new ApiError(c.res.status, `GET ${path} → ${c.res.status}`);
    const type = c.res.headers.get("content-type") ?? "";
    // a blob: URL opened as a page runs in the pult's origin, so only a raster type ever becomes one
    if (!AVATAR_TYPES.includes(type)) throw new Error(`GET ${path}: not an avatar (${type || "no content-type"})`);
    if (c.res.headers.get("etag") !== `"${sha256}"`) throw new Error(`GET ${path}: the avatar changed while it loaded`);
    return new Blob([await c.res.arrayBuffer()], { type });
}

/** `cleared` counts the cached sessions dropped; the agent process keeps running. */
export const clearAgentCache = (name: string): Promise<{ ok: boolean; cleared: number }> =>
    post<{ ok: boolean; cleared: number }>(`${agentPath(name)}/clear-cache`);

/** Aborts every in-flight turn across all chats and pauses the agent (unlike stopTurn, also stops the future). `turns:0` is idempotent success, not failure. */
export const stopAgent = (name: string): Promise<{ ok: boolean; turns: number }> =>
    post<{ ok: boolean; turns: number }>(`${agentPath(name)}/stop`);

/** Does NOT resurrect aborted turns — resume only lifts the gate. */
export const resumeAgent = (name: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`${agentPath(name)}/resume`);

// ── chats (the streaming surface) ────────────────────────────────────────────────────────

// a chat id comes from the agent's own session list: anything but a positive integer could steer the path to another route
function convPath(agent: string, id: number): string {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("This chat has an invalid id, so nothing was sent.");
    return `${agentPath(agent)}/conversations/${encodeURIComponent(id)}`;
}

/** Archived chats still exist and can still run turns — merely out of the way. */
export const listConversations = (
    agent: string,
    includeArchived = false,
): Promise<ConversationInfo[]> =>
    get<ConversationInfo[]>(`${agentPath(agent)}/conversations${includeArchived ? "?all=1" : ""}`);

// async on purpose, like every chat call below: an id convPath refuses must reject, never throw past a .catch
export const patchConversation = async (
    agent: string,
    id: number,
    patch: { title?: string; archived?: boolean; pinned?: boolean },
): Promise<{ ok: boolean }> => send<{ ok: boolean }>("PATCH", convPath(agent, id), patch);

/** The server names it later, from the first message. */
export async function createConversation(agent: string): Promise<{ id: number }> {
    const { id } = await post<{ id: unknown }>(`${agentPath(agent)}/conversations`);
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error(`${agent} answered with an invalid chat id.`);
    return { id };
}

/** Gone for real, unlike archiving. The caller confirms, not this layer. */
export const deleteConversation = async (agent: string, id: number): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>("DELETE", convPath(agent, id));

/** Folds the earlier part of a chat now; `compacted: false` with a reason when there is nothing to fold or no summary came back. */
export const compactConversation = async (
    agent: string,
    id: number,
): Promise<{ compacted: boolean; reason?: string; covers?: [number, number] }> =>
    post(`${convPath(agent, id)}/compact`);

/** `messageId` and everything after it are deleted for real; refused while a turn is running (the loop holds indices into the history being spliced). Destructive and not undoable — the caller confirms, this layer does not. */
export const truncateFrom = async (
    agent: string,
    id: number,
    messageId: number,
): Promise<{ ok: boolean }> => post<{ ok: boolean }>(`${convPath(agent, id)}/truncate`, { messageId });

/** `stopped: false` means nothing was generating — the desired state, not an error. */
export const stopTurn = async (agent: string, id: number): Promise<{ ok: boolean; stopped: boolean }> =>
    post<{ ok: boolean; stopped: boolean }>(`${convPath(agent, id)}/stop`);

// the consumer's `for await` body runs between reads and must stay synchronous — an approval must never be awaited there, or a reader parked on a click misses a stream that already ended
export async function* runTurn(
    agent: string,
    id: number,
    text: string,
    // data-URIs, at most 4 per message; the gateway refuses the turn if the model has no `vision`
    images: string[],
    // aborts the fetch (socket), not the turn — the gateway keeps it running for attachTurn to pick up; POST …/stop is the only way to end it early
    signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
    const c = await apiFetch(`${convPath(agent, id)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, images }),
        signal: signal ?? null,
    });
    if (!c.res.ok) {
        const said = await refusal(c);
        throw new ApiError(c.res.status, `POST /messages → ${c.res.status}${said ? `: ${said}` : ""}`);
    }
    yield* events(c);
}

/** Replays the turn's events from the first token, then keeps streaming live. 409 means it finished already — reload rows instead of streaming. */
export async function* attachTurn(
    agent: string,
    id: number,
    signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
    const c = await apiFetch(`${convPath(agent, id)}/stream`, { signal: signal ?? null });
    if (!c.res.ok) {
        const said = await refusal(c);
        throw new ApiError(c.res.status, `GET /stream → ${c.res.status}${said ? `: ${said}` : ""}`);
    }
    yield* events(c);
}

/** Shared by runTurn and attachTurn. */
export async function* events(c: ApiCall): AsyncGenerator<TurnEvent> {
    const r = c.res;
    if (!r.body) throw new Error("The server answered without a body, so there is nothing to stream.");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buf += dec.decode(chunk.value, { stream: true });
            let nl = buf.indexOf("\n");
            while (nl >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                nl = buf.indexOf("\n");
                if (!line.trim()) continue;
                let ev: TurnEvent;
                try {
                    ev = JSON.parse(line) as TurnEvent;
                } catch {
                    continue; // a line we cannot parse is a line we must not act on
                }
                yield ev;
            }
        }
    } finally {
        // consumer broke out (unmount, navigation) — the gateway just detaches, the turn keeps running
        await reader.cancel().catch(() => undefined);
    }
}

// ── the model registry (gateway.db, through the gateway's writers) ──────────────────

export const listProviders = (): Promise<ProviderInfo[]> => get<ProviderInfo[]>("/providers");

const modelPath = (name: string): string => `/models/${encodeURIComponent(name)}`;

export const addModel = (entry: NewModel): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>("/models", entry);

export const updateModel = (name: string, patch: ModelPatch): Promise<ModelPatched> =>
    send<ModelPatched>("PATCH", modelPath(name), patch);

export const removeModel = (name: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>("DELETE", modelPath(name));

export const setDefaultModel = (name: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`${modelPath(name)}/default`);

/** Plain text, in the gateway's own env (not an agent's) — an explicit click, never part of any listing. 404 = not set. */
export const revealModelKey = (name: string): Promise<{ key: string; value: string }> =>
    post<{ key: string; value: string }>(`${modelPath(name)}/key/reveal`);

// real traffic (and real money) — only ever runs from an explicit click, never on mount. Never throws: the caller pings models in a sequential loop, and one rejection must not abandon the rest stuck on "checking…"
export async function pingModel(name: string): Promise<PingResult> {
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    let c: ApiCall;
    try {
        c = await apiFetch(`${modelPath(name)}/ping`, { method: "POST" });
    } catch (e) {
        return { ok: false, ms: ms(), error: `ping ${name}: ${(e as Error).message}` };
    }
    const body = (await readJson<Partial<PingResult>>(c).catch(() => null)) as Partial<PingResult> | null;
    if (body && typeof body.ok === "boolean") {
        return {
            ok: body.ok,
            ms: body.ms ?? 0,
            text: body.text,
            error: body.error,
        };
    }
    // no JSON envelope at all — the gateway is down, not the model
    return { ok: false, ms: ms(), error: `ping ${name} → ${c.res.status}` };
}

// ── per-agent model policy ───────────────────────────────────────────────────

// models are a whitelist: `allowed: null` is the TIGHTEST grant (default model only), never "unrestricted" — an empty array means no model at all
export interface AgentModelPolicy {
    primary: string | null;
    fallback: string | null;
    allowed: string[] | null;
    available: string[];
    /** "" when nothing is configured. */
    default: string;
}

/** `null` clears a field; the server refuses a `primary`/`fallback` outside the grants the same body implies. */
export interface AgentModelPolicyPatch {
    primary?: string | null;
    fallback?: string | null;
    allowed?: string[] | null;
}

const agentModelsPath = (agent: string): string => `${agentPath(agent)}/models`;

export const getAgentModels = (agent: string): Promise<AgentModelPolicy> =>
    get<AgentModelPolicy>(agentModelsPath(agent));

export const patchAgentModels = (
    agent: string,
    patch: AgentModelPolicyPatch,
): Promise<AgentModelPolicy> => send<AgentModelPolicy>("PATCH", agentModelsPath(agent), patch);

// ── per-model prices and daily limits (Settings, Limits & prices) ─────────────────

export type LimitUnit = "tokens" | "usd";

/** One registry model; prices are dollars per 1M tokens, `today` is every agent and model check on it since the owner's midnight. */
export interface LimitRow {
    uid: string;
    name: string;
    provider: string;
    priceInPerM: number;
    priceOutPerM: number;
    /** null is unlimited. */
    limit: { unit: LimitUnit; value: number } | null;
    today: { tokens: number; promptTokens: number; completionTokens: number; cost: number };
    day: DayInfo;
}

/** Absent keeps, `limit: null` clears; a tokens limit is a whole number. */
export interface LimitPatch {
    priceInPerM?: number;
    priceOutPerM?: number;
    limit?: { unit: LimitUnit; value: number } | null;
}

export const listLimits = (signal?: AbortSignal): Promise<LimitRow[]> => get<LimitRow[]>("/limits", signal);

export const patchLimit = (model: string, patch: LimitPatch): Promise<LimitRow> =>
    send<LimitRow>("PATCH", `/limits/${encodeURIComponent(model)}`, patch);

// ── the gateway itself ──────────────────────────────────────────────────────

export interface GatewayProbe {
    ok: boolean;
    /** Reported for failures too — a timeout and a refusal differ. */
    ms: number;
    /** Manifests read, proving the answer came from the real gateway and not a dev server serving index.html for an unknown path. */
    agents?: number;
    error?: string;
}

// rides /agents on purpose: it boots nothing and calls no model, unlike /api/health it requires a live session, so it proves the session (not just the process) is up
export async function pingGateway(): Promise<GatewayProbe> {
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    try {
        const list = await listAgents();
        return { ok: true, ms: ms(), agents: list.length };
    } catch (e) {
        return { ok: false, ms: ms(), error: (e as Error).message };
    }
}

// ── the paged history (GET …/messages?limit&before) ──────────────────────────────────────

/** The live stream's ToolCall has no `id`; a restored turn needs one to pair each result to its call. */
interface HistoryToolCall extends ToolCall {
    id: string;
}

// the RAW conversation, not the visible one: `tool` rows and tool-only assistant rows are included so a reload shows what the agent DID, not only what it said
export interface HistoryMessage {
    /** `before=<id>` pages backwards from it. */
    id: number;
    role: "user" | "assistant" | "tool";
    content: string;
    /** User rows only — the data-URIs sent with the message, when the gateway records them. */
    images?: string[];
    meta?: {
        actor?: { kind: "human" | "agent" | "system"; agent?: string };
        callId?: string;
        modelUid?: string | null | undefined;
        registryModel?: string | null | undefined;
        requestedModel?: string | null | undefined;
        reportedModel?: string | null | undefined;
        attempt?: number | null | undefined;
        parentCallId?: string | null | undefined;
        promptTokens?: number | null;
        completionTokens?: number | null;
        cachedTokens?: number | null;
        /** The call ended without a usage report; its tokens are the gateway's estimate. */
        usageEstimated?: boolean | undefined;
        finishReason?: string | null;
        callDurationMs?: number | undefined;
        turnDurationMs?: number;
        rounds?: number;
    };
    /** Assistant rows only. */
    thinking?: string;
    /** Assistant rows only, and only when that message asked for tools. */
    toolCalls?: HistoryToolCall[];
    /** Tool rows only — which call this content answers. */
    toolCallId?: string;
    /** The summary row the model sees instead of the folded block. */
    summary?: boolean;
    at: string;
}

/** Ascending within the page. `hasMore` means older rows exist before `items[0]` — nothing about newer ones. */
interface HistoryPage {
    items: HistoryMessage[];
    hasMore: boolean;
}

/** `before` pages older than that row's id. */
export async function listHistory(
    agent: string,
    id: number,
    limit: number,
    before?: number,
): Promise<HistoryPage> {
    const page = await get<HistoryPage>(
        `${convPath(agent, id)}/messages?limit=${limit}${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`,
    );
    if (!page.items.some((row) => row.role === "assistant" && !row.summary)) return page;
    // only this chat's calls, up to the gateway's cap, however busy the agent is elsewhere; enrichment only, so a failed read never hides history
    const calls = await listLlmCalls(agent, 500, id, AbortSignal.timeout(2000)).catch(() => []);
    if (!Array.isArray(calls)) return page;
    const byMessage = new Map<number, LlmCallInfo | null>();
    for (const call of calls) {
        if (!call || call.callKind !== "turn" || typeof call.callId !== "string" || !call.callId || !Array.isArray(call.messageSeqs)) continue;
        for (const seq of call.messageSeqs) {
            if (!Number.isSafeInteger(seq) || seq <= 0) continue;
            const previous = byMessage.get(seq);
            // Conflicting call references remain unknown; ordering is not proof of authorship.
            byMessage.set(seq, previous === undefined ? call : previous?.callId === call.callId ? previous : null);
        }
    }
    return {
        ...page,
        items: page.items.map((row) => {
            if (row.role !== "assistant" || row.summary) return row;
            const call = byMessage.get(row.id);
            if (!call?.callId || (row.meta?.callId !== undefined && row.meta.callId !== call.callId)) return row;
            return { ...row, meta: {
                callId: call.callId,
                modelUid: call.modelUid,
                registryModel: call.registryModel,
                requestedModel: call.requestedModel,
                reportedModel: call.reportedModel,
                attempt: call.attempt,
                parentCallId: call.parentCallId,
                callDurationMs: typeof call.durationMs === "number" && Number.isFinite(call.durationMs) ? call.durationMs : undefined,
                promptTokens: call.promptTokens,
                completionTokens: call.completionTokens,
                cachedTokens: call.cachedTokens,
                usageEstimated: call.usageEstimated,
                finishReason: call.finishReason,
                ...row.meta,
            } };
        }),
    };
}

// ── one agent's own record: the llm-call trace ─────────────────────────────────

// deliberately WITHOUT the raw payload — one payload can weigh as much as a whole prompt; see getLlmCallRaw
export interface LlmCallInfo {
    id: number;
    /** null on calls outside any chat (a compaction summary, a call the agent made for itself). */
    conversationId: number | null;
    scope: string;
    callId: string | null;
    /** A "ping" (a model check) never reaches an agent's list: the gateway records it under "(gateway)". */
    callKind: "turn" | "oneshot" | "title" | "compaction" | "ping" | null;
    model: string | null;
    /** The registry row that chose the model; it survives a rename. */
    modelUid: string | null;
    registryModel: string | null;
    requestedModel: string | null;
    reportedModel: string | null;
    attempt: number | null;
    parentCallId: string | null;
    turnSeq: number | null;
    messageSeqs: number[] | null;
    /** Anything but "stop" is a call that ended abnormally. */
    finishReason: string | null;
    /** Spent is prompt + completion; null on a call with no usage at all. */
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens: number | null;
    /** No usage report came back (stopped, paused, a deleted chat, a mid-stream failure): the tokens are the gateway's estimate. */
    usageEstimated: boolean;
    /** Dollars at the model's current price; 0 when it has none. */
    cost: number;
    durationMs: number | null;
    /** Completion tokens divided by the gateway's full call duration; not the provider's decode speed. */
    tokensPerSec: number | null;
    createdAt: string;
}

/** Newest first; `conversation` narrows the list to that chat's calls. */
export const listLlmCalls = (agent: string, limit: number, conversation?: number, signal?: AbortSignal): Promise<LlmCallInfo[]> =>
    get<LlmCallInfo[]>(`${agentPath(agent)}/calls?limit=${limit}${conversation === undefined ? "" : `&conversation=${conversation}`}`, signal);

/** `unknown` on purpose: the shape is the provider's, and the only safe rendering is stringifying it into a text node. */
export const getLlmCallRaw = (agent: string, id: number): Promise<unknown> =>
    get<unknown>(`${agentPath(agent)}/calls/${encodeURIComponent(id)}`);
