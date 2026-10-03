// How the Limits & prices tab reads a model: its edited fields into a PATCH, the worst-case hint beside the limit, and today's use against it.
import type { LimitPatch, LimitRow, LimitUnit } from "./api.ts";
import { isPositiveInt, number, plural } from "./shared.ts";
import { usd } from "./spend.ts";

/** The fields as typed: an empty price is 0, an empty limit is unlimited. */
export interface LimitDraft {
    priceIn: string;
    priceOut: string;
    unit: LimitUnit;
    value: string;
}

export const draftOf = (row: LimitRow): LimitDraft => ({
    priceIn: row.priceInPerM ? String(row.priceInPerM) : "",
    priceOut: row.priceOutPerM ? String(row.priceOutPerM) : "",
    unit: row.limit?.unit ?? "tokens",
    value: row.limit ? String(row.limit.value) : "",
});

/** `patch` holds only what differs from the row and is null while a field is invalid; the hint prices the limit at the output price, the worst case. */
export function readDraft(row: LimitRow, draft: LimitDraft): { patch: LimitPatch | null; error: string; hint: string } {
    const priceIn = draft.priceIn.trim() === "" ? 0 : Number(draft.priceIn);
    const priceOut = draft.priceOut.trim() === "" ? 0 : Number(draft.priceOut);
    const text = draft.value.trim();
    const value = Number(text);
    const error = !(Number.isFinite(priceIn) && priceIn >= 0 && Number.isFinite(priceOut) && priceOut >= 0) ? "A price is dollars per 1M tokens: 0 or more."
        : text === "" ? ""
        : draft.unit === "tokens" && !isPositiveInt(text) ? "A token limit is a positive whole number. Leave it empty for no limit."
        : draft.unit === "usd" && !(Number.isFinite(value) && value > 0) ? "A dollar limit is an amount above 0. Leave it empty for no limit."
        : "";
    if (error) return { patch: null, error, hint: "" };

    const limit = text === "" ? null : { unit: draft.unit, value };
    const patch: LimitPatch = {};
    if (priceIn !== row.priceInPerM) patch.priceInPerM = priceIn;
    if (priceOut !== row.priceOutPerM) patch.priceOutPerM = priceOut;
    if (limit?.unit !== row.limit?.unit || limit?.value !== row.limit?.value) patch.limit = limit;

    let hint = "";
    if (limit && priceOut > 0)
        hint = limit.unit === "tokens" ? `≈ up to ${usd(limit.value / 1e6 * priceOut)}` : `≈ at least ${number.format(Math.floor(limit.value / priceOut * 1e6))} tokens`;
    else if (limit?.unit === "usd" && priceIn === 0) hint = "A dollar limit on a model without prices is never reached. Set a price first.";
    return { patch, error: "", hint };
}

/** Today's use in the limit's own unit; `fraction` is null with no limit. */
export function limitUse(row: LimitRow): { text: string; fraction: number | null; reached: boolean } {
    const { tokens, cost } = row.today;
    const spent = `${number.format(tokens)} ${plural(tokens, "token", "tokens")}`;
    if (!row.limit) return { text: [spent, usd(cost)].filter(Boolean).join(" · "), fraction: null, reached: false };
    const used = row.limit.unit === "tokens" ? tokens : cost;
    const text = row.limit.unit === "tokens"
        ? [`${number.format(tokens)} of ${number.format(row.limit.value)} tokens`, usd(cost)].filter(Boolean).join(" · ")
        : `${usd(cost) || "$0.00"} of ${usd(row.limit.value)} · ${spent}`;
    return { text, fraction: Math.min(1, used / row.limit.value), reached: used >= row.limit.value };
}
