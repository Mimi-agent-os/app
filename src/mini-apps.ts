// The pult's half of mimiapp:// (tauri/src-tauri/src/apps.rs): every request a mini-app frame makes rides this pult's own channel.
import { APP_CHUNK } from "@mimi-os/protocol";

import { listPins } from "./api.ts";
import { ApiError, gatewayTag, openStream, streamFetch, subscribe, type ChannelStream, type StreamHead, type StreamSink, type TunnelHeader } from "./channel.ts";
import { cookieHeader, pinJar, storeCookies } from "./mini-app-cookies.ts";
import { Hash } from "./mini-app-hash.ts";
import { redirectStep } from "./mini-app-redirect.ts";
import { attachRelay, bridgeScript, BRIDGE_PATH, cookiesChanged, injectBridge, takeStashed } from "./mini-app-relay.ts";
import { tauriInvoke } from "./tauri.ts";

/** One request apps.rs parked, as it evals it into the pult. */
export interface SchemeRequest {
    id: string;
    app: string;
    gateway: string;
    method: string;
    path: string;
    headers: [string, string][];
    body: number;
}

interface Reply {
    status: number;
    headers: [string, string][];
    body: Uint8Array;
}

type Invoke = NonNullable<ReturnType<typeof tauriInvoke>>;

// progress either way re-arms it; past the agent's 120 s wait for a head, so the agent's own answer wins
const IDLE_MS = 130_000;
const REPLY_MAX = 16 * 1024 * 1024;
// the gateway allows 64 live streams per session, /events and every /api call included
const LIVE_MAX = 16;
const APP_LIVE_MAX = 8;
const HOPS_MAX = 20;
// a launch waits this long for a channel and a grant, as every other /api call does
const GRANT_MS = 15_000;
// what the frame may send, so the jar's cookies still fit the tunnel's 48 KiB head
const HEADERS_MAX = 12 * 1024;
const NO_BODY = new Set([101, 103, 204, 205, 304]);
// ours replace the policy headers, the jar takes set-cookie, and WebKit frames the body itself
const DROPPED = new Set([
    "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "set-cookie", "set-cookie2", "clear-site-data",
    "x-frame-options", "cache-control", "pragma", "content-security-policy", "referrer-policy", "cross-origin-resource-policy", "x-content-type-options",
]);
const utf8 = new TextEncoder();

// ── grants and origins ─────────────────────────────────────────────────────
// "<gateway tag>:<appId>" → the credential, minted only at launch and held only in this page's memory
const grants = new Map<string, Promise<string>>();
// "<gateway tag>:<appId>" → the frame host "<appId>.<pin>.<tag>", so an agent that takes a used name gets an origin and storage of its own
const hosts = new Map<string, string>();
// "<appId> <path>" → until when the navigation the pult itself started there (a launch, a reload) may carry the app's Lax cookies, once
const launches = new Map<string, number>();
let frameBase: Promise<string> | null = null;
let template: string | null = null;
let fellBack = false;

subscribe(() => {
    for (const key of grants.keys()) if (!key.startsWith(`${gatewayTag()}:`)) grants.delete(key);
});

export function attachAppDoor(): void {
    const invoke = tauriInvoke();
    if (!invoke) return;
    Object.assign(window, { __mimiApps: (req: SchemeRequest) => void serve(req) });
    frameBase = (invoke("apps_attach") as Promise<string>).then((value) => (template = value));
    frameBase.catch((error: unknown) => console.error("mimi-app: the desktop shell did not attach the app door", error));
    attachRelay({ grantOf, originOf });
}

/** Whether this pult opens interfaces at all: main.tsx attaches the door in the macOS desktop app only. */
export const doorAttached = (): boolean => frameBase !== null;

/** Launch, "Retry launch" and "Reload interface" only: a frame can never make the pult mint a credential. */
export function grantFor(agent: string, appId: string, fresh = false): Promise<string> {
    const tag = gatewayTag();
    const key = `${tag}:${appId}`;
    const held = grants.get(key);
    if (held && !fresh) return held;
    const minted = streamFetch({ t: "app_grant", appId }, undefined, AbortSignal.timeout(GRANT_MS)).then(async (res) => {
        if (!res.ok) throw new ApiError(res.status, res.status === 403 ? "This interface is not open to this device." : `Could not open this interface (${res.status}).`);
        const { credential } = (await res.json()) as { credential?: unknown };
        if (typeof credential !== "string" || !credential) throw new ApiError(502, "The gateway sent no credential for this interface.");
        return credential;
    });
    const grant = Promise.all([minted, listPins()]).then(([credential, pins]) => {
        const card = pins.find((pin) => pin.name === agent);
        if (!card) throw new ApiError(403, "This interface's agent is not admitted.");
        // a new key or a new admission under the same name is another agent
        const hash = new Hash("sha256");
        hash.update(utf8.encode(`${card.fingerprint} ${card.pinnedAt}`));
        const pin = Array.from(hash.digest().subarray(0, 5), (b) => b.toString(16).padStart(2, "0")).join("");
        pinJar(tag, appId, pin);
        hosts.set(key, `${appId}.${pin}.${tag}`);
        return credential;
    });
    grants.set(key, grant);
    grant.catch(() => {
        if (grants.get(key) === grant) grants.delete(key);
    });
    return grant;
}

function grantOf(appId: string): Promise<string> | null {
    return grants.get(`${gatewayTag()}:${appId}`) ?? null;
}

// a mimiapp: URL's .origin is "null" under the URL standard, so an origin is always built from protocol and host
function originAt(host: string): string | null {
    const url = template === null ? null : URL.parse(template.replace("{host}", host));
    return url ? `${url.protocol}//${url.host}` : null;
}

function originOf(appId: string): string | null {
    const host = hosts.get(`${gatewayTag()}:${appId}`);
    return host ? originAt(host) : null;
}

/** The URL a launch or a reload points its frame at, once grantFor() has resolved; the navigation it starts may carry the app's Lax cookies. */
export async function frameUrl(appId: string, route = "/"): Promise<string> {
    if (!frameBase) throw new Error("Interfaces open only in the mimi desktop app on macOS.");
    const host = hosts.get(`${gatewayTag()}:${appId}`);
    if (!host) throw new Error("Open this interface from its agent's Interfaces tab.");
    const base = new URL((await frameBase).replace("{host}", host));
    const url = new URL(route, base);
    if (url.protocol !== base.protocol || url.host !== base.host) throw new Error("This interface link leaves its app.");
    launches.set(`${appId} ${url.pathname}${url.search}`, Date.now() + 10_000);
    return url.href;
}

// ── fairness: 16 live requests, 8 per app, FIFO per app and round-robin across apps ──
let live = 0;
const liveOf = new Map<string, number>();
// the map's order is the round: an app that just went moves to its back
const waiting = new Map<string, (() => void)[]>();

function admit(appId: string): Promise<void> {
    if (live < LIVE_MAX && (liveOf.get(appId) ?? 0) < APP_LIVE_MAX && !waiting.has(appId)) {
        live += 1;
        liveOf.set(appId, (liveOf.get(appId) ?? 0) + 1);
        return Promise.resolve();
    }
    return new Promise((go) => {
        const queue = waiting.get(appId) ?? [];
        queue.push(go);
        waiting.set(appId, queue);
    });
}

function release(appId: string): void {
    live -= 1;
    // any host a page names lands here before the grant check, so an idle app leaves no entry behind
    const count = (liveOf.get(appId) ?? 1) - 1;
    if (count > 0) liveOf.set(appId, count);
    else liveOf.delete(appId);
    const next = [...waiting.keys()].find((app) => (liveOf.get(app) ?? 0) < APP_LIVE_MAX);
    if (live >= LIVE_MAX || next === undefined) return;
    const queue = waiting.get(next) ?? [];
    waiting.delete(next);
    const go = queue.shift();
    if (queue.length > 0) waiting.set(next, queue);
    live += 1;
    liveOf.set(next, (liveOf.get(next) ?? 0) + 1);
    go?.();
}

// ── serve: one parked request, answered whole ───────────────────────────────
export async function serve(req: SchemeRequest, idleMs = IDLE_MS): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) return;
    await admit(req.app);
    let reply: Reply;
    try {
        reply = await answer(invoke, req, idleMs);
    } catch (error) {
        const known = error instanceof ApiError;
        reply = {
            status: known ? error.status : 502,
            headers: [["content-type", "text/plain; charset=utf-8"], ["content-security-policy", "default-src 'none'"]],
            body: utf8.encode(known ? error.message : "The interface could not be reached."),
        };
    } finally {
        release(req.app);
    }
    // wry keeps one value per name on macOS, so a repeated header travels joined
    const joined = new Map<string, string>();
    for (const [name, value] of reply.headers) joined.set(name, joined.has(name) ? `${joined.get(name)}, ${value}` : value);
    const headers = [...joined].filter(([name]) => !DROPPED.has(name) || (name === "content-length" && req.method === "HEAD"));
    const origin = originAt(`${req.app}.${req.gateway}`) ?? "'self'";
    // apps.rs drops a value that is not visible ASCII whole, which would take the pult's policies too: such an app directive goes alone, as a browser ignores it
    const own = (joined.get("content-security-policy") ?? "").split(",")
        .map((policy) => policy.split(";").filter((directive) => /^[\t\x20-\x7e]*$/.test(directive)).join(";").trim());
    // three policies, each enforced on its own: the app's, who may frame it, and no other app, plain http (loopback servers included) or foreign form target
    const policies = [
        ...own,
        `frame-ancestors ${location.origin} 'self' ${origin}`,
        `default-src 'self' ${origin} https: wss: data: blob: mediastream: 'unsafe-inline' 'unsafe-eval'; form-action 'self' ${origin}`,
    ];
    headers.push(
        ["content-security-policy", policies.filter(Boolean).join(", ")],
        ["referrer-policy", "same-origin"],
        ["cross-origin-resource-policy", "same-origin"],
        ["x-content-type-options", "nosniff"],
        ["cache-control", "no-store"],
    );
    const head = utf8.encode(JSON.stringify({ id: req.id, status: reply.status, headers }));
    const out = new Uint8Array(4 + head.length + reply.body.length);
    new DataView(out.buffer).setUint32(0, head.length);
    out.set(head, 4);
    out.set(reply.body, 4 + head.length);
    await invoke("app_respond", out).catch((error: unknown) => console.error("mimi-app: the desktop shell refused a reply", error));
}

async function answer(invoke: Invoke, req: SchemeRequest, idleMs: number): Promise<Reply> {
    const tag = gatewayTag();
    const grant = grantOf(req.app);
    const origin = originOf(req.app);
    if (!grant || !origin) throw new ApiError(403, "Open this interface from its agent's Interfaces tab.");
    if (`${req.app}.${req.gateway}` !== hosts.get(`${tag}:${req.app}`)) throw new ApiError(421, "This interface belongs to another gateway or to an agent that held this name before.");
    const pathname = req.path.split("?", 1)[0] ?? "/";
    if (pathname === BRIDGE_PATH) return { status: 200, headers: [["content-type", "text/javascript; charset=utf-8"]], body: bridgeScript() };
    if (pathname.startsWith("/__mimi__/")) throw new ApiError(404, "Not Found");

    const sent = new Map<string, string>();
    for (const [name, value] of req.headers) {
        const key = name.toLowerCase();
        sent.set(key, sent.has(key) ? `${sent.get(key)}, ${value}` : value);
    }
    sent.delete("cookie");
    if ([...sent].reduce((n, [name, value]) => n + name.length + value.length, 0) > HEADERS_MAX) throw new ApiError(431, "Request Header Fields Too Large");
    const dest = sent.get("sec-fetch-dest");
    const navigation = dest === "document" || dest === "iframe"
        || (dest === undefined && (sent.get("upgrade-insecure-requests") === "1" || (sent.get("accept") ?? "").startsWith("text/html")));
    const site = sent.get("sec-fetch-site");
    const referer = URL.parse(sent.get("referer") ?? "");
    const fromApp = (referer !== null && `${referer.protocol}//${referer.host}` === origin) || sent.get("origin") === origin;
    // WebKit may name no site on a custom scheme, and then only a same-app Referer or Origin makes a request this app's own
    const own = site === "same-origin" || site === "none" || (site === undefined && fromApp);
    const launchKey = `${req.app} ${req.path}`;
    const launched = !own && navigation && (launches.get(launchKey) ?? 0) > Date.now();
    if (launched) launches.delete(launchKey);
    const sameSite = own ? "same" : launched ? "launch" : "cross";
    // a multipart form the bridge sent by fetch left its final page here for the navigation that shows it
    const stashed = navigation && req.method === "GET" ? takeStashed(req.app, req.path) : null;
    if (stashed) return withBridge(stashed, req.app, pathname);
    // one range past the reply cap is asked for in a piece the cap carries
    const range = /^bytes=(\d*)-(\d*)$/.exec(sent.get("range") ?? "");
    if (range?.[1]) {
        const last = Number(range[1]) + REPLY_MAX - 1;
        if (!range[2] || Number(range[2]) > last) sent.set("range", `bytes=${range[1]}-${last}`);
    } else if (range?.[2] && Number(range[2]) > REPLY_MAX) sent.set("range", `bytes=-${REPLY_MAX}`);

    let upload: Uint8Array | undefined;
    if (req.body > 0) {
        const raw = (await invoke("app_body", { id: req.id })) as ArrayBuffer | number[];
        if (!(raw instanceof ArrayBuffer) && !fellBack) {
            fellBack = true;
            console.warn("mimi-app: desktop IPC fell back to postMessage");
        }
        upload = new Uint8Array(raw);
    }
    // WebKit drops a Blob, File or FormData body on a custom scheme: a form or worker upload fails loudly instead of arriving empty
    if (!upload && ["POST", "PUT", "PATCH"].includes(req.method) && /^multipart\//i.test(sent.get("content-type") ?? "")) {
        throw new ApiError(400, "WebKit dropped this request body; send it with fetch() from the page.");
    }

    const credential = await grant;
    let method = req.method.toUpperCase();
    let path = req.path;
    let reply: Reply;
    for (let hops = 0; ; hops += 1) {
        const scope = { gateway: tag, appId: req.app, path: path.split("?", 1)[0] ?? "/" };
        const headers = Object.fromEntries(sent);
        const cookie = cookieHeader(scope, sameSite, method);
        if (cookie) headers["cookie"] = cookie;
        headers["accept-encoding"] = "identity";
        if (method === "GET" || method === "HEAD") delete headers["content-length"];
        else headers["content-length"] = String(upload?.length ?? 0);
        reply = await exchange({ t: "app", appId: req.app, credential, method, path, headers }, upload, idleMs);
        const lines = reply.headers.filter(([name]) => name === "set-cookie").map(([, value]) => value);
        // the frame's cookie mirror hears of it before the reply that set it lands
        if (lines.length > 0 && storeCookies(scope, lines, "http")) cookiesChanged(req.app);
        const step = redirectStep(reply.status, method);
        const location = reply.headers.find(([name]) => name === "location")?.[1];
        if (!step || location === undefined) break;
        const target = URL.parse(location, `${origin}${path}`);
        if (!target || `${target.protocol}//${target.host}` !== origin) throw new ApiError(502, "The interface redirected outside itself.");
        if (hops === HOPS_MAX) throw new ApiError(502, "The interface redirected too many times.");
        // WebKit does not follow a scheme handler's redirect: a document moves itself, so its URL is the new one
        if (navigation && step.method === "GET") {
            const href = target.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            return {
                status: 200,
                headers: [["content-type", "text/html; charset=utf-8"], ["content-security-policy", "default-src 'none'"]],
                body: utf8.encode(`<!doctype html><meta http-equiv="refresh" content="0;url=${href}">`),
            };
        }
        method = step.method;
        if (!step.body) {
            upload = undefined;
            for (const name of ["content-type", "content-encoding", "content-language", "content-location"]) sent.delete(name);
        }
        path = `${target.pathname}${target.search}`;
    }

    const encoding = reply.headers.find(([name]) => name === "content-encoding")?.[1].trim().toLowerCase();
    // a HEAD, a 204 or a 304 names its encoding over no body at all, and there is nothing to decode
    if (encoding && encoding !== "identity" && reply.body.length > 0) {
        if (!["gzip", "x-gzip", "deflate"].includes(encoding)) throw new ApiError(502, "The interface sent a compressed reply the desktop app cannot read.");
        const reader = new Blob([reply.body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(encoding === "deflate" ? "deflate" : "gzip")).getReader();
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
            for (let r = await reader.read(); !r.done; r = await reader.read()) {
                size += r.value.length;
                if (size > REPLY_MAX) throw new ApiError(502, "The interface answered more than the desktop app carries.");
                parts.push(r.value);
            }
        } catch (error) {
            void reader.cancel().catch(() => undefined);
            throw error instanceof ApiError ? error : new ApiError(502, "The interface sent a broken compressed reply.");
        }
        reply.body = new Uint8Array(await new Blob(parts).arrayBuffer());
    }
    return navigation && method !== "HEAD" ? withBridge(reply, req.app, pathname) : reply;
}

/** A document's HTML gets bridge.js as its first script; a range, an empty status or any other type goes as it is. */
function withBridge(reply: Reply, appId: string, path: string): Reply {
    const type = reply.headers.find(([name]) => name === "content-type")?.[1] ?? "";
    if (!/^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i.test(type) || reply.status < 200 || reply.status === 206 || NO_BODY.has(reply.status)) return reply;
    const csp = reply.headers.filter(([name]) => name === "content-security-policy").map(([, value]) => value).join(", ");
    return { ...reply, body: injectBridge(reply.body, { appId, csp, path }) };
}

/** One hop over the channel, buffered to REPLY_MAX; a chunk either way re-arms the idle deadline. */
function exchange(header: TunnelHeader, upload: Uint8Array | undefined, idleMs: number): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let stream: ChannelStream | null = null;
        let head: StreamHead = { status: 502, headers: [] };
        const parts: Uint8Array[] = [];
        let size = 0;
        const progress = (): void => {
            if (settled) return;
            clearTimeout(timer);
            timer = setTimeout(() => abort.abort(new ApiError(504, "The interface stopped answering.")), idleMs);
        };
        const done = (error: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error !== null) {
                reject(error instanceof ApiError ? error : new ApiError(502, "The interface could not be reached."));
                return;
            }
            const body = new Uint8Array(size);
            parts.reduce((at, part) => (body.set(part, at), at + part.length), 0);
            resolve({ status: head.status, headers: head.headers, body });
        };
        const sink: StreamSink = {
            head(reply) {
                head = reply;
                progress();
            },
            data(chunk) {
                progress();
                if (size + chunk.length <= REPLY_MAX) {
                    parts.push(chunk);
                    size += chunk.length;
                    return true;
                }
                stream?.reset();
                // a range past the cap is cut where the cap falls and says so; the media element asks for the rest
                const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(head.headers.find(([name]) => name === "content-range")?.[1] ?? "");
                if (head.status !== 206 || !range) {
                    done(new ApiError(502, "The interface answered more than the desktop app carries."));
                    return false;
                }
                parts.push(chunk.subarray(0, REPLY_MAX - size));
                size = REPLY_MAX;
                const cut = `bytes ${range[1]}-${Number(range[1]) + REPLY_MAX - 1}/${range[2]}`;
                head = { status: 206, headers: head.headers.map(([name, value]) => [name, name === "content-range" ? cut : value]) };
                done(null);
                return false;
            },
            end: () => done(null),
            fail: (error) => done(error),
        };
        progress();
        openStream(header, sink, abort.signal).then(async (open) => {
            stream = open;
            for (let at = 0, room = true; upload && at < upload.length && !settled; at += APP_CHUNK) {
                if (!room) await new Promise<void>((go) => open.onDrain(go));
                room = open.write(upload.subarray(at, at + APP_CHUNK));
                progress();
            }
            open.end();
        }, done);
    });
}
