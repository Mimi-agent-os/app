// channel.ts dials on import, so each case installs fake DOM globals and imports a fresh instance of the module.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { APP_CHUNK, CLOSE_NOT_PAIRED, DEVICE_CREDIT, DEVICE_WINDOW, FLAG_DATA, FLAG_END, FLAG_RESET, makeInviteUri, newInvite, PROTOCOL_VERSION, ServerSession } from "@mimi-os/protocol";

interface Stub {
    url: string;
    closed: boolean;
    sent: number;
    onopen: (() => void) | null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    onclose: ((event: { code: number }) => void) | null;
    onerror: (() => void) | null;
}

const NativeWebSocket = globalThis.WebSocket;
const sockets: Stub[] = [];
const hashes: string[] = [];
let instance = 0;

function browser(hash: string, paired: boolean): void {
    sockets.length = 0;
    hashes.length = 0;
    const store = new Map<string, string>();
    if (paired) {
        const key = Buffer.alloc(32, 7).toString("base64");
        store.set("mimi-os:device", JSON.stringify({ secret: key, gatewayPub: key, gateway: "http://127.0.0.1:46464", gateways: ["http://127.0.0.1:46464"] }));
    }
    Object.assign(globalThis, {
        localStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => store.set(k, v),
            removeItem: (k: string) => store.delete(k),
        },
        location: { protocol: "http:", host: "127.0.0.1:46464", hash, pathname: "/app/", search: "" },
        history: { replaceState: (_s: unknown, _t: string, url: string) => hashes.push(url) },
        WebSocket: class {
            binaryType = "";
            onopen: (() => void) | null = null;
            onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
            onclose: ((event: { code: number }) => void) | null = null;
            onerror: (() => void) | null = null;
            closed = false;
            sent = 0;
            url: string;
            constructor(url: string) { this.url = url; sockets.push(this as unknown as Stub); }
            send(): void { this.sent += 1; }
            close(): void {
                if (this.closed) return;
                this.closed = true;
                this.onclose?.({ code: 1005 });
            }
        },
    });
}

/** The gateway ends the socket with `code`. */
function hangUp(ws: Stub, code: number): void {
    ws.closed = true;
    ws.onclose?.({ code });
}

const load = (): Promise<typeof import("../src/channel.ts")> =>
    import(new URL(`../src/channel.ts?case=${++instance}`, import.meta.url).href) as Promise<typeof import("../src/channel.ts")>;

test("a pairing hash with nothing redeemable still dials with the stored key", async () => {
    for (const hash of ["#pair=", "#pair=%"]) {
        browser(hash, true);
        const channel = await load();
        assert.equal(channel.takePendingInvite(), null, hash);
        assert.deepEqual(sockets.map((s) => s.url), ["ws://127.0.0.1:46464/channel"], hash);
        assert.equal(channel.getSnapshot().state, "connecting", hash);
        assert.deepEqual(hashes, ["/app/"], hash);
        channel.forgetDevice();
    }
});

test("a redeemable pairing hash is handed to the pairing view instead of dialling", async () => {
    const uri = makeInviteUri(Buffer.alloc(32, 9), newInvite(Date.now()));
    browser(`#pair=${encodeURIComponent(uri)}`, true);
    const channel = await load();
    assert.deepEqual(sockets, []);
    assert.equal(channel.getSnapshot().state, "pairing_required");
    assert.equal(channel.takePendingInvite(), uri);
    assert.equal(channel.takePendingInvite(), null);
    channel.forgetDevice();
});

test("a pairing link names its gateway: mimi pair's own address, else the origin it was opened on", async () => {
    browser("", false);
    const channel = await load();
    const gwPub = Buffer.alloc(32, 9);
    const invite = newInvite(Date.now());
    const withAddress = makeInviteUri(gwPub, invite, "http://100.101.1.2:46464");
    const bare = makeInviteUri(gwPub, invite);
    assert.deepEqual(channel.readPairLink(`  ${withAddress}\n`), { uri: withAddress, address: "http://100.101.1.2:46464" });
    assert.deepEqual(channel.readPairLink(bare), { uri: bare, address: "" });
    assert.deepEqual(channel.readPairLink(`http://10.0.0.5:46464/app/#pair=${encodeURIComponent(bare)}`), { uri: bare, address: "http://10.0.0.5:46464" });
    // the link's own address wins over the page it was opened on
    assert.equal(channel.readPairLink(`http://10.0.0.5:46464/#pair=${encodeURIComponent(withAddress)}`).address, "http://100.101.1.2:46464");
    for (const bad of ["", "http://10.0.0.5:46464", "#pair=%", `${bare}&at=ftp%3A%2F%2Fx`, withAddress.replace("&at=http%3A", "&at=http:")]) {
        assert.throws(() => channel.readPairLink(bad), /not a pairing link/, bad);
    }
});

test("pasting mimi pair's one link dials the address it carries, and a typed address wins over it", async () => {
    const invite = newInvite(Date.now());
    const link = makeInviteUri(Buffer.alloc(32, 9), invite, "http://100.101.1.2:46464");
    for (const [typed, dialled] of [
        [undefined, "ws://100.101.1.2:46464"],
        ["https://gw.tail1234.ts.net/", "wss://gw.tail1234.ts.net"],
    ] as const) {
        browser("", false);
        const channel = await load();
        const paired = channel.pairWithInvite(link, typed);
        await tick();
        assert.deepEqual(sockets.map((s) => s.url), [`${dialled}/channel/pair?invite=${invite.id}`]);
        sockets[0]?.close();
        await assert.rejects(paired, /closed before it finished/);
    }
    browser("", false);
    const channel = await load();
    await assert.rejects(channel.pairWithInvite("mimi://pair/v2?nope"), /not a pairing link/);
    assert.deepEqual(sockets, [], "a malformed link dials nothing");
    assert.equal(channel.getSnapshot().state, "pairing_required");
});

test("a pairing link whose gateway never answers gives up after 15 s and names the address", async (t) => {
    browser("", false);
    const channel = await load();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const invite = newInvite(Date.now());
    const paired = channel.pairWithInvite(makeInviteUri(Buffer.alloc(32, 9), invite, "http://[fd7a:115c:a1e0::5]:8001"));
    await tick();
    assert.deepEqual(sockets.map((s) => s.url), [`ws://[fd7a:115c:a1e0::5]:8001/channel/pair?invite=${invite.id}`]);
    t.mock.timers.tick(14_999);
    await tick();
    assert.equal(sockets[0]?.closed, false, "still waiting just under 15 s");
    t.mock.timers.tick(1);
    await assert.rejects(paired, /Could not reach http:\/\/\[fd7a:115c:a1e0::5\]:8001 within 15 s/);
    assert.equal(sockets[0]?.closed, true);
});

test("an unpaired browser with no hash asks for pairing", async () => {
    browser("", false);
    const channel = await load();
    assert.deepEqual(sockets, []);
    assert.equal(channel.getSnapshot().state, "pairing_required");
});

test("an undecodable record closes the socket instead of throwing out of onmessage", async () => {
    browser("", true);
    const channel = await load();
    const ws = sockets[0] as Stub;
    ws.onopen?.();
    assert.ok(ws.sent > 0, "the handshake was sent");
    ws.onmessage?.({ data: new Uint8Array([255, 255, 255, 255, 255]).buffer });
    assert.equal(ws.closed, true);
    assert.equal(channel.getSnapshot().state, "reconnecting");
    channel.forgetDevice();
});

test("a gateway that says this device is not paired lands on rejected at once, never redials, and a new link still pairs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    browser("", true);
    const channel = await load();
    sockets[0]?.onopen?.();
    hangUp(sockets[0] as Stub, CLOSE_NOT_PAIRED);
    assert.equal(channel.getSnapshot().state, "rejected");
    t.mock.timers.tick(10 * 60_000);
    channel.redialNow();
    await tick();
    assert.equal(sockets.length, 1, "no retry loop, not even on coming back to the page");

    const invite = newInvite(Date.now());
    const paired = channel.pairWithInvite(makeInviteUri(Buffer.alloc(32, 9), invite, "http://100.101.1.2:46464"));
    await tick();
    assert.equal(sockets.at(-1)?.url, `ws://100.101.1.2:46464/channel/pair?invite=${invite.id}`);
    sockets.at(-1)?.close();
    await assert.rejects(paired, /closed before it finished/);
    channel.forgetDevice();
});

test("a bare or abnormal close before the handshake completes still redials, with no rejected screen in between", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    browser("", true);
    const channel = await load();
    const states: string[] = [];
    channel.subscribe((s) => states.push(s.state));
    // a gateway restart, a handshake past its deadline, a gateway stop, a dropped link: each one only a redial away
    for (const [i, code] of [1000, 1006, 1001, 1006].entries()) {
        sockets[i]?.onopen?.();
        hangUp(sockets[i] as Stub, code);
        assert.equal(channel.getSnapshot().state, "reconnecting");
        t.mock.timers.tick(1000 * 2 ** i);
        assert.equal(sockets.length, i + 2);
    }
    assert.equal(states.includes("rejected"), false);
    channel.forgetDevice();
});

test("a used or unknown invite reads as a dead link, and only a gateway never reached reads as unreachable", async () => {
    // what the gateway does with an invite id it does not hold: it completes the upgrade, then drops the socket with no close frame
    const server = createServer().on("upgrade", (req, socket) => {
        const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const gateway = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const gwPub = Buffer.from(generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x ?? "", "base64url");
    const uri = makeInviteUri(gwPub, newInvite(Date.now()));
    try {
        browser("", false);
        globalThis.WebSocket = NativeWebSocket;
        const channel = await load();
        await assert.rejects(channel.pairWithInvite(uri, gateway), /may be used or expired/);
        assert.equal(channel.getSnapshot().state, "pairing_required");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    browser("", false);
    globalThis.WebSocket = NativeWebSocket;
    const channel = await load();
    await assert.rejects(channel.pairWithInvite(uri, gateway), /Could not reach the gateway/);
});

// ── streams against a real gateway session: the fake socket feeds a ServerSession from @mimi-os/protocol ──
type Channel = typeof import("../src/channel.ts");
type Frame = import("@mimi-os/protocol").ChannelStreamFrame;
interface Gateway {
    /** What the next dial's server_info says; each dial meets a fresh session. */
    protocol: number;
    frames: Frame[];
    socket: Stub;
    send(stream: number, flags: number, payload?: Uint8Array): void;
    head(stream: number, status: number, headers?: Record<string, string | string[]>): void;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await tick();
}

async function gateway(protocol = PROTOCOL_VERSION, device: "active" | "pending" = "active"): Promise<{ channel: Channel; gw: Gateway }> {
    const keys = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
    const gatewayPub = Buffer.from(keys.x ?? "", "base64url");
    const session = (): ServerSession => new ServerSession({ s: Buffer.from(keys.d ?? "", "base64url"), protocol: gw.protocol, lookup: () => device });
    let server: ServerSession;
    browser("", false);
    localStorage.setItem("mimi-os:device", JSON.stringify({ secret: Buffer.alloc(32, 3).toString("base64"), gatewayPub: gatewayPub.toString("base64"), gateway: "http://127.0.0.1:46464", gateways: ["http://127.0.0.1:46464"] }));
    // bytes belong to the socket they were sent on: a closed one delivers nothing more
    const toPult = (chunks: Uint8Array[]): void => {
        const socket = gw.socket;
        for (const chunk of chunks) setImmediate(() => { if (!socket.closed) socket.onmessage?.({ data: chunk.slice().buffer }); });
    };
    const gw: Gateway = {
        protocol,
        frames: [],
        socket: null as unknown as Stub,
        send: (stream, flags, payload = new Uint8Array(0)) => toPult(server.send({ stream, flags, payload })),
        head: (stream, status, headers = {}) => gw.send(stream, FLAG_DATA, new TextEncoder().encode(JSON.stringify({ t: "head", status, headers }))),
    };
    Object.assign(globalThis, {
        WebSocket: class {
            binaryType = "";
            onopen: (() => void) | null = null;
            onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
            onclose: ((event: { code: number }) => void) | null = null;
            onerror: (() => void) | null = null;
            closed = false;
            sent = 0;
            url: string;
            constructor(url: string) {
                this.url = url;
                server = session();
                gw.socket = this as unknown as Stub;
                sockets.push(this as unknown as Stub);
                setImmediate(() => this.onopen?.());
            }
            send(data: Uint8Array): void {
                this.sent += 1;
                const { out, events } = server.feed(data);
                toPult(out);
                for (const ev of events) if (ev.type === "frame") gw.frames.push(ev.frame);
            }
            close(): void {
                if (this.closed) return;
                this.closed = true;
                this.onclose?.({ code: 1005 });
            }
        },
    });
    const channel = await load();
    const settled = protocol !== PROTOCOL_VERSION ? "incompatible" : device === "pending" ? "pending_activation" : "ready";
    for (let i = 0; i < 50 && channel.getSnapshot().state !== settled; i += 1) await tick();
    assert.equal(channel.getSnapshot().state, settled);
    return { channel, gw };
}

const json = (frame: Frame | undefined): unknown => JSON.parse(new TextDecoder().decode(frame?.payload));
const on = (gw: Gateway, stream: number): Frame[] => gw.frames.filter((f) => f.stream === stream);
const credits = (gw: Gateway, stream: number): number => on(gw, stream).filter((f) => f.flags === FLAG_DATA && f.payload.length === 0).length;

function recorder(ready: () => boolean = () => true) {
    const log = { heads: [] as { status: number; headers: [string, string][] }[], bytes: 0, ended: false, failed: null as Error | null };
    const sink = {
        head: (head: { status: number; headers: [string, string][] }) => { log.heads.push(head); },
        data: (chunk: Uint8Array) => { log.bytes += chunk.length; return ready(); },
        end: () => { log.ended = true; },
        fail: (error: Error) => { log.failed = error; },
    };
    return { log, sink };
}

const APP = { t: "app", appId: "files", credential: "c2VjcmV0", method: "GET", path: "/", headers: {} } as const;

test("the gateway tag is the first five bytes of the paired gateway's key, and forgetting the device clears it", async () => {
    const { channel } = await gateway();
    const stored = JSON.parse(localStorage.getItem("mimi-os:device") ?? "{}") as { gatewayPub: string };
    assert.equal(channel.gatewayTag(), Buffer.from(stored.gatewayPub, "base64").subarray(0, 5).toString("hex"));
    channel.forgetDevice();
    assert.equal(channel.gatewayTag(), "");
});

test("an app grant and an app request put their own header on a stream of their own, and a grant reads as a plain JSON reply", async () => {
    const { channel, gw } = await gateway();
    const granted = channel.streamFetch({ t: "app_grant", appId: "files" });
    await settle();
    assert.deepEqual(json(on(gw, 1)[0]), { t: "app_grant", appId: "files" });
    assert.equal(on(gw, 1)[1]?.flags, FLAG_END, "a grant sends no body");
    gw.head(1, 200, { "content-type": "application/json" });
    gw.send(1, FLAG_END, new TextEncoder().encode(JSON.stringify({ appId: "files", credential: "c2VjcmV0" })));
    assert.deepEqual(await (await granted).json(), { appId: "files", credential: "c2VjcmV0" });

    const { sink } = recorder();
    await channel.openStream({ ...APP, headers: { accept: "*/*" }, upgrade: true }, sink);
    await settle();
    assert.deepEqual(json(on(gw, 2)[0]), { ...APP, headers: { accept: "*/*" }, upgrade: true });
    channel.forgetDevice();
});

test("a zero-payload DATA frame is credit in every phase, never a head, and an app stream answers one credit per quantum it took", async () => {
    const { channel, gw } = await gateway();
    const { log, sink } = recorder();
    await channel.openStream(APP, sink);
    await settle();
    gw.send(1, FLAG_DATA);
    await settle();
    assert.equal(log.failed, null, "credit before the head is not a bad head");
    gw.head(1, 200, { "set-cookie": ["a=1; Path=/", "b=2"], "X-Multi": "x" });
    for (let i = 0; i < DEVICE_CREDIT / APP_CHUNK * 2; i += 1) gw.send(1, FLAG_DATA, new Uint8Array(APP_CHUNK));
    await settle();
    assert.deepEqual(log.heads[0], { status: 200, headers: [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2"], ["x-multi", "x"]] });
    assert.equal(log.bytes, DEVICE_CREDIT * 2);
    assert.equal(credits(gw, 1), 2);
    channel.forgetDevice();
});

test("no credit goes out while the consumer is behind, until it resumes", async () => {
    const { channel, gw } = await gateway();
    let ready = false;
    const { log, sink } = recorder(() => ready);
    const stream = await channel.openStream(APP, sink);
    await settle();
    gw.head(1, 200);
    for (let i = 0; i < DEVICE_WINDOW / APP_CHUNK; i += 1) gw.send(1, FLAG_DATA, new Uint8Array(APP_CHUNK));
    await settle();
    assert.equal(log.bytes, DEVICE_WINDOW);
    assert.equal(credits(gw, 1), 0);
    ready = true;
    stream.resume();
    await settle();
    assert.equal(credits(gw, 1), DEVICE_WINDOW / DEVICE_CREDIT);
    channel.forgetDevice();
});

test("an api stream never credits", async () => {
    const { channel, gw } = await gateway();
    const reply = channel.apiFetch("/events");
    await settle();
    gw.head(1, 200);
    for (let i = 0; i < 20; i += 1) gw.send(1, FLAG_DATA, new Uint8Array(APP_CHUNK));
    await settle();
    await reply;
    assert.equal(credits(gw, 1), 0);
    channel.forgetDevice();
});

test("a gateway that overruns the window is reset and the stream fails, and a throwing sink loses only its own stream", async () => {
    const { channel, gw } = await gateway();
    const overrun = recorder(() => false);
    await channel.openStream(APP, overrun.sink);
    const thrower = recorder();
    await channel.openStream(APP, { ...thrower.sink, head: () => { throw new Error("boom"); } });
    await settle();
    gw.head(1, 200);
    for (let i = 0; i < (DEVICE_WINDOW + APP_CHUNK) / APP_CHUNK; i += 1) gw.send(1, FLAG_DATA, new Uint8Array(APP_CHUNK));
    await settle();
    assert.equal(overrun.log.failed, null, "a window plus a chunk is still within the rules");
    gw.send(1, FLAG_DATA, new Uint8Array(1));
    gw.head(2, 200);
    await settle();
    assert.match(String(overrun.log.failed), /overran/);
    assert.equal(on(gw, 1).at(-1)?.flags, FLAG_RESET);
    assert.match(String(thrower.log.failed), /boom/);
    assert.equal(on(gw, 2).at(-1)?.flags, FLAG_RESET);
    assert.equal(gw.socket.closed, false, "the connection outlives both");
    const after = channel.apiFetch("/health");
    await settle();
    gw.head(3, 200);
    gw.send(3, FLAG_END);
    assert.equal((await after).res.status, 200);
    channel.forgetDevice();
});

test("write stops at the window and onDrain fires on the gateway's credit; streamFetch paces a 1 MiB body", async () => {
    const { channel, gw } = await gateway();
    const { sink } = recorder();
    const stream = await channel.openStream({ ...APP, method: "POST" }, sink);
    let open = true;
    for (let sent = 0; open; sent += APP_CHUNK) open = stream.write(new Uint8Array(APP_CHUNK));
    let drained = false;
    stream.onDrain(() => { drained = true; });
    await settle();
    assert.equal(on(gw, 1).reduce((n, f) => n + f.payload.length, 0) - on(gw, 1)[0]!.payload.length, DEVICE_WINDOW);
    assert.equal(drained, false);
    gw.send(1, FLAG_DATA);
    await settle();
    assert.equal(drained, true);

    const body = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
    const reply = channel.streamFetch({ ...APP, method: "PUT" }, body);
    await settle();
    const uploaded = (): number => on(gw, 2).slice(1).reduce((n, f) => n + f.payload.length, 0);
    assert.equal(uploaded(), DEVICE_WINDOW, "nothing past one window before a credit");
    for (let i = 0; uploaded() < body.length && i < 100; i += 1) {
        gw.send(2, FLAG_DATA);
        await settle();
    }
    const got = Buffer.concat(on(gw, 2).slice(1).map((f) => f.payload));
    assert.deepEqual(new Uint8Array(got), body);
    assert.equal(on(gw, 2).at(-1)?.flags, FLAG_END);
    gw.head(2, 204);
    gw.send(2, FLAG_END);
    const res = await reply;
    assert.equal(res.status, 204);
    assert.equal(res.body, null, "a 204 is a Response with no body, not a throw that drops the channel");
    channel.forgetDevice();
});

test("a head no Response can carry fails its own request only", async () => {
    const { channel, gw } = await gateway();
    const informational = channel.streamFetch(APP);
    await settle();
    gw.head(1, 101);
    await assert.rejects(informational);
    assert.equal(on(gw, 1).at(-1)?.flags, FLAG_RESET);
    assert.equal(gw.socket.closed, false);
    channel.forgetDevice();
});

test("a reply that ends before the upload does abandons it with a RESET; an upgraded stream's END is only a half-close", async () => {
    const { channel, gw } = await gateway();
    const early = recorder();
    const upload = await channel.openStream({ ...APP, method: "POST" }, early.sink);
    upload.write(new Uint8Array(10));
    const socket = recorder();
    const upgraded = await channel.openStream({ ...APP, upgrade: true }, socket.sink);
    await settle();
    gw.head(1, 413);
    gw.send(1, FLAG_END);
    gw.head(2, 101);
    gw.send(2, FLAG_END);
    await settle();
    assert.equal(early.log.ended, true);
    assert.equal(on(gw, 1).at(-1)?.flags, FLAG_RESET);
    assert.equal(socket.log.ended, true);
    assert.notEqual(on(gw, 2).at(-1)?.flags, FLAG_RESET);
    upgraded.write(new Uint8Array([0x88, 0x00]));
    upgraded.end();
    await settle();
    assert.deepEqual(on(gw, 2).slice(-2).map((f) => f.flags), [FLAG_DATA, FLAG_END]);
    channel.forgetDevice();
});

test("the 61st live stream waits for a slot and starts when one ends", async () => {
    const { channel, gw } = await gateway();
    const streams = [];
    for (let i = 0; i < 60; i += 1) streams.push(await channel.openStream(APP, recorder().sink));
    let started = false;
    const waiting = channel.openStream(APP, recorder().sink).then((s) => { started = true; return s; });
    await settle();
    assert.equal(started, false);
    streams[0]!.end();
    gw.head(1, 200);
    gw.send(1, FLAG_END);
    await settle();
    assert.equal(started, true);
    assert.deepEqual(json(on(gw, 61)[0]), APP);
    await waiting;
    channel.forgetDevice();
});

test("a head too large for one record is refused on its own, and the channel stays up", async () => {
    const { channel, gw } = await gateway();
    await assert.rejects(channel.openStream({ ...APP, headers: { cookie: "x".repeat(64 * 1024) } }, recorder().sink), /too large/);
    const after = channel.apiFetch("/health");
    await settle();
    gw.head(1, 200);
    gw.send(1, FLAG_END);
    assert.equal((await after).res.status, 200);
    assert.equal(gw.socket.closed, false);
    channel.forgetDevice();
});

test("a lost connection fails every open stream once", async () => {
    const { channel, gw } = await gateway();
    const { log, sink } = recorder();
    await channel.openStream(APP, sink);
    const pending = channel.apiFetch("/agents");
    await settle();
    gw.socket.close();
    assert.match(String(log.failed), /connection closed/);
    await assert.rejects(pending, /connection closed/);
    channel.forgetDevice();
});

test("a gateway on another protocol version is named, not retried like a dropped connection, and Retry dials at once", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { channel, gw } = await gateway(PROTOCOL_VERSION + 1);
    assert.deepEqual(channel.getSnapshot(), { state: "incompatible", sas: null, peer: PROTOCOL_VERSION + 1 });
    const states: string[] = [];
    channel.subscribe((s) => states.push(s.state));

    channel.redialNow();
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(sockets.length, 1, "neither the foreground nor a fast backoff dials again");
    t.mock.timers.tick(1);
    await settle();
    assert.equal(sockets.length, 2, "one recheck a minute later");
    t.mock.timers.tick(119_999);
    await settle();
    assert.equal(sockets.length, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(sockets.length, 3, "the next one twice as late");
    channel.recheckProtocol();
    await settle();
    assert.equal(sockets.length, 4, "Retry dials now");
    assert.deepEqual(new Set(states), new Set(["incompatible"]), "a recheck never reads as reconnecting, and four refusals never as an unpaired browser");
    assert.equal(channel.getSnapshot().peer, PROTOCOL_VERSION + 1);

    gw.protocol = PROTOCOL_VERSION;
    channel.recheckProtocol();
    await settle();
    assert.deepEqual(channel.getSnapshot(), { state: "ready", sas: null });
    const health = channel.apiFetch("/health");
    await settle();
    gw.head(1, 200);
    gw.send(1, FLAG_END);
    assert.equal((await health).res.status, 200);

    gw.socket.close();
    assert.equal(channel.getSnapshot().state, "reconnecting", "a drop after an update is an ordinary drop again");
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(channel.getSnapshot().state, "ready");
    channel.forgetDevice();
});

test("switching the gateway URL from the incompatible notice reads as a fresh dial", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { channel } = await gateway(PROTOCOL_VERSION + 1);
    channel.useGateway("http://127.0.0.1:46465");
    assert.equal(channel.getSnapshot().state, "connecting");
    assert.equal(sockets.at(-1)?.url, "ws://127.0.0.1:46465/channel");
    await settle();
    assert.equal(channel.getSnapshot().state, "incompatible");
    channel.forgetDevice();
});

// ── keepalive: a stream-0 ping every 25 s while ready, and a socket that answers nothing within 10 s is dropped ──
const said = (msg: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(msg));

test("a ready channel pings on stream 0 every 25 s, and a pong or any other frame answers it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { channel, gw } = await gateway();
    t.mock.timers.tick(24_999);
    assert.equal(on(gw, 0).length, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(on(gw, 0).map((f) => [f.flags, json(f)]), [[FLAG_END, { t: "ping" }]], "one whole message, as the gateway reads stream 0");
    gw.send(0, FLAG_END, said({ t: "pong" }));
    await settle();
    t.mock.timers.tick(10_000);
    assert.equal(gw.socket.closed, false);

    const events = channel.apiFetch("/events");
    await settle();
    t.mock.timers.tick(15_000);
    assert.equal(on(gw, 0).length, 2);
    gw.head(1, 200);
    await settle();
    t.mock.timers.tick(10_000);
    assert.equal(gw.socket.closed, false, "a reply on another stream proves the socket as well as a pong does");
    assert.equal((await events).res.status, 200);
    channel.forgetDevice();
});

test("a ping nothing answers within 10 s drops the socket at once: its streams fail and the channel redials", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { channel, gw } = await gateway();
    const { log, sink } = recorder();
    await channel.openStream(APP, sink);
    const dead = gw.socket;
    // one tick runs its timers at its own end, so the ping and its deadline need ticks of their own
    t.mock.timers.tick(25_000);
    t.mock.timers.tick(9_999);
    assert.equal(dead.closed, false);
    t.mock.timers.tick(1);
    assert.equal(dead.closed, true);
    assert.equal(channel.getSnapshot().state, "reconnecting");
    assert.match(String(log.failed), /connection closed/);
    t.mock.timers.tick(1000);
    await settle();
    assert.notEqual(gw.socket, dead);
    assert.equal(channel.getSnapshot().state, "ready");
    channel.forgetDevice();
});

test("coming back to the page pings a ready socket at once, so a dead one is gone within 10 s", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { channel, gw } = await gateway();
    channel.redialNow();
    assert.deepEqual(on(gw, 0).map(json), [{ t: "ping" }]);
    t.mock.timers.tick(10_000);
    assert.equal(gw.socket.closed, true);
    assert.equal(channel.getSnapshot().state, "reconnecting");
    channel.forgetDevice();
});

test("a ping behind a large upload waits 1 s more per 16 KB the gateway has not confirmed, and a later ping keeps that wait", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { channel, gw } = await gateway();
    // a message with photos: the gateway reads a ping sent after it only once the whole body is in
    const post = channel.apiFetch("/agents/wren/conversations/1/messages", { method: "POST", body: "a".repeat(600_000) });
    await settle();
    channel.redialNow();
    t.mock.timers.tick(10_000);
    assert.equal(gw.socket.closed, false, "600 KB ahead of the ping is 36 s more");
    t.mock.timers.tick(15_000);
    assert.equal(on(gw, 0).length, 2, "the 25 s ping went out behind the same upload");
    t.mock.timers.tick(20_000);
    assert.equal(gw.socket.closed, false, "the second ping waits for the bytes the first one was waiting for");
    gw.send(0, FLAG_END, said({ t: "pong" }));
    gw.send(0, FLAG_END, said({ t: "pong" }));
    await settle();
    t.mock.timers.tick(5_000);
    assert.equal(on(gw, 0).length, 3);
    t.mock.timers.tick(10_000);
    assert.equal(gw.socket.closed, true, "with the upload confirmed, 10 s of silence ends the socket again");
    await assert.rejects(post, /connection closed/);
    channel.forgetDevice();
});

test("a deadline that fires late, as on a page that was frozen, asks again instead of dropping the socket", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const { channel, gw } = await gateway();
    t.mock.timers.tick(25_000);
    assert.equal(on(gw, 0).length, 1);
    // the page sleeps for five minutes: the clock moves on while no timer runs
    t.mock.timers.setTime(Date.now() + 5 * 60_000);
    t.mock.timers.tick(10_000);
    assert.equal(gw.socket.closed, false);
    assert.ok(on(gw, 0).length > 1, "a fresh ping went out");
    gw.send(0, FLAG_END, said({ t: "pong" }));
    await settle();
    t.mock.timers.tick(10_000);
    assert.equal(gw.socket.closed, false);
    assert.equal(channel.getSnapshot().state, "ready");
    channel.forgetDevice();
});

test("a device waiting for approval sends no ping, and pinging starts once it is activated and stops when it is forgotten", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const { channel, gw } = await gateway(PROTOCOL_VERSION, "pending");
    t.mock.timers.tick(60_000);
    assert.equal(on(gw, 0).length, 0);
    assert.equal(gw.socket.closed, false);
    gw.send(0, FLAG_END, said({ t: "activated" }));
    await settle();
    assert.equal(channel.getSnapshot().state, "ready");
    t.mock.timers.tick(25_000);
    assert.deepEqual(on(gw, 0).map(json), [{ t: "ping" }]);
    channel.forgetDevice();
    t.mock.timers.tick(60_000);
    assert.equal(on(gw, 0).length, 1);
});
