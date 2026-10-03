// Settings, Limits & prices. limits.ts and api.ts run for real, api.ts over a stub channel that answers like the gateway's
// /api/limits; limits.tsx is JSX no plain Node runner imports, so only its wiring is read from the source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import type { LimitRow } from "../src/api.ts";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const CHANNEL = stub(
    "export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }" +
    "export const apiFetch = (path, init = {}) => globalThis.__fetch(path, init);" +
    "export const readJson = async (c) => JSON.parse(await c.res.text());" +
    "export const refusal = async (c) => JSON.parse(await c.res.text()).error ?? '';",
);
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.endsWith("/src/api.ts")) return { url: CHANNEL, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const DAY = { today: "2026-09-29", timeZone: "Europe/Helsinki", resetsAt: "2026-09-29T21:00:00.000Z" };
const row = (over: Partial<LimitRow> = {}): LimitRow => ({
    uid: "uid-fast", name: "fast", provider: "openai", priceInPerM: 0, priceOutPerM: 0, limit: null,
    today: { tokens: 0, promptTokens: 0, completionTokens: 0, cost: 0 }, day: DAY, ...over,
});

// the gateway's registry: one model, whatever the last PATCH made it
let held = row();
const requests: { method: string; path: string; body: unknown }[] = [];
Object.assign(globalThis, {
    __fetch: (path: string, init: { method?: string; body?: string }) => {
        const method = init.method ?? "GET";
        const body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>;
        requests.push({ method, path, body });
        if (method === "GET" && path === "/limits") return Promise.resolve({ res: new Response(JSON.stringify([held])) });
        if (method === "PATCH" && path === "/limits/fast%2Fv2") {
            if (!body || Object.keys(body).length === 0) return Promise.resolve({ res: new Response(JSON.stringify({ error: "nothing to change" }), { status: 400 }) });
            held = { ...held, ...body } as LimitRow;
            return Promise.resolve({ res: new Response(JSON.stringify(held)) });
        }
        return Promise.resolve({ res: new Response(JSON.stringify({ error: "no such model" }), { status: 404 }) });
    },
});

const { listLimits, patchLimit } = await import("../src/api.ts");
const { draftOf, limitUse, readDraft } = await import("../src/limits.ts");

test("a price or limit edit is sent as only what changed, by model name, and the answer is the new row", async () => {
    held = row({ name: "fast/v2" });
    requests.length = 0;
    const [listed] = await listLimits();
    assert.ok(listed);
    const { patch } = readDraft(listed, { ...draftOf(listed), priceOut: "15", value: "2000000" });
    assert.deepEqual(patch, { priceOutPerM: 15, limit: { unit: "tokens", value: 2_000_000 } }, "the untouched input price stays out");
    const saved = await patchLimit(listed.name, patch!);
    assert.deepEqual(requests, [
        { method: "GET", path: "/limits", body: undefined },
        { method: "PATCH", path: "/limits/fast%2Fv2", body: { priceOutPerM: 15, limit: { unit: "tokens", value: 2_000_000 } } },
    ]);
    assert.equal(saved.priceOutPerM, 15);
    assert.deepEqual(readDraft(saved, draftOf(saved)).patch, {}, "the saved row reads back as nothing to save");
    await assert.rejects(patchLimit("gone", { priceInPerM: 1 }), /404: no such model/);
});

test("clearing the limit sends null, and an empty price is 0", () => {
    const limited = row({ priceInPerM: 3, priceOutPerM: 15, limit: { unit: "usd", value: 5 } });
    assert.deepEqual(readDraft(limited, { ...draftOf(limited), value: "" }).patch, { limit: null });
    assert.deepEqual(readDraft(limited, { ...draftOf(limited), priceIn: " " }).patch, { priceInPerM: 0 });
    assert.deepEqual(readDraft(limited, { ...draftOf(limited), value: "5.00" }).patch, {}, "the same amount typed differently changes nothing");
    assert.deepEqual(readDraft(limited, { ...draftOf(limited), unit: "tokens", value: "5" }).patch, { limit: { unit: "tokens", value: 5 } });
});

test("beside a token limit the worst case in dollars, beside a dollar limit the fewest tokens, both at the output price", () => {
    const priced = row({ priceInPerM: 3, priceOutPerM: 15 });
    assert.equal(readDraft(priced, { ...draftOf(priced), value: "1000000" }).hint, "≈ up to $15.00");
    assert.equal(readDraft(priced, { ...draftOf(priced), unit: "usd", value: "5" }).hint, "≈ at least 333,333 tokens");
    assert.equal(readDraft(priced, { ...draftOf(priced), priceOut: "10", unit: "usd", value: "5" }).hint, "≈ at least 500,000 tokens", "the typed price, before it is saved");
    assert.equal(readDraft(priced, draftOf(priced)).hint, "", "no limit, no hint");
    const free = row();
    assert.equal(readDraft(free, { ...draftOf(free), value: "1000000" }).hint, "", "no output price, no dollar figure");
    assert.equal(readDraft(free, { ...draftOf(free), unit: "usd", value: "5" }).hint, "A dollar limit on a model without prices is never reached. Set a price first.");
});

test("an invalid field blocks the save and says why", () => {
    const base = draftOf(row());
    for (const [draft, why] of [
        [{ ...base, value: "1.5" }, /positive whole number/],
        [{ ...base, value: "0" }, /positive whole number/],
        [{ ...base, unit: "usd", value: "0" }, /above 0/],
        [{ ...base, unit: "usd", value: "five" }, /above 0/],
        [{ ...base, priceIn: "-1" }, /0 or more/],
        [{ ...base, priceOut: "abc" }, /0 or more/],
    ] as const) {
        const read = readDraft(row(), draft);
        assert.equal(read.patch, null, JSON.stringify(draft));
        assert.match(read.error, why);
    }
    assert.equal(readDraft(row(), { ...base, unit: "usd", value: "0.5" }).error, "");
});

test("today's use reads in the limit's own unit, cost only where the model is priced", () => {
    assert.deepEqual(limitUse(row({ today: { tokens: 1200, promptTokens: 1000, completionTokens: 200, cost: 0 } })), { text: "1,200 tokens", fraction: null, reached: false });
    const tokens = limitUse(row({ limit: { unit: "tokens", value: 1000 }, today: { tokens: 1200, promptTokens: 1000, completionTokens: 200, cost: 0.02 } }));
    assert.deepEqual(tokens, { text: "1,200 of 1,000 tokens · $0.02", fraction: 1, reached: true });
    const dollars = limitUse(row({ limit: { unit: "usd", value: 5 }, today: { tokens: 0, promptTokens: 0, completionTokens: 0, cost: 0 } }));
    assert.deepEqual(dollars, { text: "$0.00 of $5.00 · 0 tokens", fraction: 0, reached: false });
    assert.equal(limitUse(row({ limit: { unit: "usd", value: 5 }, today: { tokens: 90_000, promptTokens: 80_000, completionTokens: 10_000, cost: 2.5 } })).fraction, 0.5);
});

test("Limits & prices is its own Settings section, next to Models, and refreshes on usage", async () => {
    const route = await readFile(new URL("../src/route.ts", import.meta.url), "utf8");
    assert.match(route, /SETTINGS_SECTIONS = \[[^\]]*"models", "limits", /);
    assert.match(route, /\{ v: "limits", label: "Limits & prices", /);
    const settings = await readFile(new URL("../src/views/gateway.tsx", import.meta.url), "utf8");
    assert.match(settings, /\{current === "limits" && <LimitsPanel \/>\}/);
    const view = await readFile(new URL("../src/views/limits.tsx", import.meta.url), "utf8");
    assert.match(view, /addEventListener\("mimi:usage-changed", refresh\)/);
    assert.match(view, /patchLimit\(row\.name, patch\)/, "saved by the model's current name");
    assert.match(view, /\$\{reached\} at \$\{plural\(reached, "its", "their"\)\} daily limit/, "two models are at their limit, not its");
    assert.match(view, /model checks still run/, "a limit never refuses a model check, and the note says so");
});
