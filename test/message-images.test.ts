// message-images.ts over the real api.ts, with channel.ts stubbed by a fake gateway that serves GET …/messages/:id/images.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const CHANNEL = stub(
    "export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }" +
    "export const apiFetch = (path, init) => globalThis.__apiFetch(path, init);" +
    "export const readJson = async (c) => JSON.parse(await c.res.text());" +
    "export const refusal = async (c) => (await c.res.json()).error ?? '';",
);

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.endsWith("/src/api.ts")) return { url: CHANNEL, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

// what the gateway holds per message path; every answer waits until the test releases it, so the order of requests is visible
const stored = new Map<string, string[]>();
const asked: { path: string; signal: AbortSignal | undefined; release: () => void }[] = [];

Object.assign(globalThis, {
    __apiFetch: (path: string, init: RequestInit = {}): Promise<{ res: Response }> => new Promise((resolve, reject) => {
        const signal = init.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        asked.push({
            path,
            signal,
            release: () => {
                const images = stored.get(path);
                resolve({ res: images ? Response.json({ images }) : Response.json({ error: "no such message" }, { status: 404 }) });
            },
        });
    }),
});

const { cachedImages, IMAGE_CACHE_BYTES, imagesKey, loadImages, seedImages } = await import("../src/message-images.ts");

const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const uri = (n: number, length = 40): string => `data:image/jpeg;base64,${String(n).padEnd(length - 23, "A")}`;
const path = (id: number): string => `/agents/scout/conversations/7/messages/${id}/images`;

test("one fetch at a time, in the order asked, over GET …/messages/:id/images; a second ask for the same message waits and takes the first one's answer", async () => {
    stored.set(path(10), [uri(1), uri(2)]);
    stored.set(path(11), [uri(3)]);
    asked.length = 0;
    const first = loadImages(imagesKey("scout", 7, 10), new AbortController().signal);
    const second = loadImages(imagesKey("scout", 7, 11), new AbortController().signal);
    const again = loadImages(imagesKey("scout", 7, 10), new AbortController().signal);
    await flush();
    assert.deepEqual(asked.map((a) => a.path), [path(10)], "the second waits for the first");
    asked[0]?.release();
    assert.deepEqual(await first, [uri(1), uri(2)]);
    await flush();
    assert.deepEqual(asked.map((a) => a.path), [path(10), path(11)]);
    asked[1]?.release();
    assert.deepEqual(await second, [uri(3)]);
    assert.deepEqual(await again, [uri(1), uri(2)]);
    await flush();
    assert.equal(asked.length, 2, "the repeat ask is answered from the cache, never fetched again");
    assert.deepEqual(await loadImages(imagesKey("scout", 7, 11), new AbortController().signal), [uri(3)]);
    assert.equal(asked.length, 2);
});

test("an abort while waiting takes the ask out of line unfetched; one during its fetch aborts the request, and the next in line goes", async () => {
    stored.set(path(20), [uri(20)]);
    stored.set(path(21), [uri(21)]);
    stored.set(path(22), [uri(22)]);
    asked.length = 0;
    const going = new AbortController();
    const waiting = new AbortController();
    const fetching = loadImages(imagesKey("scout", 7, 20), going.signal);
    const parked = loadImages(imagesKey("scout", 7, 21), waiting.signal);
    const last = loadImages(imagesKey("scout", 7, 22), new AbortController().signal);
    await flush();
    waiting.abort(new Error("off screen"));
    await assert.rejects(parked, /off screen/);
    going.abort(new Error("left"));
    await assert.rejects(fetching, /left/);
    assert.equal(asked[0]?.signal?.aborted, true, "the request itself is aborted, not only its answer dropped");
    await flush();
    assert.deepEqual(asked.map((a) => a.path), [path(20), path(22)], "21 was never asked for");
    asked[1]?.release();
    assert.deepEqual(await last, [uri(22)]);
    assert.equal(cachedImages(imagesKey("scout", 7, 20)), undefined, "an aborted fetch caches nothing");
    const gone = new AbortController();
    gone.abort(new Error("already gone"));
    await assert.rejects(loadImages(imagesKey("scout", 7, 23), gone.signal), /already gone/);
});

test("a refusal or an answer that is not image data-URIs rejects and caches nothing, and the line moves on", async () => {
    stored.set(path(31), ["javascript:alert(1)"]);
    stored.set(path(32), [uri(32)]);
    asked.length = 0;
    const missing = assert.rejects(loadImages(imagesKey("scout", 7, 30), new AbortController().signal), /404: no such message/);
    const odd = assert.rejects(loadImages(imagesKey("scout", 7, 31), new AbortController().signal), /carried no images/);
    const fine = loadImages(imagesKey("scout", 7, 32), new AbortController().signal);
    for (let i = 0; i < 3; i++) {
        await flush();
        asked[i]?.release();
    }
    await missing;
    await odd;
    assert.deepEqual(await fine, [uri(32)]);
    assert.equal(cachedImages(imagesKey("scout", 7, 30)), undefined);
    assert.equal(cachedImages(imagesKey("scout", 7, 31)), undefined);
});

test("the message just sent is seeded under its seq and served without a fetch; seeding nothing keeps what is there", async () => {
    asked.length = 0;
    const key = imagesKey("scout", 7, 40);
    seedImages(key, [uri(40), uri(41)]);
    seedImages(key, []);
    assert.deepEqual(await loadImages(key, new AbortController().signal), [uri(40), uri(41)]);
    await flush();
    assert.equal(asked.length, 0);
});

test("the cache holds at most IMAGE_CACHE_BYTES of data-URI length, the least recently used going first", () => {
    assert.equal(IMAGE_CACHE_BYTES, 48 * 1024 * 1024);
    // one message's worth at most: 32 images of 480 000 chars
    const third = "x".repeat(IMAGE_CACHE_BYTES / 3);
    const [a, b, c, d] = [imagesKey("scout", 8, 50), imagesKey("scout", 8, 51), imagesKey("scout", 8, 52), imagesKey("scout", 8, 53)];
    seedImages(a, [third]);
    seedImages(b, [third]);
    seedImages(c, [third]);
    assert.ok(cachedImages(b) && cachedImages(c), "three thirds fit exactly, the smaller entries before them gone");
    assert.ok(cachedImages(a), "a is now the most recently used");
    seedImages(d, [third]);
    assert.equal(cachedImages(b), undefined, "b was the least recently used");
    assert.ok(cachedImages(a) && cachedImages(c) && cachedImages(d));
    assert.equal(cachedImages(imagesKey("scout", 7, 40)), undefined, "the small entries went long before");
    seedImages(c, [third.slice(1)]);
    assert.ok(cachedImages(a) && cachedImages(c) && cachedImages(d), "a seed of a held key replaces it rather than counting twice");
    seedImages(imagesKey("scout", 8, 54), ["y".repeat(IMAGE_CACHE_BYTES + 1)]);
    assert.equal(cachedImages(imagesKey("scout", 8, 54)), undefined, "a message larger than the whole cache is not kept");
    assert.ok(cachedImages(a) && cachedImages(c) && cachedImages(d), "and evicts nothing");
});
