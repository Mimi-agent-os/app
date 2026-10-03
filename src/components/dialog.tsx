/** In-app stand-in for window.confirm/prompt: one dialog at a time, asking again cancels the first. */
import {
    Fragment,
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import type { ReactElement, ReactNode } from "react";

import { holdBack, releaseBack, type Hold } from "../route.ts";

interface ConfirmOptions {
    title: string;
    body?: string;
    ok?: string;
    cancel?: string;
    /** Destructive: the ok button turns red and Enter stops being a shortcut to it. */
    danger?: boolean;
}

interface PromptOptions {
    title: string;
    body?: string;
    initial?: string;
    placeholder?: string;
    ok?: string;
    cancel?: string;
}

interface Dialog {
    confirm(options: ConfirmOptions): Promise<boolean>;
    /** Resolves the trimmed input, or null on cancel. */
    prompt(options: PromptOptions): Promise<string | null>;
}

const Ctx = createContext<Dialog | null>(null);

export function useDialog(): Dialog {
    const dialog = useContext(Ctx);
    if (!dialog) throw new Error("useDialog() used outside <DialogProvider>");
    return dialog;
}

type Ask =
    | {
          kind: "confirm";
          title: string;
          body: string;
          ok: string;
          cancel: string;
          danger: boolean;
          resolve: (yes: boolean) => void;
      }
    | {
          kind: "prompt";
          title: string;
          body: string;
          initial: string;
          placeholder: string;
          ok: string;
          cancel: string;
          resolve: (value: string | null) => void;
      };

// a promise must settle exactly once — this is the one path for backdrop, button, Escape, and displacement by a newer question
function dismiss(ask: Ask): void {
    if (ask.kind === "confirm") ask.resolve(false);
    else ask.resolve(null);
}

export function DialogProvider({ children }: { children: ReactNode }): ReactElement {
    const [ask, setAsk] = useState<Ask | null>(null);
    // mirror of `ask` readable from the stable callbacks below, so they never need rebinding
    const live = useRef<Ask | null>(null);
    // bumped per question and used as a key: a prompt replacing a prompt must remount the card, or defaultValue/autoFocus would show the old question's state
    const seq = useRef(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const pressedShade = useRef(false);
    const restore = useRef<HTMLElement | null>(null);
    // the question holds a history entry of its own, so Back (Android's key, the edge swipe) cancels it instead of leaving the screen under it
    const hold = useRef<Hold | null>(null);
    const id = useId();

    // the card goes at once; the answer lands after its entry is popped, so a caller that navigates next never loses its own entry to that pop
    const settle = useCallback((answer: (a: Ask) => void): void => {
        const a = live.current;
        if (!a) return;
        live.current = null;
        setAsk(null);
        if (restore.current?.isConnected) restore.current.focus({ preventScroll: true });
        restore.current = null;
        const held = hold.current;
        hold.current = null;
        if (held) releaseBack(held, () => answer(a));
        else answer(a);
    }, []);

    const cancel = useCallback((): void => settle(dismiss), [settle]);

    const open = useCallback((next: Ask): void => {
        if (live.current) dismiss(live.current);
        else {
            restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            hold.current = holdBack(() => {
                hold.current = null;
                cancel();
            });
        }
        live.current = next;
        seq.current += 1;
        setAsk(next);
    }, [cancel]);

    const accept = useCallback((): void => {
        const value = inputRef.current?.value.trim() ?? "";
        settle((a) => (a.kind === "confirm" ? a.resolve(true) : a.resolve(value)));
    }, [settle]);

    // capture phase, stopPropagation on both keys: chat.tsx's global gate bindings must not see them while this card is up
    useEffect(() => {
        if (!ask) return undefined;
        const onKey = (e: KeyboardEvent): void => {
            if (e.isComposing) {
                if (e.key === "Enter" || e.key === "Escape") e.stopPropagation();
                return;
            }
            if (e.key === "Tab") {
                const controls = cardRef.current?.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
                );
                const first = controls?.[0];
                const last = controls?.[controls.length - 1];
                if (e.shiftKey && (document.activeElement === first || !cardRef.current?.contains(document.activeElement))) {
                    e.preventDefault();
                    last?.focus();
                } else if (!e.shiftKey && (document.activeElement === last || !cardRef.current?.contains(document.activeElement))) {
                    e.preventDefault();
                    first?.focus();
                }
                return;
            }
            if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                cancel();
                return;
            }
            if (e.key !== "Enter") return;
            e.stopPropagation();
            // a focused button keeps its native Enter-is-click — tabbing to «cancel» and
            // pressing Enter must cancel, not submit over the user's head
            if (e.target instanceof HTMLButtonElement) return;
            if (ask.kind === "prompt" || !ask.danger) {
                e.preventDefault();
                accept();
            }
            // danger confirm with focus astray: Enter does nothing, by design
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [ask, cancel, accept]);

    useEffect(() => () => {
        if (live.current) dismiss(live.current);
        live.current = null;
        if (hold.current) releaseBack(hold.current);
        hold.current = null;
    }, []);

    const api = useMemo<Dialog>(
        () => ({
            confirm: (o) =>
                new Promise((resolve) =>
                    open({
                        kind: "confirm",
                        title: o.title,
                        body: o.body ?? "",
                        ok: o.ok ?? "OK",
                        cancel: o.cancel ?? "Cancel",
                        danger: o.danger ?? false,
                        resolve,
                    }),
                ),
            prompt: (o) =>
                new Promise((resolve) =>
                    open({
                        kind: "prompt",
                        title: o.title,
                        body: o.body ?? "",
                        initial: o.initial ?? "",
                        placeholder: o.placeholder ?? "",
                        ok: o.ok ?? "OK",
                        cancel: o.cancel ?? "Cancel",
                        resolve,
                    }),
                ),
        }),
        [open],
    );

    // raw <button>s, not <Btn> — Btn forwards no autoFocus, and the keyed Fragment below remounts the card for every question so autoFocus alone starts focus on the safe answer
    const danger = ask?.kind === "confirm" && ask.danger;
    return (
        <Ctx.Provider value={api}>
            {children}
            {ask &&
                createPortal(
                    <Fragment key={seq.current}>
                        {/* `.dlgback` lifts this shade above the modal's own `.mback`, and centres the card inside it */}
                        <div
                            className="mback dlgback"
                            // only a press that starts and ends on the shade dismisses: a text selection dragged out of the input must not
                            onPointerDown={(e) => { pressedShade.current = e.target === e.currentTarget; }}
                            onClick={(e) => { if (pressedShade.current && e.target === e.currentTarget) cancel(); }}
                        >
                            <div
                                ref={cardRef}
                                className="dlg"
                                role={danger ? "alertdialog" : "dialog"}
                                aria-modal="true"
                                aria-labelledby={`${id}-title`}
                                aria-describedby={ask.body ? `${id}-body` : undefined}
                            >
                                <h2 id={`${id}-title`}>{ask.title}</h2>
                                {ask.body && <p id={`${id}-body`}>{ask.body}</p>}
                                {ask.kind === "prompt" && (
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        aria-labelledby={`${id}-title`}
                                        defaultValue={ask.initial}
                                        placeholder={ask.placeholder}
                                        autoFocus
                                        // like window.prompt: the initial value arrives selected,
                                        // so typing replaces and editing is one arrow-key away
                                        onFocus={(e) => e.currentTarget.select()}
                                    />
                                )}
                                <div className="btns">
                                    <button type="button" className="btn" autoFocus={danger} onClick={cancel}>
                                        {ask.cancel}
                                    </button>
                                    <button
                                        type="button"
                                        className={danger ? "btn danger" : "btn primary"}
                                        autoFocus={ask.kind === "confirm" && !ask.danger}
                                        onClick={accept}
                                    >
                                        {ask.ok}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </Fragment>,
                    // a modal <dialog> (the Connection screen) makes the rest of the page inert, so a question about it is asked inside it
                    document.querySelector("dialog[open]") ?? document.body,
                )}
        </Ctx.Provider>
    );
}
