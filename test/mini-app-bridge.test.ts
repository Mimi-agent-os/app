// bridge.js as bridgeScript() assembles it, in a node:vm context with a fake window and document; the test plays the pult over a real MessageChannel.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import vm from "node:vm";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.includes("/src/mini-app-")) {
            return { url: `data:text/javascript,${encodeURIComponent("export const openStream = () => {}; export const gatewayTag = () => \"\"; export const subscribe = () => () => {};")}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (!url.endsWith("?raw")) return nextLoad(url, context);
        return { format: "module", source: `export default ${JSON.stringify(readFileSync(new URL(url.slice(0, -4)), "utf8"))};`, shortCircuit: true };
    },
});
mock.timers.enable({ apis: ["setTimeout"] });
const { bridgeScript } = await import("../src/mini-app-relay.ts");
const SOURCE = new TextDecoder().decode(bridgeScript());

const HOST = "wren.a1b2c3d4e5.localhost";
const ORIGIN = `mimiapp://${HOST}`;
const utf8 = new TextEncoder();
const text = (bytes: ArrayBuffer | Uint8Array): string => new TextDecoder().decode(bytes);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
    for (let i = 0; i < 500; i++) {
        const value = read();
        if (value) return value;
        await settle();
    }
    throw new Error(`timed out waiting for ${what}`);
}

type Message = Record<string, unknown> & { t: string; id: number };

interface Page {
    ctx: vm.Context;
    run: <T = unknown>(code: string) => T;
    hellos: { message: { mimi: string; v: number; key: string; nonce: string; doc: string }; origin: string }[];
    inbox: Message[];
    pult: MessagePort | null;
    natives: { fetch: unknown[][]; ws: unknown[][]; es: unknown[][]; beacon: unknown[][]; xhr: unknown[][]; submits: number; assigned: string[] };
    attributes: Record<string, string>;
    welcome: () => Promise<void>;
    next: (t: string, test?: (m: Message) => boolean) => Promise<Message>;
    post: (message: object, transfer?: Transferable[]) => void;
    answer: (id: number, status: number, headers?: [string, string][], chunks?: string[], end?: boolean) => void;
    dispatch: (type: string, extra?: object) => void;
}

const pages: Page[] = [];
test.afterEach(() => {
    for (const page of pages.splice(0)) page.pult?.close();
});

/** A fresh document with the bridge installed, as the pult injects it. */
function open(cookies: { n: string; v: string; p: string; e: number | null }[] = []): Page {
    const natives: Page["natives"] = { fetch: [], ws: [], es: [], beacon: [], xhr: [], submits: 0, assigned: [] };
    const hellos: Page["hellos"] = [];
    const top = { postMessage: (message: Page["hellos"][number]["message"], origin: string) => hellos.push({ message, origin }) };
    const events = new EventTarget();
    class Document {}
    Object.defineProperty(Document.prototype, "cookie", { configurable: true, get: () => "native-jar", set: () => undefined });
    const attributes: Record<string, string> = { "data-mimi": JSON.stringify({ v: 1, key: "a".repeat(32), doc: "doc-1", pult: "tauri://localhost", origin: ORIGIN, cookies }) };
    const document = Object.assign(Object.create(Document.prototype) as object, {
        currentScript: { getAttribute: (name: string) => attributes[name] ?? null, removeAttribute: (name: string) => delete attributes[name] },
        baseURI: `${ORIGIN}/app/page`,
        URL: `${ORIGIN}/app/page?q=1#top`,
    });
    class XMLHttpRequest extends EventTarget {}
    Object.assign(XMLHttpRequest.prototype, {
        open(this: XMLHttpRequest, ...args: unknown[]) { natives.xhr.push(["open", ...args]); },
        send(this: XMLHttpRequest, body: unknown) { natives.xhr.push(["send", body]); },
        setRequestHeader(this: XMLHttpRequest, name: string, value: string) { natives.xhr.push(["header", name, value]); },
    });
    class HTMLFormElement extends EventTarget {
        method = "get";
        enctype = "application/x-www-form-urlencoded";
        target = "";
        action = `${ORIGIN}/app/page`;
        fields: [string, string | File][] = [];
        get [Symbol.toStringTag](): string { return "HTMLFormElement"; }
    }
    Object.assign(HTMLFormElement.prototype, { submit() { natives.submits += 1; } });
    class PageFormData extends FormData {
        constructor(form?: HTMLFormElement) {
            super();
            for (const [name, value] of form?.fields ?? []) this.append(name, value);
        }
    }
    class NativeWebSocket { constructor(...args: unknown[]) { natives.ws.push(args); } }
    class NativeEventSource { constructor(...args: unknown[]) { natives.es.push(args); } }
    class ProgressEvent extends Event {}
    const sandbox = {
        document, Document, top, XMLHttpRequest, HTMLFormElement, FormData: PageFormData, ProgressEvent,
        WebSocket: NativeWebSocket, EventSource: NativeEventSource,
        fetch: (...args: unknown[]) => {
            natives.fetch.push(args);
            return Promise.resolve(new Response("native"));
        },
        location: { protocol: "mimiapp:", host: HOST, pathname: "/app/page", assign: (url: string) => natives.assigned.push(url) },
        navigator: { userAgent: "test", sendBeacon: (...args: unknown[]) => (natives.beacon.push(args), true) },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        ReadableStream, Response, Request, Headers, Blob, File, URL, URLSearchParams, TextEncoder, TextDecoder, MessageChannel, EventTarget, Event,
        MessageEvent, CloseEvent, DOMException, AbortController, AbortSignal, crypto, console, setTimeout, clearTimeout, queueMicrotask,
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext("globalThis.window = globalThis;", ctx);
    vm.runInContext(SOURCE, ctx);
    const inbox: Message[] = [];
    const page: Page = {
        ctx, hellos, inbox, natives, attributes, pult: null,
        run: <T,>(code: string) => vm.runInContext(code, ctx) as T,
        async welcome() {
            mock.timers.tick(0);
            const hello = hellos.at(-1);
            assert.ok(hello, "a hello went out");
            const channel = new MessageChannel();
            page.dispatch("message", { data: { mimi: "welcome", v: 1, nonce: hello.message.nonce }, source: top, ports: [channel.port2], origin: "tauri://localhost" });
            channel.port1.onmessage = (e: MessageEvent) => inbox.push(e.data as Message);
            page.pult = channel.port1;
            await settle();
        },
        next: (t, check = () => true) => until(() => inbox.find((m) => m.t === t && check(m)), t),
        post: (message, transfer = []) => page.pult?.postMessage(message, transfer),
        answer(id, status, headers = [], chunks = [], end = true) {
            page.post({ t: "head", id, status, headers });
            for (const chunk of chunks) {
                const bytes = utf8.encode(chunk).buffer;
                page.post({ t: "data", id, chunk: bytes }, [bytes]);
            }
            if (end) page.post({ t: "end", id });
        },
        dispatch(type, extra = {}) {
            const event = new Event(type, { cancelable: true });
            // own properties shadow Event's getters, target included
            for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
            events.dispatchEvent(event);
        },
    };
    pages.push(page);
    return page;
}

async function ready(cookies?: Parameters<typeof open>[0]): Promise<Page> {
    const page = open(cookies);
    await page.welcome();
    return page;
}

/** The request body the bridge streams for one id, crediting it as the pult would. */
async function upload(page: Page, id: number): Promise<Uint8Array> {
    page.post({ t: "credit", id, n: 256 * 1024 });
    await page.next("end", (m) => m.id === id);
    return Buffer.concat(page.inbox.filter((m) => m.t === "body" && m.id === id).map((m) => new Uint8Array(m["chunk"] as ArrayBuffer)));
}

// ── install and handshake ───────────────────────────────────────────────────
test("the bridge installs itself, hides its boot data and greets the pult with its key", async () => {
    const page = open();
    assert.equal(page.attributes["data-mimi"], undefined, "the boot attribute is removed");
    assert.equal(page.run("window[Symbol.for('mimi.bridge')]"), 1);
    assert.equal(page.run("Object.keys(window).includes(Symbol.for('mimi.bridge').toString())"), false);
    assert.equal(page.run("typeof fetch === 'function' && fetch.name"), "mimiFetch");
    mock.timers.tick(0);
    assert.equal(page.hellos.length, 1);
    const [hello] = page.hellos;
    assert.equal(hello?.origin, "tauri://localhost");
    assert.equal(hello?.message.mimi, "hello");
    assert.equal(hello?.message.key, "a".repeat(32));
    assert.equal(hello?.message.doc, "doc-1");
    assert.match(hello?.message.nonce ?? "", /^[0-9a-f]{32}$/);
});

test("hellos go out at 0, 50, 250, 1000 and 3000 ms; waiting calls then go native, and a late welcome brings the bridge back", async () => {
    const page = open();
    const early = page.run<Promise<Response>>("fetch('/api/early')");
    for (const [step, count] of [[0, 1], [50, 2], [200, 3], [750, 4], [2000, 5]] as const) {
        mock.timers.tick(step);
        assert.equal(page.hellos.length, count, `after ${step} more ms`);
    }
    mock.timers.tick(999);
    await settle();
    assert.equal(page.natives.fetch.length, 0, "still waiting at 3999 ms");
    mock.timers.tick(1);
    assert.equal(await (await early).text(), "native", "gave up at 4000 ms: the waiting fetch went native, buffered through the scheme");
    mock.timers.tick(4000);
    assert.equal(page.hellos.length, 6, "and keeps greeting every 5 s");
    await page.run<Promise<Response>>("fetch('/api/native')");
    assert.equal(page.natives.fetch.length, 2);
    const channel = new MessageChannel();
    const nonce = page.hellos.at(-1)?.message.nonce;
    page.dispatch("message", { data: { mimi: "welcome", v: 1, nonce: "stale" }, source: page.run("top"), ports: [channel.port2] });
    await settle();
    page.run("fetch('/api/late')");
    await settle();
    assert.equal(page.natives.fetch.length, 3, "a welcome for another nonce is ignored");
    const fresh = new MessageChannel();
    page.dispatch("message", { data: { mimi: "welcome", v: 1, nonce }, source: page.run("top"), ports: [fresh.port2] });
    fresh.port1.onmessage = (e: MessageEvent) => page.inbox.push(e.data as Message);
    page.pult = fresh.port1;
    channel.port1.close();
    page.run("fetch('/api/bridged')");
    const bridged = await page.next("fetch");
    assert.equal(bridged["path"], "/api/bridged");
});

test("a welcome is swallowed before the app's own message listeners see it", async () => {
    const page = open();
    page.run("globalThis.seen = []; addEventListener('message', (e) => seen.push(e.data))");
    await page.welcome();
    assert.equal(page.run("seen.length"), 0);
});

// ── fetch ───────────────────────────────────────────────────────────────────
test("a same-origin fetch streams: a real Response at the head, a body that grows chunk by chunk, credit as it is read", async () => {
    const page = await ready();
    const pending = page.run<Promise<Response>>("fetch('/api/feed?x=1', { headers: { 'x-app': '1' } })");
    const request = await page.next("fetch");
    assert.equal(request["kind"], "fetch");
    assert.equal(request["method"], "GET");
    assert.equal(request["path"], "/api/feed?x=1");
    assert.equal(request["body"], "none");
    assert.equal(request["credentials"], "include");
    assert.deepEqual(request["headers"], [["x-app", "1"], ["accept", "*/*"], ["referer", `${ORIGIN}/app/page?q=1`]]);
    page.answer(request.id, 200, [["content-type", "text/plain"], ["x-many", "1"], ["x-many", "2"], ["bad\nname", "x"]], [], false);
    const res = await pending;
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    assert.equal(res.statusText, "");
    assert.equal(res.url, `${ORIGIN}/api/feed?x=1`);
    assert.equal(res.redirected, false);
    assert.equal(res.type, "basic");
    assert.equal(res.headers.get("x-many"), "1, 2");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    page.post({ t: "data", id: request.id, chunk: utf8.encode("one").buffer });
    assert.equal(text((await reader.read()).value ?? new Uint8Array()), "one");
    await page.next("credit", (m) => m.id === request.id);
    page.post({ t: "data", id: request.id, chunk: utf8.encode("two").buffer });
    assert.equal(text((await reader.read()).value ?? new Uint8Array()), "two");
    page.post({ t: "end", id: request.id });
    assert.equal((await reader.read()).done, true);
    await until(() => page.inbox.filter((m) => m.t === "credit").reduce((n, m) => n + (m["n"] as number), 0) === 6, "every byte read credited back");
});

test("clone keeps what the bridge knows; a 204 has a null body; a status the web cannot express is a network error", async () => {
    const page = await ready();
    const pending = page.run<Promise<Response>>("fetch('/a')");
    const first = await page.next("fetch");
    page.answer(first.id, 200, [], ["x"]);
    const copy = (await pending).clone();
    assert.equal(copy.url, `${ORIGIN}/a`);
    assert.equal(await copy.text(), "x");
    const empty = page.run<Promise<Response>>("fetch('/b', { method: 'DELETE' })");
    const second = await page.next("fetch", (m) => m.id !== first.id);
    page.answer(second.id, 204);
    assert.equal((await empty).body, null);
    const odd = page.run<Promise<Response>>("fetch('/c')");
    const third = await page.next("fetch", (m) => m.id > second.id);
    page.answer(third.id, 199);
    await assert.rejects(odd, { name: "TypeError" });
});

test("a request body goes out under credit: string, URLSearchParams, Blob and a stream, with the type Fetch gives each", async () => {
    const page = await ready();
    const cases: [string, string, string | undefined][] = [
        ["'hello'", "hello", "text/plain;charset=UTF-8"],
        ["new URLSearchParams({ a: '1', b: 'x y' })", "a=1&b=x+y", "application/x-www-form-urlencoded;charset=UTF-8"],
        ["new Blob(['blob'], { type: 'application/x-test' })", "blob", "application/x-test"],
        ["new Uint8Array([104, 105])", "hi", undefined],
        ["new ReadableStream({ start(c) { c.enqueue(new Uint8Array([115])); c.enqueue(new Uint8Array([116])); c.close(); } })", "st", undefined],
    ];
    let last = 0;
    for (const [body, expected, type] of cases) {
        void page.run(`fetch('/up', { method: 'POST', body: ${body}, duplex: 'half' })`);
        const request = await page.next("fetch", (m) => m.id > last);
        last = request.id;
        assert.equal(request["body"], "stream");
        assert.equal(request["length"], body.startsWith("new ReadableStream") ? undefined : expected.length, body);
        assert.equal((request["headers"] as [string, string][]).find(([n]) => n === "content-type")?.[1], type, body);
        assert.equal(page.inbox.some((m) => m.t === "body" && m.id === request.id), false, "nothing before the pult's credit");
        assert.equal(text(await upload(page, request.id)), expected, body);
    }
    await assert.rejects(page.run<Promise<Response>>("fetch('/x', { body: 'x' })"), { name: "TypeError" }, "a GET cannot carry a body");
});

test("a large upload never runs past its credit", async () => {
    const page = await ready();
    void page.run("fetch('/big', { method: 'PUT', body: new Blob([new Uint8Array(1024 * 1024)]) })");
    const request = await page.next("fetch");
    page.post({ t: "credit", id: request.id, n: 256 * 1024 });
    await until(() => page.inbox.filter((m) => m.t === "body").length === 4, "one window of slices");
    await settle();
    await settle();
    assert.equal(page.inbox.filter((m) => m.t === "body").length, 4, "the bridge waits for more credit");
    page.post({ t: "credit", id: request.id, n: 768 * 1024 });
    await page.next("end", (m) => m.id === request.id);
    assert.equal(page.inbox.filter((m) => m.t === "body").reduce((n, m) => n + (m["chunk"] as ArrayBuffer).byteLength, 0), 1024 * 1024);
});

test("FormData goes out as the multipart bytes a browser sends", async () => {
    const page = await ready();
    void page.run(`(() => {
        const form = new FormData();
        form.append('note', 'line one\\nline two');
        form.append('we"ird\\r\\nname', 'v');
        form.append('file', new File(['file body'], 'a "b".txt', { type: 'text/plain' }));
        form.append('raw', new File([new Uint8Array([0, 255])], 'raw.bin'));
        return fetch('/form', { method: 'POST', body: form });
    })()`);
    const request = await page.next("fetch");
    const type = (request["headers"] as [string, string][]).find(([n]) => n === "content-type")?.[1] ?? "";
    const boundary = /^multipart\/form-data; boundary=(----WebKitFormBoundary[A-Za-z0-9]{16})$/.exec(type)?.[1];
    assert.ok(boundary, type);
    const expected = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nline one\r\nline two\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="we%22ird%0D%0Aname"\r\n\r\nv\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a %22b%22.txt"\r\nContent-Type: text/plain\r\n\r\nfile body\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="raw"; filename="raw.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.from([0, 255]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    assert.equal(request["length"], expected.length);
    assert.ok(Buffer.from(await upload(page, request.id)).equals(expected));
});

test("redirects follow Fetch: POST becomes GET on 302, a 307 replays the body, manual is opaque, error fails", async () => {
    const page = await ready();
    const moved = page.run<Promise<Response>>("fetch('/a', { method: 'POST', body: 'x', headers: { 'content-language': 'en' } })");
    const first = await page.next("fetch");
    await upload(page, first.id);
    page.answer(first.id, 302, [["location", "/b?y"]], [], false);
    const second = await page.next("fetch", (m) => m.id > first.id);
    assert.equal(second["method"], "GET");
    assert.equal(second["body"], "none");
    assert.deepEqual((second["headers"] as [string, string][]).map(([n]) => n), ["accept", "referer"], "the body headers go with the body");
    await page.next("cancel", (m) => m.id === first.id);
    page.answer(second.id, 200, [], ["done"]);
    const res = await moved;
    assert.equal(res.url, `${ORIGIN}/b?y`);
    assert.equal(res.redirected, true);

    const replay = page.run<Promise<Response>>("fetch('/c', { method: 'PUT', body: 'again' })");
    const third = await page.next("fetch", (m) => m.id > second.id);
    await upload(page, third.id);
    page.answer(third.id, 307, [["location", "/d"]]);
    const fourth = await page.next("fetch", (m) => m.id > third.id);
    assert.equal(fourth["method"], "PUT");
    assert.equal(text(await upload(page, fourth.id)), "again");
    page.answer(fourth.id, 201);
    assert.equal((await replay).status, 201);

    const streamed = page.run<Promise<Response>>("fetch('/e', { method: 'POST', body: new ReadableStream({ start(c) { c.close(); } }), duplex: 'half' })");
    const fifth = await page.next("fetch", (m) => m.id > fourth.id);
    await upload(page, fifth.id);
    page.answer(fifth.id, 308, [["location", "/f"]]);
    await assert.rejects(streamed, { name: "TypeError" }, "a stream body cannot be sent twice");

    const manual = page.run<Promise<Response>>("fetch('/g', { redirect: 'manual' })");
    const sixth = await page.next("fetch", (m) => m.id > fifth.id);
    page.answer(sixth.id, 301, [["location", "/h"]]);
    const opaque = await manual;
    assert.deepEqual([opaque.type, opaque.status, opaque.ok, [...opaque.headers], opaque.body], ["opaqueredirect", 0, false, [], null]);

    const refused = page.run<Promise<Response>>("fetch('/i', { redirect: 'error' })");
    const seventh = await page.next("fetch", (m) => m.id > sixth.id);
    page.answer(seventh.id, 302, [["location", "/j"]]);
    await assert.rejects(refused, { name: "TypeError" });
});

test("a redirect off the app goes native without Authorization; one to another mini-app fails", async () => {
    const page = await ready();
    const away = page.run<Promise<Response>>("fetch('/login', { headers: { authorization: 'Bearer t', 'x-keep': '1' } })");
    const first = await page.next("fetch");
    page.answer(first.id, 302, [["location", "https://auth.example.com/start"]]);
    assert.equal(await (await away).text(), "native");
    const [url, init] = page.natives.fetch[0] as [string, { method: string; headers: [string, string][] }];
    assert.equal(url, "https://auth.example.com/start");
    assert.equal(init.method, "GET");
    assert.deepEqual(Array.from(init.headers, ([n]) => n), ["x-keep", "accept"]);

    const sideways = page.run<Promise<Response>>("fetch('/other')");
    const second = await page.next("fetch", (m) => m.id > first.id);
    page.answer(second.id, 302, [["location", "mimiapp://files.a1b2c3d4e5.localhost/"]]);
    await assert.rejects(sideways, { name: "TypeError" });
});

test("only this app's own origin is bridged; everything else is the engine's fetch", async () => {
    const page = await ready();
    await page.run<Promise<Response>>("fetch('https://api.example.com/x')");
    await page.run<Promise<Response>>("fetch('mimiapp://files.a1b2c3d4e5.localhost/x')");
    assert.equal(page.natives.fetch.length, 2);
    void page.run(`fetch(new URL('mimiapp://${HOST}/abs'))`);
    assert.equal((await page.next("fetch"))["path"], "/abs");
});

test("a Request input keeps its method, headers and body", async () => {
    const page = await ready();
    void page.run(`fetch(new Request('${ORIGIN}/req', { method: 'PATCH', headers: { 'x-r': '1' }, body: 'patch' }))`);
    const request = await page.next("fetch");
    assert.equal(request["method"], "PATCH");
    assert.ok((request["headers"] as [string, string][]).some(([n, v]) => n === "x-r" && v === "1"));
    assert.equal(text(await upload(page, request.id)), "patch");
});

test("abort rejects with the signal's reason and cancels the stream, before the head or during the body", async () => {
    const page = await ready();
    const pending = page.run<Promise<Response>>("globalThis.c1 = new AbortController(); fetch('/slow', { signal: c1.signal })");
    const request = await page.next("fetch");
    page.run("c1.abort()");
    await assert.rejects(pending, { name: "AbortError" });
    await page.next("cancel", (m) => m.id === request.id);

    const streaming = page.run<Promise<Response>>("globalThis.c2 = new AbortController(); fetch('/stream', { signal: c2.signal })");
    const second = await page.next("fetch", (m) => m.id > request.id);
    page.answer(second.id, 200, [], ["a"], false);
    const res = await streaming;
    page.run("c2.abort()");
    await assert.rejects(res.text(), { name: "AbortError" });
    await page.next("cancel", (m) => m.id === second.id);
});

test("credentials: omit, keepalive's inline body and its 64 KiB budget", async () => {
    const page = await ready();
    void page.run("fetch('/anon', { credentials: 'omit' })");
    assert.equal((await page.next("fetch"))["credentials"], "omit");
    void page.run("fetch('/k1', { method: 'POST', body: 'x'.repeat(40000), keepalive: true })");
    const kept = await page.next("fetch", (m) => m["keepalive"] === true);
    assert.equal(kept["body"], "inline");
    assert.equal((kept["chunk"] as ArrayBuffer).byteLength, 40000);
    await assert.rejects(page.run<Promise<Response>>("fetch('/k2', { method: 'POST', body: 'y'.repeat(40000), keepalive: true })"), { name: "TypeError" });
    page.answer(kept.id, 204);
    await settle();
    void page.run("fetch('/k3', { method: 'POST', body: 'z'.repeat(40000), keepalive: true })");
    await page.next("fetch", (m) => m["path"] === "/k3");
});

test("integrity: the pult's digest must match the strongest algorithm the metadata names", async () => {
    const page = await ready();
    const body = "alert(1)";
    const sha256 = createHash("sha256").update(body).digest("base64");
    const sha384 = createHash("sha384").update(body).digest("base64");
    const good = page.run<Promise<Response>>(`fetch('/lib.js', { integrity: 'sha256-wrong sha384-${sha384}' })`);
    const first = await page.next("fetch");
    assert.equal(first["integrity"], `sha256-wrong sha384-${sha384}`);
    page.answer(first.id, 200, [], [body], false);
    page.post({ t: "end", id: first.id, digests: { sha256, sha384 } });
    assert.equal(await (await good).text(), body);

    const bad = page.run<Promise<Response>>(`fetch('/lib2.js', { integrity: 'sha256-${sha384}' })`);
    const second = await page.next("fetch", (m) => m.id > first.id);
    page.answer(second.id, 200, [], [body], false);
    page.post({ t: "end", id: second.id, digests: { sha256 } });
    await assert.rejects(bad, { name: "TypeError" });
});

// ── EventSource ─────────────────────────────────────────────────────────────
test("EventSource parses the stream per HTML: split CRLF, a BOM, named events, ids, retry and comments", async () => {
    const page = await ready();
    page.run(`globalThis.log = []; globalThis.es = new EventSource('/events');
        es.onopen = () => log.push(['open', es.readyState]);
        es.onmessage = (e) => log.push(['message', e.data, e.lastEventId, e.origin]);
        es.addEventListener('tick', (e) => log.push(['tick', e.data]));
        es.onerror = () => log.push(['error', es.readyState]);`);
    assert.equal(page.run("es.readyState"), 0);
    assert.equal(page.run("es.url"), `${ORIGIN}/events`);
    assert.equal(page.run("EventSource.CLOSED + es.OPEN"), 3);
    const request = await page.next("fetch");
    assert.equal(request["kind"], "sse");
    assert.deepEqual(request["headers"], [["accept", "text/event-stream"], ["cache-control", "no-cache"]]);
    page.answer(request.id, 200, [["content-type", "Text/Event-Stream; charset=utf-8"]], [
        "﻿data: a\r", "\ndata:b\r\n\r", "\n: a comment\nid: 7\nevent: tick\ndata: t\n\n",
        "id: bad\u0000id\ndata: keeps 7\n\nretry: 50\nretry: 5x\nunknown: x\ndata\n\n",
        "data: never dispatched",
    ], false);
    await until(() => page.run<number>("log.length") >= 5, "five events");
    assert.deepEqual(JSON.parse(page.run("JSON.stringify(log)")), [
        ["open", 1],
        ["message", "a\nb", "", ORIGIN],
        ["tick", "t"],
        ["message", "keeps 7", "7", ORIGIN],
        ["message", "", "7", ORIGIN],
    ]);
    page.post({ t: "end", id: request.id });
    await until(() => page.run<number>("log.length") === 6, "the error before a reconnect");
    assert.deepEqual(JSON.parse(page.run("JSON.stringify(log[5])")), ["error", 0]);
    mock.timers.tick(49);
    await settle();
    assert.equal(page.inbox.filter((m) => m.t === "fetch").length, 1);
    mock.timers.tick(1);
    const again = await page.next("fetch", (m) => m.id > request.id);
    assert.deepEqual(again["headers"], [["accept", "text/event-stream"], ["cache-control", "no-cache"], ["last-event-id", "7"]]);
    page.run("es.close()");
    await page.next("cancel", (m) => m.id === again.id);
    assert.equal(page.run("es.readyState"), 2);
});

test("an EventSource answered 404, or with another type, fails for good; one to another origin is the engine's", async () => {
    const page = await ready();
    page.run("globalThis.errors = 0; globalThis.bad = new EventSource('/missing'); bad.onerror = () => errors++;");
    const request = await page.next("fetch");
    page.answer(request.id, 404, [["content-type", "text/event-stream"]]);
    await until(() => page.run<number>("errors") === 1, "one error");
    assert.equal(page.run("bad.readyState"), 2);
    mock.timers.tick(10_000);
    await settle();
    assert.equal(page.inbox.filter((m) => m.t === "fetch").length, 1, "no reconnect");
    page.run("new EventSource('/plain')");
    const plain = await page.next("fetch", (m) => m.id > request.id);
    page.answer(plain.id, 200, [["content-type", "text/plain"]]);
    page.run("globalThis.away = new EventSource('https://feed.example.com/', { withCredentials: true })");
    assert.equal(JSON.stringify(page.natives.es), JSON.stringify([["https://feed.example.com/", { withCredentials: true }]]));
    assert.equal(page.run("away instanceof EventSource"), true);
});

// ── WebSocket ───────────────────────────────────────────────────────────────
test("a WebSocket to the app's host opens through the relay; its state machine and errors are the spec's", async () => {
    const page = await ready();
    assert.throws(() => page.run("new WebSocket('/ws#frag')"), { name: "SyntaxError" });
    assert.throws(() => page.run("new WebSocket('ftp://x/')"), { name: "SyntaxError" });
    assert.throws(() => page.run("new WebSocket('/ws', ['a', 'a'])"), { name: "SyntaxError" });
    assert.throws(() => page.run("new WebSocket('/ws', ['bad token'])"), { name: "SyntaxError" });
    page.run(`globalThis.log = []; globalThis.ws = new WebSocket('ws://${HOST}/ws?room=1', ['chat', 'json']);
        ws.onopen = () => log.push(['open', ws.readyState, ws.protocol]);
        ws.onmessage = (e) => log.push(['message', typeof e.data === 'string' ? e.data : Object.prototype.toString.call(e.data), e.origin]);
        ws.onerror = () => log.push(['error', ws.readyState]);
        ws.onclose = (e) => log.push(['close', e.code, e.reason, e.wasClean, ws.readyState]);`);
    assert.equal(page.run("ws.readyState"), 0);
    assert.equal(page.run("ws.url"), `ws://${HOST}/ws?room=1`);
    assert.equal(page.run("ws.extensions"), "");
    assert.throws(() => page.run("ws.send('too early')"), { name: "InvalidStateError" });
    const request = await page.next("ws");
    assert.deepEqual({ ...request }, { t: "ws", id: request.id, path: "/ws?room=1", protocols: ["chat", "json"] });
    page.post({ t: "ws.open", id: request.id, protocol: "json" });
    await until(() => page.run<number>("log.length") === 1, "open");

    page.run("ws.send('hé'); ws.send(new Uint8Array([1, 2, 3])); ws.send(new Blob(['blob']))");
    assert.equal(page.run("ws.bufferedAmount"), 3 + 3 + 4);
    await until(() => page.inbox.filter((m) => m.t === "ws.send").length === 3, "three sends, in order");
    const sends = page.inbox.filter((m) => m.t === "ws.send");
    assert.equal(sends[0]?.["text"], "hé");
    assert.deepEqual([...new Uint8Array(sends[1]?.["bin"] as ArrayBuffer)], [1, 2, 3]);
    assert.equal(text(sends[2]?.["bin"] as ArrayBuffer), "blob");
    page.post({ t: "ws.sent", id: request.id, n: 3 });
    await until(() => page.run("ws.bufferedAmount") === 7, "bufferedAmount falls as the pult reports");

    page.post({ t: "ws.message", id: request.id, text: "hello" });
    const bin = new Uint8Array([9]).buffer;
    page.post({ t: "ws.message", id: request.id, bin }, [bin]);
    await until(() => page.run<number>("log.length") === 3, "two messages");
    page.run("ws.binaryType = 'arraybuffer'; ws.binaryType = 'nonsense'");
    assert.equal(page.run("ws.binaryType"), "arraybuffer");
    const second = new Uint8Array([8]).buffer;
    page.post({ t: "ws.message", id: request.id, bin: second }, [second]);
    await until(() => page.run<number>("log.length") === 4, "a third message");
    const credited = (): number => page.inbox.filter((m) => m.t === "credit" && m.id === request.id).reduce((n, m) => n + (m["n"] as number), 0);
    await until(() => credited() === 7, "the frame credits what it took");

    assert.throws(() => page.run("ws.close(1001)"), { name: "InvalidAccessError" });
    assert.throws(() => page.run("ws.close(1000, 'x'.repeat(124))"), { name: "SyntaxError" });
    page.run("ws.close(4000, 'done')");
    assert.equal(page.run("ws.readyState"), 2);
    page.run("ws.send('after close')");
    assert.equal(page.run("ws.bufferedAmount"), 7 + 11, "a send while closing only grows bufferedAmount");
    const close = await page.next("ws.close");
    assert.deepEqual([close["code"], close["reason"]], [4000, "done"]);
    page.post({ t: "ws.closed", id: request.id, code: 4000, reason: "done", clean: true });
    await until(() => page.run<number>("log.length") === 5, "close");
    assert.deepEqual(JSON.parse(page.run("JSON.stringify(log)")), [
        ["open", 1, "json"],
        ["message", "hello", `ws://${HOST}`],
        ["message", "[object Blob]", `ws://${HOST}`],
        ["message", "[object ArrayBuffer]", `ws://${HOST}`],
        ["close", 4000, "done", true, 3],
    ]);
    assert.equal(page.inbox.filter((m) => m.t === "ws.send").length, 3);
});

test("an unclean close fires error before close; closing while connecting fails the connection", async () => {
    const page = await ready();
    page.run("globalThis.log = []; globalThis.a = new WebSocket('/a'); a.onerror = () => log.push('error'); a.onclose = (e) => log.push(['close', e.code, e.wasClean]);");
    const first = await page.next("ws");
    page.post({ t: "ws.open", id: first.id, protocol: "" });
    await until(() => page.run("a.readyState") === 1, "open");
    page.post({ t: "ws.closed", id: first.id, code: 1006, reason: "", clean: false });
    await until(() => page.run<number>("log.length") === 2, "error and close");
    assert.deepEqual(JSON.parse(page.run("JSON.stringify(log)")), ["error", ["close", 1006, false]]);

    page.run("globalThis.log2 = []; globalThis.b = new WebSocket('/b'); b.onerror = () => log2.push('error'); b.onclose = (e) => log2.push(e.code);");
    const second = await page.next("ws", (m) => m.id > first.id);
    page.run("b.close()");
    assert.equal(page.run("b.readyState"), 2);
    await page.next("cancel", (m) => m.id === second.id);
    mock.timers.tick(0);
    assert.deepEqual(JSON.parse(page.run("JSON.stringify(log2)")), ["error", 1006]);
    assert.equal(page.run("b.readyState"), 3);
});

test("sends past the frame window wait for the pult's credit, one oversized message at a time", async () => {
    const page = await ready();
    page.run("globalThis.big = new WebSocket('/big')");
    const request = await page.next("ws");
    page.post({ t: "ws.open", id: request.id, protocol: "" });
    await until(() => page.run("big.readyState") === 1, "open");
    page.run("big.send(new Uint8Array(200 * 1024)); big.send(new Uint8Array(100 * 1024)); big.send(new Uint8Array(300 * 1024))");
    await until(() => page.inbox.filter((m) => m.t === "ws.send").length === 1, "the first message");
    await settle();
    await settle();
    assert.equal(page.inbox.filter((m) => m.t === "ws.send").length, 1, "200 KiB + 100 KiB is past the 256 KiB window");
    page.post({ t: "credit", id: request.id, n: 200 * 1024 });
    await until(() => page.inbox.filter((m) => m.t === "ws.send").length === 2, "the second");
    await settle();
    assert.equal(page.inbox.filter((m) => m.t === "ws.send").length, 2, "an oversized message waits until nothing is outstanding");
    page.post({ t: "credit", id: request.id, n: 100 * 1024 });
    await until(() => page.inbox.filter((m) => m.t === "ws.send").length === 3, "the oversized one alone");
});

test("a WebSocket to another host is the engine's own, and still an instance of WebSocket", () => {
    const page = open();
    page.run("globalThis.away = new WebSocket('https://chat.example.com/socket', 'v1')");
    assert.deepEqual(page.natives.ws, [["wss://chat.example.com/socket", "v1"]]);
    assert.equal(page.run("away instanceof WebSocket"), true);
    assert.equal(page.run("WebSocket.CLOSING + WebSocket.prototype.OPEN"), 3);
});

// ── document.cookie ─────────────────────────────────────────────────────────
test("document.cookie reads the mirror by path and order, writes through to the pult, and takes the pult's corrections", async () => {
    const page = open([
        { n: "a", v: "1", p: "/", e: null },
        { n: "b", v: "2", p: "/app", e: null },
        { n: "gone", v: "x", p: "/", e: Date.now() - 1 },
        { n: "", v: "bare", p: "/", e: null },
        { n: "far", v: "3", p: "/elsewhere", e: null },
    ]);
    assert.equal(page.run("document.cookie"), "b=2; a=1; bare");
    page.run("document.cookie = 'c=3; Max-Age=60'");
    page.run("document.cookie = 'h=1; HttpOnly'");
    page.run("document.cookie = 'a=; Max-Age=0'");
    assert.equal(page.run("document.cookie"), "b=2; c=3; a=1; bare", "c's default path is /app, and a deletion must name a's own path");
    page.run("document.cookie = 'a=; Max-Age=0; Path=/'");
    assert.equal(page.run("document.cookie"), "b=2; c=3; bare");
    await page.welcome();
    const sets = await until(() => page.inbox.filter((m) => m.t === "cookie.set").length === 3 && page.inbox.filter((m) => m.t === "cookie.set"), "the queued assignments");
    assert.deepEqual(sets.map((m) => [m["line"], m["path"]]), [["c=3; Max-Age=60", "/app/page"], ["a=; Max-Age=0", "/app/page"], ["a=; Max-Age=0; Path=/", "/app/page"]]);
    await page.next("cookies");
    assert.ok(page.inbox.findIndex((m) => m.t === "cookies") > page.inbox.findIndex((m) => m.t === "cookie.set"), "the jar is asked for after the queued assignments");
    page.post({ t: "cookies", list: [{ n: "server", v: "9", p: "/", e: null }] });
    await until(() => page.run("document.cookie") === "server=9", "the snapshot replaces the mirror");
    page.run("document.cookie = 'd=4'");
    await page.next("cookie.set", (m) => m["line"] === "d=4");
    assert.equal(page.run("navigator.cookieEnabled"), true);
    assert.equal(page.run("window.cookieStore"), undefined);
    assert.equal(page.run("Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get.call(Object.create(Document.prototype))"), "native-jar", "another document keeps the engine's cookie");
});

// ── the bodies WebKit drops, and the sync XHR guard ────────────────────────
test("a synchronous XHR to the app throws; an async one, or one elsewhere, is the engine's", () => {
    const page = open();
    assert.throws(() => page.run("new XMLHttpRequest().open('GET', '/api/x', false)"), { name: "InvalidAccessError" });
    page.run("new XMLHttpRequest().open('GET', '/api/x')");
    page.run("new XMLHttpRequest().open('GET', 'https://example.com/', false)");
    assert.deepEqual(page.natives.xhr.map((call) => call.slice(0, 3)), [["open", "GET", "/api/x"], ["open", "GET", "https://example.com/"]]);
});

test("an XHR Blob or FormData body to the app is sent as bytes WebKit keeps, typed unless the app typed it", async () => {
    const page = open();
    page.run("globalThis.x1 = new XMLHttpRequest(); x1.open('POST', '/up'); x1.send(new Blob(['blob'], { type: 'text/x-blob' }))");
    await until(() => page.natives.xhr.some((c) => c[0] === "send"), "send");
    const sent = page.natives.xhr.find((c) => c[0] === "send")?.[1];
    assert.equal(Object.prototype.toString.call(sent), "[object ArrayBuffer]");
    assert.equal(text(sent as ArrayBuffer), "blob");
    assert.deepEqual(page.natives.xhr.find((c) => c[0] === "header"), ["header", "content-type", "text/x-blob"]);

    page.natives.xhr.length = 0;
    page.run("globalThis.x2 = new XMLHttpRequest(); x2.open('POST', '/up'); x2.setRequestHeader('Content-Type', 'application/x-mine'); const f = new FormData(); f.append('a', 'b'); x2.send(f)");
    await until(() => page.natives.xhr.some((c) => c[0] === "send"), "send");
    assert.deepEqual(page.natives.xhr.filter((c) => c[0] === "header"), [["header", "Content-Type", "application/x-mine"]], "the app's own type stands");
    assert.match(text(page.natives.xhr.find((c) => c[0] === "send")?.[1] as ArrayBuffer), /^------WebKitFormBoundary\w{16}\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n/);

    page.natives.xhr.length = 0;
    page.run("globalThis.x3 = new XMLHttpRequest(); x3.open('POST', '/up'); x3.send('plain')");
    assert.deepEqual(page.natives.xhr.find((c) => c[0] === "send"), ["send", "plain"]);
});

test("sendBeacon with a Blob to the app is a bridged keepalive fetch; anything else is the engine's beacon", async () => {
    const page = await ready();
    assert.equal(page.run("navigator.sendBeacon('/log', new Blob(['event'], { type: 'application/json' }))"), true);
    const beacon = await page.next("fetch");
    assert.deepEqual([beacon["method"], beacon["keepalive"], beacon["body"], text(beacon["chunk"] as ArrayBuffer)], ["POST", true, "inline", "event"]);
    assert.ok((beacon["headers"] as [string, string][]).some(([n, v]) => n === "content-type" && v === "application/json"));
    assert.equal(page.run("navigator.sendBeacon('/log', 'text')"), true);
    assert.equal(page.run("navigator.sendBeacon('/log', new Blob([new Uint8Array(70 * 1024)]))"), false, "over the keepalive budget");
    assert.deepEqual(page.natives.beacon, [["/log", "text"]]);
});

test("a multipart form posted into the frame goes through the bridge, then navigates to the reply the pult holds", async () => {
    const page = await ready();
    page.run(`globalThis.form = new HTMLFormElement();
        form.method = 'post'; form.enctype = 'multipart/form-data'; form.action = '${ORIGIN}/save';
        form.fields = [['title', 'hi'], ['file', new File(['data'], 'f.txt', { type: 'text/plain' })]];`);
    page.dispatch("submit", { target: page.run("form"), submitter: null });
    const request = await page.next("fetch");
    assert.deepEqual([request["method"], request["path"], request["nav"]], ["POST", "/save", true]);
    const body = text(await upload(page, request.id));
    assert.match(body, /name="file"; filename="f.txt"\r\nContent-Type: text\/plain\r\n\r\ndata\r\n/);
    page.answer(request.id, 200, [["content-type", "text/html"]]);
    await until(() => page.natives.assigned.length === 1, "the navigation");
    assert.deepEqual(page.natives.assigned, [`${ORIGIN}/save`]);

    page.run("form.submit()");
    const second = await page.next("fetch", (m) => m.id > request.id);
    await upload(page, second.id);
    page.answer(second.id, 307, [["location", "/save2"]]);
    const third = await page.next("fetch", (m) => m.id > second.id);
    assert.deepEqual([third["method"], third["path"]], ["POST", "/save2"]);
    await upload(page, third.id);
    page.answer(third.id, 303, [["location", "/done"]]);
    await until(() => page.natives.assigned.length === 2, "the redirect navigation");
    assert.equal(page.natives.assigned[1], `${ORIGIN}/done`);

    page.run("form.enctype = 'application/x-www-form-urlencoded'; form.submit()");
    assert.equal(page.natives.submits, 1, "a urlencoded form keeps its body in WebKit and is left alone");
});

// ── losing the pult ─────────────────────────────────────────────────────────
test("fatal with retry fails what is live and greets again after a backoff; without retry the bridge goes native for good", async () => {
    const page = await ready();
    const live = page.run<Promise<Response>>("fetch('/live')");
    page.run("globalThis.closes = []; globalThis.sock = new WebSocket('/s'); sock.onclose = (e) => closes.push(e.code)");
    await page.next("fetch");
    await page.next("ws");
    const hellos = page.hellos.length;
    page.post({ t: "fatal", message: "The paired gateway changed.", retry: true });
    await assert.rejects(live, { name: "TypeError" });
    await until(() => page.run<number>("closes.length") === 1, "the socket closed");
    assert.equal(page.run("closes[0]"), 1006);
    mock.timers.tick(999);
    assert.equal(page.hellos.length, hellos);
    mock.timers.tick(1);
    assert.equal(page.hellos.length, hellos + 1, "hello again after 1 s");
    await page.welcome();
    page.post({ t: "fatal", message: "A malformed message.", retry: false });
    await settle();
    await page.run<Promise<Response>>("fetch('/after')");
    assert.equal(page.natives.fetch.length, 1);
    mock.timers.tick(60_000);
    assert.equal(page.hellos.length, hellos + 1, "no more hellos once told to stop");
});

test("pagehide says bye", async () => {
    const page = await ready();
    page.dispatch("pagehide");
    await page.next("bye");
});
