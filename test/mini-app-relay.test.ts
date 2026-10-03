// mini-app-relay.ts against fake frames and a stubbed channel.ts; the cookie jar, WebSocket codec and hashes are real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

const CHANNEL = `data:text/javascript,${encodeURIComponent(`
export const openStream = (...args) => globalThis.__channel.openStream(...args);
export const gatewayTag = () => globalThis.__channel.tag;
export const subscribe = (listener) => globalThis.__channel.subscribe(listener);
`)}`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.includes("/src/mini-app-")) return { url: CHANNEL, shortCircuit: true };
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (!url.endsWith("?raw")) return nextLoad(url, context);
        const text = readFileSync(new URL(url.slice(0, -"?raw".length)), "utf8");
        return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
    },
});

// ── the scripted channel ────────────────────────────────────────────────────
interface Sink {
    head(head: { status: number; headers: [string, string][] }): void;
    data(chunk: Uint8Array): boolean;
    end(): void;
    fail(error: Error): void;
}
interface Fake {
    header: { t: string; appId: string; credential: string; method: string; path: string; headers: Record<string, string>; upgrade?: true };
    sink: Sink;
    written: Uint8Array[];
    ended: boolean;
    reset: boolean;
    closed: boolean;
    resumed: number;
    writable: boolean;
    drain: (() => void) | null;
}
const fakes: Fake[] = [];
const listeners = new Set<(s: { state: string }) => void>();
let holdOpen = false;
const held: (() => void)[] = [];
const channel = {
    tag: "a1b2c3d4e5",
    subscribe(listener: (s: { state: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    openStream(header: Fake["header"], sink: Sink, signal?: AbortSignal) {
        return new Promise((resolve, reject) => {
            const fake: Fake = { header, sink, written: [], ended: false, reset: false, closed: false, resumed: 0, writable: true, drain: null };
            let opened = false;
            signal?.addEventListener("abort", () => {
                if (!opened) return reject(signal.reason);
                if (fake.closed) return;
                fake.reset = true;
                fake.closed = true;
                sink.fail(new Error("aborted"));
            });
            const go = (): void => {
                if (signal?.aborted) return reject(signal.reason);
                opened = true;
                fakes.push(fake);
                resolve({
                    write(chunk: Uint8Array) {
                        fake.written.push(chunk.slice());
                        return fake.writable;
                    },
                    onDrain(resume: () => void) {
                        if (fake.writable || fake.closed) queueMicrotask(resume);
                        else fake.drain = resume;
                    },
                    end() { fake.ended = true; },
                    reset() {
                        fake.reset = true;
                        fake.closed = true;
                    },
                    resume() { fake.resumed += 1; },
                });
            };
            if (holdOpen) held.push(go);
            else go();
        });
    },
};

// ── the pult's globals ──────────────────────────────────────────────────────
let helloListener: ((event: unknown) => void) | null = null;
const pult = {
    addEventListener(type: string, listener: (event: unknown) => void) {
        if (type === "message") helloListener = listener;
    },
};
const storage = new Map<string, string>();
Object.assign(globalThis, { __channel: channel, window: pult, location: { origin: "tauri://localhost" } });
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        get length() { return storage.size; },
        key: (i: number) => [...storage.keys()][i] ?? null,
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
    },
});
mock.timers.enable({ apis: ["setTimeout"] });

const relay = await import("../src/mini-app-relay.ts");
const { redirectStep } = await import("../src/mini-app-redirect.ts");
const cookies = await import("../src/mini-app-cookies.ts");
const { wsAccept, clientFrame, OP_TEXT } = await import("../src/mini-app-ws.ts");

const launched = new Set(["wren", "files", "notes"]);
// apps whose name another agent pin took since launch: the door names a new origin for them
const moved = new Set<string>();
const originOf = (appId: string): string => `mimiapp://${appId}.${moved.has(appId) ? "0f0f0f0f0f." : ""}${channel.tag}.localhost`;
relay.attachRelay({ grantOf: (appId) => (launched.has(appId) ? Promise.resolve(`cred-${appId}`) : null), originOf });

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array | ArrayBuffer): string => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
    for (let i = 0; i < 500; i++) {
        const value = read();
        if (value) return value;
        await settle();
    }
    throw new Error(`timed out waiting for ${what}`);
}

// ── fake frames ─────────────────────────────────────────────────────────────
interface Posted { msg: { mimi: string; nonce: string }; origin: string; transfer: MessagePort[] }
function makeFrame(parent: object = pult) {
    const onLoad: (() => void)[] = [];
    const posted: Posted[] = [];
    const win = { parent, postMessage: (msg: Posted["msg"], origin: string, transfer: MessagePort[]) => posted.push({ msg, origin, transfer }) };
    const el = {
        contentWindow: win,
        addEventListener: (type: string, fn: () => void) => { if (type === "load") onLoad.push(fn); },
        removeEventListener: () => { onLoad.length = 0; },
    };
    return { el: el as unknown as HTMLIFrameElement, win, posted, load: () => onLoad.forEach((fn) => fn()) };
}

function bootOf(html: Uint8Array): { v: number; key: string; doc: string; pult: string; origin: string; cookies: { n: string; v: string }[] } {
    const raw = /data-mimi="([^"]*)"/.exec(text(html))?.[1] ?? "";
    return JSON.parse(raw.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) as ReturnType<typeof bootOf>;
}

const bootFor = (appId: string): ReturnType<typeof bootOf> => bootOf(relay.injectBridge(utf8.encode("<head>"), { appId, csp: "", path: "/" }));
const keyOf = (appId: string): string => bootFor(appId).key;
const hello = (win: object, key: string, origin: string, nonce = "n1", doc = "d"): void => helloListener?.({ data: { mimi: "hello", v: 1, key, nonce, doc }, source: win, origin });

const unregister: (() => void)[] = [];
const ports: MessagePort[] = [];

interface Link { port: MessagePort; inbox: Record<string, unknown>[]; frame: ReturnType<typeof makeFrame>; closed: () => boolean }
async function connect(appId = "wren", frame = makeFrame()): Promise<Link> {
    if (!unregister.some((u) => (u as { frame?: unknown }).frame === frame)) {
        const off = relay.registerFrame(frame.el, appId);
        unregister.push(Object.assign(off, { frame }));
    }
    const boot = bootFor(appId);
    hello(frame.win, boot.key, originOf(appId), "n1", boot.doc);
    const welcome = frame.posted.at(-1);
    assert.ok(welcome, "welcomed");
    const port = welcome.transfer[0] as MessagePort;
    const inbox: Record<string, unknown>[] = [];
    let isClosed = false;
    port.onmessage = (e: MessageEvent) => inbox.push(e.data as Record<string, unknown>);
    port.addEventListener("close", () => { isClosed = true; });
    ports.push(port);
    return { port, inbox, frame, closed: () => isClosed };
}

const find = (link: Link, t: string, id?: number): Record<string, unknown> | undefined => link.inbox.find((m) => m["t"] === t && (id === undefined || m["id"] === id));
const fetchMessage = (id: number, over: Record<string, unknown> = {}) => ({
    t: "fetch", id, kind: "fetch", method: "GET", path: "/x", headers: [], body: "none", credentials: "include", keepalive: false, nav: false, integrity: "", ...over,
});
const lastFake = (): Fake => fakes.at(-1) as Fake;
const finishFake = (fake: Fake): void => {
    if (fake.closed) return;
    fake.closed = true;
    fake.sink.end();
};

test.afterEach(async () => {
    holdOpen = false;
    for (const go of held.splice(0)) go();
    for (const off of unregister.splice(0)) off();
    await settle();
    for (const fake of fakes) finishFake(fake);
    for (const port of ports.splice(0)) port.close();
    fakes.length = 0;
    storage.clear();
    cookies.clearCookies();
    channel.tag = "a1b2c3d4e5";
    await settle();
});

// ── the hello gate ──────────────────────────────────────────────────────────
test("only a registered frame launched for the key's app, on its own origin and gateway, is welcomed", () => {
    const debug = mock.method(console, "debug", () => undefined);
    const frame = makeFrame();
    unregister.push(relay.registerFrame(frame.el, "wren"));
    const key = keyOf("wren");
    hello(makeFrame().win, key, originOf("wren"));
    hello(frame.win, "0".repeat(32), originOf("wren"));
    hello(frame.win, key, "mimiapp://files.a1b2c3d4e5.localhost");
    hello(frame.win, key, "null");
    hello(frame.win, keyOf("files"), originOf("files"));
    launched.delete("wren");
    hello(frame.win, key, originOf("wren"));
    launched.add("wren");
    channel.tag = "ffffffffff";
    hello(frame.win, key, originOf("wren").replace("a1b2c3d4e5", "ffffffffff"));
    channel.tag = "a1b2c3d4e5";
    helloListener?.({ data: { mimi: "hello", v: 2, key, nonce: "n", doc: "d" }, source: frame.win, origin: originOf("wren") });
    assert.equal(frame.posted.length, 0, "every hello above was refused");
    assert.equal(debug.mock.callCount(), 8);
    hello(frame.win, key, originOf("wren"), "nonce-7");
    assert.equal(frame.posted.length, 1);
    assert.deepEqual(frame.posted[0]?.msg, { mimi: "welcome", v: 1, nonce: "nonce-7" });
    assert.equal(frame.posted[0]?.origin, originOf("wren"), "the port goes only to the app's own origin");
    ports.push(frame.posted[0]?.transfer[0] as MessagePort);
    debug.mock.restore();
});

test("a same-app frame nested in a launched one gets its own session; a new document replaces the old one's", async () => {
    const outer = await connect("wren");
    const nested = makeFrame(outer.frame.win);
    hello(nested.win, keyOf("wren"), originOf("wren"));
    assert.equal(nested.posted.length, 1, "welcomed through its parent chain");
    ports.push(nested.posted[0]?.transfer[0] as MessagePort);
    hello(outer.frame.win, keyOf("wren"), originOf("wren"), "n2");
    await until(() => outer.closed(), "the old session to close");
    assert.equal(outer.frame.posted.length, 2);
});

test("an iframe load retires the sessions opened before the previous load, nested ones included", async () => {
    const first = await connect("wren");
    const nested = makeFrame(first.frame.win);
    hello(nested.win, keyOf("wren"), originOf("wren"));
    const nestedPort = nested.posted[0]?.transfer[0] as MessagePort;
    let nestedClosed = false;
    nestedPort.addEventListener("close", () => { nestedClosed = true; });
    ports.push(nestedPort);
    first.frame.load();
    // the next document of that iframe: its nested frame is gone, but said no bye
    const second = await connect("wren", first.frame);
    await until(() => first.closed(), "the replaced document's own session");
    await settle();
    assert.equal(nestedClosed, false);
    first.frame.load();
    await until(() => nestedClosed, "the old nested session, at the load after next");
    await settle();
    assert.equal(second.closed(), false, "the document that just loaded keeps its session");
});

test("a malformed message or a reused id is fatal to the session", async () => {
    const link = await connect("wren");
    link.port.postMessage({ t: "fetch", id: "one" });
    await until(() => find(link, "fatal"), "fatal");
    assert.equal(find(link, "fatal")?.["retry"], false);
    await until(() => link.closed(), "close");

    const other = await connect("wren");
    other.port.postMessage(fetchMessage(5));
    other.port.postMessage(fetchMessage(5));
    await until(() => find(other, "fatal"), "fatal on a reused id");
});

// ── fetch ───────────────────────────────────────────────────────────────────
test("a fetch goes out as an app stream: its own headers, minus forbidden ones, plus origin, identity, the jar and the length", async () => {
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["sid=s1; HttpOnly", "theme=dark", "other=1; Path=/elsewhere"], "http");
    const link = await connect("wren");
    link.port.postMessage(fetchMessage(1, {
        method: "post", path: "/api/items?x=1", body: "stream", length: 5,
        headers: [["cookie", "forged=1"], ["host", "evil"], ["x-mimi-app", "z"], ["content-type", "application/json"], ["x-custom", "1"],
            ["accept-encoding", "br"], ["sec-websocket-key", "k"], ["proxy-authorization", "p"], ["origin", "mimiapp://other"], ["connection", "close"]],
    }));
    const fake = await until(() => fakes[0], "the stream");
    const { headers, ...rest } = fake.header;
    assert.deepEqual(rest, { t: "app", appId: "wren", credential: "cred-wren", method: "POST", path: "/api/items?x=1", upgrade: undefined });
    assert.deepEqual(Object.keys(headers).sort(), ["accept-encoding", "accept-language", "content-length", "content-type", "cookie", "origin", "user-agent", "x-custom"]);
    assert.equal(headers["cookie"], "sid=s1; theme=dark");
    assert.equal(headers["origin"], originOf("wren"));
    assert.equal(headers["accept-encoding"], "identity");
    assert.equal(headers["content-length"], "5");
    assert.equal(headers["user-agent"], navigator.userAgent);

    await until(() => find(link, "credit", 1), "the first upload credit");
    assert.equal(find(link, "credit", 1)?.["n"], 256 * 1024, "the frame may send one window once the stream is open");
    const body = utf8.encode("hello").buffer;
    link.port.postMessage({ t: "body", id: 1, chunk: body }, [body]);
    link.port.postMessage({ t: "end", id: 1 });
    await until(() => fake.ended, "the request END");
    assert.equal(text(fake.written[0] ?? new Uint8Array()), "hello");
    await until(() => link.inbox.filter((m) => m["t"] === "credit").length === 2, "credit for the bytes written");

    fake.sink.head({ status: 201, headers: [["content-type", "text/plain"], ["set-cookie", "fresh=1"], ["connection", "keep-alive"], ["x-bad", "aĀ"], ["x-many", "1"], ["x-many", "2"]] });
    fake.sink.data(utf8.encode("done"));
    finishFake(fake);
    await until(() => find(link, "end", 1), "end");
    const order = link.inbox.map((m) => m["t"]).filter((t) => t !== "credit");
    assert.deepEqual(order, ["cookies", "head", "data", "end"], "the jar snapshot reaches the frame before the reply that changed it");
    assert.deepEqual(find(link, "head", 1)?.["headers"], [["content-type", "text/plain"], ["x-many", "1"], ["x-many", "2"]]);
    assert.equal(text(find(link, "data", 1)?.["chunk"] as ArrayBuffer), "done");
    assert.deepEqual((find(link, "cookies")?.["list"] as { n: string }[]).map((c) => c.n), ["theme", "other", "fresh"]);
});

test("credentials: omit sends no Cookie and stores no Set-Cookie", async () => {
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["theme=dark"], "http");
    const link = await connect("wren");
    link.port.postMessage(fetchMessage(1, { credentials: "omit" }));
    const fake = await until(() => fakes[0], "the stream");
    assert.equal(fake.header.headers["cookie"], undefined);
    fake.sink.head({ status: 200, headers: [["set-cookie", "nope=1"]] });
    finishFake(fake);
    await until(() => find(link, "end", 1), "end");
    assert.deepEqual(cookies.scriptCookies(channel.tag, "wren").map((c) => c.n), ["theme"]);
});

test("request bodies stay inside the frame's credit: nothing before the stream opens, never more than a window", async () => {
    holdOpen = true;
    const early = await connect("wren");
    early.port.postMessage(fetchMessage(1, { method: "PUT", body: "stream" }));
    const chunk = new ArrayBuffer(1);
    early.port.postMessage({ t: "body", id: 1, chunk }, [chunk]);
    await until(() => find(early, "fatal"), "fatal for a body sent before any credit");
    holdOpen = false;
    for (const go of held.splice(0)) go();

    const link = await connect("wren");
    link.port.postMessage(fetchMessage(2, { method: "PUT", body: "stream" }));
    const fake = await until(() => fakes.find((f) => f.header.method === "PUT" && !f.reset), "the stream");
    fake.writable = false;
    await until(() => find(link, "credit", 2), "the first credit");
    const window = new ArrayBuffer(256 * 1024);
    link.port.postMessage({ t: "body", id: 2, chunk: window }, [window]);
    await until(() => fake.written.length > 0, "a write");
    assert.equal(fake.written.length, 1, "the pult stops at the first write the channel refuses");
    const credited = (): number => link.inbox.filter((m) => m["t"] === "credit" && m["id"] === 2).reduce((sum, m) => sum + (m["n"] as number), 0);
    await until(() => credited() === 256 * 1024 + 16 * 1024, "credit for the one chunk that entered the channel");
    const over = new ArrayBuffer(16 * 1024 + 1);
    link.port.postMessage({ t: "body", id: 2, chunk: over }, [over]);
    await until(() => find(link, "fatal"), "fatal past the credit");
});

test("a body must be exactly its declared length, which goes upstream as content-length", async () => {
    const link = await connect("wren");
    link.port.postMessage(fetchMessage(1, { method: "PUT", body: "stream", length: 3 }));
    const fake = await until(() => fakes[0], "the stream");
    assert.equal(fake.header.headers["content-length"], "3");
    await until(() => find(link, "credit", 1), "the first credit");
    const exact = utf8.encode("abc").buffer;
    link.port.postMessage({ t: "body", id: 1, chunk: exact }, [exact]);
    link.port.postMessage({ t: "end", id: 1 });
    await until(() => fake.ended, "the request END");
    assert.equal(find(link, "fatal"), undefined);

    const inline = await connect("wren");
    inline.port.postMessage(fetchMessage(1, { method: "POST", body: "inline", chunk: new ArrayBuffer(4), length: 5, keepalive: true }));
    assert.match(String((await until(() => find(inline, "error", 1), "error"))["message"]), /declared length/);

    for (const [sent, what] of [[4, "past"], [2, "shorter than"]] as const) {
        const over = await connect("wren");
        over.port.postMessage(fetchMessage(1, { method: "PUT", body: "stream", length: 3 }));
        await until(() => find(over, "credit", 1), "the first credit");
        const chunk = new ArrayBuffer(sent);
        over.port.postMessage({ t: "body", id: 1, chunk }, [chunk]);
        over.port.postMessage({ t: "end", id: 1 });
        assert.match(String((await until(() => find(over, "fatal"), `fatal ${what} the length`))["message"]), new RegExp(what));
    }
});

test("a frame that stops reading holds the channel's credit until it credits back", async () => {
    const link = await connect("wren");
    link.port.postMessage(fetchMessage(1));
    const fake = await until(() => fakes[0], "the stream");
    fake.sink.head({ status: 200, headers: [] });
    const answers = Array.from({ length: 4 }, () => fake.sink.data(new Uint8Array(64 * 1024)));
    assert.deepEqual(answers, [true, true, true, false], "the fourth chunk fills the 256 KiB frame window");
    assert.equal(fake.resumed, 0);
    link.port.postMessage({ t: "credit", id: 1, n: 64 * 1024 });
    await until(() => fake.resumed === 1, "resume once the frame took a chunk");
});

test("cancel resets a live stream and drops a queued one; bye resets everything but keepalive", async () => {
    const link = await connect("files");
    for (let id = 1; id <= 9; id++) link.port.postMessage(fetchMessage(id));
    await until(() => fakes.length === 8, "eight live streams, the ninth queued behind the per-app share");
    await settle();
    assert.equal(fakes.length, 8);
    link.port.postMessage({ t: "cancel", id: 9 });
    link.port.postMessage({ t: "cancel", id: 1 });
    await until(() => fakes[0]?.reset, "a RESET for the live one");
    await settle();
    assert.equal(fakes.length, 8, "the cancelled ninth never opens, though a slot came free");
    assert.equal(find(link, "error", 1), undefined, "a cancelled request hears nothing more");

    const keep = new ArrayBuffer(3);
    link.port.postMessage(fetchMessage(10, { method: "POST", body: "inline", chunk: keep, keepalive: true }), [keep]);
    await until(() => fakes.length === 9, "the keepalive stream");
    const keepalive = lastFake();
    assert.equal(keepalive.written.length, 1);
    assert.equal(keepalive.ended, true, "an inline body is sent whole");
    link.port.postMessage({ t: "bye" });
    await until(() => link.closed(), "the session to close");
    assert.equal(keepalive.reset, false, "keepalive outlives its document");
    assert.ok(fakes.slice(1, 8).every((f) => f.reset), "every other stream is reset");
});

test("16 fetches in all and 8 per app; the next waits for a slot", async () => {
    const wren = await connect("wren");
    const files = await connect("files");
    const notes = await connect("notes");
    for (let id = 1; id <= 8; id++) {
        wren.port.postMessage(fetchMessage(id));
        files.port.postMessage(fetchMessage(id));
    }
    await until(() => fakes.length === 16, "sixteen streams");
    wren.port.postMessage(fetchMessage(9));
    for (let i = 0; i < 5; i++) await settle();
    notes.port.postMessage(fetchMessage(1));
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(fakes.length, 16);
    finishFake(fakes.find((f) => f.header.appId === "files") as Fake);
    await until(() => fakes.length === 17, "a queued request takes the freed slot");
    assert.equal(lastFake().header.appId, "notes", "wren queued first but is at its share of 8, so notes goes");
});

test("64 live ids per app, then the relay refuses", async () => {
    holdOpen = true;
    const link = await connect("wren");
    for (let id = 1; id <= 65; id++) link.port.postMessage(fetchMessage(id));
    await until(() => find(link, "error", 65), "the 65th refused");
    assert.equal(find(link, "error", 64), undefined);
});

test("a gzip reply is decoded for the frame; an encoding the pult cannot decode is an error", async () => {
    const link = await connect("wren");
    link.port.postMessage(fetchMessage(1));
    const fake = await until(() => fakes[0], "the stream");
    const packed = gzipSync(Buffer.from("x".repeat(100_000)));
    fake.sink.head({ status: 200, headers: [["content-encoding", "gzip"], ["content-length", String(packed.length)], ["content-type", "text/plain"]] });
    fake.sink.data(packed);
    finishFake(fake);
    await until(() => find(link, "head", 1), "head");
    assert.deepEqual(find(link, "head", 1)?.["headers"], [["content-type", "text/plain"]]);
    let received = "";
    // zlib inflates on the thread pool: wait for the end in real time, crediting as the frame would
    for (const deadline = performance.now() + 5000; !find(link, "end", 1) && performance.now() < deadline;) {
        const data = link.inbox.filter((m) => m["t"] === "data");
        link.inbox.splice(0, link.inbox.length, ...link.inbox.filter((m) => m["t"] !== "data"));
        for (const m of data) {
            received += text(m["chunk"] as ArrayBuffer);
            link.port.postMessage({ t: "credit", id: 1, n: (m["chunk"] as ArrayBuffer).byteLength });
        }
        await settle();
    }
    assert.ok(find(link, "end", 1), "the reply ends");
    for (const m of link.inbox.filter((m) => m["t"] === "data")) received += text(m["chunk"] as ArrayBuffer);
    assert.equal(received.length, 100_000);

    link.port.postMessage(fetchMessage(2));
    const brotli = await until(() => fakes[1], "the second stream");
    brotli.sink.head({ status: 200, headers: [["content-encoding", "br"]] });
    await until(() => find(link, "error", 2), "error");
    assert.equal(brotli.reset, true);
});

test("an integrity fetch ends with the digests of what the frame received", async () => {
    const link = await connect("wren");
    link.port.postMessage(fetchMessage(1, { integrity: "sha256-AAAA sha512-BBBB?opt md5-CCCC" }));
    const fake = await until(() => fakes[0], "the stream");
    fake.sink.head({ status: 200, headers: [] });
    fake.sink.data(utf8.encode("alert(1)"));
    finishFake(fake);
    const end = await until(() => find(link, "end", 1), "end");
    const { createHash } = await import("node:crypto");
    assert.deepEqual(end["digests"], {
        sha256: createHash("sha256").update("alert(1)").digest("base64"),
        sha512: createHash("sha512").update("alert(1)").digest("base64"),
    });
});

test("a multipart form's final reply is held for the navigation that follows; a redirect goes straight to the frame", async () => {
    const link = await connect("wren");
    link.port.postMessage(fetchMessage(1, { method: "POST", path: "/upload", body: "stream", nav: true }));
    const fake = await until(() => fakes[0], "the stream");
    fake.sink.head({ status: 200, headers: [["content-type", "text/html"], ["set-cookie", "after=1"]] });
    fake.sink.data(utf8.encode("<p>saved</p>"));
    await settle();
    assert.equal(find(link, "head", 1), undefined, "nothing reaches the frame until the reply is whole");
    finishFake(fake);
    await until(() => find(link, "end", 1), "end");
    assert.equal(find(link, "data", 1), undefined, "the body stays in the pult");
    assert.equal(find(link, "head", 1)?.["status"], 200);
    const stashed = relay.takeStashed("wren", "/upload");
    assert.ok(stashed);
    assert.equal(text(stashed.body), "<p>saved</p>");
    assert.deepEqual(stashed.headers, [["content-type", "text/html"]]);
    assert.equal(relay.takeStashed("wren", "/upload"), null, "once only");

    link.port.postMessage(fetchMessage(2, { method: "POST", path: "/upload2", body: "stream", nav: true }));
    const moved = await until(() => fakes[1], "the second stream");
    moved.sink.head({ status: 303, headers: [["location", "/done"]] });
    await until(() => find(link, "head", 2), "a redirect head at once");
    assert.equal(relay.takeStashed("wren", "/upload2"), null);
});

test("document.cookie assignments reach the jar; a refused one is corrected by a snapshot", async () => {
    const link = await connect("wren");
    link.port.postMessage({ t: "cookie.set", line: "a=1", path: "/x/y" });
    const snapshot = await until(() => find(link, "cookies"), "a snapshot");
    assert.deepEqual(snapshot["list"], [{ n: "a", v: "1", p: "/x", e: null }]);
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["sid=s; HttpOnly; Path=/"], "http");
    link.inbox.length = 0;
    link.port.postMessage({ t: "cookie.set", line: "sid=forged; Path=/", path: "/" });
    const correction = await until(() => find(link, "cookies"), "a correcting snapshot");
    assert.deepEqual((correction["list"] as { n: string }[]).map((c) => c.n), ["a"]);
    assert.equal(cookies.cookieHeader({ gateway: channel.tag, appId: "wren", path: "/" }, "same"), "sid=s");
});

test("a document asks for the jar once welcomed, and hears it after its own queued assignments", async () => {
    const link = await connect("wren");
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["late=1"], "http");
    link.port.postMessage({ t: "cookie.set", line: "early=1", path: "/" });
    link.port.postMessage({ t: "cookies" });
    await until(() => link.inbox.filter((m) => m["t"] === "cookies").length === 2, "two snapshots");
    assert.deepEqual((link.inbox.at(-1)?.["list"] as { n: string }[]).map((c) => c.n), ["late", "early"]);
});

test("cookiesChanged pushes a snapshot to every document of that app only", async () => {
    const wren = await connect("wren");
    const files = await connect("files");
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["z=1"], "http");
    relay.cookiesChanged("wren");
    await until(() => find(wren, "cookies"), "wren's snapshot");
    await settle();
    assert.equal(find(files, "cookies"), undefined);
});

test("a forgotten device or a new gateway closes every session with a retry; forgetting also clears the jar", async () => {
    const link = await connect("wren");
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["a=1; Max-Age=60"], "http");
    for (const listener of listeners) listener({ state: "pairing_required" });
    const fatal = await until(() => find(link, "fatal"), "fatal");
    assert.equal(fatal["retry"], true);
    assert.deepEqual(cookies.scriptCookies(channel.tag, "wren"), []);
    assert.equal(storage.size, 0);

    const other = await connect("wren");
    channel.tag = "0102030405";
    for (const listener of listeners) listener({ state: "connecting" });
    await until(() => find(other, "fatal"), "fatal on a gateway change");
});

test("a document whose app moved to another agent pin is closed at its next message, and plants nothing in the jar", async () => {
    const link = await connect("files");
    moved.add("files");
    try {
        link.port.postMessage({ t: "cookie.set", line: "planted=1", path: "/" });
        const fatal = await until(() => find(link, "fatal"), "fatal");
        assert.equal(fatal["retry"], false);
        assert.deepEqual(cookies.scriptCookies(channel.tag, "files"), []);
        hello(link.frame.win, keyOf("files"), "mimiapp://files.a1b2c3d4e5.localhost", "n2", "d2");
        assert.equal(link.frame.posted.length, 1, "nor is it welcomed again on the old origin");
    } finally {
        moved.delete("files");
    }
});

test("16 documents per app: the oldest is told to retry", async () => {
    const first = await connect("wren");
    const outer = first.frame;
    for (let i = 0; i < 15; i++) {
        const nested = makeFrame(outer.win);
        hello(nested.win, keyOf("wren"), originOf("wren"));
        ports.push(nested.posted[0]?.transfer[0] as MessagePort);
    }
    await settle();
    assert.equal(find(first, "fatal"), undefined);
    const last = makeFrame(outer.win);
    hello(last.win, keyOf("wren"), originOf("wren"));
    ports.push(last.posted[0]?.transfer[0] as MessagePort);
    const fatal = await until(() => find(first, "fatal"), "the oldest evicted");
    assert.equal(fatal["retry"], true);
});

// ── WebSocket ───────────────────────────────────────────────────────────────
function serverFrame(opcode: number, payload: Uint8Array | string, masked = false): Uint8Array {
    const body = typeof payload === "string" ? utf8.encode(payload) : payload;
    assert.ok(body.length < 126);
    return Uint8Array.from([0x80 | opcode, (masked ? 0x80 : 0) | body.length, ...(masked ? [0, 0, 0, 0] : []), ...body]);
}
function readFrame(bytes: Uint8Array): { opcode: number; payload: Uint8Array } {
    const length = bytes[1]! & 0x7f;
    assert.ok(length < 126 && (bytes[1]! & 0x80) !== 0, "a short masked client frame");
    const mask = bytes.subarray(2, 6);
    return { opcode: bytes[0]! & 0x0f, payload: bytes.slice(6, 6 + length).map((b, i) => b ^ mask[i & 3]!) };
}
async function openSocket(link: Link, id: number, protocols: string[] = []): Promise<Fake> {
    const before = fakes.length;
    link.port.postMessage({ t: "ws", id, path: "/ws?room=1", protocols });
    return until(() => fakes.length > before && lastFake(), `the upgrade stream ${id}`);
}

test("the WebSocket handshake: the headers it sends, nothing before the 101, and a 101 that must prove itself", async () => {
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["sid=1"], "http");
    const link = await connect("wren");
    const fake = await openSocket(link, 1, ["chat", "json"]);
    const h = fake.header.headers;
    assert.equal(fake.header.method, "GET");
    assert.equal(fake.header.upgrade, true);
    assert.equal(h["upgrade"], "websocket");
    assert.equal(h["connection"], "Upgrade");
    assert.equal(h["sec-websocket-version"], "13");
    assert.equal(h["sec-websocket-protocol"], "chat, json");
    assert.equal(Buffer.from(h["sec-websocket-key"] ?? "", "base64").length, 16);
    assert.equal(h["origin"], originOf("wren"));
    assert.equal(h["cookie"], "sid=1");
    assert.equal(h["sec-websocket-extensions"], undefined);
    assert.deepEqual(fake.written, []);
    assert.equal(fake.ended, false, "nothing is written or ended before the head");

    fake.sink.head({ status: 101, headers: [["sec-websocket-accept", "wrong"]] });
    const closed = await until(() => find(link, "ws.closed", 1), "a refused handshake");
    assert.deepEqual({ ...closed }, { t: "ws.closed", id: 1, code: 1006, reason: "", clean: false });
    assert.equal(fake.reset, true);

    for (const [id, status, extra] of [[2, 403, []], [3, 101, [["sec-websocket-protocol", "other"]]], [4, 101, [["sec-websocket-extensions", "permessage-deflate"]]]] as const) {
        const next = await openSocket(link, id, ["chat"]);
        next.sink.head({ status, headers: [["sec-websocket-accept", wsAccept(next.header.headers["sec-websocket-key"] ?? "")], ...extra] });
        await until(() => find(link, "ws.closed", id), `refusal ${id}`);
    }
});

test("a WebSocket carries messages both ways, answers pings, and closes cleanly", async () => {
    const link = await connect("wren");
    const fake = await openSocket(link, 1, ["chat"]);
    fake.sink.head({ status: 101, headers: [["sec-websocket-accept", wsAccept(fake.header.headers["sec-websocket-key"] ?? "")], ["sec-websocket-protocol", "chat"], ["set-cookie", "ws=1"]] });
    const open = await until(() => find(link, "ws.open", 1), "open");
    assert.equal(open["protocol"], "chat");
    assert.deepEqual(cookies.scriptCookies(channel.tag, "wren").map((c) => c.n), ["ws"], "handshake cookies are kept");

    link.port.postMessage({ t: "ws.send", id: 1, text: "hello" });
    await until(() => find(link, "ws.sent", 1), "sent");
    assert.equal(find(link, "ws.sent", 1)?.["n"], 5);
    assert.equal(find(link, "credit", 1)?.["n"], 5);
    const sent = readFrame(fake.written[0] ?? new Uint8Array());
    assert.equal(sent.opcode, OP_TEXT);
    assert.equal(text(sent.payload), "hello");

    fake.sink.data(serverFrame(9, "are you there"));
    await until(() => fake.written.length === 2, "a pong");
    assert.deepEqual({ ...readFrame(fake.written[1] ?? new Uint8Array()), payload: text(readFrame(fake.written[1] ?? new Uint8Array()).payload) }, { opcode: 10, payload: "are you there" });

    fake.sink.data(Buffer.concat([serverFrame(1, "hi there"), serverFrame(2, Uint8Array.from([1, 2, 3]))]));
    await until(() => link.inbox.filter((m) => m["t"] === "ws.message").length === 2, "two messages");
    const [first, second] = link.inbox.filter((m) => m["t"] === "ws.message");
    assert.equal(first?.["text"], "hi there");
    assert.deepEqual([...new Uint8Array(second?.["bin"] as ArrayBuffer)], [1, 2, 3]);

    link.port.postMessage({ t: "ws.close", id: 1, code: 4000, reason: "done" });
    await until(() => fake.written.length === 3, "our close frame");
    const close = readFrame(fake.written[2] ?? new Uint8Array());
    assert.equal(close.opcode, 8);
    assert.equal(new DataView(close.payload.buffer).getUint16(0), 4000);
    assert.equal(fake.ended, false, "END waits for the server's close");
    fake.sink.data(serverFrame(8, Uint8Array.from([0x0f, 0xa0])));
    await until(() => fake.ended, "our END after the handshake");
    finishFake(fake);
    const closed = await until(() => find(link, "ws.closed", 1), "closed");
    assert.deepEqual({ ...closed }, { t: "ws.closed", id: 1, code: 4000, reason: "", clean: true });
});

test("a server close followed at once by a reset still reports clean, with the server's code", async () => {
    const link = await connect("wren");
    const fake = await openSocket(link, 1);
    fake.sink.head({ status: 101, headers: [["sec-websocket-accept", wsAccept(fake.header.headers["sec-websocket-key"] ?? "")]] });
    await until(() => find(link, "ws.open", 1), "open");
    fake.sink.data(serverFrame(8, Uint8Array.from([0x0f, 0xa1, ...utf8.encode("gone")])));
    await until(() => fake.ended, "the echo and our END");
    assert.equal(new DataView(readFrame(fake.written[0] ?? new Uint8Array()).payload.buffer).getUint16(0), 4001, "the echo repeats the server's code");
    fake.closed = true;
    fake.sink.fail(new Error("reset"));
    const closed = await until(() => find(link, "ws.closed", 1), "closed");
    assert.deepEqual({ ...closed }, { t: "ws.closed", id: 1, code: 4001, reason: "gone", clean: true });
});

test("a server that breaks the protocol fails the socket at once: close 1002 out, 1006 to the frame", async () => {
    const link = await connect("wren");
    const fake = await openSocket(link, 1);
    fake.sink.head({ status: 101, headers: [["sec-websocket-accept", wsAccept(fake.header.headers["sec-websocket-key"] ?? "")]] });
    await until(() => find(link, "ws.open", 1), "open");
    fake.sink.data(serverFrame(1, "masked", true));
    const closed = await until(() => find(link, "ws.closed", 1), "closed");
    assert.deepEqual({ ...closed }, { t: "ws.closed", id: 1, code: 1006, reason: "", clean: false });
    assert.equal(new DataView(readFrame(fake.written[0] ?? new Uint8Array()).payload.buffer).getUint16(0), 1002);
    assert.equal(fake.ended, true);
});

test("WebSocket sends wait while the channel window is shut, and a send past the frame's credit is fatal", async () => {
    const link = await connect("wren");
    const fake = await openSocket(link, 1);
    fake.sink.head({ status: 101, headers: [["sec-websocket-accept", wsAccept(fake.header.headers["sec-websocket-key"] ?? "")]] });
    await until(() => find(link, "ws.open", 1), "open");
    fake.writable = false;
    const big = new ArrayBuffer(100 * 1024);
    link.port.postMessage({ t: "ws.send", id: 1, bin: big }, [big]);
    await until(() => fake.written.length === 1, "the first slice");
    await settle();
    assert.equal(fake.written.length, 1, "no more slices while the window is shut");
    assert.equal(find(link, "ws.sent", 1), undefined);
    fake.writable = true;
    fake.drain?.();
    await until(() => find(link, "ws.sent", 1), "the whole message out");
    assert.equal(Buffer.concat(fake.written).length, 100 * 1024 + 14);
    const window = new ArrayBuffer(200 * 1024);
    fake.writable = false;
    link.port.postMessage({ t: "ws.send", id: 1, bin: window }, [window]);
    const more = new ArrayBuffer(100 * 1024);
    link.port.postMessage({ t: "ws.send", id: 1, bin: more }, [more]);
    await until(() => find(link, "fatal"), "fatal past the credit");
});

test("closing a document sends close 1001 on its open sockets and ends them without waiting", async () => {
    const link = await connect("wren");
    const fake = await openSocket(link, 1);
    fake.sink.head({ status: 101, headers: [["sec-websocket-accept", wsAccept(fake.header.headers["sec-websocket-key"] ?? "")]] });
    await until(() => find(link, "ws.open", 1), "open");
    link.port.postMessage({ t: "bye" });
    await until(() => fake.ended, "END");
    assert.equal(new DataView(readFrame(fake.written[0] ?? new Uint8Array()).payload.buffer).getUint16(0), 1001);
    mock.timers.tick(5_000);
    assert.equal(fake.reset, true, "reset if the server never finishes");
});

test("a socket still queued after 30 s is closed abnormally", async () => {
    const link = await connect("notes");
    for (let id = 1; id <= 8; id++) await openSocket(link, id);
    link.port.postMessage({ t: "ws", id: 9, path: "/late", protocols: [] });
    await settle();
    mock.timers.tick(30_000);
    const closed = await until(() => find(link, "ws.closed", 9), "the queued socket closed");
    assert.equal(closed["code"], 1006);
});

// ── pult-core's calls ───────────────────────────────────────────────────────
test("redirectStep follows Fetch: 301/302 turn POST into GET, 303 turns anything but GET/HEAD into GET, 307/308 keep both", () => {
    assert.equal(redirectStep(200, "GET"), null);
    assert.equal(redirectStep(304, "GET"), null);
    assert.deepEqual(redirectStep(301, "POST"), { method: "GET", body: false });
    assert.deepEqual(redirectStep(302, "POST"), { method: "GET", body: false });
    assert.deepEqual(redirectStep(302, "PUT"), { method: "PUT", body: true });
    assert.deepEqual(redirectStep(303, "PUT"), { method: "GET", body: false });
    assert.deepEqual(redirectStep(303, "HEAD"), { method: "HEAD", body: true });
    assert.deepEqual(redirectStep(307, "POST"), { method: "POST", body: true });
    assert.deepEqual(redirectStep(308, "DELETE"), { method: "DELETE", body: true });
});

test("the assembled bridge script compiles, and its spliced rules name nothing outside themselves", () => {
    const source = text(relay.bridgeScript());
    assert.ok(source.startsWith("// @ts-check"));
    new vm.Script(source);
    const raw = readFileSync(new URL("../src/mini-app-bridge.js", import.meta.url), "utf8").trimEnd();
    assert.ok(source.startsWith(raw), "the source goes out as written");
    const call = source.slice(raw.length).trim();
    assert.ok(call.startsWith("(") && call.endsWith(");"));
    const [parse, match, step, limits] = vm.runInContext(`[${call.slice(1, -2)}]`, vm.createContext({})) as
        [typeof cookies.parseCookieLine, typeof cookies.matchCookies, typeof redirectStep, Record<string, number>];
    // results from the bare context have its own Object prototype: compare them as JSON
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(parse("a=b; Max-Age=10", "/x/y", 0)), { n: "a", v: "b", p: "/x", e: 10_000, h: false, s: false, ss: "lax" });
    assert.deepEqual(plain(parse("a=b; Expires=Wed, 21 Oct 2015 07:28:00 GMT", "/", Date.UTC(2015, 9, 1))), { n: "a", v: "b", p: "/", e: Date.UTC(2015, 9, 21, 7, 28), h: false, s: false, ss: "lax" });
    assert.deepEqual(plain(match([{ n: "b", v: "1", p: "/", e: null }, { n: "a", v: "2", p: "/x", e: null }], "/x/y", 0).map((c) => c.n)), ["a", "b"]);
    assert.deepEqual(plain(step(303, "POST")), { method: "GET", body: false });
    assert.deepEqual(plain(limits), { window: 256 * 1024, keepalive: 64 * 1024, upload: 64 * 1024 * 1024 });
});

const inject = (html: string, csp = "", appId = "wren"): string => text(relay.injectBridge(utf8.encode(html), { appId, csp, path: "/" }));
const TAG = /<script src="mimiapp:\/\/wren\.a1b2c3d4e5\.localhost\/__mimi__\/bridge\.js" data-mimi="[^"]*"( nonce="[^"]*")?><\/script>/;
const at = (html: string, csp = ""): string => inject(html, csp).replace(TAG, "@");

test("the bridge tag goes first into the head, after a charset meta that must stay in the first 1024 bytes", () => {
    assert.equal(at("<!doctype html><html><head><title>x</title></head>"), "<!doctype html><html><head>@<title>x</title></head>");
    assert.equal(at("<HTML><HEAD lang=en><meta charset=\"utf-8\"><title>t</title>"), "<HTML><HEAD lang=en><meta charset=\"utf-8\">@<title>t</title>");
    assert.equal(at("<head><title>t</title><meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\">"), "<head><title>t</title><meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\">@");
    assert.equal(at("<head><script>early()</script><meta charset=utf-8>"), "<head>@<script>early()</script><meta charset=utf-8>", "never after an app script");
    assert.equal(at(`<head><meta name=x content="${"y".repeat(1100)}"><meta charset=utf-8>`).indexOf("@"), 6, "a charset meta past 1024 bytes is not waited for");
    assert.equal(at("<!-- <head> --><html><header></header><head>"), "<!-- <head> --><html><header></header><head>@");
    assert.equal(at("<!DOCTYPE html><html lang=en><body>x"), "<!DOCTYPE html><html lang=en>@<body>x");
    assert.equal(at("<!doctype html><p>x"), "<!doctype html>@<p>x");
    assert.equal(at("<script>first()</script><head>"), "@<script>first()</script><head>");
    assert.equal(at("<p>x"), "@<p>x");
    assert.equal(at("﻿<p>x"), "﻿@<p>x", "after a UTF-8 BOM");
    assert.equal(at("<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title/></head>"), "<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head>@<title/></head>");
    const utf16 = Uint8Array.from([0xff, 0xfe, 0x3c, 0x00]);
    assert.equal(relay.injectBridge(utf16, { appId: "wren", csp: "", path: "/" }), utf16, "a UTF-16 page is left alone");
});

test("the boot data is ASCII-only JSON with the key, the pult, the app origin and the scripts' cookies", () => {
    cookies.storeCookies({ gateway: channel.tag, appId: "wren", path: "/" }, ["sid=s; HttpOnly", "price=5€", "q=\"</script>&"], "http");
    const html = inject("<head>");
    assert.ok(/^[\x00-\x7f]*$/.test(html));
    const boot = bootOf(utf8.encode(html));
    assert.equal(boot.v, 1);
    assert.match(boot.key, /^[0-9a-f]{32}$/);
    assert.equal(boot.key, keyOf("wren"), "one key per gateway and app");
    assert.notEqual(boot.key, keyOf("files"));
    assert.match(boot.doc, /^[0-9a-f]{32}$/);
    assert.equal(boot.pult, "tauri://localhost");
    assert.equal(boot.origin, originOf("wren"));
    assert.deepEqual(boot.cookies.map((c) => [c.n, c.v]), [["price", "5€"], ["q", "\"</script>&"]]);
});

test("the app's CSP decides the nonce, and a page that forbids the bridge is logged once and left to run without it", () => {
    const warn = mock.method(console, "warn", () => undefined);
    assert.doesNotMatch(inject("<head>", "default-src 'self'"), /nonce=/);
    assert.doesNotMatch(inject("<head>", "script-src mimiapp:; img-src *"), /nonce=/);
    assert.match(inject("<head>", "script-src 'nonce-abc123' 'strict-dynamic'"), / nonce="abc123"/);
    assert.match(inject("<head>", "default-src 'none'; script-src-elem 'nonce-k1' 'nonce-k2', script-src 'nonce-k2'"), / nonce="k2"/);
    assert.match(inject("<head>", "script-src 'self'; script-src-elem 'nonce-n'"), / nonce="n"/, "script-src-elem wins over script-src");
    const lines = (): string[] => warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.deepEqual(lines(), []);
    assert.match(inject("<head>", "script-src 'sha256-abc'", "strict"), /<head><script src=/, "a blocked tag is still inserted, fail open");
    inject("<head>", "script-src 'nonce-a', script-src 'nonce-b'", "strict");
    assert.deepEqual(lines(), ["mimi-app: strict forbids the bridge script (script-src); streaming, WebSocket and document.cookie are off"], "one line per app");
    const quiet = bootFor("quiet");
    const said = bootFor("said");
    const frame = makeFrame();
    unregister.push(relay.registerFrame(frame.el, "said"));
    launched.add("said");
    hello(frame.win, said.key, originOf("said"), "n", said.doc);
    ports.push(frame.posted[0]?.transfer[0] as MessagePort);
    mock.timers.tick(10_000);
    assert.ok(lines().some((line) => line.startsWith("mimi-app: quiet forbids")), "an injected page that never said hello is logged too");
    assert.ok(!lines().some((line) => line.startsWith("mimi-app: said")), "a page that said hello is not");
    assert.equal(quiet.v, 1);
    launched.delete("said");
    warn.mock.restore();
});
