// The /events client's reconnect cadence and bursts, with channel.ts stubbed to hand each attempt to the test.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";

const STUB = `data:text/javascript,${encodeURIComponent("export const apiFetch = (path, init) => globalThis.__apiFetch(path, init);")}`;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.endsWith("/src/events.ts")) return { url: STUB, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

Object.assign(globalThis, { window: { dispatchEvent: () => true, addEventListener: () => undefined, removeEventListener: () => undefined } });

const { subscribeEvents } = await import("../src/events.ts");
const wait = globalThis.setTimeout;

/** Runs the subscriber until it has slept `count` times, with every sleep fired at once, and returns the delays it asked for. */
async function backoff(line: string, count: number): Promise<number[]> {
    const delays: number[] = [];
    globalThis.__apiFetch = () => Promise.resolve({ res: new Response(line) });
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
        if (delays.length < count) delays.push(ms);
        return wait(fn, 0);
    }) as typeof setTimeout;
    const stop = subscribeEvents({});
    try {
        for (let spin = 0; spin < 1000 && delays.length < count; spin++) await new Promise((r) => wait(r, 1));
    } finally {
        stop();
        globalThis.setTimeout = wait;
    }
    return delays;
}

test("a stream that never says ready backs off exponentially", async () => {
    assert.deepEqual(await backoff('{"type":"error","message":"too many event subscribers"}\n', 3), [1000, 2000, 4000]);
});

test("the gateway's ready line resets the backoff", async () => {
    assert.deepEqual(await backoff('{"type":"ready"}\n', 3), [1000, 1000, 1000]);
});

/** Feeds `lines` through one stream with setTimeout mocked, advances the clock by `ms`, and returns the window events dispatched. */
async function dispatched(lines: string[], ms: number): Promise<{ type: string; detail: unknown }[]> {
    const seen: { type: string; detail: unknown }[] = [];
    let calls = 0;
    globalThis.__apiFetch = (_path: string, init: { signal: AbortSignal }) => calls++ === 0
        ? Promise.resolve({ res: new Response(lines.map((line) => `${line}\n`).join("")) })
        : new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("stopped"))); });
    Object.assign(globalThis.window, {
        dispatchEvent: (e: CustomEvent) => { seen.push({ type: e.type, detail: e.detail }); return true; },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    const stop = subscribeEvents({});
    try {
        for (let spin = 0; spin < 20; spin++) await new Promise((r) => setImmediate(r));
        mock.timers.tick(ms);
        return seen;
    } finally {
        stop();
        mock.timers.reset();
    }
}

test("chat_changed lines within 150 ms fold into one mimi:chat-changed per agent, naming every chat once", async () => {
    const seen = await dispatched([
        '{"type":"chat_changed","agent":"wren","session":4}',
        '{"type":"chat_changed","agent":"wren","session":7}',
        '{"type":"chat_changed","agent":"scout","session":1}',
        '{"type":"chat_changed","agent":"wren","session":4}',
        '{"type":"chat_changed","agent":"wren","session":9}',
    ], 150);
    assert.deepEqual(seen, [
        { type: "mimi:chat-changed", detail: { agent: "wren", sessions: [4, 7, 9] } },
        { type: "mimi:chat-changed", detail: { agent: "scout", sessions: [1] } },
    ]);
});

test("nothing is dispatched before the 150 ms burst closes", async () => {
    assert.deepEqual(await dispatched(['{"type":"chat_changed","agent":"wren","session":4}'], 149), []);
});

test("usage_changed lines within 3 s dispatch one mimi:usage-changed, after the window", async () => {
    const line = '{"type":"usage_changed","agent":"wren"}';
    assert.deepEqual(await dispatched([line, line, line, line, line], 2999), []);
    assert.deepEqual(await dispatched([line, line, line, line, line], 3000), [{ type: "mimi:usage-changed", detail: null }]);
});

test("limits_changed refetches every cost at once, with no burst window", async () => {
    assert.deepEqual(await dispatched(['{"type":"limits_changed","model":"fake"}'], 0), [
        { type: "mimi:usage-changed", detail: { type: "limits_changed", model: "fake" } },
    ]);
});

test("stopping drops every burst still waiting", async () => {
    const seen: string[] = [];
    let calls = 0;
    globalThis.__apiFetch = (_path: string, init: { signal: AbortSignal }) => calls++ === 0
        ? Promise.resolve({ res: new Response('{"type":"chat_changed","agent":"wren","session":4}\n{"type":"usage_changed","agent":"wren"}\n') })
        : new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("stopped"))); });
    Object.assign(globalThis.window, { dispatchEvent: (e: CustomEvent) => { seen.push(e.type); return true; } });
    mock.timers.enable({ apis: ["setTimeout"] });
    const stop = subscribeEvents({});
    try {
        for (let spin = 0; spin < 20; spin++) await new Promise((r) => setImmediate(r));
        stop();
        mock.timers.tick(5000);
        assert.deepEqual(seen, []);
    } finally {
        mock.timers.reset();
    }
});
