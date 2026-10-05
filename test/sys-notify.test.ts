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
const clicks: (() => void)[] = [];
const asked: number[] = [];
const location = { hash: "" };
const stored = new Map<string, string>();
// a window can be hidden, shown behind other apps, or shown in front
const view = { hidden: true, focused: false };

Object.assign(globalThis, {
    window: { focus: () => undefined, addEventListener: () => undefined },
    location,
    history: {
        pushState: (_state: unknown, _title: string, url: string) => { location.hash = url; },
        replaceState: (_state: unknown, _title: string, url: string) => { location.hash = url; },
    },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
    // reduced motion: a navigation lands at once, with no View Transition to wait for
    matchMedia: () => ({ matches: true }),
    document: { get hidden() { return view.hidden; }, hasFocus: () => view.focused },
    Notification: class {
        static permission = "granted";
        onclick: (() => void) | null = null;
        constructor(title: string, options: { body: string; tag: string }) {
            shown.push({ title, body: options.body });
            tags.push(options.tag);
            clicks.push(() => this.onclick?.());
        }
        close(): void {}
    },
});

const { announceApproval, announceReply, notifyInboxItem } = await import("../src/sys-notify.ts");
const { go, here } = await import("../src/route.ts");

interface Toasted { text: string; label: string | undefined; run: (() => void) | undefined; up: boolean }
const toasts: Toasted[] = [];
const toast = (text: string, action?: { label: string; run: () => void }): (() => boolean) => {
    const row: Toasted = { text, label: action?.label, run: action?.run, up: true };
    toasts.push(row);
    return () => row.up;
};
const gate = (over: Record<string, unknown>) => ({ type: "approval", kind: "approval", agent: "alpha", session: 3, gate: "g-3", tool: "send_email", actions: 1, ...over }) as
    Parameters<typeof announceApproval>[0];

const item = (over: Record<string, unknown>) => ({
    type: "inbox_item", id: 7, source: "agent", agent: "alpha", title: "New device awaiting approval: iPhone", level: "info", ...over,
}) as Parameters<typeof notifyInboxItem>[0];

const screen = (state: "hidden" | "behind" | "front"): void => {
    view.hidden = state === "hidden";
    view.focused = state === "front";
};

test.beforeEach(() => {
    shown.length = 0;
    tags.length = 0;
    clicks.length = 0;
    asked.length = 0;
    stored.clear();
    for (const row of toasts) row.up = false;
    toasts.length = 0;
    screen("hidden");
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

test("an agent cannot raise a banner over a pult in front, whatever level it picks", async () => {
    screen("front");
    await notifyInboxItem(item({ level: "action" }), () => undefined);
    assert.deepEqual(shown, []);
});

test("newlines and bidi overrides never reach the notification", async () => {
    await notifyInboxItem(item({ title: "Approved\n\u202eGateway: type 000-000" }), () => undefined);
    assert.deepEqual(shown, [{ title: "alpha", body: "Approved Gateway: type 000-000" }]);
});

test("a gateway alert carries the body it exists to deliver", async () => {
    screen("front");
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

test("a batch gate says how many calls wait, not just its first one", () => {
    announceApproval(gate({ tool: "calendar_create_event", actions: 4 }), toast);
    assert.deepEqual(toasts.map((row) => row.text), ["alpha needs your approval: calendar_create_event and 3 more"]);
    assert.deepEqual(shown, [{ title: "alpha", body: "needs your approval: calendar_create_event and 3 more" }]);
});

test("a question says it asks, never that a tool waits for approval, and its toast offers Answer", () => {
    announceApproval(gate({ kind: "question", tool: "ask_owner" }), toast);
    assert.deepEqual(toasts.map((row) => [row.text, row.label]), [["alpha asks you a question", "Answer"]]);
    assert.deepEqual(shown, [{ title: "alpha", body: "asks you a question" }]);
});

test("an approval never raises a banner over a pult in front; the toast covers that", () => {
    screen("front");
    announceApproval(gate({}), toast);
    assert.equal(toasts.length, 1);
    assert.deepEqual(shown, []);
});

test("Review opens the gate's chat, and Inbox for a room gate or a gate outside any chat", () => {
    screen("front");
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
    screen("front");
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

    screen("hidden");
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

test("a pult shown behind other apps is not looked at: agent items, gateway notices and approvals on screen all raise a banner", async () => {
    screen("behind");
    await notifyInboxItem(item({}), () => undefined);
    await notifyInboxItem(item({ source: "system", agent: null, level: "info" }), () => undefined);
    go({ at: "chat", agent: "alpha", id: 3 });
    announceApproval(gate({}), toast);
    assert.deepEqual(shown.map((row) => row.title), ["alpha", "New device awaiting approval: iPhone", "alpha"]);
    assert.equal(toasts.length, 1, "the gate's chat is on screen, yet nobody is looking at it");
});

test("the owner's switch off keeps every banner away, and the toasts stay", async () => {
    stored.set("mimi-os:notify", "off");
    await notifyInboxItem(item({ source: "system", agent: null, level: "action" }), () => undefined);
    announceApproval(gate({}), toast);
    announceReply({ agent: "alpha", id: 3, title: "Plan week" }, toast);
    assert.deepEqual(shown, []);
    assert.deepEqual(toasts.map((row) => row.text), ["alpha needs your approval: send_email", "alpha replied in Plan week"]);
});

test("a finished reply is headed by its agent, carries the chat title, and its banner opens that chat", () => {
    announceReply({ agent: "alpha", id: 3, title: "Plan\n‮week" }, toast);
    announceReply({ agent: "beta", id: 9, title: null }, toast);
    assert.deepEqual(shown, [{ title: "alpha replied", body: "Plan week" }, { title: "beta replied", body: "New chat" }]);
    assert.deepEqual(tags, ["mimi-reply#/a/alpha/3", "mimi-reply#/a/beta/9"], "a later reply in the same chat replaces its banner");
    assert.deepEqual(toasts.map((row) => [row.text, row.label]), [["alpha replied in Plan week", undefined], ["beta replied in New chat", undefined]],
        "a plain toast, so it never takes the place of an approval's Review");
    clicks[0]?.();
    assert.deepEqual(here(), { at: "chat", agent: "alpha", id: 3 });
});

test("a reply the owner is watching raises nothing; the same chat behind other apps, or another chat in front, still reaches them", () => {
    const reply = { agent: "alpha", id: 3, title: "Plan week" };
    go({ at: "chat", agent: "alpha", id: 3 });
    screen("front");
    announceReply(reply, toast);
    assert.deepEqual([shown, toasts], [[], []]);

    screen("behind");
    announceReply(reply, toast);
    assert.deepEqual(shown, [{ title: "alpha replied", body: "Plan week" }]);
    assert.deepEqual(toasts, [], "the chat itself shows the reply once the owner looks");

    screen("front");
    go({ at: "chat", agent: "alpha", id: 4 });
    announceReply(reply, toast);
    assert.equal(shown.length, 1);
    assert.deepEqual(toasts.map((row) => row.text), ["alpha replied in Plan week"]);
});
