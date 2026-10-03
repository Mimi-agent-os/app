// Activity rows read their detail once, when opened: inbox-api.ts over a counting stub channel, inbox.tsx's effect lifted from source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import type { InteractionPage, InteractionRow } from "../src/inbox-api.ts";

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
        if (specifier === "./channel.ts" && context.parentURL?.endsWith("/src/inbox-api.ts")) return { url: CHANNEL, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

// what the gateway holds: every exchange in full; the list answers rows without args and result, a detail as the exchange stood when asked
const exchanges = new Map<string, Record<string, unknown>>();
const requests: string[] = [];
// details kept on the wire while `holding`, as a slow link keeps 512 KiB
const held: (() => void)[] = [];
let holding = false;
Object.assign(globalThis, {
    window: new EventTarget(),
    __fetch: (path: string) => {
        requests.push(path);
        if (path.startsWith("/interactions?")) {
            const rows = [...exchanges.values()].map(({ args: _args, result: _result, ...row }) => row);
            return Promise.resolve({ res: new Response(JSON.stringify({ interactions: rows, hasMore: false })) });
        }
        const detail = exchanges.get(decodeURIComponent(path.slice("/interactions/".length)));
        const answer = { res: detail ? new Response(JSON.stringify(detail)) : new Response("{}", { status: 404 }) };
        return holding ? new Promise((resolve) => held.push(() => resolve(answer))) : Promise.resolve(answer);
    },
});

const { cachedDetail, listInteractions, readInteraction } = await import("../src/inbox-api.ts");

const exchange = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, kind: "a2a", from: "wren", to: "scout", createdAt: "2026-09-28 10:00:00", status: "sent", statusChangedAt: "2026-09-28 10:00:00",
    command: "search", args: JSON.stringify({ q: "x".repeat(1000) }), ...over,
});
const rowOf = async (id: string): Promise<InteractionRow> => {
    const row = (await listInteractions()).interactions.find((r) => r.id === id);
    assert.ok(row, `no row ${id}`);
    return row;
};
// every detail read the feed started, until it lands; a landing may start the next one
const flights = new Set<Promise<void>>();
async function settle(): Promise<void> {
    while (flights.size > 0) await Promise.allSettled([...flights]);
}

test("a list row carries no args or result; opening it reads the detail once, and a collapse keeps it", async () => {
    exchanges.clear();
    exchanges.set("x1", exchange("x1", { status: "answered", result: "{\"hits\":3}" }));
    const row = await rowOf("x1");
    assert.equal("args" in row || "result" in row, false);
    assert.equal(row.command, "search", "the list still names what was asked");

    assert.equal(cachedDetail(row), undefined, "nothing is read before the row opens");
    requests.length = 0;
    await readInteraction(row);
    assert.deepEqual(requests, ["/interactions/x1"]);
    assert.equal(cachedDetail(row)?.result, "{\"hits\":3}");
    assert.match(cachedDetail(row)?.args ?? "", /^\{"q"/);
    assert.deepEqual(requests, ["/interactions/x1"], "shown again after a collapse without another request");
});

test("a row whose exchange moved on since is read again", async () => {
    exchanges.clear();
    exchanges.set("x2", exchange("x2"));
    await readInteraction(await rowOf("x2"));
    exchanges.set("x2", exchange("x2", { status: "answered", statusChangedAt: "2026-09-28 10:05:00", result: "{\"done\":true}" }));
    const moved = await rowOf("x2");
    assert.equal(cachedDetail(moved), undefined, "the detail read while it was sent is stale now");
    await readInteraction(moved);
    assert.equal(cachedDetail(moved)?.result, "{\"done\":true}");
});

test("an exchange answered within the second it was sent is read again: the stamp alone does not move", async () => {
    exchanges.clear();
    exchanges.set("x3", exchange("x3"));
    await readInteraction(await rowOf("x3"));
    exchanges.set("x3", exchange("x3", { status: "answered", result: "{\"fast\":true}", durationMs: 180 }));
    const answered = await rowOf("x3");
    assert.equal(cachedDetail(answered), undefined, "the sent detail, with no result, would pass for the answered one");
    await readInteraction(answered);
    assert.equal(cachedDetail(answered)?.result, "{\"fast\":true}");
});

test("a pruned exchange is remembered as gone, whatever its row says", async () => {
    exchanges.clear();
    const row: InteractionRow = { id: "gone", from: "a", to: "b", createdAt: "2026-09-29 10:00:00", status: "sent", statusChangedAt: "2026-09-29 10:00:01" };
    assert.equal(await readInteraction(row), null);
    assert.equal(cachedDetail({ ...row, status: "answered", statusChangedAt: "2026-09-29 10:00:02" }), null);
});

test("only the latest 20 details are kept: each can weigh 512 KiB", async () => {
    exchanges.clear();
    for (let i = 0; i < 21; i++) exchanges.set(`k${i}`, exchange(`k${i}`));
    const rows = (await listInteractions()).interactions;
    for (const row of rows) await readInteraction(row);
    assert.equal(cachedDetail(rows[0]!), undefined, "the oldest read was dropped");
    assert.ok(rows.slice(1).every((row) => cachedDetail(row)?.id === row.id));
});

// ── the feed, as inbox.tsx declares it ─────────────────────────────────────────

const source = await readFile(new URL("../src/views/inbox.tsx", import.meta.url), "utf8");
const effect = /useEffect\(\(\) => \{\n\s*(for \(const row of page\?\.interactions \?\? \[\]\) [^\n]+)\n\s*\}, \[([^\]]*)\]\);/.exec(source);
assert.ok(effect, "inbox.tsx reads open rows in one effect over the page and the open set");
const readBody = /const read = async \(row: InteractionRow\): Promise<void> => \{([\s\S]*?)\n {4}\};/.exec(source);
assert.ok(readBody, "inbox.tsx reads one row in one read function");
const deps = (effect[2] as string).split(",").map((name) => name.trim());
const readOpen = new Function("page", "open", "cachedDetail", "read", effect[1] as string) as
    (page: { interactions: { id: string }[] } | null, open: ReadonlySet<string>, cached: (row: { id: string }) => unknown, read: (row: { id: string }) => void) => void;
const AsyncFunction = (async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
const readRow = new AsyncFunction(
    "row", "reading", "generation", "live", "setError", "setOpen", "setLanded", "readInteraction", "errorMessage", readBody[1] as string,
);

type Update<T> = T | ((old: T) => T);

// the feed as React runs it: every state change re-renders, and the effect runs again only when one of its declared deps changed
function feed(page: InteractionPage): { set: (next: Partial<State>) => void; state: State } {
    const state: State = { page, open: new Set(), landed: 0, error: "" };
    const reading = { current: new Set<string>() };
    let last: unknown[] | undefined;
    const render = (): void => {
        const now = deps.map((name) => {
            assert.ok(name in state, `the effect depends on ${name}, which this harness does not model`);
            return state[name as keyof State];
        });
        if (last && now.every((value, i) => Object.is(value, last![i]))) return;
        last = now;
        readOpen(state.page, state.open, cachedDetail, read);
    };
    const setter = <K extends keyof State>(key: K) => (update: Update<State[K]>): void => {
        state[key] = typeof update === "function" ? (update as (old: State[K]) => State[K])(state[key]) : update;
        render();
    };
    const read = (row: { id: string }): void => {
        const flight: Promise<void> = readRow(
            row, reading, { current: 0 }, { current: true }, setter("error"), setter("open"), setter("landed"), readInteraction,
            (e: unknown) => String(e),
        ).finally(() => flights.delete(flight));
        flights.add(flight);
    };
    render();
    return { set: (next) => { Object.assign(state, next); render(); }, state };
}
interface State { page: InteractionPage; open: ReadonlySet<string>; landed: number; error: string }

test("the feed reads a row only while it is open and nothing fresh is cached for it", async () => {
    exchanges.clear();
    for (const id of ["opened", "closed", "cached"]) exchanges.set(id, exchange(id));
    const page = await listInteractions();
    await readInteraction(page.interactions.find((row) => row.id === "cached")!);
    const view = feed(page);
    requests.length = 0;
    view.set({ open: new Set(["opened", "cached"]) });
    await settle();
    assert.deepEqual(requests, ["/interactions/opened"]);
    assert.equal(cachedDetail(page.interactions.find((row) => row.id === "opened")!)?.id, "opened");
    await settle();
    assert.deepEqual(requests, ["/interactions/opened"], "a read that landed fresh is not read again");
});

test("a read still on a slow link when a refresh moves its exchange on is read again once it lands, never left loading", async () => {
    exchanges.clear();
    exchanges.set("slow", exchange("slow"));
    const view = feed(await listInteractions());
    holding = true;
    requests.length = 0;
    view.set({ open: new Set(["slow"]) });
    assert.deepEqual(requests, ["/interactions/slow"]);

    // answered while the sent detail is still arriving; the small list refresh gets in first
    exchanges.set("slow", exchange("slow", { status: "answered", statusChangedAt: "2026-09-28 10:07:00", result: "{\"ok\":1}" }));
    view.set({ page: await listInteractions() });
    assert.deepEqual(requests, ["/interactions/slow", "/interactions?limit=100"], "one read per row at a time");
    holding = false;
    held.splice(0).forEach((release) => release());
    await settle();

    const row = view.state.page.interactions[0]!;
    assert.equal(row.status, "answered");
    assert.equal(cachedDetail(row)?.result, "{\"ok\":1}", "the open row shows Loading until something else refreshes the list");
    assert.deepEqual(requests, ["/interactions/slow", "/interactions?limit=100", "/interactions/slow"]);
    await settle();
    assert.equal(requests.length, 3, "and then it rests");
});

test("a read that fails closes its row and says why, so nothing retries until the owner opens it again", async () => {
    exchanges.clear();
    exchanges.set("bad", exchange("bad"));
    const view = feed(await listInteractions());
    exchanges.set("bad", { ...exchange("bad"), id: "other" });
    requests.length = 0;
    view.set({ open: new Set(["bad"]) });
    await settle();
    assert.deepEqual([...view.state.open], []);
    assert.match(view.state.error, /different exchange/);
    assert.deepEqual(requests, ["/interactions/bad"]);
});
