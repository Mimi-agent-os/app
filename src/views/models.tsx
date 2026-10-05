import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import {
    addModel,
    listAgents,
    getUsage,
    listModels,
    listProviders,
    pingModel,
    removeModel,
    revealModelKey,
    setDefaultModel,
    updateModel,
    type AgentSummary,
    type ModelPatch,
    type ModelPatched,
    type ModelSummary,
    type ParamField,
    type PingResult,
    type ProviderInfo,
    type UsageStats,
    type UsageTotals,
} from "../api.ts";
import { useToast } from "../components/toast.tsx";
import { useDialog } from "../components/dialog.tsx";
import { Btn, Dot, Empty, Panel, Pill, Skeleton } from "../components/ui.tsx";
import { holdBack, releaseBack } from "../route.ts";
import { errorMessage, Err, isPositiveInt, kilo, plural } from "../shared.ts";
import { NO_USAGE, resetTime, usd } from "../spend.ts";

/** What one ping said. "running" is a state of its own: a live call can take 15 s and the
 *  card must not look idle meanwhile. */
type Probe = { state: "running" } | ({ state: "done" } & PingResult);

/** A gateway model shows its remote model id; a local server or CLI shows its endpoint. */
const where = (m: ModelSummary): string => `${m.provider} · ${m.modelId ?? m.endpoint}`;

const TEXTAREA: CSSProperties = {
    font: "400 12px/1.55 var(--mono)",
    color: "inherit",
    background: "var(--panel-2)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r2)",
    padding: "9px 12px",
    resize: "vertical",
    width: "100%",
};

/** The tab's own verb bar — this file no longer owns the `.wtop` header. */
const BAR: CSSProperties = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };

/** Security: a revealed key auto-hides after this long — the real leak risk is a tab left open, not the click itself. */
const REVEAL_TTL_MS = 60_000;

const FORM: CSSProperties = { display: "grid", gap: 14 };
const ROW: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const FIELDS: CSSProperties = {
    display: "grid",
    gap: 12,
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
};
const HINT: CSSProperties = { fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.45 };
const CHECK: CSSProperties = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, minHeight: "var(--ctl-h)" };

/** True only when the adapter declares a key AND it is unset — knowable without spending a ping. */
const keyMissing = (m: ModelSummary, p: ProviderInfo | undefined): boolean =>
    p?.keyRequirement === "required" && !m.keySet;

/** Assumes an unknown adapter needs a key too — hiding it by default would be the wrong guess. */
const needsKey = (p: ProviderInfo | undefined): boolean => !p || Boolean(p.keyEnv);


function Field({
    label,
    hint,
    span,
    children,
}: {
    label: string;
    hint?: ReactNode;
    span?: boolean;
    children: ReactNode;
}): ReactElement {
    return (
        <label style={{ display: "grid", gap: 5, ...(span ? { gridColumn: "1 / -1" } : {}) }}>
            <span className="eyebrow">{label}</span>
            {children}
            {hint !== undefined && <span style={HINT}>{hint}</span>}
        </label>
    );
}

/** Escape is bound by the owner, not by Modal itself. */
function Modal({
    title,
    sub,
    width,
    onClose,
    children,
}: {
    title: ReactNode;
    sub?: ReactNode;
    width: number;
    onClose: () => void;
    children: ReactNode;
}): ReactElement {
    const modalRef = useRef<HTMLDivElement | null>(null);
    const pressedShade = useRef(false);
    const titleId = useId();
    const close = useRef(onClose);
    close.current = onClose;

    useEffect(() => {
        const hold = holdBack(() => close.current());
        const previous = document.activeElement;
        const box = modalRef.current;
        const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]';
        (box?.querySelector<HTMLElement>(selector) ?? box)?.focus();
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== "Tab" || e.defaultPrevented || document.querySelector('.dlg[aria-modal="true"]:not(.model-dialog)')) return;
            const stops = Array.from(box?.querySelectorAll<HTMLElement>(selector) ?? []).filter((el) => el.getClientRects().length > 0);
            const first = stops[0];
            const last = stops[stops.length - 1];
            if (!first || !last) {
                e.preventDefault();
                box?.focus();
            } else if (e.shiftKey ? document.activeElement === first || !box?.contains(document.activeElement) : document.activeElement === last || !box?.contains(document.activeElement)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => {
            releaseBack(hold);
            window.removeEventListener("keydown", onKey, true);
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
        };
    }, []);

    return (
        <div
            className="mback dlgback"
            // only a press that starts and ends on the shade dismisses: a text selection dragged out of an input must not
            onPointerDown={(e) => { pressedShade.current = e.target === e.currentTarget; }}
            onClick={(e) => { if (pressedShade.current && e.target === e.currentTarget) onClose(); }}
        >
            <div ref={modalRef} className="dlg model-dialog" style={{ width: `min(${width}px, 94vw)` }} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
                <h2 id={titleId}>
                    {title}
                    {sub !== undefined && (
                        <span className="dim3" style={{ fontWeight: 400 }}>
                            {" "}
                            · {sub}
                        </span>
                    )}
                </h2>
                {children}
            </div>
        </div>
    );
}


const scalarFields = (fields: ParamField[]): ParamField[] =>
    fields.filter((f) => f.type !== "json");
const jsonFields = (fields: ParamField[]): ParamField[] => fields.filter((f) => f.type === "json");

const seedScalars = (
    fields: ParamField[],
    current: Record<string, unknown>,
): Record<string, string> =>
    Object.fromEntries(
        scalarFields(fields)
            .filter((f) => current[f.key] !== undefined)
            .map((f) => [f.key, String(current[f.key])]),
    );

const seedJson = (fields: ParamField[], current: Record<string, unknown>): string => {
    const seed: Record<string, unknown> = {};
    for (const f of jsonFields(fields))
        if (current[f.key] !== undefined) seed[f.key] = current[f.key];
    return Object.keys(seed).length ? JSON.stringify(seed, null, 2) : "";
};

/** Unknown params have no widget, so they're carried through rather than dropped — losing them would silently break vendor-specific config on pass-through gateways. */
const unknownParams = (
    fields: ParamField[],
    current: Record<string, unknown>,
): Record<string, unknown> => {
    const known = new Set(fields.map((f) => f.key));
    return Object.fromEntries(Object.entries(current).filter(([k]) => !known.has(k)));
};

/** Empty input means NOT SET — the provider default applies — so it's dropped rather than sent as 0 or "". Throws a sentence the form shows verbatim. */
function collectParams(
    fields: ParamField[],
    scalars: Record<string, string>,
    json: string,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of scalarFields(fields)) {
        const v = (scalars[f.key] ?? "").trim();
        if (!v) continue;
        if (f.type === "number") {
            const n = Number(v);
            if (!Number.isFinite(n)) throw new Error(`${f.key}: "${v}" is not a number`);
            out[f.key] = n;
        } else if (f.type === "boolean") {
            out[f.key] = v === "true";
        } else {
            out[f.key] = v;
        }
    }
    if (json.trim()) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch (e) {
            throw new Error(`JSON: ${errorMessage(e)}`);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("A JSON field must be an object { … }.");
        }
        Object.assign(out, parsed);
    }
    return out;
}

/** Empty text = {}. Throws the sentence the form shows verbatim. */
function parseRawParams(text: string): Record<string, unknown> {
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Params must be a JSON object { … }.");
    }
    return parsed as Record<string, unknown>;
}

const TRISTATE = [
    { v: "", t: "Default" },
    { v: "true", t: "Yes" },
    { v: "false", t: "No" },
] as const;

function ParamFields({
    fields,
    scalars,
    json,
    onScalar,
    onJson,
}: {
    fields: ParamField[];
    scalars: Record<string, string>;
    json: string;
    onScalar: (key: string, value: string) => void;
    onJson: (value: string) => void;
}): ReactElement {
    const structured = jsonFields(fields);
    return (
        <div style={{ display: "grid", gap: 12 }}>
            <div style={FIELDS}>
                {scalarFields(fields).map((f) => (
                    <Field key={f.key} label={f.key} {...(f.hint ? { hint: f.hint } : {})}>
                        {f.type === "boolean" ? (
                            <div className="seg" style={{ width: "fit-content" }}>
                                {TRISTATE.map((o) => (
                                    <button
                                        key={o.v}
                                        type="button"
                                        className={(scalars[f.key] ?? "") === o.v ? "on" : ""}
                                        onClick={() => onScalar(f.key, o.v)}
                                    >
                                        {o.t}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <input
                                type="text"
                                {...(f.type === "number" ? { inputMode: "decimal" as const } : {})}
                                value={scalars[f.key] ?? ""}
                                placeholder="Provider default"
                                onChange={(e) => onScalar(f.key, e.target.value)}
                            />
                        )}
                    </Field>
                ))}
            </div>
            {structured.length > 0 && (
                <Field
                    label={`Structured: ${structured.map((f) => f.key).join(", ")}`}
                    hint="One JSON object holding the structured params."
                >
                    <textarea
                        rows={4}
                        style={TEXTAREA}
                        value={json}
                        placeholder='{ "chat_template_kwargs": { "enable_thinking": true } }'
                        onChange={(e) => onJson(e.target.value)}
                    />
                </Field>
            )}
        </div>
    );
}

/** Switching between fields and raw re-seeds from what was typed and refuses on invalid JSON, so
 *  nothing is silently dropped; unmapped params are carried underneath the fields for the same reason. */
function ParamsEditor({
    provider,
    initial,
    into,
    onError,
}: {
    provider: ProviderInfo | undefined;
    initial: Record<string, unknown>;
    /** Called at save time only — reading on every keystroke would mean setState-in-render from a child, which React forbids. */
    into: { current: () => Record<string, unknown> };
    onError: (message: string) => void;
}): ReactElement {
    const fields = provider?.params ?? [];
    const [raw, setRaw] = useState(Boolean(provider?.openParams) || fields.length === 0);
    const [scalars, setScalars] = useState(() => seedScalars(fields, initial));
    const [json, setJson] = useState(() => seedJson(fields, initial));
    const [rawText, setRawText] = useState(() => JSON.stringify(initial, null, 2));
    const [extra, setExtra] = useState(() => unknownParams(fields, initial));

    into.current = () =>
        raw ? parseRawParams(rawText) : { ...extra, ...collectParams(fields, scalars, json) };

    const toFields = (): void => {
        let obj: Record<string, unknown>;
        try {
            obj = parseRawParams(rawText);
        } catch (e) {
            onError(`Fix the JSON first: ${errorMessage(e)}`);
            return;
        }
        onError("");
        setScalars(seedScalars(fields, obj));
        setJson(seedJson(fields, obj));
        setExtra(unknownParams(fields, obj));
        setRaw(false);
    };
    const toRaw = (): void => {
        try {
            setRawText(
                JSON.stringify({ ...extra, ...collectParams(fields, scalars, json) }, null, 2),
            );
        } catch {
            setRawText(JSON.stringify(initial, null, 2));
        }
        setRaw(true);
    };

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={ROW}>
                <span className="eyebrow">Params</span>
                {fields.length > 0 && (
                    <div className="seg" style={{ marginLeft: "auto" }}>
                        <button type="button" className={raw ? "" : "on"} onClick={toFields}>
                            Fields
                        </button>
                        <button type="button" className={raw ? "on" : ""} onClick={toRaw}>
                            JSON
                        </button>
                    </div>
                )}
            </div>
            {raw ? (
                <>
                    <textarea
                        style={{ ...TEXTAREA, minHeight: 140 }}
                        value={rawText}
                        spellCheck={false}
                        placeholder="{ }"
                        onChange={(e) => setRawText(e.target.value)}
                    />
                    <span style={HINT}>
                        The whole params object, sent to the provider verbatim.
                        {provider?.openParams
                            ? " Unknown keys are allowed: this gateway passes them through."
                            : fields.length
                              ? ` Known keys: ${fields.map((f) => f.key).join(", ")}.`
                              : ""}
                    </span>
                </>
            ) : (
                <>
                    <ParamFields
                        fields={fields}
                        scalars={scalars}
                        json={json}
                        onScalar={(k, v) => setScalars((s) => ({ ...s, [k]: v }))}
                        onJson={setJson}
                    />
                    <span style={HINT}>
                        An empty field leaves the param unset, so the provider default applies.
                        {Object.keys(extra).length > 0 &&
                            ` Also kept as is: ${Object.keys(extra).join(", ")} (edit them as JSON).`}
                    </span>
                </>
            )}
            {!provider && (
                <span style={HINT}>
                    The server does not know this adapter, so params can only be edited as JSON.
                </span>
            )}
        </div>
    );
}


function EditModel({
    model,
    provider,
    agents,
    onSaved,
    onCancel,
}: {
    model: ModelSummary;
    provider: ProviderInfo | undefined;
    /** Every agent, for the rename sentence: who names this model and will follow. */
    agents: AgentSummary[];
    onSaved: (r: ModelPatched) => void;
    onCancel: () => void;
}): ReactElement {
    const [name, setName] = useState(model.name);
    const [endpoint, setEndpoint] = useState(model.endpoint);
    const [modelId, setModelId] = useState(model.modelId ?? "");
    const [ctx, setCtx] = useState(String(model.contextTokens));
    const [vision, setVision] = useState(model.vision);
    const readParams = useRef<() => Record<string, unknown>>(() => model.params);
    const [err, setErr] = useState("");
    const [saving, setSaving] = useState(false);

    const renaming = name.trim() !== "" && name.trim() !== model.name;
    const contextInvalid = !isPositiveInt(ctx);
    const followers = agents.filter((a) => !a.inherited && a.model === model.name);

    const save = async (): Promise<void> => {
        if (saving || contextInvalid || !name.trim()) return;
        setErr("");
        let params: Record<string, unknown>;
        try {
            params = readParams.current();
        } catch (e) {
            setErr(errorMessage(e));
            return;
        }
        // params always go WHOLE: a cleared field must actually clear, and PATCH replaces the
        // object rather than merging into it
        const patch: ModelPatch = { params, vision };
        if (renaming) patch.name = name.trim();
        if (endpoint.trim()) patch.endpoint = endpoint.trim();
        if (modelId.trim()) patch.modelId = modelId.trim();
        if (ctx.trim()) patch.contextTokens = Number(ctx);
        setSaving(true);
        try {
            onSaved(await updateModel(model.name, patch));
        } catch (e) {
            setErr(errorMessage(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={FORM}>
            <div style={FIELDS}>
                <Field
                    label="Name"
                    hint={
                        renaming
                            ? followers.length
                                ? `${followers.map((a) => a.name).join(", ")} run on it. Their model policies, the default and the key env follow the rename, but agent code that names it is not rewritten.`
                                : "No agent runs on it by name. The registry row, the default and the key env follow the rename."
                            : "How agents refer to it. The per-model key env derives from it."
                    }
                >
                    <input
                        type="text"
                        className="mono"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </Field>
                <Field label="Context, tokens" hint={contextInvalid ? "Enter a positive whole number." : "The model's context window; each chat's size is measured against it."}>
                    <input
                        type="text"
                        inputMode="numeric"
                        aria-invalid={contextInvalid}
                        value={ctx}
                        onChange={(e) => setCtx(e.target.value)}
                    />
                </Field>
                <Field label="Images" hint="Lets a chat attach images. The gateway refuses images to a model without it.">
                    <label style={CHECK}>
                        <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
                        Supports images
                    </label>
                </Field>
                {provider?.needsModelId && (
                    <Field
                        label="Remote model ID"
                        span
                        hint={provider.modelIdHint ?? "The ID the gateway knows it by."}
                    >
                        <input
                            type="text"
                            className="mono"
                            value={modelId}
                            onChange={(e) => setModelId(e.target.value)}
                        />
                    </Field>
                )}
                <Field label="Endpoint" span {...(provider?.endpointHint ? { hint: provider.endpointHint } : {})}>
                    <input
                        type="text"
                        className="mono"
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                    />
                </Field>
            </div>

            <ParamsEditor
                provider={provider}
                initial={model.params}
                into={readParams}
                onError={setErr}
            />

            {err && <Err>{err}</Err>}
            <div className="btns">
                <span style={{ ...HINT, marginRight: "auto", alignSelf: "center" }}>
                    Agents on this model are worth restarting.
                </span>
                <Btn kind="quiet" sm onClick={onCancel}>
                    Cancel
                </Btn>
                <Btn kind="primary" sm disabled={saving || contextInvalid || !name.trim()} onClick={() => void save()}>
                    {saving ? "Saving…" : "Save"}
                </Btn>
            </div>
        </div>
    );
}


/** A revealed value, filed under the ENV VAR the server actually read. */
type KeyShown = { env: string; key: string; value: string };

/** Addressed by MODEL, not by env var — the endpoints are PATCH …/:name and POST …/:name/key/reveal;
 *  the server resolves the shared env var, so saving here rotates every model that reads it. */
function ManageKey({
    model,
    sharers,
    shown,
    revealing,
    revealErr,
    onReveal,
    onDone,
    onClose,
}: {
    model: ModelSummary;
    /** Every model reading the same env var, this one included. */
    sharers: ModelSummary[];
    shown: KeyShown | null;
    revealing: string | null;
    revealErr: { env: string; message: string } | null;
    onReveal: () => void;
    onDone: (keyEnv: string, rebuilt: number, busy: number[]) => void;
    onClose: () => void;
}): ReactElement {
    const [value, setValue] = useState("");
    const [err, setErr] = useState("");
    const [saving, setSaving] = useState(false);
    const open = shown?.env === model.keyEnv;

    const save = async (): Promise<void> => {
        const key = value.trim();
        if (!key) {
            setErr("The server ignores an empty key, so there is nothing to save.");
            return;
        }
        setErr("");
        setSaving(true);
        try {
            const r = await updateModel(model.name, { apiKey: key });
            onDone(r.keyEnv ?? model.keyEnv, r.rebuilt ?? 0, r.busy ?? []);
        } catch (e) {
            setErr(errorMessage(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={FORM}>
            <div style={{ ...ROW, gap: 10 }}>
                <Dot state={model.keySet ? "ok" : "degraded"} />
                <span style={{ fontSize: 12.5 }}>
                    {model.keySet ? "set" : "not configured"}
                </span>
                <span style={{ ...HINT, marginLeft: "auto" }}>
                    Read by {sharers.map((m) => m.name).join(", ")}
                </span>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
                <span className="eyebrow">Current value</span>
                {open ? (
                    <>
                        <span
                            className="mono"
                            style={{
                                fontSize: 11.5,
                                wordBreak: "break-all",
                                userSelect: "all",
                                padding: "9px 12px",
                                background: "var(--panel-2)",
                                border: "1px solid var(--line)",
                                borderRadius: "var(--r2)",
                            }}
                        >
                            {shown.value}
                        </span>
                        <span style={HINT}>
                            {shown.key} · on screen until a minute passes or you press Esc
                        </span>
                    </>
                ) : (
                    <div style={ROW}>
                        <Btn
                            sm
                            icon="key"
                            disabled={!model.keySet || revealing !== null}
                            title={
                                model.keySet
                                    ? "Shows the value. One explicit click, recorded server-side."
                                    : "Nothing to show yet"
                            }
                            onClick={onReveal}
                        >
                            {revealing === model.keyEnv ? "Reading…" : "Reveal"}
                        </Btn>
                        <span style={HINT}>Never sent to the browser until you ask.</span>
                    </div>
                )}
                {revealErr?.env === model.keyEnv && (
                    <span style={{ ...HINT, color: "var(--bad)" }}>
                        Could not read the value: {revealErr.message}
                    </span>
                )}
            </div>

            <Field
                label={model.keySet ? "New value" : "Value"}
                hint={`Stored encrypted in mimi/.env as ${model.keyEnv}. Live chats on ${
                    sharers.length === 1 ? "this model" : "these models"
                } pick it up immediately.`}
            >
                <input
                    type="password"
                    autoComplete="off"
                    value={value}
                    placeholder={model.keySet ? "Paste the replacement key" : "Paste the key"}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") void save();
                    }}
                />
            </Field>

            {err && <Err>{err}</Err>}
            <div className="btns">
                <Btn kind="quiet" sm onClick={onClose}>
                    Close
                </Btn>
                <Btn kind="primary" sm disabled={saving || !value.trim()} onClick={() => void save()}>
                    {model.keySet ? "Replace" : "Save"}
                </Btn>
            </div>
        </div>
    );
}


function AddModel({
    providers,
    onAdded,
    onCancel,
}: {
    providers: ProviderInfo[];
    onAdded: () => void;
    onCancel: () => void;
}): ReactElement {
    const [kind, setKind] = useState(providers[0]?.kind ?? "");
    const provider = providers.find((p) => p.kind === kind);
    const [name, setName] = useState("");
    const [endpoint, setEndpoint] = useState("");
    const [modelId, setModelId] = useState("");
    const [ctx, setCtx] = useState("");
    const [vision, setVision] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const readParams = useRef<() => Record<string, unknown>>(() => ({}));
    const [err, setErr] = useState("");
    const [saving, setSaving] = useState(false);

    const contextInvalid = !isPositiveInt(ctx);
    const submit = async (): Promise<void> => {
        if (saving || contextInvalid || !name.trim()) return;
        setErr("");
        let params: Record<string, unknown>;
        try {
            params = readParams.current();
        } catch (e) {
            setErr(errorMessage(e));
            return;
        }
        setSaving(true);
        try {
            await addModel({
                name: name.trim(),
                provider: kind,
                contextTokens: Number(ctx),
                vision,
                ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
                ...(modelId.trim() ? { modelId: modelId.trim() } : {}),
                ...(Object.keys(params).length ? { params } : {}),
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            });
            onAdded();
        } catch (e) {
            setErr(errorMessage(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={FORM}>
            {/* params belong to the adapter, so the editor below is force-remounted (`key={kind}`)
                on switch — otherwise stale state would carry over */}
            <Field label="Provider">
                <div className="seg" style={{ width: "fit-content" }}>
                    {providers.map((p) => (
                        <button
                            key={p.kind}
                            type="button"
                            className={p.kind === kind ? "on" : ""}
                            onClick={() => setKind(p.kind)}
                        >
                            {p.kind}
                        </button>
                    ))}
                </div>
            </Field>
            <div style={FIELDS}>
                <Field label="Name" hint="How agents will refer to it. Short and URL-safe.">
                    <input
                        type="text"
                        className="mono"
                        value={name}
                        placeholder="sonnet"
                        onChange={(e) => setName(e.target.value)}
                    />
                </Field>
                <Field label="Context, tokens" hint={ctx && contextInvalid ? "Enter a positive whole number." : "Required: the model's context window size."}>
                    <input
                        type="text"
                        inputMode="numeric"
                        aria-invalid={ctx !== "" && contextInvalid}
                        value={ctx}
                        placeholder="128000"
                        onChange={(e) => setCtx(e.target.value)}
                    />
                </Field>
                <Field label="Images" hint="Lets a chat attach images. The gateway refuses images to a model without it.">
                    <label style={CHECK}>
                        <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
                        Supports images
                    </label>
                </Field>
                {provider?.needsModelId && (
                    <Field label="Remote model ID" span {...(provider.modelIdHint ? { hint: provider.modelIdHint } : {})}>
                        <input
                            type="text"
                            className="mono"
                            value={modelId}
                            onChange={(e) => setModelId(e.target.value)}
                        />
                    </Field>
                )}
                <Field
                    label="Endpoint"
                    span
                    hint={
                        provider?.endpointHint ??
                        (provider?.defaultEndpoint
                            ? `Empty means ${provider.defaultEndpoint}`
                            : "The server's origin, without /v1")
                    }
                >
                    <input
                        type="text"
                        className="mono"
                        value={endpoint}
                        placeholder={provider?.defaultEndpoint ?? "http://127.0.0.1:8080"}
                        onChange={(e) => setEndpoint(e.target.value)}
                    />
                </Field>
                {provider?.keyEnv && (
                    <Field
                        label={provider.keyEnv}
                        span
                        hint={
                            provider.keySet
                                ? "Already set. Leave it empty to keep it, or paste a replacement. Every model of this provider shares it."
                                : "Stored encrypted in mimi/.env and shared by every model of this provider."
                        }
                    >
                        <input
                            type="password"
                            autoComplete="off"
                            value={apiKey}
                            placeholder={provider.keySet ? "Keep the current key" : "Paste the key"}
                            onChange={(e) => setApiKey(e.target.value)}
                        />
                    </Field>
                )}
            </div>
            <ParamsEditor
                key={kind}
                provider={provider}
                initial={{}}
                into={readParams}
                onError={setErr}
            />
            {err && <Err>{err}</Err>}
            <div className="btns">
                <Btn kind="quiet" sm onClick={onCancel}>
                    Cancel
                </Btn>
                <Btn kind="primary" sm disabled={saving || !name.trim() || contextInvalid} onClick={() => void submit()}>
                    {saving ? "Adding…" : "Add"}
                </Btn>
            </div>
        </div>
    );
}


// a model named in agent code has no fallback: the agent fails to load until its code names another
const breakage = (name: string, chose: AgentSummary[], inherited: AgentSummary[]): string => {
    const parts: string[] = [];
    if (chose.length) {
        const who = chose.map((a) => a.name).join(", ");
        parts.push(
            chose.length === 1
                ? `${who} names "${name}" in its code and stops loading until it names another model.`
                : `${who} name "${name}" in their code and stop loading until they name another model.`,
        );
    }
    if (inherited.length) {
        parts.push(
            `${inherited.map((a) => a.name).join(", ")} reach it through the default and follow whatever default remains.`,
        );
    }
    if (parts.length === 0) parts.push("No agent runs on it.");
    parts.push("Only the gateway's model registry changes. The provider key in mimi/.env stays.");
    return parts.join(" ");
};

const FACTS: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "12px 18px",
    padding: "12px 15px",
};
const FACT: CSSProperties = { display: "grid", gap: 4, minWidth: 0, alignContent: "start" };
const FACTV: CSSProperties = { fontSize: 12.5, wordBreak: "break-all" };
const SUB: CSSProperties = { display: "block", fontSize: 11.5, color: "var(--ink-3)" };

function ModelCard({
    model,
    provider,
    users,
    probe,
    usage,
    onPing,
    onMakeDefault,
    onEdit,
    onKey,
    onRemove,
}: {
    model: ModelSummary;
    provider: ProviderInfo | undefined;
    users: AgentSummary[];
    probe: Probe | undefined;
    /** Today's spend on this model's registry row; who used it belongs to that agent's own page. */
    usage: UsageTotals | undefined;
    onPing: () => void;
    onMakeDefault: () => void;
    onEdit: () => void;
    onKey: () => void;
    onRemove: () => void;
}): ReactElement {
    const dialog = useDialog();
    const inherited = users.filter((a) => a.inherited);
    const chose = users.filter((a) => !a.inherited);
    const keyed = needsKey(provider);
    const failed = probe?.state === "done" && !probe.ok;

    return (
        <Panel
            title={
                <span
                    style={{
                        display: "inline-flex",
                        gap: 8,
                        alignItems: "center",
                        minWidth: 0,
                        flexWrap: "wrap",
                    }}
                >
                    <span style={{ fontWeight: 600 }}>{model.name}</span>
                    {model.isDefault && <Pill tone="info">default</Pill>}
                    <span className="mono dim3" style={{ fontSize: 11, fontWeight: 400 }}>
                        {where(model)}
                    </span>
                    <State probe={probe} unkeyed={keyMissing(model, provider)} keyEnv={model.keyEnv} />
                </span>
            }
            aside={
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    <Btn
                        sm
                        icon="refresh"
                        disabled={probe?.state === "running"}
                        title="A real call, paid on gateway providers"
                        onClick={onPing}
                    >
                        Ping
                    </Btn>
                    <Btn sm onClick={onEdit} title="Name, endpoint, context, params">
                        Edit
                    </Btn>
                    {!model.isDefault && (
                        <Btn
                            sm
                            title="The model every agent without its own choice runs on"
                            onClick={onMakeDefault}
                        >
                            Make default
                        </Btn>
                    )}
                    {/* the server refuses to drop the default anyway — not offering it beats
                        explaining the refusal afterwards */}
                    {!model.isDefault && (
                        <Btn
                            sm
                            kind="danger"
                            onClick={() => {
                                void dialog
                                    .confirm({
                                        title: `Remove model ${model.name}?`,
                                        body: breakage(model.name, chose, inherited),
                                        ok: "Remove",
                                        danger: true,
                                    })
                                    .then((yes) => {
                                        if (yes) onRemove();
                                    });
                            }}
                        >
                            Remove
                        </Btn>
                    )}
                </span>
            }
        >
            {failed && (
                <div style={{ padding: "10px 15px 0" }}>
                    <Err>
                        Not responding: {probe.error ?? "no explanation"} · {probe.ms} ms
                    </Err>
                </div>
            )}

            <div style={FACTS}>
                <div style={FACT}>
                    <span className="eyebrow">Endpoint</span>
                    <span className="mono" style={FACTV} title={model.endpoint}>
                        {model.endpoint}
                    </span>
                    {model.modelId && (
                        <span style={SUB}>
                            Remote ID <span className="mono">{model.modelId}</span>
                        </span>
                    )}
                </div>

                <div style={FACT}>
                    <span className="eyebrow">Context</span>
                    <span className="mono" style={FACTV}>
                        {kilo(model.contextTokens)} tokens
                    </span>
                    <span style={SUB}>
                        {Object.keys(model.params).length
                            ? `Params: ${Object.keys(model.params).join(", ")}`
                            : "Params: provider defaults"}
                    </span>
                </div>

                <div style={FACT}>
                    <span className="eyebrow">Key</span>
                    {!keyed ? (
                        <span style={FACTV} className="dim3">
                            None needed. This adapter authenticates without one.
                        </span>
                    ) : (
                        <>
                            <span style={{ ...ROW, gap: 8 }}>
                                <Dot state={model.keySet ? "ok" : "degraded"} />
                                <span className="mono" style={{ fontSize: 12.5 }}>
                                    {model.keyEnv}
                                </span>
                                <Btn sm icon="key" onClick={onKey}>
                                    {model.keySet ? "Manage" : "Set key"}
                                </Btn>
                            </span>
                            <span style={SUB}>
                                {model.keySet
                                    ? "Set · encrypted in mimi/.env"
                                    : provider?.keyRequirement === "required" ? "Required. Add an API key."
                                    : provider?.keyRequirement === "optional" ? "Optional. Add one if your endpoint requires it."
                                    : "Not configured"}
                            </span>
                        </>
                    )}
                </div>

                <div style={FACT}>
                    <span className="eyebrow">Used by</span>
                    <span style={FACTV}>
                        {users.length ? users.map((a) => a.name).join(", ") : "Nobody"}
                    </span>
                    {inherited.length > 0 && (
                        <span style={SUB}>
                            Via the default: {inherited.map((a) => a.name).join(", ")}
                        </span>
                    )}
                </div>

                <div style={FACT}>
                    <span className="eyebrow">Spent today</span>
                    {usage ? (
                        <>
                            <span className="mono" style={FACTV}>
                                {kilo(usage.totalTokens)} tokens{usage.cost > 0 && ` · ${usd(usage.cost)}`} · {usage.calls} {plural(usage.calls, "call", "calls")}
                            </span>
                            <span style={SUB}>
                                Input {kilo(usage.promptTokens)} · output {kilo(usage.completionTokens)}
                                {usage.estimatedCalls > 0 && ` · ${usage.estimatedCalls} estimated`}
                            </span>
                        </>
                    ) : (
                        <span style={FACTV} className="dim3">
                            Model breakdown unavailable
                        </span>
                    )}
                </div>
            </div>
        </Panel>
    );
}


export default function ModelsPanel(): ReactElement {
    const [models, setModels] = useState<ModelSummary[] | null>(null);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [agents, setAgents] = useState<AgentSummary[]>([]);
    const [error, setError] = useState("");
    const [probes, setProbes] = useState<Record<string, Probe>>({});
    /** Which dialog is up: at most one. */
    const [editing, setEditing] = useState<string | null>(null);
    const [keying, setKeying] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const toast = useToast();
    const dialog = useDialog();

    /** ONE slot for a revealed key at a time, keyed by ENV VAR, the unit the server actually stores. */
    const [shown, setShown] = useState<KeyShown | null>(null);
    /** Guards against a second click firing a second POST — each reveal writes its own audit line server-side. */
    const [revealing, setRevealing] = useState<string | null>(null);
    /** Kept separate from `shown` — an error must never render inside the box styled for a credential. */
    const [revealErr, setRevealErr] = useState<{ env: string; message: string } | null>(null);
    const revealRequest = useRef(0);

    /** Today's window of the gateway's rollup (GET /api/stats/usage?days=1). */
    const [usage, setUsage] = useState<UsageStats | null>(null);

    const reload = useCallback(async (): Promise<void> => {
        // separately and best-effort: spend that cannot load must not blank the page
        const today = getUsage(1, "registry").catch(() => null);
        try {
            const [m, p, a] = await Promise.all([listModels(), listProviders(), listAgents()]);
            setModels(m);
            setProviders(p);
            setAgents(a.filter((agent) => agent.status === "approved"));
            setError("");
        } catch (e) {
            // a registry that cannot load fails the GET, and that message is the answer
            setError(errorMessage(e));
        }
        setUsage(await today);
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    /** A probe set to "running" MUST leave that state — a thrown error becomes a failed probe, never a stuck "checking…". */
    const ping = useCallback(async (name: string): Promise<PingResult> => {
        setProbes((p) => ({ ...p, [name]: { state: "running" } }));
        try {
            const r = await pingModel(name);
            setProbes((p) => ({ ...p, [name]: { state: "done", ...r } }));
            return r;
        } catch (e) {
            // ms 0 is honest here: we never got a duration, only a thrown transport error
            const r: PingResult = { ok: false, ms: 0, error: errorMessage(e) };
            setProbes((p) => ({ ...p, [name]: { state: "done", ...r } }));
            return r;
        }
    }, []);

    // a check is a real call that spends tokens: the cards re-read today's spend after it, and keep the last one if that read fails
    const refreshSpend = useCallback((): Promise<void> => getUsage(1, "registry").then(setUsage, () => undefined), []);

    // any recorded call or new price re-reads it too, and so does the owner's midnight, when nothing is recorded
    const resetsAt = usage?.day.resetsAt;
    useEffect(() => {
        const refresh = (): void => void refreshSpend();
        window.addEventListener("mimi:usage-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
        const timer = resetsAt ? setTimeout(refresh, Math.max(0, Date.parse(resetsAt) - Date.now()) + 1000) : undefined;
        return () => {
            window.removeEventListener("mimi:usage-changed", refresh);
            window.removeEventListener("mimi:resync", refresh);
            clearTimeout(timer);
        };
    }, [refreshSpend, resetsAt]);

    /** Promise.allSettled, not a sequential chain — one bad probe must not abort the rest, and a
     *  sequential chain would charge every model its neighbours' latency. */
    const pingAll = useCallback(async (): Promise<void> => {
        const names = (models ?? []).map((m) => m.name);
        if (names.length === 0) return;
        const rs = await Promise.allSettled(names.map((n) => ping(n)));
        void refreshSpend();
        const ok = rs.filter((r) => r.status === "fulfilled" && r.value.ok).length;
        toast(
            `Checked ${names.length} ${plural(names.length, "model", "models")} · ${ok} responding` +
                (ok < names.length ? ` · ${names.length - ok} not` : ""),
        );
    }, [models, ping, refreshSpend, toast]);

    /** Read one provider key in plain text. Explicit click, a confirm before the request, one
     *  in-flight request at a time, and a failure that never lands in the value slot. */
    const reveal = useCallback(
        async (m: ModelSummary): Promise<void> => {
            if (revealing !== null) return;
            const request = ++revealRequest.current;
            const ok = await dialog.confirm({
                title: `Reveal the value of ${m.keyEnv}?`,
                body: "It appears on screen. Make sure nobody else is watching and nothing records it.",
                ok: "Reveal",
            });
            if (!ok || request !== revealRequest.current) return;
            setShown(null);
            setRevealErr(null);
            setRevealing(m.keyEnv);
            try {
                const r = await revealModelKey(m.name);
                if (request === revealRequest.current) setShown({ env: m.keyEnv, key: r.key, value: r.value });
            } catch (e) {
                if (request === revealRequest.current) setRevealErr({ env: m.keyEnv, message: errorMessage(e) });
            } finally {
                setRevealing((k) => (k === m.keyEnv ? null : k));
            }
        },
        [dialog, revealing],
    );

    /** The backstop: nothing else drops the value without a click. */
    useEffect(() => {
        if (shown === null) return undefined;
        const t = window.setTimeout(() => setShown(null), REVEAL_TTL_MS);
        return () => window.clearTimeout(t);
    }, [shown]);

    const closeKey = useCallback((): void => {
        revealRequest.current += 1;
        setKeying(null);
        setRevealing(null);
        // the value must not outlive the dialog it was asked for in
        setShown(null);
        setRevealErr(null);
    }, []);

    const act = async (fn: () => Promise<unknown>): Promise<void> => {
        try {
            await fn();
            await reload();
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    // an open dialog owns Escape — capture, so the chat's gate binding never sees it
    useEffect(() => {
        if (editing === null && keying === null && !adding) return undefined;
        const onKey = (e: KeyboardEvent): void => {
            if (e.defaultPrevented || document.querySelector('.dlg[aria-modal="true"]:not(.model-dialog)')) return;
            if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(null);
                setAdding(false);
                closeKey();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [editing, keying, adding, closeKey]);

    const byKind = new Map(providers.map((p) => [p.kind, p]));
    const list = [...(models ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    const def = list.find((m) => m.isDefault);
    const failed = list.filter((m) => {
        const pr = probes[m.name];
        return pr?.state === "done" && !pr.ok;
    });
    const unkeyed = list.filter((m) => keyMissing(m, byKind.get(m.provider)));
    const busy = Object.values(probes).some((p) => p.state === "running");
    // spend on a uid no card holds (a removed model, or none from the registry) stays on the page through the bar
    const elsewhere = (usage?.registryRows ?? []).filter((r) => !list.some((m) => m.modelUid && m.modelUid === r.modelUid)).reduce((n, r) => n + r.totalTokens, 0);

    const when = [
        `${list.length} in the registry`,
        def ? `default ${def.name}` : "no default",
        ...(failed.length ? [`${failed.length} not responding`] : []),
        ...(unkeyed.length ? [`${unkeyed.length} without a key`] : []),
        ...(usage ? [`today's spend resets at ${resetTime(usage.day)}`] : []),
        ...(elsewhere ? [`${kilo(elsewhere)} tokens spent on models not in the registry`] : []),
    ].join(" · ");

    const editingModel = editing === null ? undefined : list.find((x) => x.name === editing);
    const keyingModel = keying === null ? undefined : list.find((x) => x.name === keying);

    return (
        <>
            <div style={BAR}>
                <span className="dim3" style={{ fontSize: 12 }}>
                    {models === null ? "Loading the registry…" : when}
                </span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <Btn
                        sm
                        icon="refresh"
                        disabled={busy || list.length === 0}
                        title="A real call to every model at once, paid on gateway providers"
                        onClick={() => void pingAll()}
                    >
                        Check all
                    </Btn>
                    <Btn
                        kind="primary"
                        sm
                        icon="plus"
                        disabled={providers.length === 0}
                        onClick={() => setAdding(true)}
                    >
                        Connect
                    </Btn>
                </div>
            </div>

            {error && <Err>{error}</Err>}

            {models === null && !error && [0, 1, 2].map((n) => (
                <div key={n} className="pnl" aria-hidden="true">
                    <div className="pnlh">
                        <Skeleton w={140} h={13} />
                        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                            <Skeleton className="round" w={52} h="var(--ctl-h-sm)" />
                            <Skeleton className="round" w={52} h="var(--ctl-h-sm)" />
                        </span>
                    </div>
                    <div style={FACTS}>
                        {/* the real five facts: endpoint, context+sub, key button+sub, used by, spent today+sub */}
                        {[false, true, true, false, true].map((sub, f) => (
                            <div key={f} style={FACT}>
                                <span className="eyebrow"><Skeleton className="inline" w={48} h={9} /></span>
                                <span style={FACTV}>{f === 2
                                    ? <Skeleton className="inline round" w={92} h="var(--ctl-h-sm)" />
                                    : <Skeleton className="inline" w={`${76 - f * 7 - n * 4}%`} h={11} />}</span>
                                {sub && <span style={SUB}><Skeleton className="inline" w="55%" h={9} /></span>}
                            </div>
                        ))}
                    </div>
                </div>
            ))}

            {models !== null && list.length === 0 && (
                <Empty>The registry has no models yet. Connect adds the first one.</Empty>
            )}

            {list.map((m) => (
                <ModelCard
                    key={m.name}
                    model={m}
                    provider={byKind.get(m.provider)}
                    users={agents.filter((a) => a.model === m.name)}
                    probe={probes[m.name]}
                    usage={usage?.registryRows && m.modelUid ? (usage.registryRows.find((r) => r.modelUid === m.modelUid) ?? NO_USAGE) : undefined}
                    onPing={() => void ping(m.name).then(refreshSpend)}
                    onMakeDefault={() => void act(() => setDefaultModel(m.name))}
                    onEdit={() => setEditing(m.name)}
                    onKey={() => setKeying(m.name)}
                    onRemove={() => void act(() => removeModel(m.name))}
                />
            ))}

            {adding && (
                <Modal title="Connect a model" sub="model registry" width={680} onClose={() => setAdding(false)}>
                    <AddModel
                        providers={providers}
                        onAdded={() => {
                            setAdding(false);
                            void reload();
                        }}
                        onCancel={() => setAdding(false)}
                    />
                </Modal>
            )}

            {editingModel && (
                <Modal
                    title={`Edit ${editingModel.name}`}
                    sub={editingModel.provider}
                    width={680}
                    onClose={() => setEditing(null)}
                >
                    <EditModel
                        model={editingModel}
                        provider={byKind.get(editingModel.provider)}
                        agents={agents}
                        onSaved={(r) => {
                            setEditing(null);
                            if (r.renamed) {
                                const who = r.renamed.agents.length
                                    ? ` · ${r.renamed.agents.join(", ")} follow`
                                    : "";
                                const stuck = r.renamed.busy.length
                                    ? ` · chats ${r.renamed.busy.join(", ")} are mid-turn and switch after it`
                                    : "";
                                toast(`${r.renamed.from} → ${r.renamed.to}${who}${stuck}`);
                            }
                            void reload();
                        }}
                        onCancel={() => setEditing(null)}
                    />
                </Modal>
            )}

            {keyingModel && (
                <Modal
                    title={keyingModel.keyEnv}
                    sub="provider key"
                    width={560}
                    onClose={closeKey}
                >
                    <ManageKey
                        model={keyingModel}
                        sharers={list.filter((x) => x.keyEnv === keyingModel.keyEnv)}
                        shown={shown}
                        revealing={revealing}
                        revealErr={revealErr}
                        onReveal={() => void reveal(keyingModel)}
                        onDone={(keyEnv, rebuilt, busyIds) => {
                            closeKey();
                            toast(
                                `${keyEnv} updated · providers rebuilt: ${rebuilt}` +
                                    (busyIds.length
                                        ? ` · chats ${busyIds.join(", ")} are mid-turn, so the key applies after the turn or a restart`
                                        : ""),
                            );
                            void reload();
                        }}
                        onClose={closeKey}
                    />
                </Modal>
            )}
        </>
    );
}

// being in the registry and answering are different facts: an unpinged model never borrows a green pill
function State({
    probe,
    unkeyed,
    keyEnv,
}: {
    probe: Probe | undefined;
    unkeyed: boolean;
    keyEnv: string;
}): ReactElement {
    if (probe?.state === "running") return <Pill>checking…</Pill>;
    if (probe?.state === "done") {
        return probe.ok ? (
            <span {...(probe.text ? { title: `said: ${probe.text}` } : {})}>
                <Pill tone="ok">responding · {probe.ms} ms</Pill>
            </span>
        ) : (
            <span title={probe.error ?? ""}>
                <Pill tone="bad">not responding</Pill>
            </span>
        );
    }
    if (unkeyed) {
        return (
            <span title={`${keyEnv} is not set in mimi/.env`}>
                <Pill tone="warn">no key</Pill>
            </span>
        );
    }
    return <Pill>not checked</Pill>;
}
