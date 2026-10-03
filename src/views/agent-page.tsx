// One agent: its chats, its published interfaces and its settings.
import { lazy, memo, Suspense, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactElement } from "react";

import { clearAgentCache, patchPinPerms, resumeAgent, stopAgent, type AgentSummary, type ConversationInfo, type Health, type PinPerms } from "../api.ts";
import type { ApprovalSummary } from "../approval-api.ts";
import { agentState, refreshAgent, useChats } from "../agent-chats.ts";
import { useInterfaces } from "../app-api.ts";
import { ChatRow } from "../components/chat-row.tsx";
import { useDialog } from "../components/dialog.tsx";
import { Icon } from "../components/icon.tsx";
import { Menu } from "../components/menu.tsx";
import { ConnLine } from "../components/nav-bar.tsx";
import { useToast } from "../components/toast.tsx";
import { AgentMark, BackButton, Btn, Empty, LoadBoundary } from "../components/ui.tsx";
import { go, holdBack, releaseBack, type AgentTab } from "../route.ts";
import { errorMessage, Err, isDelegation, plural, useMounted } from "../shared.ts";
import { androidApp } from "../tauri.ts";
import { CallsTab } from "./chat.tsx";
import "../agent-page.css";

const AgentModels = lazy(() => import("./agent-models.tsx"));
const InterfacesTab = lazy(() => import("./interfaces.tsx"));

const TAB_LABEL: Record<AgentTab, string> = { chats: "Chats", interfaces: "Interfaces", settings: "Settings" };
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface AgentPageProps {
    agent: string;
    me: AgentSummary;
    health?: Health | undefined;
    why?: string | undefined;
    approvals: readonly ApprovalSummary[];
    tab: AgentTab;
    app?: string | undefined;
    appRoute?: string | undefined;
    nav: number;
}

function AgentPageView({ agent, me, health, why, approvals, tab: asked, app, appRoute, nav }: AgentPageProps): ReactElement {
    // a link to an interface lands on Chats in the Android app, where mini-apps do not run yet
    const tab = androidApp && asked === "interfaces" ? "chats" : asked;
    const dialog = useDialog();
    const toast = useToast();
    // replies that land after the owner left this agent must not write state
    const mounted = useMounted();
    const { rows, stale, error } = useChats(agent);
    const interfaces = useInterfaces(agent, me.connected);
    const [menu, setMenu] = useState<HTMLElement | null>(null);
    const [calls, setCalls] = useState(false);
    const [query, setQuery] = useState("");
    // the list fades in only when it replaced a skeleton, and only that once: a tab switch back must not replay it
    const [waited, setWaited] = useState(rows === null);
    // optimistic until the registry catches up; null defers to the server, which wins even when it says the opposite
    const [pausedOpt, setPausedOpt] = useState<boolean | null>(null);
    useEffect(() => setPausedOpt(null), [me.paused]);
    const paused = pausedOpt ?? me.paused;
    const [perms, setPerms] = useState<PinPerms>(me.perms);
    useEffect(() => setPerms(me.perms), [me.perms]);
    // mounted on first visit and then only hidden, so a launched interface survives a tab switch
    const [interfacesSeen, setInterfacesSeen] = useState(tab === "interfaces");
    if (tab === "interfaces" && !interfacesSeen) setInterfacesSeen(true);
    // a plain switch back to Interfaces names no page, so the last link stays in force
    const [link, setLink] = useState({ app, appRoute, nav });
    if ((app !== undefined || appRoute !== undefined) && (app !== link.app || appRoute !== link.appRoute || nav !== link.nav)) setLink({ app, appRoute, nav });
    const modal = useRef<HTMLDivElement | null>(null);
    const callsTitle = useId();

    useEffect(() => {
        if (!calls) return undefined;
        const hold = holdBack(() => setCalls(false));
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        (modal.current?.querySelector<HTMLElement>(FOCUSABLE) ?? modal.current)?.focus();
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setCalls(false);
        };
        window.addEventListener("keydown", onKey, true);
        return () => {
            releaseBack(hold);
            window.removeEventListener("keydown", onKey, true);
            if (opener?.isConnected) opener.focus({ preventScroll: true });
        };
    }, [calls]);

    const clearCache = async (): Promise<void> => {
        try {
            const r = await clearAgentCache(agent);
            toast(r.cleared ? `Dropped ${r.cleared} cached ${plural(r.cleared, "session", "sessions")}. The next turn reads fresh.` : "Nothing was cached.");
        } catch (e) {
            toast(errorMessage(e));
        }
    };

    const stop = async (): Promise<void> => {
        const sure = await dialog.confirm({
            title: `Stop ${agent}?`,
            body: `Every turn ${agent} is running is cut off, in every chat, and it makes no model calls until you resume it. Nothing already written is deleted.`,
            ok: "Stop agent",
            danger: true,
        });
        if (!sure) return;
        setPausedOpt(true);
        try {
            await stopAgent(agent);
            // the busy rows died with the turns
            await refreshAgent(agent).catch(() => undefined);
        } catch (e) {
            // unknown what the server managed to do: drop the guess and wait for its answer
            if (mounted.current) setPausedOpt(null);
            toast(`Could not stop ${agent}. ${errorMessage(e)}`);
        }
    };

    const resume = async (): Promise<void> => {
        setPausedOpt(false);
        try {
            await resumeAgent(agent);
        } catch (e) {
            if (mounted.current) setPausedOpt(null);
            toast(`Could not resume ${agent}. ${errorMessage(e)}`);
        }
    };

    const setPerm = async (name: keyof PinPerms, value: boolean): Promise<void> => {
        const was = perms;
        setPerms({ ...perms, [name]: value });
        try {
            await patchPinPerms(agent, { [name]: value });
            window.dispatchEvent(new CustomEvent("mimi:pins-changed"));
        } catch (e) {
            if (mounted.current) setPerms(was);
            toast(errorMessage(e));
        }
    };

    const gated = approvals.some((a) => a.agent === agent);
    const state = agentState({ connected: me.connected, lastSeen: me.lastSeen, paused }, gated, rows?.some((c) => c.busy) ?? false);
    const gates = new Map(approvals.filter((a) => a.agent === agent && a.room === undefined && a.conversation !== undefined).map((a) => [a.conversation, a]));
    const tabs = (["chats", "interfaces", "settings"] as const).filter((t) => t !== "interfaces" || tab === t || (!androidApp && (interfaces.hasInterfaces === true || Boolean(interfaces.error))));

    const q = query.trim().toLocaleLowerCase();
    const matching = q ? (rows ?? []).filter((c) => (c.title ?? "untitled").toLocaleLowerCase().includes(q) || String(c.id).includes(q)) : (rows ?? []);
    const listed = matching.filter((c) => !c.archived && !isDelegation(c) && c.messages > 0);
    const pinned = listed.filter((c) => c.pinned);
    const recent = listed.filter((c) => !c.pinned);
    const delegated = matching.filter((c) => !c.archived && isDelegation(c));
    const archived = matching.filter((c) => c.archived);
    const list = (group: readonly ConversationInfo[]): ReactElement => (
        <ul className="chat-list">
            {group.map((c) => (
                <li key={c.id}>
                    <ChatRow agent={agent} chat={c} variant="full" open={false} gate={gates.get(c.id)} stale={stale && !me.connected} />
                </li>
            ))}
        </ul>
    );

    return (
        <div className="view agent-page">
            <header className="head page-head">
                <BackButton />
                <AgentMark agent={agent} size="lg" />
                <div className="head-main">
                    <h1 className="head-title">{agent}</h1>
                    <div className="head-sub" title={health && health !== "ok" ? why : undefined}>
                        <span className="page-desc">{me.description ?? me.model}</span>
                        <ConnLine>{state && <span className="state" data-tone={state.tone}>{state.word}</span>}</ConnLine>
                    </div>
                </div>
                <div className="head-acts">
                    {paused && <button type="button" className="btn sm page-resume" onClick={() => void resume()}>Resume</button>}
                    <button type="button" className="btn sm page-new" aria-label={`New chat with ${agent}`} title="New chat" onClick={() => go({ at: "new", agent })}>
                        <Icon name="plus" sm /><span>New chat</span>
                    </button>
                    <button type="button" className="btn icon" aria-label="Agent actions" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget)}>
                        <Icon name="more" />
                    </button>
                </div>
            </header>
            <nav
                className="tabs"
                role="tablist"
                aria-label={agent}
                onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const next = tabs[(tabs.indexOf(tab) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length] ?? "chats";
                    go(next === "chats" ? { at: "agent", agent } : { at: "agent", agent, tab: next }, { replace: true });
                    e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
                }}
            >
                {tabs.map((t) => (
                    <button
                        key={t}
                        type="button"
                        role="tab"
                        data-tab={t}
                        aria-selected={tab === t}
                        tabIndex={tab === t ? 0 : -1}
                        onClick={() => go(t === "chats" ? { at: "agent", agent } : { at: "agent", agent, tab: t }, { replace: true })}
                    >
                        {TAB_LABEL[t]}
                    </button>
                ))}
            </nav>

            <div className="scroll" role="tabpanel" aria-label={TAB_LABEL[tab]} hidden={tab === "interfaces"}>
                {tab === "chats" && (
                    <div className="chats-page">
                        <input type="search" className="chats-search" placeholder="Search chats" aria-label="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
                        {rows === null ? (
                            <ul className="chat-list skel-wait" aria-hidden="true">
                                {[0, 1, 2, 3, 4].map((n) => (
                                    <li key={n} className="chat-row" data-variant="full"><span className="skel" style={{ width: `${72 - n * 9}%`, marginLeft: 10 }} /></li>
                                ))}
                            </ul>
                        ) : (
                            <div className={waited ? "enter" : undefined} onAnimationEnd={(e) => { if (e.target === e.currentTarget) setWaited(false); }}>
                                {error && rows.length === 0 && <Err>{error}</Err>}
                                {!error && !q && listed.length === 0 && (
                                    <Empty actions={<Btn sm icon="plus" onClick={() => go({ at: "new", agent })}>New chat</Btn>}>
                                        {delegated.length > 0 || archived.length > 0 ? `No active chats with ${agent}.` : `No chats with ${agent} yet.`}
                                    </Empty>
                                )}
                                {q && matching.length === 0 && <Empty>No chats match “{query.trim()}”.</Empty>}
                                {pinned.length > 0 && <><h2 className="list-h">Pinned</h2>{list(pinned)}</>}
                                {recent.length > 0 && <><h2 className="list-h">Recent</h2>{list(recent)}</>}
                                {delegated.length > 0 && (
                                    <details className="list-fold" open={Boolean(q)}>
                                        <summary>Delegated · {delegated.length}</summary>
                                        {list(delegated)}
                                    </details>
                                )}
                                {archived.length > 0 && (
                                    <details className="list-fold" open={Boolean(q)}>
                                        <summary>Archived · {archived.length}</summary>
                                        {list(archived)}
                                    </details>
                                )}
                            </div>
                        )}
                    </div>
                )}
                {tab === "settings" && (
                    <div className="settings-page">
                        <section className="block">
                            <h2 className="block-h">Models</h2>
                            <p className="block-sub">Apply to every chat and model call from {agent}. Daily limits and prices belong to each model, in Settings, Limits & prices.</p>
                            <LoadBoundary>
                                <Suspense fallback={<span className="skel skel-wait" style={{ width: "60%" }} />}>
                                    <AgentModels agent={agent} />
                                </Suspense>
                            </LoadBoundary>
                        </section>
                        <section className="block">
                            <h2 className="block-h">Access</h2>
                            <label className="check">
                                <input type="checkbox" checked={perms.delegate} onChange={(e) => void setPerm("delegate", e.target.checked)} />
                                Can call other agents
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={perms.discoverable} onChange={(e) => void setPerm("discoverable", e.target.checked)} />
                                Visible to other agents
                            </label>
                            <p className="block-sub">
                                Keys, devices and blocking are in{" "}
                                <button type="button" className="link" onClick={() => go({ at: "settings", section: "access" })}>Settings, Access</button>.
                            </p>
                        </section>
                        <section className="block">
                            <h2 className="block-h">Session</h2>
                            <div className="block-row">
                                <div>
                                    <b>Clear session cache</b>
                                    <p className="block-sub">Drops what the gateway holds in memory for {agent}. The next turn reads from disk.</p>
                                </div>
                                <Btn sm onClick={() => void clearCache()}>Clear</Btn>
                            </div>
                            <div className="block-row">
                                <div>
                                    <b>{paused ? `Resume ${agent}` : `Stop ${agent}`}</b>
                                    <p className="block-sub">
                                        {paused
                                            ? `${agent} makes no model calls until you resume it.`
                                            : "Cuts off every turn it is running and stops its model calls until you resume it."}
                                    </p>
                                </div>
                                <Btn sm kind={paused ? "outline" : "danger"} onClick={() => void (paused ? resume() : stop())}>{paused ? "Resume" : "Stop…"}</Btn>
                            </div>
                        </section>
                    </div>
                )}
            </div>

            {interfacesSeen && (
                <div className="agent-apps" role="tabpanel" aria-label={TAB_LABEL.interfaces} hidden={tab !== "interfaces"}>
                    <LoadBoundary>
                        <Suspense fallback={<span className="skel skel-wait" style={{ width: 180, margin: 24 }} />}>
                            <InterfacesTab agent={agent} data={interfaces} initialApp={link.app} initialRoute={link.appRoute} navigationKey={link.nav} />
                        </Suspense>
                    </LoadBoundary>
                </div>
            )}

            {menu && (
                <Menu
                    label="Agent actions"
                    at={menu}
                    onClose={() => setMenu(null)}
                    items={[
                        { id: "calls", label: "Model call details", icon: "info", run: () => setCalls(true) },
                        { id: "cache", label: "Clear session cache", icon: "refresh", run: () => void clearCache() },
                        "sep",
                        paused
                            ? { id: "resume", label: "Resume agent", icon: "play", run: () => void resume() }
                            : { id: "stop", label: "Stop agent…", icon: "pause", danger: true, run: () => void stop() },
                    ]}
                />
            )}

            {calls && createPortal(
                <>
                    <div className="mback" onClick={() => setCalls(false)} />
                    <div ref={modal} className="modal" role="dialog" aria-modal="true" aria-labelledby={callsTitle} tabIndex={-1} onKeyDown={(e) => {
                        // browser chrome sits between last and first in tab order, so Tab wraps inside the dialog by hand
                        if (e.key !== "Tab") return;
                        const stops = [...(modal.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
                        const first = stops[0];
                        const last = stops.at(-1);
                        const at = document.activeElement;
                        if (!first || !last || !(e.shiftKey ? at === first || at === modal.current : at === last)) return;
                        e.preventDefault();
                        (e.shiftKey ? last : first).focus();
                    }}>
                        <div className="mhead">
                            <h2 id={callsTitle}>Model call details · {agent}</h2>
                            <Btn kind="quiet" sm icon="close" title="Close (Escape)" onClick={() => setCalls(false)} />
                        </div>
                        <div className="mbody"><CallsTab agent={agent} /></div>
                    </div>
                </>,
                document.body,
            )}
        </div>
    );
}

const AgentPage = memo(AgentPageView);
export default AgentPage;
