// The pult's end of bridge.js (mini-app-bridge.js): a mini-app frame's same-origin fetch, EventSource, WebSocket and document.cookie, relayed over this pult's channel as app streams.
import { APP_CHUNK, APP_HEADER_COUNT, APP_PATH_MAX } from "@mimi-os/protocol";
import { gatewayTag, openStream, subscribe, type ChannelStream, type StreamHead, type StreamSink } from "./channel.ts";
import { clearCookies, cookieHeader, matchCookies, parseCookieLine, scriptCookies, storeCookies } from "./mini-app-cookies.ts";
import { base64, Hash, type HashName } from "./mini-app-hash.ts";
import { redirectStep } from "./mini-app-redirect.ts";
import { clientFrame, closePayload, OP_BINARY, OP_CLOSE, OP_PONG, OP_TEXT, WS_MESSAGE_MAX, wsAccept, WsDecoder, WsError } from "./mini-app-ws.ts";
import SOURCE from "./mini-app-bridge.js?raw";

export const BRIDGE_PATH = "/__mimi__/bridge.js";

export interface Door {
    /** The launched app's credential; null = not launched in this pult session (grants are minted only at launch). */
    grantOf(appId: string): Promise<string> | null;
    /** "mimiapp://<appId>.<pin>.<tag>.localhost" from the apps_attach template; null until the app is launched. */
    originOf(appId: string): string | null;
}

/** A multipart form navigation's final reply, held for the GET navigation bridge.js makes next; set-cookie is already stored and gzip already decoded. */
export interface StashedReply {
    status: number;
    headers: [string, string][];
    body: Uint8Array;
}

// what the pult posts to one frame stream before the frame credits it back
const FRAME_WINDOW = 256 * 1024;
const READY_WAIT_MS = 60_000;
const WS_QUEUE_MS = 30_000;
const WS_CLOSE_MS = 5_000;
const STASH_MS = 10_000;
const STASH_MAX = 16 * 1024 * 1024;
const HELLO_WAIT_MS = 10_000;
// how long a closed app's iframe still takes the keepalive requests its last document sent while it went
const LEFT_BEHIND_MS = 10_000;
const SESSIONS_PER_APP = 16;
const IDS_PER_APP = 64;
const KEEPALIVE_MAX = 64 * 1024;
// app/tauri/src-tauri/src/apps.rs refuses a larger scheme body with 413
const UPLOAD_MAX = 64 * 1024 * 1024;
// the frame's own request headers, leaving room under APP_HEADER_MAX and APP_HEADER_COUNT for the jar and what the relay adds
const FRAME_HEADER_BYTES = 12 * 1024;
const FRAME_HEADER_COUNT = APP_HEADER_COUNT - 12;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REQUEST_DROPPED = /^(cookie2?|host|connection|keep-alive|te|trailer|transfer-encoding|upgrade|origin|content-length|accept-encoding|user-agent|accept-language|proxy-.*|sec-websocket-.*|x-mimi-.*)$/;
const REPLY_DROPPED = /^(set-cookie2?|connection|keep-alive|te|trailer|transfer-encoding|upgrade|proxy-.*)$/;
const REDIRECTS = [301, 302, 303, 307, 308];
const utf8 = new TextEncoder();

// ── state ──────────────────────────────────────────────────────────────────
interface Frame {
    el: HTMLIFrameElement;
    appId: string;
    loads: number;
    /** The iframe's WindowProxy at registration: a removed iframe's contentWindow is null, but its leaving document still posts from it. */
    win: Window | null;
    /** Unregistered: only a keepalive request its last document left behind is still taken from it. */
    gone: boolean;
}

interface Session {
    /** null for the stand-in session of a keepalive request left behind by a document, born closed. */
    port: MessagePort | null;
    gateway: string;
    appId: string;
    /** The app's origin when the document said hello. */
    origin: string;
    source: MessageEventSource;
    frame: Frame;
    /** frame.loads when the hello arrived. */
    epoch: number;
    lastId: number;
    ops: Map<number, HttpOp | SocketOp>;
    closed: boolean;
}

interface OpBase {
    id: number;
    session: Session;
    appId: string;
    path: string;
    abort: AbortController;
    stream: ChannelStream | null;
    release: (() => void) | null;
    done: boolean;
    /** The frame is gone: the stream finishes quietly. */
    detached: boolean;
    /** Reply bytes posted to the frame and not yet credited back. */
    outstanding: number;
    paused: boolean;
    wake: (() => void) | null;
    timer: ReturnType<typeof setTimeout> | undefined;
}

interface HttpOp extends OpBase {
    kind: "http";
    body: "none" | "stream" | "inline";
    /** The body length the frame declared, sent upstream as content-length; null for a chunked body. */
    length: number | null;
    credentials: boolean;
    keepalive: boolean;
    nav: boolean;
    inflate: WritableStreamDefaultWriter<BufferSource> | null;
    hashes: Map<HashName, Hash> | null;
    stash: { status: number; headers: [string, string][]; parts: Uint8Array[]; size: number } | null;
    upQueue: Uint8Array[];
    upEnded: boolean;
    upAllowed: number;
    upReceived: number;
    upStalled: boolean;
    sentEnd: boolean;
}

interface Outgoing {
    slices: Generator<Uint8Array>;
    /** Message bytes to report as sent; null for a control frame. */
    n: number | null;
    close: boolean;
}

interface SocketOp extends OpBase {
    kind: "ws";
    protocols: string[];
    key: string;
    decoder: WsDecoder | null;
    open: boolean;
    data: Outgoing[];
    control: Outgoing[];
    writing: Outgoing | null;
    stalled: boolean;
    /** Message bytes the frame posted and the pult has not yet written. */
    upPending: number;
    closeQueued: boolean;
    closeSent: boolean;
    /** Ends once our close frame is out, without waiting for the server's. */
    abandon: boolean;
    ended: boolean;
    serverClose: { code: number; reason: string } | null;
    reported: boolean;
}

interface Pool {
    max: number;
    perApp: number;
    live: number;
    apps: Map<string, number>;
    queue: { appId: string; go: () => void }[];
}

let door: Door | null = null;
let seenTag = "";
const frames = new Map<HTMLIFrameElement, Frame>();
const sessions = new Set<Session>();
const keys = new Map<string, { gateway: string; appId: string }>();
const idsLive = new Map<string, number>();
// one held form reply per app: a newer one replaces a reply its document never came back for, so unclaimed replies cannot pile up
const stash = new Map<string, { gateway: string; path: string; reply: StashedReply; timer: ReturnType<typeof setTimeout> }>();
const awaitingHello = new Map<string, ReturnType<typeof setTimeout>>();
const warned = new Set<string>();
const fetchPool: Pool = { max: 16, perApp: 8, live: 0, apps: new Map(), queue: [] };
// EventSource and WebSocket: streams that stay open
const longPool: Pool = { max: 16, perApp: 8, live: 0, apps: new Map(), queue: [] };
// WebSocket bytes in assembly, per "<gateway>:<appId>": one app holding fragments never fails another app's sockets
const wsBudgets = new Map<string, { used: number; max: number }>();

const randomHex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

function warnBlocked(appId: string): void {
    if (warned.has(appId)) return;
    warned.add(appId);
    console.warn(`mimi-app: ${appId} forbids the bridge script (script-src); streaming, WebSocket and document.cookie are off`);
}

// ── the door: attach, frames, hello ─────────────────────────────────────────
/** Called once by attachAppDoor(): the relay learns launched grants and frame origins from the door, never from a frame. */
export function attachRelay(next: Door): void {
    door = next;
    seenTag = gatewayTag();
    window.addEventListener("message", hello);
    subscribe((snapshot) => {
        const tag = gatewayTag();
        if (snapshot.state === "pairing_required") {
            clearCookies();
            keys.clear();
            for (const held of stash.values()) clearTimeout(held.timer);
            stash.clear();
            for (const session of [...sessions]) fatal(session, "This device is no longer paired.", true);
        } else if (tag !== seenTag) {
            for (const session of [...sessions]) fatal(session, "The paired gateway changed.", true);
        }
        seenTag = tag;
    });
}

/** AppFrame's effect: only a registered iframe, or a same-app frame nested in it, gets a bridge session. */
export function registerFrame(frame: HTMLIFrameElement, appId: string): () => void {
    const entry: Frame = { el: frame, appId, loads: 0, win: frame.contentWindow, gone: false };
    // a document that left without a bye: every load retires the sessions opened before the previous one
    const onLoad = (): void => {
        entry.loads += 1;
        for (const session of [...sessions]) if (session.frame === entry && session.epoch < entry.loads - 1) closeSession(session);
    };
    frames.set(frame, entry);
    frame.addEventListener("load", onLoad);
    return () => {
        frame.removeEventListener("load", onLoad);
        entry.gone = true;
        setTimeout(() => {
            if (frames.get(frame) === entry) frames.delete(frame);
        }, LEFT_BEHIND_MS);
        for (const session of [...sessions]) if (session.frame === entry) closeSession(session);
    };
}

/** A frame's hello, or the keepalive request of a document already past its bye: both prove their frame and app the same way. */
function hello(event: MessageEvent): void {
    const data = event.data as { mimi?: unknown; v?: unknown; key?: unknown; nonce?: unknown; doc?: unknown; fetch?: unknown } | null;
    if (typeof data !== "object" || data === null || (data.mimi !== "hello" && data.mimi !== "keepalive")) return;
    const { v, key, nonce, doc } = data;
    const refuse = (why: string): void => console.debug(`mimi-app: refused a bridge ${String(data.mimi)}: ${why}`);
    if (v !== 1 || typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key)) return refuse("malformed");
    const bound = keys.get(key);
    if (!bound || !door || bound.gateway !== gatewayTag() || door.grantOf(bound.appId) === null) return refuse("unknown key, another gateway, or an app not launched");
    let frame: Frame | null = null;
    let w = event.source as Window | null;
    for (let hop = 0; w && hop <= 8 && w !== window && !frame; hop++) {
        for (const entry of frames.values()) if (entry.el.contentWindow === w || entry.win === w) frame = entry;
        w = w.parent === w ? null : w.parent;
    }
    if (!frame || frame.appId !== bound.appId || (frame.gone && data.mimi === "hello")) return refuse("not from a frame launched for this app");
    if (event.origin !== door.originOf(bound.appId)) return refuse(`origin ${event.origin}`);
    if (data.mimi === "keepalive") return void leftBehind(bound, frame, event.source as MessageEventSource, data.fetch, refuse);
    if (typeof nonce !== "string" || nonce.length > 64 || typeof doc !== "string" || doc.length > 64) return refuse("malformed");
    clearTimeout(awaitingHello.get(doc));
    awaitingHello.delete(doc);
    // one window holds one document at a time
    for (const session of [...sessions]) if (session.source === event.source) closeSession(session);
    const same = [...sessions].filter((s) => s.appId === bound.appId);
    if (same.length >= SESSIONS_PER_APP && same[0]) fatal(same[0], "Too many open documents of this app.", true);
    const channel = new MessageChannel();
    try {
        (event.source as Window).postMessage({ mimi: "welcome", v: 1, nonce }, event.origin, [channel.port2]);
    } catch (error) {
        channel.port1.close();
        return refuse(`the welcome could not be posted: ${String(error)}`);
    }
    const session: Session = {
        port: channel.port1, gateway: bound.gateway, appId: bound.appId, origin: event.origin, source: event.source as MessageEventSource,
        frame, epoch: frame.loads, lastId: 0, ops: new Map(), closed: false,
    };
    sessions.add(session);
    channel.port1.onmessage = (e: MessageEvent) => onPort(session, e.data);
}

/** A keepalive request from a document whose port went with its bye (fetch or sendBeacon in pagehide or unload): sent once, its reply heard by nobody. */
async function leftBehind(bound: { gateway: string; appId: string }, frame: Frame, source: MessageEventSource, fetch: unknown, refuse: (why: string) => void): Promise<void> {
    const m = (typeof fetch === "object" && fetch !== null ? fetch : {}) as Raw;
    if (m.t !== "fetch" || m.keepalive !== true || m.body === "stream") return refuse("not a keepalive request");
    // the dying page posts its Blob as it is, and the pult reads it
    if (m.chunk instanceof Blob) m.chunk = m.chunk.size > KEEPALIVE_MAX ? null : await m.chunk.arrayBuffer().catch(() => null);
    const session: Session = { port: null, gateway: bound.gateway, appId: bound.appId, origin: door?.originOf(bound.appId) ?? "", source, frame, epoch: frame.loads, lastId: 1, ops: new Map(), closed: true };
    startFetch(session, 1, m, () => refuse("malformed"));
}

function closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session);
    for (const op of [...session.ops.values()]) {
        if (op.kind === "http" && op.keepalive) op.detached = true;
        else if (op.kind === "ws" && op.open) {
            op.detached = true;
            failSocket(op, 1001);
        } else cancelOp(op);
    }
    session.port?.close();
}

function fatal(session: Session, message: string, retry: boolean): void {
    post(session, { t: "fatal", message, retry });
    closeSession(session);
}

function post(session: Session, message: object, transfer: Transferable[] = []): void {
    if (session.closed) return;
    try {
        session.port?.postMessage(message, transfer);
    } catch (error) {
        console.error("mimi-app: a relay message could not be posted", error);
    }
}

const postOp = (op: HttpOp | SocketOp, message: object, transfer: Transferable[] = []): void => {
    if (!op.detached) post(op.session, message, transfer);
};

// ── the frame's messages ────────────────────────────────────────────────────
interface Raw {
    t?: unknown; id?: unknown; kind?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown; chunk?: unknown;
    length?: unknown; credentials?: unknown; keepalive?: unknown; nav?: unknown; integrity?: unknown; n?: unknown; protocols?: unknown;
    text?: unknown; bin?: unknown; code?: unknown; reason?: unknown; line?: unknown;
}

function onPort(session: Session, data: unknown): void {
    if (session.closed) return;
    // the app's origin moved to another agent pin since this document said hello: the document belongs to the agent that held the name before
    if (door?.originOf(session.appId) !== session.origin) return fatal(session, "This interface now belongs to another agent. Reload it.", false);
    const m = (typeof data === "object" && data !== null ? data : {}) as Raw;
    const id = typeof m.id === "number" && Number.isSafeInteger(m.id) && m.id > 0 ? m.id : 0;
    const bad = (): void => fatal(session, `A malformed ${String(m.t)} message.`, false);
    if (m.t === "bye") return closeSession(session);
    // asked once welcomed: cookies set between this document's injection and its welcome, after its own queued assignments
    if (m.t === "cookies") return post(session, { t: "cookies", list: scriptCookies(session.gateway, session.appId) });
    if (m.t === "cookie.set") {
        if (typeof m.line !== "string" || m.line.length > 8192 || typeof m.path !== "string" || !m.path.startsWith("/") || m.path.length > APP_PATH_MAX) return bad();
        const scope = { gateway: session.gateway, appId: session.appId, path: m.path };
        // a refused assignment still gets a snapshot, which corrects the frame's optimistic mirror
        if (storeCookies(scope, [m.line], "script")) cookiesChanged(session.appId);
        else post(session, { t: "cookies", list: scriptCookies(session.gateway, session.appId) });
        return;
    }
    if (id === 0) return bad();
    if (m.t === "fetch" || m.t === "ws") {
        if (id <= session.lastId) return fatal(session, "A reused or decreasing request id.", false);
        session.lastId = id;
        if (m.t === "fetch") startFetch(session, id, m, bad);
        else startSocket(session, id, m, bad);
        return;
    }
    const op = session.ops.get(id);
    if (m.t === "cancel") {
        if (op) cancelOp(op);
        return;
    }
    if (m.t === "credit") {
        if (typeof m.n !== "number" || !Number.isSafeInteger(m.n) || m.n < 0) return bad();
        if (!op) return;
        op.outstanding = Math.max(0, op.outstanding - m.n);
        op.wake?.();
        resumeReply(op);
        return;
    }
    if (op?.kind === "http" && (m.t === "body" || m.t === "end")) {
        if (op.body !== "stream" || op.upEnded) return bad();
        if (m.t === "end") {
            if (op.length !== null && op.upReceived !== op.length) return fatal(session, "A request body shorter than its declared length.", false);
            op.upEnded = true;
        } else {
            if (!(m.chunk instanceof ArrayBuffer)) return bad();
            op.upReceived += m.chunk.byteLength;
            // the upstream frames the body by the declared length, so a body that runs past it would spill into its next request
            if (op.upReceived > op.upAllowed || op.upReceived > (op.length ?? Infinity)) return fatal(session, "A request body past its credit or its declared length.", false);
            op.upQueue.push(new Uint8Array(m.chunk));
        }
        pumpUpload(op);
        return;
    }
    if (op?.kind === "ws" && m.t === "ws.send") {
        const bytes = typeof m.text === "string" ? utf8.encode(m.text) : m.bin instanceof ArrayBuffer ? new Uint8Array(m.bin) : null;
        if (!bytes) return bad();
        if (op.upPending > 0 && op.upPending + bytes.length > FRAME_WINDOW) return fatal(session, "WebSocket data past its credit.", false);
        if (!op.open || op.closeQueued) return;
        if (bytes.length > WS_MESSAGE_MAX) return failSocket(op, 1009);
        op.upPending += bytes.length;
        op.data.push({ slices: clientFrame(typeof m.text === "string" ? OP_TEXT : OP_BINARY, bytes, APP_CHUNK), n: bytes.length, close: false });
        pumpSocket(op);
        return;
    }
    if (op?.kind === "ws" && m.t === "ws.close") {
        const code = m.code === undefined ? null : m.code;
        const reason = typeof m.reason === "string" ? m.reason : "";
        if ((code !== null && (typeof code !== "number" || !(code === 1000 || (code >= 3000 && code <= 4999)))) || utf8.encode(reason).length > 123) return bad();
        if (!op.open || op.closeQueued) return;
        op.closeQueued = true;
        op.data.push({ slices: clientFrame(OP_CLOSE, closePayload(code, reason), APP_CHUNK), n: null, close: true });
        pumpSocket(op);
        return;
    }
    // a message for an id that already finished is a race, not a fault
    if (!["body", "end", "ws.send", "ws.close"].includes(String(m.t))) bad();
}

function track<T extends HttpOp | SocketOp>(op: T): T | null {
    const live = idsLive.get(op.appId) ?? 0;
    if (live >= IDS_PER_APP) return null;
    idsLive.set(op.appId, live + 1);
    op.session.ops.set(op.id, op);
    return op;
}

/** Frees the op's id and slot; its stream is already gone or going. */
function finish(op: HttpOp | SocketOp): void {
    if (op.done) return;
    op.done = true;
    op.session.ops.delete(op.id);
    idsLive.set(op.appId, (idsLive.get(op.appId) ?? 1) - 1);
    op.release?.();
    op.release = null;
    clearTimeout(op.timer);
    op.wake?.();
    if (op.kind === "http" && op.inflate) void op.inflate.abort().catch(() => undefined);
    if (op.kind === "ws") {
        op.decoder?.release();
        op.decoder = null;
    }
}

function cancelOp(op: HttpOp | SocketOp): void {
    if (op.done) return;
    finish(op);
    // queued or opening: the wait rejects; open: channel.ts sends RESET
    op.abort.abort(new Error("cancelled"));
}

function requestLimits(method: string, path: string, headers: readonly (readonly [string, string])[]): string | null {
    if (!/^[A-Za-z]{1,16}$/.test(method) || /^(connect|trace|track)$/i.test(method)) return `method ${method} is not allowed`;
    if (!/^\/[\x21-\x7e]*$/.test(path) || path.includes("#") || path.length > APP_PATH_MAX) return "the path is not a same-origin path";
    if (headers.length > FRAME_HEADER_COUNT) return "too many request headers";
    let bytes = 0;
    for (const [name, value] of headers) {
        if (!TOKEN.test(name) || /[\r\n\0]|[^\x00-\xff]/.test(value)) return `the request header ${name} is not valid`;
        bytes += name.length + value.length;
    }
    return bytes > FRAME_HEADER_BYTES ? "the request headers are too large" : null;
}

function requestHeaders(op: HttpOp | SocketOp, pairs: readonly (readonly [string, string])[], method: string, cookies: boolean): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, value] of pairs) if (!REQUEST_DROPPED.test(name.toLowerCase())) out.set(name.toLowerCase(), value);
    const origin = door?.originOf(op.appId);
    if (origin && method !== "GET" && method !== "HEAD") out.set("origin", origin);
    out.set("accept-encoding", "identity");
    out.set("user-agent", navigator.userAgent);
    const languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
    out.set("accept-language", languages.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}`)).join(","));
    const cookie = cookies ? cookieHeader({ gateway: op.session.gateway, appId: op.appId, path: op.path }, "same") : "";
    if (cookie) out.set("cookie", cookie);
    return out;
}

// one FIFO per pool; a waiter whose app is at its share lets the next app go first
function acquire(pool: Pool, appId: string, signal: AbortSignal): Promise<() => void> {
    const release = (): void => {
        pool.live -= 1;
        pool.apps.set(appId, (pool.apps.get(appId) ?? 1) - 1);
        for (let i = 0; i < pool.queue.length && pool.live < pool.max; i++) {
            const next = pool.queue[i]!;
            if ((pool.apps.get(next.appId) ?? 0) >= pool.perApp) continue;
            pool.queue.splice(i--, 1);
            next.go();
        }
    };
    const take = (): (() => void) => {
        pool.live += 1;
        pool.apps.set(appId, (pool.apps.get(appId) ?? 0) + 1);
        return release;
    };
    if (pool.live < pool.max && (pool.apps.get(appId) ?? 0) < pool.perApp && !pool.queue.some((w) => w.appId === appId)) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
        const waiter = { appId, go: () => resolve(take()) };
        pool.queue.push(waiter);
        signal.addEventListener("abort", () => {
            const at = pool.queue.indexOf(waiter);
            if (at >= 0) pool.queue.splice(at, 1);
            reject(signal.reason);
        }, { once: true });
    });
}

/** The launched app's credential for a session still on the current gateway, or null. */
async function credentialFor(session: Session): Promise<string | null> {
    const grant = session.gateway === gatewayTag() ? door?.grantOf(session.appId) ?? null : null;
    try {
        return grant === null ? null : await grant;
    } catch {
        return null;
    }
}

/** openStream, failing after READY_WAIT_MS without a ready channel; only the op's own abort reaches the stream once it is open. */
async function open(op: HttpOp | SocketOp, credential: string, method: string, headers: Map<string, string>, sink: StreamSink, upgrade: boolean): Promise<boolean> {
    const waiting = setTimeout(() => op.abort.abort(new Error("The channel is not ready.")), READY_WAIT_MS);
    try {
        const header = { t: "app" as const, appId: op.appId, credential, method, path: op.path, headers: Object.fromEntries(headers), upgrade: upgrade ? true as const : undefined };
        op.stream = await openStream(header, sink, op.abort.signal);
        return !op.done;
    } catch {
        return false;
    } finally {
        clearTimeout(waiting);
    }
}

// ── fetch and EventSource: an http app stream ───────────────────────────────
function startFetch(session: Session, id: number, m: Raw, bad: () => void): void {
    const headers = m.headers;
    const pairs = Array.isArray(headers) && headers.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string")
        ? headers as [string, string][] : null;
    const body = m.body === "none" || m.body === "stream" || m.body === "inline" ? m.body : null;
    if ((m.kind !== "fetch" && m.kind !== "sse") || typeof m.method !== "string" || typeof m.path !== "string" || !pairs || !body
        || (m.length !== undefined && (typeof m.length !== "number" || !Number.isSafeInteger(m.length) || m.length < 0))
        || (body === "inline" && !(m.chunk instanceof ArrayBuffer)) || (m.integrity !== undefined && typeof m.integrity !== "string")) return bad();
    const method = m.method.toUpperCase();
    const op = track<HttpOp>({
        kind: "http", id, session, appId: session.appId, path: m.path, abort: new AbortController(), stream: null, release: null, done: false,
        detached: session.closed, outstanding: 0, paused: false, wake: null, timer: undefined, body,
        length: typeof m.length === "number" ? m.length : null, credentials: m.credentials !== "omit",
        keepalive: m.keepalive === true, nav: m.nav === true, inflate: null, hashes: null, stash: null, upQueue: [], upEnded: body !== "stream",
        upAllowed: 0, upReceived: 0, upStalled: false, sentEnd: false,
    });
    if (!op) return post(session, { t: "error", id, message: "too many requests from this app at once" });
    const inline = body === "inline" ? new Uint8Array(m.chunk as ArrayBuffer) : null;
    const whole = body === "stream" ? null : inline?.length ?? 0;
    const refused = requestLimits(m.method, m.path, pairs) ?? (inline && inline.length > KEEPALIVE_MAX ? "an inline body over 64 KiB" : null)
        ?? (op.length !== null && whole !== null && op.length !== whole ? "the declared length is not the body's" : null);
    if (refused) return failFetch(op, refused);
    if (inline) op.upQueue.push(inline);
    for (const token of typeof m.integrity === "string" ? m.integrity.split(/\s+/) : []) {
        const name = /^(sha256|sha384|sha512)-/.exec(token)?.[1] as HashName | undefined;
        if (name) (op.hashes ??= new Map()).set(name, op.hashes.get(name) ?? new Hash(name));
    }
    void (async () => {
        try {
            op.release = await acquire(m.kind === "sse" ? longPool : fetchPool, op.appId, op.abort.signal);
        } catch {
            return;
        }
        // cancelled in the same task that granted the slot
        if (op.done) return op.release();
        const credential = await credentialFor(session);
        if (credential === null) return failFetch(op, "this app is not launched in the control panel");
        const headers = requestHeaders(op, pairs, method, op.credentials);
        if (op.length !== null) headers.set("content-length", String(op.length));
        const sink: StreamSink = { head: (h) => onHead(op, h, method), data: (chunk) => onData(op, chunk), end: () => onEnd(op), fail: (e) => failFetch(op, e.message) };
        if (!(await open(op, credential, method, headers, sink, false))) return failFetch(op, "the stream could not be opened: no ready channel within 60 s, or headers too large");
        if (body === "stream") {
            op.upAllowed = FRAME_WINDOW;
            postOp(op, { t: "credit", id, n: FRAME_WINDOW });
        }
        pumpUpload(op);
    })();
}

function failFetch(op: HttpOp, message: string): void {
    if (op.done) return;
    postOp(op, { t: "error", id: op.id, message });
    finish(op);
    op.abort.abort(new Error(message));
}

function pumpUpload(op: HttpOp): void {
    const stream = op.stream;
    if (!stream || op.done || op.upStalled) return;
    let written = 0;
    while (op.upQueue.length > 0) {
        const chunk = op.upQueue[0]!;
        const part = chunk.subarray(0, APP_CHUNK);
        if (part.length === chunk.length) op.upQueue.shift();
        else op.upQueue[0] = chunk.subarray(part.length);
        written += part.length;
        if (!stream.write(part)) {
            op.upStalled = true;
            stream.onDrain(() => {
                op.upStalled = false;
                pumpUpload(op);
            });
            break;
        }
    }
    if (written > 0 && op.body === "stream") {
        op.upAllowed += written;
        postOp(op, { t: "credit", id: op.id, n: written });
    }
    if (!op.upStalled && op.upQueue.length === 0 && op.upEnded && !op.sentEnd) {
        op.sentEnd = true;
        stream.end();
    }
}

function onHead(op: HttpOp, head: StreamHead, method: string): void {
    const lines = head.headers.filter(([name]) => name === "set-cookie").map(([, value]) => value);
    // the snapshot goes out first, so the frame's mirror is current when its code sees the reply
    if (lines.length > 0 && op.credentials && storeCookies({ gateway: op.session.gateway, appId: op.appId, path: op.path }, lines, "http")) cookiesChanged(op.appId);
    const encoding = (head.headers.find(([name]) => name === "content-encoding")?.[1] ?? "identity").trim().toLowerCase();
    // a HEAD, a 204 or a 304 names its encoding over no body at all, and there is nothing to decode
    const bodiless = method === "HEAD" || [101, 103, 204, 205, 304].includes(head.status);
    const inflating = !bodiless && (encoding === "gzip" || encoding === "x-gzip" || encoding === "deflate");
    if (encoding !== "identity" && !bodiless && !inflating) {
        op.stream?.reset();
        return failFetch(op, `the app sent a ${encoding} reply the control panel cannot decode`);
    }
    const headers = head.headers.filter(([name, value]) => !REPLY_DROPPED.test(name) && !/[\r\n\0]|[^\x00-\xff]/.test(value)
        && !(encoding !== "identity" && (name === "content-encoding" || name === "content-length")));
    if (inflating) {
        const inflater = new DecompressionStream(encoding === "deflate" ? "deflate" : "gzip");
        op.inflate = inflater.writable.getWriter();
        void inflate(op, inflater.readable.getReader());
    }
    if (op.nav && !REDIRECTS.includes(head.status)) op.stash = { status: head.status, headers, parts: [], size: 0 };
    else postOp(op, { t: "head", id: op.id, status: head.status, headers });
}

function onData(op: HttpOp, chunk: Uint8Array): boolean {
    if (!op.inflate) return emit(op, chunk);
    op.inflate.write(chunk as Uint8Array<ArrayBuffer>).catch(() => undefined);
    if ((op.inflate.desiredSize ?? 0) > 0 && op.outstanding < FRAME_WINDOW) return true;
    op.paused = true;
    op.inflate.ready.then(() => resumeReply(op), () => undefined);
    return false;
}

/** Decoded (or plain) reply bytes to the frame; false once the frame holds a window. */
function emit(op: HttpOp, bytes: Uint8Array): boolean {
    for (const hash of op.hashes?.values() ?? []) hash.update(bytes);
    if (op.stash) {
        op.stash.size += bytes.length;
        if (op.stash.size > STASH_MAX) {
            op.stream?.reset();
            failFetch(op, "the form's reply is larger than the desktop app carries");
            return false;
        }
        op.stash.parts.push(new Uint8Array(bytes));
        return true;
    }
    if (op.detached) return true;
    // a copy with an ArrayBuffer of its own, so it can be transferred
    const copy = new Uint8Array(bytes);
    op.outstanding += copy.length;
    postOp(op, { t: "data", id: op.id, chunk: copy.buffer }, [copy.buffer]);
    if (op.outstanding < FRAME_WINDOW) return true;
    op.paused = true;
    return false;
}

function resumeReply(op: HttpOp | SocketOp): void {
    const inflate = op.kind === "http" ? op.inflate : null;
    if (!op.paused || op.done || op.outstanding >= FRAME_WINDOW || (inflate && (inflate.desiredSize ?? 0) <= 0)) return;
    op.paused = false;
    op.stream?.resume();
}

async function inflate(op: HttpOp, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
            emit(op, r.value);
            while (!op.done && !op.detached && op.outstanding >= FRAME_WINDOW) await new Promise<void>((wake) => { op.wake = wake; });
            op.wake = null;
            if (op.done) return void reader.cancel().catch(() => undefined);
            resumeReply(op);
        }
    } catch {
        if (op.done) return;
        op.stream?.reset();
        return failFetch(op, "the app's compressed reply is corrupt");
    }
    finishReply(op);
}

function onEnd(op: HttpOp): void {
    if (op.inflate) op.inflate.close().catch(() => undefined);
    else finishReply(op);
}

function finishReply(op: HttpOp): void {
    if (op.done) return;
    const digests = op.hashes ? Object.fromEntries([...op.hashes].map(([name, hash]) => [name, base64(hash.digest())])) : undefined;
    if (op.stash) {
        const { status, headers, parts, size } = op.stash;
        const body = new Uint8Array(size);
        parts.reduce((at, part) => (body.set(part, at), at + part.length), 0);
        const { appId } = op;
        clearTimeout(stash.get(appId)?.timer);
        stash.set(appId, { gateway: op.session.gateway, path: op.path, reply: { status, headers, body }, timer: setTimeout(() => stash.delete(appId), STASH_MS) });
        postOp(op, { t: "head", id: op.id, status, headers });
    }
    postOp(op, { t: "end", id: op.id, digests });
    finish(op);
}

// ── WebSocket: an upgrade app stream, RFC 6455 spoken here ─────────────────────
function startSocket(session: Session, id: number, m: Raw, bad: () => void): void {
    const protocols = Array.isArray(m.protocols) && m.protocols.every((p) => typeof p === "string") ? m.protocols as string[] : null;
    if (typeof m.path !== "string" || !protocols) return bad();
    const op = track<SocketOp>({
        kind: "ws", id, session, appId: session.appId, path: m.path, abort: new AbortController(), stream: null, release: null, done: false,
        detached: false, outstanding: 0, paused: false, wake: null, timer: undefined, protocols, key: base64(crypto.getRandomValues(new Uint8Array(16))),
        decoder: null, open: false, data: [], control: [], writing: null, stalled: false, upPending: 0, closeQueued: false, closeSent: false,
        abandon: false, ended: false, serverClose: null, reported: false,
    });
    if (!op) return post(session, { t: "ws.closed", id, code: 1006, reason: "", clean: false });
    if (requestLimits("GET", m.path, []) || !protocols.every((p) => TOKEN.test(p)) || new Set(protocols).size !== protocols.length) return closeSocket(op);
    op.timer = setTimeout(() => closeSocket(op), WS_QUEUE_MS);
    void (async () => {
        try {
            op.release = await acquire(longPool, op.appId, op.abort.signal);
        } catch {
            return;
        }
        if (op.done) return op.release();
        clearTimeout(op.timer);
        const credential = await credentialFor(session);
        if (credential === null) return closeSocket(op);
        const headers = requestHeaders(op, [], "GET", true);
        headers.set("origin", door?.originOf(op.appId) ?? "");
        headers.set("upgrade", "websocket");
        headers.set("connection", "Upgrade");
        headers.set("sec-websocket-key", op.key);
        headers.set("sec-websocket-version", "13");
        if (protocols.length > 0) headers.set("sec-websocket-protocol", protocols.join(", "));
        headers.set("cache-control", "no-cache");
        headers.set("pragma", "no-cache");
        const sink: StreamSink = {
            head: (h) => onSocketHead(op, h),
            data: (chunk) => onSocketData(op, chunk),
            end: () => {
                op.stream?.reset();
                closeSocket(op);
            },
            fail: () => closeSocket(op),
        };
        if (!(await open(op, credential, "GET", headers, sink, true))) closeSocket(op);
    })();
}

/** The frame's close report, once: clean whenever the server's close frame arrived, whatever happened to the stream after it. */
function report(op: SocketOp): void {
    if (op.reported) return;
    op.reported = true;
    const close = op.serverClose;
    postOp(op, { t: "ws.closed", id: op.id, code: close?.code ?? 1006, reason: close?.reason ?? "", clean: close !== null });
}

/** The stream is gone (or never came): report and free everything. */
function closeSocket(op: SocketOp): void {
    report(op);
    cancelOp(op);
}

function onSocketHead(op: SocketOp, head: StreamHead): void {
    const value = (name: string): string | undefined => head.headers.find(([n]) => n === name)?.[1];
    const lines = head.headers.filter(([name]) => name === "set-cookie").map(([, v]) => v);
    if (lines.length > 0 && storeCookies({ gateway: op.session.gateway, appId: op.appId, path: op.path }, lines, "http")) cookiesChanged(op.appId);
    const protocol = value("sec-websocket-protocol")?.trim() ?? "";
    const accepted = head.status === 101 && value("sec-websocket-accept")?.trim() === wsAccept(op.key)
        && (protocol === "" || op.protocols.includes(protocol)) && !value("sec-websocket-extensions")?.trim();
    if (!accepted) {
        op.stream?.reset();
        return closeSocket(op);
    }
    op.open = true;
    const scope = `${op.session.gateway}:${op.appId}`;
    const budget = wsBudgets.get(scope) ?? { used: 0, max: 128 * 1024 * 1024 };
    wsBudgets.set(scope, budget);
    op.decoder = new WsDecoder(budget);
    postOp(op, { t: "ws.open", id: op.id, protocol });
}

function onSocketData(op: SocketOp, chunk: Uint8Array): boolean {
    if (!op.decoder) return true;
    let events;
    try {
        events = op.decoder.push(chunk);
    } catch (error) {
        failSocket(op, error instanceof WsError ? error.code : 1002);
        return true;
    }
    for (const event of events) {
        if (event.kind === "text" || event.kind === "binary") {
            if (op.reported || op.detached) continue;
            const size = event.kind === "text" ? utf8.encode(event.data).length : event.data.length;
            op.outstanding += size;
            if (event.kind === "text") postOp(op, { t: "ws.message", id: op.id, text: event.data });
            else {
                const bin = new Uint8Array(event.data).buffer;
                postOp(op, { t: "ws.message", id: op.id, bin }, [bin]);
            }
        } else if (event.kind === "ping") {
            op.control.push({ slices: clientFrame(OP_PONG, event.data, APP_CHUNK), n: null, close: false });
        } else if (event.kind === "close") {
            op.serverClose = { code: event.code ?? 1005, reason: event.reason };
            op.decoder?.release();
            op.decoder = null;
            if (!op.closeQueued) {
                op.closeQueued = true;
                op.control.push({ slices: clientFrame(OP_CLOSE, closePayload(event.code), APP_CHUNK), n: null, close: true });
            }
            armClose(op);
            break;
        }
    }
    pumpSocket(op);
    endSocket(op);
    if (op.outstanding < FRAME_WINDOW) return true;
    op.paused = true;
    return false;
}

/** Fails the connection: our close frame with `code`, the frame told at once, the stream ended once that frame is out. */
function failSocket(op: SocketOp, code: number): void {
    if (!op.closeQueued) {
        op.closeQueued = true;
        op.control.push({ slices: clientFrame(OP_CLOSE, closePayload(code), APP_CHUNK), n: null, close: true });
    }
    op.abandon = true;
    report(op);
    op.decoder?.release();
    op.decoder = null;
    armClose(op);
    pumpSocket(op);
    endSocket(op);
}

function armClose(op: SocketOp): void {
    clearTimeout(op.timer);
    op.timer = setTimeout(() => closeSocket(op), WS_CLOSE_MS);
}

function endSocket(op: SocketOp): void {
    if (op.ended || !op.closeSent || !(op.serverClose || op.abandon)) return;
    op.ended = true;
    op.stream?.end();
}

function pumpSocket(op: SocketOp): void {
    const stream = op.stream;
    while (stream && !op.stalled && !op.done) {
        op.writing ??= op.control.shift() ?? op.data.shift() ?? null;
        const item = op.writing;
        if (!item) return;
        const next = item.slices.next();
        if (next.done) {
            op.writing = null;
            if (item.n !== null) {
                op.upPending -= item.n;
                postOp(op, { t: "ws.sent", id: op.id, n: item.n });
                postOp(op, { t: "credit", id: op.id, n: item.n });
            }
            if (item.close) {
                op.closeSent = true;
                op.data = [];
                // the server's 5 s start once our close frame is out, not while the data queued before it still drains
                armClose(op);
                endSocket(op);
            }
            continue;
        }
        if (!stream.write(next.value)) {
            op.stalled = true;
            stream.onDrain(() => {
                op.stalled = false;
                pumpSocket(op);
            });
        }
    }
}

// ── what pult-core's serve() calls ──────────────────────────────────────────
/** The frames of this app hear the jar changed: pushed before the reply that changed it is answered. */
export function cookiesChanged(appId: string): void {
    const gateway = gatewayTag();
    for (const session of sessions) {
        if (session.appId === appId && session.gateway === gateway) post(session, { t: "cookies", list: scriptCookies(gateway, appId) });
    }
}

/** A multipart form's final reply, once, for the GET navigation that follows it within 10 s. */
export function takeStashed(appId: string, path: string): StashedReply | null {
    const held = stash.get(appId);
    if (held?.path !== path) return null;
    stash.delete(appId);
    clearTimeout(held.timer);
    return held.gateway === gatewayTag() ? held.reply : null;
}

/** bridge.js with the cookie and redirect rules it shares with the pult spliced in, so each rule has one owner. */
export function bridgeScript(): Uint8Array {
    const limits = JSON.stringify({ window: FRAME_WINDOW, keepalive: KEEPALIVE_MAX, upload: UPLOAD_MAX });
    return utf8.encode(`${SOURCE.trimEnd()}(${parseCookieLine}, ${matchCookies}, ${redirectStep}, ${limits});\n`);
}

/** The nonce to copy onto the bridge tag, "" when none is needed, null when the app's CSP leaves the tag no way in. */
function scriptNonce(csp: string, origin: string): string | null {
    let needed: string[] | null = null;
    for (const policy of csp.split(",")) {
        const directives = new Map<string, string[]>();
        for (const directive of policy.split(";")) {
            const [name, ...values] = directive.trim().split(/\s+/);
            if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values);
        }
        const list = directives.get("script-src-elem") ?? directives.get("script-src") ?? directives.get("default-src");
        if (!list) continue;
        const lower = list.map((source) => source.toLowerCase());
        if (!lower.includes("'strict-dynamic'") && lower.some((s) => s === "'self'" || s === "*" || s === "mimiapp:" || s === origin.toLowerCase())) continue;
        const nonces = list.filter((s) => /^'nonce-[A-Za-z0-9+/_=-]+'$/.test(s)).map((s) => s.slice(7, -1));
        needed = needed === null ? nonces : needed.filter((n) => nonces.includes(n));
        if (needed.length === 0) return null;
    }
    return needed?.[0] ?? "";
}

/** The bridge tag, placed first in the document's head (after a charset meta that must stay in the first 1024 bytes). */
export function injectBridge(html: Uint8Array, doc: { appId: string; csp: string; path: string }): Uint8Array {
    const origin = door?.originOf(doc.appId);
    if (!origin || (html[0] === 0xff && html[1] === 0xfe) || (html[0] === 0xfe && html[1] === 0xff)) return html;
    const gateway = gatewayTag();
    const nonce = scriptNonce(doc.csp, origin);
    if (nonce === null) warnBlocked(doc.appId);
    const docId = randomHex();
    if (nonce !== null && !warned.has(doc.appId)) {
        awaitingHello.set(docId, setTimeout(() => {
            awaitingHello.delete(docId);
            warnBlocked(doc.appId);
        }, HELLO_WAIT_MS));
    }
    let key = [...keys].find(([, bound]) => bound.gateway === gateway && bound.appId === doc.appId)?.[0];
    if (!key) {
        key = randomHex();
        keys.set(key, { gateway, appId: doc.appId });
    }
    const boot = { v: 1, key, doc: docId, pult: location.origin, origin, cookies: scriptCookies(gateway, doc.appId) };
    const json = JSON.stringify(boot).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const attribute = json.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const tag = utf8.encode(`<script src="${origin}${BRIDGE_PATH}" data-mimi="${attribute}"${nonce ? ` nonce="${nonce}"` : ""}></script>`);

    // byte offsets: a latin-1 view keeps one character per byte whatever the page's encoding
    let text = "";
    for (const b of html.subarray(0, 65536)) text += String.fromCharCode(b);
    let head = -1;
    let root = -1;
    let doctype = -1;
    let script = -1;
    let charset = -1;
    let leading = true;
    for (const match of text.matchAll(/<!--[\s\S]*?(?:-->|$)|<(!doctype|html|head|meta|script)(?=[\s/>])[^>]*>?|<[^!]/gi)) {
        const name = match[1]?.toLowerCase();
        const end = match.index + match[0].length;
        if (match[0].startsWith("<!--")) continue;
        if (name === "!doctype" && leading) doctype = end;
        leading = false;
        if (name === "script" && script === -1) script = match.index;
        else if (name === "html" && root === -1) root = end;
        else if (name === "head" && head === -1) head = end;
        else if (name === "meta" && charset === -1 && /\bcharset\s*=|http-equiv\s*=\s*["']?content-type/i.test(match[0])) charset = end;
    }
    let at = head >= 0 ? head : root >= 0 ? root : doctype >= 0 ? doctype : html[0] === 0xef && html[1] === 0xbb && html[2] === 0xbf ? 3 : 0;
    if (script >= 0 && script < at) at = script;
    else if (charset > at && charset - 1 < 1024 && (script === -1 || script > charset)) at = charset;
    const out = new Uint8Array(html.length + tag.length);
    out.set(html.subarray(0, at));
    out.set(tag, at);
    out.set(html.subarray(at), at + tag.length);
    return out;
}
