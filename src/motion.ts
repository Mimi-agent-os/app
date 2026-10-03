// Route changes as View Transitions and list reorders as FLIP; styles.css owns every duration and curve.
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";

const REDUCED = "(prefers-reduced-motion: reduce)";

let running: ViewTransition | null = null;
let reset: ReturnType<typeof setTimeout> | undefined;
let timing: { duration: number; easing: string } | null = null;

if (typeof document !== "undefined" && "startViewTransition" in document) document.documentElement.dataset["vt"] = "";

/** Runs `update` inside a View Transition whose CSS reads `html[data-nav]`; without the API, `data-nav` drives the fallback animation. */
export function navigate(update: () => void, direction: "forward" | "back"): void {
    if (typeof document === "undefined" || matchMedia(REDUCED).matches) {
        update();
        return;
    }
    const root = document.documentElement;
    root.dataset["nav"] = direction;
    if (document.startViewTransition) {
        running?.skipTransition();
        const transition = document.startViewTransition(() => flushSync(update));
        running = transition;
        const done = (): void => {
            if (running !== transition) return;
            running = null;
            delete root.dataset["nav"];
        };
        transition.finished.then(done, done);
        return;
    }
    update();
    clearTimeout(reset);
    // longer than --dur-3, so the fallback animation is never cut
    reset = setTimeout(() => { delete root.dataset["nav"]; }, 240);
}

/** Slides the `[data-flip]` rows inside `list` from where they were whenever `order` changes; rows new to the list fade in. */
export function useFlip(list: RefObject<HTMLElement | null>, order: string): void {
    const last = useRef<{ order: string; tops: Map<string, number>; painted: boolean } | null>(null);
    // measured after every render, so a reorder never starts from positions an unrelated layout change made stale
    useLayoutEffect(() => {
        const root = list.current;
        // a hidden list (the phone's Home under a pushed screen) has no positions to start from
        if (!root || root.getClientRects().length === 0) {
            last.current = null;
            return;
        }
        const base = root.getBoundingClientRect().top - root.scrollTop;
        const rows = [...root.querySelectorAll<HTMLElement>("[data-flip]")];
        const tops = new Map(rows.map((el) => [el.dataset["flip"] ?? "", el.getBoundingClientRect().top - base]));
        const before = last.current;
        const now = { order, tops, painted: false };
        last.current = now;
        requestAnimationFrame(() => { now.painted = true; });
        // positions replaced before they were ever painted (a render in the same frame) are nothing the owner saw move
        if (!before?.painted || before.order === order || matchMedia(REDUCED).matches) return;
        const moves = rows.map((el) => {
            const key = el.dataset["flip"] ?? "";
            const was = before.tops.get(key);
            return { el, dy: was === undefined ? null : was - (tops.get(key) ?? was) };
        });
        if (moves.filter(({ dy }) => Math.abs(dy ?? 0) > 0.5).length > 24) return;
        if (!timing) {
            const style = getComputedStyle(document.documentElement);
            timing = { duration: parseFloat(style.getPropertyValue("--dur-2")), easing: style.getPropertyValue("--ease-move").trim() };
        }
        // a missing token would make animate() throw
        if (!(timing.duration > 0) || !timing.easing) return;
        for (const { el, dy } of moves) {
            if (dy === null) el.animate([{ opacity: 0 }, { opacity: 1 }], timing);
            else if (Math.abs(dy) > 0.5) {
                // a row climbing past others is lifted over them for the move (data-lift in layout.css), so its title never runs through theirs
                if (dy > 0) el.dataset["lift"] = "";
                const drop = (): void => { delete el.dataset["lift"]; };
                el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], timing).finished.then(drop, drop);
            }
        }
    });
}
