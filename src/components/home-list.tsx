// The one list of agents and their chats: the desktop sidebar, its folded rail, and the phone's Home screen; the bar of places under it is nav-bar.tsx.
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { AgentSummary } from "../api.ts";
import type { ApprovalSummary } from "../approval-api.ts";
import { agentLanding, agentState, HOME_MAX, homeChats, NO_CHATS, refreshAgent, useAgentChats } from "../agent-chats.ts";
// imported as a module so vite serves it under base "/app/"
import mascot from "../assets/mimi-mascot.png";
import { useFlip } from "../motion.ts";
import { gateRoute, go, type Route } from "../route.ts";
import { MOD, plural } from "../shared.ts";
import { androidApp, tauriInvoke } from "../tauri.ts";
import { ChatRow } from "./chat-row.tsx";
import { DesktopMenu } from "./desktop-menu.tsx";
import { Icon } from "./icon.tsx";
import { ConnLine } from "./nav-bar.tsx";
import { AgentMark, Btn, Countdown, Empty } from "./ui.tsx";

interface HomeListProps {
    agents: readonly AgentSummary[] | null;
    error: string;
    approvals: readonly ApprovalSummary[];
    route: Route | null;
    /** Desktop only: the 56px rail. */
    folded: boolean;
    onFold: () => void;
    onSearch: () => void;
    /** Picks the agent for a new chat when the rail has none in view. */
    onNewChat: () => void;
    onRetry: () => void;
}

// agents whose chat rows the owner folded away on this device
const COLLAPSED_KEY = "mimi-os:collapsed";

/** One agent's rows as they were when the mouse came in, with the pinned ids they held then. */
interface Held {
    pins: string;
    order: readonly number[];
}

function HomeList({ agents, error, approvals, route, folded, onFold, onSearch, onNewChat, onRetry }: HomeListProps): ReactElement {
    const chats = useAgentChats();
    const scroll = useRef<HTMLDivElement | null>(null);
    const listId = useId();
    // while the mouse is over the list, recency moves wait, so a row about to be clicked stays put; a pin or unpin shows at once
    const [frozen, setFrozen] = useState<ReadonlyMap<string, Held> | null>(null);
    // the list fades in once, when it replaces the skeleton
    const [fresh, setFresh] = useState(agents === null);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
        try {
            const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
            return new Set(Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : []);
        } catch {
            return new Set();
        }
    });
    // chat rows the list has room for, measured on resize and when the agents change, never on a data change, so a streaming reply cannot move the list
    const [room, setRoom] = useState(0);
    const native = tauriInvoke() !== null && !androidApp;

    const needs = approvals.toSorted((a, b) => a.deadline - b.deadline);
    const gateByChat = new Map<string, ApprovalSummary>();
    for (const a of needs) {
        const key = `${a.agent}#${a.conversation}`;
        if (a.room === undefined && a.conversation !== undefined && !gateByChat.has(key)) gateByChat.set(key, a);
    }
    const open = route?.at === "chat" ? route : null;
    const named = route?.at === "chat" || route?.at === "new" || route?.at === "agent" ? route.agent : null;

    const loads = (agents ?? []).map((me) => {
        const entry = chats.get(me.name) ?? NO_CHATS;
        const openId = open?.agent === me.name ? open.id : undefined;
        return { me, entry, openId, shut: collapsed.has(me.name), wants: homeChats(entry.rows ?? [], openId, HOME_MAX).shown.length };
    });
    // the rows that fit, shared out: the agent wanting fewest goes first, and whatever it leaves passes to the rest
    const limits = new Map<string, number>();
    const sharing = loads.filter((l) => !l.shut).toSorted((a, b) => a.wants - b.wants);
    let left = room;
    sharing.forEach(({ me, wants }, i) => {
        const limit = Math.min(HOME_MAX, Math.max(3, Math.floor(left / (sharing.length - i))));
        limits.set(me.name, limit);
        left -= Math.min(limit, wants);
    });

    const groups = loads.map(({ me, entry, openId, shut }) => {
        const home = homeChats(entry.rows ?? [], openId, limits.get(me.name));
        // a collapsed agent keeps only the chat on screen
        const live = shut ? home.shown.filter((c) => c.id === openId) : home.shown;
        const pins = live.filter((c) => c.pinned).map((c) => c.id).join(" ");
        const held = frozen?.get(me.name);
        const rows = held?.pins === pins
            ? [...held.order.flatMap((id) => live.find((c) => c.id === id) ?? []), ...live.filter((c) => !held.order.includes(c.id))]
            : live;
        const state = agentState(me, approvals.some((g) => g.agent === me.name), entry.rows?.some((c) => c.busy) ?? false);
        return { me, entry, rows, pins, shut, total: home.total, hidden: home.hidden, state };
    });
    // a pin or unpin under a still mouse takes the new order at once and holds that one instead
    if (frozen && groups.some((g) => frozen.has(g.me.name) && frozen.get(g.me.name)?.pins !== g.pins)) {
        setFrozen(new Map(groups.map((g) => [g.me.name, { pins: g.pins, order: g.rows.map((c) => c.id) }])));
    }
    // the same keys whether folded or not, so unfolding the rail never replays the rows
    useFlip(scroll, groups.flatMap(({ me, rows }) => rows.map((c) => `${me.name}#${c.id}`)).join(" "));

    // native listeners: React's enter and leave follow portals, so a menu opened from a row would count as still inside the list
    const shown = useRef(groups);
    useLayoutEffect(() => {
        shown.current = groups;
    });
    useEffect(() => {
        const el = scroll.current;
        if (!el || folded) return;
        const enter = (e: PointerEvent): void => {
            if (e.pointerType === "mouse") setFrozen(new Map(shown.current.map((g) => [g.me.name, { pins: g.pins, order: g.rows.map((c) => c.id) }])));
        };
        const leave = (): void => setFrozen(null);
        el.addEventListener("pointerenter", enter);
        el.addEventListener("pointerleave", leave);
        return () => {
            el.removeEventListener("pointerenter", enter);
            el.removeEventListener("pointerleave", leave);
        };
    }, [folded]);

    const names = (agents ?? []).map((a) => a.name).join(" ");
    const shutNames = [...collapsed].join(" ");
    const loaded = agents !== null && agents.every((a) => chats.get(a.name)?.rows);
    useLayoutEffect(() => {
        const el = scroll.current;
        if (!el || folded) return;
        const measure = (): void => {
            // a hidden list (the phone's Home under a pushed screen) is measured again when it shows
            if (el.clientHeight === 0) return;
            const style = getComputedStyle(el);
            const rowHeight = parseFloat(style.getPropertyValue("--row-h"));
            const top = el.getBoundingClientRect().top - el.scrollTop;
            const end = (el.lastElementChild?.getBoundingClientRect().bottom ?? top) - top + parseFloat(style.paddingBottom);
            // the rows now shown plus the free height below them, less nothing else: headings and agent rows stay where they are
            const rows = el.querySelectorAll(".agent:not([data-shut]) [data-flip], .chat-skel").length;
            if (rowHeight > 0) setRoom(rows + Math.floor((el.clientHeight - end) / rowHeight));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [folded, names, shutNames, loaded]);

    const toggleShut = (name: string): void => {
        const next = new Set(collapsed);
        if (!next.delete(name)) next.add(name);
        setCollapsed(next);
        try {
            if (next.size === 0) localStorage.removeItem(COLLAPSED_KEY);
            else localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
        } catch {
            // private mode: the agent still folds, it just forgets
        }
    };
    if (folded) {
        const first = needs[0];
        const railAgent = named ?? (groups.length === 1 ? groups[0]?.me.name : undefined);
        return (
            <nav className="home rail" aria-label="Agents">
                <header className="home-head">
                    <button type="button" className="btn icon" aria-label="Show the sidebar" title={`Show the sidebar (${MOD}B)`} onClick={onFold}>
                        <img className="home-mascot" src={mascot} alt="" />
                    </button>
                </header>
                <button type="button" className="btn icon rail-jump" aria-label="Jump to" title={`Jump to (${MOD}K)`} onClick={onSearch}>
                    <Icon name="search" />
                </button>
                {/* the agent in view, the only one, or a pick from the palette: a new chat without unfolding the sidebar */}
                <button type="button" className="btn icon rail-jump" aria-label={railAgent ? `New chat with ${railAgent}` : "New chat"}
                    title={railAgent ? `New chat with ${railAgent}` : "New chat"} onClick={() => (railAgent ? go({ at: "new", agent: railAgent }) : onNewChat())}>
                    <Icon name="plus" />
                </button>
                <div className="home-scroll" ref={scroll}>
                    {first && (
                        <button type="button" className="rail-needs" aria-label={`${needs.length} waiting for you`} title="Needs you"
                            onClick={() => go(gateRoute(first.agent, first.room, first.conversation, first.gate))}>
                            <span className="count warn">{needs.length}</span>
                        </button>
                    )}
                    {groups.map(({ me, state }) => {
                        const label = state ? `${me.name}, ${state.word}` : me.name;
                        return (
                            <button key={me.name} type="button" className="rail-agent" aria-current={named === me.name ? "page" : undefined}
                                aria-label={label} title={label} onClick={() => go(agentLanding(me.name, approvals))}>
                                <AgentMark agent={me.name} />
                                {state && <span className="dot" data-tone={state.tone} />}
                            </button>
                        );
                    })}
                </div>
            </nav>
        );
    }

    return (
        <nav className="home" aria-label="Agents and chats">
            <header className="home-head">
                {native ? <DesktopMenu brand /> : (
                    <span className="home-brand"><img className="home-mascot" src={mascot} alt="" /><span className="wm">mimi-os</span></span>
                )}
                <button type="button" className="btn icon home-search" aria-label="Search" onClick={onSearch}><Icon name="search" /></button>
                <button type="button" className="btn icon home-fold" aria-label="Hide the sidebar" title={`Hide the sidebar (${MOD}B)`} onClick={onFold}>
                    <Icon name="back" sm />
                </button>
            </header>
            <button type="button" className="home-jump" onClick={onSearch}>
                <Icon name="search" sm /><span>Jump to…</span><kbd>{MOD}K</kbd>
            </button>
            <ConnLine />
            <div className="home-scroll" ref={scroll}>
                {needs.length > 0 && (
                    <section className="home-sec needs" aria-label="Needs you">
                        <h2 className="home-h">Needs you<span className="count warn">{needs.length}</span></h2>
                        {needs.map((a) => {
                            const inChat = a.room === undefined && a.conversation !== undefined;
                            const title = inChat ? chats.get(a.agent)?.rows?.find((c) => c.id === a.conversation)?.title ?? "Untitled" : a.kind === "question" ? "Answer in Inbox" : "Review in Inbox";
                            return (
                                <button key={a.gate} type="button" className="need" onClick={() => go(gateRoute(a.agent, a.room, a.conversation, a.gate))}>
                                    <span className="need-title">{title}</span>
                                    <Countdown deadline={a.deadline} />
                                    <span className="need-sub">{a.agent} · {a.label}</span>
                                </button>
                            );
                        })}
                    </section>
                )}
                <section className="home-sec" aria-label="Agents">
                    <h2 className="vh">Agents</h2>
                    {agents === null && !error ? (
                        <div className="home-agents skel-wait" aria-hidden="true">
                            {[60, 45, 52].map((width) => (
                                <div key={width} className="agent">
                                    <div className="agent-row">
                                        <span className="agent-hit"><span className="agent-mark" /><span className="skel" style={{ width: `${width}%` }} /></span>
                                    </div>
                                    <ul className="agent-chats">
                                        {[0, 1].map((n) => <li key={n} className="chat-skel"><span className="skel" style={{ width: "62%" }} /></li>)}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    ) : error && groups.length === 0 ? (
                        <Empty actions={<Btn sm kind="quiet" onClick={onRetry}>Retry</Btn>}>Can't reach the gateway. Retrying.</Empty>
                    ) : groups.length === 0 ? (
                        <Empty title="No agents yet" actions={<Btn sm onClick={() => go({ at: "settings", section: "access" })}>Open access settings</Btn>}>
                            Agents appear here once you approve their access.
                        </Empty>
                    ) : (
                        <div className={fresh ? "home-agents enter" : "home-agents"}
                            onAnimationEnd={(e) => { if (e.target === e.currentTarget) setFresh(false); }}>
                            {groups.map(({ me, entry, rows, shut, total, hidden, state }) => {
                                const on = route?.at === "agent" && route.agent === me.name;
                                const drafting = route?.at === "new" && route.agent === me.name;
                                // cached rows stay clickable while the agent is connected: the chat reads its own history
                                const stale = entry.stale && !me.connected;
                                return (
                                    <div key={me.name} className="agent" data-shut={shut || undefined}>
                                        <div className={on ? "agent-row on" : "agent-row"}>
                                            <button type="button" className="agent-hit" aria-current={on ? "page" : undefined} onClick={() => go({ at: "agent", agent: me.name })}>
                                                <AgentMark agent={me.name} />
                                                <span className="agent-name">{me.name}</span>
                                                {state ? <span className="state" data-tone={state.tone}>{state.word}</span>
                                                    : shut && total > 0 && <span className="agent-count" aria-label={`${total} ${plural(total, "chat", "chats")}`}>{total}</span>}
                                            </button>
                                            <button type="button" className="btn icon sm agent-new" aria-label={`New chat with ${me.name}`} title="New chat"
                                                onClick={() => go({ at: "new", agent: me.name })}>
                                                <Icon name="plus" sm />
                                            </button>
                                            <button type="button" className="btn icon sm agent-fold" aria-expanded={!shut} aria-controls={`${listId}-${me.name}`}
                                                aria-label={`Chats with ${me.name}`} title={shut ? "Show chats" : "Hide chats"} onClick={() => toggleShut(me.name)}>
                                                <Icon name="chevron" sm />
                                            </button>
                                        </div>
                                        <ul className="agent-chats" id={`${listId}-${me.name}`}>
                                            {entry.rows === null && !shut
                                                ? [0, 1].map((n) => (
                                                    <li key={n} className="chat-skel skel-wait" aria-hidden="true"><span className="skel" style={{ width: "62%" }} /></li>
                                                ))
                                                : rows.map((c) => (
                                                    <li key={c.id} data-flip={`${me.name}#${c.id}`}>
                                                        <ChatRow agent={me.name} chat={c} variant="home" open={open?.agent === me.name && open.id === c.id}
                                                            gate={gateByChat.get(`${me.name}#${c.id}`)} stale={stale} />
                                                    </li>
                                                ))}
                                            {!shut && hidden > 0 && (
                                                <li><button type="button" className="agent-more" onClick={() => go({ at: "agent", agent: me.name })}>All {total} chats</button></li>
                                            )}
                                            {!shut && entry.rows !== null && entry.rows.length === 0 && entry.error && (
                                                <li><button type="button" className="agent-more" onClick={() => void refreshAgent(me.name).catch(() => undefined)}>Chats did not load. Retry</button></li>
                                            )}
                                            {!shut && entry.rows !== null && !entry.stale && rows.length === 0 && !drafting && (
                                                <li><button type="button" className="agent-more" onClick={() => go({ at: "new", agent: me.name })}>Start a chat</button></li>
                                            )}
                                        </ul>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>
            </div>
        </nav>
    );
}

export default memo(HomeList);
