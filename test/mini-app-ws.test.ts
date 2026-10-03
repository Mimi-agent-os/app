// The relay's RFC 6455 codec and its digests: masked client frames, the server-frame decoder's rules, and SHA-1/SHA-2 against node:crypto.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { base64, Hash } from "../src/mini-app-hash.ts";
import { clientFrame, closePayload, OP_BINARY, OP_CLOSE, OP_TEXT, wsAccept, WsDecoder, WsError, type WsEvent } from "../src/mini-app-ws.ts";

const budget = (): { used: number; max: number } => ({ used: 0, max: 128 * 1024 * 1024 });

/** An unmasked server frame, as an upstream sends it. */
function serverFrame(opcode: number, payload: Uint8Array | string, fin = true): Uint8Array {
    const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    const lengthBytes = body.length < 126 ? 0 : body.length < 65536 ? 2 : 8;
    const out = new Uint8Array(2 + lengthBytes + body.length);
    out[0] = (fin ? 0x80 : 0) | opcode;
    out[1] = body.length < 126 ? body.length : body.length < 65536 ? 126 : 127;
    const view = new DataView(out.buffer);
    if (lengthBytes === 2) view.setUint16(2, body.length);
    if (lengthBytes === 8) view.setBigUint64(2, BigInt(body.length));
    out.set(body, 2 + lengthBytes);
    return out;
}

/** What an upstream reads from our frame: unmasked, with the lengths it declared. */
function unmask(bytes: Uint8Array): { fin: boolean; opcode: number; masked: boolean; payload: Uint8Array } {
    const opcode = bytes[0]! & 0x0f;
    let length = bytes[1]! & 0x7f;
    let at = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    if (length === 126) { length = view.getUint16(2); at = 4; }
    else if (length === 127) { length = Number(view.getBigUint64(2)); at = 10; }
    const mask = bytes.subarray(at, at + 4);
    const payload = bytes.slice(at + 4, at + 4 + length).map((b, i) => b ^ mask[i & 3]!);
    assert.equal(bytes.length, at + 4 + length, "the frame is exactly its header and payload");
    return { fin: (bytes[0]! & 0x80) !== 0, opcode, masked: (bytes[1]! & 0x80) !== 0, payload };
}

const joined = (slices: Iterable<Uint8Array>): Uint8Array => Buffer.concat([...slices]);

test("the accept value of RFC 6455 §1.3", () => {
    assert.equal(wsAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("client frames are masked and carry 7-, 16- and 64-bit lengths", () => {
    for (const length of [0, 125, 126, 65535, 65536, 200_000]) {
        const payload = randomBytes(length);
        const slices = [...clientFrame(OP_BINARY, payload, 16 * 1024)];
        assert.ok(slices.every((s) => s.length <= 16 * 1024), `${length}: every slice fits one channel chunk`);
        const frame = unmask(joined(slices));
        assert.equal(frame.masked, true);
        assert.equal(frame.fin, true);
        assert.equal(frame.opcode, OP_BINARY);
        assert.ok(Buffer.from(frame.payload).equals(payload), `${length}: the payload round-trips through the mask`);
    }
    const text = unmask(joined(clientFrame(OP_TEXT, new TextEncoder().encode("hi"), 16 * 1024)));
    assert.equal(new TextDecoder().decode(text.payload), "hi");
    const close = unmask(joined(clientFrame(OP_CLOSE, closePayload(4000, "done"), 16 * 1024)));
    assert.equal(new DataView(close.payload.buffer).getUint16(0), 4000);
    assert.equal(new TextDecoder().decode(close.payload.subarray(2)), "done");
    assert.equal(closePayload(null).length, 0);
});

test("server frames of every length, split anywhere, decode to whole messages", () => {
    for (const length of [0, 125, 126, 65535, 65536]) {
        const payload = randomBytes(length);
        const wire = serverFrame(OP_BINARY, payload);
        const decoder = new WsDecoder(budget());
        const events: WsEvent[] = [];
        for (let at = 0; at < wire.length; at += 1000) events.push(...decoder.push(wire.slice(at, at + 1000)));
        assert.equal(events.length, 1, `${length}`);
        const [event] = events;
        assert.ok(event?.kind === "binary" && Buffer.from(event.data).equals(payload), `${length}`);
    }
});

test("fragments assemble around control frames; a ping is surfaced for its pong", () => {
    const decoder = new WsDecoder(budget());
    const events = decoder.push(Buffer.concat([
        serverFrame(OP_TEXT, "hel", false),
        serverFrame(9, "are you there"),
        serverFrame(0, "lo ", false),
        serverFrame(10, ""),
        serverFrame(0, "world", true),
    ]));
    assert.deepEqual(events.map((e) => e.kind), ["ping", "pong", "text"]);
    assert.ok(events[0]?.kind === "ping" && new TextDecoder().decode(events[0].data) === "are you there");
    assert.ok(events[2]?.kind === "text" && events[2].data === "hello world");
});

test("a close frame carries its code and reason, or none", () => {
    const withCode = new WsDecoder(budget()).push(serverFrame(OP_CLOSE, closePayload(4001, "bye")));
    assert.deepEqual(withCode, [{ kind: "close", code: 4001, reason: "bye" }]);
    assert.deepEqual(new WsDecoder(budget()).push(serverFrame(OP_CLOSE, new Uint8Array(0))), [{ kind: "close", code: null, reason: "" }]);
});

test("what a server must never send fails the connection with the right code", () => {
    const fails = (bytes: Uint8Array, code: number, why: string): void => {
        assert.throws(() => new WsDecoder(budget()).push(bytes), (e: unknown) => e instanceof WsError && e.code === code, why);
    };
    const masked = serverFrame(OP_TEXT, "x");
    masked[1]! |= 0x80;
    fails(masked, 1002, "a masked server frame");
    const reserved = serverFrame(OP_TEXT, "x");
    reserved[0]! |= 0x40;
    fails(reserved, 1002, "an extension bit nobody negotiated");
    fails(serverFrame(3, "x"), 1002, "an unknown opcode");
    fails(serverFrame(0, "x"), 1002, "a continuation with no message");
    fails(Buffer.concat([serverFrame(OP_TEXT, "a", false), serverFrame(OP_TEXT, "b")]), 1002, "a message inside a fragmented one");
    fails(serverFrame(9, "x", false), 1002, "a fragmented control frame");
    fails(serverFrame(9, new Uint8Array(126)), 1002, "a control frame over 125 bytes");
    fails(serverFrame(OP_CLOSE, new Uint8Array([3])), 1002, "a one-byte close payload");
    fails(serverFrame(OP_CLOSE, closePayload(1005)), 1002, "a reserved close code");
    fails(serverFrame(OP_TEXT, new Uint8Array([0xc3, 0x28])), 1007, "a text message that is not UTF-8");
    fails(serverFrame(OP_CLOSE, Buffer.concat([closePayload(1000), Buffer.from([0xff])])), 1007, "a close reason that is not UTF-8");
    const huge = new Uint8Array(10);
    huge[0] = 0x82;
    huge[1] = 127;
    new DataView(huge.buffer).setBigUint64(2, BigInt(64 * 1024 * 1024 + 1));
    fails(huge, 1009, "a message over 64 MiB, refused from its header alone");
});

test("the assembly budget is shared across sockets and handed back", () => {
    const shared = { used: 0, max: 100 };
    const a = new WsDecoder(shared);
    const b = new WsDecoder(shared);
    a.push(serverFrame(OP_BINARY, new Uint8Array(40), false));
    assert.equal(shared.used, 40);
    assert.throws(() => b.push(serverFrame(OP_BINARY, new Uint8Array(70))), (e: unknown) => e instanceof WsError && e.code === 1009);
    b.release();
    assert.equal(shared.used, 40);
    a.push(serverFrame(0, new Uint8Array(10)));
    assert.equal(shared.used, 0, "a finished message hands its bytes back");
});

test("SHA-1 and SHA-2 match node:crypto across block edges and uneven updates", () => {
    for (const name of ["sha1", "sha256", "sha384", "sha512"] as const) {
        for (const length of [0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 1000, 70_000]) {
            const data = randomBytes(length);
            const hash = new Hash(name);
            for (let at = 0; at < length;) {
                const n = Math.min(length - at, 1 + (at % 97));
                hash.update(data.subarray(at, at + n));
                at += n;
            }
            assert.equal(base64(hash.digest()), createHash(name).update(data).digest("base64"), `${name} over ${length} bytes`);
        }
    }
});
