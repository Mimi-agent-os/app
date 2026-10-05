// What every view reads as spend. spend.ts runs for real; the Models page's off-registry sum is lifted out of models.tsx,
// which is JSX no plain Node runner imports. Spent is every token a provider processed, and cost is the gateway's figure
// at each model's current price, summed the same way and shown only where a model is priced.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { DayInfo, UsageCell, UsageDaily, UsageDay, UsageStats, UsageTotals } from "../src/api.ts";

const { NO_USAGE, PING_AGENT, resetTime, usageView, usd } = await import("../src/spend.ts");

const DAY: DayInfo = { today: "2026-09-29", timeZone: "Europe/Helsinki", resetsAt: "2026-09-29T21:00:00.000Z" };

const totals = (over: Partial<UsageTotals>): UsageTotals => {
    const t = { ...NO_USAGE, ...over };
    return { ...t, totalTokens: t.promptTokens + t.completionTokens };
};
const cell = (agent: string, model: string, over: Partial<UsageTotals>): UsageCell => ({ agent, model, registryModel: null, ...totals(over) });
const stats = (rows: UsageCell[], agent: string | null = null, days = 1): UsageStats => ({
    sinceDay: days === 1 ? DAY.today : "2026-09-23",
    days,
    agent,
    day: DAY,
    rows,
    totals: rows.reduce((t, r) => ({
        calls: t.calls + r.calls, estimatedCalls: t.estimatedCalls + r.estimatedCalls, promptTokens: t.promptTokens + r.promptTokens,
        completionTokens: t.completionTokens + r.completionTokens, totalTokens: t.totalTokens + r.totalTokens, cost: t.cost + r.cost,
    }), NO_USAGE),
});
const daily = (rows: UsageDay[], sinceDay = "2026-09-23", day: DayInfo = DAY): UsageDaily => ({ agent: null, sinceDay, day, rows });
const dayRow = (day: string, model: string, over: Partial<UsageTotals>): UsageDay => ({ day, model, registryModel: null, ...totals(over) });

// four turns of one chat: 24,000 prompt tokens with the context re-sent each time, 1,500 out, $0.09 at its current price
const testDay = cell("wren", "qwen3", { calls: 4, promptTokens: 24_000, completionTokens: 1_500, cost: 0.09 });

test("the headline is spent, input + output, with its cost, and both are the same numbers as today's bar", () => {
    const view = usageView(stats([testDay]), daily([dayRow(DAY.today, "qwen3", testDay)]), null, null, "agent");
    assert.equal(view.totals.totalTokens, 25_500, "every re-sent prompt token counts");
    assert.equal(view.totals.cost, 0.09);
    assert.equal(view.bars?.at(-1)?.day, DAY.today);
    assert.equal(view.bars?.at(-1)?.totalTokens, view.totals.totalTokens, "the chart and its tiles read one measure");
    assert.equal(view.bars?.at(-1)?.cost, view.totals.cost);
});

test("cost reads as dollars only where there is one: an unpriced model shows nothing, a tiny one keeps its digits", () => {
    assert.equal(usd(0), "", "no fake $0.00");
    assert.equal(usd(12.5), "$12.50");
    assert.equal(usd(1234.567), "$1,234.57");
    assert.equal(usd(0.0042), "$0.0042", "one cheap call is not rounded to nothing");
    assert.equal(usd(0.00001), "<$0.0001");
});

test("the ranking orders by spent: a long re-sent context outweighs a short chat", () => {
    const view = usageView(stats([
        cell("scout", "qwen3", { calls: 2, promptTokens: 3_000, completionTokens: 500 }),
        testDay,
    ]), null, null, null, "agent");
    assert.deepEqual(view.leaders.map(([name, t]) => [name, t.totalTokens]), [["wren", 25_500], ["scout", 3_500]]);
});

test("a filter the gateway did not apply is summed from the rows, estimated calls included; its own scope keeps its totals", () => {
    const rows = [
        cell("wren", "qwen3", { calls: 3, estimatedCalls: 1, promptTokens: 9_000, completionTokens: 300, cost: 0.25 }),
        cell("wren", "llama", { calls: 1, promptTokens: 1_000, completionTokens: 100 }),
        cell("scout", "qwen3", { calls: 5, promptTokens: 50_000, completionTokens: 2_000, cost: 1.5 }),
    ];
    const everyone = usageView(stats(rows), null, "wren", null, "model");
    assert.deepEqual(everyone.totals, { calls: 4, estimatedCalls: 1, promptTokens: 10_000, completionTokens: 400, totalTokens: 10_400, cost: 0.25 });
    assert.deepEqual(everyone.leaders.map(([name, t]) => [name, t.cost]), [["qwen3", 0.25], ["llama", 0]], "a free model ranks with no cost");
    assert.deepEqual(everyone.leaders.map(([name]) => name), ["qwen3", "llama"]);

    const scoped = stats(rows.slice(0, 2), "wren");
    scoped.totals = { ...scoped.totals, calls: 99 };
    assert.equal(usageView(scoped, null, "wren", null, "agent").totals.calls, 99, "the gateway's scoped totals stand");
    assert.equal(usageView(scoped, null, "wren", "llama", "agent").totals.totalTokens, 1_100, "a model filter on top sums its rows");
});

test("model checks are counted in spent but are not an agent", () => {
    const view = usageView(stats([testDay, cell(PING_AGENT, "qwen3", { calls: 3, promptTokens: 30, completionTokens: 3 })]), null, null, null, "agent");
    assert.equal(view.totals.totalTokens, 25_533);
    assert.equal(view.agents, 1);
    assert.equal(view.models, 1);
});

test("the bars run over the owner's days, from the window's first day through the gateway's today, in any browser zone", () => {
    const march = { ...DAY, today: "2026-03-01", resetsAt: "2026-03-01T22:00:00.000Z" };
    const view = usageView(stats([]), daily([dayRow("2026-02-27", "qwen3", { calls: 1, promptTokens: 700, completionTokens: 70 }), dayRow("2026-03-01", "llama", { calls: 2, promptTokens: 40 })], "2026-02-26", march), null, null, "agent");
    assert.deepEqual(view.bars?.map((bar) => [bar.day, bar.totalTokens]), [["2026-02-26", 0], ["2026-02-27", 770], ["2026-02-28", 0], ["2026-03-01", 40]]);
    const filtered = usageView(stats([]), daily([dayRow("2026-03-01", "qwen3", { calls: 1, promptTokens: 5 }), dayRow("2026-03-01", "llama", { calls: 2, promptTokens: 40 })], "2026-03-01", march), null, "qwen3", "agent");
    assert.deepEqual(filtered.bars, [{ day: "2026-03-01", totalTokens: 5, cost: 0, calls: 1, estimatedCalls: 0 }]);
    assert.equal(usageView(stats([]), null, null, null, "agent").bars, null, "no bars until the daily window loads");
});

test("a day's bar counts its estimated calls, so the chart marks them as the tiles do", () => {
    const rows = [dayRow(DAY.today, "qwen3", { calls: 3, estimatedCalls: 1, promptTokens: 900, completionTokens: 90 }), dayRow(DAY.today, "llama", { calls: 1, estimatedCalls: 1, promptTokens: 10 })];
    const view = usageView(stats([cell("wren", "qwen3", { calls: 3, estimatedCalls: 1, promptTokens: 900, completionTokens: 90 }), cell("wren", "llama", { calls: 1, estimatedCalls: 1, promptTokens: 10 })]), daily(rows, DAY.today), null, null, "agent");
    assert.equal(view.bars?.at(-1)?.estimatedCalls, view.totals.estimatedCalls);
    assert.equal(usageView(stats([]), daily(rows, DAY.today), null, "qwen3", "agent").bars?.at(-1)?.estimatedCalls, 1, "a model filter keeps only that model's estimates");
});

test("the reset reads as the gateway's midnight, with this device's clock only when its own midnight differs", () => {
    const localMidnight = new Date(2026, 8, 30, 0, 0).toISOString();
    assert.equal(resetTime({ ...DAY, resetsAt: localMidnight }), "midnight Europe/Helsinki");
    const elevenHere = new Date(2026, 8, 29, 23, 0).toISOString();
    assert.equal(resetTime({ ...DAY, resetsAt: elevenHere }), "midnight Europe/Helsinki (23:00 here)");
});

// ── the Models page ───────────────────────────────────────────────────────────

const models = await readFile(new URL("../src/views/models.tsx", import.meta.url), "utf8");
const elsewhereExpr = /const elsewhere = (.+);\n/.exec(models);
assert.ok(elsewhereExpr, "models.tsx sums the spend no card holds in one expression");
const elsewhere = new Function("usage", "list", `return ${elsewhereExpr[1] as string};`) as
    (usage: { registryRows?: { modelUid: string | null; totalTokens: number }[] } | null, list: { modelUid?: string | null }[]) => number;

test("spend on a removed model, or on none from the registry, stays on the Models page", () => {
    const usage = { registryRows: [{ modelUid: "uid-live", totalTokens: 900 }, { modelUid: "uid-removed", totalTokens: 300 }, { modelUid: null, totalTokens: 20 }] };
    assert.equal(elsewhere(usage, [{ modelUid: "uid-live" }, { modelUid: null }]), 320);
    assert.equal(elsewhere(null, [{ modelUid: "uid-live" }]), 0);
});

const refreshBody = /const refreshSpend = useCallback\(\(\): Promise<void> => (.+), \[\]\);/.exec(models)?.[1];
assert.ok(refreshBody, "models.tsx re-reads today's spend in one callback");

test("a model check re-reads today's spend, and a failed read keeps the cards' last figures", async () => {
    const asked: unknown[][] = [];
    const shown: unknown[] = [];
    const refresh = (answer: Promise<unknown>): Promise<void> =>
        new Function("getUsage", "setUsage", `return ${refreshBody};`)((...args: unknown[]) => { asked.push(args); return answer; }, (value: unknown) => shown.push(value)) as Promise<void>;
    await refresh(Promise.resolve("today"));
    await refresh(Promise.reject(new Error("gateway away")));
    assert.deepEqual(asked, [[1, "registry"], [1, "registry"]]);
    assert.deepEqual(shown, ["today"], "the failed read writes nothing");
    assert.match(models, /onPing=\{\(\) => void ping\(m\.name\)\.then\(refreshSpend\)\}/, "one check refreshes the cards");
    assert.match(models, /await Promise\.allSettled\(names\.map\(\(n\) => ping\(n\)\)\);\n\s*void refreshSpend\(\);/, "Check all refreshes them once");
});

// ── the wording ───────────────────────────────────────────────────────────────

test("no view calls the day UTC, keeps unique input or an agent budget, or says the re-sent prompt is not billed", async () => {
    for (const view of ["usage", "gateway", "models", "agent-models", "agent-page", "chat", "limits"]) {
        const source = await readFile(new URL(`../src/views/${view}.tsx`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /· UTC|UTC day|\$\{[^}]*\} UTC/, `${view}.tsx labels a day as UTC`);
        assert.doesNotMatch(source, /not billed|Tokens used|[Uu]nique input|freshInput|budget|spentToday/, `${view}.tsx keeps a removed measure`);
    }
});

test("the dashboard's total is the gateway's own sum of every agent, a revoked one's too, its cost beside it only when a model is priced", async () => {
    const source = await readFile(new URL("../src/views/gateway.tsx", import.meta.url), "utf8");
    assert.match(source, /const \{ tokens: spent, cost \} = snap\.today;/);
    assert.match(source, /usage: snap && <span className="settings-value">\{kilo\(snap\.today\.tokens\)\} today<\/span>/, "the Settings row reads the same total");
    assert.doesNotMatch(source, /snap\.agents\.reduce\(\(n, a\) => n \+ a\.(tokens|cost)Today/, "the roster is only who is pinned now");
    assert.match(source, /\{cost > 0 && <Metric value=\{usd\(cost\)\} label="cost today" \/>\}/);
    assert.match(source, /Input \+ output across every agent\{cost > 0 \? ", at current prices" : ""\}; Usage also counts model checks\. The day resets at \{resetTime\(snap\.day\)\}/);
});

test("every view that shows spend or cost refetches it in place on a recorded call, a new price and a reconnect", async () => {
    const read = (view: string): Promise<string> => readFile(new URL(`../src/views/${view}.tsx`, import.meta.url), "utf8");
    const listens = /window\.addEventListener\("mimi:usage-changed", refresh\);\n\s*window\.addEventListener\("mimi:resync", refresh\);/;
    const usage = await read("usage");
    assert.match(usage, listens);
    assert.match(usage, /const refresh = \(\): void => setLive\(\(value\) => value \+ 1\);/);
    assert.match(usage, /\}, \[days, barDays, revision, live\]\);/);
    assert.match(usage, /\}, \[agent, days, barDays, revision, live\]\);/);
    assert.match(usage, /<PerformancePanel days=\{days\} agent=\{agent\} model=\{model\} revision=\{revision\} live=\{live\} \/>/);
    // only a new window or the Refresh button shows as loading: a live refetch never blanks the chart or drops the picked day
    assert.match(usage, /if \(shownTotals\.current !== load\) \{\n\s*setLoading\(true\);\n\s*setDailyLoading\(true\);[\s\S]*?setSelectedDay\(null\);\n\s*\}/);
    assert.match(usage, /if \(shownScope\.current !== load\) \{\n\s*setSelectedDay\(null\);/);
    const performance = await read("performance");
    assert.match(performance, /\}, \[days, agent, model, key, revision, retry, live\]\);/);
    assert.match(performance, /if \(shown\.current !== load\) \{\n\s*setLoading\(true\);/);
    const models = await read("models");
    assert.match(models, /const refresh = \(\): void => void refreshSpend\(\);/);
    assert.match(models, listens);
});

test("every today figure starts over at the owner's midnight, when nothing is recorded to say so", async () => {
    const midnight = (call: string): RegExp =>
        new RegExp(`setTimeout\\(${call}, Math\\.max\\(0, Date\\.parse\\(resetsAt\\) - Date\\.now\\(\\)\\) \\+ 1000\\)`);
    const read = (path: string): Promise<string> => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
    assert.match(await read("App.tsx"), midnight("\\(\\) => void reload\\(\\)"), "Health and the Settings row");
    assert.match(await read("views/usage.tsx"), midnight("\\(\\) => setLive\\(\\(value\\) => value \\+ 1\\)"));
    assert.match(await read("views/limits.tsx"), midnight("\\(\\) => setRevision\\(\\(value\\) => value \\+ 1\\)"));
    assert.match(await read("views/models.tsx"), midnight("refresh"), "the Models cards' spent today");
    for (const [path, source] of [["App.tsx", "snap?.day.resetsAt"], ["views/usage.tsx", "stats?.day.resetsAt"], ["views/limits.tsx", "day?.resetsAt"], ["views/models.tsx", "usage?.day.resetsAt"]]) {
        assert.ok((await read(path!)).includes(`const resetsAt = ${source!};`), `${path} re-arms on each new day's reset`);
    }
});
