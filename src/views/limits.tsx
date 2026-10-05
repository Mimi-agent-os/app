import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import { listLimits, patchLimit, type LimitRow } from "../api.ts";
import { Btn, Empty, Panel, Skeleton } from "../components/ui.tsx";
import { draftOf, limitUse, readDraft, type LimitDraft } from "../limits.ts";
import { errorMessage, Err, plural } from "../shared.ts";
import { resetTime } from "../spend.ts";
import "../limits.css";

/** Settings, Limits & prices: one row per registry model, its prices and daily limit edited apart from its base settings. */
export default function LimitsPanel(): ReactElement {
    const [rows, setRows] = useState<LimitRow[] | null>(null);
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        listLimits(controller.signal).then(
            (list) => { setRows(list); setError(""); },
            (e: unknown) => { if (!controller.signal.aborted) setError(errorMessage(e, "Could not load model limits.")); },
        );
        return () => controller.abort();
    }, [revision]);

    useEffect(() => {
        const refresh = (): void => setRevision((value) => value + 1);
        window.addEventListener("mimi:usage-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
        return () => {
            window.removeEventListener("mimi:usage-changed", refresh);
            window.removeEventListener("mimi:resync", refresh);
        };
    }, []);

    const day = rows?.[0]?.day;
    const reached = rows?.filter((row) => limitUse(row).reached).length ?? 0;
    const resetsAt = day?.resetsAt;

    // nothing is recorded at the owner's midnight, yet every limit starts over then
    useEffect(() => {
        if (!resetsAt) return;
        const timer = setTimeout(() => setRevision((value) => value + 1), Math.max(0, Date.parse(resetsAt) - Date.now()) + 1000);
        return () => clearTimeout(timer);
    }, [resetsAt]);

    return (
        <>
            <div className="limits-bar">
                <span className="dim3">
                    {rows === null ? (error ? "" : "Loading the registry…")
                        : [`${rows.length} ${plural(rows.length, "model", "models")}`, reached > 0 ? `${reached} at ${plural(reached, "its", "their")} daily limit` : "", day ? `limits reset at ${resetTime(day)}` : ""].filter(Boolean).join(" · ")}
                </span>
                <Btn sm icon="refresh" onClick={() => setRevision((value) => value + 1)}>Refresh</Btn>
            </div>
            <p className="limits-note">
                Prices are dollars per 1M tokens and price all usage, past days included. A daily limit counts one model's use by every agent and by model checks.
                At its limit an agent's call goes to that agent's fallback when the fallback has room, and is refused otherwise; model checks still run.
            </p>

            {error && <Err>{error}{rows ? " Showing the last loaded figures." : ""}</Err>}

            {rows === null && !error && (
                <Panel>
                    {[0, 1, 2].map((n) => (
                        <div key={n} className="limit-row" aria-hidden="true"><Skeleton w={140} h={13} /><Skeleton w="70%" h={11} /></div>
                    ))}
                </Panel>
            )}

            {rows !== null && rows.length === 0 && <Empty>The registry has no models yet. Connect one in Settings, Models.</Empty>}

            {rows !== null && rows.length > 0 && (
                <Panel>
                    {rows.map((row) => (
                        <LimitEditor key={row.uid} row={row} onSaved={(next) => setRows((list) => list?.map((r) => (r.uid === next.uid ? next : r)) ?? list)} />
                    ))}
                </Panel>
            )}
        </>
    );
}

function LimitEditor({ row, onSaved }: { row: LimitRow; onSaved: (row: LimitRow) => void }): ReactElement {
    // null follows the gateway's row, so a refresh never overwrites what the owner is typing
    const [draft, setDraft] = useState<LimitDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const shown = draft ?? draftOf(row);
    const { patch, error: invalid, hint } = readDraft(row, shown);
    const changed = patch === null || Object.keys(patch).length > 0;
    const use = limitUse(row);
    const edit = (field: Partial<LimitDraft>): void => {
        setDraft({ ...shown, ...field });
        setError("");
    };

    const save = async (): Promise<void> => {
        if (!patch || Object.keys(patch).length === 0 || saving) return;
        setSaving(true);
        try {
            onSaved(await patchLimit(row.name, patch));
            setDraft(null);
        } catch (e) {
            setError(errorMessage(e, "Could not save this model's limit."));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="limit-row">
            <div className="limit-head">
                <span className="limit-name"><b>{row.name}</b><span className="mono dim3">{row.provider}</span></span>
                <span className="limit-use" data-reached={use.reached || undefined}>
                    {use.reached ? `Limit reached · ${use.text}` : `Today ${use.text}`}
                </span>
            </div>
            {use.fraction !== null && (
                <div className="limit-track" data-reached={use.reached || undefined} role="img" aria-label={`${row.name} today: ${use.text}`}>
                    <span style={{ width: `${use.fraction * 100}%` }} />
                </div>
            )}
            <fieldset className="limit-fields" disabled={saving}>
                <label>
                    Input, $ per 1M
                    <input type="text" inputMode="decimal" placeholder="0" value={shown.priceIn} aria-label={`${row.name} input price, dollars per 1M tokens`} onChange={(e) => edit({ priceIn: e.target.value })} />
                </label>
                <label>
                    Output, $ per 1M
                    <input type="text" inputMode="decimal" placeholder="0" value={shown.priceOut} aria-label={`${row.name} output price, dollars per 1M tokens`} onChange={(e) => edit({ priceOut: e.target.value })} />
                </label>
                <div className="limit-daily">
                    <span>Daily limit</span>
                    <span className="limit-daily-input">
                        <input type="text" inputMode={shown.unit === "tokens" ? "numeric" : "decimal"} placeholder="No limit" value={shown.value} aria-label={`${row.name} daily limit in ${shown.unit === "tokens" ? "tokens" : "dollars"}`} aria-invalid={Boolean(invalid)} onChange={(e) => edit({ value: e.target.value })} />
                        <span className="seg" role="group" aria-label={`${row.name} limit unit`}>
                            <button type="button" className={shown.unit === "tokens" ? "on" : ""} aria-pressed={shown.unit === "tokens"} onClick={() => edit({ unit: "tokens" })}>tokens</button>
                            <button type="button" className={shown.unit === "usd" ? "on" : ""} aria-pressed={shown.unit === "usd"} onClick={() => edit({ unit: "usd" })}>$</button>
                        </span>
                    </span>
                </div>
                {hint && <span className="limit-hint">{hint}</span>}
                {changed && (
                    <span className="limit-acts">
                        <Btn kind="primary" sm disabled={saving || patch === null} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Btn>
                        <Btn kind="quiet" sm disabled={saving} onClick={() => { setDraft(null); setError(""); }}>Reset</Btn>
                    </span>
                )}
            </fieldset>
            {(invalid || error) && <Err>{invalid || error}</Err>}
        </div>
    );
}
