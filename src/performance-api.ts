import { apiFetch, readJson } from "./channel.ts";

export interface TimingDistribution {
    samples: number;
    mean: number | null;
    p50: number | null;
    p95: number | null;
}

export interface PerformanceMetrics {
    calls: number;
    latencyMs: TimingDistribution;
    firstOutputMs: TimingDistribution;
    throughput: {
        samples: number;
        completionTokens: number;
        durationMs: number;
        tokensPerSec: number | null;
    };
}

export interface PerformanceStats {
    days: number;
    sinceDay: string;
    agent: string | null;
    model: string | null;
    coverage: { since: string | null; complete: boolean };
    totals: PerformanceMetrics;
    modelRows: (PerformanceMetrics & { modelUid: string | null; registryModel: string | null; model: string | null; provider: string | null })[];
    providerRows: (PerformanceMetrics & { provider: string | null })[];
}

export async function getPerformance(days: number, agent: string | null, model: string | null, signal: AbortSignal): Promise<PerformanceStats> {
    const query = new URLSearchParams({ days: String(days) });
    if (agent !== null) query.set("agent", agent);
    if (model !== null) query.set("model", model);
    const call = await apiFetch(`/stats/performance?${query}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (!call.res.ok) throw new Error("Could not load performance statistics. Try again shortly.");
    const value = await readJson<PerformanceStats>(call);
    if (!value || value.days !== days || value.agent !== agent || value.model !== model || !value.coverage || typeof value.coverage.complete !== "boolean" || (value.coverage.since !== null && typeof value.coverage.since !== "string") || !value.totals || !Array.isArray(value.modelRows) || !Array.isArray(value.providerRows))
        throw new Error("The gateway could not confirm these performance filters. Refresh to try again.");
    for (const row of [value.totals, ...value.modelRows, ...value.providerRows]) {
        if (!row || !Number.isSafeInteger(row.calls) || row.calls < 0 || !row.throughput || !row.latencyMs || !row.firstOutputMs)
            throw new Error("The gateway returned incomplete performance statistics. Try again shortly.");
        for (const metric of [row.latencyMs, row.firstOutputMs, row.throughput]) {
            const values = "tokensPerSec" in metric ? [metric.tokensPerSec, metric.completionTokens, metric.durationMs] : [metric.mean, metric.p50, metric.p95];
            if (!Number.isSafeInteger(metric.samples) || metric.samples < 0 || metric.samples > row.calls || values.some((number) => number !== null && (typeof number !== "number" || !Number.isFinite(number) || number < 0)))
                throw new Error("The gateway returned invalid performance measurements. Try again shortly.");
        }
        if (row.throughput.samples > 0 && (typeof row.throughput.completionTokens !== "number" || typeof row.throughput.durationMs !== "number" || row.throughput.durationMs <= 0))
            throw new Error("The gateway returned speed without its recorded tokens and duration. Try again shortly.");
    }
    for (const row of value.modelRows) {
        if ([row.modelUid, row.registryModel, row.model, row.provider].some((identity) => identity !== null && typeof identity !== "string"))
            throw new Error("The gateway did not record the model identity for this comparison.");
    }
    if (value.providerRows.some((row) => row.provider !== null && typeof row.provider !== "string"))
        throw new Error("The gateway did not record the provider identity for this comparison.");
    return value;
}
