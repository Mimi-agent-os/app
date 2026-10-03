// push.ts against a Map storage, a stubbed shell command and a stubbed channel whose state the test moves.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const CHANNEL = stub(
    "export const apiFetch = (path, init) => globalThis.__apiFetch(path, init);" +
    "export const refusal = async (c) => { try { return JSON.parse(await c.res.text()).error ?? ''; } catch { return ''; } };" +
    "export const subscribe = (listener) => globalThis.__subscribe(listener);",
);
const TAURI = stub("export const tauriInvoke = () => globalThis.__invoke;");

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (context.parentURL?.endsWith("/src/push.ts")) {
            if (specifier === "./channel.ts") return { url: CHANNEL, shortCircuit: true };
            if (specifier === "./tauri.ts") return { url: TAURI, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const stored = new Map<string, string>();
const listeners = new Set<(s: { state: string }) => void>();
const asked: string[] = [];
const sent: { path: string; method: string; body: unknown }[] = [];
// what the phone and the gateway answer next
let token: string | Error = "fcm-token-1";
let status = 200;
let error = "";

Object.assign(globalThis, {
    localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
    },
    __invoke: (cmd: string): Promise<string> => {
        asked.push(cmd);
        return token instanceof Error ? Promise.reject(token) : Promise.resolve(token);
    },
    __apiFetch: (path: string, init: RequestInit): Promise<{ res: Response }> => {
        sent.push({ path, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
        return Promise.resolve({ res: new Response(JSON.stringify(status === 200 ? { ok: true } : { error }), { status }) });
    },
    __subscribe: (listener: (s: { state: string }) => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
});

const { pushEnabled, renewPushToken, setPush } = await import("../src/push.ts");

const move = async (state: string): Promise<void> => {
    for (const listener of [...listeners]) listener({ state });
    await new Promise((settle) => setImmediate(settle));
};

test.beforeEach(() => {
    stored.clear();
    listeners.clear();
    asked.length = 0;
    sent.length = 0;
    token = "fcm-token-1";
    status = 200;
    error = "";
});

test("turning on hands the phone's token to the gateway, and only then is the switch on", async () => {
    await setPush(true);
    assert.deepEqual(asked, ["push_token"]);
    assert.deepEqual(sent, [{ path: "/devices/me/push", method: "PUT", body: { token: "fcm-token-1" } }]);
    assert.equal(pushEnabled(), true);
});

test("a token the phone could not get, or one the gateway refused, leaves the switch off", async () => {
    token = new Error("Android blocks notifications from mimi.");
    await assert.rejects(setPush(true), /Android blocks notifications/);
    assert.deepEqual(sent, []);
    assert.equal(pushEnabled(), false);

    token = "fcm-token-1";
    status = 400;
    error = "token must be an FCM registration token";
    await assert.rejects(setPush(true), /token must be an FCM registration token/);
    assert.equal(pushEnabled(), false);
});

test("turning off drops the token on the gateway; a drop that failed keeps the switch on", async () => {
    await setPush(true);
    sent.length = 0;
    status = 503;
    await assert.rejects(setPush(false), /did not drop/);
    assert.equal(pushEnabled(), true);

    status = 200;
    await setPush(false);
    assert.deepEqual(sent.map((s) => s.method), ["DELETE", "DELETE"]);
    assert.equal(pushEnabled(), false);
    assert.equal(stored.size, 0);
});

test("while on, a start hands the token over once, at the channel's first ready", async () => {
    stored.set("mimi-os:push", "on");
    renewPushToken();
    await move("connecting");
    assert.deepEqual(asked, []);
    await move("ready");
    assert.deepEqual(asked, ["push_token"]);
    assert.deepEqual(sent.map((s) => s.method), ["PUT"]);
    await move("reconnecting");
    await move("ready");
    assert.equal(sent.length, 1);
    assert.equal(listeners.size, 0);
});

test("while off, a start sends nothing and waits on nothing", async () => {
    renewPushToken();
    assert.equal(listeners.size, 0);
    await move("ready");
    assert.deepEqual(asked, []);
    assert.deepEqual(sent, []);
});
