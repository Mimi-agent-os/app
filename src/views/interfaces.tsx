import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { AgentApp, AppPage, InterfacesData } from "../app-api.ts";
import { Icon } from "../components/icon.tsx";
import { Btn, Empty, Skeleton } from "../components/ui.tsx";
import { registerFrame } from "../mini-app-relay.ts";
import { doorAttached, frameUrl, grantFor } from "../mini-apps.ts";
import { go, useOverlayUp } from "../route.ts";
import { Err, errorMessage, useMounted } from "../shared.ts";
import "../interfaces.css";

export { useInterfaces } from "../app-api.ts";

interface LaunchState {
    appId: string;
    title: string;
    /** The page's path in its app, asked for again on a reload. */
    route: string;
    url: string;
    pending: boolean;
    error: string | null;
}

function pagesOf(app: AgentApp): AppPage[] {
    if (!app.pages?.length) return [{ id: "main", title: app.title, ...(app.entry ? { path: app.entry } : {}) }];
    if (!app.entry || app.pages.some((page) => page.path === app.entry || page.path === undefined)) return app.pages;
    let id = "entry";
    while (app.pages.some((page) => page.id === id)) id = `_${id}`;
    return [{ id, title: app.title, path: app.entry }, ...app.pages];
}

export default function InterfacesTab({ agent, initialApp, initialRoute, navigationKey, data }: {
    agent: string;
    /** The app the link names; none or an unknown one opens the first. */
    initialApp?: string | undefined;
    initialRoute?: string | undefined;
    navigationKey?: number | undefined;
    data: InterfacesData;
}): ReactElement {
    const { apps, loading, error, refresh } = data;
    const incoming = JSON.stringify([initialApp, initialRoute, navigationKey]);
    const [selected, setSelected] = useState<Record<string, string>>({});
    const [launched, setLaunched] = useState<Record<string, LaunchState>>({});
    const pending = useRef(new Set<string>());
    const mounted = useMounted();
    const app = apps.find((item) => item.appId === initialApp) ?? apps[0];
    const pageIncoming = JSON.stringify([incoming, app?.appId]);
    const pages = useMemo(() => app ? pagesOf(app) : [], [app]);
    const localSelection = selected[pageIncoming];
    let routeValid = initialRoute === undefined;
    if (initialRoute !== undefined) {
        try { routeValid = initialRoute.startsWith("/") && new URL(initialRoute, "http://app.invalid").origin === "http://app.invalid"; }
        catch { routeValid = false; }
    }
    const linkedPage = initialRoute === undefined || !routeValid ? undefined
        : pages.find((page) => page.path === initialRoute) ?? { id: `route:${initialRoute}`, title: "Linked page", path: initialRoute };
    const current = pages.find((page) => page.id === localSelection)
        ?? (localSelection === linkedPage?.id ? linkedPage : undefined)
        ?? linkedPage
        ?? (app?.entry ? pages.find((page) => page.path === app.entry || page.path === undefined) : undefined)
        ?? pages[0];
    const activeKey = app && current ? JSON.stringify([app.appId, current.id]) : null;
    const active = activeKey ? launched[activeKey] : undefined;
    const approved = app?.status === "approved";
    // anywhere but the macOS desktop app a frame would share the pult's origin or its IPC, so none is ever made
    const door = doorAttached();

    const launch = useCallback((targetApp: AgentApp, target: AppPage, fresh = false): void => {
        if (!targetApp.available || targetApp.status !== "approved") return;
        const key = JSON.stringify([targetApp.appId, target.id]);
        if (pending.current.has(key)) return;
        pending.current.add(key);
        const { appId } = targetApp;
        const title = target.title === targetApp.title ? targetApp.title : `${targetApp.title} · ${target.title}`;
        const route = target.path ?? targetApp.entry ?? "/";
        setLaunched((old) => ({ ...old, [key]: { appId, title, route, url: "", ...old[key], pending: true, error: null } }));
        // the grant is minted here and nowhere else, so no frame can make the pult mint one
        void grantFor(agent, appId, fresh).then(() => frameUrl(appId, route)).then((url) => {
            if (mounted.current) setLaunched((old) => ({ ...old, [key]: { appId, title, route, url, pending: false, error: null } }));
        }).catch((reason: unknown) => {
            if (mounted.current) setLaunched((old) => old[key] ? { ...old, [key]: { ...old[key], pending: false, error: errorMessage(reason, "Could not launch this interface.") } } : old);
        }).finally(() => pending.current.delete(key));
    }, [agent]);

    useEffect(() => {
        if (door && app && current && activeKey && !launched[activeKey] && !loading && !error) launch(app, current);
    }, [door, app, current, activeKey, launched, loading, error, launch]);

    const known = Object.keys(launched).length > 0 || !!app;
    // mirrors the auto-launch preconditions, so the placeholder never waits on a launch that will not start
    const awaitingFrame = loading ? !known : door && !!activeKey && approved && !!app?.available && !active?.url && !active?.error && !error;

    return <div className="interfaces-tab">
        <header className="interfaces-toolbar">
            <div className="interfaces-heading"><span>@{agent}</span><h2>{app?.title ?? "Interfaces"}</h2></div>
            <div className="interfaces-tools">
                {apps.length > 1 && <label className="interfaces-app-choice"><span>Interface</span><select aria-label="Choose interface" value={app?.appId} onChange={(event) => go({ at: "agent", agent, tab: "interfaces", app: event.target.value }, { replace: true })}>{apps.map((item) => <option key={item.appId} value={item.appId}>{item.title}</option>)}</select></label>}
                <Btn sm kind="quiet" icon="refresh" disabled={loading} title="Check for available interfaces without reloading your page" onClick={refresh}>Refresh list</Btn>
            </div>
        </header>
        {error && <Err>{error} <Btn sm onClick={refresh}>Retry</Btn></Err>}
        {loading && known && <p className="dim3" role="status">Refreshing interfaces…</p>}
        {!routeValid && <Err>This interface link has an invalid route. Showing the overview.</Err>}
        {app && (pages.length > 1 || (linkedPage && !pages.some((page) => page.id === linkedPage.id))) && <div className="interfaces-pages" aria-label="Interface pages">
            {[...pages, ...(linkedPage && !pages.some((page) => page.id === linkedPage.id) ? [linkedPage] : [])].map((page) => <button key={page.id} type="button" className={page.id === current?.id ? "on" : ""} aria-pressed={page.id === current?.id} onClick={() => setSelected((old) => ({ ...old, [pageIncoming]: page.id }))}>{page.title}</button>)}
        </div>}
        {app && !door && <p className="interfaces-notice" role="status">Interfaces open only in the desktop app on macOS.</p>}
        {app && !approved && <p className="interfaces-notice" role="status">@{agent} is blocked, so its interfaces cannot be opened.</p>}
        {app && approved && !app.available && <p className="interfaces-notice" role="status">This interface is offline.{active?.url ? " Your open page is still available." : " Check again when it is available."} <Btn sm disabled={loading} onClick={refresh}>Refresh</Btn></p>}
        {active?.error && <Err>{active.error} <Btn sm disabled={active.pending || !app?.available || !approved} onClick={() => { if (app && current) launch(app, current, true); }}>Retry launch</Btn></Err>}
        {active?.pending && !awaitingFrame && <p className="dim3" role="status">Launching interface…</p>}
        {!loading && !error && !app && <Empty title="No interfaces yet">Interfaces published by {agent} will appear here.</Empty>}
        {awaitingFrame && <div className="interfaces-page" role="status" aria-label="Loading interface"><Skeleton className="interfaces-skel" /></div>}
        {Object.entries(launched).map(([key, state]) => state.url && <AppFrame key={key} agent={agent} state={state} active={key === activeKey} />)}
    </div>;
}

function AppFrame({ agent, state, active }: { agent: string; state: LaunchState; active: boolean }): ReactElement {
    const frame = useRef<HTMLIFrameElement | null>(null);
    const loadingTimer = useRef<number | undefined>(undefined);
    // under a menu, dialog or palette the frame takes no clicks, keys or focus, so it cannot steal them from the pult
    const covered = useOverlayUp();
    const [loaded, setLoaded] = useState(false);
    const [issue, setIssue] = useState("");
    const [reload, setReload] = useState(0);
    useEffect(() => {
        setLoaded(false);
        setIssue("");
        loadingTimer.current = window.setTimeout(() => setIssue(`The interface has not finished loading. Check that @${agent} is online.`), 20_000);
        return () => window.clearTimeout(loadingTimer.current);
    }, [agent, state.url, reload]);
    // the relay opens bridge.js's streams, WebSocket and cookies only to a document inside a frame launched for this app
    useEffect(() => (frame.current ? registerFrame(frame.current, state.appId) : undefined), [state.appId]);
    return <section hidden={!active} className="interfaces-page" aria-label={state.title}>
        {!loaded && !issue && <p className="dim3" role="status">Loading interface page…</p>}
        {issue && <Err>{issue}</Err>}
        {/* outside the frame, where no agent page can draw over it */}
        <p className="dim3" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, font: "var(--f-xs)" }}><Icon name="app" sm />Agent page. mimi never asks for keys or pairing links here.</p>
        {/* the frame's origin is the app's own, never the pult's; allow="" drops camera, microphone and the like */}
        <iframe ref={frame} title={state.title} className="interfaces-frame" src={state.url} sandbox="allow-scripts allow-forms allow-same-origin" allow="" referrerPolicy="no-referrer" inert={covered} onLoad={() => { window.clearTimeout(loadingTimer.current); setLoaded(true); setIssue(""); }} onError={() => { window.clearTimeout(loadingTimer.current); setLoaded(false); setIssue("The interface could not be loaded."); }} />
        <div className="interfaces-page-actions">
            <Btn sm kind="quiet" icon="refresh" disabled={state.pending} title="Reload this page; unsaved work may be lost" onClick={() => {
                setReload((value) => value + 1);
                // a fresh grant replaces the old one on the gateway: whatever the page had in flight ends with it
                void grantFor(agent, state.appId, true).then(() => frameUrl(state.appId, state.route)).then((url) => {
                    if (frame.current) frame.current.src = url;
                }).catch((reason: unknown) => setIssue(errorMessage(reason, "Could not reload this interface.")));
            }}>Reload interface</Btn>
        </div>
    </section>;
}
