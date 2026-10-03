// route.ts against a fake location, history (Back fires every popstate and hashchange listener; go() lands a tick later, as a browser's does), storage and media query.
import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map<string, string>();
const entries: { url: string; state: unknown }[] = [{ url: "", state: null }];
let at = 0;
let wide = true;
const listeners = new Map<string, ((e: { type: string }) => void)[]>();
const fake = { hash: "", pathname: "/app/", search: "" };

const fire = (type: string): void => { for (const listener of listeners.get(type) ?? []) listener({ type }); };
const tick = (): Promise<void> => new Promise((done) => setImmediate(done));
const step = (by: number): void => {
    at += by;
    fake.hash = entries[at]?.url ?? "";
    fire("popstate");
    fire("hashchange");
};
// steps the pult's own back() or go() spends on a mini-app frame's entries: only the frame moves, and the page hears nothing
let frameSteps = 0;
const travel = (by: number): void => {
    const spent = Math.min(frameSteps, Math.abs(by));
    frameSteps -= spent;
    if (spent < Math.abs(by)) step(by - Math.sign(by) * spent);
};

Object.assign(globalThis, {
    location: fake,
    history: {
        get state() { return entries[at]?.state ?? null; },
        get length() { return entries.length; },
        pushState: (state: unknown, _title: string, url: string) => {
            entries.splice(at + 1, Infinity, { url, state });
            at = entries.length - 1;
            fake.hash = url;
        },
        replaceState: (state: unknown, _title: string, url: string) => {
            entries[at] = { url, state };
            fake.hash = url;
        },
        back: () => travel(-1),
        go: (by: number) => { setImmediate(() => travel(by)); },
    },
    localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
    },
    matchMedia: (query: string) => ({ matches: wide && query === "(min-width: 901px)" }),
    window: {
        addEventListener: (type: string, listener: (e: { type: string }) => void) => { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
        removeEventListener: () => undefined,
    },
});

const {
    SETTINGS_INDEX, SETTINGS_SECTIONS, back, forgetChat, formatRoute, gateRoute, go, goLater, here, holdBack, landing, lastChat, lastSettings, leave,
    parentOf, parseRoute, recentChats, releaseBack, rememberChat, snapshot,
} = await import("../src/route.ts");
const { navigate } = await import("../src/motion.ts");

const row = (id: number, over: { archived?: boolean; title?: string; titleByUser?: boolean } = {}) =>
    ({ id, archived: false, title: "Plan week", titleByUser: false, ...over });

test("every canonical hash parses and formats back to itself", () => {
    for (const hash of [
        "#/",
        "#/a/wren/12",
        "#/a/wren/new",
        "#/a/wren",
        "#/a/wren/chats",
        "#/a/wren/settings",
        "#/a/wren/interfaces",
        "#/a/wren/interfaces/board",
        "#/a/wren/interfaces/board?route=%2Fweek%3Fday%3D2%26x%3D%23",
        "#/a/wren/interfaces?route=%2F",
        "#/a/night%20owl%2Fx/3",
        "#/a/night%20owl/new",
        "#/r",
        "#/r/room-7",
        "#/inbox",
        "#/inbox?gate=g%2F7",
        "#/inbox/activity",
        "#/inbox/activity?gate=g-1",
        "#/settings",
        "#/settings/connection",
        "#/settings/models",
        "#/settings/limits",
        "#/settings/access",
        "#/settings/health",
        "#/settings/usage",
        "#/settings/device",
    ]) {
        const route = parseRoute(hash);
        assert.ok(route, hash);
        assert.equal(formatRoute(route), hash);
    }
    for (const route of [
        { at: "new", agent: "a/b c" },
        { at: "rooms", room: "a/b c" },
        { at: "agent", agent: "wren", tab: "interfaces", app: "b?o#rd", appRoute: "/x?y=1" },
        // what an Inbox app notice opens: the agent's one app, on the notice's route
        { at: "agent", agent: "wren", tab: "interfaces", app: undefined, appRoute: "/week?day=2#top" },
    ] as const) {
        assert.deepEqual(parseRoute(formatRoute(route)), route);
    }
    assert.deepEqual(parseRoute(""), { at: "home" });
    assert.deepEqual(parseRoute("#"), { at: "home" });
});

test("the agent page with no tab and its Chats tab are the same place under both spellings", () => {
    assert.deepEqual(parseRoute("#/a/wren"), { at: "agent", agent: "wren" });
    assert.deepEqual(parseRoute("#/a/wren/chats"), { at: "agent", agent: "wren", tab: "chats" });
    assert.equal(formatRoute({ at: "agent", agent: "wren" }), "#/a/wren");
    assert.equal(formatRoute({ at: "agent", agent: "wren", tab: "chats" }), "#/a/wren/chats");
});

test("anything else names no place", () => {
    for (const hash of [
        "#pair=mimi%3A%2F%2Finvite",
        "#/nope",
        "#/a",
        "#/a/",
        "#/a/wren/",
        "#/a/wren/0",
        "#/a/wren/007",
        "#/a/wren/-1",
        "#/a/wren/1.5",
        "#/a/wren/99999999999999999999",
        "#/a/wren/1/2",
        "#/a/wren/new/x",
        "#/a/wren/new?route=%2F",
        "#/a/wren/chats/x",
        "#/a/wren/settings/models",
        "#/a/wren/chats?route=%2F",
        "#/a/wren/interfaces/board?view=x",
        "#/a/wren/interfaces/board/extra",
        "#/a/%E0%A4%A",
        "#/settings/",
        "#/settings/devices",
        "#/settings/models/x",
        "#/inbox/3",
        "#/inbox/reports",
        "#/inbox/activity/x",
        "#/inbox/activity?route=%2F",
        "#/inbox?gate=",
        "#/inbox?route=%2F",
        "#/a/wren?gate=g-1",
        "#/r/a/b",
        "#a/wren/3",
        "#//inbox",
    ]) {
        assert.equal(parseRoute(hash), null, hash);
    }
});

test("the Settings index names every section once, in order, each group in one run", () => {
    assert.deepEqual(SETTINGS_INDEX.map((t) => t.v), SETTINGS_SECTIONS);
    const runs = SETTINGS_INDEX.map((t) => t.group).filter((group, i, all) => group !== all[i - 1]);
    assert.deepEqual(runs, [...new Set(runs)]);
});

test("without a document, navigate runs its update at once", () => {
    let ran = false;
    navigate(() => { ran = true; }, "forward");
    assert.equal(ran, true);
});

test("go pushes a history entry, replace does not, and Back returns to the previous place", () => {
    go({ at: "inbox" });
    go({ at: "chat", agent: "wren", id: 3 });
    const depth = entries.length;
    go({ at: "settings", section: "usage" }, { replace: true });
    assert.equal(entries.length, depth);
    assert.equal(fake.hash, "#/settings/usage");

    go({ at: "chat", agent: "wren", id: 4 });
    step(-1);
    assert.deepEqual(here(), { at: "settings", section: "usage" });
    step(-1);
    assert.deepEqual(here(), { at: "inbox" });
});

test("a chat route whose id an agent planted is refused: no entry is written and the owner stays where they are", () => {
    go({ at: "inbox" });
    const depth = entries.length;
    const nav = snapshot().nav;
    for (const id of ["../../../pins/victim", "../../../pins/victim/block?", "7", 0, -1, 1.5, Number.NaN, 2 ** 53]) {
        go({ at: "chat", agent: "evil", id: id as number });
        go({ at: "chat", agent: "evil", id: id as number }, { replace: true });
        goLater()({ at: "chat", agent: "evil", id: id as number });
        leave({ at: "inbox" }, { at: "chat", agent: "evil", id: id as number });
        assert.deepEqual(here(), { at: "inbox" }, `moved to ${id}`);
    }
    assert.equal(entries.length, depth);
    assert.equal(fake.hash, "#/inbox");
    assert.equal(snapshot().nav, nav);
});

test("every entry the app writes carries its depth: a push adds one, a replace keeps it, Back and Forward read it", () => {
    go({ at: "inbox" });
    const base = snapshot().index;
    assert.deepEqual(entries[at]?.state, { i: base });
    go({ at: "chat", agent: "wren", id: 3 });
    assert.equal(snapshot().index, base + 1);
    assert.deepEqual(entries[at]?.state, { i: base + 1 });
    go({ at: "chat", agent: "wren", id: 4 }, { replace: true });
    assert.equal(snapshot().index, base + 1);
    assert.deepEqual(entries[at]?.state, { i: base + 1 });
    step(-1);
    assert.equal(snapshot().index, base);
    step(1);
    assert.equal(snapshot().index, base + 1);
    assert.deepEqual(here(), { at: "chat", agent: "wren", id: 4 });
});

test("back steps to the previous entry the app wrote, else puts the parent in this entry's place", () => {
    go({ at: "inbox" });
    go({ at: "chat", agent: "wren", id: 8 });
    back();
    assert.deepEqual(here(), { at: "inbox" });

    entries.splice(0, Infinity, { url: "#/a/wren/9", state: { i: 0 } });
    at = 0;
    fake.hash = "#/a/wren/9";
    fire("popstate");
    assert.equal(snapshot().index, 0, "the entry the app opened on is the first");
    back();
    assert.deepEqual(here(), { at: "home" });
    assert.deepEqual(entries, [{ url: "#/", state: { i: 0 } }], "replaced, so nothing is left to step back into");

    entries.splice(0, Infinity, { url: "#/a/wren/new", state: { i: 0 } });
    fake.hash = "#/a/wren/new";
    fire("popstate");
    back();
    assert.deepEqual(here(), { at: "agent", agent: "wren" }, "a new chat that cannot open climbs to its agent");
    back();
    assert.deepEqual(here(), { at: "home" });
    const nav = snapshot().nav;
    back();
    assert.equal(snapshot().nav, nav, "Home is the root: nothing above it");
});

test("every screen climbs to Home, a new chat through its agent's page and a Settings section through the index", () => {
    assert.equal(parentOf({ at: "home" }), null);
    for (const route of [
        { at: "chat", agent: "wren", id: 3 },
        { at: "agent", agent: "wren", tab: "settings" },
        { at: "inbox" },
        { at: "inbox", gate: "g-1" },
        { at: "settings" },
        { at: "rooms", room: "r-1" },
    ] as const) assert.deepEqual(parentOf(route), { at: "home" }, formatRoute(route));
    assert.deepEqual(parentOf({ at: "new", agent: "wren" }), { at: "agent", agent: "wren" });
    assert.deepEqual(parentOf({ at: "settings", section: "usage" }), { at: "settings" });
});

test("on a phone Inbox and the Settings index sit one above Home: pushed from Home, swapped in above it, popped back to from deeper", async () => {
    entries.splice(0, Infinity, { url: "#/", state: { i: 0 } });
    at = 0;
    fake.hash = "#/";
    fire("popstate");
    wide = false;
    try {
        go({ at: "inbox" });
        assert.deepEqual(entries.map((e) => e.url), ["#/", "#/inbox"], "pushed from Home");
        go({ at: "settings" });
        assert.deepEqual(entries.map((e) => e.url), ["#/", "#/settings"], "swapped in at the same depth");
        assert.equal(snapshot().index, 1);

        go({ at: "settings", section: "usage" });
        go({ at: "chat", agent: "wren", id: 4 });
        assert.equal(snapshot().index, 3);
        const nav = snapshot().nav;
        go({ at: "inbox" });
        go({ at: "settings" });
        go({ at: "agent", agent: "wren" });
        await tick();
        assert.deepEqual(here(), { at: "inbox" }, "the second tap and a move during the pop are dropped");
        assert.equal(snapshot().nav, nav + 1, "one navigation");
        assert.equal(at, 1);
        assert.deepEqual(entries[1], { url: "#/inbox", state: { i: 1 } }, "the root took over the entry it popped to");

        go({ at: "settings", section: "health" });
        go({ at: "settings" });
        await tick();
        assert.deepEqual(here(), { at: "settings" }, "a section pops to its own index");
        assert.equal(at, 1);
        back();
        assert.deepEqual(here(), { at: "home" }, "Back from a root goes Home");
    } finally {
        wide = true;
    }
});

test("the Inbox tab rides the URL: Activity swaps in at Inbox's depth, and Inbox from the bar reopens on Reports", () => {
    assert.deepEqual(parseRoute("#/inbox/activity"), { at: "inbox", tab: "activity" });
    assert.deepEqual(parentOf({ at: "inbox", tab: "activity" }), { at: "home" });
    entries.splice(0, Infinity, { url: "#/", state: { i: 0 } });
    at = 0;
    fake.hash = "#/";
    fire("popstate");
    wide = false;
    try {
        go({ at: "inbox" });
        go({ at: "inbox", tab: "activity" }, { replace: true });
        assert.deepEqual(entries.map((e) => e.url), ["#/", "#/inbox/activity"], "a tab switch takes the entry it is on");
        go({ at: "inbox" });
        assert.deepEqual(entries.map((e) => e.url), ["#/", "#/inbox"]);
        assert.equal(snapshot().index, 1);
    } finally {
        wide = true;
    }
});

test("on a phone, going Home pops back to the first entry instead of stacking a second Home; a second tap meanwhile is dropped", async () => {
    entries.splice(0, Infinity, { url: "#/", state: { i: 0 } });
    at = 0;
    fake.hash = "#/";
    fire("popstate");
    wide = false;
    try {
        go({ at: "inbox" });
        go({ at: "chat", agent: "wren", id: 4 });
        go({ at: "agent", agent: "wren" });
        go({ at: "home" });
        go({ at: "home" });
        go({ at: "chat", agent: "wren", id: 5 });
        await tick();
        assert.deepEqual(here(), { at: "home" });
        assert.equal(snapshot().index, 0);
        assert.equal(at, 0, "one pop, all the way down");

        // the first entry held a chat (the window was wide when it opened): Home takes its place
        entries.splice(0, Infinity, { url: "#/a/wren/2", state: { i: 0 } }, { url: "#/inbox", state: { i: 1 } });
        at = 1;
        fake.hash = "#/inbox";
        fire("popstate");
        go({ at: "home" });
        await tick();
        assert.deepEqual(here(), { at: "home" });
        assert.deepEqual(entries[0], { url: "#/", state: { i: 0 } });

        go({ at: "home" }, { replace: true });
        assert.equal(entries.length, 2, "already Home at the first entry: nothing written");
    } finally {
        wide = true;
    }
});

test("an overlay's entry: Back closes the overlay and keeps the screen; closing it pops the entry before `then` runs", async () => {
    go({ at: "chat", agent: "wren", id: 6 });
    const depth = entries.length;
    let closed = 0;
    holdBack(() => { closed += 1; });
    await tick();
    assert.equal(entries.length, depth + 1, "one entry, pushed a tick after the overlay opened");
    assert.equal(entries[at]?.url, "#/a/wren/6", "same place");
    const nav = snapshot().nav;
    step(-1);
    assert.equal(closed, 1);
    assert.deepEqual(here(), { at: "chat", agent: "wren", id: 6 });
    assert.equal(snapshot().nav, nav, "Back took the overlay, not the screen");

    const hold = holdBack(() => { closed += 1; });
    await tick();
    const order: string[] = [];
    releaseBack(hold, () => order.push(`then at ${at}`));
    releaseBack(hold);
    order.push("released");
    await tick();
    await tick();
    assert.deepEqual(order, ["released", `then at ${depth - 1}`], "the entry is gone when `then` runs");
    assert.equal(closed, 1, "closing on its own is not a Back");
    assert.equal(entries[at]?.url, "#/a/wren/6");
});

test("a release and a hold in one tick share one entry, as StrictMode's rehearsal mount does", async () => {
    go({ at: "settings", section: "health" });
    const depth = entries.length;
    const first = holdBack(() => undefined);
    releaseBack(first);
    let closed = false;
    holdBack(() => { closed = true; });
    await tick();
    assert.equal(entries.length, depth + 1);
    step(-1);
    assert.equal(closed, true, "Back closes the overlay that stayed");
    await tick();
    assert.equal(entries.length, depth + 1, "nothing left to pop");
    assert.deepEqual(here(), { at: "settings", section: "health" });
});

test("a move asked for while an overlay is up closes it and lands once its entry is gone, never burying it", async () => {
    go({ at: "agent", agent: "wren" });
    const base = at;
    let closed = false;
    holdBack(() => { closed = true; });
    await tick();
    go({ at: "chat", agent: "wren", id: 7 });
    assert.equal(closed, true);
    await tick();
    await tick();
    assert.deepEqual(here(), { at: "chat", agent: "wren", id: 7 });
    assert.deepEqual(entries.slice(base), [
        { url: "#/a/wren", state: { i: snapshot().index - 1 } },
        { url: "#/a/wren/7", state: { i: snapshot().index } },
    ], "the overlay's entry was popped, then the chat pushed");
    step(-1);
    assert.deepEqual(here(), { at: "agent", agent: "wren" }, "one Back returns to the screen the overlay was on");
});

test("a hash typed into the address bar is one step forward, so Back returns to where the owner was", () => {
    go({ at: "inbox" });
    const base = snapshot().index;
    entries.splice(at + 1, Infinity, { url: "#/a/wren/9", state: null });
    at += 1;
    fake.hash = "#/a/wren/9";
    fire("popstate");
    fire("hashchange");
    assert.equal(snapshot().index, base + 1);
    assert.deepEqual(entries[at], { url: "#/a/wren/9", state: { i: base + 1 } }, "stamped where it stands");
    back();
    assert.deepEqual(here(), { at: "inbox" });
});

test("one Back is one navigation, though popstate and hashchange both fire for it", () => {
    go({ at: "inbox" });
    go({ at: "chat", agent: "wren", id: 5 });
    const before = snapshot().nav;
    step(-1);
    assert.equal(snapshot().nav, before + 1);
});

test("a pairing link in the hash is left for channel.ts", () => {
    go({ at: "inbox" });
    fake.hash = "#pair=abc";
    fire("hashchange");
    assert.deepEqual(here(), { at: "inbox" });
    assert.equal(fake.hash, "#pair=abc");
});

test("a late answer lands while the owner is still where they asked, as a push or a replace", () => {
    go({ at: "inbox" });
    const land = goLater();
    land({ at: "chat", agent: "alpha", id: 42 });
    assert.deepEqual(here(), { at: "chat", agent: "alpha", id: 42 });

    go({ at: "new", agent: "alpha" });
    const depth = entries.length;
    goLater()({ at: "chat", agent: "alpha", id: 43 }, { replace: true });
    assert.deepEqual(here(), { at: "chat", agent: "alpha", id: 43 });
    assert.equal(entries.length, depth, "the new-chat entry is replaced, so Back never returns to it");
});

test("a late answer never moves someone who already left, by click, by replace or by Back", () => {
    go({ at: "chat", agent: "alpha", id: 1 });
    const clicked = goLater();
    go({ at: "chat", agent: "beta", id: 9 });
    clicked({ at: "chat", agent: "alpha", id: 42 });
    assert.deepEqual(here(), { at: "chat", agent: "beta", id: 9 });

    const replaced = goLater();
    go({ at: "agent", agent: "beta", tab: "settings" }, { replace: true });
    replaced({ at: "chat", agent: "alpha", id: 42 });
    assert.deepEqual(here(), { at: "agent", agent: "beta", tab: "settings" });

    const stepped = goLater();
    step(-1);
    stepped({ at: "chat", agent: "alpha", id: 43 });
    assert.deepEqual(here(), { at: "chat", agent: "alpha", id: 1 });

    const repeated = goLater();
    go({ at: "chat", agent: "alpha", id: 1 });
    repeated({ at: "chat", agent: "alpha", id: 44 });
    assert.deepEqual(here(), { at: "chat", agent: "alpha", id: 1 }, "even a repeat of the same place counts as moving");
});

test("a deleted chat is left in place, and only while the owner is still on it", () => {
    go({ at: "chat", agent: "alpha", id: 5 });
    go({ at: "chat", agent: "alpha", id: 7 });
    const depth = entries.length;
    leave({ at: "chat", agent: "alpha", id: 5 }, { at: "agent", agent: "alpha" });
    assert.deepEqual(here(), { at: "chat", agent: "alpha", id: 7 }, "the owner moved on while the delete was in flight");

    leave({ at: "chat", agent: "alpha", id: 7 }, { at: "agent", agent: "alpha" });
    assert.deepEqual(here(), { at: "agent", agent: "alpha" });
    assert.equal(entries.length, depth, "replaced, so Back never returns to it");
});

test("a gate opens its chat, and Inbox opened on it for a room gate or one outside any chat", () => {
    assert.deepEqual(gateRoute("alpha", 12, 3, "g-1"), { at: "inbox", gate: "g-1" });
    assert.deepEqual(gateRoute("alpha", "r-1", undefined, "g-2"), { at: "inbox", gate: "g-2" });
    assert.deepEqual(gateRoute("alpha", undefined, 3, "g-3"), { at: "chat", agent: "alpha", id: 3 });
    assert.deepEqual(gateRoute("alpha", undefined, undefined), { at: "inbox", gate: undefined });
    assert.deepEqual(parseRoute(formatRoute({ at: "inbox", gate: "g/7 x" })), { at: "inbox", gate: "g/7 x" });
});

test("each agent remembers the last chat confirmed in this window, not every arrival", () => {
    stored.clear();
    rememberChat("alpha", row(5));
    rememberChat("beta", row(2));
    rememberChat("alpha", row(6));
    go({ at: "chat", agent: "alpha", id: 9 });
    assert.equal(lastChat("alpha"), 6, "arriving is not proof the chat exists");
    assert.equal(lastChat("beta"), 2);
    assert.equal(lastChat("gamma"), undefined);
    forgetChat("alpha", 6);
    assert.equal(lastChat("alpha"), undefined);
});

test("the device keeps recent chats across agents, most recent last, each once", () => {
    stored.clear();
    rememberChat("alpha", row(5));
    rememberChat("beta", row(2));
    rememberChat("alpha", row(6));
    rememberChat("alpha", row(5));
    assert.deepEqual(recentChats(), [["beta", 2], ["alpha", 6], ["alpha", 5]]);
    forgetChat("alpha", 6);
    assert.deepEqual(recentChats(), [["beta", 2], ["alpha", 5]]);
    for (let id = 1; id <= 40; id++) rememberChat("zeta", row(id));
    assert.equal(recentChats().length, 30);
    assert.deepEqual(recentChats().at(-1), ["zeta", 40]);
});

test("recent chats read back from storage keep only a chat an id can name", () => {
    stored.set("mimi-os:last-chat", JSON.stringify([["a", 0], ["a", -2], ["a", 1.5], ["a", "3"], ["a", "../../pins/victim"], [7, 2], "b", ["b", 4]]));
    assert.deepEqual(recentChats(), [["b", 4]]);
    stored.clear();
});

test("an archived chat or a delegation thread is never where the agent row lands", () => {
    stored.clear();
    rememberChat("eps", row(1));
    rememberChat("eps", row(2, { archived: true }));
    assert.equal(lastChat("eps"), 1);
    rememberChat("eps", row(3, { title: "← Draft reply to Anna", titleByUser: true }));
    assert.equal(lastChat("eps"), 1);
    rememberChat("eps", row(4, { title: "← Draft reply to Anna", titleByUser: false }));
    assert.equal(lastChat("eps"), 4, "only a title the gateway set by hand marks a delegation");

    rememberChat("eps", row(4, { archived: true }));
    assert.equal(lastChat("eps"), undefined, "archived while on screen");
    assert.deepEqual(recentChats(), [["eps", 1]]);
    rememberChat("eps", row(1, { archived: true }));
    assert.equal(stored.get("mimi-os:last-chat"), "[]");
});

test("a chat viewed in another window never swaps the one kept here", () => {
    rememberChat("delta", row(4));
    stored.set("mimi-os:last-chat", JSON.stringify([["delta", 11]]));
    assert.equal(lastChat("delta"), 4);
    forgetChat("delta", 4);
});

test("the landing: last place talked in, else last chat, else the first agent, and Settings only with no agents", () => {
    stored.clear();
    assert.deepEqual(landing([]), { at: "settings", section: "access" });
    assert.deepEqual(landing(["alpha", "beta"]), { at: "agent", agent: "alpha" });

    rememberChat("beta", row(2));
    go({ at: "chat", agent: "gamma", id: 8 });
    assert.deepEqual(landing(["alpha", "beta", "gamma"]), { at: "chat", agent: "gamma", id: 8 }, "the last place");
    assert.deepEqual(landing(["alpha", "beta"]), { at: "chat", agent: "beta", id: 2 }, "a gone agent's place falls to the last chat still reachable");

    go({ at: "settings", section: "models" });
    go({ at: "inbox" });
    go({ at: "new", agent: "alpha" });
    go({ at: "rooms", room: "7" });
    assert.deepEqual(landing(["alpha", "gamma"]), { at: "chat", agent: "gamma", id: 8 }, "Settings, Inbox, a new chat and a room are never where the app opens");

    go({ at: "agent", agent: "alpha", tab: "settings" });
    assert.deepEqual(landing(["alpha"]), { at: "agent", agent: "alpha", tab: "settings" });
});

test("the Settings link returns to the last section, never models by default; the index is no section", () => {
    stored.clear();
    assert.equal(lastSettings(), "health");
    go({ at: "settings", section: "models" });
    go({ at: "settings" });
    assert.equal(lastSettings(), "models");
});

test("the entry the app opens on lands at once on the last place talked in, so Back never finds it blank", async () => {
    stored.set("mimi-os:last-place", "#/a/beta/2");
    entries.splice(0, Infinity, { url: "", state: null });
    at = 0;
    fake.hash = "";
    const opened = await import("../src/route.ts?opened");
    assert.equal(fake.hash, "#/a/beta/2");
    assert.deepEqual(entries, [{ url: "#/a/beta/2", state: { i: 0 } }]);
    assert.deepEqual(opened.here(), { at: "chat", agent: "beta", id: 2 });
});

test("on a phone the app opens on Home and stays there", async () => {
    stored.set("mimi-os:last-place", "#/a/beta/2");
    entries.splice(0, Infinity, { url: "#/", state: null });
    at = 0;
    fake.hash = "#/";
    wide = false;
    try {
        const opened = await import("../src/route.ts?phone");
        assert.equal(fake.hash, "#/");
        assert.deepEqual(opened.here(), { at: "home" });
    } finally {
        wide = true;
    }
});

test("a pairing link at startup is never replaced", async () => {
    fake.hash = "#pair=abc";
    await import("../src/route.ts?paired");
    assert.equal(fake.hash, "#pair=abc");
});

test("a phone opened deep gets Home and the parents stacked under it, so Back climbs and leaves only from Home", async () => {
    entries.splice(0, Infinity, { url: "#/a/beta/new", state: null });
    at = 0;
    fake.hash = "#/a/beta/new";
    wide = false;
    try {
        const deep = await import("../src/route.ts?deep");
        assert.deepEqual(entries, [
            { url: "#/", state: { i: 0 } },
            { url: "#/a/beta", state: { i: 1 } },
            { url: "#/a/beta/new", state: { i: 2 } },
        ]);
        assert.deepEqual(deep.here(), { at: "new", agent: "beta" });
        deep.back();
        assert.deepEqual(deep.here(), { at: "agent", agent: "beta" });
        deep.back();
        assert.deepEqual(deep.here(), { at: "home" });
    } finally {
        wide = true;
    }
});

test("a phone opened on a Settings section gets Home and the index under it", async () => {
    entries.splice(0, Infinity, { url: "#/settings/access", state: null });
    at = 0;
    fake.hash = "#/settings/access";
    wide = false;
    try {
        const deep = await import("../src/route.ts?settings");
        assert.deepEqual(entries, [
            { url: "#/", state: { i: 0 } },
            { url: "#/settings", state: { i: 1 } },
            { url: "#/settings/access", state: { i: 2 } },
        ]);
        deep.back();
        assert.deepEqual(deep.here(), { at: "settings" });
    } finally {
        wide = true;
    }
});

test("a reload over an open overlay steps off its entry", async () => {
    entries.splice(0, Infinity, { url: "#/inbox", state: { i: 1 } }, { url: "#/inbox", state: { i: 1, held: 1 } });
    at = 1;
    fake.hash = "#/inbox";
    await import("../src/route.ts?held");
    await tick();
    assert.equal(at, 0);
    assert.deepEqual(entries[1], { url: "#/inbox", state: { i: 1, held: 1 } }, "left as it was, only stepped off");
});

test("where only the pult moves history, a frame's history.back(), go() or forward() moves neither the screen nor an overlay", async () => {
    // the instances loaded above are done: only this one hears the pops
    listeners.clear();
    entries.splice(0, Infinity, { url: "#/a/wren/3", state: null });
    at = 0;
    fake.hash = "#/a/wren/3";
    const guarded = await import("../src/route.ts?guarded");
    guarded.guardHistory();
    guarded.go({ at: "settings", section: "usage" });
    guarded.go({ at: "chat", agent: "wren", id: 4 });
    let closed = 0;
    guarded.holdBack(() => { closed += 1; });
    await tick();
    assert.equal(entries.length, 4);
    const nav = guarded.snapshot().nav;

    step(-1);
    assert.equal(closed, 0, "a pop off the overlay's entry closes nothing");
    assert.deepEqual(entries[at], { url: "#/a/wren/4", state: { i: 2, held: 1 } }, "and the entry comes back");

    step(-3);
    assert.deepEqual(guarded.here(), { at: "chat", agent: "wren", id: 4 });
    assert.equal(guarded.snapshot().nav, nav, "no arrival refires");
    assert.equal(closed, 0);
    assert.deepEqual(entries, [
        { url: "#/a/wren/3", state: { i: 0 } },
        { url: "#/a/wren/4", state: { i: 1 } },
        { url: "#/a/wren/4", state: { i: 1, held: 1 } },
    ], "the place went back on top of the entry it landed on, its overlay above it");
    assert.equal(guarded.snapshot().index, 1);

    guarded.back();
    assert.equal(closed, 1, "the pult's own Back still closes the overlay");
    guarded.back();
    assert.deepEqual(guarded.here(), { at: "chat", agent: "wren", id: 3 }, "and walks back");

    step(1);
    assert.deepEqual(guarded.here(), { at: "chat", agent: "wren", id: 3 }, "a frame's forward() moves nothing either");
    assert.deepEqual(entries[at], { url: "#/a/wren/3", state: { i: 2 } });
});

test("a pult step that lands on a frame's own entry is given up: a dialog's answer still runs, a phone's pop to Home still lands, and the guard still holds", async (t) => {
    listeners.clear();
    stored.clear();
    entries.splice(0, Infinity, { url: "#/", state: null });
    at = 0;
    fake.hash = "#/";
    const framed = await import("../src/route.ts?framed");
    framed.guardHistory();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    framed.go({ at: "chat", agent: "wren", id: 4 });
    const chat = { at: "chat", agent: "wren", id: 4 };

    const hold = framed.holdBack(() => undefined);
    await tick();
    let answered = false;
    frameSteps = 1;
    framed.releaseBack(hold, () => { answered = true; });
    await tick();
    assert.equal(answered, false, "the pop moved only the frame");
    t.mock.timers.tick(300);
    await tick();
    assert.equal(answered, true, "retried once the step went unheard");
    assert.deepEqual(entries.slice(0, at + 1), [{ url: "#/", state: { i: 0 } }, { url: "#/a/wren/4", state: { i: 1 } }]);
    t.mock.timers.tick(300);

    frameSteps = 1;
    framed.back();
    t.mock.timers.tick(300);
    step(-1);
    assert.deepEqual(framed.here(), chat, "a frame's pop after an unheard Back is still undone");

    wide = false;
    try {
        frameSteps = 1;
        framed.go({ at: "home" });
        await tick();
        assert.deepEqual(framed.here(), chat);
        t.mock.timers.tick(300);
        assert.deepEqual(framed.here(), { at: "home" }, "Home lands in place");
        framed.go({ at: "chat", agent: "wren", id: 5 });
        assert.deepEqual(framed.here(), { at: "chat", agent: "wren", id: 5 }, "the pult moves again");
        step(-1);
        assert.deepEqual(framed.here(), { at: "chat", agent: "wren", id: 5 }, "and a frame's pop is still undone");
    } finally {
        wide = true;
    }
});
