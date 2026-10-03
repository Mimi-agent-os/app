import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../shared.ts";
import { androidApp, tauriInvoke } from "../tauri.ts";
import { gatewayAddress } from "../channel.ts";
import { go, holdBack, releaseBack } from "../route.ts";
import mascot from "../assets/mimi-mascot.png";
import { Icon } from "./icon.tsx";
import "../desktop-menu.css";
import "../menu.css";

export function DesktopMenu({ brand = false, rail = false, gate = false }: { brand?: boolean; rail?: boolean; gate?: boolean }): ReactElement | null {
    // Android has the system's own ways to leave, and Reload sits in Settings > This device
    const invoke = androidApp ? null : tauriInvoke();
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const scrim = useRef<HTMLDivElement>(null);
    const last = useRef(false);
    const working = useRef(false);
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [position, setPosition] = useState({ left: 8, top: 8 });

    const close = useCallback((restoreFocus = true): void => {
        setOpen(false);
        if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    }, []);

    useLayoutEffect(() => {
        if (!open || !trigger.current || !menu.current) return;
        const anchor = trigger.current.getBoundingClientRect();
        const panel = menu.current.getBoundingClientRect();
        setPosition({
            left: Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8)),
            top: Math.max(8, anchor.bottom + panel.height + 16 <= window.innerHeight
                ? anchor.bottom + 8 : anchor.top - panel.height - 8),
        });
        const items = menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
        (last.current ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
    }, [open, error]);

    useEffect(() => {
        if (!open) return;
        const hold = holdBack(() => close(false));
        // the phone's scrim closes on its own click, so the tap that dismisses the menu never lands on the row beneath it
        const outside = (event: Event): void => {
            if (event.target instanceof Node && event.target !== scrim.current && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close(false);
        };
        const moved = (): void => close(false);
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("focusin", outside);
        window.addEventListener("resize", moved);
        return () => {
            releaseBack(hold);
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("focusin", outside);
            window.removeEventListener("resize", moved);
        };
    }, [open, close]);

    if (!invoke) return null;

    const quit = async (): Promise<void> => {
        if (working.current) return;
        working.current = true;
        setPending("quit_app");
        setError("");
        try {
            await invoke("quit_app");
            close(false);
        } catch (reason) {
            setError(errorMessage(reason, "Could not complete this action. Try again."));
            setOpen(true);
        } finally {
            working.current = false;
            setPending(null);
        }
    };
    const connections = (): void => { close(false); go({ at: "settings", section: "connection" }); };

    return <>
        <button ref={trigger} type="button" className={`desktop-menu-trigger${brand ? " brand" : ""}${rail ? " rail" : ""}`}
            aria-label="Application menu" title="Application menu" aria-haspopup="menu" aria-expanded={open}
            aria-controls={open ? id : undefined} disabled={pending !== null}
            onClick={() => { last.current = false; setError(""); setOpen(value => !value); }}
            onKeyDown={event => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    last.current = event.key === "ArrowUp";
                    setError("");
                    setOpen(true);
                }
            }}>
            {brand ? <><img src={mascot} alt="" /><span className="wm">mimi-os</span><Icon name="chevron" sm /></> : <Icon name="more" />}
        </button>
        {open && createPortal(<><div ref={scrim} className="menu-scrim" aria-hidden="true" onClick={() => close(false)} /><div ref={menu} id={id} className="desktop-app-menu" role="menu" aria-label="mimi application"
            style={position} onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
                else if (event.key === "Tab") { event.stopPropagation(); close(); }
                else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
                    const current = items.indexOf(document.activeElement as HTMLButtonElement);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                    items[next]?.focus();
                }
            }}>
            <div className="desktop-menu-caption" role="presentation"><strong>mimi</strong><span title={gatewayAddress()}>{gatewayAddress()}</span></div>
            {!gate && <button type="button" role="menuitem" disabled={pending !== null} onClick={connections}><Icon name="settings" /><span>Connection</span><Icon name="chevron" sm /></button>}
            <button type="button" role="menuitem" disabled={pending !== null} onClick={() => location.reload()}><Icon name="refresh" /><span>Reload</span></button>
            <div className="desktop-menu-divider" role="separator" />
            <button type="button" role="menuitem" className="desktop-menu-quit" disabled={pending !== null} onClick={() => void quit()}><Icon name="power" /><span>{pending === "quit_app" ? "Quitting…" : "Quit mimi"}</span></button>
            {error && <p className="desktop-menu-error" role="alert">{error}</p>}
        </div></>, trigger.current?.closest("dialog") ?? document.body)}
    </>;
}
