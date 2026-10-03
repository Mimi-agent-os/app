// SHA-1 (the WebSocket accept check) and SHA-256/384/512 (fetch integrity) for the relay: the pult may not be a secure context, so crypto.subtle is never assumed.

export type HashName = "sha1" | "sha256" | "sha384" | "sha512";
type Word = [number, number];

// FIPS 180-4: the first `bits` bits of the fractional parts of the square (degree 2) or cube (degree 3) roots of the primes after the first `skip`
function rootFractions(count: number, skip: number, degree: bigint, bits: bigint): bigint[] {
    const primes: bigint[] = [];
    for (let n = 2n; primes.length < count + skip; n++) if (primes.every((p) => n % p !== 0n)) primes.push(n);
    return primes.slice(skip).map((p) => {
        const target = p << (degree * bits);
        let x = 1n << ((degree * bits + 9n) / degree + 1n);
        for (;;) {
            const next = ((degree - 1n) * x + target / x ** (degree - 1n)) / degree;
            if (next >= x) return x & ((1n << bits) - 1n);
            x = next;
        }
    });
}

const split64 = (values: bigint[]): Uint32Array => Uint32Array.from(values.flatMap((v) => [Number(v >> 32n), Number(v & 0xffffffffn)]));
const SHA1_H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];
const K256 = Uint32Array.from(rootFractions(64, 0, 3n, 32n), Number);
const K512 = split64(rootFractions(80, 0, 3n, 64n));
const INITIAL: Record<HashName, Uint32Array> = {
    sha1: Uint32Array.from(SHA1_H),
    sha256: Uint32Array.from(rootFractions(8, 0, 2n, 32n), Number),
    sha384: split64(rootFractions(8, 8, 2n, 64n)),
    sha512: split64(rootFractions(8, 0, 2n, 64n)),
};
const OUT_BYTES: Record<HashName, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
const rotr64 = ([hi, lo]: Word, n: number): Word => n < 32
    ? [(hi >>> n) | (lo << (32 - n)), (lo >>> n) | (hi << (32 - n))]
    : [(lo >>> (n - 32)) | (hi << (64 - n)), (hi >>> (n - 32)) | (lo << (64 - n))];
const shr64 = ([hi, lo]: Word, n: number): Word => [hi >>> n, (lo >>> n) | (hi << (32 - n))];
const xor64 = (a: Word, b: Word, c: Word): Word => [a[0] ^ b[0] ^ c[0], a[1] ^ b[1] ^ c[1]];
function add64(...words: Word[]): Word {
    let hi = 0;
    let lo = 0;
    for (const [h, l] of words) {
        hi += h >>> 0;
        lo += l >>> 0;
    }
    return [(hi + Math.floor(lo / 2 ** 32)) >>> 0, lo >>> 0];
}

/** One incremental digest: update() as the bytes stream, digest() once. */
export class Hash {
    readonly #name: HashName;
    readonly #state: Uint32Array;
    readonly #block: Uint8Array;
    readonly #view: DataView;
    readonly #w: Uint32Array;
    #filled = 0;
    #length = 0;

    constructor(name: HashName) {
        this.#name = name;
        this.#state = INITIAL[name].slice();
        const wide = name === "sha384" || name === "sha512";
        this.#block = new Uint8Array(wide ? 128 : 64);
        this.#view = new DataView(this.#block.buffer);
        this.#w = new Uint32Array(wide ? 160 : 80);
    }

    update(data: Uint8Array): void {
        for (let at = 0; at < data.length;) {
            const take = Math.min(this.#block.length - this.#filled, data.length - at);
            this.#block.set(data.subarray(at, at + take), this.#filled);
            this.#filled += take;
            at += take;
            if (this.#filled === this.#block.length) {
                this.#compress();
                this.#filled = 0;
            }
        }
        this.#length += data.length;
    }

    digest(): Uint8Array {
        const size = this.#block.length;
        const bits = this.#length * 8;
        this.#block[this.#filled++] = 0x80;
        // the length field takes the last 8 bytes of a 64-byte block, the last 16 of a 128-byte one
        if (this.#filled > size - size / 8) {
            this.#block.fill(0, this.#filled);
            this.#compress();
            this.#filled = 0;
        }
        this.#block.fill(0, this.#filled);
        this.#view.setUint32(size - 8, Math.floor(bits / 2 ** 32));
        this.#view.setUint32(size - 4, bits >>> 0);
        this.#compress();
        const out = new DataView(new ArrayBuffer(OUT_BYTES[this.#name]));
        for (let i = 0; i < out.byteLength / 4; i++) out.setUint32(i * 4, this.#state[i]!);
        return new Uint8Array(out.buffer);
    }

    #compress(): void {
        const s = this.#state;
        const w = this.#w;
        const v = this.#view;
        if (this.#name === "sha1") {
            for (let t = 0; t < 16; t++) w[t] = v.getUint32(t * 4);
            for (let t = 16; t < 80; t++) w[t] = rotr(w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!, 31);
            let [a, b, c, d, e] = [s[0]!, s[1]!, s[2]!, s[3]!, s[4]!];
            for (let t = 0; t < 80; t++) {
                const f = t < 20 ? (b & c) | (~b & d) : t < 40 || t >= 60 ? b ^ c ^ d : (b & c) | (b & d) | (c & d);
                const next = (rotr(a, 27) + f + e + SHA1_K[Math.floor(t / 20)]! + w[t]!) | 0;
                [a, b, c, d, e] = [next, a, rotr(b, 2), c, d];
            }
            [a, b, c, d, e].forEach((x, i) => { s[i] = s[i]! + x; });
        } else if (this.#name === "sha256") {
            for (let t = 0; t < 16; t++) w[t] = v.getUint32(t * 4);
            for (let t = 16; t < 64; t++) {
                const x = w[t - 15]!;
                const y = w[t - 2]!;
                w[t] = w[t - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[t - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
            }
            let [a, b, c, d, e, f, g, h] = [s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!, s[6]!, s[7]!];
            for (let t = 0; t < 64; t++) {
                const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t]! + w[t]!) | 0;
                const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                [a, b, c, d, e, f, g, h] = [(t1 + t2) | 0, a, b, c, (d + t1) | 0, e, f, g];
            }
            [a, b, c, d, e, f, g, h].forEach((x, i) => { s[i] = s[i]! + x; });
        } else {
            const word = (array: Uint32Array, t: number): Word => [array[2 * t]!, array[2 * t + 1]!];
            for (let t = 0; t < 32; t++) w[t] = v.getUint32(t * 4);
            for (let t = 16; t < 80; t++) {
                const x = word(w, t - 15);
                const y = word(w, t - 2);
                const sum = add64(word(w, t - 16), xor64(rotr64(x, 1), rotr64(x, 8), shr64(x, 7)), word(w, t - 7), xor64(rotr64(y, 19), rotr64(y, 61), shr64(y, 6)));
                w.set(sum, 2 * t);
            }
            let x: [Word, Word, Word, Word, Word, Word, Word, Word] = [word(s, 0), word(s, 1), word(s, 2), word(s, 3), word(s, 4), word(s, 5), word(s, 6), word(s, 7)];
            for (let t = 0; t < 80; t++) {
                const [a, b, c, d, e, f, g, h] = x;
                const ch: Word = [(e[0] & f[0]) ^ (~e[0] & g[0]), (e[1] & f[1]) ^ (~e[1] & g[1])];
                const maj: Word = [(a[0] & b[0]) ^ (a[0] & c[0]) ^ (b[0] & c[0]), (a[1] & b[1]) ^ (a[1] & c[1]) ^ (b[1] & c[1])];
                const t1 = add64(h, xor64(rotr64(e, 14), rotr64(e, 18), rotr64(e, 41)), ch, word(K512, t), word(w, t));
                const t2 = add64(xor64(rotr64(a, 28), rotr64(a, 34), rotr64(a, 39)), maj);
                x = [add64(t1, t2), a, b, c, add64(d, t1), e, f, g];
            }
            x.forEach((one, i) => s.set(add64(word(s, i), one), 2 * i));
        }
    }
}

export function base64(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}
