import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import { getUsage, getUsageDaily, type UsageDaily, type UsageStats } from "../api.ts";
import { Btn, Empty } from "../components/ui.tsx";
import { errorMessage, kilo, number, plural } from "../shared.ts";
import { PING_AGENT, resetTime, usageView, usd } from "../spend.ts";
import PerformancePanel from "./performance.tsx";
import "../usage.css";

const PERIODS = [{ days: 1, label: "Today" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }, { days: 0, label: "All time" }];
// a day string is a calendar date: formatted in UTC, so no zone shifts it
const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const dayLabel = (day: string): string => DATE.format(new Date(`${day}T00:00:00Z`));
const modelName = (model: string): string => model || "Unknown model";
const agentName = (agent: string): string => agent === PING_AGENT ? "Model checks" : agent || "Unknown agent";
const percentage = (part: number, total: number): string => total > 0 ? `${(part / total * 100).toFixed(1)}%` : "–";

interface ScopedUsage {
    days: number;
    agent: string;
    stats: UsageStats | null;
    daily: UsageDaily | null;
    loading: boolean;
    dailyLoading: boolean;
    error: string;
    dailyError: string;
}

export default function UsagePanel(): ReactElement {
    const [days, setDays] = useState(7);
    const [revision, setRevision] = useState(0);
    const [snapshot, setSnapshot] = useState<{ days: number; stats: UsageStats } | null>(null);
    const [daily, setDaily] = useState<{ days: number; value: UsageDaily } | null>(null);
    const [scoped, setScoped] = useState<ScopedUsage | null>(null);
    const [loading, setLoading] = useState(true);
    const [dailyLoading, setDailyLoading] = useState(true);
    const [error, setError] = useState("");
    const [dailyError, setDailyError] = useState("");
    const [agent, setAgent] = useState<string | null>(null);
    const [model, setModel] = useState<string | null>(null);
    const [group, setGroup] = useState<"agent" | "model">("agent");
    const [showAll, setShowAll] = useState(false);
    const [chartMetric, setChartMetric] = useState<"totalTokens" | "calls">("totalTokens");
    const [selectedDay, setSelectedDay] = useState<string | null>(null);
    const barDays = days || 30;
    const globalStats = snapshot?.days === days ? snapshot.stats : null;
    const scope = agent !== null && scoped?.agent === agent && scoped.days === days ? scoped : null;
    const stats = scope?.stats ?? globalStats;
    const series = agent === null ? daily?.days === barDays ? daily.value : null : scope?.daily ?? null;
    const trendLoading = agent === null ? dailyLoading : !scope || scope.dailyLoading;
    const trendError = agent === null ? dailyError : scope?.dailyError ?? "";
    const totalsError = scope?.error || error;

    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setLoading(true);
        setDailyLoading(true);
        setError("");
        setDailyError("");
        setSelectedDay(null);
        void getUsage(days, "registry", controller.signal).then((value) => {
            if (value.agent !== null) throw new Error("The gateway returned usage for a different agent.");
            if (active) setSnapshot({ days, stats: value });
        }).catch((reason: unknown) => {
            if (active) setError(errorMessage(reason, "Could not load usage totals."));
        }).finally(() => { if (active) setLoading(false); });
        void getUsageDaily(barDays, controller.signal).then((value) => {
            if (value.agent !== null) throw new Error("The gateway returned a daily trend for a different agent.");
            if (active) setDaily({ days: barDays, value });
        }).catch((reason: unknown) => {
            if (active) setDailyError(errorMessage(reason, "Could not load the daily trend."));
        }).finally(() => { if (active) setDailyLoading(false); });
        return () => { active = false; controller.abort(); };
    }, [days, barDays, revision]);

    useEffect(() => {
        if (agent === null) return;
        let active = true;
        const controller = new AbortController();
        setSelectedDay(null);
        setScoped((old) => ({ days, agent, stats: old?.days === days && old.agent === agent ? old.stats : null, daily: old?.days === days && old.agent === agent ? old.daily : null, loading: true, dailyLoading: true, error: "", dailyError: "" }));
        void getUsage(days, "registry", controller.signal, agent).then((value) => {
            if (value.agent !== agent) throw new Error("The gateway returned usage for a different agent.");
            if (active) setScoped((old) => old ? { ...old, stats: value } : old);
        }).catch((reason: unknown) => {
            if (active) setScoped((old) => old ? { ...old, error: errorMessage(reason, "Could not refresh usage for this agent.") } : old);
        }).finally(() => { if (active) setScoped((old) => old ? { ...old, loading: false } : old); });
        void getUsageDaily(barDays, controller.signal, agent).then((value) => {
            if (value.agent !== agent) throw new Error("The gateway returned a daily trend for a different agent.");
            if (active) setScoped((old) => old ? { ...old, daily: value } : old);
        }).catch((reason: unknown) => {
            if (active) setScoped((old) => old ? { ...old, dailyError: errorMessage(reason, "Could not load this agent's daily trend.") } : old);
        }).finally(() => { if (active) setScoped((old) => old ? { ...old, dailyLoading: false } : old); });
        return () => { active = false; controller.abort(); };
    }, [agent, days, barDays, revision]);

    const agents = [...new Set((globalStats ?? snapshot?.stats)?.rows.map((row) => row.agent) ?? [])].sort();
    const models = [...new Set((globalStats ?? snapshot?.stats)?.rows.map((row) => row.model) ?? [])].sort();
    const view = stats ? usageView(stats, series, agent, model, group) : null;
    const rows = view?.rows ?? [];
    const totals = view?.totals ?? null;
    const spent = totals?.totalTokens ?? 0;
    const priced = (totals?.cost ?? 0) > 0;
    const registryPriced = stats?.registryRows?.some((row) => row.cost > 0) ?? false;
    const filtered = agent !== null || model !== null;
    const leaders = view?.leaders ?? [];
    const bars = view?.bars ?? null;
    const peak = Math.max(0, ...(bars ?? []).map((bar) => bar[chartMetric]));
    const trendTotal = (bars ?? []).reduce((total, bar) => total + bar[chartMetric], 0);
    const peakDay = peak > 0 ? bars?.find((bar) => bar[chartMetric] === peak) : undefined;
    const focusedDay = bars?.find((bar) => bar.day === selectedDay) ?? bars?.at(-1);
    const unit = chartMetric === "calls" ? "calls" : "tokens spent";
    const period = !stats ? "" : stats.days === 0 ? "All recorded history"
        : stats.days === 1 ? `Today, ${dayLabel(stats.day.today)} · resets at ${resetTime(stats.day)}`
        : `${dayLabel(stats.sinceDay)} – ${dayLabel(stats.day.today)}, ${stats.day.timeZone}`;
    const retry = (): void => setRevision((value) => value + 1);

    return <section className="usage-panel" aria-label="Model usage">
        <header className="usage-header">
            <div><h2>Usage</h2><p>Every model call: chats, the agents' own calls, titles, compaction and model checks.</p></div>
            <Btn sm icon="refresh" disabled={loading || dailyLoading || Boolean(scope?.loading) || Boolean(scope?.dailyLoading)} onClick={retry}>Refresh</Btn>
        </header>
        <div className="seg usage-periods" aria-label="Usage period">{PERIODS.map((period) => <button key={period.days} type="button" aria-pressed={period.days === days} className={period.days === days ? "on" : ""} onClick={() => setDays(period.days)}>{period.label}</button>)}</div>
        {totalsError && <div className="usage-error" role="alert"><span>{totalsError}{stats ? " Showing the last loaded totals." : ""}</span><Btn sm onClick={retry}>Retry totals</Btn></div>}
        {(loading || scope?.loading) && <p className="usage-note" role="status">{stats ? "Updating usage…" : "Loading usage…"}</p>}
        {stats && view && totals && <>
            <div className="usage-filter-row">
                <label>Agent<select aria-label="Usage agent" value={agent === null ? "" : JSON.stringify(agent)} onChange={(event) => setAgent(event.target.value === "" ? null : JSON.parse(event.target.value) as string)}>
                    <option value="">All agents</option>{agents.map((value) => <option key={value} value={JSON.stringify(value)}>{agentName(value)}</option>)}
                    {agent !== null && !agents.includes(agent) && <option value={JSON.stringify(agent)}>{agentName(agent)} · no calls this period</option>}
                </select></label>
                <label>Model<select aria-label="Usage model" value={model === null ? "" : JSON.stringify(model)} onChange={(event) => setModel(event.target.value === "" ? null : JSON.parse(event.target.value) as string)}>
                    <option value="">All models</option>{models.map((value) => <option key={value} value={JSON.stringify(value)}>{modelName(value)}</option>)}
                    {model !== null && !models.includes(model) && <option value={JSON.stringify(model)}>{modelName(model)} · no calls this period</option>}
                </select></label>
                {filtered && <Btn sm kind="quiet" onClick={() => { setAgent(null); setModel(null); }}>Clear filters</Btn>}
            </div>
            <p className="usage-note">{period}{filtered ? " · Filtered totals" : ""}</p>
            <div className="usage-summary">
                <div><span>Spent</span><output aria-label="Tokens spent">{number.format(spent)}</output><small>Input + output tokens</small></div>
                {priced && <div><span>Cost</span><output aria-label="Cost">{usd(totals.cost)}</output><small>At current prices</small></div>}
                <div><span>Model calls</span><output aria-label="Model calls">{number.format(totals.calls)}</output><small>{view.agents} {plural(view.agents, "agent", "agents")} · {view.models} named {plural(view.models, "model", "models")}{rows.some((row) => !row.model) ? " + unknown" : ""}</small></div>
            </div>
            <div className="usage-token-split">
                <div className="usage-token-labels"><span>Input <b>{number.format(totals.promptTokens)}</b> <small>{percentage(totals.promptTokens, spent)}</small></span><span>Output <b>{number.format(totals.completionTokens)}</b> <small>{percentage(totals.completionTokens, spent)}</small></span></div>
                <div className="usage-token-track" role="img" aria-label={`${number.format(totals.promptTokens)} input tokens and ${number.format(totals.completionTokens)} output tokens`}><span style={{ width: `${spent ? totals.promptTokens / spent * 100 : 0}%` }} /><span style={{ width: `${spent ? totals.completionTokens / spent * 100 : 0}%` }} /></div>
            </div>
            {totals.estimatedCalls > 0 && <p className="usage-note">Includes {number.format(totals.estimatedCalls)} estimated {plural(totals.estimatedCalls, "call", "calls")}: stopped or failed before the provider reported usage.</p>}
            {rows.length === 0 && <Empty title={filtered ? "No matching usage" : "No usage yet"} icon="dash">{filtered ? "No recorded calls match these filters in this period." : "Model usage appears here after a call is recorded."}</Empty>}
        </>}
        {stats && <section className="usage-section" aria-label="Daily usage trend">
            <div className="usage-section-heading"><div><h3>Daily trend</h3><p>{days === 0 ? "Last 30 days, totals above cover all history" : barDays === 1 ? "Today" : `Last ${barDays} days`}{series ? ` · ${series.day.timeZone}` : ""}{agent !== null ? ` · ${agentName(agent)}` : ""}{model !== null ? ` · ${modelName(model)}` : ""}</p></div>
                <div className="seg"><button type="button" aria-pressed={chartMetric === "totalTokens"} className={chartMetric === "totalTokens" ? "on" : ""} onClick={() => setChartMetric("totalTokens")}>Spent</button><button type="button" aria-pressed={chartMetric === "calls"} className={chartMetric === "calls" ? "on" : ""} onClick={() => setChartMetric("calls")}>Calls</button></div>
            </div>
            {trendError ? <div className="usage-error" role="alert"><span>{trendError}</span><Btn sm onClick={retry}>Retry trend</Btn></div>
                : trendLoading ? <p className="usage-note" role="status">Loading daily trend…</p>
                : bars && focusedDay && <>
                    <div className="usage-chart" role="group" aria-label={`Daily ${chartMetric === "calls" ? "model calls" : "tokens spent"}`}>{bars.map((bar) => <button type="button" key={bar.day} aria-label={`${bar.day}: ${number.format(bar.totalTokens)} tokens spent${bar.cost > 0 ? `, ${usd(bar.cost)}` : ""}, ${number.format(bar.calls)} calls`} aria-pressed={bar.day === focusedDay.day} title={`${bar.day} · ${number.format(bar[chartMetric])} ${unit}${chartMetric === "totalTokens" && bar.cost > 0 ? ` · ${usd(bar.cost)}` : ""}`} onClick={() => setSelectedDay(bar.day)} onFocus={() => setSelectedDay(bar.day)}><span style={{ height: `${peak ? Math.max(2, bar[chartMetric] / peak * 100) : 2}%`, opacity: bar[chartMetric] ? 1 : 0.2 }} /></button>)}</div>
                    <div className="usage-chart-axis"><span>{dayLabel(bars[0]!.day)}</span><span>{dayLabel(bars.at(-1)!.day)}</span></div>
                    <div className="usage-day-readout" aria-live="polite"><b>{dayLabel(focusedDay.day)}</b><span>{number.format(focusedDay.totalTokens)} spent</span>{focusedDay.cost > 0 && <span>{usd(focusedDay.cost)}</span>}<span>{number.format(focusedDay.calls)} calls{focusedDay.estimatedCalls > 0 ? `, ${number.format(focusedDay.estimatedCalls)} estimated` : ""}</span></div>
                    <p className="usage-note">{peakDay ? `Peak: ${dayLabel(peakDay.day)} · ${number.format(peak)} ${unit}. ` : "No recorded activity in this chart window. "}Daily average: {number.format(Math.round(trendTotal / bars.length))} {unit}.</p>
                </>}
        </section>}
        <PerformancePanel days={days} agent={agent} model={model} revision={revision} />
        {stats && totals && rows.length > 0 && <>
            <section className="usage-section" aria-label="Usage breakdown">
                <div className="usage-section-heading"><h3>Where usage went</h3><div className="seg"><button type="button" aria-pressed={group === "agent"} className={group === "agent" ? "on" : ""} onClick={() => { setGroup("agent"); setShowAll(false); }}>By agent</button><button type="button" aria-pressed={group === "model"} className={group === "model" ? "on" : ""} onClick={() => { setGroup("model"); setShowAll(false); }}>By model</button></div></div>
                <div className="usage-ranking">{(showAll ? leaders : leaders.slice(0, 5)).map(([name, total]) => <button key={name} type="button" aria-label={`Filter ${group}: ${group === "agent" ? agentName(name) : modelName(name)}`} onClick={() => group === "agent" ? setAgent(name) : setModel(name)}>
                    <span className="usage-rank-name">{group === "agent" ? agentName(name) : modelName(name)}</span><span className="usage-rank-numbers"><b title={`${number.format(total.totalTokens)} tokens spent`}>{kilo(total.totalTokens)} spent{total.cost > 0 && ` · ${usd(total.cost)}`}</b><small>{number.format(total.calls)} calls · {percentage(total.totalTokens, spent)}</small></span>
                    <span className="usage-rank-track" aria-hidden="true"><span style={{ width: `${spent ? total.totalTokens / spent * 100 : 0}%` }} /></span>
                </button>)}</div>
                {leaders.length > 5 && <Btn sm kind="quiet" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show top 5" : `Show all ${leaders.length} ${group === "agent" ? "agents" : "models"}`}</Btn>}
            </section>
            <details className="usage-details"><summary>Detailed usage · {rows.length} {rows.length === 1 ? "row" : "rows"}</summary><p className="usage-note">Model names here are the provider model IDs recorded with each call.</p>
                <div className="usage-table-wrap" role="region" aria-label="Usage by agent and model" tabIndex={0}><table className="usage-table-agent-model"><thead><tr><th>Agent</th><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Spent</th>{priced && <th>Cost</th>}<th>Share</th></tr></thead><tbody>{rows.map((row) => <tr key={JSON.stringify([row.agent, row.model])}><th scope="row">{agentName(row.agent)}</th><td>{modelName(row.model)}</td><td>{number.format(row.calls)}{row.estimatedCalls > 0 && <small> · {row.estimatedCalls} estimated</small>}</td><td>{number.format(row.promptTokens)}</td><td>{number.format(row.completionTokens)}</td><td>{number.format(row.totalTokens)}</td>{priced && <td>{usd(row.cost)}</td>}<td>{percentage(row.totalTokens, spent)}</td></tr>)}</tbody><tfoot><tr><th scope="row">Total</th><td>{filtered ? "Filtered" : "All"}</td><td>{number.format(totals.calls)}</td><td>{number.format(totals.promptTokens)}</td><td>{number.format(totals.completionTokens)}</td><td>{number.format(spent)}</td>{priced && <td>{usd(totals.cost)}</td>}<td>{spent ? "100%" : "–"}</td></tr></tfoot></table></div>
            </details>
        </>}
        {stats && model === null && stats.agent === agent && stats.registryRows && stats.registryRows.length > 0 && <details className="usage-details"><summary>Configured model attribution</summary><p className="usage-note">{agent === null ? "All agents" : agentName(agent)}, grouped by the registry model that chose each call.</p><div className="usage-table-wrap" role="region" aria-label="Usage by configured model" tabIndex={0}><table><thead><tr><th>Configured model</th><th>Calls</th><th>Input</th><th>Output</th><th>Spent</th>{registryPriced && <th>Cost</th>}</tr></thead><tbody>{stats.registryRows.map((row) => <tr key={row.modelUid ?? "none"}><th scope="row">{row.modelUid === null ? "No registry model" : row.registryModel || "Unnamed model"}</th><td>{number.format(row.calls)}</td><td>{number.format(row.promptTokens)}</td><td>{number.format(row.completionTokens)}</td><td>{number.format(row.totalTokens)}</td>{registryPriced && <td>{usd(row.cost)}</td>}</tr>)}</tbody></table></div></details>}
        {stats && <details className="usage-details usage-accounting"><summary>What these numbers include</summary>
            <p>Spent is every token a provider processed: the whole prompt of each call, with the context it re-sends every time, plus the output, counted as if every model were a paid cloud one. It covers chats, the agents' own calls (routines, bridges, /ask), chat titles, compaction summaries and the model checks from Settings, Models, which belong to no agent.</p>
            <p>Cost is spent at each model's current price from Settings, Limits & prices, so a price change re-prices past usage too. A model without a price shows no cost.</p>
            <p>An estimated call was stopped or failed after the provider had it, without a usage report. Its tokens are estimated from the text at about four characters a token, and they count toward spent, cost and the model's daily limit.</p>
            <p>A day is a calendar day in {stats.day.timeZone}, the gateway's time zone; today resets at {resetTime(stats.day)}. Unknown model means its ID was not recorded.</p>
        </details>}
    </section>;
}
