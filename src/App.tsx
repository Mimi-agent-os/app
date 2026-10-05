import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import {
    compactConversation,
    getDashboard,
    listAgents,
    resumeAgent,
    stopAgent,
    stopTurn,
    type AgentSummary,
    type DashboardSnapshot,
} from "./api.ts";
import { listApprovals, type ApprovalSummary } from "./approval-api.ts";
import { openEmptyChat, refreshAgent, startAgentChats, useAgentChats } from "./agent-chats.ts";
import { setAvatars } from "./avatars.ts";
import { DialogProvider } from "./components/dialog.tsx";
import HomeList from "./components/home-list.tsx";
import { NavBar } from "./components/nav-bar.tsx";
import { useInboxUnread } from "./components/notifications.tsx";
import { Palette, usePalette, type Command } from "./components/palette.tsx";
import { ToastProvider, useToast } from "./components/toast.tsx";
import { BackButton, Btn, Empty, LoadBoundary } from "./components/ui.tsx";
import { listPairedDevices } from "./paired-devices-api.ts";
import {
    back, forgetChat, gateRoute, go, goLater, here, landing, leave, recentChats, rememberChat, SETTINGS_INDEX, useRoute, WIDE,
    type SettingsSection,
} from "./route.ts";
import { ago, errorMessage, isDelegation, MOD } from "./shared.ts";
import { tauriInvoke } from "./tauri.ts";
import { applyTheme, themeChoice } from "./theme.ts";
import AgentPage from "./views/agent-page.tsx";
import Chat, { ChatPending } from "./views/chat.tsx";
import { PairGate } from "./views/pair.tsx";

// Settings and Inbox load on first visit, so the chat path never waits for them
const Settings = lazy(() => import("./views/gateway.tsx"));
const Inbox = lazy(() => import("./views/inbox.tsx"));

// two states: folded writes "off", unfolded removes the key
const SIDE_KEY = "mimi-os:sidebar";

const wideQuery = matchMedia(WIDE);
const onWideChange = (listener: () => void): (() => void) => {
    wideQuery.addEventListener("change", listener);
    return () => wideQuery.removeEventListener("change", listener);
};

// module-level, so the memoized screens keep stable props across shell renders
const openAgent = (agent: string): void => go({ at: "agent", agent });
const openChat = (agent: string, id: number): void => go({ at: "chat", agent, id });
const openInterface = (agent: string, appRoute?: string): void => go({ at: "agent", agent, tab: "interfaces", appRoute });
const openAgentSettings = (agent: string): void => go({ at: "agent", agent, tab: "settings" });
const openGate = (a: ApprovalSummary): void => go(gateRoute(a.agent, a.room, a.conversation, a.gate));
// beside the index a section swaps in place; a phone pushes it over the index, so Back returns there
const pickSection = (section: SettingsSection): void => go({ at: "settings", section }, { replace: wideQuery.matches });

// the ‹ is there from the first frame: on a phone this screen may be all there is
const ScreenWait = (): ReactElement => (
    <div className="view"><header className="head"><BackButton /><span className="skel skel-wait" style={{ width: 140, height: 14 }} /></header></div>
);

// providers sit above whatever calls useToast/useDialog, hence the split
export function App(): ReactElement {
    return (
        <ToastProvider>
            <DialogProvider>
                <Shell />
            </DialogProvider>
        </ToastProvider>
    );
}

function Shell(): ReactElement {
    const { route, nav } = useRoute();
    const wide = useSyncExternalStore(onWideChange, () => wideQuery.matches);
    const chats = useAgentChats();
    const unread = useInboxUnread();
    const toast = useToast();
    const native = tauriInvoke() !== null;

    const [agents, setAgents] = useState<AgentSummary[] | null>(null);
    const [error, setError] = useState("");
    // null only before the first answer; after that the last good snapshot stays while refetches fail
    const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
    const [snapError, setSnapError] = useState("");
    // /approvals, not the snapshot: only it names a gate's chat
    const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
    // devices waiting for approval: a count on the bar's Settings and the Access row
    const [waiting, setWaiting] = useState(0);
    const dashboardRequest = useRef(0);
    const registryRequest = useRef(0);
    const approvalsRequest = useRef(0);
    const devicesRequest = useRef(0);

    const [folded, setFolded] = useState<boolean>(() => {
        try {
            return localStorage.getItem(SIDE_KEY) === "off";
        } catch {
            return false;
        }
    });
    const toggleFold = useCallback((): void => {
        setFolded((was) => {
            try {
                if (was) localStorage.removeItem(SIDE_KEY);
                else localStorage.setItem(SIDE_KEY, "off");
            } catch {
                // private mode: the sidebar still folds, it just forgets
            }
            return !was;
        });
    }, []);

    // ── the gateway's state, each read with its own request serial ──────────────

    // an identical answer keeps the old object, so nothing downstream re-renders for it
    const reload = useCallback(async (): Promise<void> => {
        const request = ++dashboardRequest.current;
        try {
            const next = await getDashboard();
            if (request !== dashboardRequest.current) return;
            setSnap((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
            setSnapError("");
        } catch (e) {
            if (request === dashboardRequest.current) setSnapError(errorMessage(e));
        }
    }, []);

    // replaced only on success: an empty list lies harder than a stale one
    const reloadRegistries = useCallback(async (): Promise<void> => {
        const request = ++registryRequest.current;
        try {
            const rows = (await listAgents()).filter((agent) => agent.status === "approved");
            if (request !== registryRequest.current) return;
            setAvatars(rows);
            setAgents((prev) => (JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
            setError("");
        } catch (e) {
            if (request === registryRequest.current) setError(errorMessage(e));
        }
    }, []);

    const reloadApprovals = useCallback(async (): Promise<void> => {
        const request = ++approvalsRequest.current;
        try {
            const rows = await listApprovals();
            if (request === approvalsRequest.current) setApprovals((prev) => (JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
        } catch {
            // the last verified gates stay: an empty list would hide ones that still wait
        }
    }, []);

    const reloadDevices = useCallback(async (): Promise<void> => {
        const request = ++devicesRequest.current;
        try {
            const rows = await listPairedDevices();
            if (request === devicesRequest.current) setWaiting(rows.filter((d) => d.status === "inactive").length);
        } catch {
            // the last count stays: it is a hint, and Access reads the list itself
        }
    }, []);

    useEffect(() => {
        void reload();
        void reloadRegistries();
        void reloadApprovals();
        void reloadDevices();
        const everything = (): void => { void reload(); void reloadRegistries(); void reloadApprovals(); };
        const devicesChanged = (): void => { void reloadDevices(); };
        const pinsChanged = (): void => { void reloadRegistries(); };
        const usageChanged = (): void => { void reload(); };
        const approvalsChanged = (): void => { void reloadApprovals(); };
        window.addEventListener("mimi:resync", everything);
        window.addEventListener("mimi:agent-changed", everything);
        window.addEventListener("mimi:pins-changed", pinsChanged);
        window.addEventListener("mimi:usage-changed", usageChanged);
        window.addEventListener("mimi:approvals-changed", approvalsChanged);
        window.addEventListener("mimi:paired-devices-changed", devicesChanged);
        window.addEventListener("mimi:resync", devicesChanged);
        return () => {
            dashboardRequest.current++;
            registryRequest.current++;
            approvalsRequest.current++;
            devicesRequest.current++;
            window.removeEventListener("mimi:resync", everything);
            window.removeEventListener("mimi:agent-changed", everything);
            window.removeEventListener("mimi:pins-changed", pinsChanged);
            window.removeEventListener("mimi:usage-changed", usageChanged);
            window.removeEventListener("mimi:approvals-changed", approvalsChanged);
            window.removeEventListener("mimi:paired-devices-changed", devicesChanged);
            window.removeEventListener("mimi:resync", devicesChanged);
        };
    }, [reload, reloadRegistries, reloadApprovals, reloadDevices]);

    // nothing is recorded at the owner's midnight, yet "today" starts over then
    const resetsAt = snap?.day.resetsAt;
    useEffect(() => {
        if (!resetsAt) return;
        const timer = setTimeout(() => void reload(), Math.max(0, Date.parse(resetsAt) - Date.now()) + 1000);
        return () => clearTimeout(timer);
    }, [resetsAt, reload]);

    useEffect(() => {
        if (agents) startAgentChats(agents.map((a) => a.name));
    }, [agents]);

    // ── where the owner is ────────────────────────────────────────────────────────

    const named = route?.at === "chat" || route?.at === "new" || route?.at === "agent" ? route.agent : undefined;
    const me = named === undefined ? undefined : agents?.find((a) => a.name === named);
    const openChatRoute = route?.at === "chat" ? route : null;
    const openEntry = openChatRoute ? chats.get(openChatRoute.agent) : undefined;
    const openRow = openChatRoute ? openEntry?.rows?.find((c) => c.id === openChatRoute.id) : undefined;

    // a URL naming no place, a parked room or an agent that is not admitted lands: the last place on desktop, Home on the phone
    useEffect(() => {
        // the phone's Home needs no agent list, so a dead link never waits on one
        if (!wide && (route === null || route.at === "rooms")) {
            go({ at: "home" }, { replace: true });
            return;
        }
        if (!agents) return;
        const names = agents.map((a) => a.name);
        const lost = route === null || route.at === "rooms" || (named !== undefined && !names.includes(named));
        if (lost || (route?.at === "home" && wide)) go(wide ? landing(names) : { at: "home" }, { replace: true });
    }, [agents, route, named, wide]);

    // #/a/<agent>/new becomes the agent's empty chat in place; one resolution per arrival, StrictMode's second effect included
    const resolving = useRef(-1);
    useEffect(() => {
        if (route?.at !== "new" || !me || resolving.current === nav) return;
        resolving.current = nav;
        const { agent } = route;
        const land = goLater();
        openEmptyChat(agent).then(
            (id) => land({ at: "chat", agent, id }, { replace: true }),
            (e: unknown) => {
                toast(errorMessage(e));
                if (here() === route) back();
            },
        );
    }, [route, me, nav, toast]);

    // a chat missing from a fresh list is refetched once; still missing, it is gone
    const checked = useRef(-1);
    useEffect(() => {
        if (!openChatRoute || !openEntry?.rows || openEntry.stale || openRow || checked.current === nav) return;
        checked.current = nav;
        const { agent, id } = openChatRoute;
        refreshAgent(agent).then((rows) => {
            if (rows.some((c) => c.id === id)) return;
            forgetChat(agent, id);
            leave(openChatRoute, { at: "agent", agent });
        }, () => undefined);
    }, [openChatRoute, openEntry, openRow, nav]);

    // once per arrival, and again only when the row's archived flag or title changes
    const remembered = useRef("");
    useEffect(() => {
        if (!openChatRoute || !openRow) return;
        const key = `${nav}|${openRow.archived}|${openRow.title}`;
        if (remembered.current === key) return;
        remembered.current = key;
        rememberChat(openChatRoute.agent, openRow);
    }, [openChatRoute, openRow, nav]);

    useEffect(() => {
        document.title = approvals.length > 0 ? `(${approvals.length}) mimi-os` : "mimi-os";
    }, [approvals.length]);

    // preventDefault only once the chord is certainly ours: a bare Ctrl+B opens Firefox's bookmarks
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.defaultPrevented || e.isComposing) return;
            const key = e.key.toLowerCase();
            if (key === "b" && wideQuery.matches) {
                e.preventDefault();
                toggleFold();
                return;
            }
            if (key !== "n" || document.querySelector("[aria-modal=true], dialog[open]")) return;
            const now = here();
            if (now?.at !== "chat" && now?.at !== "new" && now?.at !== "agent") return;
            e.preventDefault();
            go({ at: "new", agent: now.agent });
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [toggleFold]);

    // ── commands ──────────────────────────────────────────────────────────────────

    // keyed on the chat alone, so the composer's slash list never changes under a keystroke
    const chatAgent = openChatRoute?.agent;
    const chatId = openChatRoute?.id;
    const slash = useMemo<Command[]>(() => {
        if (chatAgent === undefined || chatId === undefined) return [];
        return [{
            id: "do:compact",
            label: "Compact this chat",
            group: "do",
            icon: "models",
            slash: "/compact",
            keywords: `compact fold summarize shorten context ${chatAgent}`,
            run: async () => {
                try {
                    const r = await compactConversation(chatAgent, chatId);
                    toast(r.compacted ? "Compacted. The model now reads a shorter history." : r.reason ?? "Nothing to compact yet.");
                } catch (e) {
                    toast(errorMessage(e));
                }
            },
        }];
    }, [chatAgent, chatId, toast]);

    // every chat, so a search finds an old one; the palette shortens the list itself while nothing is typed
    const recent = useMemo(() => [...chats]
        .flatMap(([agent, entry]) => (entry.rows ?? [])
            .filter((c) => !c.archived && !isDelegation(c) && c.messages > 0 && !(agent === chatAgent && c.id === chatId))
            .map((c) => ({ agent, c })))
        .toSorted((x, y) => (x.c.updatedAt === y.c.updatedAt ? 0 : x.c.updatedAt < y.c.updatedAt ? 1 : -1)), [chats, chatAgent, chatId]);

    // ⌘K then Enter goes back to the chat before this one
    const initial = useMemo(() => {
        const pair = recentChats().findLast(([agent, id]) => recent.some((r) => r.agent === agent && r.c.id === id));
        return pair ? `chat:${pair[0]}:${pair[1]}` : undefined;
    }, [recent]);

    const commands = useMemo<Command[]>(() => {
        const out: Command[] = [];
        const known = agents ?? [];

        for (const a of approvals.toSorted((x, y) => x.deadline - y.deadline)) {
            if (!known.some((k) => k.name === a.agent)) continue;
            const inChat = a.room === undefined && a.conversation !== undefined;
            out.push({
                id: `needs:${a.gate}`,
                label: inChat ? chats.get(a.agent)?.rows?.find((c) => c.id === a.conversation)?.title ?? "Untitled" : a.label,
                detail: a.kind === "question" ? (inChat ? a.label : a.agent)
                    : `${a.agent} · ${a.tool}${a.actions.length > 1 ? ` and ${a.actions.length - 1} more` : ""}`,
                group: "needs",
                dot: "degraded",
                keywords: a.kind === "question" ? `question answer ${a.label}` : `approval allow ${a.label}`,
                run: () => openGate(a),
            });
        }

        for (const { agent, c } of recent) {
            out.push({
                id: `chat:${agent}:${c.id}`,
                label: c.title ?? "Untitled",
                detail: `${agent} · ${ago(c.updatedAt)}`,
                group: "recent",
                icon: "chat",
                keywords: `${agent} ${c.title ?? ""}`,
                run: () => openChat(agent, c.id),
            });
        }

        for (const a of known) {
            out.push({ id: `goto:agent:${a.name}`, label: `Open ${a.name}`, group: "goto", icon: "chat", keywords: `agent chats ${a.name}`, run: () => openAgent(a.name) });
            out.push({
                id: `goto:agent-settings:${a.name}`,
                label: `${a.name} settings`,
                group: "goto",
                icon: "settings",
                keywords: `agent models fallback access ${a.name}`,
                run: () => openAgentSettings(a.name),
            });
        }
        for (const t of SETTINGS_INDEX) {
            out.push({
                id: `goto:settings:${t.v}`,
                label: `Settings: ${t.label}`,
                group: "goto",
                icon: t.icon,
                keywords: `settings gateway ${t.v} ${t.hint}`,
                run: () => go({ at: "settings", section: t.v }),
            });
        }
        out.push({ id: "goto:inbox", label: "Inbox", group: "goto", icon: "queue", keywords: "reports notifications activity", run: () => go({ at: "inbox" }) });

        for (const a of known) {
            out.push({
                id: `do:new:${a.name}`,
                label: `New chat with ${a.name}`,
                group: "do",
                icon: "plus",
                // browsers keep ⌘N and Ctrl+N for a new window; only the desktop app gets the key
                hint: native && named === a.name ? `${MOD}N` : undefined,
                keywords: `new chat start talk ${a.name}`,
                run: () => go({ at: "new", agent: a.name }),
            });
        }
        if (chatAgent !== undefined && chatId !== undefined) {
            const title = chats.get(chatAgent)?.rows?.find((c) => c.id === chatId)?.title ?? "this chat";
            out.push({
                id: "do:stop-turn",
                label: `Stop the turn in ${title}`,
                group: "do",
                icon: "stop",
                keywords: `stop cancel abort interrupt turn ${chatAgent}`,
                run: async () => {
                    const r = await stopTurn(chatAgent, chatId);
                    toast(r.stopped ? "Stopped." : "Nothing was running.");
                },
            });
            for (const c of slash) out.push({ ...c, label: `Compact ${title}` });
        }
        // two different acts, not one switch: stop cuts every turn and revokes spending, resume only lifts the gate
        for (const a of known) {
            out.push(a.paused ? {
                id: `do:resume:${a.name}`,
                label: `Resume ${a.name}`,
                group: "do",
                icon: "play",
                keywords: `resume unpause continue agent ${a.name}`,
                run: async () => {
                    await resumeAgent(a.name);
                    toast(`${a.name}: resumed, it may spend again`);
                    await reloadRegistries();
                },
            } : {
                id: `do:stop:${a.name}`,
                label: `Stop ${a.name} (turns and spending)`,
                group: "do",
                icon: "stop",
                keywords: `stop pause halt abort turns spending agent ${a.name}`,
                run: async () => {
                    const r = await stopAgent(a.name);
                    toast(r.turns > 0
                        ? `${a.name}: stopped, ${r.turns} ${r.turns === 1 ? "turn" : "turns"} cut off, agent paused`
                        : `${a.name}: nothing was running, agent paused`);
                    await reloadRegistries();
                },
            });
        }
        out.push({
            id: "do:theme",
            // three states, and "system" is the absent key
            label: "Cycle theme",
            group: "do",
            keywords: "theme dark light system appearance",
            run: () => {
                const current = themeChoice();
                const next = current === "light" ? "dark" : current === "dark" ? "system" : "light";
                applyTheme(next);
                toast(next === "system" ? "Theme: follow system" : `Theme: ${next}`);
            },
        });
        if (wide) {
            out.push({
                id: "do:sidebar",
                label: folded ? "Show the sidebar" : "Hide the sidebar",
                group: "do",
                icon: folded ? "chevron" : "back",
                hint: `${MOD}B`,
                keywords: "sidebar rail fold collapse expand",
                run: toggleFold,
            });
        }
        return out;
    }, [agents, approvals, chats, recent, named, chatAgent, chatId, slash, native, wide, folded, toggleFold, reloadRegistries, toast]);

    const palette = usePalette({ commands, initial, onError: (e) => toast(e.message) });

    // ── the screen ────────────────────────────────────────────────────────────────

    const dash = named === undefined ? undefined : snap?.agents.find((a) => a.name === named);
    const gatesHere = openChatRoute
        ? approvals.filter((a) => a.agent === openChatRoute.agent && a.conversation === openChatRoute.id && a.room === undefined).length
        : 0;
    const screen = agents === null && (route === null || route.at === "home" || route.at === "rooms" || named !== undefined) ? (
        error ? (
            <div className="view">
                <header className="head"><BackButton /><div className="head-main"><h1 className="head-title">Can't reach the gateway</h1></div></header>
                <Empty actions={<Btn sm onClick={() => void reloadRegistries()}>Retry</Btn>}>{error}</Empty>
            </div>
        ) : <ScreenWait />
    )
        : route?.at === "chat" && me && agents ? (
            <Chat key={`${route.agent}#${route.id}`} agent={route.agent} conversation={route.id} me={me} agents={agents}
                gated={gatesHere > 0} elsewhere={approvals.length - gatesHere} slash={slash} />
        )
        : route?.at === "new" && me ? <ChatPending agent={route.agent} />
        : route?.at === "agent" && me ? (
            <AgentPage key={route.agent} agent={route.agent} me={me} health={dash?.health} why={dash?.why}
                approvals={approvals} tab={route.tab ?? "chats"} app={route.app} appRoute={route.appRoute} nav={nav} />
        )
        : route?.at === "inbox" ? (
            <LoadBoundary key="inbox" screen>
                <Suspense fallback={<ScreenWait />}>
                    <Inbox gate={route.gate} tab={route.tab} onAgent={openAgent} onChat={openChat} onOpenInterface={openInterface} />
                </Suspense>
            </LoadBoundary>
        )
        : route?.at === "settings" ? (
            <LoadBoundary key="settings" screen>
                <Suspense fallback={<ScreenWait />}>
                    <Settings section={route.section} wide={wide} waiting={waiting} onSection={pickSection} snap={snap} snapError={snapError} approvals={approvals}
                        onGate={openGate} onAgent={openAgent} onChat={openChat} onModels={openAgentSettings} />
                </Suspense>
            </LoadBoundary>
        )
        : null;

    return (
        <div className="app" data-side={folded && wide ? "off" : "on"} data-stack={route?.at === "home" ? "home" : "screen"}
            data-bar={route?.at === "chat" || route?.at === "new" ? "off" : "on"}>
            {/* null once this device has a paired session, a modal dialog otherwise */}
            <PairGate />
            <aside className="side">
                <HomeList agents={agents} error={error} approvals={approvals} route={route}
                    folded={folded && wide} onFold={toggleFold} onSearch={palette.open} onNewChat={() => palette.openWith("new chat")} onRetry={reloadRegistries} />
            </aside>
            <main className="work">{screen}</main>
            <NavBar route={route} rail={folded && wide} agents={agents} needs={approvals.length} unread={unread} waiting={waiting} />
            <Palette control={palette} />
        </div>
    );
}
