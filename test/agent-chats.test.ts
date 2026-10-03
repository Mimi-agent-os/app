// agent-chats.ts and the real route.ts under it, against an EventTarget window, a Map storage and a stubbed api.ts.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";

import type { ConversationInfo } from "../src/api.ts";
import type { ApprovalSummary } from "../src/approval-api.ts";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const API = stub(
    "export const listConversations = (agent, all) => globalThis.__list(agent, all);" +
    "export const createConversation = (agent) => globalThis.__create(agent);" +
    "export const patchConversation = (agent, id, edit) => globalThis.__patch(agent, id, edit);",
);
const REACT = stub("export const useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();");

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (context.parentURL?.endsWith("/src/agent-chats.ts")) {
            if (specifier === "./api.ts") return { url: API, shortCircuit: true };
            if (specifier === "react") return { url: REACT, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const stored = new Map<string, string>();
Object.assign(globalThis, {
    window: new EventTarget(),
    location: { hash: "" },
    history: { state: null, pushState: () => undefined, replaceState: () => undefined },
    matchMedia: () => ({ matches: false }),
    localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
    },
});

function chat(id: number, over: Partial<ConversationInfo> = {}): ConversationInfo {
    return {
        id, title: `Chat ${id}`, archived: false, pinned: false, createdAt: "2026-09-01 09:00:00",
        updatedAt: `2026-09-${String(10 + id).padStart(2, "0")} 09:00:00`, messages: 4, busy: false, awaitingApproval: false,
        titleByUser: false, ...over,
    };
}

// what the gateway holds per agent; an agent in `down` answers 503, and while `held` is set every answer waits for release
const server = new Map<string, ConversationInfo[]>();
const down = new Set<string>();
const fetched: string[] = [];
const created: string[] = [];
let held: (() => void)[] | null = null;
// what the next PATCH answers; `hold` keeps it waiting until released
let patchAnswer: { ok: boolean } | Error = { ok: true };
let patchHold: (() => void) | null = null;
const patched: [string, number, unknown][] = [];

Object.assign(globalThis, {
    __list: (agent: string, all: boolean): Promise<ConversationInfo[]> => {
        assert.equal(all, true, "the store lists archived chats too");
        fetched.push(agent);
        const answer = (): Promise<ConversationInfo[]> => down.has(agent)
            ? Promise.reject(new Error(`GET /agents/${agent}/conversations → 503: agent offline`))
            : Promise.resolve(structuredClone(server.get(agent) ?? []));
        const queue = held;
        if (!queue) return answer();
        return new Promise((resolve, reject) => { queue.push(() => { answer().then(resolve, reject); }); });
    },
    __patch: (agent: string, id: number, edit: Partial<ConversationInfo>): Promise<{ ok: boolean }> => {
        patched.push([agent, id, edit]);
        const answer = patchAnswer;
        const settle = (): Promise<{ ok: boolean }> => {
            if (answer instanceof Error) return Promise.reject(answer);
            if (answer.ok) server.set(agent, (server.get(agent) ?? []).map((c) => (c.id === id ? { ...c, ...edit } : c)));
            return Promise.resolve(answer);
        };
        return new Promise((resolve, reject) => {
            const go = (): void => { settle().then(resolve, reject); };
            if (patchHold === null) go();
            else patchHold = go;
        });
    },
    __create: (agent: string): Promise<{ id: number }> => {
        created.push(agent);
        const rows = server.get(agent) ?? [];
        const id = Math.max(0, ...rows.map((c) => c.id)) + 1;
        server.set(agent, [...rows, chat(id, { title: null, messages: 0, updatedAt: "2026-09-28 12:00:00" })]);
        return Promise.resolve({ id });
    },
});

const {
    NO_CHATS, agentLanding, agentState, dropChat, editChat, homeChats, openEmptyChat, refreshAgent, startAgentChats, useAgentChats, useChats,
} = await import("../src/agent-chats.ts");
const { rememberChat } = await import("../src/route.ts");

const settle = async (): Promise<void> => {
    for (let spin = 0; spin < 10; spin++) await new Promise((r) => setImmediate(r));
};
const ids = (rows: readonly ConversationInfo[] | null | undefined): number[] | undefined => rows?.map((c) => c.id);
const cache = (): Record<string, ConversationInfo[]> => JSON.parse(stored.get("mimi-os:chat-titles") ?? "{}") as Record<string, ConversationInfo[]>;
const gate = (over: Partial<ApprovalSummary>): ApprovalSummary =>
    ({ gate: "g", agent: "wren", tool: "send_email", label: "Send an email", actions: [], since: "2026-09-28 09:00:00", deadline: 1000, ...over });

async function fresh(agents: Record<string, ConversationInfo[]>): Promise<void> {
    startAgentChats([]);
    stored.clear();
    down.clear();
    held = null;
    patchAnswer = { ok: true };
    patchHold = null;
    patched.length = 0;
    server.clear();
    for (const [agent, rows] of Object.entries(agents)) server.set(agent, rows);
    startAgentChats(Object.keys(agents));
    await settle();
    fetched.length = 0;
    created.length = 0;
}

// ── pure rules ────────────────────────────────────────────────────────────────

test("homeChats shows every pinned chat, then the three most recent, and counts every listed chat", () => {
    const rows = [
        chat(9), chat(8, { pinned: true }), chat(7), chat(6), chat(5), chat(4, { pinned: true }), chat(3),
    ];
    const { shown, total } = homeChats(rows, undefined);
    assert.deepEqual(ids(shown), [8, 4, 9, 7, 6]);
    assert.equal(total, 7);
});

test("homeChats leaves out archived chats, delegation threads and empty chats", () => {
    const rows = [
        chat(9, { archived: true }), chat(8, { title: "← Draft reply", titleByUser: true }), chat(7, { messages: 0, title: null }),
        chat(6), chat(5, { title: "← typed by the owner", titleByUser: false }), chat(4, { archived: true, pinned: true }),
    ];
    const { shown, total } = homeChats(rows, undefined);
    assert.deepEqual(ids(shown), [6, 5]);
    assert.equal(total, 2);
});

test("homeChats keeps the open chat: an empty one right after the pinned, a cut one in its place", () => {
    const rows = [chat(9), chat(8), chat(7, { messages: 0, title: null }), chat(6), chat(5), chat(4), chat(3, { pinned: true })];
    assert.deepEqual(ids(homeChats(rows, 7).shown), [3, 7, 9, 8, 6]);
    assert.equal(homeChats(rows, 7).total, 6, "an empty chat is shown but never counted");
    assert.deepEqual(ids(homeChats(rows, 4).shown), [3, 9, 8, 6, 4]);
    assert.deepEqual(ids(homeChats(rows, 8).shown), [3, 9, 8, 6], "an open chat already in the top three adds nothing");
    assert.deepEqual(ids(homeChats([chat(3), chat(2, { archived: true })], 2).shown), [3, 2], "an archived open chat still shows while it is open");
    assert.deepEqual(homeChats(rows, 4).hidden, 1, "a cut chat shown because it is open is not counted as hidden");
});

test("homeChats fills an agent's share: pinned chats use it first, at least 3 recent always show, and the rest is hidden", () => {
    const rows = [chat(12), chat(11), chat(10, { pinned: true }), chat(9), chat(8), chat(7), chat(6), chat(5), chat(4), chat(3), chat(2), chat(1)];
    const eight = homeChats(rows, undefined, 8);
    assert.deepEqual(ids(eight.shown), [10, 12, 11, 9, 8, 7, 6, 5]);
    assert.equal(eight.hidden, 4);
    assert.equal(eight.total, 12);
    const pinnedMany = [chat(9, { pinned: true }), chat(8, { pinned: true }), chat(7, { pinned: true }), chat(6), chat(5), chat(4), chat(3)];
    assert.deepEqual(ids(homeChats(pinnedMany, undefined, 4).shown), [9, 8, 7, 6, 5, 4], "pins never push the recent ones under 3");
    assert.equal(homeChats(rows, undefined, 20).hidden, 0);
});

test("agentState: the loudest true state wins", () => {
    const me = { connected: true, lastSeen: "2026-09-28 09:00:00", paused: false };
    assert.equal(agentState(me, false, false), null);
    assert.deepEqual(agentState({ ...me, paused: true }, false, false), { word: "paused", tone: "mute" });
    assert.deepEqual(agentState({ ...me, connected: false, lastSeen: null, paused: true }, false, false), { word: "offline", tone: "mute" });
    assert.match(agentState({ ...me, connected: false }, false, false)?.word ?? "", /^offline since \S/);
    assert.deepEqual(agentState({ ...me, connected: false, paused: true }, false, true), { word: "responding", tone: "accent" });
    assert.deepEqual(agentState({ ...me, connected: false, paused: true }, true, true), { word: "needs you", tone: "warn" });
});

// ── the store ────────────────────────────────────────────────────────────────

test("rows arrive sorted by last activity, then by id, archived chats included", async () => {
    await fresh({
        wren: [
            chat(1, { updatedAt: "2026-09-20 08:00:00" }), chat(2, { updatedAt: "2026-09-27 08:00:00" }),
            chat(3, { updatedAt: "2026-09-20 08:00:00", archived: true }), chat(4, { updatedAt: "2026-09-21 08:00:00" }),
        ],
    });
    assert.deepEqual(ids(useChats("wren").rows), [2, 4, 3, 1]);
    assert.equal(useChats("wren").stale, false);
    assert.equal(useChats("nobody"), NO_CHATS);
});

test("an agent seen for the first time shows no rows until its list arrives", async () => {
    await fresh({});
    held = [];
    server.set("wren", [chat(1)]);
    startAgentChats(["wren"]);
    assert.deepEqual(useChats("wren"), { rows: null, stale: false, error: "" });
    const release = held;
    held = null;
    for (const answer of release) answer();
    await settle();
    assert.deepEqual(ids(useChats("wren").rows), [1]);
});

test("calls during a fetch share one fetch queued behind it", async () => {
    await fresh({ wren: [chat(1)] });
    held = [];
    const first = refreshAgent("wren");
    const second = refreshAgent("wren");
    const third = refreshAgent("wren");
    const fourth = refreshAgent("wren");
    assert.equal(second, third);
    assert.equal(third, fourth);
    assert.deepEqual(fetched, ["wren"]);

    server.set("wren", [chat(1), chat(2)]);
    held.shift()?.();
    assert.deepEqual(ids(await first), [2, 1]);
    await settle();
    assert.deepEqual(fetched, ["wren", "wren"]);
    held.shift()?.();
    assert.deepEqual(ids(await second), [2, 1]);
    assert.deepEqual(fetched, ["wren", "wren"], "exactly two fetches");
    held = null;

    await refreshAgent("wren");
    assert.deepEqual(fetched, ["wren", "wren", "wren"], "a call after the flight settled starts a new one");
});

test("a failed refresh keeps the last rows as stale, records the error and rejects", async () => {
    await fresh({ wren: [chat(1), chat(2)] });
    down.add("wren");
    await assert.rejects(refreshAgent("wren"), /agent offline/);
    const entry = useChats("wren");
    assert.deepEqual(ids(entry.rows), [2, 1]);
    assert.equal(entry.stale, true);
    assert.match(entry.error, /agent offline/);

    down.delete("wren");
    await refreshAgent("wren");
    assert.deepEqual(useChats("wren"), { rows: useChats("wren").rows, stale: false, error: "" });
});

test("a change to one agent replaces the map but keeps every other agent's entry", async () => {
    await fresh({ wren: [chat(1)], scout: [chat(2)] });
    const before = useAgentChats();
    const scout = useChats("scout");
    server.set("wren", [chat(1), chat(3)]);
    await refreshAgent("wren");
    assert.notEqual(useAgentChats(), before);
    assert.equal(useChats("scout"), scout);
    assert.deepEqual(ids(useChats("wren").rows), [3, 1]);
});

test("the title cache holds what the home list shows, never live state, and seeds an agent as stale", async () => {
    await fresh({
        wren: [
            chat(1, { busy: true, awaitingApproval: true }), chat(2, { archived: true }), chat(3, { messages: 0, title: null }),
            chat(4, { title: "← Draft reply", titleByUser: true }), chat(5, { pinned: true }), chat(6), chat(7), chat(8),
        ],
    });
    const kept = cache()["wren"];
    assert.deepEqual(ids(kept), [5, 8, 7, 6, 1], "as many rows as the home list can show");
    assert.ok(kept?.every((c) => !c.busy && !c.awaitingApproval));

    startAgentChats([]);
    assert.equal(useChats("wren"), NO_CHATS);
    assert.equal(cache()["wren"], undefined, "an agent no longer listed leaves the cache too");

    stored.set("mimi-os:chat-titles", JSON.stringify({ wren: [chat(1, { updatedAt: "2026-09-01 00:00:00" }), chat(2)] }));
    down.add("wren");
    startAgentChats(["wren"]);
    assert.deepEqual(useChats("wren"), { rows: useChats("wren").rows, stale: true, error: "" });
    assert.deepEqual(ids(useChats("wren").rows), [2, 1], "sorted like fresh rows");
    await settle();
    assert.equal(useChats("wren").stale, true, "an offline agent keeps its cached titles");
    assert.match(useChats("wren").error, /agent offline/);
});

test("a row the list could not render or address is dropped, whether the agent sends it or the cache gives it back", async () => {
    // what a compromised agent's session_list can carry, and what such a list leaves in the cache
    const planted = [
        { ...chat(20), id: "../../../pins/victim" }, { ...chat(21), id: 0 }, { ...chat(22), id: 2 ** 53 },
        { ...chat(23), title: { $$typeof: "x", evil: [1, 2] } },
        { ...chat(24), titleByUser: "yes" }, { ...chat(25), archived: "no" }, { ...chat(26), pinned: { a: 1 } },
        { ...chat(27), messages: -1 }, { ...chat(28), messages: "4" }, { ...chat(29), updatedAt: "yesterday" }, { ...chat(30), createdAt: 7 },
        { ...chat(31), activeTurnSeq: "1" }, null, "row", [chat(32)],
    ] as unknown as ConversationInfo[];
    await fresh({ evil: [chat(1), ...planted] });
    assert.deepEqual(ids(useChats("evil").rows), [1]);
    assert.deepEqual(ids(cache()["evil"]), [1], "nothing the list dropped reaches the cache");

    startAgentChats([]);
    stored.set("mimi-os:chat-titles", JSON.stringify({ evil: [chat(2), ...planted], scout: { title: "not a list" } }));
    down.add("evil");
    down.add("scout");
    startAgentChats(["evil", "scout"]);
    assert.deepEqual(ids(useChats("evil").rows), [2]);
    assert.equal(useChats("scout").rows, null, "a cache entry that is not a list seeds nothing");
    await settle();
    assert.deepEqual(ids(useChats("evil").rows), [2], "the agent is offline, so the cleaned cache is what stays");
});

test("an offline agent with no cache shows an empty stale list, not a skeleton forever", async () => {
    await fresh({});
    down.add("scout");
    startAgentChats(["scout"]);
    await settle();
    assert.deepEqual(useChats("scout"), { rows: [], stale: true, error: useChats("scout").error });
});

test("an answer that lands after its agent was dropped does not bring it back", async () => {
    await fresh({ wren: [chat(1)] });
    held = [];
    const late = refreshAgent("wren");
    startAgentChats([]);
    held.shift()?.();
    held = null;
    assert.deepEqual(ids(await late), [1]);
    assert.equal(useChats("wren"), NO_CHATS);
    assert.equal(useAgentChats().size, 0);
});

test("mimi:chat-changed refreshes only the agent it names", async () => {
    await fresh({ wren: [chat(1)], scout: [chat(2)] });
    server.set("wren", [chat(1, { title: "Plan week" })]);
    window.dispatchEvent(new CustomEvent("mimi:chat-changed", { detail: { agent: "wren", sessions: [1] } }));
    window.dispatchEvent(new CustomEvent("mimi:chat-changed", { detail: { agent: "stranger", sessions: [1] } }));
    await settle();
    assert.deepEqual(fetched, ["wren"]);
    assert.equal(useChats("wren").rows?.[0]?.title, "Plan week");
});

test("mimi:resync refreshes every agent; mimi:agent-changed only those stale or failing", async () => {
    await fresh({ wren: [chat(1)], scout: [chat(2)] });
    window.dispatchEvent(new CustomEvent("mimi:resync"));
    await settle();
    assert.deepEqual(fetched.toSorted(), ["scout", "wren"]);

    fetched.length = 0;
    down.add("scout");
    await refreshAgent("scout").catch(() => undefined);
    down.delete("scout");
    fetched.length = 0;
    window.dispatchEvent(new CustomEvent("mimi:agent-changed"));
    await settle();
    assert.deepEqual(fetched, ["scout"]);
    assert.equal(useChats("scout").stale, false);
});

test("an edit lands in the list before the gateway answers, and unknown rows are ignored", async () => {
    await fresh({ wren: [chat(1), chat(2)] });
    patchHold = () => undefined;
    const pending = editChat("wren", 1, { title: "Renamed", pinned: true });
    assert.deepEqual(useChats("wren").rows?.map((c) => [c.id, c.title, c.pinned, c.titleByUser]), [[2, "Chat 2", false, false], [1, "Renamed", true, true]]);
    assert.deepEqual(patched, [["wren", 1, { title: "Renamed", pinned: true }]], "the gateway gets only what the owner changed");
    patchHold();
    await pending;
    const entry = useChats("wren");
    await editChat("wren", 99, { title: "x" });
    await editChat("nobody", 1, { title: "x" });
    assert.equal(useChats("wren"), entry);
    dropChat("wren", 2);
    assert.deepEqual(ids(useChats("wren").rows), [1]);
});

test("a list fetched before an edit was answered never undoes it", async () => {
    await fresh({ wren: [chat(1), chat(2)] });
    held = [];
    const early = refreshAgent("wren");
    await editChat("wren", 1, { pinned: true });
    // the list read began before the PATCH, so it answers with the chat as it was
    server.set("wren", [chat(1), chat(2)]);
    held.shift()?.();
    held = null;
    await early;
    assert.equal(useChats("wren").rows?.find((c) => c.id === 1)?.pinned, true, "the older answer is laid under the edit");

    await refreshAgent("wren");
    assert.equal(useChats("wren").rows?.find((c) => c.id === 1)?.pinned, false, "a list begun after the answer is the truth again");
});

test("a refused edit puts the row back and rejects, a { ok: false } answer included", async () => {
    await fresh({ wren: [chat(1)] });
    patchAnswer = new Error("PATCH → 503: agent offline");
    await assert.rejects(editChat("wren", 1, { pinned: true }), /agent offline/);
    assert.equal(useChats("wren").rows?.[0]?.pinned, false);

    patchAnswer = { ok: false };
    await assert.rejects(editChat("wren", 1, { archived: true }), /no longer has this chat/);
    assert.equal(useChats("wren").rows?.[0]?.archived, false);
    await settle();
});

test("a deleted chat stays gone from a list fetched before the delete", async () => {
    await fresh({ wren: [chat(1), chat(2)] });
    held = [];
    const early = refreshAgent("wren");
    dropChat("wren", 2);
    held.shift()?.();
    held = null;
    await early;
    assert.deepEqual(ids(useChats("wren").rows), [1]);
});

test("a new chat reuses the agent's untouched chat, and only creates one when there is none", async () => {
    await fresh({ wren: [chat(1), chat(2, { messages: 0, title: null })] });
    assert.equal(await openEmptyChat("wren"), 2);
    assert.deepEqual(fetched, [], "the known rows answered");

    await fresh({ wren: [chat(1)] });
    server.set("wren", [chat(1), chat(3, { messages: 0, title: null })]);
    assert.equal(await openEmptyChat("wren"), 3, "a refetch found one made elsewhere");
    assert.deepEqual(created, []);

    await fresh({
        wren: [chat(1), chat(2, { messages: 0, title: null, busy: true }), chat(3, { messages: 0, title: null, archived: true }),
            chat(4, { messages: 0, title: "Named" })],
    });
    const id = await openEmptyChat("wren");
    assert.equal(id, 5);
    assert.deepEqual(created, ["wren"]);
    assert.ok(useChats("wren").rows?.some((c) => c.id === 5), "the list already holds the new chat");
});

test("pressing new chat twice while the first is still found makes one chat", async () => {
    await fresh({ wren: [chat(1)] });
    const [a, b] = await Promise.all([openEmptyChat("wren"), openEmptyChat("wren")]);
    assert.equal(a, b);
    assert.deepEqual(created, ["wren"]);
});

test("a failed refresh is retried with backoff until one succeeds", async () => {
    await fresh({ wren: [chat(1)] });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        down.add("wren");
        await refreshAgent("wren").catch(() => undefined);
        fetched.length = 0;
        mock.timers.tick(2_000);
        await settle();
        assert.deepEqual(fetched, ["wren"], "the first retry after 2s");
        mock.timers.tick(3_999);
        await settle();
        assert.deepEqual(fetched, ["wren"], "the next one waits twice as long");
        down.delete("wren");
        mock.timers.tick(1);
        await settle();
        assert.equal(useChats("wren").stale, false);
        mock.timers.tick(120_000);
        await settle();
        assert.deepEqual(fetched, ["wren", "wren"], "nothing more once it answered");
    } finally {
        mock.timers.reset();
    }
});

test("a new chat for an agent that cannot answer fails, and creates nothing", async () => {
    await fresh({ wren: [chat(1)] });
    down.add("wren");
    await assert.rejects(openEmptyChat("wren"), /agent offline/);
    assert.deepEqual(created, []);
});

test("agentLanding: the soonest gate's chat, else the last chat viewed, else the most recent, else the agent page", async () => {
    await fresh({
        wren: [chat(1), chat(2, { archived: true }), chat(3, { title: "← Draft", titleByUser: true }), chat(4), chat(5, { messages: 0, title: null })],
        scout: [],
    });
    const gates = [
        gate({ conversation: 1, deadline: 3000 }), gate({ conversation: 4, deadline: 2000 }), gate({ room: "r-1", deadline: 1000 }),
        gate({ deadline: 500 }), gate({ agent: "scout", conversation: 9, deadline: 100 }),
    ];
    assert.deepEqual(agentLanding("wren", gates), { at: "chat", agent: "wren", id: 4 });

    rememberChat("wren", chat(1));
    assert.deepEqual(agentLanding("wren", []), { at: "chat", agent: "wren", id: 1 });
    rememberChat("wren", chat(99));
    assert.deepEqual(agentLanding("wren", []), { at: "chat", agent: "wren", id: 4 }, "a remembered chat not in the list falls to the most recent");
    assert.deepEqual(agentLanding("scout", []), { at: "agent", agent: "scout" });
    assert.deepEqual(agentLanding("nobody", []), { at: "agent", agent: "nobody" });
});
