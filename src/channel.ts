// The browser half of the one secure channel. Server half: gateway/src/http/{devices,listeners}.ts + registry/{devices,tunnel}.ts.
import {
    APP_CHUNK,
    APP_HEADER_MAX,
    DEVICE_CREDIT,
    DEVICE_WINDOW,
    ClientSession,
    PairingInitiator,
    parseInviteUri,
    PROTOCOL_VERSION,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    type ClientEvent,
    type ChannelStreamFrame,
} from "@mimi-os/protocol";

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();
const EMPTY = new Uint8Array(0);

// WebSocket.send is typed for plain-ArrayBuffer views; the channel core's chunks are typed over ArrayBufferLike but never back onto a SharedArrayBuffer.
const pin = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;

// ── base64 (spread-free — a device secret is 32 bytes, cheap either way, but this mirrors the rest of the app) ──
function b64(u: Uint8Array): string {
    let s = "";
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i] as number);
    return btoa(s);
}
function unb64(s: string): Uint8Array {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
}

// ── device key storage: localStorage "mimi-os:device" ────────────────────────
interface DeviceKey {
    secret: Uint8Array;
    gatewayPub: Uint8Array;
    sas?: string | undefined;
    gateway: string;
    gateways: string[];
}
const STORAGE_KEY = "mimi-os:device";

function loadDeviceKey(): DeviceKey | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { secret?: unknown; gatewayPub?: unknown; sas?: unknown; gateway?: unknown; gateways?: unknown };
        const { secret, gatewayPub, sas, gateway, gateways } = parsed;
        if (typeof secret !== "string" || typeof gatewayPub !== "string" || typeof gateway !== "string" || !Array.isArray(gateways)) return null;
        return {
            secret: unb64(secret),
            gatewayPub: unb64(gatewayPub),
            sas: typeof sas === "string" ? sas : undefined,
            gateway,
            gateways: gateways.filter((g): g is string => typeof g === "string"),
        };
    } catch {
        return null;
    }
}
function storeDeviceKey(key: DeviceKey): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            secret: b64(key.secret),
            gatewayPub: b64(key.gatewayPub),
            sas: key.sas,
            gateway: key.gateway,
            gateways: key.gateways,
        }));
    } catch {
        // private window — pairing must be redone next load
    }
}
function clearDeviceKey(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // nothing persisted to begin with
    }
}

// ── published state ───────────────────────────────────────────────────────
type ChannelState = "pairing_required" | "connecting" | "pending_activation" | "ready" | "reconnecting" | "rejected" | "incompatible";

export interface ChannelSnapshot {
    state: ChannelState;
    /** Set only while `state` is "pending_activation". */
    sas: string | null;
    /** The gateway's protocol version, set only while `state` is "incompatible". */
    peer?: number | undefined;
}

const listeners = new Set<(s: ChannelSnapshot) => void>();
let snapshot: ChannelSnapshot = { state: "pairing_required", sas: null };

function setSnapshot(next: ChannelSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
}

export function getSnapshot(): ChannelSnapshot {
    return snapshot;
}

export function subscribe(listener: (s: ChannelSnapshot) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

// The gateway the device paired with; the page's own origin only as the dev-proxy fallback.
let gatewayBase = `${location.protocol}//${location.host}`;
export const gatewayAddress = (): string => gatewayBase;
/** An http(s) origin, or "" for anything else — the address rides the stored device key. */
export function normalizeGateway(value: string): string {
    const url = URL.parse(value.trim());
    return url !== null && (url.protocol === "http:" || url.protocol === "https:") ? url.origin : "";
}
// The paired gateway in every mini-app origin (mimiapp://<app>.<pin>.<tag>…): the first 5 bytes of its public key, as hex; "" unpaired.
let tag = "";
export const gatewayTag = (): string => tag;

const wsBase = (): string => `ws${gatewayBase.startsWith("https:") ? "s" : ""}:${gatewayBase.slice(gatewayBase.indexOf("//"))}`;
const deviceName = (): string => `Browser on ${navigator.platform || "this device"}`;

// ── streams: one per /api or mini-app request, and the app grants ──────
export type TunnelHeader =
    | { t: "api"; method: string; path: string; headers?: Record<string, string> | undefined }
    | { t: "app"; appId: string; credential: string; method: string; path: string; headers: Record<string, string>; upgrade?: true | undefined }
    | { t: "app_grant"; appId: string };

/** Names lower-case; a multi-valued header becomes several pairs (each Set-Cookie line stays whole). */
export interface StreamHead {
    status: number;
    headers: [string, string][];
}

export interface StreamSink {
    head(head: StreamHead): void;
    /** false: the consumer is behind — no credit goes out until ChannelStream.resume(). */
    data(chunk: Uint8Array): boolean;
    end(): void;
    /** RESET, a lost connection, an unreadable head, a window overrun, an abort or a throwing sink; at most once, never after end(). */
    fail(error: Error): void;
}

export interface ChannelStream {
    /** Sent in APP_CHUNK frames; false: the window is shut, wait for onDrain before the next write. A stream that is gone drops the chunk and answers true. */
    write(chunk: Uint8Array): boolean;
    /** One slot: fires once the window opens again, or at once when it is open or the stream is gone. */
    onDrain(resume: () => void): void;
    end(): void;
    /** RESET on the wire; the sink hears nothing more. */
    reset(): void;
    resume(): void;
}

interface Tunnel {
    sink: StreamSink;
    /** An app stream: DEVICE_WINDOW credit both ways. */
    credited: boolean;
    /** END is a half-close here, never the end of the exchange. */
    upgrade: boolean;
    head: boolean;
    closed: boolean;
    sentEnd: boolean;
    gotEnd: boolean;
    ready: boolean;
    resumed: boolean;
    sinceCredit: number;
    unacked: number;
    drain: (() => void) | null;
    release: () => void;
}
interface Connection {
    session: ClientSession;
    ws: WebSocket;
    tunnels: Map<number, Tunnel>;
    streamCounter: { next: number };
    /** Bytes handed to the socket so far. */
    written: number;
}

// a record the session cannot seal kills the socket: onclose then fails every open stream
function sendFrame(conn: Connection, frame: ChannelStreamFrame): void {
    try {
        for (const chunk of conn.session.send(frame)) {
            conn.ws.send(pin(chunk));
            conn.written += chunk.length;
        }
    } catch (error) {
        console.error("channel: closing the socket after a failed send", error);
        conn.ws.close();
    }
}

function closeTunnel(conn: Connection, id: number, t: Tunnel): void {
    if (t.closed) return;
    t.closed = true;
    conn.tunnels.delete(id);
    t.release();
    // a writer parked on onDrain wakes to find the stream gone, outside whatever closed it
    if (t.drain) queueMicrotask(t.drain);
    t.drain = null;
}

function failTunnel(conn: Connection, id: number, t: Tunnel, error: Error, reset: boolean): void {
    if (t.closed) return;
    closeTunnel(conn, id, t);
    if (reset) sendFrame(conn, { stream: id, flags: FLAG_RESET, payload: EMPTY });
    if (t.gotEnd) return;
    try {
        t.sink.fail(error);
    } catch (thrown) {
        console.error("channel: a stream's failure handler threw", thrown);
    }
}

/** A sink or a writer that throws loses its own stream, never the connection. */
function deliver<T>(conn: Connection, id: number, t: Tunnel, call: () => T): T | undefined {
    try {
        return call();
    } catch (error) {
        failTunnel(conn, id, t, error instanceof Error ? error : new Error(String(error)), true);
        return undefined;
    }
}

function grantCredit(conn: Connection, id: number, t: Tunnel): void {
    if (!t.credited || t.gotEnd) return;
    while (t.ready && t.sinceCredit >= DEVICE_CREDIT) {
        sendFrame(conn, { stream: id, flags: FLAG_DATA, payload: EMPTY });
        t.sinceCredit -= DEVICE_CREDIT;
    }
}

function replyEnded(conn: Connection, id: number, t: Tunnel): void {
    t.gotEnd = true;
    deliver(conn, id, t, () => t.sink.end());
    if (t.closed) return;
    if (t.sentEnd) closeTunnel(conn, id, t);
    else if (!t.upgrade) {
        // the reply is whole, so an upload still going is abandoned, as an HTTP/1.1 client does
        closeTunnel(conn, id, t);
        sendFrame(conn, { stream: id, flags: FLAG_RESET, payload: EMPTY });
    }
}

function routeStream(conn: Connection, frame: ChannelStreamFrame): void {
    const id = frame.stream;
    const t = conn.tunnels.get(id);
    if (!t) return; // reset or already closed on our side
    if (frame.flags === FLAG_RESET) {
        failTunnel(conn, id, t, new Error("The gateway reset this stream."), false);
        return;
    }
    // a zero-payload DATA frame is credit in every phase, before the head included
    if (frame.flags === FLAG_DATA && frame.payload.length === 0) {
        if (!t.credited) return;
        t.unacked = Math.max(0, t.unacked - DEVICE_CREDIT);
        const drain = t.unacked < DEVICE_WINDOW ? t.drain : null;
        t.drain = null;
        if (drain) deliver(conn, id, t, drain);
        return;
    }
    if (!t.head) {
        let head: { t?: unknown; status?: unknown; headers?: unknown } = {};
        try { head = JSON.parse(utf8d.decode(frame.payload)) as typeof head; } catch { /* invalid below */ }
        const { status, headers } = head;
        if (head.t !== "head" || typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
            failTunnel(conn, id, t, new Error("The gateway sent an invalid response head."), true);
            return;
        }
        const pairs: [string, string][] = [];
        if (headers !== null && typeof headers === "object") {
            for (const [name, value] of Object.entries(headers)) {
                for (const one of [value].flat()) if (typeof one === "string") pairs.push([name.toLowerCase(), one]);
            }
        }
        t.head = true;
        deliver(conn, id, t, () => t.sink.head({ status, headers: pairs }));
        if (frame.flags === FLAG_END && !t.closed) replyEnded(conn, id, t);
        return;
    }
    if (frame.payload.length > 0) {
        if (t.credited) {
            t.sinceCredit += frame.payload.length;
            if (t.sinceCredit > DEVICE_WINDOW + APP_CHUNK) {
                failTunnel(conn, id, t, new Error("The gateway overran this stream's window."), true);
                return;
            }
        }
        t.resumed = false;
        const ready = deliver(conn, id, t, () => t.sink.data(frame.payload));
        if (t.closed) return;
        // a consumer may resume from inside data(): that resume wins over the false it returns
        t.ready = ready === true || t.resumed;
        grantCredit(conn, id, t);
    }
    if (frame.flags === FLAG_END) replyEnded(conn, id, t);
}

// the gateway resets a session's 65th live stream, and /events holds one for as long as the pult is open
const STREAM_MAX = 60;
let streamsLive = 0;
const streamQueue: (() => void)[] = [];

function takeStreamSlot(signal: AbortSignal | undefined): Promise<void> {
    if (streamsLive < STREAM_MAX && streamQueue.length === 0) {
        streamsLive += 1;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const turn = (): void => {
            signal?.removeEventListener("abort", onAbort);
            streamsLive += 1;
            resolve();
        };
        const onAbort = (): void => {
            const at = streamQueue.indexOf(turn);
            if (at >= 0) streamQueue.splice(at, 1);
            reject(signal?.reason);
        };
        streamQueue.push(turn);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function freeStreamSlot(): void {
    streamsLive -= 1;
    streamQueue.shift()?.();
}

// ── connection lifecycle: pairing key → /channel, reconnect with backoff ─────
let generation = 0;
let currentWs: WebSocket | null = null;
let activeSession: Connection | null = null;
let firstAttempt = true;
let consecutiveRejects = 0;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 30_000;
// a gateway on another protocol version only changes when someone deploys, so it is rechecked slowly
const INCOMPATIBLE_FIRST_MS = 60_000;
const INCOMPATIBLE_MAX_MS = 30 * 60_000;
let incompatibleMs = INCOMPATIBLE_FIRST_MS;
// the retry waiting out its backoff, so redialNow() can run it early
let retry: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
// while ready, a stream-0 ping every 25 s; nothing heard within 10 s (more behind an upload) ends a socket the network dropped silently
const PING_EVERY_MS = 25_000;
const PONG_WITHIN_MS = 10_000;
const PING = utf8.encode(JSON.stringify({ t: "ping" }));
let pingNow: (() => void) | null = null;

function scheduleReconnect(key: DeviceKey, gen: number, wait: number): void {
    const dial = (): void => {
        clearTimeout(retryTimer);
        if (retry === dial) retry = null;
        if (gen === generation) connect(key, gen);
    };
    clearTimeout(retryTimer);
    retryTimer = setTimeout(dial, wait);
    retry = dial;
}

/** Foreground or network back: a pending retry dials now and a ready socket is pinged now. */
export function redialNow(): void {
    if (snapshot.state === "ready") pingNow?.();
    if (!retry || snapshot.state === "incompatible") return;
    backoffMs = 1000;
    retry();
}

/** The owner's Retry on the incompatible notice: one dial now, the slow recheck schedule unchanged. */
export function recheckProtocol(): void {
    if (snapshot.state === "incompatible") retry?.();
}

function connect(key: DeviceKey, gen: number): void {
    if (gen !== generation) return;
    // a recheck keeps the notice up until the gateway answers otherwise
    if (firstAttempt || snapshot.state !== "incompatible") setSnapshot({ state: firstAttempt ? "connecting" : "reconnecting", sas: null });
    const session = new ClientSession({ s: key.secret, gatewayPub: key.gatewayPub, protocol: PROTOCOL_VERSION });
    const ws = new WebSocket(`${wsBase()}/channel`);
    ws.binaryType = "arraybuffer";
    currentWs = ws;
    const conn: Connection = { session, ws, tunnels: new Map(), streamCounter: { next: 1 }, written: 0 };
    let stream0Chunks: Uint8Array[] = [];
    let opened = false;
    let reachedReady = false;
    let incompatible: { peer?: number | undefined } | null = null;
    let heard = false;
    let pinger: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // conn.written at each unanswered ping, and at the latest answered one
    const asked: number[] = [];
    let confirmed = 0;

    const ping = (): void => {
        const sent = Date.now();
        // the pong queues behind every byte not yet confirmed: 1 s more for each 16 KB of them
        const wait = PONG_WITHIN_MS + Math.floor((conn.written - confirmed) / 16_384) * 1000;
        asked.push(conn.written);
        heard = false;
        sendFrame(conn, { stream: 0, flags: FLAG_END, payload: PING });
        clearTimeout(deadline);
        deadline = setTimeout(() => {
            if (heard) return;
            // this late, the page was frozen or throttled, which says nothing about the socket: ask again
            if (Date.now() - sent >= 2 * wait) { ping(); return; }
            // a dead socket can take a minute to report its close, so the reconnect starts now
            ws.onclose = null;
            ws.close();
            closed();
        }, wait);
    };

    const online = (): void => {
        activeSession = conn;
        clearInterval(pinger);
        pinger = setInterval(ping, PING_EVERY_MS);
        pingNow = ping;
        setSnapshot({ state: "ready", sas: null });
    };

    const routeFrame = (frame: ChannelStreamFrame): void => {
        if (frame.stream === 0) {
            if (frame.flags === FLAG_RESET) return; // stream 0 never resets
            stream0Chunks.push(frame.payload);
            if (frame.flags !== FLAG_END) return;
            const total = stream0Chunks.reduce((n, p) => n + p.length, 0);
            const buf = new Uint8Array(total);
            let off = 0;
            for (const part of stream0Chunks) { buf.set(part, off); off += part.length; }
            stream0Chunks = [];
            let msg: { t?: unknown } = {};
            try { msg = JSON.parse(utf8d.decode(buf)) as { t?: unknown }; } catch { return; }
            if (msg.t === "activated") online();
            if (msg.t === "pong") confirmed = asked.shift() ?? confirmed;
            return;
        }
        routeStream(conn, frame);
    };

    const stale = (): boolean => gen !== generation || currentWs !== ws;

    ws.onopen = () => {
        if (stale()) { ws.close(); return; }
        opened = true;
        for (const chunk of session.start()) ws.send(pin(chunk));
    };
    ws.onmessage = (event) => {
        if (stale()) { ws.close(); return; }
        heard = true;
        try {
            const { out, events } = session.feed(new Uint8Array(event.data as ArrayBuffer));
            for (const chunk of out) ws.send(pin(chunk));
            for (const ev of events) handleEvent(ev);
        } catch (error) {
            // the channel core destroys the session on an undecodable record; onclose is what fails the open tunnels and reconnects
            console.error("channel: closing the socket after a failed read", error);
            ws.close();
        }
    };
    ws.onerror = () => { /* onclose follows and drives the actual reconnect logic */ };
    const closed = (): void => {
        clearInterval(pinger);
        clearTimeout(deadline);
        if (pingNow === ping) pingNow = null;
        if (activeSession === conn) activeSession = null;
        if (currentWs === ws) currentWs = null;
        for (const [id, t] of [...conn.tunnels]) failTunnel(conn, id, t, new Error("The gateway connection closed."), false);
        if (gen !== generation) return;
        firstAttempt = false;
        if (incompatible) {
            setSnapshot({ state: "incompatible", sas: null, peer: incompatible.peer });
            scheduleReconnect(key, gen, incompatibleMs);
            incompatibleMs = Math.min(incompatibleMs * 2, INCOMPATIBLE_MAX_MS);
            return;
        }
        if (reachedReady) consecutiveRejects = 0;
        else if (opened) {
            // A real gateway accepted the WS but closed before completing the handshake — an unknown or revoked key (uniform close).
            consecutiveRejects += 1;
            if (consecutiveRejects >= 3) { setSnapshot({ state: "rejected", sas: null }); return; }
        }
        setSnapshot({ state: "reconnecting", sas: null });
        scheduleReconnect(key, gen, backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };
    ws.onclose = closed;

    function handleEvent(ev: ClientEvent): void {
        if (ev.type === "ready") {
            reachedReady = true;
            backoffMs = 1000;
            incompatibleMs = INCOMPATIBLE_FIRST_MS;
            if (ev.info.activation === "pending") setSnapshot({ state: "pending_activation", sas: key.sas ?? null });
            else online();
        } else if (ev.type === "frame") {
            routeFrame(ev.frame);
        } else if (ev.type === "error") {
            // the session pushes its own "close" right after this one
            if (ev.code === "incompatible_protocol") incompatible = { peer: ev.peer };
        } else if (ev.type === "close") {
            ws.close();
        }
    }
}

function startChannel(key?: DeviceKey): void {
    const useKey = key ?? loadDeviceKey();
    if (useKey) gatewayBase = useKey.gateway;
    tag = useKey ? Array.from(useKey.gatewayPub.subarray(0, 5), (b) => b.toString(16).padStart(2, "0")).join("") : "";
    generation += 1;
    currentWs?.close();
    currentWs = null;
    activeSession = null;
    if (!useKey) { setSnapshot({ state: "pairing_required", sas: null }); return; }
    firstAttempt = true;
    consecutiveRejects = 0;
    backoffMs = 1000;
    incompatibleMs = INCOMPATIBLE_FIRST_MS;
    connect(useKey, generation);
}

// ── pairing: hash-triggered or a pasted invite link, same handshake either way ──
function pair(uri: string, name: string): Promise<{ secret: Uint8Array; gatewayPub: Uint8Array; sas: string }> {
    const parsed = parseInviteUri(uri); // throws on a malformed link — the caller surfaces the message
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const initiator = new PairingInitiator({ s: secret, uri, deviceName: name });
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase()}/channel/pair?invite=${encodeURIComponent(parsed.id)}`);
        ws.binaryType = "arraybuffer";
        let reached = false;
        // a closed port or a dropped route can hold a connect for over a minute: say so instead of spinning
        const unreachable = setTimeout(() => {
            reject(new Error(`Could not reach ${gatewayBase} within 15 s. On the gateway, mimi status lists the addresses it listens on; check this one is among them and its port is open.`));
            ws.close();
        }, 15_000);
        ws.onopen = () => {
            reached = true;
            clearTimeout(unreachable);
            for (const chunk of initiator.start()) ws.send(pin(chunk));
        };
        ws.onmessage = (event) => {
            try {
                const { out, events } = initiator.feed(new Uint8Array(event.data as ArrayBuffer));
                for (const chunk of out) ws.send(pin(chunk));
                for (const ev of events) {
                    if (ev.type === "enrolled") { resolve({ secret, gatewayPub: parsed.gwPub, sas: ev.sas }); ws.close(); }
                    else reject(new Error("This pairing link was refused. It may already be used or expired. Ask for a new one."));
                }
            } catch (error) {
                // a handshake the initiator cannot read is a dead attempt: settle it, or the pairing UI waits forever
                reject(error instanceof Error ? error : new Error("The pairing handshake failed."));
                ws.close();
            }
        };
        // the gateway drops a used or unknown invite without a closing handshake, which a browser reports as an error after open
        ws.onerror = () => {
            if (!reached) reject(new Error("Could not reach the gateway to pair this browser."));
        };
        ws.onclose = () => {
            clearTimeout(unreachable);
            reject(new Error("The pairing connection closed before it finished. The link may be used or expired."));
        };
    });
}

let pairingInFlight: Promise<void> | null = null;

/** A pasted pairing link: `mimi pair`'s `mimi://pair/v2?…&at=<address>`, or `<origin>#pair=<uri>`. `address` is
 *  the gateway the link names — its `at`, else the origin it was opened on — or "" when it names none. Throws on a malformed link. */
export function readPairLink(input: string): { uri: string; address: string } {
    const link = input.trim();
    const at = link.indexOf("#pair=");
    try {
        const uri = at === -1 ? link : decodeURIComponent(link.slice(at + "#pair=".length));
        return { uri, address: parseInviteUri(uri).address ?? (at > 0 ? normalizeGateway(link.slice(0, at)) : "") };
    } catch {
        throw new Error("That is not a pairing link. Paste the first line `mimi pair` printed, whole.");
    }
}

/** Redeems an invite (from `#pair=` or pasted in by hand) and, on success, dials `/channel` with the new key.
 *  `gateway`, typed by hand, wins over the address the link names; with neither the page's own origin is dialled. */
export function pairWithInvite(input: string, gateway?: string): Promise<void> {
    if (pairingInFlight) return pairingInFlight;
    const attempt = (async (): Promise<void> => {
        const link = readPairLink(input);
        const target = (gateway !== undefined && normalizeGateway(gateway)) || link.address;
        setSnapshot({ state: "connecting", sas: null });
        try {
            if (target) gatewayBase = target;
            const key: DeviceKey = { ...await pair(link.uri, deviceName()), gateway: gatewayBase, gateways: [gatewayBase] };
            storeDeviceKey(key);
            startChannel(key);
        } catch (error) {
            // a refused invite must not take an already-paired browser offline; with no stored key this lands on "pairing_required"
            startChannel();
            throw error;
        }
    })();
    pairingInFlight = attempt.finally(() => { pairingInFlight = null; });
    return pairingInFlight;
}

export function forgetDevice(): void {
    clearDeviceKey();
    tag = "";
    generation += 1;
    clearTimeout(retryTimer);
    retry = null;
    currentWs?.close();
    currentWs = null;
    activeSession = null;
    setSnapshot({ state: "pairing_required", sas: null });
}

// ── connection settings: the URLs that all reach the paired gateway ──
// Every saved URL shares one device key (one pairing). Switching URL reconnects with that key,
// it never re-pairs; only "Clean and forget" drops the key.
export function savedGateways(): string[] {
    return loadDeviceKey()?.gateways ?? [];
}

export function useGateway(url: string): void {
    const norm = normalizeGateway(url);
    if (!norm) return;
    const key = loadDeviceKey();
    if (!key) { gatewayBase = norm; return; }
    const gateways = Array.from(new Set([...key.gateways, norm]));
    const next: DeviceKey = { ...key, gateway: norm, gateways };
    storeDeviceKey(next);
    gatewayBase = norm;
    startChannel(next);
}

export function dropGateway(url: string): void {
    const key = loadDeviceKey();
    if (!key) return;
    const gateways = key.gateways.filter((g) => g !== url);
    const gateway = key.gateway === url ? gateways[0] : key.gateway;
    if (gateway === undefined) return;
    storeDeviceKey({ ...key, gateway, gateways });
    if (key.gateway === url) useGateway(gateway);
}

// The hash carries a single-use invite: strip it before a bookmark or a referrer can leak it, and leave redeeming it to views/pair.tsx (it owns the busy/error UI).
let pendingInvite: string | null = null;
if (location.hash.startsWith("#pair=")) {
    const encoded = location.hash.slice("#pair=".length);
    history.replaceState(history.state, "", location.pathname + location.search);
    try { pendingInvite = decodeURIComponent(encoded) || null; } catch { pendingInvite = null; }
}
// a hash with nothing redeemable in it must still dial: a hostile "#pair=" navigation cannot take a paired browser offline
if (!pendingInvite) startChannel();

/** The invite this page was opened with (`#pair=<uri>`), handed over once — views/pair.tsx redeems it on mount. */
export function takePendingInvite(): string | null {
    const invite = pendingInvite;
    pendingInvite = null;
    return invite;
}

// ── waiting for a ready connection, then the tunnel ───────────────────────────
function waitReady(signal?: AbortSignal): Promise<Connection> {
    if (activeSession) return Promise.resolve(activeSession);
    return new Promise((resolve, reject) => {
        let unsub: () => void = () => {};
        const onAbort = (): void => { unsub(); reject(signal!.reason); };
        unsub = subscribe(() => {
            if (!activeSession) return;
            unsub();
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve(activeSession);
        });
        if (signal) {
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}

/** A stream once the channel is ready and one of its slots is free, FIFO; an abort before the open rejects, after it RESETs and fails the sink. */
export async function openStream(header: TunnelHeader, sink: StreamSink, signal?: AbortSignal): Promise<ChannelStream> {
    signal?.throwIfAborted();
    // one frame is one record: a head past the cap would fail to seal and take the whole socket down with it
    const payload = utf8.encode(JSON.stringify(header));
    if (payload.length > APP_HEADER_MAX) throw new Error("This request's headers are too large for the channel.");
    await takeStreamSlot(signal);
    let conn: Connection;
    try {
        conn = await waitReady(signal);
        signal?.throwIfAborted();
    } catch (error) {
        freeStreamSlot();
        throw error;
    }
    const id = conn.streamCounter.next++;
    const credited = header.t === "app";
    const t: Tunnel = {
        sink, credited, upgrade: credited && header.upgrade === true,
        head: false, closed: false, sentEnd: false, gotEnd: false, ready: true, resumed: false,
        sinceCredit: 0, unacked: 0, drain: null, release: () => undefined,
    };
    const onAbort = (): void => failTunnel(conn, id, t, signal?.reason as Error, true);
    t.release = () => {
        signal?.removeEventListener("abort", onAbort);
        freeStreamSlot();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    conn.tunnels.set(id, t);
    sendFrame(conn, { stream: id, flags: FLAG_DATA, payload });
    return {
        write(chunk) {
            if (t.closed || t.sentEnd) return true;
            for (let at = 0; at < chunk.length; at += APP_CHUNK) {
                const part = chunk.subarray(at, at + APP_CHUNK);
                sendFrame(conn, { stream: id, flags: FLAG_DATA, payload: part });
                if (credited) t.unacked += part.length;
            }
            return !credited || t.unacked < DEVICE_WINDOW;
        },
        onDrain(resume) {
            if (t.closed || !credited || t.unacked < DEVICE_WINDOW) queueMicrotask(resume);
            else t.drain = resume;
        },
        end() {
            if (t.closed || t.sentEnd) return;
            t.sentEnd = true;
            sendFrame(conn, { stream: id, flags: FLAG_END, payload: EMPTY });
            if (t.gotEnd) closeTunnel(conn, id, t);
        },
        reset() {
            if (t.closed) return;
            closeTunnel(conn, id, t);
            sendFrame(conn, { stream: id, flags: FLAG_RESET, payload: EMPTY });
        },
        resume() {
            if (t.closed) return;
            t.resumed = true;
            t.ready = true;
            grantCredit(conn, id, t);
        },
    };
}

// statuses whose Response must have a null body: constructing one with a stream throws
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** One exchange as a Response, resolved at the head: the upload runs beside it, so an app that echoes as it reads cannot deadlock. */
export function streamFetch(header: TunnelHeader, body?: Uint8Array, signal?: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
        let stream: ChannelStream | null = null;
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        let answered = false;
        let over = false;
        const sink: StreamSink = {
            head(head) {
                const readable = NULL_BODY.has(head.status) ? null : new ReadableStream<Uint8Array>({
                    start: (c) => { controller = c; },
                    pull: () => stream?.resume(),
                    cancel: () => {
                        over = true;
                        stream?.reset();
                    },
                }, new ByteLengthQueuingStrategy({ highWaterMark: DEVICE_WINDOW }));
                const headers = new Headers();
                for (const [name, value] of head.headers) {
                    try { headers.append(name, value); } catch { /* a header no Response can carry is left out, not the reply */ }
                }
                const res = new Response(readable, { status: head.status, headers });
                answered = true;
                resolve(res);
            },
            data(chunk) {
                if (!controller) return true;
                controller.enqueue(chunk);
                return (controller.desiredSize ?? 0) > 0;
            },
            end() {
                over = true;
                controller?.close();
            },
            fail(error) {
                over = true;
                if (answered) controller?.error(error);
                else reject(error);
            },
        };
        openStream(header, sink, signal).then(async (open) => {
            stream = open;
            // END follows the last chunk at once; only a chunk still to go waits for the window
            for (let at = 0, room = true; body && at < body.length && !over; at += APP_CHUNK) {
                if (!room) await new Promise<void>((go) => open.onDrain(go));
                room = open.write(body.subarray(at, at + APP_CHUNK));
            }
            open.end();
        }, reject);
    });
}

export interface ApiCall {
    res: Response;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<ApiCall> {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const body = typeof init.body === "string" ? utf8.encode(init.body) : undefined;
    const res = await streamFetch({ t: "api", method: (init.method ?? "GET").toUpperCase(), path: `/api${path}`, headers }, body, init.signal ?? undefined);
    return { res };
}

export async function readJson<T>(c: ApiCall): Promise<T> {
    return JSON.parse(await c.res.text()) as T;
}

export class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// The gateway answers refusals as `{error}`; any other body (a proxy's error page) explains nothing, so it yields "".
export async function refusal(c: ApiCall): Promise<string> {
    try {
        const { error } = JSON.parse(await c.res.text()) as { error?: unknown };
        return typeof error === "string" ? error.trim() : "";
    } catch {
        return "";
    }
}

export async function checkedFetch(path: string, init: RequestInit = {}): Promise<ApiCall> {
    const call = await apiFetch(path, init);
    if (!call.res.ok) throw new ApiError(call.res.status, await refusal(call) || `Request failed (${call.res.status}).`);
    return call;
}
