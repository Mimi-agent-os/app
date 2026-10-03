// @ts-check
// The mini-app half of the pult relay (mini-app-relay.ts), injected first into every app document: same-origin fetch, EventSource, WebSocket and document.cookie over one MessagePort; bridgeScript() appends the call that hands it the pult's rules.
(/**
 * @param {typeof import("./mini-app-cookies.ts").parseCookieLine} parseCookieLine
 * @param {typeof import("./mini-app-cookies.ts").matchCookies} matchCookies
 * @param {typeof import("./mini-app-redirect.ts").redirectStep} redirectStep
 * @param {{ window: number, keepalive: number, upload: number }} limits
 */ function bridge(parseCookieLine, matchCookies, redirectStep, limits) {
    "use strict";

    /**
     * @typedef {import("./mini-app-cookies.ts").ScriptCookie} ScriptCookie
     * @typedef {{ v: number, key: string, doc: string, pult: string, origin: string, cookies: ScriptCookie[] }} Boot
     * @typedef {{ blob: Blob | null, stream: ReadableStream<Uint8Array> | null, type: string }} Encoded
     * @typedef {{ kind: "fetch" | "sse", method: string, url: URL, headers: [string, string][], body: Encoded | null, inline: ArrayBuffer | null,
     *   credentials: boolean, keepalive: boolean, nav: boolean, integrity: string, signal: AbortSignal | null }} Exchange
     * @typedef {{ status: number, headers: Headers, body: ReadableStream<Uint8Array> | null, ended: Promise<Record<string, string> | undefined> }} Reply
     * @typedef {{ on: (message: any) => void, fail: () => void }} Op
     */

    const script = document.currentScript;
    const raw = script && script.getAttribute("data-mimi");
    if (!script || !raw) return;
    script.removeAttribute("data-mimi");
    /** @type {Boot} */
    let boot;
    try {
        boot = JSON.parse(raw);
    } catch {
        return;
    }
    if (boot.v !== 1) return;

    const CREDIT_STEP = 64 * 1024;
    const SLICE = 64 * 1024;
    const HELLO_AT = [0, 50, 250, 1000, 3000];
    const HELLO_GIVE_UP_MS = 4000;
    const HELLO_EVERY_MS = 5000;
    const REDIRECTS_MAX = 20;
    const NULL_BODY = [101, 103, 204, 205, 304];
    const BODY_HEADERS = ["content-type", "content-encoding", "content-language", "content-location"];
    const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    const utf8 = new TextEncoder();
    const tagOf = (/** @type {unknown} */ x) => Object.prototype.toString.call(x);

    const native = {
        fetch: window.fetch,
        WebSocket: window.WebSocket,
        EventSource: window.EventSource,
        cookie: Object.getOwnPropertyDescriptor(Document.prototype, "cookie"),
        open: XMLHttpRequest.prototype.open,
        send: XMLHttpRequest.prototype.send,
        setRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
        sendBeacon: navigator.sendBeacon,
        submit: HTMLFormElement.prototype.submit,
    };

    /** @param {string} value @returns {URL | null} */
    function parseUrl(value) {
        try {
            return new URL(value, document.baseURI);
        } catch {
            return null;
        }
    }
    const own = (/** @type {URL} */ url) => url.protocol === location.protocol && url.host === location.host;

    // ── the port: hello, welcome, loss ─────────────────────────────────────────
    /** @type {MessagePort | null} */
    let port = null;
    let gaveUp = false;
    let forGood = false;
    // pagehide has run: the port went with the bye, and only a keepalive request still leaves, straight to the pult
    let leaving = false;
    /** @type {((port: MessagePort | null) => void)[]} */
    let waiters = [];
    let nonce = "";
    let nextId = 1;
    let losses = 0;
    let welcomedAt = 0;
    /** @type {Map<number, Op>} */
    const ops = new Map();
    /** @type {{ line: string, path: string }[]} */
    const cookieQueue = [];
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let helloTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let giveUpTimer;

    /** @param {object} message @param {Transferable[]} [transfer] */
    const post = (message, transfer = []) => port?.postMessage(message, transfer);

    /** @param {MessagePort | null} value */
    function settle(value) {
        const list = waiters;
        waiters = [];
        for (const waiter of list) waiter(value);
    }

    /** The port once welcomed; null while the bridge runs native (never welcomed yet, or told to stop). */
    function connected() {
        if (port || gaveUp || forGood) return Promise.resolve(port);
        return /** @type {Promise<MessagePort | null>} */ (new Promise((resolve) => waiters.push(resolve)));
    }

    /** @param {object} message */
    function toPult(message) {
        try {
            window.top?.postMessage(message, boot.pult);
        } catch {
            // a custom-scheme target origin the engine cannot parse: top is always the pult, and the key binds a document to its own app only
            window.top?.postMessage(message, "*");
        }
    }

    function sayHello() {
        nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
        toPult({ mimi: "hello", v: 1, key: boot.key, nonce, doc: boot.doc });
    }

    /** @param {number} delay */
    function greet(delay) {
        clearTimeout(helloTimer);
        clearTimeout(giveUpTimer);
        gaveUp = false;
        let step = 0;
        const tick = () => {
            if (port || forGood) return;
            sayHello();
            step += 1;
            const next = HELLO_AT[step];
            helloTimer = setTimeout(tick, next === undefined ? HELLO_EVERY_MS : next - (HELLO_AT[step - 1] ?? 0));
        };
        helloTimer = setTimeout(tick, delay);
        giveUpTimer = setTimeout(() => {
            gaveUp = true;
            settle(null);
        }, delay + HELLO_GIVE_UP_MS);
    }

    /** @param {string} message @param {boolean} retry */
    function lose(message, retry) {
        console.debug(`mimi-app: the control panel closed this document's bridge: ${message}`);
        port?.close();
        port = null;
        const live = [...ops.values()];
        ops.clear();
        for (const op of live) op.fail();
        if (!retry) {
            forGood = true;
            settle(null);
            return;
        }
        losses = Date.now() - welcomedAt > 60_000 ? 1 : losses + 1;
        greet(Math.min(30_000, 1000 * 2 ** (losses - 1)));
    }

    window.addEventListener("message", (event) => {
        const data = event.data;
        if (event.source !== window.top || typeof data !== "object" || data === null || data.mimi !== "welcome") return;
        event.stopImmediatePropagation();
        const granted = event.ports[0];
        if (data.v !== 1 || data.nonce !== nonce || port || forGood || !granted) return;
        port = granted;
        welcomedAt = Date.now();
        clearTimeout(helloTimer);
        clearTimeout(giveUpTimer);
        gaveUp = false;
        port.onmessage = (e) => {
            const m = e.data;
            if (m.t === "cookies") jar = m.list;
            else if (m.t === "fatal") lose(String(m.message), m.retry === true);
            else ops.get(m.id)?.on(m);
        };
        for (const assignment of cookieQueue.splice(0)) post({ t: "cookie.set", ...assignment });
        post({ t: "cookies" });
        settle(port);
    }, { capture: true });

    window.addEventListener("pagehide", () => {
        post({ t: "bye" });
        port?.close();
        port = null;
        leaving = true;
    });
    window.addEventListener("pageshow", (event) => {
        if (!event.persisted) return;
        leaving = false;
        const live = [...ops.values()];
        ops.clear();
        for (const op of live) op.fail();
        greet(0);
    });

    // ── one bridged exchange: an http app stream, resolved at its head ──────────
    /** @param {Exchange} req @returns {Promise<Reply>} */
    function exchange(req) {
        const id = nextId++;
        const signal = req.signal;
        return new Promise((resolve, reject) => {
            let credit = 0;
            let given = 0;
            let credited = 0;
            let headed = false;
            let done = false;
            /** @type {(() => void) | null} */
            let wake = null;
            /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
            let controller = null;
            /** @type {(digests: Record<string, string> | undefined) => void} */
            let ended = () => undefined;
            /** @type {Promise<Record<string, string> | undefined>} */
            const endedWith = new Promise((r) => { ended = r; });
            const finish = () => {
                done = true;
                ops.delete(id);
                signal?.removeEventListener("abort", onAbort);
                wake?.();
            };
            /** @param {unknown} error */
            const fail = (error) => {
                if (done) return;
                finish();
                ended(undefined);
                if (!headed) reject(error);
                else controller?.error(error);
            };
            const onAbort = () => {
                if (!done) post({ t: "cancel", id });
                fail(signal?.reason);
            };
            const waitCredit = () => /** @type {Promise<void>} */ (new Promise((r) => { wake = () => { wake = null; r(); }; }));

            if (signal?.aborted) return reject(signal.reason);
            // a redirect hop or a reconnect after the pult closed this document's port
            if (!port) return reject(new TypeError("Load failed"));
            signal?.addEventListener("abort", onAbort, { once: true });
            ops.set(id, {
                fail: () => fail(new TypeError("Load failed")),
                on(m) {
                    if (m.t === "credit") {
                        credit += m.n;
                        wake?.();
                    } else if (m.t === "head") {
                        if (headed) return;
                        if (m.status < 200 || m.status > 599) {
                            post({ t: "cancel", id });
                            return fail(new TypeError("Load failed"));
                        }
                        headed = true;
                        const headers = new Headers();
                        for (const [name, value] of m.headers) {
                            try {
                                headers.append(name, value);
                            } catch {
                                // one header Headers refuses is dropped, not the reply
                            }
                        }
                        const body = NULL_BODY.includes(m.status) || req.method === "HEAD" ? null : new ReadableStream({
                            start(c) { controller = c; },
                            // credit what the reader took: every 64 KiB, or at once when the queue runs dry
                            pull(c) {
                                const queued = CREDIT_STEP - (c.desiredSize ?? CREDIT_STEP);
                                const n = given - queued - credited;
                                if (n >= CREDIT_STEP || (queued <= 0 && n > 0)) {
                                    credited += n;
                                    post({ t: "credit", id, n });
                                }
                            },
                            cancel() {
                                if (!done) post({ t: "cancel", id });
                                finish();
                                ended(undefined);
                            },
                        }, { highWaterMark: CREDIT_STEP, size: (chunk) => chunk.byteLength });
                        resolve({ status: m.status, headers, body, ended: endedWith });
                    } else if (m.t === "data") {
                        const chunk = new Uint8Array(m.chunk);
                        if (!controller) return post({ t: "credit", id, n: chunk.length });
                        given += chunk.length;
                        controller.enqueue(chunk);
                    } else if (m.t === "end") {
                        finish();
                        ended(m.digests);
                        controller?.close();
                    } else if (m.t === "error") {
                        console.debug(`mimi-app: ${req.method} ${req.url.pathname} failed: ${m.message}`);
                        fail(new TypeError("Load failed"));
                    }
                },
            });

            const body = req.body;
            const streamed = !req.keepalive && (body?.blob || body?.stream);
            post({
                t: "fetch", id, kind: req.kind, method: req.method, path: req.url.pathname + req.url.search, headers: req.headers,
                body: req.keepalive && req.inline ? "inline" : streamed ? "stream" : "none", chunk: req.keepalive ? req.inline : undefined,
                length: req.inline ? req.inline.byteLength : body?.blob ? body.blob.size : undefined,
                credentials: req.credentials ? "include" : "omit", keepalive: req.keepalive, nav: req.nav, integrity: req.integrity,
            });
            if (!streamed || !body) return;
            // concurrent with the reply: an upstream that echoes as it reads must see the body before it answers
            void (async () => {
                try {
                    if (body.blob) {
                        for (let at = 0; at < body.blob.size;) {
                            const size = Math.min(SLICE, body.blob.size - at);
                            while (!done && credit < size) await waitCredit();
                            if (done) return;
                            const bytes = await body.blob.slice(at, at + size).arrayBuffer();
                            if (done) return;
                            credit -= size;
                            at += size;
                            post({ t: "body", id, chunk: bytes }, [bytes]);
                        }
                    } else if (body.stream) {
                        const reader = body.stream.getReader();
                        for (let r = await reader.read(); !r.done; r = await reader.read()) {
                            if (tagOf(r.value) !== "[object Uint8Array]") throw new TypeError("A request body stream must yield Uint8Array chunks.");
                            for (let at = 0; at < r.value.length; at += SLICE) {
                                const part = r.value.slice(at, at + SLICE);
                                while (!done && credit < part.length) await waitCredit();
                                if (done) return void reader.cancel().catch(() => undefined);
                                credit -= part.length;
                                post({ t: "body", id, chunk: part.buffer }, [part.buffer]);
                            }
                        }
                    }
                    if (!done) post({ t: "end", id });
                } catch (error) {
                    if (!done) post({ t: "cancel", id });
                    fail(error instanceof TypeError ? error : new TypeError("Load failed"));
                }
            })();
        });
    }

    /**
     * Same-origin redirects followed per `redirect`; a hop to another origin comes back as `leave` for native fetch.
     * @param {Exchange} first
     * @param {RequestRedirect} redirect
     * @returns {Promise<{ reply: Reply, url: URL, redirected: boolean } | { opaque: URL } | { leave: Exchange }>}
     */
    async function follow(first, redirect) {
        let req = first;
        for (let hops = 0; ; hops++) {
            const reply = await exchange(req);
            const moved = reply.headers.get("location");
            const step = moved === null ? null : redirectStep(reply.status, req.method);
            if (!step || moved === null) return { reply, url: req.url, redirected: hops > 0 };
            reply.body?.cancel().catch(() => undefined);
            if (redirect === "manual") return { opaque: req.url };
            /** @type {URL | null} */
            let next = null;
            try {
                next = new URL(moved, req.url);
            } catch {
                // an unparseable Location fails below
            }
            if (redirect === "error" || hops === REDIRECTS_MAX || !next || (step.body && req.body?.stream)) throw new TypeError("Load failed");
            const headers = step.body ? req.headers : req.headers.filter(([name]) => !BODY_HEADERS.includes(name));
            req = { ...req, url: next, method: step.method, headers, body: step.body ? req.body : null, inline: step.body ? req.inline : null };
            if (!own(next)) return { leave: req };
        }
    }

    /**
     * Fetch's BodyInit as bytes that can be sent again after a 307: a Blob, or the stream itself.
     * @param {unknown} body
     * @returns {Encoded}
     */
    function encodeBody(body) {
        const kind = tagOf(body);
        if (typeof body === "string") return { blob: new Blob([body]), stream: null, type: "text/plain;charset=UTF-8" };
        if (kind === "[object URLSearchParams]") return { blob: new Blob([String(body)]), stream: null, type: "application/x-www-form-urlencoded;charset=UTF-8" };
        if (kind === "[object Blob]" || kind === "[object File]") return { blob: /** @type {Blob} */ (body), stream: null, type: /** @type {Blob} */ (body).type };
        if (kind === "[object FormData]") return multipart(/** @type {FormData} */ (body));
        if (kind === "[object ReadableStream]") return { blob: null, stream: /** @type {ReadableStream<Uint8Array>} */ (body), type: "" };
        if (ArrayBuffer.isView(body) || kind === "[object ArrayBuffer]") return { blob: new Blob([/** @type {BufferSource} */ (body)]), stream: null, type: "" };
        return { blob: new Blob([String(body)]), stream: null, type: "text/plain;charset=UTF-8" };
    }

    /** HTML's multipart/form-data encoding; file parts stay file-backed Blob slices. @param {FormData} form @returns {Encoded} */
    function multipart(form) {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const boundary = `----WebKitFormBoundary${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => letters[b % 62]).join("")}`;
        const escape = (/** @type {string} */ s) => s.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
        const lines = (/** @type {string} */ s) => s.replace(/\r\n|\r|\n/g, "\r\n");
        /** @type {BlobPart[]} */
        const parts = [];
        for (const [name, value] of form) {
            const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${escape(lines(name))}"`;
            if (typeof value === "string") parts.push(`${disposition}\r\n\r\n${lines(value)}\r\n`);
            else parts.push(`${disposition}; filename="${escape(value.name)}"\r\nContent-Type: ${value.type || "application/octet-stream"}\r\n\r\n`, value, "\r\n");
        }
        parts.push(`--${boundary}--\r\n`);
        return { blob: new Blob(parts), stream: null, type: `multipart/form-data; boundary=${boundary}` };
    }

    // ── fetch ──────────────────────────────────────────────────────────────────
    // kept beside the object, not in a private field: an engine's Response constructor may read these getters before the subclass's fields exist
    /** @type {WeakMap<Response, { url: string, redirected: boolean, type: ResponseType, empty: Headers }>} */
    const shadows = new WeakMap();
    /** A Response whose url, redirected and type say what the bridge did, since Response's own cannot be set. */
    class BridgedResponse extends Response {
        /** @param {BodyInit | null} body @param {ResponseInit} init @param {{ url: string, redirected: boolean, type: ResponseType }} meta */
        constructor(body, init, meta) {
            super(body, init);
            shadows.set(this, { ...meta, empty: new Headers() });
        }
        /** @override @returns {string} */
        get url() { return shadows.get(this)?.url ?? super.url; }
        /** @override @returns {boolean} */
        get redirected() { return shadows.get(this)?.redirected ?? super.redirected; }
        /** @override @returns {ResponseType} */
        get type() { return shadows.get(this)?.type ?? super.type; }
        /** @override @returns {number} */
        get status() { return shadows.get(this)?.type === "opaqueredirect" ? 0 : super.status; }
        /** @override @returns {boolean} */
        get ok() { return shadows.get(this)?.type === "opaqueredirect" ? false : super.ok; }
        /** @override @returns {Headers} */
        get headers() { const shadow = shadows.get(this); return shadow?.type === "opaqueredirect" ? shadow.empty : super.headers; }
        /** @override @returns {ReadableStream<Uint8Array<ArrayBuffer>> | null} */
        get body() { return shadows.get(this)?.type === "opaqueredirect" ? null : super.body; }
        /** @override @returns {Response} */
        clone() {
            const copy = super.clone();
            const shadow = shadows.get(this);
            return shadow ? new BridgedResponse(copy.body, { status: super.status, headers: super.headers }, shadow) : copy;
        }
    }

    let keepaliveBytes = 0;

    /** @param {RequestInfo | URL} input @param {RequestInit} [init] @returns {Promise<Response>} */
    async function mimiFetch(input, init) {
        const source = tagOf(input) === "[object Request]" ? /** @type {Request} */ (input) : null;
        const url = parseUrl(source ? source.url : String(input));
        if (!url || !own(url) || !(leaving || (await connected()))) return native.fetch.call(window, input, init);
        let bodyInit = init?.body ?? null;
        /** @type {RequestInfo} */
        let base = url.href;
        if (source) {
            if (bodyInit === null && source.body !== null) bodyInit = await source.blob();
            base = new Request(source.url, {
                method: source.method, headers: source.headers, credentials: source.credentials, redirect: source.redirect, integrity: source.integrity,
                keepalive: source.keepalive, signal: source.signal, referrerPolicy: source.referrerPolicy,
            });
        }
        // forbidden headers drop here exactly as natively
        const request = new Request(base, { ...init, body: null });
        const method = request.method;
        if (bodyInit !== null && (method === "GET" || method === "HEAD")) throw new TypeError("Request with GET/HEAD method cannot have body.");
        const body = bodyInit === null ? null : encodeBody(bodyInit);
        /** @type {[string, string][]} */
        const headers = [...request.headers];
        if (body?.type && !request.headers.has("content-type")) headers.push(["content-type", body.type]);
        if (!request.headers.has("accept")) headers.push(["accept", "*/*"]);
        if (request.referrerPolicy !== "no-referrer" && request.referrer !== "") headers.push(["referer", document.URL.split("#")[0] ?? ""]);
        let reserved = 0;
        /** @type {ArrayBuffer | null} */
        let inline = null;
        if (request.keepalive) {
            if (body?.stream) throw new TypeError("A keepalive request cannot carry a stream body.");
            reserved = body?.blob?.size ?? 0;
            if (keepaliveBytes + reserved > limits.keepalive) throw new TypeError("The keepalive budget of this document is spent.");
            keepaliveBytes += reserved;
        }
        if (leaving) {
            if (!request.keepalive) throw new TypeError("Load failed");
            // the Blob goes unread: the caller may be the page's own pagehide or unload listener, and its document is gone before a read finishes
            toPult({ mimi: "keepalive", v: 1, key: boot.key, fetch: {
                t: "fetch", id: 1, kind: "fetch", method, path: url.pathname + url.search, headers, body: body ? "inline" : "none", chunk: body?.blob,
                length: body?.blob?.size, credentials: request.credentials === "omit" ? "omit" : "include", keepalive: true, nav: false, integrity: "",
            } });
            return /** @type {Promise<Response>} */ (new Promise(() => undefined));
        }
        try {
            // a string needs no Blob read, which a document in its unload steps may not live to finish
            if (request.keepalive && body?.blob) inline = typeof bodyInit === "string" ? utf8.encode(bodyInit).buffer : await body.blob.arrayBuffer();
            const result = await follow({
                kind: "fetch", method, url, headers, body, inline, credentials: request.credentials !== "omit", keepalive: request.keepalive,
                nav: false, integrity: request.integrity, signal: request.signal,
            }, request.redirect);
            if ("opaque" in result) return new BridgedResponse(null, { status: 200 }, { url: result.opaque.href, redirected: false, type: "opaqueredirect" });
            if ("leave" in result) {
                const hop = result.leave;
                if (hop.url.protocol !== "http:" && hop.url.protocol !== "https:") throw new TypeError("Load failed");
                return native.fetch.call(window, hop.url.href, {
                    method: hop.method, headers: hop.headers.filter(([name]) => name !== "authorization" && name !== "referer"),
                    body: hop.body?.blob ?? null, credentials: request.credentials, redirect: request.redirect, signal: request.signal,
                    integrity: request.integrity, keepalive: request.keepalive, referrerPolicy: request.referrerPolicy,
                });
            }
            const { reply } = result;
            /** @type {BodyInit | null} */
            let content = reply.body;
            if (request.integrity) {
                const bytes = reply.body ? await new Response(reply.body).arrayBuffer() : new ArrayBuffer(0);
                const digests = (await reply.ended) ?? {};
                const tokens = request.integrity.split(/\s+/).map((token) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)(?:\?.*)?$/.exec(token)).filter((m) => m !== null);
                const strongest = ["sha512", "sha384", "sha256"].find((name) => tokens.some((m) => m[1] === name));
                if (strongest && !tokens.some((m) => m[1] === strongest && m[2] === digests[strongest])) throw new TypeError(`Failed integrity metadata check for ${url.href}`);
                content = reply.body ? bytes : null;
            }
            return new BridgedResponse(content, { status: reply.status, headers: reply.headers }, { url: result.url.href.split("#")[0] ?? "", redirected: result.redirected, type: "basic" });
        } finally {
            keepaliveBytes -= reserved;
        }
    }

    // ── EventSource ────────────────────────────────────────────────────────────
    /** @param {object} proto @param {string[]} names */
    function handlerProperties(proto, names) {
        for (const name of names) {
            /** @type {WeakMap<EventTarget, { handler: ((event: Event) => unknown) | null }>} */
            const slots = new WeakMap();
            Object.defineProperty(proto, `on${name}`, {
                configurable: true,
                enumerable: true,
                /** @this {EventTarget} */
                get() { return slots.get(this)?.handler ?? null; },
                /** @this {EventTarget} @param {unknown} value */
                set(value) {
                    let slot = slots.get(this);
                    if (!slot) {
                        const held = { handler: /** @type {((event: Event) => unknown) | null} */ (null) };
                        slots.set(this, held);
                        this.addEventListener(name, (event) => held.handler?.call(this, event));
                        slot = held;
                    }
                    slot.handler = typeof value === "function" ? /** @type {(event: Event) => unknown} */ (value) : null;
                },
            });
        }
    }

    /** @param {Function} type @param {Record<string, number>} constants */
    function constantsOn(type, constants) {
        for (const [name, value] of Object.entries(constants)) {
            Object.defineProperty(type, name, { value, enumerable: true });
            Object.defineProperty(type.prototype, name, { value, enumerable: true });
        }
    }

    class MimiEventSource extends EventTarget {
        #url = "";
        #credentials = false;
        #state = 0;
        #lastId = "";
        #retry = 3000;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        #timer;
        /** @type {AbortController | null} */
        #abort = null;

        /** @param {string | URL} url @param {EventSourceInit} [init] */
        constructor(url, init) {
            super();
            const resolved = parseUrl(String(url));
            if (!resolved) throw new DOMException(`The URL '${String(url)}' is invalid.`, "SyntaxError");
            if (!own(resolved)) return /** @type {any} */ (new native.EventSource(url, init));
            this.#url = resolved.href;
            this.#credentials = Boolean(init?.withCredentials);
            void this.#connect();
        }
        get url() { return this.#url; }
        get withCredentials() { return this.#credentials; }
        get readyState() { return this.#state; }
        close() {
            this.#state = 2;
            clearTimeout(this.#timer);
            this.#abort?.abort();
        }

        async #connect() {
            const abort = new AbortController();
            this.#abort = abort;
            /** @type {[string, string][]} */
            const headers = [["accept", "text/event-stream"], ["cache-control", "no-cache"]];
            // a header carries bytes: the id goes as its UTF-8, as the engine sends it
            if (this.#lastId) headers.push(["last-event-id", Array.from(utf8.encode(this.#lastId), (b) => String.fromCharCode(b)).join("")]);
            try {
                if (!(await connected())) throw new TypeError("the bridge is not connected");
                const result = await follow({
                    kind: "sse", method: "GET", url: new URL(this.#url), headers, body: null, inline: null, credentials: true, keepalive: false,
                    nav: false, integrity: "", signal: abort.signal,
                }, "follow");
                const reply = "reply" in result ? result.reply : null;
                const type = reply?.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
                if (!reply?.body || reply.status !== 200 || type !== "text/event-stream") {
                    void reply?.body?.cancel();
                    if (this.#state === 2) return;
                    this.#state = 2;
                    this.dispatchEvent(new Event("error"));
                    return;
                }
                if (this.#state === 2) return void reply.body.cancel();
                this.#state = 1;
                this.dispatchEvent(new Event("open"));
                // HTML §9.2.6: the decoder drops one leading BOM; a CR at a chunk's end waits to see whether an LF follows
                const reader = reply.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let skipLF = false;
                let data = "";
                let event = "";
                let id = this.#lastId;
                for (let r = await reader.read(); !r.done && this.#state !== 2; r = await reader.read()) {
                    buffer += decoder.decode(r.value, { stream: true });
                    let start = 0;
                    for (let i = 0; i < buffer.length; i++) {
                        const ch = buffer[i];
                        if (skipLF && ch === "\n") {
                            skipLF = false;
                            start = i + 1;
                            continue;
                        }
                        skipLF = false;
                        if (ch !== "\r" && ch !== "\n") continue;
                        skipLF = ch === "\r";
                        const line = buffer.slice(start, i);
                        start = i + 1;
                        if (line === "") {
                            this.#lastId = id;
                            if (data === "") {
                                event = "";
                                continue;
                            }
                            const message = new MessageEvent(event || "message", { data: data.slice(0, -1), origin: boot.origin, lastEventId: id });
                            data = "";
                            event = "";
                            if (this.#state !== 2) this.dispatchEvent(message);
                            continue;
                        }
                        if (line.startsWith(":")) continue;
                        const colon = line.indexOf(":");
                        const field = colon === -1 ? line : line.slice(0, colon);
                        const value = colon === -1 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
                        if (field === "data") data += `${value}\n`;
                        else if (field === "event") event = value;
                        else if (field === "id" && !value.includes("\0")) id = value;
                        else if (field === "retry" && /^\d+$/.test(value)) this.#retry = Number(value);
                    }
                    buffer = buffer.slice(start);
                }
                if (this.#state === 2) void reader.cancel().catch(() => undefined);
            } catch {
                // a network error, a reset or the end of the stream: all reconnect
            }
            if (this.#state === 2) return;
            this.#state = 0;
            this.dispatchEvent(new Event("error"));
            this.#timer = setTimeout(() => {
                if (this.#state === 0) void this.#connect();
            }, this.#retry);
        }
    }
    constantsOn(MimiEventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    handlerProperties(MimiEventSource.prototype, ["open", "message", "error"]);

    // ── WebSocket ──────────────────────────────────────────────────────────────
    class MimiWebSocket extends EventTarget {
        #id = 0;
        #url = "";
        #origin = "";
        #state = 0;
        #protocol = "";
        /** @type {BinaryType} */
        #binaryType = "blob";
        #buffered = 0;
        /** Message bytes posted to the pult and not yet credited back. */
        #up = 0;
        /** @type {(() => void) | null} */
        #wake = null;
        /** @type {Promise<void>} */
        #chain = Promise.resolve();

        /** @param {string | URL} url @param {string | string[]} [protocols] */
        constructor(url, protocols = []) {
            super();
            const parsed = parseUrl(String(url));
            if (parsed?.protocol === "http:") parsed.protocol = "ws:";
            else if (parsed?.protocol === "https:") parsed.protocol = "wss:";
            if (!parsed || ![location.protocol, "ws:", "wss:"].includes(parsed.protocol) || parsed.href.includes("#")) {
                throw new DOMException(`The URL '${String(url)}' is invalid.`, "SyntaxError");
            }
            if (parsed.host !== location.host) return /** @type {any} */ (new native.WebSocket(parsed.href, protocols));
            const list = typeof protocols === "string" ? [protocols] : [...protocols];
            if (list.some((p) => !TOKEN.test(p)) || new Set(list).size !== list.length) throw new DOMException("The subprotocols are invalid.", "SyntaxError");
            this.#url = parsed.href;
            // a mimiapp: URL has an opaque origin under the URL standard
            this.#origin = parsed.protocol === location.protocol ? boot.origin : parsed.origin;
            void this.#start(parsed, list);
        }
        get url() { return this.#url; }
        get readyState() { return this.#state; }
        get protocol() { return this.#protocol; }
        get extensions() { return ""; }
        get bufferedAmount() { return this.#buffered; }
        get binaryType() { return this.#binaryType; }
        set binaryType(value) {
            if (value === "blob" || value === "arraybuffer") this.#binaryType = value;
        }

        /** @param {URL} url @param {string[]} protocols */
        async #start(url, protocols) {
            const link = await connected();
            if (this.#state !== 0) return;
            if (!link || !port) return this.#closed(1006, "", false);
            this.#id = nextId++;
            ops.set(this.#id, { on: (m) => this.#on(m), fail: () => this.#closed(1006, "", false) });
            post({ t: "ws", id: this.#id, path: url.pathname + url.search, protocols });
        }

        /** @param {any} m */
        #on(m) {
            if (m.t === "ws.open") {
                if (this.#state !== 0) return;
                this.#state = 1;
                this.#protocol = m.protocol;
                this.dispatchEvent(new Event("open"));
            } else if (m.t === "ws.message") {
                const size = typeof m.text === "string" ? utf8.encode(m.text).length : m.bin.byteLength;
                if (this.#state === 1) {
                    const data = typeof m.text === "string" ? m.text : this.#binaryType === "blob" ? new Blob([m.bin]) : m.bin;
                    this.dispatchEvent(new MessageEvent("message", { data, origin: this.#origin }));
                }
                post({ t: "credit", id: this.#id, n: size });
            } else if (m.t === "ws.sent") {
                this.#buffered = Math.max(0, this.#buffered - m.n);
            } else if (m.t === "credit") {
                this.#up = Math.max(0, this.#up - m.n);
                this.#wake?.();
            } else if (m.t === "ws.closed") {
                ops.delete(this.#id);
                this.#closed(m.code, m.reason, m.clean === true);
            }
        }

        /** @param {number} code @param {string} reason @param {boolean} clean */
        #closed(code, reason, clean) {
            if (this.#state === 3) return;
            this.#state = 3;
            ops.delete(this.#id);
            this.#wake?.();
            if (!clean) this.dispatchEvent(new Event("error"));
            this.dispatchEvent(new CloseEvent("close", { wasClean: clean, code, reason }));
        }

        /** @param {string | ArrayBufferLike | Blob | ArrayBufferView} data */
        send(data) {
            if (this.#state === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
            const kind = tagOf(data);
            const blob = kind === "[object Blob]" || kind === "[object File]" ? /** @type {Blob} */ (data) : null;
            /** @type {{ text?: string, bin?: ArrayBuffer }} */
            let message = {};
            let size = blob ? blob.size : 0;
            if (ArrayBuffer.isView(data)) message = { bin: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer };
            else if (kind === "[object ArrayBuffer]") message = { bin: /** @type {ArrayBuffer} */ (data).slice(0) };
            else if (!blob) message = { text: String(data) };
            if (message.bin) size = message.bin.byteLength;
            if (message.text !== undefined) size = utf8.encode(message.text).length;
            this.#buffered += size;
            if (this.#state !== 1) return;
            const id = this.#id;
            this.#chain = this.#chain.then(async () => {
                if (blob) message = { bin: await blob.arrayBuffer() };
                while (this.#state !== 3 && this.#up > 0 && this.#up + size > limits.window) {
                    await new Promise((r) => { this.#wake = () => { this.#wake = null; r(undefined); }; });
                }
                if (this.#state === 3) return;
                this.#up += size;
                post({ t: "ws.send", id, ...message }, message.bin ? [message.bin] : []);
            }).catch(() => this.#closed(1006, "", false));
        }

        /** @param {number} [code] @param {string} [reason] */
        close(code, reason) {
            const value = code === undefined ? undefined : Number(code);
            if (value !== undefined && value !== 1000 && !(value >= 3000 && value <= 4999)) throw new DOMException(`The close code ${value} is not allowed.`, "InvalidAccessError");
            const text = reason === undefined ? "" : String(reason);
            if (utf8.encode(text).length > 123) throw new DOMException("The close reason is longer than 123 bytes.", "SyntaxError");
            if (this.#state >= 2) return;
            if (this.#state === 0) {
                this.#state = 2;
                if (this.#id) post({ t: "cancel", id: this.#id });
                setTimeout(() => this.#closed(1006, "", false), 0);
                return;
            }
            this.#state = 2;
            const id = this.#id;
            // a reason cannot travel without a code: the standard closes with 1000 then
            const sent = value === undefined && text !== "" ? 1000 : value;
            this.#chain = this.#chain.then(() => { post({ t: "ws.close", id, code: sent, reason: text }); });
        }
    }
    constantsOn(MimiWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    handlerProperties(MimiWebSocket.prototype, ["open", "message", "error", "close"]);
    for (const [ours, theirs] of [[MimiWebSocket, native.WebSocket], [MimiEventSource, native.EventSource]]) {
        // a socket to another host is the engine's own, and still an instance of the replaced constructor
        Object.defineProperty(ours, Symbol.hasInstance, { value: (/** @type {unknown} */ x) => (theirs !== undefined && x instanceof theirs) || Function.prototype[Symbol.hasInstance].call(ours, x) });
    }

    // ── document.cookie: a synchronous mirror of the pult's jar ────────────────
    let jar = boot.cookies;
    Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        enumerable: true,
        /** @this {Document} */
        get() {
            if (this !== document) return native.cookie?.get?.call(this) ?? "";
            return matchCookies(jar, location.pathname, Date.now()).map((c) => (c.n === "" ? c.v : `${c.n}=${c.v}`)).join("; ");
        },
        /** @this {Document} @param {unknown} value */
        set(value) {
            if (this !== document) return void native.cookie?.set?.call(this, value);
            const line = String(value);
            const now = Date.now();
            const cookie = parseCookieLine(line, location.pathname, now);
            if (!cookie || cookie.h) return;
            const at = jar.findIndex((c) => c.n === cookie.n && c.p === cookie.p);
            const next = { n: cookie.n, v: cookie.v, p: cookie.p, e: cookie.e };
            if (cookie.e !== null && cookie.e <= now) jar = jar.filter((_, i) => i !== at);
            else jar = at === -1 ? [...jar, next] : jar.map((c, i) => (i === at ? next : c));
            const assignment = { line, path: location.pathname };
            if (port) post({ t: "cookie.set", ...assignment });
            else cookieQueue.push(assignment);
        },
    });
    Object.defineProperty(navigator, "cookieEnabled", { configurable: true, get: () => true });
    // a native cookieStore reads the engine's jar, not this one
    Object.defineProperty(window, "cookieStore", { configurable: true, writable: true, value: undefined });

    // ── bodies WebKit drops on a custom scheme: XHR and beacon Blobs, multipart forms ──
    /** @type {WeakMap<XMLHttpRequest, { own: boolean, typed: boolean }>} */
    const xhrs = new WeakMap();
    /** @this {XMLHttpRequest} @param {string} _method @param {string | URL} url */
    XMLHttpRequest.prototype.open = function (_method, url) {
        const target = parseUrl(String(url));
        const mine = target !== null && own(target);
        // a synchronous request would block the one thread that also runs the pult, which has to answer it
        if (mine && arguments.length > 2 && !arguments[2]) throw new DOMException("Synchronous requests to a mini-app are not supported.", "InvalidAccessError");
        xhrs.set(this, { own: mine, typed: false });
        return native.open.apply(this, /** @type {any} */ (arguments));
    };
    /** @this {XMLHttpRequest} @param {string} name @param {string} value */
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        const meta = xhrs.get(this);
        if (meta && String(name).toLowerCase() === "content-type") meta.typed = true;
        return native.setRequestHeader.call(this, name, value);
    };
    /** @this {XMLHttpRequest} @param {Document | XMLHttpRequestBodyInit | null} [body] */
    XMLHttpRequest.prototype.send = function (body) {
        const kind = tagOf(body);
        if (!xhrs.get(this)?.own || !["[object Blob]", "[object File]", "[object FormData]"].includes(kind)) return native.send.call(this, body);
        const encoded = encodeBody(body);
        const blob = /** @type {Blob} */ (encoded.blob);
        if (encoded.type && !xhrs.get(this)?.typed) native.setRequestHeader.call(this, "content-type", encoded.type);
        if (blob.size > limits.upload) {
            setTimeout(() => {
                this.dispatchEvent(new ProgressEvent("error"));
                this.dispatchEvent(new ProgressEvent("loadend"));
            }, 0);
            return;
        }
        blob.arrayBuffer().then((bytes) => native.send.call(this, bytes)).catch((error) => console.error("mimi-app: an XHR body could not be sent", error));
    };

    if (typeof native.sendBeacon === "function") {
        /** @param {string | URL} url @param {BodyInit | null} [data] */
        navigator.sendBeacon = function (url, data) {
            const target = parseUrl(String(url));
            const kind = tagOf(data);
            if (!target || !own(target) || !["[object Blob]", "[object File]", "[object FormData]"].includes(kind)) return native.sendBeacon.call(navigator, url, data);
            const encoded = encodeBody(data);
            const blob = /** @type {Blob} */ (encoded.blob);
            if (keepaliveBytes + blob.size > limits.keepalive) return false;
            /** @type {HeadersInit} */
            const headers = encoded.type ? { "content-type": encoded.type } : {};
            void mimiFetch(target.href, { method: "POST", body: blob, headers, keepalive: true, credentials: "include" }).catch(() => undefined);
            return true;
        };
    }

    /**
     * The action URL when a submission is a multipart POST into this very frame on this origin: the body WebKit would lose.
     * @param {HTMLFormElement} form @param {HTMLElement | null} submitter
     */
    function formAction(form, submitter) {
        const button = /** @type {HTMLButtonElement | null} */ (submitter);
        const pick = (/** @type {string} */ attribute, /** @type {() => string} */ read, /** @type {string} */ fallback) => (button?.hasAttribute(attribute) ? read() : fallback);
        const method = pick("formmethod", () => button?.formMethod ?? "", form.method).toLowerCase();
        const enctype = pick("formenctype", () => button?.formEnctype ?? "", form.enctype).toLowerCase();
        const target = pick("formtarget", () => button?.formTarget ?? "", form.target).toLowerCase();
        const action = parseUrl(pick("formaction", () => button?.formAction ?? "", form.action));
        return method === "post" && enctype === "multipart/form-data" && (target === "" || target === "_self") && action && own(action) ? action : null;
    }

    /** @param {HTMLFormElement} form @param {HTMLElement | null} submitter @param {URL} action */
    async function submitForm(form, submitter, action) {
        const body = multipart(submitter ? new FormData(form, submitter) : new FormData(form));
        if (!(await connected())) return native.submit.call(form);
        let url = action;
        let method = "POST";
        try {
            for (let hops = 0; hops <= REDIRECTS_MAX; hops++) {
                const reply = await exchange({
                    kind: "fetch", method, url, body: method === "POST" ? body : null, inline: null, credentials: true, keepalive: false, nav: true, integrity: "", signal: null,
                    headers: [["content-type", body.type], ["accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["referer", document.URL.split("#")[0] ?? ""]],
                });
                const moved = reply.headers.get("location");
                const step = moved === null ? null : redirectStep(reply.status, method);
                // the pult holds the final reply for the GET navigation that comes next, once its end arrives
                if (!step || moved === null) {
                    await reply.ended;
                    return location.assign(url.href);
                }
                reply.body?.cancel().catch(() => undefined);
                const next = new URL(moved, url);
                if ((reply.status === 307 || reply.status === 308) && own(next)) {
                    url = next;
                    method = step.method;
                    continue;
                }
                return location.assign(next.href);
            }
        } catch (error) {
            console.error("mimi-app: the form could not be sent", error);
        }
    }

    window.addEventListener("submit", (event) => {
        const form = event.target;
        if (event.defaultPrevented || tagOf(form) !== "[object HTMLFormElement]") return;
        const submitter = /** @type {SubmitEvent} */ (event).submitter ?? null;
        const action = formAction(/** @type {HTMLFormElement} */ (form), submitter);
        if (!action) return;
        event.preventDefault();
        void submitForm(/** @type {HTMLFormElement} */ (form), submitter, action);
    });
    /** @this {HTMLFormElement} */
    HTMLFormElement.prototype.submit = function () {
        const action = formAction(this, null);
        if (action) void submitForm(this, null, action);
        else native.submit.call(this);
    };

    // ── install ────────────────────────────────────────────────────────────────
    for (const [name, value] of /** @type {[string, unknown][]} */ ([["fetch", mimiFetch], ["EventSource", MimiEventSource], ["WebSocket", MimiWebSocket]])) {
        Object.defineProperty(window, name, { configurable: true, writable: true, value });
    }
    Object.defineProperty(window, Symbol.for("mimi.bridge"), { value: 1 });
    greet(0);
})
