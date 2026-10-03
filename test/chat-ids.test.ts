// A planted chat id or agent name never becomes a path: api.ts and inbox-api.ts run over a stub channel that records each request.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const CHANNEL = stub(
    "export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }" +
    "export const apiFetch = (path, init = {}) => globalThis.__fetch(path, init);" +
    "export const checkedFetch = (path, init = {}) => globalThis.__fetch(path, init);" +
    "export const readJson = async (c) => JSON.parse(await c.res.text());" +
    "export const refusal = async () => '';",
);

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && /\/src\/(api|inbox-api)\.ts$/.test(context.parentURL ?? "")) return { url: CHANNEL, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const sent: string[] = [];
let answer: unknown = { ok: true };
Object.assign(globalThis, {
    window: new EventTarget(),
    __fetch: (path: string, init: RequestInit) => {
        sent.push(`${init.method ?? "GET"} ${path}`);
        return Promise.resolve({ res: new Response(JSON.stringify(answer), { status: 200 }) });
    },
});

const api = await import("../src/api.ts");
const { discuss } = await import("../src/inbox-api.ts");

// what the verified exploit planted: a traversal onto another agent's pin, and a trailing "?" that swallows the suffix the pult appends
const PLANTED = ["../../../pins/victim", "../../../pins/victim/block?", "1/../../../models/fake", "7", 0, -1, 1.5, Number.NaN, 2 ** 53];

const chatCalls = (id: number): [string, () => Promise<unknown>][] => [
    ["patch", () => api.patchConversation("evil", id, { pinned: true })],
    ["delete", () => api.deleteConversation("evil", id)],
    ["stop", () => api.stopTurn("evil", id)],
    ["compact", () => api.compactConversation("evil", id)],
    ["truncate", () => api.truncateFrom("evil", id, 3)],
    ["history", () => api.listHistory("evil", id, 20)],
    ["send", () => api.runTurn("evil", id, "hi", []).next()],
    ["attach", () => api.attachTurn("evil", id).next()],
];

test("a planted chat id is refused before any request leaves, as a rejection and never a throw", async () => {
    for (const id of PLANTED) {
        for (const [name, call] of chatCalls(id as number)) {
            sent.length = 0;
            let promise: Promise<unknown> | undefined;
            assert.doesNotThrow(() => { promise = call(); }, `${name} threw past a .catch for ${id}`);
            await assert.rejects(promise as Promise<unknown>, /invalid id/, `${name} accepted ${id}`);
            assert.deepEqual(sent, [], `${name} sent a request for ${id}`);
        }
    }
});

test("a real chat id names exactly its own chat, under an encoded agent name", async () => {
    sent.length = 0;
    answer = { ok: true, stopped: false, items: [], hasMore: false };
    await api.deleteConversation("night owl/x", 7);
    await api.stopTurn("wren", 12);
    await api.patchConversation("wren", 3, { title: "Plan" });
    await api.listHistory("wren", 3, 20, 41);
    assert.deepEqual(sent, [
        "DELETE /agents/night%20owl%2Fx/conversations/7",
        "POST /agents/wren/conversations/12/stop",
        "PATCH /agents/wren/conversations/3",
        "GET /agents/wren/conversations/3/messages?limit=20&before=41",
    ]);
});

test("an agent name is one encoded segment on every agent route", async () => {
    sent.length = 0;
    answer = { ok: true, turns: 0, cleared: 0 };
    await api.stopAgent("../pins/victim");
    await api.resumeAgent("a?b");
    await api.clearAgentCache("a/b");
    assert.deepEqual(sent, [
        "POST /agents/..%2Fpins%2Fvictim/stop",
        "POST /agents/a%3Fb/resume",
        "POST /agents/a%2Fb/clear-cache",
    ]);
});

test("a new chat whose id the agent answers as anything but a positive integer is refused", async () => {
    for (const id of PLANTED) {
        answer = { id };
        await assert.rejects(api.createConversation("evil"), /invalid chat id/, `accepted ${id}`);
    }
    answer = { id: 9 };
    assert.deepEqual(await api.createConversation("evil"), { id: 9 });
});

test("Discuss refuses a chat the gateway names by anything but a positive integer", async () => {
    for (const conversation of PLANTED) {
        answer = { agent: "evil", conversation };
        await assert.rejects(discuss(4), /invalid chat/, `accepted ${conversation}`);
    }
    answer = { agent: "evil", conversation: 5 };
    assert.deepEqual(await discuss(4), { agent: "evil", conversation: 5 });
});
