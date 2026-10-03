// mini-apps.ts's scheme path over stubbed channel, cookie jar and relay modules, with the desktop shell as an invoke recorder.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { gzipSync } from "node:zlib";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS: Record<string, string> = {
    "./channel.ts": stub(`
        export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
        export const gatewayTag = () => globalThis.__mini.tag;
        export const subscribe = (listener) => { globalThis.__mini.listeners.push(listener); return () => undefined; };
        export const openStream = (header, sink, signal) => globalThis.__mini.openStream(header, sink, signal);
        export const streamFetch = (header, body, signal) => globalThis.__mini.streamFetch(header, body, signal);
    `),
    "./api.ts": stub(`
        export const listPins = async () => globalThis.__mini.pins;
    `),
    "./mini-app-cookies.ts": stub(`
        export const cookieHeader = (scope, sameSite) => globalThis.__mini.cookieHeader(scope, sameSite);
        export const storeCookies = (scope, lines, from) => globalThis.__mini.storeCookies(scope, lines, from);
        export const pinJar = (gateway, appId, pin) => globalThis.__mini.events.push("pin:" + gateway + ":" + appId + ":" + pin);
    `),
    "./mini-app-relay.ts": stub(`
        export const BRIDGE_PATH = "/__mimi__/bridge.js";
        export const attachRelay = (door) => { globalThis.__mini.door = door; };
        export const bridgeScript = () => new TextEncoder().encode("/* bridge */");
        export const cookiesChanged = (appId) => globalThis.__mini.events.push("cookies:" + appId);
        export const injectBridge = (html, doc) => { globalThis.__mini.injected.push(doc); return new TextEncoder().encode("<script src=bridge></script>" + new TextDecoder().decode(html)); };
        export const takeStashed = (appId, path) => globalThis.__mini.stash(appId, path);
    `),
};
registerHooks({
    resolve(specifier, context, nextResolve) {
        const url = STUBS[specifier];
        if (url && context.parentURL?.includes("/src/mini-apps.ts")) return { url, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

interface Head { status: number; headers: [string, string][] }
interface Sink { head(head: Head): void; data(chunk: Uint8Array): boolean; end(): void; fail(error: Error): void }
interface Call { header: Record<string, unknown> & { headers: Record<string, string> }; sink: Sink; written: Uint8Array[]; ended: boolean; reset: boolean }
interface Reply { id: string; status: number; headers: Map<string, string>; body: string }

const TAG = "0a1b2c3d4e";
const PINNED_AT = "2026-10-01 10:00:00";
const card = (name: string, fingerprint = "sha256:aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111") => ({ name, fingerprint, pinnedAt: PINNED_AT });
// what the pult derives from an agent's pin: the first 5 bytes of sha256("<fingerprint> <pinnedAt>"), in hex
const pinOf = (fingerprint: string): string => createHash("sha256").update(`${fingerprint} ${PINNED_AT}`).digest("hex").slice(0, 10);
const PIN = pinOf(card("files").fingerprint);
const GATEWAY = `${PIN}.${TAG}`;
const ORIGIN = `mimiapp://files.${GATEWAY}.localhost`;
const utf8 = new TextEncoder();
const mini = {
    tag: TAG,
    pins: [card("files"), card("notes"), card("board"), card("blocked")],
    listeners: [] as (() => void)[],
    events: [] as string[],
    injected: [] as unknown[],
    door: null as { grantOf(appId: string): Promise<string> | null; originOf(appId: string): string | null } | null,
    calls: [] as Call[],
    grants: 0,
    grantStatus: 200,
    // the scripted upstream: answers a call once the pult has ended its request, unless a case leaves it hanging
    upstream: null as ((call: Call) => void) | null,
    cookieHeader: (_scope: unknown, _sameSite: string): string => "",
    cookieScopes: [] as unknown[],
    storeCookies: (_scope: unknown, _lines: string[], _from: string): boolean => false,
    stash: (_appId: string, _path: string): unknown => null,
    openStream: async (header: Call["header"], sink: Sink, signal?: AbortSignal) => {
        const call: Call = { header, sink, written: [], ended: false, reset: false };
        mini.calls.push(call);
        signal?.addEventListener("abort", () => {
            if (call.reset) return;
            call.reset = true;
            sink.fail(signal.reason as Error);
        });
        return {
            write: (chunk: Uint8Array) => { call.written.push(chunk.slice()); return true; },
            onDrain: (go: () => void) => queueMicrotask(go),
            end: () => {
                call.ended = true;
                queueMicrotask(() => mini.upstream?.(call));
            },
            reset: () => { call.reset = true; },
            resume: () => undefined,
        };
    },
    streamFetch: async (header: { t: string }) => {
        assert.equal(header.t, "app_grant", "the scheme path mints nothing and sends everything else as a stream");
        mini.grants += 1;
        return new Response(JSON.stringify({ appId: "files", credential: `cred-${mini.grants}` }), { status: mini.grantStatus });
    },
};

const invoked: { cmd: string; args: unknown }[] = [];
const replies: Reply[] = [];
let upload: ArrayBuffer | number[] = new ArrayBuffer(0);
Object.assign(globalThis, {
    __mini: mini,
    location: { origin: "tauri://localhost" },
    window: {
        __TAURI_INTERNALS__: {
            invoke: async (cmd: string, args?: unknown) => {
                invoked.push({ cmd, args });
                if (cmd === "apps_attach") return "mimiapp://{host}.localhost/";
                if (cmd === "app_body") return upload;
                if (cmd === "app_respond") {
                    const bytes = args as Uint8Array;
                    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
                    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + size))) as { id: string; status: number; headers: [string, string][] };
                    replies.push({ id: head.id, status: head.status, headers: new Map(head.headers), body: new TextDecoder().decode(bytes.subarray(4 + size)) });
                }
                return undefined;
            },
        },
    },
});

// a fresh module before attach, then the one every case uses
const unattached = (await import("../src/mini-apps.ts?unattached")) as typeof import("../src/mini-apps.ts");
const doors = await import("../src/mini-apps.ts");
const { attachAppDoor, doorAttached, frameUrl, grantFor, serve } = doors;

const answer = (call: Call, status: number, headers: [string, string][] = [], ...chunks: (string | Uint8Array)[]): void => {
    call.sink.head({ status, headers });
    for (const chunk of chunks) call.sink.data(typeof chunk === "string" ? utf8.encode(chunk) : chunk);
    call.sink.end();
};
const ok = (call: Call): void => answer(call, 200, [["content-type", "text/plain"]], "ok");
let ids = 0;
const request = (over: Partial<import("../src/mini-apps.ts").SchemeRequest> = {}) =>
    ({ id: `r${++ids}`, app: "files", gateway: GATEWAY, method: "GET", path: "/", headers: [] as [string, string][], body: 0, ...over });
const policies = (reply: Reply | undefined): string[] => (reply?.headers.get("content-security-policy") ?? "").split(", ");
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => {
    mini.tag = TAG;
    mini.calls.length = 0;
    mini.events.length = 0;
    mini.injected.length = 0;
    mini.cookieScopes.length = 0;
    mini.upstream = ok;
    mini.grantStatus = 200;
    mini.cookieHeader = () => "";
    mini.storeCookies = () => false;
    mini.stash = () => null;
    invoked.length = 0;
    replies.length = 0;
});

test("before the shell attaches, no frame URL exists", async () => {
    assert.equal(unattached.doorAttached(), false);
    await assert.rejects(unattached.frameUrl("files", "/"), /only in the mimi desktop app on macOS/);
});

test("attach asks the shell once and hands the relay its door; a frame URL exists once its app is launched", async () => {
    attachAppDoor();
    assert.equal(doorAttached(), true);
    assert.equal(invoked[0]?.cmd, "apps_attach");
    assert.equal(typeof (window as unknown as { __mimiApps?: unknown }).__mimiApps, "function");
    await assert.rejects(frameUrl("files", "/"), /from its agent's Interfaces tab/);
    assert.equal(mini.door?.originOf("files"), null);
    await grantFor("files", "files");
    assert.deepEqual(mini.events, [`pin:${TAG}:files:${PIN}`], "the jar is bound to the pin behind the app");
    assert.equal(await frameUrl("files", "/orders/7?page=2"), `${ORIGIN}/orders/7?page=2`);
    assert.equal(await frameUrl("files", "/orders:7"), `${ORIGIN}/orders:7`, "a colon in a route stays a path");
    await assert.rejects(frameUrl("files", "//evil.test/x"), /leaves its app/);
    assert.equal(mini.door?.originOf("files"), ORIGIN);
});

test("serve never mints: an app not launched in this pult is refused before anything reaches the channel", async () => {
    const before = mini.grants;
    await serve(request({ app: "notes" }));
    assert.equal(replies[0]?.status, 403);
    assert.equal(mini.calls.length, 0);
    assert.equal(mini.grants, before);
    assert.equal(mini.door?.grantOf("notes"), null);
});

test("a launch mints once, a retry mints again, and a refused mint is not kept", async () => {
    const before = mini.grants;
    assert.equal(await grantFor("files", "files"), `cred-${before}`);
    assert.equal(mini.grants, before, "the attach case already launched files");
    assert.equal(await grantFor("files", "files", true), `cred-${before + 1}`);
    mini.grantStatus = 403;
    await assert.rejects(grantFor("blocked", "blocked"), /not open to this device/);
    assert.equal(mini.door?.grantOf("blocked"), null);
    mini.grantStatus = 200;
    await assert.rejects(grantFor("ghost", "ghost"), /agent is not admitted/);
    assert.equal(mini.door?.grantOf("ghost"), null);
    assert.equal(await mini.door?.grantOf("files"), `cred-${before + 1}`);
});

test("a GET rides the app stream with the launch's credential and comes back with the pult's own policy headers", async () => {
    const credential = await grantFor("files", "files");
    mini.upstream = (call) => answer(call, 200, [["content-type", "text/plain"], ["content-length", "2"], ["set-cookie", "a=1"], ["cache-control", "max-age=60"], ["x-frame-options", "DENY"]], "ok");
    await serve(request({ path: "/api/files?x=1", headers: [["accept", "*/*"], ["cookie", "forged=1"]] }));
    assert.equal(invoked.some((i) => i.cmd === "app_body"), false);
    const { header } = mini.calls[0]!;
    assert.deepEqual({ ...header, headers: undefined }, { t: "app", appId: "files", credential, method: "GET", path: "/api/files?x=1", headers: undefined });
    assert.equal(header.headers["accept-encoding"], "identity");
    assert.equal(header.headers["cookie"], undefined, "a cookie the frame sent never leaves the pult");
    const reply = replies[0]!;
    assert.equal(reply.id, `r${ids}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body, "ok");
    for (const name of ["content-length", "set-cookie", "x-frame-options"]) assert.equal(reply.headers.has(name), false, name);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.equal(reply.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
    assert.equal(reply.headers.get("referrer-policy"), "same-origin");
});

test("one merged CSP: the app's own policy, who may frame it (the app itself too, for nested frames), and no other app", async () => {
    mini.upstream = (call) => answer(call, 200, [["content-type", "text/plain"], ["content-security-policy", "script-src 'self'"]], "ok");
    await serve(request());
    assert.deepEqual(policies(replies[0]), [
        "script-src 'self'",
        `frame-ancestors tauri://localhost 'self' ${ORIGIN}`,
        `default-src 'self' ${ORIGIN} https: wss: data: blob: mediastream: 'unsafe-inline' 'unsafe-eval'; form-action 'self' ${ORIGIN}`,
    ]);
    mini.upstream = ok;
    await serve(request());
    assert.equal(policies(replies[1]).length, 2, "an app without a policy adds no empty one");
});

test("a repeated header travels joined, and a HEAD keeps the app's content-length", async () => {
    mini.upstream = (call) => answer(call, 200, [["link", "</a>; rel=preload"], ["link", "</b>; rel=preload"], ["content-length", "42"]]);
    await serve(request({ method: "HEAD" }));
    assert.equal(replies[0]?.headers.get("link"), "</a>; rel=preload, </b>; rel=preload");
    assert.equal(replies[0]?.headers.get("content-length"), "42");
});

test("an upload is pulled from the shell and streamed in chunks, whichever IPC path carried it", async () => {
    const bytes = new Uint8Array(40_000).map((_, i) => i % 251);
    upload = bytes.slice().buffer;
    await serve(request({ method: "POST", body: bytes.length, headers: [["content-type", "application/octet-stream"]] }));
    assert.deepEqual(invoked.find((i) => i.cmd === "app_body")?.args, { id: `r${ids}` });
    const call = mini.calls[0]!;
    assert.equal(call.header.headers["content-length"], String(bytes.length));
    assert.ok(call.written.every((chunk) => chunk.length <= 16 * 1024));
    assert.deepEqual(new Uint8Array(Buffer.concat(call.written)), bytes);
    upload = [1, 2, 3];
    await serve(request({ method: "PUT", body: 3 }));
    assert.deepEqual([...Buffer.concat(mini.calls[1]!.written)], [1, 2, 3]);
    assert.equal(replies[1]?.status, 200);
});

test("a multipart post whose body WebKit dropped fails loudly instead of arriving empty", async () => {
    await serve(request({ method: "POST", headers: [["content-type", "multipart/form-data; boundary=x"]] }));
    assert.equal(replies[0]?.status, 400);
    assert.match(replies[0]?.body ?? "", /WebKit dropped this request body/);
    assert.equal(mini.calls.length, 0);
});

test("bridge.js is the pult's own and nothing under /__mimi__/ goes upstream", async () => {
    await serve(request({ path: "/__mimi__/bridge.js?v=1" }));
    await serve(request({ path: "/__mimi__/other" }));
    assert.equal(replies[0]?.status, 200);
    assert.equal(replies[0]?.body, "/* bridge */");
    assert.equal(replies[0]?.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(replies[1]?.status, 404);
    assert.equal(mini.calls.length, 0);
});

test("another gateway's frame gets 421, and a gateway change drops every grant", async () => {
    await serve(request({ gateway: `${PIN}.ffffffffff` }));
    assert.equal(replies[0]?.status, 421);
    assert.equal(mini.calls.length, 0);
    mini.tag = "ffffffffff";
    for (const listener of mini.listeners) listener();
    mini.tag = TAG;
    assert.equal(mini.door?.grantOf("files"), null);
    await grantFor("files", "files");
});

test("an agent that takes a used name gets an origin of its own and an empty jar, and the old agent's frames are refused", async () => {
    const was = mini.pins;
    mini.pins = [card("files", "sha256:9999-8888-7777-6666-5555-4444-3333-2222")];
    try {
        await grantFor("files", "files", true);
        const pin = pinOf("sha256:9999-8888-7777-6666-5555-4444-3333-2222");
        assert.deepEqual(mini.events, [`pin:${TAG}:files:${pin}`]);
        assert.equal(mini.door?.originOf("files"), `mimiapp://files.${pin}.${TAG}.localhost`);
        assert.equal(await frameUrl("files", "/"), `mimiapp://files.${pin}.${TAG}.localhost/`);
        await serve(request());
        assert.equal(replies[0]?.status, 421, "a frame on the old pin's origin");
        await serve(request({ gateway: `${pin}.${TAG}` }));
        assert.equal(replies[1]?.status, 200);
    } finally {
        mini.pins = was;
        await grantFor("files", "files", true);
    }
});

test("the jar fills the cookie header per hop and takes every Set-Cookie before the reply reaches the frame", async () => {
    const asked: [unknown, string][] = [];
    mini.cookieHeader = (scope, sameSite) => { asked.push([scope, sameSite]); return "sid=1"; };
    mini.storeCookies = (scope, lines, from) => { mini.events.push(`store:${JSON.stringify(scope)}:${lines.join("|")}:${from}`); return true; };
    const respond = invoked.length;
    mini.upstream = (call) => answer(call, 200, [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2"]], "ok");
    await serve(request({ path: "/app/page?q", headers: [["referer", `${ORIGIN}/app/`], ["sec-fetch-dest", "document"]] }));
    assert.equal(mini.calls[0]?.header.headers["cookie"], "sid=1");
    assert.deepEqual(asked, [[{ gateway: TAG, appId: "files", path: "/app/page" }, "same"]]);
    assert.deepEqual(mini.events, [`store:{"gateway":"${TAG}","appId":"files","path":"/app/page"}:a=1; Path=/|b=2:http`, "cookies:files"]);
    assert.ok(invoked.slice(respond).some((i) => i.cmd === "app_respond"));
});

test("only what starts in this app is same-site, and a missing Sec-Fetch-Site needs a same-app Referer or Origin to be", async () => {
    // an app no launch has pointed a frame at yet, so no navigation here is the pult's own
    await grantFor("notes", "notes");
    const own = `mimiapp://notes.${GATEWAY}.localhost`;
    const sites: string[] = [];
    mini.cookieHeader = (_scope, sameSite) => { sites.push(sameSite); return ""; };
    await serve(request({ app: "notes", headers: [["sec-fetch-dest", "iframe"]] }));
    await serve(request({ app: "notes", headers: [["sec-fetch-dest", "iframe"], ["referer", `${ORIGIN}/`]] }));
    await serve(request({ app: "notes", headers: [["sec-fetch-site", "same-site"], ["sec-fetch-dest", "image"]] }));
    await serve(request({ app: "notes", headers: [["sec-fetch-dest", "image"]] }));
    await serve(request({ app: "notes", headers: [["sec-fetch-dest", "image"], ["referer", `${own}/page`]] }));
    await serve(request({ app: "notes", method: "POST", headers: [["origin", own]] }));
    await serve(request({ app: "notes", headers: [["sec-fetch-site", "same-origin"], ["sec-fetch-dest", "image"]] }));
    assert.deepEqual(sites, ["cross", "cross", "cross", "cross", "same", "same", "same"]);
});

test("Lax cookies ride only the navigation a launch or a reload started, once each; another app's navigation here gets SameSite=None only", async () => {
    await grantFor("board", "board");
    const sites: string[] = [];
    mini.cookieHeader = (_scope, sameSite) => { sites.push(sameSite); return ""; };
    const nav: [string, string][] = [["sec-fetch-dest", "iframe"], ["sec-fetch-site", "cross-site"]];
    await frameUrl("board", "/");
    await serve(request({ app: "board", headers: nav }));
    await serve(request({ app: "board", headers: nav }));
    await serve(request({ app: "board", headers: [["sec-fetch-dest", "image"], ["sec-fetch-site", "cross-site"]] }));
    await frameUrl("board", "/");
    await frameUrl("board", "/week");
    for (const path of ["/week", "/", "/"]) await serve(request({ app: "board", path, headers: [["accept", "text/html"]] }));
    assert.deepEqual(sites, ["launch", "cross", "cross", "launch", "launch", "cross"]);
});

test("a launch's Lax cookies go only to its own path, only for a while, and never to the app's own navigation in its stead", async (t) => {
    await grantFor("board", "board");
    const sites: string[] = [];
    mini.cookieHeader = (_scope, sameSite) => { sites.push(sameSite); return ""; };
    const cross: [string, string][] = [["sec-fetch-dest", "iframe"], ["sec-fetch-site", "cross-site"]];
    await frameUrl("board", "/");
    await serve(request({ app: "board", path: "/delete?id=1", headers: cross }));
    await serve(request({ app: "board", path: "/", headers: [["sec-fetch-dest", "iframe"], ["sec-fetch-site", "same-origin"]] }));
    await serve(request({ app: "board", path: "/", headers: cross }));
    assert.deepEqual(sites, ["cross", "same", "launch"]);

    await frameUrl("board", "/");
    const later = Date.now() + 10_001;
    t.mock.method(Date, "now", () => later);
    await serve(request({ app: "board", path: "/", headers: cross }));
    assert.deepEqual(sites.slice(3), ["cross"], "an unused launch expires");
});

test("a document's 302 moves the document itself; a document's 307 is followed with its body", async () => {
    mini.upstream = (call) => call.header["path"] === "/start"
        ? answer(call, 302, [["location", "/next?a=1&b=2"], ["set-cookie", "hop=1"]])
        : ok(call);
    const stored: string[] = [];
    mini.storeCookies = (_scope, lines) => { stored.push(...lines); return false; };
    await serve(request({ path: "/start", headers: [["sec-fetch-dest", "document"]] }));
    assert.equal(mini.calls.length, 1);
    assert.equal(replies[0]?.status, 200);
    assert.equal(replies[0]?.body, `<!doctype html><meta http-equiv="refresh" content="0;url=${ORIGIN}/next?a=1&amp;b=2">`);
    assert.equal(policies(replies[0])[0], "default-src 'none'");
    assert.deepEqual(stored, ["hop=1"]);

    upload = utf8.encode("form=1").buffer as ArrayBuffer;
    mini.upstream = (call) => call.header["path"] === "/submit" ? answer(call, 307, [["location", "/again"]]) : ok(call);
    await serve(request({ method: "POST", path: "/submit", body: 6, headers: [["sec-fetch-dest", "document"], ["content-type", "application/x-www-form-urlencoded"]] }));
    assert.equal(mini.calls[2]?.header["method"], "POST");
    assert.equal(mini.calls[2]?.header["path"], "/again");
    assert.equal(Buffer.concat(mini.calls[2]!.written).toString(), "form=1");
    assert.equal(replies[1]?.body, "ok");
});

test("a subresource POST answered 302 is followed as a GET with no body and no body headers", async () => {
    upload = utf8.encode("x=1").buffer as ArrayBuffer;
    mini.upstream = (call) => call.header["path"] === "/save" ? answer(call, 302, [["location", "done"]]) : ok(call);
    await serve(request({ method: "POST", path: "/save", body: 3, headers: [["content-type", "application/x-www-form-urlencoded"]] }));
    const second = mini.calls[1]!;
    assert.equal(second.header["method"], "GET");
    assert.equal(second.header["path"], "/done");
    assert.equal(second.written.length, 0);
    assert.equal(second.header.headers["content-type"], undefined);
    assert.equal(second.header.headers["content-length"], undefined);
    assert.equal(replies[0]?.body, "ok");
});

test("a redirect out of the app, or one hop too many, is an inert 502", async () => {
    mini.upstream = (call) => answer(call, 302, [["location", "https://evil.test/"]]);
    await serve(request());
    assert.equal(replies[0]?.status, 502);
    assert.equal(policies(replies[0])[0], "default-src 'none'");
    mini.upstream = (call) => answer(call, 307, [["location", "/loop"]]);
    await serve(request());
    assert.equal(replies[1]?.status, 502);
    assert.equal(mini.calls.length, 1 + 21);
});

test("only a navigation to an HTML page gets the bridge", async () => {
    mini.upstream = (call) => answer(call, 200, [["content-type", "text/html; charset=utf-8"], ["content-security-policy", "script-src 'nonce-a'"]], "<p>hi");
    await serve(request({ path: "/doc?x", headers: [["sec-fetch-dest", "document"]] }));
    await serve(request({ headers: [["accept", "text/html,*/*"]] }));
    await serve(request({ headers: [["sec-fetch-dest", "empty"]] }));
    mini.upstream = (call) => answer(call, 200, [["content-type", "application/json"]], "{}");
    await serve(request({ headers: [["sec-fetch-dest", "document"]] }));
    assert.deepEqual(mini.injected, [{ appId: "files", csp: "script-src 'nonce-a'", path: "/doc" }, { appId: "files", csp: "script-src 'nonce-a'", path: "/" }]);
    assert.equal(replies[0]?.body, "<script src=bridge></script><p>hi");
    assert.equal(replies[2]?.body, "<p>hi");
});

test("a form's final page left in the stash answers the navigation that shows it, bridge included", async () => {
    mini.stash = (appId, path) => appId === "files" && path === "/done?id=4" ? { status: 201, headers: [["content-type", "text/html"]], body: utf8.encode("<p>saved") } : null;
    await serve(request({ path: "/done?id=4", headers: [["sec-fetch-dest", "document"]] }));
    assert.equal(mini.calls.length, 0);
    assert.equal(replies[0]?.status, 201);
    assert.equal(replies[0]?.body, "<script src=bridge></script><p>saved");
});

test("a range past the reply cap is asked for in a piece the cap carries, and a reply past it is cut or refused", async () => {
    const MAX = 16 * 1024 * 1024;
    mini.upstream = (call) => answer(call, 206, [["content-range", `bytes 0-${MAX}/${2 * MAX}`]], new Uint8Array(MAX + 1));
    await serve(request({ headers: [["range", "bytes=0-"]] }));
    assert.equal(mini.calls[0]?.header.headers["range"], `bytes=0-${MAX - 1}`);
    assert.equal(mini.calls[0]?.reset, true, "the rest of the range is cancelled upstream");
    assert.equal(replies[0]?.status, 206);
    assert.equal(replies[0]?.headers.get("content-range"), `bytes 0-${MAX - 1}/${2 * MAX}`);
    assert.equal(replies[0]?.body.length, MAX);
    mini.upstream = (call) => answer(call, 200, [], new Uint8Array(MAX + 1));
    await serve(request());
    assert.equal(replies[1]?.status, 502);
    assert.equal(mini.calls[1]?.reset, true);
});

test("a gzip reply is decoded for WebKit, and an encoding the pult cannot read is refused", async () => {
    mini.upstream = (call) => answer(call, 200, [["content-type", "text/plain"], ["content-encoding", "gzip"]], gzipSync("hello, gzip"));
    await serve(request());
    assert.equal(replies[0]?.body, "hello, gzip");
    assert.equal(replies[0]?.headers.has("content-encoding"), false);
    mini.upstream = (call) => answer(call, 200, [["content-encoding", "br"]], "x");
    await serve(request());
    assert.equal(replies[1]?.status, 502);
});

test("a 204 carries no body, and a closed channel is an inert 502", async () => {
    mini.upstream = (call) => answer(call, 204);
    await serve(request());
    assert.equal(replies[0]?.status, 204);
    assert.equal(replies[0]?.body, "");
    mini.upstream = (call) => call.sink.fail(new Error("The gateway connection closed."));
    await serve(request());
    assert.equal(replies[1]?.status, 502);
    assert.equal(replies[1]?.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(policies(replies[1])[0], "default-src 'none'");
});

test("the deadline is time without progress: a hanging app is 504 and reset, a slow but moving one completes", async () => {
    mini.upstream = null;
    await serve(request(), 20);
    assert.equal(replies[0]?.status, 504);
    assert.equal(mini.calls[0]?.reset, true);
    mini.upstream = (call) => {
        call.sink.head({ status: 200, headers: [] });
        let sent = 0;
        const timer = setInterval(() => {
            call.sink.data(utf8.encode("."));
            if (++sent === 6) {
                clearInterval(timer);
                call.sink.end();
            }
        }, 15);
    };
    await serve(request(), 40);
    assert.equal(replies[1]?.status, 200);
    assert.equal(replies[1]?.body, "......");
});

test("16 requests live, 8 per app, FIFO per app and round-robin across apps", async () => {
    for (const app of ["notes", "board"]) await grantFor(app, app);
    mini.upstream = null;
    const all = [
        ...Array.from({ length: 9 }, () => serve(request())),
        ...Array.from({ length: 9 }, () => serve(request({ app: "notes" }))),
        serve(request({ app: "board" })),
    ];
    await flush();
    const live = (app: string): number => mini.calls.filter((c) => c.header["appId"] === app).length;
    assert.deepEqual([live("files"), live("notes"), live("board")], [8, 8, 0]);
    ok(mini.calls[0]!);
    await flush();
    assert.deepEqual([live("files"), live("notes"), live("board")], [9, 8, 0], "the app first in line with room goes");
    ok(mini.calls.find((c) => c.header["appId"] === "notes")!);
    await flush();
    assert.deepEqual([live("files"), live("notes"), live("board")], [9, 9, 0]);
    ok(mini.calls[1]!);
    await flush();
    assert.deepEqual([live("files"), live("notes"), live("board")], [9, 9, 1], "an app no request has served yet is not starved");
    for (const call of mini.calls) if (!call.reset) ok(call);
    await Promise.all(all);
    assert.equal(replies.length, 19);
});
