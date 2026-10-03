import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

import {
    getAgentModels,
    patchAgentModels,
    type AgentModelPolicy,
    type AgentModelPolicyPatch,
} from "../api.ts";
import { Btn, Empty } from "../components/ui.tsx";
import { errorMessage, Err } from "../shared.ts";

const FORM: CSSProperties = { display: "grid", gap: 12, padding: 0 };
const ROW: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const HINT: CSSProperties = { fontSize: 11.5 };

/** One agent's model policy: primary, fallback and an allow-list; daily limits are the models' own, in Settings. */
function ModelPolicyPanel({ agent }: { agent: string }): ReactElement {
    const [policy, setPolicy] = useState<AgentModelPolicy | null>(null);
    const [error, setError] = useState("");
    const [primary, setPrimary] = useState("");
    const [fallback, setFallback] = useState("");
    const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set());
    const [defaultOnly, setDefaultOnly] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const load = useCallback(async (): Promise<void> => {
        setError("");
        try {
            const p = await getAgentModels(agent);
            setPolicy(p);
            setPrimary(p.primary ?? "");
            setFallback(p.fallback ?? "");
            setAllowed(new Set(p.allowed ?? []));
            setDefaultOnly(p.allowed === null);
        } catch (e) {
            setError(errorMessage(e));
        }
    }, [agent]);

    useEffect(() => {
        setPolicy(null);
        setError("");
        setSaved(false);
        void load();
    }, [load]);

    /** An explicit empty list grants no models; null follows the gateway default. */
    const toggle = (name: string): void => {
        setSaved(false);
        const next = new Set(allowed);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        setAllowed(next);
        // a primary or fallback that fell out of the grants would be refused by the PATCH and every turn, so it goes
        if (primary !== "" && !next.has(primary)) setPrimary("");
        if (fallback !== "" && !next.has(fallback)) setFallback("");
    };

    const dirty = policy !== null && (
        primary !== (policy.primary ?? "") ||
        fallback !== (policy.fallback ?? "") ||
        defaultOnly !== (policy.allowed === null) ||
        (!defaultOnly && (allowed.size !== policy.allowed?.length ||
            [...allowed].some((m) => !policy.allowed?.includes(m))))
    );

    const save = async (): Promise<void> => {
        if (saving || !dirty) return;
        setSaving(true);
        setError("");
        try {
            const patch: AgentModelPolicyPatch = {
                // null clears; omitting a field would keep the server's old value
                primary: primary === "" ? null : primary,
                fallback: fallback === "" ? null : fallback,
                allowed: defaultOnly ? null : [...allowed],
            };
            const p = await patchAgentModels(agent, patch);
            setPolicy(p);
            setPrimary(p.primary ?? "");
            setFallback(p.fallback ?? "");
            setAllowed(new Set(p.allowed ?? []));
            setDefaultOnly(p.allowed === null);
            setSaved(true);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setSaving(false);
        }
    };

    if (error !== "" && policy === null)
        return (
            <Err>
                <div style={{ ...ROW, gap: 10 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
                    <Btn sm icon="refresh" onClick={() => void load()}>Retry</Btn>
                </div>
            </Err>
        );

    // the same bar the lazy chunk showed, so loading the policy after the code does not flash
    if (policy === null) return <span className="skel skel-wait" style={{ width: "60%" }} />;

    const { available, default: def } = policy;
    const granted = available.filter((m) => (defaultOnly ? m === def : allowed.has(m)));

    return (
        <>
            {available.length === 0 ? (
                <Empty>The gateway has no models yet. Add one in Settings, Models, before {agent} can use a primary or a fallback.</Empty>
            ) : (
                <fieldset disabled={saving} style={{ ...FORM, margin: 0, border: 0, minWidth: 0 }}>
                    {/* both selects offer only the granted set: anything else is refused by the PATCH and by every turn */}
                    <div style={ROW}>
                        <span style={{ width: 90 }}>Primary</span>
                        <select
                            value={primary}
                            aria-label="Primary model"
                            style={{ minWidth: 200 }}
                            onChange={(e) => {
                                setPrimary(e.target.value);
                                setSaved(false);
                            }}
                        >
                            <option value="">Use inherited model</option>
                            {granted.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </select>
                        <span className="dim3" style={HINT}>
                            {defaultOnly
                                ? "Only the gateway default is allowed"
                                : granted.length === 0 ? "Allow a model below to select it" : "Choose from this agent's allowed models"}
                        </span>
                    </div>
                    <div style={ROW}>
                        <span style={{ width: 90 }}>Fallback</span>
                        <select
                            value={fallback}
                            aria-label="Fallback model"
                            style={{ minWidth: 200 }}
                            title="Tried when the primary's provider errors or the primary reached its daily limit"
                            onChange={(e) => {
                                setFallback(e.target.value);
                                setSaved(false);
                            }}
                        >
                            <option value="">No fallback</option>
                            {granted.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </select>
                        <span className="dim3" style={HINT}>
                            Tried on a provider error or when the primary reached its daily limit, never on a refusal
                        </span>
                    </div>
                    <div>
                        <label style={{ ...ROW, marginBottom: 8 }}>
                            <input
                                type="checkbox"
                                checked={defaultOnly}
                                onChange={(e) => {
                                    const useDefault = e.target.checked;
                                    setDefaultOnly(useDefault);
                                    setSaved(false);
                                    if (useDefault) {
                                        if (primary !== def) setPrimary("");
                                        if (fallback !== def) setFallback("");
                                    } else {
                                        if (!allowed.has(primary)) setPrimary("");
                                        if (!allowed.has(fallback)) setFallback("");
                                    }
                                }}
                            />
                            Use the gateway default only
                        </label>
                        <div className="dim3" style={{ ...HINT, marginBottom: 6 }}>
                            {defaultOnly
                                ? def ? `Currently ${def}. Changes to the default apply automatically.` : "No default model is configured."
                                : "Choose allowed models. Leave all unchecked to deny model calls."}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                            {available.map((m) => (
                                <label
                                    key={m}
                                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={defaultOnly ? m === def : allowed.has(m)}
                                        disabled={defaultOnly}
                                        onChange={() => toggle(m)}
                                    />
                                    <span className="mono">{m}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                    {error && <Err>{error}</Err>}
                    <div style={ROW}>
                        <Btn
                            kind="primary"
                            sm
                            disabled={saving || !dirty}
                            onClick={() => void save()}
                        >
                            {saving ? "Saving…" : "Save changes"}
                        </Btn>
                        <Btn
                            kind="quiet"
                            sm
                            disabled={saving || !dirty}
                            onClick={() => {
                                setPrimary(policy.primary ?? "");
                                setFallback(policy.fallback ?? "");
                                setAllowed(new Set(policy.allowed ?? []));
                                setDefaultOnly(policy.allowed === null);
                                setError("");
                                setSaved(false);
                            }}
                        >
                            Reset
                        </Btn>
                        {dirty && !saving && <span className="dim3" style={HINT}>Unsaved changes</span>}
                        {saved && (
                            <span className="dim3" style={HINT}>
                                Saved
                            </span>
                        )}
                    </div>
                </fieldset>
            )}
        </>
    );
}

export default function AgentModels({
    agent,
}: {
    /** Required: no `list[0]` fallback that could land on the wrong agent. */
    agent: string;
}): ReactElement {
    return <ModelPolicyPanel key={agent} agent={agent} />;
}
