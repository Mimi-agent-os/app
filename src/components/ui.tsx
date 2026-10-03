/** Shared UI primitives: deliberately thin, since the design system is CSS-class-driven and a primitive's job is to name a class, not restyle. */
import { Component, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode, MouseEvent as ReactMouseEvent } from "react";

import { Icon, type IconName } from "./icon.tsx";
import { useAvatar } from "../avatars.ts";
import { back } from "../route.ts";
import { countdown } from "../shared.ts";


/** Render inside the surface's real row class so the loaded content swaps in with no layout shift. */
export function Skeleton({ w, h, className }: {
    w?: number | string;
    h?: number | string;
    className?: string;
}): ReactElement {
    return <span className={className ? `skel ${className}` : "skel"} aria-hidden="true" style={{ width: w, height: h }} />;
}

/** True from the render where `ready` first turns true until the row stagger has played (8 × 25ms + 200ms). */
export function useEntering(ready: boolean): boolean {
    const [phase, setPhase] = useState<"wait" | "on" | "done">("wait");
    // set during render, not in an effect: the rows' first commit must already carry .entering, or they flash in and then fade
    if (ready && phase === "wait") setPhase("on");
    useEffect(() => {
        if (phase !== "on") return;
        const timer = setTimeout(() => setPhase("done"), 450);
        return () => clearTimeout(timer);
    }, [phase]);
    return phase === "on";
}


/** The agent's avatar, or its first letter while that loads, if it fails, or when the agent ships none. */
export function AgentMark({ agent, size }: { agent: string; size?: "lg" | "xl" | undefined }): ReactElement {
    const src = useAvatar(agent);
    const [broken, setBroken] = useState<string | null>(null);
    return (
        <span className={size ? `agent-mark ${size}` : "agent-mark"} aria-hidden="true">
            {src && src !== broken ? <img src={src} alt="" draggable={false} onError={() => setBroken(src)} /> : agent.slice(0, 1).toUpperCase()}
        </span>
    );
}


/** Not api.ts's `Health` — the spellings overlap on purpose, but don't rename this to `Health`, or a fourth value added there would silently paint here too. */
export type DotState = "ok" | "degraded" | "down" | "idle" | "paused";

export const Dot = ({ state }: { state: DotState }): ReactElement => (
    <span className={state === "idle" ? "dot" : `dot ${state}`} />
);

export type PillTone = "ok" | "warn" | "bad" | "info" | "plain";

export const Pill = ({
    tone = "plain",
    children,
}: {
    tone?: PillTone;
    children: ReactNode;
}): ReactElement => <span className={tone === "plain" ? "pill" : `pill ${tone}`}>{children}</span>;


/** Semantic, not decorative: `send` is the one mint action, accent invites the next step, danger destroys something. */
type BtnKind = "primary" | "accent" | "danger" | "quiet" | "outline" | "send";

export function Btn({
    kind = "outline",
    sm,
    icon,
    disabled,
    title,
    onClick,
    children,
}: {
    kind?: BtnKind | undefined;
    sm?: boolean | undefined;
    icon?: IconName | undefined;
    disabled?: boolean | undefined;
    title?: string | undefined;
    /** The event rides along for callers that anchor menus to the button's box. */
    onClick?: ((e: ReactMouseEvent<HTMLButtonElement>) => void) | undefined;
    children?: ReactNode;
}): ReactElement {
    const cls = ["btn", kind === "outline" ? "" : kind, sm ? "sm" : "", children ? "" : "icon"]
        .filter(Boolean)
        .join(" ");
    return (
        <button type="button" className={cls} disabled={disabled} title={title} aria-label={children ? undefined : title} onClick={onClick}>
            {icon && <Icon name={icon} sm={sm ?? !children} />}
            {children}
        </button>
    );
}


/** A bordered block with an optional titled header — the design's `.pnl`. */
export function Panel({
    title,
    icon,
    aside,
    children,
}: {
    title?: ReactNode;
    icon?: IconName;
    /** Pushed to the right of the header (a count, a button). */
    aside?: ReactNode;
    children: ReactNode;
}): ReactElement {
    return (
        <div className="pnl">
            {title !== undefined && (
                <div className="pnlh">
                    {icon && <Icon name={icon} sm />}
                    {title}
                    {aside && <span style={{ marginLeft: "auto" }}>{aside}</span>}
                </div>
            )}
            {children}
        </div>
    );
}

/** One row inside a Panel: leading mark, a name + sub-line, trailing actions. */
export function KvRow({
    lead,
    name,
    sub,
    actions,
}: {
    lead?: ReactNode;
    name: ReactNode;
    sub?: ReactNode;
    actions?: ReactNode;
}): ReactElement {
    return (
        <div className="kvrow">
            {lead}
            <div className="txt">
                <b>{name}</b>
                {sub !== undefined && <span>{sub}</span>}
            </div>
            {actions && <div className="acts">{actions}</div>}
        </div>
    );
}

export const Empty = ({ children, title, icon, actions }: {
    children?: ReactNode;
    title?: string;
    icon?: IconName;
    actions?: ReactNode;
}): ReactElement => (
    <div className="empty">
        {icon && <span className="empty-icon"><Icon name={icon} /></span>}
        {title && <h3>{title}</h3>}
        {children && <div className="empty-copy">{children}</div>}
        {actions && <div className="empty-actions">{actions}</div>}
    </div>
);

export const Metric = ({ value, label }: { value: ReactNode; label: string }): ReactElement => (
    <div className="metric">
        <b className="num">{value}</b>
        <span>{label}</span>
    </div>
);


/** `open` is a plain prop, not state: React only writes the DOM property when the value changes, so a constant `open` still lets a reader collapse the block by hand. */
export function Disclose({
    tone,
    summary,
    open,
    flush,
    children,
}: {
    tone?: "think" | "tools";
    summary: ReactNode;
    open?: boolean;
    /** Drops the block's own bottom margin — needed where the surrounding grid already supplies the gap. */
    flush?: boolean;
    children: ReactNode;
}): ReactElement {
    return (
        <details className={tone ? `disclose ${tone}` : "disclose"} open={open} style={flush ? { margin: 0 } : undefined}>
            <summary>{summary}</summary>
            <pre>{children}</pre>
        </details>
    );
}


// ── screen chrome and time ────────────────────────────────────────────────────

/** Around a lazily loaded part: a file that failed to arrive, or a crash while rendering it, leaves a way out instead of a blank app. */
export class LoadBoundary extends Component<{ screen?: boolean | undefined; children: ReactNode }, { error: Error | null }> {
    override state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: unknown): { error: Error } {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    override componentDidCatch(error: unknown): void {
        console.error("a part of the app failed", error);
    }

    override render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;
        // Chromium, WebKit and Firefox each word a chunk that never arrived differently
        const missing = /dynamically imported module|module script failed/i.test(error.message);
        const failed = missing ? (
            <Empty title="This part of the app did not load" actions={<Btn sm onClick={() => location.reload()}>Reload</Btn>}>
                A newer version may be out, or the connection dropped. Reloading fetches it again.
            </Empty>
        ) : (
            <Empty title="This part of the app hit an error" actions={<Btn sm onClick={() => this.setState({ error: null })}>Try again</Btn>}>
                {error.message}
            </Empty>
        );
        // a whole screen keeps its header, so the phone still has a way back
        return this.props.screen ? <div className="view"><header className="head"><BackButton /></header>{failed}</div> : failed;
    }
}

/** Every screen's ‹; only shown at phone width, where the home list is a screen of its own. */
export function BackButton({ count }: { count?: number | undefined }): ReactElement {
    return (
        <button type="button" className="btn icon head-back" aria-label={count ? `Back, ${count} waiting for you` : "Back"} onClick={back}>
            <Icon name="back" />
            {count ? <span className="count warn">{count}</span> : null}
        </button>
    );
}

let minute = Date.now();
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | undefined;

function subscribeMinute(listener: () => void): () => void {
    minuteListeners.add(listener);
    minuteTimer ??= setInterval(() => {
        minute = Date.now();
        for (const l of minuteListeners) l();
    }, 60_000);
    return () => {
        minuteListeners.delete(listener);
        if (minuteListeners.size > 0) return;
        clearInterval(minuteTimer);
        minuteTimer = undefined;
    };
}

/** One shared 60s tick for every relative time on screen. */
export const useMinute = (): number => useSyncExternalStore(subscribeMinute, () => minute);

/** Exists only while a gate is open, so its 1s interval never outlives the gate. */
export function Countdown({ deadline }: { deadline: number }): ReactElement {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    return <span className="countdown">{countdown(deadline - now)}</span>;
}
