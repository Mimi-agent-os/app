// The ⌘K palette: it knows only a `Command` list, never which screens exist.
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactElement } from "react";

import { holdBack, releaseBack } from "../route.ts";
import { Icon, type IconName } from "./icon.tsx";
import { Dot, type DotState } from "./ui.tsx";

// the order is fixed here, not per caller, so a group never moves; `cap` shortens a group only while nothing is typed
const GROUPS = [
    { id: "needs", label: "Needs you", cap: Infinity },
    { id: "recent", label: "Recent chats", cap: 12 },
    { id: "goto", label: "Go to", cap: Infinity },
    { id: "do", label: "Actions", cap: Infinity },
] as const;

type GroupId = (typeof GROUPS)[number]["id"];

export interface Command {
    /** Unique across the list: it is the React key and the `initial` a caller preselects. */
    id: string;
    label: string;
    /** A quiet second line on the right: the agent, a time, a tool. */
    detail?: string | undefined;
    group: GroupId;
    icon?: IconName | undefined;
    dot?: DotState | undefined;
    /** Display only: binding the keys is the shell's job. */
    hint?: string | undefined;
    /** Opts the command into the composer's slash menu (see matchSlash). */
    slash?: `/${string}` | undefined;
    keywords?: string | undefined;
    run: () => void | Promise<void>;
}

// once the draft has whitespace ("/model gpt-oss"), only an exact command name matches
export function matchSlash(commands: readonly Command[], typed: string): Command[] {
    const text = typed.trimStart();
    if (!text.startsWith("/")) return [];
    const word = (text.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
    const settled = /\s/.test(text);
    return commands.filter((c) => {
        if (c.slash === undefined) return false;
        const name = c.slash.slice(1).toLowerCase();
        return settled ? name === word : name.startsWith(word);
    });
}

interface PaletteControl {
    readonly isOpen: boolean;
    open: () => void;
    /** Opens with this query already typed, e.g. "new chat" to pick an agent for a new chat. */
    openWith: (query: string) => void;
    readonly seed: string;
    close: () => void;
    toggle: () => void;
    readonly commands: readonly Command[];
    readonly initial: string | undefined;
    readonly run: (command: Command) => Promise<void>;
}

interface PaletteOptions {
    commands: readonly Command[];
    /** A `run` that threw: the palette has closed by then, so this is the only place left to report it. */
    onError?: (error: Error, command: Command) => void;
    /** The command preselected while the query is empty. */
    initial?: string | undefined;
}

export function usePalette({ commands, onError, initial }: PaletteOptions): PaletteControl {
    const [isOpen, setIsOpen] = useState(false);
    const [seed, setSeed] = useState("");
    // ⌘K from a half-typed composer gives the caret back on close
    const restore = useRef<HTMLElement | null>(null);

    const open = useCallback((): void => {
        const active = document.activeElement;
        restore.current = active instanceof HTMLElement ? active : null;
        setSeed("");
        setIsOpen(true);
    }, []);

    const openWith = useCallback((query: string): void => {
        open();
        setSeed(query);
    }, [open]);

    const close = useCallback((): void => {
        setIsOpen(false);
        if (restore.current?.isConnected) restore.current.focus({ preventScroll: true });
        restore.current = null;
    }, []);

    useEffect(() => {
        if (!isOpen) return undefined;
        const hold = holdBack(close);
        return () => releaseBack(hold);
    }, [isOpen, close]);

    const toggle = useCallback((): void => {
        if (isOpen) close();
        else open();
    }, [isOpen, open, close]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.isComposing || e.defaultPrevented) return;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                // browsers bind ⌘K to their own search box
                e.preventDefault();
                // a question or the Connection screen is up, and the palette would open behind it
                if (e.repeat || (!isOpen && document.querySelector(".dlg[aria-modal], dialog[open]"))) return;
                if (isOpen) close();
                else open();
            } else if (e.key === "Escape" && isOpen) {
                // chat.tsx binds Escape on window as "deny" for an open gate; closing the palette must never answer it
                e.stopPropagation();
                close();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [isOpen, open, close]);

    const run = useCallback(
        async (command: Command): Promise<void> => {
            close();
            try {
                await command.run();
            } catch (e) {
                onError?.(e instanceof Error ? e : new Error(String(e)), command);
            }
        },
        [close, onError],
    );

    return useMemo(
        () => ({ isOpen, open, openWith, seed, close, toggle, commands, initial, run }),
        [isOpen, open, openWith, seed, close, toggle, commands, initial, run],
    );
}

export function Palette({ control }: { control: PaletteControl }): ReactElement | null {
    if (!control.isOpen) return null;
    return createPortal(
        <>
            <div className="overlay on" onClick={control.close} />
            {/* mounted only while open, so the query and the cursor are new every time */}
            <Body control={control} />
        </>,
        document.body,
    );
}

function Body({ control }: { control: PaletteControl }): ReactElement {
    const [query, setQuery] = useState(control.seed);
    // null until the owner moves the cursor: the preselected command holds it until then
    const [cursor, setCursor] = useState<number | null>(null);
    const input = useRef<HTMLInputElement | null>(null);
    const list = useRef<HTMLDivElement | null>(null);
    const id = useId();

    useEffect(() => {
        input.current?.focus();
    }, []);

    // in group order, so ↑ and ↓ walk the screen top to bottom
    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        const terms = q.split(/\s+/);
        // with nothing typed, a long group shows its first few, and always the preselected command
        const found = !q ? GROUPS.flatMap((g) => control.commands.filter((c) => c.group === g.id).filter((c, i) => i < g.cap || c.id === control.initial))
            : q.startsWith("/") ? matchSlash(control.commands, q)
            : control.commands.filter((c) => {
                const group = GROUPS.find((g) => g.id === c.group)?.label ?? "";
                const hay = `${c.label} ${c.detail ?? ""} ${group} ${c.slash ?? ""} ${c.keywords ?? ""}`.toLowerCase();
                return terms.every((t) => hay.includes(t));
            });
        return GROUPS.flatMap((g) => found.filter((c) => c.group === g.id));
    }, [control.commands, control.initial, query]);

    // clamped, not reset: `commands` is live, so the cursor can point past the end mid-render
    const preselected = query.trim() === "" ? Math.max(0, rows.findIndex((c) => c.id === control.initial)) : 0;
    const at = rows.length === 0 ? -1 : Math.min(cursor ?? preselected, rows.length - 1);

    useEffect(() => {
        const container = list.current;
        const selected = container?.querySelector<HTMLElement>('[aria-selected="true"]');
        if (!container || !selected) return;
        const row = selected.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        if (row.top < viewport.top) container.scrollTop -= viewport.top - row.top;
        else if (row.bottom > viewport.bottom) container.scrollTop += row.bottom - viewport.bottom;
    }, [at, rows]);

    return (
        <div className="palette on" role="dialog" aria-modal="true" aria-label="Jump to">
            <input
                ref={input}
                type="text"
                placeholder="Jump to a chat, agent or command"
                value={query}
                role="combobox"
                aria-label="Jump to a chat, agent or command"
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
                aria-expanded="true"
                aria-controls={`${id}-rows`}
                aria-activedescendant={at < 0 ? undefined : `${id}-row-${at}`}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setCursor(null);
                }}
                onKeyDown={(e) => {
                    // IME composition owns Enter and the arrows until the candidate settles
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Tab") {
                        e.preventDefault();
                    } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        if (rows.length) setCursor((at + 1) % rows.length);
                    } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        if (rows.length) setCursor((at - 1 + rows.length) % rows.length);
                    } else if (e.key === "Enter") {
                        e.preventDefault();
                        // the gate's ⌘⏎ on window must not fire alongside this command
                        e.stopPropagation();
                        const c = rows[at];
                        if (c) void control.run(c);
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        control.close();
                    }
                }}
            />
            <div ref={list} className="palette-results" id={`${id}-rows`} role="listbox" aria-label="Results">
                {rows.length === 0 && <div className="grp" role="status">Nothing matches.</div>}
                {GROUPS.map((g) => {
                    const start = rows.findIndex((c) => c.group === g.id);
                    if (start < 0) return null;
                    return (
                        <Fragment key={g.id}>
                            <div className="grp" aria-hidden="true">{g.label}</div>
                            {rows
                                .filter((c) => c.group === g.id)
                                .map((c, k) => {
                                    const index = start + k;
                                    return (
                                        <div
                                            key={c.id}
                                            id={`${id}-row-${index}`}
                                            className={index === at ? "opt on" : "opt"}
                                            role="option"
                                            aria-selected={index === at}
                                            onMouseMove={() => { if (index !== at) setCursor(index); }}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => void control.run(c)}
                                        >
                                            {c.dot !== undefined && <Dot state={c.dot} />}
                                            {c.icon !== undefined && <Icon name={c.icon} sm />}
                                            <span className="opt-label">{c.label}</span>
                                            {c.detail && <span className="opt-detail">{c.detail}</span>}
                                            {c.hint && <kbd className="k">{c.hint}</kbd>}
                                        </div>
                                    );
                                })}
                        </Fragment>
                    );
                })}
            </div>
            <div className="palette-footer" aria-hidden="true">
                <span><kbd>↑</kbd> <kbd>↓</kbd> choose</span>
                <span><kbd>Enter</kbd> open</span>
                <span><kbd>Esc</kbd> close</span>
            </div>
        </div>
    );
}
