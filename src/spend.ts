// How every view reads spend: spent is input + output, cost is those tokens at today's prices, and a day is the owner's day on the gateway.
import type { DayInfo, UsageCell, UsageDaily, UsageStats, UsageTotals } from "./api.ts";

/** The pseudo-agent the Models tab's checks (pings) are recorded under: the gateway's own calls, no agent's spend. */
export const PING_AGENT = "(gateway)";

export const NO_USAGE: UsageTotals = Object.freeze({ calls: 0, estimatedCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });

const DAY_MS = 86_400_000;
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 2 });

/** Dollars as every view shows them; "" for 0, so an unpriced model never shows a fake $0.00. */
export function usd(n: number): string {
    if (!(n > 0)) return "";
    return n >= 0.01 ? DOLLARS.format(n) : n >= 0.0001 ? CENTS.format(n) : "<$0.0001";
}

/** When the owner's day and every model's daily limit start over: "midnight America/New_York", with this device's clock beside it when its own midnight falls elsewhere. */
export function resetTime(day: DayInfo): string {
    const here = CLOCK.format(new Date(day.resetsAt));
    return here === "00:00" ? `midnight ${day.timeZone}` : `midnight ${day.timeZone} (${here} here)`;
}

function sum(rows: readonly UsageTotals[]): UsageTotals {
    return rows.reduce((total, row) => ({
        calls: total.calls + row.calls,
        estimatedCalls: total.estimatedCalls + row.estimatedCalls,
        promptTokens: total.promptTokens + row.promptTokens,
        completionTokens: total.completionTokens + row.completionTokens,
        totalTokens: total.totalTokens + row.totalTokens,
        cost: total.cost + row.cost,
    }), NO_USAGE);
}

export interface UsageBar {
    day: string;
    totalTokens: number;
    cost: number;
    calls: number;
    estimatedCalls: number;
}

export interface UsageView {
    rows: UsageCell[];
    totals: UsageTotals;
    /** Agents with recorded calls; the model checks are not an agent. */
    agents: number;
    models: number;
    /** By agent or by model, heaviest spend first. */
    leaders: [string, UsageTotals][];
    /** One bar per owner's day, from the daily window's first day through its today; null until that window loads. */
    bars: UsageBar[] | null;
}

/** The Usage page's one reading of the stats, so its tiles, ranking, table and chart all count spent the same way. */
export function usageView(stats: UsageStats, daily: UsageDaily | null, agent: string | null, model: string | null, group: "agent" | "model"): UsageView {
    const rows = stats.rows.filter((row) => (agent === null || row.agent === agent) && (model === null || row.model === model));
    // the gateway's own totals stand whenever it scoped the rows itself
    const totals = model === null && stats.agent === agent ? stats.totals : sum(rows);
    const ranked = new Map<string, UsageTotals>();
    for (const row of rows) ranked.set(row[group], sum([ranked.get(row[group]) ?? NO_USAGE, row]));
    let bars: UsageBar[] | null = null;
    if (daily) {
        bars = [];
        // calendar steps over day strings: the browser's clock and zone never pick the days
        for (let day = daily.sinceDay; day <= daily.day.today; day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10))
            bars.push({ day, totalTokens: 0, cost: 0, calls: 0, estimatedCalls: 0 });
        const byDay = new Map(bars.map((bar) => [bar.day, bar]));
        for (const row of daily.rows) {
            const bar = byDay.get(row.day);
            if (!bar || (model !== null && row.model !== model)) continue;
            bar.totalTokens += row.totalTokens;
            bar.cost += row.cost;
            bar.calls += row.calls;
            bar.estimatedCalls += row.estimatedCalls;
        }
    }
    return {
        rows,
        totals,
        agents: new Set(rows.map((row) => row.agent).filter((name) => name !== PING_AGENT)).size,
        models: new Set(rows.map((row) => row.model).filter(Boolean)).size,
        leaders: [...ranked].sort((a, b) => b[1].totalTokens - a[1].totalTokens || b[1].calls - a[1].calls || a[0].localeCompare(b[0])),
        bars,
    };
}
