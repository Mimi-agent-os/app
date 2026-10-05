import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { getPerformance, type PerformanceStats } from "../performance-api.ts";
import { Btn, Empty } from "../components/ui.tsx";
import { errorMessage, number, plural } from "../shared.ts";
import "../performance.css";

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const rate = (value: number | null, samples: number): string => samples > 0 && value !== null && Number.isFinite(value) && value >= 0 ? value > 0 && value < 0.1 ? "<0.1" : decimal.format(value) : "–";
const duration = (value: number | null, samples: number): string => samples > 0 && value !== null && Number.isFinite(value) && value >= 0 ? value < 1000 ? `${number.format(Math.round(value))} ms` : `${decimal.format(value / 1000)} s` : "–";

/** `live` refetches in place (a recorded call, the owner's midnight); `revision` and a retry show as loading. */
export default function PerformancePanel({ days, agent, model, revision, live }: { days: number; agent: string | null; model: string | null; revision: number; live: number }): ReactElement {
    const [snapshot, setSnapshot] = useState<{ key: string; stats: PerformanceStats } | null>(null);
    const shown = useRef("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    const [group, setGroup] = useState<"model" | "provider">("model");
    const [showAll, setShowAll] = useState(false);
    const key = JSON.stringify([days, agent, model]);
    const current = snapshot?.key === key ? snapshot : null;
    const stats = current?.stats;

    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        const load = JSON.stringify([key, revision, retry]);
        if (shown.current !== load) {
            setLoading(true);
            setError("");
            setShowAll(false);
        }
        shown.current = load;
        void getPerformance(days, agent, model, controller.signal).then((value) => {
            if (active) { setSnapshot({ key, stats: value }); setError(""); }
        }).catch((reason: unknown) => {
            if (active) setError(errorMessage(reason, "Could not load performance statistics."));
        }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; controller.abort(); };
    }, [days, agent, model, key, revision, retry, live]);

    const rows = (group === "model"
        ? (stats?.modelRows ?? []).map((row) => ({ metrics: row, name: row.registryModel || row.model || "Unknown model", detail: `${row.model || "Model ID not recorded"} · ${row.provider || "Provider not recorded"}`, identity: row.modelUid }))
        : (stats?.providerRows ?? []).map((row) => ({ metrics: row, name: row.provider || "Provider not recorded", detail: "", identity: null }))
    ).sort((a, b) => b.metrics.calls - a.metrics.calls || a.name.localeCompare(b.name)).map((row, _, list) => {
        const peers = list.filter((other) => other.name === row.name && other.detail === row.detail);
        let length = 8;
        while (row.identity && length < row.identity.length && peers.some((other) => other !== row && other.identity?.slice(0, length) === row.identity?.slice(0, length))) length++;
        return { ...row, record: peers.length > 1 ? row.identity ? `Record ${row.identity.slice(0, length)}` : "Registry identity not recorded" : "" };
    });

    return <section className="usage-section performance-panel" aria-label="Generation performance" aria-busy={loading}>
        <div className="usage-section-heading"><div><h3>Generation performance</h3><p>Speed and response time for the selected period and filters.</p></div></div>
        {error && <div className="usage-error" role="alert"><span>{error}{stats ? " Showing the last loaded measurements for these filters." : ""}</span><Btn sm onClick={() => setRetry((value) => value + 1)} disabled={loading}>Retry performance</Btn></div>}
        {loading && <p className="usage-note" role="status">{stats ? "Updating performance…" : "Loading performance…"}</p>}
        {stats && <>
            {!stats.coverage.complete && <p className="performance-coverage">Partial history{stats.coverage.since ? ` · Measurements available from ${stats.coverage.since.slice(0, 10)}` : ""}. Older calls may be missing from these comparisons.</p>}
            {stats.totals.calls === 0 ? <Empty title="No performance measurements" icon="dash">No measured calls match this period and these filters.</Empty> : <>
                <div className="performance-summary">
                    <div><span>Output speed</span><output aria-label="Output speed">{rate(stats.totals.throughput.tokensPerSec, stats.totals.throughput.samples)}<small> tok/s</small></output><small>Including wait time</small></div>
                    <div><span>First output</span><output aria-label="First output">{duration(stats.totals.firstOutputMs.p50, stats.totals.firstOutputMs.samples)}</output><small>{stats.totals.firstOutputMs.samples ? "Median wait" : "Not recorded"}</small></div>
                    <div><span>Call duration</span><output aria-label="Call duration">{duration(stats.totals.latencyMs.p50, stats.totals.latencyMs.samples)}</output><small>{stats.totals.latencyMs.samples ? "Median duration" : "Not recorded"}</small></div>
                </div>
                <div className="performance-comparison-heading"><div className="seg" aria-label="Performance grouping"><button type="button" aria-pressed={group === "model"} className={group === "model" ? "on" : ""} onClick={() => { setGroup("model"); setShowAll(false); }}>By model</button><button type="button" aria-pressed={group === "provider"} className={group === "provider" ? "on" : ""} onClick={() => { setGroup("provider"); setShowAll(false); }}>By provider</button></div><span className="usage-note">{number.format(stats.totals.calls)} recorded {plural(stats.totals.calls, "call", "calls")} · Most calls first</span></div>
                <div className="performance-comparison" role="list" aria-label={`Performance by ${group}`}>
                    {(showAll ? rows : rows.slice(0, 5)).map((row, index) => <div className="performance-row" role="listitem" key={JSON.stringify([row.name, row.detail, index])}>
                        <div className="performance-identity"><strong>{row.name}</strong>{row.detail && <span>{row.detail}</span>}{row.record && <small title={row.identity ?? undefined}>{row.record}</small>}<small>{number.format(row.metrics.calls)} {plural(row.metrics.calls, "call", "calls")}</small></div>
                        <dl><div><dt>Output speed</dt><dd>{rate(row.metrics.throughput.tokensPerSec, row.metrics.throughput.samples)}<small> tok/s</small></dd></div><div><dt>First output</dt><dd>{duration(row.metrics.firstOutputMs.p50, row.metrics.firstOutputMs.samples)}</dd></div><div><dt>Duration</dt><dd>{duration(row.metrics.latencyMs.p50, row.metrics.latencyMs.samples)}</dd></div></dl>
                    </div>)}
                </div>
                {rows.length > 5 && <Btn sm kind="quiet" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show top 5" : `Show all ${rows.length} ${group === "model" ? "models" : "providers"}`}</Btn>}
                <details className="usage-details performance-details"><summary>Measurement details</summary>
                    <p className="usage-note">Full-call speed uses {number.format(stats.totals.throughput.samples)} of {number.format(stats.totals.calls)} calls with recorded completion tokens and a valid duration. Duration and first output are medians above. A dash means no measurement.</p>
                    <div className="usage-table-wrap" role="region" aria-label="Performance measurement details" tabIndex={0}><table><thead><tr><th>{group === "model" ? "Model / provider" : "Provider"}</th><th>Speed samples</th><th>Time samples</th><th>Mean duration</th><th>Median duration</th><th>95th percentile</th><th>First-output samples</th><th>First-output p95</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><th scope="row">{row.name}{row.detail && <small>{row.detail}</small>}{row.record && <small title={row.identity ?? undefined}>{row.record}</small>}</th><td>{number.format(row.metrics.throughput.samples)}</td><td>{number.format(row.metrics.latencyMs.samples)}</td><td>{duration(row.metrics.latencyMs.mean, row.metrics.latencyMs.samples)}</td><td>{duration(row.metrics.latencyMs.p50, row.metrics.latencyMs.samples)}</td><td>{duration(row.metrics.latencyMs.p95, row.metrics.latencyMs.samples)}</td><td>{number.format(row.metrics.firstOutputMs.samples)}</td><td>{duration(row.metrics.firstOutputMs.p95, row.metrics.firstOutputMs.samples)}</td></tr>)}</tbody></table></div>
                </details>
            </>}
            <details className="usage-details usage-accounting"><summary>What speed measures</summary><p>Output speed is recorded completion tokens divided by the full duration of the same measured calls. It includes gateway queueing, network time, prompt processing and generation. It is not a measurement of the model's decode speed alone.</p><p>First output measures the wait from call start to the first text, thinking or tool output, when recorded. It can arrive before the visible answer. The median is the middle recorded value; 95th percentile means 95% of measured calls were at or below that time.</p><p>Conversation calls, internal processing and retry attempts are counted separately. Each metric uses only calls with its required measurements. Provider names identify the recorded gateway adapter; an unrecorded provider stays unknown. Different models and providers may have different prompt lengths and workloads.</p></details>
        </>}
    </section>;
}
