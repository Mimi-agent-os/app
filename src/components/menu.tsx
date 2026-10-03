// One action menu for every ⋯ and right-click: a floating list on desktop, a bottom sheet at ≤900px (menu.css only, no JS branch).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactElement } from "react";

import { holdBack, releaseBack } from "../route.ts";
import { Icon, type IconName } from "./icon.tsx";
import "../menu.css";

interface MenuItem {
    id: string;
    label: string;
    icon?: IconName | undefined;
    detail?: string | undefined;
    danger?: boolean | undefined;
    disabled?: boolean | undefined;
    run: () => void;
}

type MenuEntry = MenuItem | "sep";

const GAP = 4;
const EDGE = 8;

export function Menu({ label, items, at, onClose }: {
    label: string;
    items: readonly MenuEntry[];
    at: HTMLElement | { x: number; y: number };
    onClose: () => void;
}): ReactElement {
    const menu = useRef<HTMLDivElement | null>(null);
    const scrim = useRef<HTMLDivElement | null>(null);
    const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
    const close = useRef(onClose);
    close.current = onClose;

    useEffect(() => {
        const hold = holdBack(() => close.current());
        return () => releaseBack(hold);
    }, []);

    useLayoutEffect(() => {
        const el = menu.current;
        if (!el) return;
        const { offsetWidth: w, offsetHeight: h } = el;
        let x: number, y: number, origin: string;
        if (at instanceof HTMLElement) {
            const box = at.getBoundingClientRect();
            const above = box.bottom + GAP + h > innerHeight - EDGE && box.top - GAP - h >= EDGE;
            x = box.right - w;
            y = above ? box.top - GAP - h : box.bottom + GAP;
            origin = above ? "right bottom" : "right top";
        } else {
            ({ x, y } = at);
            origin = "left top";
        }
        x = Math.max(EDGE, Math.min(x, innerWidth - w - EDGE));
        y = Math.max(EDGE, Math.min(y, innerHeight - h - EDGE));
        setPlace({ "--x": `${x}px`, "--y": `${y}px`, transformOrigin: origin } as CSSProperties);
    }, [at]);

    useEffect(() => {
        const box = menu.current;
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        box?.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus({ preventScroll: true });
        const inside = (target: EventTarget | null): boolean => target instanceof Node && Boolean(box?.contains(target));
        const width = innerWidth;
        // the long press that opened the sheet is still on the glass: its drift is not a scroll
        let touched = false;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== "Escape") return;
            // capture phase: an Escape meant for the menu must never reach the chat's gate binding
            e.stopPropagation();
            e.preventDefault();
            close.current();
        };
        const onPointer = (e: PointerEvent): void => {
            // the sheet's scrim closes on its own click, so the tap never lands on the row beneath it
            if (inside(e.target) || e.target === scrim.current) return;
            // the ⋯ that opened the menu toggles it: its click would open it again, so that one click is eaten, and only that one
            if (at instanceof HTMLElement && e.target instanceof Node && at.contains(e.target)) {
                const eat = (c: MouseEvent): void => { c.stopPropagation(); c.preventDefault(); };
                const done = (): void => {
                    setTimeout(() => window.removeEventListener("click", eat, true));
                };
                window.addEventListener("click", eat, { capture: true, once: true });
                window.addEventListener("pointerup", done, { capture: true, once: true });
                window.addEventListener("pointercancel", done, { capture: true, once: true });
            }
            close.current();
        };
        // the owner scrolling, or a scroll carrying the anchor away; a thread streaming elsewhere scrolls too and must not close it
        const onWheel = (e: Event): void => {
            if (!inside(e.target)) close.current();
        };
        const onTouchStart = (): void => {
            touched = true;
        };
        const onTouchMove = (e: Event): void => {
            if (touched && !inside(e.target)) close.current();
        };
        const onScroll = (e: Event): void => {
            if (at instanceof HTMLElement && e.target instanceof Node && e.target.contains(at)) close.current();
        };
        // the phone keyboard going away changes only the height
        const onResize = (): void => {
            if (innerWidth !== width) close.current();
        };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("pointerdown", onPointer, true);
        window.addEventListener("wheel", onWheel, { capture: true, passive: true });
        window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
        window.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("pointerdown", onPointer, true);
            window.removeEventListener("wheel", onWheel, true);
            window.removeEventListener("touchstart", onTouchStart, true);
            window.removeEventListener("touchmove", onTouchMove, true);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onResize);
            // an item that opened a dialog or moved elsewhere keeps its focus
            const now = document.activeElement;
            if ((now === null || now === document.body || inside(now)) && opener?.isConnected) opener.focus({ preventScroll: true });
        };
    }, [at]);

    return createPortal(
        <>
            <div ref={scrim} className="menu-scrim" aria-hidden="true" onClick={onClose} />
            <div
                ref={menu}
                className="menu"
                role="menu"
                aria-label={label}
                style={place}
                onKeyDown={(e) => {
                    if (e.key === "Tab") {
                        e.preventDefault();
                        onClose();
                        return;
                    }
                    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
                    const now = list.indexOf(document.activeElement as HTMLButtonElement);
                    const next =
                        e.key === "ArrowDown" ? (now + 1) % list.length
                        : e.key === "ArrowUp" ? (now <= 0 ? list.length - 1 : now - 1)
                        : e.key === "Home" ? 0
                        : e.key === "End" ? list.length - 1
                        : -1;
                    if (next < 0 || list.length === 0) return;
                    e.preventDefault();
                    list[next]?.focus();
                }}
            >
                {items.map((item, i) =>
                    item === "sep" ? (
                        <hr key={`sep${i}`} className="menu-sep" role="separator" />
                    ) : (
                        <button
                            key={item.id}
                            type="button"
                            className="menu-item"
                            role="menuitem"
                            data-danger={item.danger ? "" : undefined}
                            disabled={item.disabled}
                            onClick={() => {
                                onClose();
                                item.run();
                            }}
                        >
                            {item.icon && <Icon name={item.icon} sm />}
                            <span>{item.label}</span>
                            {item.detail && <span className="menu-detail">{item.detail}</span>}
                        </button>
                    ),
                )}
            </div>
        </>,
        document.body,
    );
}
