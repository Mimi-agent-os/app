// avatars.ts over the real api.ts, with channel.ts stubbed by a fake gateway that serves avatars the way the gateway's route does.
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const CHANNEL = stub(
    "export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }" +
    "export const apiFetch = (path, init) => globalThis.__apiFetch(path, init);" +
    "export const readJson = async (c) => JSON.parse(await c.res.text());" +
    "export const refusal = async () => '';",
);
const REACT = stub("export const useSyncExternalStore = (subscribe, getSnapshot) => { globalThis.__subscribe = subscribe; return getSnapshot(); };");

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.endsWith("/src/api.ts")) return { url: CHANNEL, shortCircuit: true };
        if (specifier === "react" && context.parentURL?.endsWith("/src/avatars.ts")) return { url: REACT, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

interface Stored { type: string; bytes: Uint8Array; sha256: string }
const picture = (type: string, ...bytes: number[]): Stored => {
    const data = new Uint8Array(bytes);
    return { type, bytes: data, sha256: createHash("sha256").update(data).digest("hex") };
};
const PNG = picture("image/png", 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1);
const PNG2 = picture("image/png", 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2);
const JPEG = picture("image/jpeg", 0xff, 0xd8, 0xff, 3);

// what the gateway holds per agent; `type` overrides the content-type it answers, and while `held` is set every answer waits for release
const gateway = new Map<string, Stored & { served?: string }>();
const fetched: string[] = [];
let held: (() => void)[] | null = null;

Object.assign(globalThis, {
    __apiFetch: (path: string): Promise<{ res: Response }> => {
        fetched.push(path);
        const answer = (): { res: Response } => {
            const name = decodeURIComponent(/^\/agents\/([^/]+)\/avatar\?v=/.exec(path)?.[1] ?? "");
            const avatar = gateway.get(name);
            if (!avatar) return { res: Response.json({ error: "no avatar" }, { status: 404 }) };
            return { res: new Response(avatar.bytes, { headers: { "content-type": avatar.served ?? avatar.type, etag: `"${avatar.sha256}"`, "x-content-type-options": "nosniff" } }) };
        };
        const queue = held;
        if (!queue) return Promise.resolve(answer());
        return new Promise((resolve) => { queue.push(() => resolve(answer())); });
    },
});

const { setAvatars, useAvatar } = await import("../src/avatars.ts");

let notified = 0;
useAvatar("nobody");
(globalThis as unknown as { __subscribe: (listener: () => void) => () => void }).__subscribe(() => { notified++; });

const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const roster = (...rows: [string, Stored | null][]): void => setAvatars(rows.map(([name, a]) => ({ name, avatar: a?.sha256 ?? null })));
const bytesOf = async (url: string | null): Promise<{ type: string; bytes: number[] } | undefined> => {
    const blob = url === null ? undefined : resolveObjectURL(url);
    return blob && { type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
};

test("an agent's avatar loads once per hash into a blob URL; an agent with none, or not in the roster, has none", async () => {
    gateway.set("scout", PNG);
    fetched.length = 0;
    const before = notified;
    roster(["scout", PNG], ["plain", null]);
    assert.equal(useAvatar("scout"), null, "the letter shows while it loads");
    await flush();
    const url = useAvatar("scout");
    assert.match(url ?? "", /^blob:/);
    assert.deepEqual(await bytesOf(url), { type: "image/png", bytes: [...PNG.bytes] });
    assert.deepEqual(fetched, [`/agents/scout/avatar?v=${PNG.sha256}`]);
    assert.ok(notified > before, "the marks re-render when it lands");
    assert.equal(useAvatar("plain"), null);
    assert.equal(useAvatar("stranger"), null);

    // every roster answer calls in again: a known hash is neither refetched nor replaced
    roster(["scout", PNG], ["plain", null]);
    await flush();
    assert.equal(fetched.length, 1);
    assert.equal(useAvatar("scout"), url);
});

test("a changed hash loads the new picture and revokes the old URL; a removed avatar revokes it too", async () => {
    gateway.set("scout", PNG);
    roster(["scout", PNG]);
    await flush();
    const old = useAvatar("scout");
    assert.ok(old);

    gateway.set("scout", JPEG);
    fetched.length = 0;
    roster(["scout", JPEG]);
    assert.equal(resolveObjectURL(old), undefined, "the old blob URL is revoked");
    await flush();
    const next = useAvatar("scout");
    assert.notEqual(next, old);
    assert.deepEqual(await bytesOf(next), { type: "image/jpeg", bytes: [...JPEG.bytes] });
    assert.deepEqual(fetched, [`/agents/scout/avatar?v=${JPEG.sha256}`]);

    gateway.delete("scout");
    roster(["scout", null]);
    assert.equal(useAvatar("scout"), null);
    assert.equal(resolveObjectURL(next ?? ""), undefined);
});

test("two agents shipping the same picture share one load and one URL, kept until neither names it", async () => {
    gateway.set("a", PNG2);
    gateway.set("b", PNG2);
    fetched.length = 0;
    roster(["a", PNG2], ["b", PNG2]);
    await flush();
    assert.equal(fetched.length, 1);
    const shared = useAvatar("a");
    assert.ok(shared);
    assert.equal(useAvatar("b"), shared);

    roster(["a", null], ["b", PNG2]);
    assert.equal(useAvatar("b"), shared);
    assert.ok(resolveObjectURL(shared), "still named by b");
    roster(["a", null], ["b", null]);
    assert.equal(resolveObjectURL(shared), undefined);
});

test("a reply for another hash, a 404 or a non-raster type is never cached, and the next roster answer tries again", async () => {
    // the agent changed its avatar between the roster read and the fetch
    gateway.set("scout", JPEG);
    fetched.length = 0;
    roster(["scout", PNG]);
    await flush();
    assert.equal(useAvatar("scout"), null);

    gateway.set("scout", PNG);
    roster(["scout", PNG]);
    await flush();
    assert.equal(fetched.length, 2, "retried");
    assert.deepEqual(await bytesOf(useAvatar("scout")), { type: "image/png", bytes: [...PNG.bytes] });
    roster(["scout", null]);

    gateway.delete("scout");
    roster(["scout", PNG2]);
    await flush();
    assert.equal(useAvatar("scout"), null, "404");

    for (const served of ["image/svg+xml", "text/html", "image/png; charset=utf-8"]) {
        gateway.set("scout", { ...PNG2, served });
        roster(["scout", null]);
        roster(["scout", PNG2]);
        await flush();
        assert.equal(useAvatar("scout"), null, served);
    }
    roster(["scout", null]);
});

test("a load that lands after the roster moved on leaves no blob URL behind", async () => {
    gateway.set("scout", PNG);
    held = [];
    roster(["scout", PNG]);
    roster(["scout", null]);
    const release = held;
    held = null;
    release.forEach((go) => go());
    await flush();
    assert.equal(useAvatar("scout"), null);

    // the same hash coming back loads it fresh
    roster(["scout", PNG]);
    await flush();
    assert.deepEqual(await bytesOf(useAvatar("scout")), { type: "image/png", bytes: [...PNG.bytes] });
});
