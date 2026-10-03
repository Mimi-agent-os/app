// RFC 6455 framing for the relay's WebSocket streams: masked client frames out, unmasked server frames in, no extensions.
import { base64, Hash } from "./mini-app-hash.ts";

export const OP_TEXT = 1;
export const OP_BINARY = 2;
export const OP_CLOSE = 8;
export const OP_PING = 9;
export const OP_PONG = 10;
export const WS_MESSAGE_MAX = 64 * 1024 * 1024;

export type WsEvent =
    | { kind: "text"; data: string }
    | { kind: "binary"; data: Uint8Array }
    | { kind: "ping"; data: Uint8Array }
    | { kind: "pong" }
    | { kind: "close"; code: number | null; reason: string };

/** A violation that fails the connection: the close code to send (1002 protocol, 1007 bad UTF-8, 1009 too big). */
export class WsError extends Error {
    readonly code: 1002 | 1007 | 1009;
    constructor(code: 1002 | 1007 | 1009, message: string) {
        super(message);
        this.code = code;
    }
}

const utf8 = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

/** §1.3: what Sec-WebSocket-Accept must say for the key we sent. */
export function wsAccept(key: string): string {
    const hash = new Hash("sha1");
    hash.update(utf8.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`));
    return base64(hash.digest());
}

/** A close frame's payload: the code, then the UTF-8 reason. */
export function closePayload(code: number | null, reason = ""): Uint8Array {
    if (code === null) return new Uint8Array(0);
    const text = utf8.encode(reason);
    const out = new Uint8Array(2 + text.length);
    new DataView(out.buffer).setUint16(0, code);
    out.set(text, 2);
    return out;
}

/** One masked client frame in slices of at most `max` bytes, masked slice by slice so a large message is never copied whole. */
export function* clientFrame(opcode: number, payload: Uint8Array, max: number): Generator<Uint8Array> {
    const length = payload.length;
    const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
    const head = new Uint8Array(2 + lengthBytes + 4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | (length < 126 ? length : length < 65536 ? 126 : 127);
    const view = new DataView(head.buffer);
    if (lengthBytes === 2) view.setUint16(2, length);
    if (lengthBytes === 8) {
        view.setUint32(2, Math.floor(length / 2 ** 32));
        view.setUint32(6, length >>> 0);
    }
    const mask = crypto.getRandomValues(new Uint8Array(4));
    head.set(mask, 2 + lengthBytes);
    let at = 0;
    let first = true;
    while (first || at < length) {
        const room = first ? max - head.length : max;
        const part = payload.subarray(at, at + room);
        const slice = new Uint8Array((first ? head.length : 0) + part.length);
        if (first) slice.set(head);
        const offset = first ? head.length : 0;
        for (let i = 0; i < part.length; i++) slice[offset + i] = part[i]! ^ mask[(at + i) & 3]!;
        yield slice;
        at += part.length;
        first = false;
    }
}

/** Server frames in, whole messages and control frames out; throws WsError on anything RFC 6455 forbids a server to send. */
export class WsDecoder {
    /** Bytes held across every socket's decoder: unparsed frames and fragments in assembly. */
    readonly #budget: { used: number; max: number };
    #chunks: Uint8Array[] = [];
    #size = 0;
    #parts: Uint8Array[] = [];
    #partSize = 0;
    #partOp = 0;

    constructor(budget: { used: number; max: number }) {
        this.#budget = budget;
    }

    push(bytes: Uint8Array): WsEvent[] {
        this.#chunks.push(bytes);
        this.#size += bytes.length;
        this.#budget.used += bytes.length;
        if (this.#budget.used > this.#budget.max) throw new WsError(1009, "too much WebSocket data held at once");
        const events: WsEvent[] = [];
        while (this.#size >= 2) {
            const head = this.#peek(Math.min(this.#size, 10));
            const [b0 = 0, b1 = 0] = head;
            if (b0 & 0x70) throw new WsError(1002, "reserved bits set");
            if (b1 & 0x80) throw new WsError(1002, "a server frame was masked");
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            let length = b1 & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (head.length < 4) break;
                length = (head[2]! << 8) | head[3]!;
                offset = 4;
            } else if (length === 127) {
                if (head.length < 10) break;
                const view = new DataView(head.buffer, head.byteOffset, 10);
                const high = view.getUint32(2);
                if (high >= 0x80000000) throw new WsError(1002, "a 64-bit length with its top bit set");
                length = high * 2 ** 32 + view.getUint32(6);
                offset = 10;
            }
            if (opcode >= 8 && (!fin || length > 125)) throw new WsError(1002, "a fragmented or oversized control frame");
            if (opcode < 8 && this.#partSize + length > WS_MESSAGE_MAX) throw new WsError(1009, "a message over 64 MiB");
            if (this.#size < offset + length) break;
            const frame = this.#take(offset + length).subarray(offset);
            this.#budget.used -= offset;
            if (opcode === 0 || opcode === OP_TEXT || opcode === OP_BINARY) {
                if ((opcode === 0) !== (this.#partOp !== 0)) throw new WsError(1002, opcode === 0 ? "a continuation with no message" : "a new message inside a fragmented one");
                if (opcode !== 0) this.#partOp = opcode;
                this.#parts.push(frame);
                this.#partSize += frame.length;
                if (fin) events.push(this.#message());
                continue;
            }
            this.#budget.used -= frame.length;
            if (opcode === OP_PING) events.push({ kind: "ping", data: frame.slice() });
            else if (opcode === OP_PONG) events.push({ kind: "pong" });
            else if (opcode === OP_CLOSE) {
                if (frame.length === 1) throw new WsError(1002, "a one-byte close payload");
                const code = frame.length >= 2 ? (frame[0]! << 8) | frame[1]! : null;
                if (code !== null && !((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))) {
                    throw new WsError(1002, "an invalid close code");
                }
                let reason = "";
                try {
                    reason = strict.decode(frame.subarray(2));
                } catch {
                    throw new WsError(1007, "a close reason that is not UTF-8");
                }
                events.push({ kind: "close", code, reason });
            } else throw new WsError(1002, "an unknown opcode");
        }
        return events;
    }

    /** The socket is gone: hand back what it held. */
    release(): void {
        this.#budget.used -= this.#size + this.#partSize;
        this.#chunks = [];
        this.#parts = [];
        this.#size = 0;
        this.#partSize = 0;
    }

    #message(): WsEvent {
        const data = this.#parts.length === 1 ? this.#parts[0]! : new Uint8Array(this.#partSize);
        if (this.#parts.length > 1) this.#parts.reduce((at, part) => (data.set(part, at), at + part.length), 0);
        const op = this.#partOp;
        this.#budget.used -= this.#partSize;
        this.#parts = [];
        this.#partSize = 0;
        this.#partOp = 0;
        if (op === OP_BINARY) return { kind: "binary", data };
        try {
            return { kind: "text", data: strict.decode(data) };
        } catch {
            throw new WsError(1007, "a text message that is not UTF-8");
        }
    }

    #peek(n: number): Uint8Array {
        const first = this.#chunks[0]!;
        if (first.length >= n) return first.subarray(0, n);
        const out = new Uint8Array(n);
        let at = 0;
        for (const chunk of this.#chunks) {
            const take = Math.min(chunk.length, n - at);
            out.set(chunk.subarray(0, take), at);
            at += take;
            if (at === n) break;
        }
        return out;
    }

    #take(n: number): Uint8Array {
        this.#size -= n;
        const first = this.#chunks[0]!;
        if (first.length >= n) {
            if (first.length === n) this.#chunks.shift();
            else this.#chunks[0] = first.subarray(n);
            return first.subarray(0, n);
        }
        const out = new Uint8Array(n);
        let at = 0;
        while (at < n) {
            const chunk = this.#chunks[0]!;
            const take = Math.min(chunk.length, n - at);
            out.set(chunk.subarray(0, take), at);
            at += take;
            if (take === chunk.length) this.#chunks.shift();
            else this.#chunks[0] = chunk.subarray(take);
        }
        return out;
    }
}
