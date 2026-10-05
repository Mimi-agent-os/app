import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { isAgentName, PROTOCOL_VERSION } from "@mimi-os/protocol";

import {
    blockPin,
    cancelAgentInvite,
    createAgentInvite,
    listAgentInvites,
    listPins,
    patchPinPerms,
    pingGateway,
    revokePin,
    type AgentInvite,
    type AgentInviteSummary,
    type DashboardSnapshot,
    type GatewayProbe,
    type PinCard,
    type PinPerms,
} from "../api.ts";
import { BackButton, Btn, Dot, Empty, KvRow, Metric, Panel, Pill, Skeleton } from "../components/ui.tsx";
import { Icon } from "../components/icon.tsx";
import { useDialog } from "../components/dialog.tsx";
import { useToast } from "../components/toast.tsx";
import ModelsPanel from "./models.tsx";
import LimitsPanel from "./limits.tsx";
import UsagePanel from "./usage.tsx";
import { devDetails, Err, errorMessage, kilo, notifyEnabled, NOTIFY_KEY, parse, plural, setDevDetails, useMounted, when } from "../shared.ts";
import { resetTime, usd } from "../spend.ts";
import { androidApp, tauriInvoke } from "../tauri.ts";
import { pushEnabled, setPush } from "../push.ts";
import { forgetDevice, gatewayAddress, getSnapshot, recheckProtocol, subscribe } from "../channel.ts";
import { applyTheme, themeChoice, type ThemeChoice } from "../theme.ts";
import ApprovalRequests from "../components/approval-requests.tsx";
import { ConnectionList } from "../components/connection-list.tsx";
import { ConnLine } from "../components/nav-bar.tsx";
import { PairedDevices } from "../components/paired-devices.tsx";
import { CopyTextButton } from "../components/markdown.tsx";
import type { ApprovalSummary } from "../approval-api.ts";
import { useAgentChats } from "../agent-chats.ts";
import { lastSettings, SETTINGS_INDEX, type SettingsSection } from "../route.ts";
import "../agent-invites.css";
import "../settings.css";

const PAD: CSSProperties = { padding: 12 };
const NOTE: CSSProperties = { padding: "11px 15px", font: "var(--f-sm)" };

const Where = ({ children }: { children: ReactNode }): ReactElement => (
    <span className="dim3"> · {children}</span>
);

// every timestamp comes from the gateway's clock, so a browser running fast cannot age a fresh approval
const waited = (since: string, at: string): number =>
    Math.max(0, parse(at).getTime() - parse(since).getTime());

// floored: "4 min" never rounds a wait up into one it has not reached
const dur = (ms: number): string =>
    ms < 60_000 ? `${Math.floor(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;

function approvalWhy(a: ApprovalSummary, at: string, chat: string | null): string {
    const ms = waited(a.since, at);
    const left = a.deadline - parse(at).getTime();
    const ends = a.kind === "question" ? "it closes unanswered" : "the gateway denies it itself";
    const held =
        left > 60_000
            ? `Waiting ${dur(ms)}`
            : left > 0
              ? `Waiting ${dur(ms)}. In under a minute ${ends}`
              : `Waiting ${dur(ms)}. Time is up, ${ends}`;
    const verb = a.kind === "question" ? "Answer" : "Review";
    if (a.room !== undefined || a.conversation === undefined) return `${held}. ${verb} it in Inbox.`;
    return chat ? `${held} in “${chat}”. ${verb} it there or in Inbox.` : `${held} in its chat. ${verb} it there or in Inbox.`;
}

function HealthPanel({
    snap,
    snapError,
    approvals: waiting,
    onAgent,
    onGate,
}: {
    snap: DashboardSnapshot | null;
    snapError: string;
    approvals: readonly ApprovalSummary[];
    onAgent?: ((agent: string) => void) | undefined;
    onGate?: ((gate: ApprovalSummary) => void) | undefined;
}): ReactElement {
    // a gate is named by its chat's title, as the home list names it
    const chats = useAgentChats();
    if (!snap) {
        return snapError ? (
            <Err>Can't reach the gateway: {snapError}</Err>
        ) : (
            <div className="metrics" aria-hidden="true">
                {[0, 1, 2].map((n) => (
                    <div key={n} className="metric"><Skeleton w={54} h={26} /><Skeleton w={72} h={11} /></div>
                ))}
            </div>
        );
    }

    const down = snap.agents.filter((a) => a.status === "approved" && a.health === "down");
    const approvals = [...waiting].sort((x, y) => x.deadline - y.deadline);
    const needs = down.length + approvals.length;
    const { tokens: spent, cost } = snap.today;

    return (
        <>
            {snapError && (
                <Err>
                    Can't reach the gateway: {snapError}. Showing the state as of{" "}
                    {parse(snap.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.
                </Err>
            )}

            <div className="metrics">
                <Metric value={approvals.length} label="awaiting approval" />
                <Metric value={down.length} label="down" />
                <Metric value={kilo(spent)} label="tokens spent today" />
                {cost > 0 && <Metric value={usd(cost)} label="cost today" />}
            </div>
            <p className="metrics-note">Input + output across every agent{cost > 0 ? ", at current prices" : ""}; Usage also counts model checks. The day resets at {resetTime(snap.day)}.</p>

            {needs > 0 && (
                <Panel title="Needs you" icon="warn" aside={<span className="count warn">{needs}</span>}>
                    {down.map((a) => (
                        <div className="nrow" key={a.name}>
                            <Dot state="down" />
                            <div className="txt">
                                <b>{a.name} is down</b>
                                <p>{a.why}</p>
                                {!a.connected && (
                                    <p>
                                        Nothing here can start it. The agent's own process reconnects on its own, and until
                                        it does this gateway has no way in.
                                    </p>
                                )}
                            </div>
                            <div className="acts">
                                {onAgent && (
                                    <Btn kind="quiet" sm onClick={() => onAgent(a.name)}>
                                        Open
                                    </Btn>
                                )}
                            </div>
                        </div>
                    ))}
                    {approvals.map((a) => (
                        <div className="nrow" key={a.gate}>
                            <Dot state="degraded" />
                            <div className="txt">
                                <b>
                                    {a.kind === "question" ? a.label : `${a.agent} waits for approval of ${a.tool}`}
                                </b>
                                <p>{approvalWhy(a, snap.at, chats.get(a.agent)?.rows?.find((c) => c.id === a.conversation)?.title ?? null)}</p>
                            </div>
                            <div className="acts">
                                {onGate && (
                                    <Btn sm onClick={() => onGate(a)}>
                                        {a.room === undefined && a.conversation !== undefined ? "Open chat" : "Open Inbox"}
                                    </Btn>
                                )}
                            </div>
                        </div>
                    ))}
                </Panel>
            )}
        </>
    );
}


function AgentInvitesPanel(): ReactElement {
    const [name, setName] = useState("");
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    // never logged or toasted: it carries the pairing secret
    const [invite, setInvite] = useState<AgentInvite | null>(null);
    const [invites, setInvites] = useState<AgentInviteSummary[]>([]);
    const [canceling, setCanceling] = useState<string | null>(null);
    const mounted = useMounted();

    const refresh = useCallback(async (): Promise<void> => {
        try {
            const rows = await listAgentInvites();
            if (mounted.current) setInvites(rows);
        } catch {
            // the list is a convenience; a failed read leaves the last-known one in place
        }
    }, [mounted]);

    useEffect(() => {
        void refresh();
        const onChange = (): void => void refresh();
        window.addEventListener("mimi:agent-changed", onChange);
        window.addEventListener("mimi:resync", onChange);
        return () => {
            window.removeEventListener("mimi:agent-changed", onChange);
            window.removeEventListener("mimi:resync", onChange);
        };
    }, [refresh]);

    const cancel = async (row: AgentInviteSummary): Promise<void> => {
        setCanceling(row.id);
        try {
            await cancelAgentInvite(row.id);
            if (invite?.id === row.id && mounted.current) setInvite(null);
            await refresh();
        } catch (e) {
            if (mounted.current) setError(errorMessage(e));
        } finally {
            if (mounted.current) setCanceling(null);
        }
    };

    const create = async (): Promise<void> => {
        const bound = name.trim();
        if (!isAgentName(bound)) {
            setError("Agent name must start with a lowercase letter, using only lowercase letters, digits, underscores and dashes after that, up to 64 characters.");
            return;
        }
        setBusy(true);
        setError("");
        try {
            const created = await createAgentInvite(bound);
            if (!mounted.current) return;
            setInvite(created);
            setAdding(false);
            setName("");
            void refresh();
        } catch (e) {
            if (mounted.current) setError(errorMessage(e));
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    return (
        <section className="agent-invites" aria-label="Agent invites">
            <Panel
                title="Agent invites"
                icon="key"
                aside={
                    <button type="button" className="btn primary sm" disabled={busy} aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
                        <Icon name="plus" sm />Create invite
                    </button>
                }
            >
                <p className="agent-invite-intro">A single-use invite lets a new agent connect.</p>
                {adding && (
                    <form className="agent-invite-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
                        <label>
                            <span>Agent name</span>
                            <input
                                type="text"
                                className="mono"
                                autoFocus
                                value={name}
                                placeholder="e.g. note-taker"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                disabled={busy}
                                onChange={(e) => setName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
                                }}
                            />
                        </label>
                        <div className="agent-invite-form-actions">
                            <button type="submit" className="btn primary sm" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create invite"}</button>
                            <Btn kind="quiet" sm disabled={busy} onClick={() => { setAdding(false); setName(""); setError(""); }}>Cancel</Btn>
                        </div>
                    </form>
                )}
                {error && (
                    <div style={PAD}>
                        <Err>{error}</Err>
                    </div>
                )}
                {invite ? (
                    <div className="agent-invite-created">
                        <div className="agent-invite-uri">
                            <code className="mono">MIMI_INVITE={invite.uri}</code>
                            <CopyTextButton text={`MIMI_INVITE=${invite.uri}`} label="Copy invite line" />
                        </div>
                        <p className="agent-invite-help">
                            Put this line in the agent’s <code>.env</code> and start the agent. The invite works once and expires in 24 hours.
                        </p>
                    </div>
                ) : !adding && !error && invites.length === 0 && (
                    <Empty icon="key" title="No invite yet">Create an invite to connect your first agent.</Empty>
                )}
                {invites.length > 0 && (
                    <div className="agent-invite-list">
                        <div className="dim3 t-xs" style={{ padding: "4px 0" }}>Active invites. Each works once; cancel any you no longer need.</div>
                        {invites.map((row) => (
                            <KvRow
                                key={row.id}
                                lead={<Dot state="degraded" />}
                                name={<span className="mono">{row.name}</span>}
                                sub={<span className="dim3 t-xs">expires {when(row.expiresAt)}</span>}
                                actions={
                                    <Btn kind="danger" sm disabled={canceling === row.id} onClick={() => void cancel(row)}>
                                        {canceling === row.id ? "Canceling…" : "Cancel"}
                                    </Btn>
                                }
                            />
                        ))}
                    </div>
                )}
            </Panel>
        </section>
    );
}


const PIN_DOT = { approved: "ok", blocked: "down" } as const;
const PIN_TONE = { approved: "ok", blocked: "bad" } as const;
const PIN_LABEL = { approved: "Approved", blocked: "Blocked" } as const;

const PERM_LABEL: Record<keyof PinPerms, string> = {
    delegate: "Can call other agents",
    discoverable: "Visible to other agents",
};

const flipPerm = (perms: PinPerms, key: keyof PinPerms): Partial<PinPerms> =>
    ({ [key]: !perms[key] }) as Partial<PinPerms>;

// a blocked row steps back to ink-3
const BLOCKED: CSSProperties = { color: "var(--ink-3)" };

function AgentRow({
    pin,
    busy,
    onPatch,
    onBlock,
    onRevoke,
    onModels,
}: {
    pin: PinCard;
    busy: boolean;
    onPatch: (perms: Partial<PinPerms>) => void;
    onBlock: () => void;
    onRevoke: () => void;
    onModels?: ((agent: string) => void) | undefined;
}): ReactElement {
    return (
        <div style={pin.status === "blocked" ? BLOCKED : undefined}>
            <KvRow
                lead={<Dot state={PIN_DOT[pin.status]} />}
                name={
                    <>
                        {pin.name}
                        {pin.connected && (
                            <span className="dim3" style={{ fontWeight: 400 }}>
                                {" · connected"}
                            </span>
                        )}
                    </>
                }
                sub={
                    <div style={{ display: "grid", gap: 4 }}>
                        <span className="mono">{pin.fingerprint}</span>
                        <span className="dim3 t-xs">
                            {`pinned ${when(pin.pinnedAt)} · `}
                            {pin.lastSeen ? `last seen ${when(pin.lastSeen)}` : "not seen yet"}
                            {pin.lastFrom ? ` · from ${pin.lastFrom}` : ""}
                        </span>
                        <div className="t-sm" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                            {(Object.keys(PERM_LABEL) as (keyof PinPerms)[]).map((k) => (
                                <label
                                    key={k}
                                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={pin.perms[k]}
                                        disabled={busy}
                                        onChange={() => onPatch(flipPerm(pin.perms, k))}
                                    />
                                    {PERM_LABEL[k]}
                                </label>
                            ))}
                        </div>
                        {onModels && (
                            <span className="dim3 t-xs">
                                Which models it may use: <button type="button" className="link" onClick={() => onModels(pin.name)}>{pin.name} settings</button>
                            </span>
                        )}
                    </div>
                }
                actions={
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Pill tone={PIN_TONE[pin.status]}>{PIN_LABEL[pin.status]}</Pill>
                        {pin.status !== "blocked" && (
                            <Btn sm disabled={busy} onClick={onBlock}>
                                Block
                            </Btn>
                        )}
                        <Btn kind="danger" sm disabled={busy} onClick={onRevoke}>
                            Revoke
                        </Btn>
                    </div>
                }
            />
        </div>
    );
}

// one /api/pins read behind the access tab
interface PinsView {
    pins: PinCard[] | null;
    loading: boolean;
    error: string;
    reload: () => Promise<void>;
    busy: ReadonlySet<string>;
    patch: (pin: PinCard, perms: Partial<PinPerms>) => void;
    block: (pin: PinCard) => void;
    revoke: (pin: PinCard) => void;
}

function usePins(): PinsView {
    const [pins, setPins] = useState<PinCard[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const request = useRef(0);
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
    const dialog = useDialog();
    const toast = useToast();

    const reload = useCallback(async (): Promise<void> => {
        const id = ++request.current;
        setLoading(true);
        setError("");
        try {
            const rows = await listPins();
            if (id === request.current) setPins(rows);
        } catch (e) {
            if (id === request.current) setError(errorMessage(e, "Could not load access settings."));
        } finally {
            if (id === request.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload();
        // The shell and access panel refresh together when admission changes.
        const onPins = (): void => void reload();
        window.addEventListener("mimi:pins-changed", onPins);
        window.addEventListener("mimi:agent-changed", onPins);
        window.addEventListener("mimi:resync", onPins);
        return () => {
            request.current++;
            window.removeEventListener("mimi:pins-changed", onPins);
            window.removeEventListener("mimi:agent-changed", onPins);
            window.removeEventListener("mimi:resync", onPins);
        };
    }, [reload]);

    const withBusy = useCallback(
        (name: string, fn: () => Promise<void>): void => {
            setBusy((b) => new Set(b).add(name));
            void (async () => {
                try {
                    await fn();
                    window.dispatchEvent(new CustomEvent("mimi:pins-changed"));
                    await reload();
                } catch (e) {
                    toast(errorMessage(e));
                } finally {
                    setBusy((b) => {
                        const next = new Set(b);
                        next.delete(name);
                        return next;
                    });
                }
            })();
        },
        [reload, toast],
    );

    const ask = (
        pin: PinCard,
        options: Parameters<typeof dialog.confirm>[0],
        fn: () => Promise<unknown>,
    ): void => {
        void (async () => {
            if (!(await dialog.confirm(options))) return;
            withBusy(pin.name, async () => {
                await fn();
            });
        })();
    };

    return {
        pins,
        loading,
        error,
        reload,
        busy,
        patch: (pin, perms) =>
            withBusy(pin.name, async () => {
                await patchPinPerms(pin.name, perms);
            }),
        block: (pin) =>
            ask(
                pin,
                {
                    title: `Block “${pin.name}”?`,
                    body: "The live session ends at once, and this key no longer gets in. The pin stays, so the decision stays visible and can be lifted.",
                    ok: "Block",
                    danger: true,
                },
                () => blockPin(pin.name),
            ),
        revoke: (pin) =>
            ask(
                pin,
                {
                    title: `Revoke “${pin.name}”?`,
                    body: "The pin disappears and the agent can no longer connect until it redeems a new agent invite.",
                    ok: "Revoke",
                    danger: true,
                },
                () => revokePin(pin.name),
            ),
    };
}

// a failed read is not repeated here: one banner, hoisted to the tab
function AgentPinsPanel({
    view,
    onModels,
}: {
    view: PinsView;
    onModels?: ((agent: string) => void) | undefined;
}): ReactElement {
    const rows = view.pins ?? [];
    return (
        <Panel
            title="Agents"
            icon="key"
            aside={
                rows.length > 0 ? (
                    <span className="dim3 t-xs">
                        {rows.length} {plural(rows.length, "agent", "agents")}
                    </span>
                ) : undefined
            }
        >
            <div className="dim3" style={NOTE}>
                Manage which agents can connect and how they can communicate with each other.
            </div>
            {view.pins === null && view.loading && [0, 1, 2].map((n) => (
                <div key={n} aria-hidden="true">
                    <KvRow
                        lead={<Skeleton className="dot round" w={7} h={7} />}
                        name={<Skeleton className="inline" h={11} w={`${34 - n * 5}%`} />}
                        sub={
                            <div style={{ display: "grid", gap: 4 }}>
                                <span className="mono"><Skeleton className="inline" h={9} w={`${62 - n * 6}%`} /></span>
                                <span className="t-xs"><Skeleton className="inline" h={9} w={`${46 - n * 5}%`} /></span>
                                <span className="t-sm"><Skeleton className="inline" h={10} w="52%" /></span>
                                <span className="t-xs"><Skeleton className="inline" h={9} w="70%" /></span>
                            </div>
                        }
                    />
                </div>
            ))}
            {view.pins !== null && rows.length === 0 && (
                <div style={PAD}>
                    <Empty>No agents connected yet. Create an invite above to get started.</Empty>
                </div>
            )}
            {rows.map((p) => (
                <AgentRow
                    key={p.name}
                    pin={p}
                    busy={view.busy.has(p.name)}
                    onPatch={(perms) => view.patch(p, perms)}
                    onBlock={() => view.block(p)}
                    onRevoke={() => view.revoke(p)}
                    onModels={onModels}
                />
            ))}
        </Panel>
    );
}

function AccessTab({
    onModels,
    onChat,
}: {
    onModels?: ((agent: string) => void) | undefined;
    onChat?: ((agent: string, id: number) => void) | undefined;
}): ReactElement {
    const view = usePins();
    return (
        <>
            <ApprovalRequests onOpenChat={onChat} />
            <PairedDevices />
            {view.error && (
                <Err>
                    {view.error}{" "}
                    <Btn sm disabled={view.loading} onClick={() => void view.reload()}>Retry</Btn>
                </Err>
            )}
            <AgentInvitesPanel />
            <AgentPinsPanel view={view} onModels={onModels} />
        </>
    );
}


const THEMES: readonly { v: ThemeChoice; t: string }[] = [
    { v: "system", t: "System" },
    { v: "light", t: "Light" },
    { v: "dark", t: "Dark" },
];

function InstancePanel(): ReactElement {
    const [choice, setChoice] = useState<ThemeChoice>(themeChoice);
    const [notifyOn, setNotifyOn] = useState(notifyEnabled);
    const [devOn, setDevOn] = useState(devDetails);
    const [perm, setPerm] = useState<NotificationPermission | "unsupported">(() =>
        typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    );
    const [pushOn, setPushOn] = useState(pushEnabled);
    const [pushBusy, setPushBusy] = useState(false);
    const toast = useToast();
    const mounted = useMounted();
    const inTauri = tauriInvoke() !== null;

    const switchPush = async (on: boolean): Promise<void> => {
        setPushBusy(true);
        try {
            await setPush(on);
            if (mounted.current) setPushOn(on);
        } catch (e) {
            toast(errorMessage(e));
        } finally {
            if (mounted.current) setPushBusy(false);
        }
    };

    const setNotify = (on: boolean): void => {
        try {
            localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
        } catch {
            // private mode: the toggle still works for this page's lifetime
        }
        setNotifyOn(on);
    };

    useEffect(() => {
        const onTheme = (): void => setChoice(themeChoice());
        window.addEventListener("mimi:theme", onTheme);
        return () => window.removeEventListener("mimi:theme", onTheme);
    }, []);

    return (
        <Panel title="This device" icon="settings">
            <KvRow
                name="Theme"
                sub={
                    <>
                        Choose a light or dark workspace, or match your device automatically.
                        <Where>Your preference is saved in this browser.</Where>
                    </>
                }
                actions={
                    <div className="seg">
                        {THEMES.map((t) => (
                            <button
                                key={t.v}
                                type="button"
                                className={t.v === choice ? "on" : ""}
                                aria-pressed={t.v === choice}
                                onClick={() => {
                                    setChoice(t.v);
                                    applyTheme(t.v);
                                }}
                            >
                                {t.t}
                            </button>
                        ))}
                    </div>
                }
            />
            <KvRow
                name="System notifications"
                sub={
                    <>
                        {androidApp
                            ? "System alerts for approvals, questions, Inbox items and device requests while the app is in the background."
                            : `System alerts for approvals, questions, finished replies, Inbox items and device requests while ${inTauri
                                ? "the window is in the background or, on a Mac, closed to the Dock"
                                : "this tab is hidden or its window is in the background"}.`}{" "}
                        In-app toasts are always on.
                        <Where>
                            {inTauri
                                ? (androidApp ? "Delivered through the app" : "Delivered through the desktop app")
                                : perm === "unsupported"
                                  ? "This browser does not support notifications"
                                  : perm === "denied"
                                    ? "Blocked by the browser. Allow notifications for this site to turn them on"
                                    : `Browser permission: ${perm}`}
                        </Where>
                    </>
                }
                {...(!inTauri && (perm === "unsupported" || perm === "denied")
                    ? {}
                    : !inTauri && perm === "default"
                      ? {
                            actions: (
                                <Btn
                                    kind="quiet"
                                    sm
                                    icon="bell"
                                    onClick={() =>
                                        void Notification.requestPermission().then((p) => {
                                            setPerm(p);
                                            if (p === "granted") setNotify(true);
                                        })
                                    }
                                >
                                    Turn on
                                </Btn>
                            ),
                        }
                      : {
                            actions: (
                                <div className="seg">
                                    <button
                                        type="button"
                                        className={notifyOn ? "on" : ""}
                                        onClick={() => setNotify(true)}
                                    >
                                        On
                                    </button>
                                    <button
                                        type="button"
                                        className={notifyOn ? "" : "on"}
                                        onClick={() => setNotify(false)}
                                    >
                                        Off
                                    </button>
                                </div>
                            ),
                        })}
            />
            {androidApp && (
                <KvRow
                    name="Phone notifications"
                    sub={
                        <>
                            A notification when something needs you while the app is closed. It never says what: the app
                            shows that once you open it.
                            <Where>Sent through Google's Firebase</Where>
                        </>
                    }
                    actions={
                        <div className="seg">
                            <button type="button" className={pushOn ? "on" : ""} disabled={pushBusy} onClick={() => void switchPush(true)}>On</button>
                            <button type="button" className={pushOn ? "" : "on"} disabled={pushBusy} onClick={() => void switchPush(false)}>Off</button>
                        </div>
                    }
                />
            )}
            <KvRow
                name="Developer details"
                sub="Show each reply's model trace and where older messages were summarized. Off keeps the thread uncluttered."
                actions={
                    <div className="seg">
                        <button type="button" className={devOn ? "on" : ""} onClick={() => { setDevDetails(true); setDevOn(true); }}>On</button>
                        <button type="button" className={devOn ? "" : "on"} onClick={() => { setDevDetails(false); setDevOn(false); }}>Off</button>
                    </div>
                }
            />
            {inTauri && (
                <KvRow
                    name="Reload"
                    sub="Loads the app again, as a fresh start would. Your chats and settings stay."
                    actions={<Btn kind="quiet" sm icon="refresh" onClick={() => location.reload()}>Reload</Btn>}
                />
            )}
        </Panel>
    );
}


// a probe can take seconds against a busy gateway, so "checking" is a state of its own
type Probe = { state: "running" } | ({ state: "done" } & GatewayProbe);

function ConnectionSection(): ReactElement {
    const snap = useSyncExternalStore(subscribe, getSnapshot);
    const [probe, setProbe] = useState<Probe | null>(null);
    const dialog = useDialog();
    const ready = snap.state === "ready";

    const check = async (): Promise<void> => {
        setProbe({ state: "running" });
        setProbe({ state: "done", ...(await pingGateway()) });
    };
    const cleanAndForget = async (): Promise<void> => {
        const yes = await dialog.confirm({
            title: "Clean and forget?",
            body: "This device drops its paired identity and every saved gateway URL. You will pair again with a fresh invite.",
            ok: "Clean and forget",
            danger: true,
        });
        if (yes) forgetDevice();
    };

    const probeText =
        probe === null
            ? ""
            : probe.state === "running"
              ? " · Checking…"
              : probe.ok
                ? ` · Answered in ${probe.ms} ms with ${probe.agents ?? 0} agents`
                : ` · Did not answer (${probe.error ?? "no explanation"})`;

    return (
        <>
            <Panel title="Gateway" icon="settings">
                <KvRow
                    lead={<Dot state={ready ? "ok" : snap.state === "connecting" ? "degraded" : "down"} />}
                    name={ready ? "Online" : snap.state === "incompatible" ? "Needs an update" : snap.state === "reconnecting" ? "Offline. Retrying" : "Connecting…"}
                    sub={snap.state === "incompatible" ? (
                        <>
                            {snap.peer === undefined ? "The gateway speaks a different protocol version" : `The gateway speaks protocol ${snap.peer}`}, this app
                            speaks {PROTOCOL_VERSION}. Update the gateway and the app together. This app checks again on its own.
                        </>
                    ) : (
                        <><span className="mono">{gatewayAddress()}</span>{probeText}</>
                    )}
                    actions={snap.state === "incompatible"
                        ? <Btn kind="quiet" sm icon="refresh" onClick={() => recheckProtocol()}>Retry</Btn>
                        : <Btn kind="quiet" sm icon="refresh" disabled={probe?.state === "running"} title="A real request to /api/agents" onClick={() => void check()}>Check</Btn>}
                />
                <div className="conn-block">
                    <p>URLs that reach this gateway. Switching keeps the same pairing.</p>
                    <ConnectionList />
                </div>
            </Panel>
            <Panel title="Pairing" icon="key">
                <KvRow
                    name="Clean and forget"
                    sub="This device drops its paired identity and every saved gateway URL, and pairs again with a fresh invite."
                    actions={<Btn kind="danger" sm onClick={() => void cleanAndForget()}>Clean and forget</Btn>}
                />
            </Panel>
        </>
    );
}


interface SettingsProps {
    /** The shell's dashboard snapshot; null before the first answer. */
    snap: DashboardSnapshot | null;
    /** Why the last snapshot read failed; the shell keeps the previous snapshot regardless. */
    snapError: string;
    /** Pending gates from /approvals, which knows a gate's chat. */
    approvals: readonly ApprovalSummary[];
    /** The section the URL names; none is the index, which a desktop shows beside the last section. */
    section?: SettingsSection | undefined;
    wide: boolean;
    /** Devices waiting for approval, read by the shell for the bar. */
    waiting: number;
    onSection: (section: SettingsSection) => void;
    onGate?: ((gate: ApprovalSummary) => void) | undefined;
    onAgent?: ((agent: string) => void) | undefined;
    onChat?: ((agent: string, id: number) => void) | undefined;
    onModels?: ((agent: string) => void) | undefined;
}

function Settings({ snap, snapError, approvals, section, wide, waiting, onSection, onGate, onAgent, onChat, onModels }: SettingsProps): ReactElement {
    const { state } = useSyncExternalStore(subscribe, getSnapshot);
    const current = section ?? (wide ? lastSettings() : undefined);
    const title = SETTINGS_INDEX.find((s) => s.v === current)?.label ?? "Settings";
    const needs = (snap?.agents.filter((a) => a.status === "approved" && a.health === "down").length ?? 0) + approvals.length;
    // each row's live value, where a glance at it saves opening the section
    const values: Partial<Record<SettingsSection, ReactNode>> = {
        connection: (
            <span className="settings-value">
                <Dot state={state === "ready" ? "ok" : state === "connecting" ? "degraded" : "down"} />
                {state === "ready" ? "online" : state === "incompatible" ? "needs an update" : state === "reconnecting" ? "offline" : "connecting"}
            </span>
        ),
        access: waiting > 0 && <span className="settings-value warn">{waiting} waiting</span>,
        health: needs > 0 && <span className="settings-value warn">{needs} {plural(needs, "needs", "need")} you</span>,
        usage: snap && <span className="settings-value">{kilo(snap.today.tokens)} today</span>,
    };

    return (
        <div className="view settings">
            <header className="head">
                {!wide && section !== undefined && <BackButton />}
                <div className="head-main">
                    <h1 className="head-title">{wide ? "Settings" : title}</h1>
                    <ConnLine />
                </div>
            </header>
            <div className="settings-body">
                {/* a phone pushes a section over the index; a desktop keeps both */}
                {(wide || section === undefined) && (
                    <nav className="settings-index scroll" aria-label="Settings sections">
                        {[...new Set(SETTINGS_INDEX.map((s) => s.group))].map((group) => (
                            <div key={group} className="settings-group" role="group" aria-label={group}>
                                {SETTINGS_INDEX.filter((s) => s.group === group).map((s) => (
                                    <button key={s.v} type="button" className="settings-row" aria-current={s.v === current ? "page" : undefined}
                                        title={s.hint} onClick={() => onSection(s.v)}>
                                        <span className="settings-label">{s.label}</span>
                                        {values[s.v]}
                                        <Icon name="chevron" sm />
                                    </button>
                                ))}
                            </div>
                        ))}
                    </nav>
                )}
                {current && (
                    <section className="scroll settings-pane" aria-label={title}>
                        <div className="page">
                            {wide && <h2 className="settings-title">{title}</h2>}
                            {current === "connection" && <ConnectionSection />}
                            {current === "models" && <ModelsPanel />}
                            {current === "limits" && <LimitsPanel />}
                            {current === "access" && <AccessTab onModels={onModels} onChat={onChat} />}
                            {current === "health" && <HealthPanel snap={snap} snapError={snapError} approvals={approvals} onAgent={onAgent} onGate={onGate} />}
                            {current === "usage" && <UsagePanel />}
                            {current === "device" && <InstancePanel />}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}

export default memo(Settings);
