// A pasted text as a card (in the box, in an edit and in your message), the row of them over a text box, and the viewer every card opens.
import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, ReactElement, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";

import type { Paste } from "@mimi-os/protocol";

import { textSize } from "../pasted.ts";
import { holdBack, releaseBack } from "../route.ts";
import { plural } from "../shared.ts";
import { Icon } from "./icon.tsx";
import { CopyTextButton } from "./markdown.tsx";

/** The whole card opens the viewer; in a box it also comes out (×) or goes into the text as it is. */
export function PasteCard({ paste, preview, onOpen, onRemove, onInsert }: {
    paste: Paste;
    /** How many of its first lines with words in them show, each ended by the stylesheet, never cut here. */
    preview: 1 | 2;
    onOpen: (paste: Paste, from: HTMLButtonElement) => void;
    onRemove?: (() => void) | undefined;
    onInsert?: (() => void) | undefined;
}): ReactElement {
    // the box re-renders on every keystroke, and a paste can be a megabyte: the lines are read lazily, up to the ones shown
    const { meta, head } = useMemo(() => {
        const lines: string[] = [];
        for (const [line] of paste.text.matchAll(/^.*\S.*$/gm)) {
            if (lines.push(line) === preview) break;
        }
        return { meta: `${paste.lines} ${plural(paste.lines, "line", "lines")} · ${textSize(paste.text)}`, head: lines };
    }, [paste, preview]);
    return (
        <div className="paste-card">
            <button type="button" className="paste-open" aria-label={`Open ${paste.title}`} onClick={(e) => onOpen(paste, e.currentTarget)}>{paste.title}</button>
            {onRemove ? (
                <button type="button" className="paste-x" aria-label={`Remove ${paste.title}`} title="Remove" onClick={onRemove}><Icon name="close" sm /></button>
            ) : (
                <span className="paste-meta">{meta}</span>
            )}
            {head.map((line, i) => <span key={i} className="paste-line">{line}</span>)}
            {onRemove && <span className="paste-meta">{meta}</span>}
            {onInsert && <button type="button" className="paste-insert" onClick={onInsert}>Insert as text</button>}
        </div>
    );
}

/** The cards over a text box (the composer's, an edit's): Insert puts a text in at the caret, and × never drops focus onto the page's top. */
export function BoxCards({ pastes, box, onOpen, setPastes, setText }: {
    pastes: readonly Paste[];
    box: RefObject<HTMLTextAreaElement | null>;
    onOpen: (paste: Paste, from: HTMLButtonElement) => void;
    setPastes: Dispatch<SetStateAction<Paste[]>>;
    setText: (text: string) => void;
}): ReactElement {
    return (
        <div className="paste-cards">
            {pastes.map((p, i) => (
                // index keys: a card holds no state, two may carry the same text, and a removed card's slot, focused × included, passes to the next
                <PasteCard
                    key={i}
                    paste={p}
                    preview={1}
                    onOpen={onOpen}
                    onRemove={() => {
                        if (i === pastes.length - 1 && matchMedia("(pointer: fine)").matches) box.current?.focus();
                        setPastes((cur) => cur.filter((x) => x !== p));
                    }}
                    onInsert={() => {
                        const el = box.current;
                        if (!el) return;
                        setText(el.value.slice(0, el.selectionStart) + p.text + el.value.slice(el.selectionEnd));
                        setPastes((cur) => cur.filter((x) => x !== p));
                        if (matchMedia("(pointer: fine)").matches) el.focus();
                    }}
                />
            ))}
        </div>
    );
}

export function PasteViewer({ paste, from, onClose }: { paste: Paste; from: HTMLButtonElement; onClose: () => void }): ReactElement {
    const shade = useRef<HTMLDivElement | null>(null);
    const body = useRef<HTMLPreElement | null>(null);
    const pressed = useRef(false);
    const close = (): void => {
        if (from.isConnected) from.focus({ preventScroll: true });
        onClose();
    };
    const latest = useRef(close);
    latest.current = close;
    // keys on window like the image viewer: nothing behind the sheet may act on them, and select-all stays inside the text
    useEffect(() => {
        const box = shade.current;
        if (!box) return undefined;
        const hold = holdBack(() => latest.current());
        const onKey = (e: KeyboardEvent): void => {
            e.stopPropagation();
            if (e.key === "Escape") latest.current();
            else if (e.key === "a" && (e.metaKey || e.ctrlKey) && body.current) getSelection()?.selectAllChildren(body.current);
            else if (e.key === "Tab") {
                const stops = box.querySelectorAll<HTMLElement>("button, pre");
                if (box.contains(document.activeElement) && document.activeElement !== stops[e.shiftKey ? 0 : stops.length - 1]) return;
                stops[e.shiftKey ? stops.length - 1 : 0]?.focus();
            } else return;
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey, true);
        return () => {
            releaseBack(hold);
            window.removeEventListener("keydown", onKey, true);
        };
    }, []);

    return createPortal(
        <div
            ref={shade}
            className="mback dlgback paste-viewer"
            role="dialog"
            aria-modal="true"
            aria-label={paste.title}
            // only a press that starts and ends on the shade closes: a selection dragged out of the text must not
            onPointerDown={(e) => { pressed.current = e.target === e.currentTarget; }}
            onClick={(e) => { if (pressed.current && e.target === e.currentTarget) close(); }}
        >
            <div className="paste-sheet">
                <header className="paste-sheet-head">
                    <h2>{paste.title}</h2>
                    <span className="paste-sheet-meta">{paste.lines} {plural(paste.lines, "line", "lines")} · {textSize(paste.text)}</span>
                    <CopyTextButton text={paste.text} label="Copy text" />
                    <button type="button" className="btn icon" aria-label="Close" title="Close (Escape)" autoFocus onClick={close}><Icon name="close" /></button>
                </header>
                <pre ref={body} tabIndex={0}>{paste.text}</pre>
            </div>
        </div>,
        document.body,
    );
}
