// The Calls view and a chat's per-message token data. api.ts runs for real over a stub channel that answers like the gateway
// (a chat filter, a 500-call cap); chat.tsx is JSX no plain Node runner imports, so its row text, header and meter are lifted
// out of the source and run on their own. The audit's cases: every Calls row read "undefined→N" and the header "0 in"; a chat
// lost its meter once the agent made 500 calls elsewhere; a renamed model's meter used the default model's window.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import type { HistoryMessage, LlmCallInfo, ModelSummary } from "../src/api.ts";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const CHANNEL = stub(
    "export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }" +
    "export const apiFetch = (path, init = {}) => globalThis.__fetch(path, init);" +
    "export const readJson = async (c) => JSON.parse(await c.res.text());" +
    "export const refusal = async () => '';",
);
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.endsWith("/src/api.ts")) return { url: CHANNEL, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const call = (id: number, over: Partial<LlmCallInfo> = {}): LlmCallInfo => ({
    id, conversationId: 9, scope: "wren:chat", callId: `c${id}`, callKind: "turn", model: "qwen3", modelUid: "uid-fast", registryModel: "fast",
    requestedModel: "qwen3", reportedModel: null, attempt: 1, parentCallId: null, turnSeq: null,
    messageSeqs: [], finishReason: "stop", promptTokens: 1000, completionTokens: 40, cachedTokens: null, usageEstimated: false, cost: 0,
    durationMs: 900, tokensPerSec: 44, createdAt: "2026-09-29 10:00:00", ...over,
});

// what the gateway holds: chat 4's two turns, then 600 calls in chat 9
const calls: LlmCallInfo[] = [
    call(1, { conversationId: 4, messageSeqs: [2], promptTokens: 8000, completionTokens: 300 }),
    call(2, { conversationId: 4, messageSeqs: [4], promptTokens: 8400, completionTokens: 120, usageEstimated: true, finishReason: "stopped" }),
    ...Array.from({ length: 600 }, (_, i) => call(i + 3)),
];
const history: HistoryMessage[] = [
    { id: 1, role: "user", content: "hi", at: "2026-09-29 10:00:00" },
    { id: 2, role: "assistant", content: "hello", meta: { callId: "c1", registryModel: "fast" }, at: "2026-09-29 10:00:01" },
    { id: 3, role: "user", content: "more", at: "2026-09-29 10:01:00" },
    { id: 4, role: "assistant", content: "half [stopped by user]", meta: { callId: "c2", registryModel: "fast" }, at: "2026-09-29 10:01:02" },
];
const requests: string[] = [];
Object.assign(globalThis, {
    __fetch: (path: string) => {
        requests.push(path);
        const url = new URL(path, "http://gateway");
        if (url.pathname === "/agents/wren/calls") {
            const conversation = url.searchParams.get("conversation");
            const limit = Math.min(500, Number(url.searchParams.get("limit")));
            const rows = calls.filter((c) => conversation === null || c.conversationId === Number(conversation)).sort((a, b) => b.id - a.id).slice(0, limit);
            return Promise.resolve({ res: new Response(JSON.stringify(rows)) });
        }
        if (url.pathname === "/agents/wren/conversations/4/messages") return Promise.resolve({ res: new Response(JSON.stringify({ items: history, hasMore: false })) });
        return Promise.resolve({ res: new Response("{}", { status: 404 }) });
    },
});

const { listHistory, listLlmCalls } = await import("../src/api.ts");
const { kilo, plural } = await import("../src/shared.ts");
const { usd } = await import("../src/spend.ts");

test("a chat's history reads only its own calls, however many the agent made elsewhere", async () => {
    requests.length = 0;
    const page = await listHistory("wren", 4, 60);
    assert.ok(requests.includes("/agents/wren/calls?limit=500&conversation=4"), "the history asks for this chat's calls");
    const [, first, , second] = page.items;
    assert.equal(first?.meta?.promptTokens, 8000, "600 newer calls in another chat do not push this one out");
    assert.equal(first?.meta?.modelUid, "uid-fast", "the meter can find the model by its uid");
    assert.equal(first?.meta?.usageEstimated, false);
    assert.equal(second?.meta?.usageEstimated, true, "a stopped call's tokens are marked as the estimate they are");
});

test("the Calls list asks for the agent's newest calls, or one chat's", async () => {
    requests.length = 0;
    assert.equal((await listLlmCalls("wren", 100)).length, 100);
    assert.equal((await listLlmCalls("wren", 100, 4)).length, 2);
    assert.deepEqual(requests, ["/agents/wren/calls?limit=100", "/agents/wren/calls?limit=100&conversation=4"]);
});

// ── the Calls view, as chat.tsx declares it ───────────────────────────────────

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const tokensExpr = /const tokens = ([\s\S]*?);\n/.exec(source);
assert.ok(tokensExpr, "chat.tsx states a call's tokens in one expression");
const tokens = new Function("call", "kilo", "usd", `return ${tokensExpr[1] as string};`) as (call: LlmCallInfo, k: typeof kilo, u: typeof usd) => string;
const shown = /const CALLS_SHOWN = (\d+);/.exec(source);
const summaryBody = /(const estimated = [\s\S]*?\.join\(" · "\) : "";)/.exec(source);
assert.ok(shown && summaryBody, "chat.tsx totals the Calls list in one header");
const summary = new Function("calls", "CALLS_SHOWN", "kilo", "plural", "usd", `${summaryBody[1] as string}\nreturn summary;`) as
    (calls: LlmCallInfo[] | null, max: number, k: typeof kilo, p: typeof plural, u: typeof usd) => string;
const CALLS_SHOWN = Number(shown[1]);

test("a call row says what was sent and what came out, its cost only when the model is priced, and never undefined", () => {
    assert.equal(tokens(call(1, { promptTokens: 8000, completionTokens: 400 }), kilo, usd), "8k in → 400 out", "an unpriced model shows no $0.00");
    assert.equal(tokens(call(1, { promptTokens: 8000, completionTokens: 400, cost: 0.036 }), kilo, usd), "8k in → 400 out · $0.04");
    assert.equal(tokens(call(2, { promptTokens: 7000, completionTokens: 120, usageEstimated: true, cost: 0.0042 }), kilo, usd), "≈7k in → ≈120 out · ≈$0.0042, estimated");
    assert.equal(tokens(call(3, { promptTokens: null, completionTokens: null, finishReason: "error" }), kilo, usd), "no usage reported");
});

test("the header says how many of the newest calls it totals, spent and its cost first, and counts the estimates", () => {
    const full = Array.from({ length: CALLS_SHOWN }, (_, i) => call(i + 1));
    assert.equal(summary(full, CALLS_SHOWN, kilo, plural, usd), "Last 100 calls · 104k tokens spent", "no cost on unpriced models");
    const few = [call(1, { promptTokens: 8000, completionTokens: 300, cost: 0.03 }), call(2, { promptTokens: 8400, completionTokens: 120, usageEstimated: true, cost: 0.02 }), call(3, { promptTokens: null, completionTokens: null })];
    assert.equal(summary(few, CALLS_SHOWN, kilo, plural, usd), "All 3 calls · 16.8k tokens spent · $0.05 · 1 estimated");
    assert.equal(summary([], CALLS_SHOWN, kilo, plural, usd), "");
});

// ── the meter ─────────────────────────────────────────────────────────────────

const meterBody = /const meter = useMemo\(\(\) => \{([\s\S]*?)\n {4}\}, \[rows, models\]\);/.exec(source);
const currentBody = /const currentModel = useMemo\(\(\) => \{([\s\S]*?)\n {4}\}, \[rows, models\]\);/.exec(source);
assert.ok(meterBody && currentBody, "chat.tsx reads the meter and the answering model in one memo each");
type Meter = { used: number; window: number; estimate: boolean; hot: boolean } | null;
const meter = new Function("rows", "models", meterBody[1] as string) as (rows: HistoryMessage[] | null, models: ModelSummary[] | null) => Meter;
const currentModel = new Function("rows", "models", currentBody[1] as string) as (rows: HistoryMessage[] | null, models: ModelSummary[] | null) => ModelSummary | null;

const model = (name: string, over: Partial<ModelSummary>): ModelSummary => ({
    name, modelUid: null, provider: "vllm", endpoint: "http://127.0.0.1:8000", contextTokens: 8000, isDefault: false, params: {}, keyEnv: "", keySet: false, vision: false, ...over,
});
// "fast" (8k window) was renamed "fast-8k" after the turn; the default has a 57k window
const registry = [model("big", { modelUid: "uid-big", contextTokens: 57_000, isDefault: true }), model("fast-8k", { modelUid: "uid-fast" })];
const answered = (meta: NonNullable<HistoryMessage["meta"]>): HistoryMessage[] => [
    { id: 1, role: "user", content: "hi", at: "2026-09-29 10:00:00" },
    { id: 2, role: "assistant", content: "hello", meta, at: "2026-09-29 10:00:01" },
];

test("after a rename the meter still reads the model's own window, by its uid", () => {
    const rows = answered({ callId: "c1", registryModel: "fast", modelUid: "uid-fast", promptTokens: 7000, usageEstimated: false });
    assert.deepEqual(meter(rows, registry), { used: 7000, window: 8000, estimate: false, hot: true }, "88% and near full, not 12% of the default's window");
    assert.equal(currentModel(rows, registry)?.name, "fast-8k");
    assert.equal(meter(answered({ callId: "c1", registryModel: "big", promptTokens: 7000 }), registry)?.window, 57_000, "a live turn names its model only");
});

test("a meter read off an estimated call says it is an estimate", () => {
    const rows = answered({ callId: "c2", registryModel: "fast", modelUid: "uid-fast", promptTokens: 6000, usageEstimated: true });
    assert.equal(meter(rows, registry)?.estimate, true);
});

// ── a turn's footer ───────────────────────────────────────────────────────────

const speedExpr = /const genSpeed = ([\s\S]*?);\n/.exec(source);
assert.ok(speedExpr, "chat.tsx states a turn's speed in one expression");
const genSpeed = new Function("meta", `return ${speedExpr[1] as string};`) as (meta: HistoryMessage["meta"]) => number | null;

test("a turn's speed is shown for reported output only, never for an estimate", async () => {
    const page = await listHistory("wren", 4, 60);
    const [, reported, , stopped] = page.items;
    assert.equal(genSpeed({ ...reported?.meta, callDurationMs: 2000 }), 150, "300 reported tokens over 2 s");
    assert.equal(genSpeed({ ...stopped?.meta, callDurationMs: 2000 }), null, "a stopped call's 120 tokens are the gateway's guess");
});
