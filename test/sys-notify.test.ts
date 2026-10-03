// sys-notify.ts and the real route.ts under it, against fake DOM globals, a stubbed gateway read and a recording toast.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const STUB = `data:text/javascript,${encodeURIComponent("export const getInboxItem = (id) => globalThis.__getInboxItem(id);")}`;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./inbox-api.ts" && context.parentURL?.endsWith("/src/sys-notify.ts")) return { url: STUB, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const shown: { title: string; body: string }[] = [];
const tags: string[] = [];
const asked: number[] = [];
const location = { hash: "" };

Object.assign(globalThis, {
    window: { focus: () => undefined, addEventListener: () => undefined },
    location,
    history: {
        pushState: (_state: unknown, _title: string, url: string) => { location.hash = url; },
        replaceState: (_state: unknown, _title: string, url: string) => { location.hash = url; },
    },
    localStorage: { getItem: () => null, setItem: () => undefined },
    // reduced motion: a navigation lands at once, with no View Transition to wait for
    matchMedia: () => ({ matches: true }),
    document: { hidden: true },
    Notification: class {
        static permission = "granted";
        onclick: (() => void) | null = null;
        constructor(title: string, options: { body: string; tag: string }) {
            shown.push({ title, body: options.body });
            tags.push(options.tag);
        }
        close(): void {}
    },
});

const { announceApproval, notifyInboxItem } = await import("../src/sys-notify.ts");
const { go, here } = await import("../src/route.ts");

interface Toasted { text: string; label: string | undefined; run: (() => void) | undefined; up: boolean }
const toasts: Toasted[] = [];
const toast = (text: string, action?: { label: string; run: () => void }): (() => boolean) => {
    const row: Toasted = { text, label: action?.label, run: action?.run, up: true };
    toasts.push(row);
    return () => row.up;
};
const gate = (over: Record<string, unknown>) => ({ type: "approval", kind: "approval", agent: "alpha", session: 3, tool: "send_email", ...over }) as
    Parameters<typeof announceApproval>[0];

const item = (over: Record<string, unknown>) => ({
    type: "inbox_item", id: 7, source: "agent", agent: "alpha", title: "New device awaiting approval: iPhone", level: "info", ...over,
}) as Parameters<typeof notifyInboxItem>[0];

const hidden = (value: boolean): void => { (globalThis as { document: { hidden: boolean } }).document.hidden = value; };

test.beforeEach(() => {
    shown.length = 0;
    tags.length = 0;
    asked.length = 0;
    for (const row of toasts) row.up = false;
    toasts.length = 0;
    hidden(true);
    go({ at: "inbox" });
    Object.assign(globalThis, {
        __getInboxItem: (id: number) => {
            asked.push(id);
            return Promise.resolve({ id, body: "Code: 123-456" });
        },
    });
});

test("an agent's own title never becomes the headline", async () => {
    await notifyInboxItem(item({}), () => undefined);
    assert.deepEqual(shown, [{ title: "alpha", body: "New device awaiting approval: iPhone" }]);
    assert.deepEqual(asked, []);
});

test("an agent cannot raise a banner over a visible pult, whatever level it picks", async () => {
    hidden(false);
    await notifyInboxItem(item({ level: "action" }), () => undefined);
    assert.deepEqual(shown, []);
});

test("newlines and bidi overrides never reach the notification", async () => {
    await notifyInboxItem(item({ title: "Approved\n\u202eGateway: type 000-000" }), () => undefined);
    assert.deepEqual(shown, [{ title: "alpha", body: "Approved Gateway: type 000-000" }]);
});

test("a gateway alert carries the body it exists to deliver", async () => {
    hidden(false);
    await notifyInboxItem(item({ source: "system", agent: null, level: "action" }), () => undefined);
    assert.deepEqual(asked, [7]);
    assert.deepEqual(shown, [{ title: "New device awaiting approval: iPhone", body: "Code: 123-456" }]);
});

test("a gateway alert still shows when its body cannot be read back", async () => {
    Object.assign(globalThis, { __getInboxItem: () => Promise.reject(new Error("offline")) });
    await notifyInboxItem(item({ source: "system", agent: null, level: "info" }), () => undefined);
    assert.deepEqual(shown, [{ title: "New device awaiting approval: iPhone", body: "" }]);
});

test("an approval is headed by the agent, with the label it picked flattened, in the toast and the banner alike", () => {
    announceApproval(gate({ tool: "send\n\u202eGateway: approve" }), toast);
    assert.deepEqual(toasts.map((row) => row.text), ["alpha needs your approval: send Gateway: approve"]);
    assert.deepEqual(shown, [{ title: "alpha", body: "needs your approval: send Gateway: approve" }]);
    assert.deepEqual(tags, ["mimi-approval"], "one shared tag, so a new banner replaces the last");
});

test("a question says it asks, never that a tool waits for approval, and its toast offers Answer", () => {
    announceApproval(gate({ kind: "question", tool: "ask_owner" }), toast);
    assert.deepEqual(toasts.map((row) => [row.text, row.label]), [["alpha asks you a question", "Answer"]]);
    assert.deepEqual(shown, [{ title: "alpha", body: "asks you a question" }]);
});

test("an approval never raises a banner over a visible pult; the toast covers that", () => {
    hidden(false);
    announceApproval(gate({}), toast);
    assert.equal(toasts.length, 1);
    assert.deepEqual(shown, []);
});

test("Review opens the gate's chat, and Inbox for a room gate or a gate outside any chat", () => {
    hidden(false);
    announceApproval(gate({}), toast);
    toasts[0]?.run?.();
    assert.deepEqual(here(), { at: "chat", agent: "alpha", id: 3 });

    for (const row of toasts) row.up = false;
    announceApproval(gate({ session: null, room: 12, gate: "g-12" }), toast);
    toasts[1]?.run?.();
    assert.deepEqual(here(), { at: "inbox", gate: "g-12" }, "rooms are parked, so a room gate is answered in Inbox, opened on it");

    for (const row of toasts) row.up = false;
    go({ at: "chat", agent: "alpha", id: 3 });
    announceApproval(gate({ session: null, gate: "g-4" }), toast);
    toasts[2]?.run?.();
    assert.deepEqual(here(), { at: "inbox", gate: "g-4" });
});

test("a gate whose chat is on screen, or a room gate while Inbox is, raises nothing, unless the pult is hidden", () => {
    hidden(false);
    go({ at: "chat", agent: "alpha", id: 3 });
    announceApproval(gate({}), toast);
    go({ at: "inbox" });
    announceApproval(gate({ session: null, room: 12, gate: "g-12" }), toast);
    assert.deepEqual(toasts, [], "Inbox lists every gate, whichever one it was opened on");

    go({ at: "rooms", room: "12" });
    announceApproval(gate({ session: null, room: 12 }), toast);
    assert.equal(toasts.length, 1, "a parked room link is not where a room gate is answered any more");

    for (const row of toasts) row.up = false;
    go({ at: "agent", agent: "alpha", tab: "settings" });
    announceApproval(gate({}), toast);
    assert.equal(toasts.length, 2, "the agent page is not the chat");

    hidden(true);
    go({ at: "inbox" });
    announceApproval(gate({ session: null, room: 12 }), toast);
    assert.equal(shown.length, 1);
});

test("gates that pile up under one toast fold into a count that opens Inbox, and start over once it is gone", () => {
    announceApproval(gate({}), toast);
    announceApproval(gate({ agent: "beta", tool: "pay" }), toast);
    announceApproval(gate({ agent: "gamma", session: 8 }), toast);
    assert.deepEqual(toasts.map((row) => row.text), [
        "alpha needs your approval: send_email",
        "2 requests waiting",
        "3 requests waiting",
    ]);
    assert.deepEqual(shown.at(-1), { title: "3 requests waiting", body: "Review them in Inbox" });
    go({ at: "chat", agent: "alpha", id: 1 });
    toasts[2]?.run?.();
    assert.deepEqual(here(), { at: "inbox" });

    for (const row of toasts) row.up = false;
    announceApproval(gate({ agent: "beta", tool: "pay" }), toast);
    assert.equal(toasts.at(-1)?.text, "beta needs your approval: pay");
});
