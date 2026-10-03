/** Transient toast with an optional undo — a context, not a prop, so it can fire from anywhere in the tree. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactElement, ReactNode } from "react";

const TOAST_MS = 3400;
const UNDO_MS = 8000;

interface ToastUndo {
    /** A verb («restore»), so the row says what clicking does. */
    label: string;
    run: () => void;
}

/** Returns whether this toast is still the one on screen, so a caller can fold a follow-up into it. */
export type ShowToast = (text: string, undo?: ToastUndo) => () => boolean;

const Ctx = createContext<ShowToast | null>(null);

export function useToast(): ShowToast {
    const show = useContext(Ctx);
    if (!show) throw new Error("useToast() used outside <ToastProvider>");
    return show;
}

interface Message {
    text: string;
    undo: ToastUndo | null;
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
    // kept after dismissal: `.toast` fades out over --dur-2 and needs its text for the whole of it
    const [msg, setMsg] = useState<Message | null>(null);
    const [on, setOn] = useState(false);
    // a modal <dialog> draws over everything outside it, so a toast raised while one is open lives inside it
    const [host, setHost] = useState<Element | null>(null);
    const timer = useRef<number | undefined>(undefined);
    const element = useRef<HTMLDivElement | null>(null);
    const active = useRef(false);
    const hovered = useRef(false);
    const duration = useRef(TOAST_MS);
    const serial = useRef(0);
    const acting = useRef(false);
    const held = useRef<string | null>(null);

    // a hidden window starts no countdown: an approval's Review is still there when the owner comes back
    const scheduleDismiss = useCallback((): void => {
        window.clearTimeout(timer.current);
        if (!active.current || hovered.current || document.hidden || element.current?.contains(document.activeElement)) return;
        timer.current = window.setTimeout(() => {
            active.current = false;
            setOn(false);
        }, duration.current);
    }, []);

    const show = useCallback<ShowToast>((text, undo) => {
        // a plain notice never wipes an action still on screen; it is held until that one closes
        if (!undo && active.current && acting.current) {
            held.current = text;
            return () => false;
        }
        const mine = ++serial.current;
        setHost(document.querySelector("dialog[open]"));
        setMsg({ text, undo: undo ?? null });
        setOn(true);
        active.current = true;
        acting.current = undo !== undefined;
        duration.current = undo ? UNDO_MS : TOAST_MS;
        scheduleDismiss();
        return () => active.current && serial.current === mine;
    }, [scheduleDismiss]);

    // after the fade, so the held notice rises instead of swapping text in place
    useEffect(() => {
        if (on || held.current === null) return;
        const rise = window.setTimeout(() => {
            const text = held.current;
            held.current = null;
            if (text !== null) show(text);
        }, 200);
        return () => window.clearTimeout(rise);
    }, [on, show]);

    useEffect(scheduleDismiss, [msg, scheduleDismiss]);
    useEffect(() => {
        document.addEventListener("visibilitychange", scheduleDismiss);
        return () => {
            document.removeEventListener("visibilitychange", scheduleDismiss);
            window.clearTimeout(timer.current);
        };
    }, [scheduleDismiss]);

    const undo = useCallback((): void => {
        if (!active.current) return;
        active.current = false;
        hovered.current = false;
        window.clearTimeout(timer.current);
        setOn(false);
        msg?.undo?.run();
    }, [msg]);

    return (
        <Ctx.Provider value={show}>
            {/* `children` keeps its element identity across a toast, so React bails out of
                re-rendering the app subtree every time the bar appears */}
            {children}
            {createPortal(
                // always mounted, only the class toggles: mounting with `.on` already set has no starting frame to transition from, so it would pop rather than rise
                <div
                    ref={element}
                    className={on ? "toast on" : "toast"}
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    aria-hidden={!on}
                    onMouseEnter={() => {
                        hovered.current = true;
                        window.clearTimeout(timer.current);
                    }}
                    onMouseLeave={() => {
                        hovered.current = false;
                        scheduleDismiss();
                    }}
                    onFocusCapture={() => {
                        window.clearTimeout(timer.current);
                    }}
                    onBlurCapture={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget)) return;
                        scheduleDismiss();
                    }}
                >
                    <span>{msg?.text ?? ""}</span>
                    {msg?.undo && (
                        <button
                            type="button"
                            className="u"
                            disabled={!on}
                            tabIndex={on ? 0 : -1}
                            onClick={undo}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                            }}
                        >
                            {msg.undo.label}
                        </button>
                    )}
                </div>,
                host?.isConnected ? host : document.body,
            )}
        </Ctx.Provider>
    );
}
