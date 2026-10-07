// The chat's message box: it owns the draft, staged images, pasted-text cards and the slash menu, so a keystroke re-renders only this.
import { memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, Ref } from "react";

import { buildPasted, parsePasted, type Paste } from "@mimi-os/protocol";

import { Icon } from "../components/icon.tsx";
import { matchSlash, type Command } from "../components/palette.tsx";
import { BoxCards } from "../components/paste-card.tsx";
import { Btn } from "../components/ui.tsx";
import { isLongPaste, newPaste, readDropped, tooLarge } from "../pasted.ts";
import { errorMessage, kilo, plural, SOFT_KEYS } from "../shared.ts";

// wire contract: at most 4 images and 750 000 data-URI bytes per message (a channel frame is 1 MiB)
const MAX_IMAGES = 4;
const IMAGE_BUDGET = 750_000 / MAX_IMAGES;
const IMAGE_STEPS: readonly [edge: number, quality: number][] = [[1024, 0.8], [1024, 0.6], [768, 0.6], [512, 0.55]];

/** A JPEG data-URI under IMAGE_BUDGET, so any four always fit one message together, or null. */
async function downscaleImage(file: File): Promise<string | null> {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This browser gave no 2D canvas to downscale with.");
        for (const [edge, quality] of IMAGE_STEPS) {
            const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const uri = canvas.toDataURL("image/jpeg", quality);
            if (uri.length <= IMAGE_BUDGET) return uri;
        }
        return null;
    } finally {
        bitmap.close();
    }
}

// session storage survives a reload while keeping drafts apart between browser tabs; a draft is kept as the message it would send
const DRAFTS = new Map<string, string>();
const DRAFT_KEY = "mimi-os:chat-draft";

// a draft moving to another agent's new chat: only that agent's composer takes it, once
let carried: { agent: string; text: string; images: string[] } | null = null;

/** Hands what the box held to the next composer that opens for `agent`. */
export function carryDraft(agent: string, text: string, images: string[]): void {
    carried = text.trim() || images.length > 0 ? { agent, text, images } : null;
}

export type SubmitResult = "sent" | "queued" | "drained" | "refused";

export interface ComposerHandle {
    /** Puts an unsent message back, its pasted texts as cards; false when the box already holds other words (images always come back). */
    restore(text: string, images: string[]): boolean;
    /** Empties the box, staged images and cards included, and returns what it held. */
    take(): { text: string; images: string[] };
    focus(): void;
    /** Files dropped on the chat: images staged the way the picker does, text files as cards, anything else named in a notice. */
    attach(files: File[]): void;
}

interface ComposerProps {
    agent: string;
    draftKey: string;
    busy: boolean;
    stopPending: boolean;
    /** The first history page is on screen, so a turn can be ordered against it. */
    ready: boolean;
    /** An approval is open: ⌘⏎ belongs to the gate card. */
    waiting: boolean;
    queued: number;
    canAttach: boolean;
    /** The current model's name when it cannot read images. */
    noImages: string | null;
    meter: { used: number; window: number; estimate: boolean; hot: boolean } | null;
    slash: readonly Command[];
    blocked: string | null;
    onSubmit: (text: string, images: string[]) => SubmitResult;
    onStop: () => void;
    onNotice: (text: string) => void;
    onOpenPaste: (paste: Paste, from: HTMLButtonElement) => void;
    ref?: Ref<ComposerHandle> | undefined;
}

function ComposerView({
    agent, draftKey, busy, stopPending, ready, waiting, queued, canAttach, noImages, meter, slash: commands, blocked,
    onSubmit, onStop, onNotice, onOpenPaste, ref,
}: ComposerProps): ReactElement {
    // read here, cleared by the effect below: StrictMode runs this twice and both runs must see it
    const [start] = useState(() => {
        let held = DRAFTS.get(draftKey) ?? "";
        try {
            held ||= sessionStorage.getItem(`${DRAFT_KEY}:${draftKey}`) ?? "";
        } catch {
            // storage disabled: the draft simply starts empty
        }
        const kept = parsePasted(held);
        const moved = parsePasted(carried?.agent === agent ? carried.text.trim() : "");
        return { text: kept.text && moved.text ? `${kept.text}\n\n${moved.text}` : kept.text || moved.text, pastes: [...kept.pastes, ...moved.pastes] };
    });
    const [draft, setDraft] = useState(start.text);
    const [pastes, setPastes] = useState<Paste[]>(start.pastes);
    // not persisted: a stale multi-megabyte data-URI is not worth a store
    const [images, setImages] = useState<string[]>(() => (carried?.agent === agent ? carried.images : []));
    const [slashDismissed, setSlashDismissed] = useState(false);
    const [slashActive, setSlashActive] = useState(0);
    const slashId = useId();
    const box = useRef<HTMLTextAreaElement | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const slash = slashDismissed ? [] : matchSlash(commands, draft);
    const slashAt = Math.min(slashActive, slash.length - 1);

    // stored as the message it would send, so the cards come back with the words; what was carried here is saved the same way
    useEffect(() => {
        const saved = buildPasted(pastes, draft);
        DRAFTS.set(draftKey, saved);
        try {
            // cleared first: a draft too big for the store must not leave an older one to come back on a reload
            sessionStorage.removeItem(`${DRAFT_KEY}:${draftKey}`);
            if (saved) sessionStorage.setItem(`${DRAFT_KEY}:${draftKey}`, saved);
        } catch {
            // full or disabled: the in-memory draft still carries this session
        }
    }, [draftKey, draft, pastes]);

    // once, on arrival: the state read above already holds what was carried
    useEffect(() => {
        if (carried?.agent === agent) carried = null;
    }, []);

    useImperativeHandle(ref, () => ({
        restore: (text, returned) => {
            // images staged meanwhile stay, after the ones coming back
            if (returned.length > 0) setImages((cur) => [...returned, ...cur].slice(0, MAX_IMAGES));
            if (box.current?.value.trim() || pastes.length > 0) return false;
            const back = parsePasted(text);
            setDraft(back.text);
            setPastes(back.pastes);
            return true;
        },
        take: () => {
            const held = { text: buildPasted(pastes, box.current?.value ?? draft), images };
            setDraft("");
            setPastes([]);
            setImages([]);
            return held;
        },
        focus: () => box.current?.focus(),
        attach: (files) => {
            void (async () => {
                const pics: File[] = [];
                const added: Paste[] = [];
                const notes: string[] = [];
                for (const file of files) {
                    const got = await readDropped(file).catch(() => ({ kind: "refused", reason: `${file.name} could not be read.` }) as const);
                    if (got.kind === "image") pics.push(file);
                    else if (got.kind === "text") added.push(got.paste);
                    else notes.push(got.reason);
                }
                if (added.length > 0) setPastes((cur) => [...cur, ...added]);
                if (pics.length > 0 && !canAttach && noImages) notes.push(`${noImages} cannot read images.`);
                if (pics.length > 0 && canAttach) await addFiles(pics, notes);
                else if (notes.length > 0) onNotice(notes.join(" "));
            })();
        },
    }));

    // height follows the content; the stylesheet's max-height caps it
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }, [draft]);

    const runCommand = (c: Command): void => {
        setDraft("");
        void Promise.resolve().then(() => c.run()).catch((e: unknown) => onNotice(errorMessage(e)));
    };

    const submit = (): void => {
        const command = slash[slashAt];
        if (command) {
            runCommand(command);
            return;
        }
        const text = buildPasted(pastes, draft.trim());
        // everything stays in the box: the gateway would refuse the whole request
        const over = tooLarge(text, busy ? [] : images);
        if (over) {
            onNotice(over);
            return;
        }
        const result = onSubmit(text, images);
        if (result === "sent") setImages([]);
        if (result === "sent" || result === "queued") {
            setDraft("");
            setPastes([]);
        }
        if (result === "queued" && images.length > 0) onNotice("A queued message carries text only. The images stay in the box for your next message.");
        if (result === "refused" && busy && !text && images.length > 0) onNotice("A queued message carries text only. The images stay in the box until this turn ends.");
    };

    /** Stages what fits; whatever is dropped is said out loud, after the notes the caller brings, rather than silently discarded. */
    const addFiles = async (files: File[], notes: string[] = []): Promise<void> => {
        const pics = canAttach ? files.filter((f) => f.type.startsWith("image/")) : [];
        const room = MAX_IMAGES - images.length;
        if (pics.length > 0 && room <= 0) notes.push(`A message carries at most ${MAX_IMAGES} images.`);
        if (pics.length === 0 || room <= 0) {
            if (notes.length) onNotice(notes.join(" "));
            return;
        }
        let tooBig = 0;
        let unreadable = 0;
        const added: string[] = [];
        for (const file of pics.slice(0, room)) {
            try {
                const uri = await downscaleImage(file);
                if (uri === null) tooBig += 1;
                else added.push(uri);
            } catch {
                unreadable += 1;
            }
        }
        if (added.length) setImages((cur) => [...cur, ...added].slice(0, MAX_IMAGES));
        if (pics.length > room) notes.push(`Only ${room} more ${plural(room, "image fits", "images fit")}, a message holds ${MAX_IMAGES}.`);
        if (tooBig) notes.push(`${tooBig} too detailed to shrink under ${Math.round(IMAGE_BUDGET / 1000)} KB ${plural(tooBig, "was", "were")} skipped.`);
        if (unreadable) notes.push(`${unreadable} could not be read.`);
        if (notes.length) onNotice(notes.join(" "));
    };

    const pct = meter ? Math.min(100, Math.round((meter.used / meter.window) * 100)) : 0;
    const empty = !draft.trim() && images.length === 0 && pastes.length === 0;

    return (
        <div className="composer" data-blocked={blocked === null ? undefined : ""}>
            {slash.length > 0 && (
                <div className="slash-menu" role="listbox" id={slashId} aria-label="Chat commands">
                    {slash.map((c, i) => (
                        <div
                            key={c.id}
                            id={`${slashId}-${i}`}
                            className="slash-opt"
                            role="option"
                            aria-selected={i === slashAt}
                            onMouseEnter={() => setSlashActive(i)}
                            // mousedown, not click: blurring the textarea first would close the menu before the click landed
                            onMouseDown={(e) => {
                                e.preventDefault();
                                runCommand(c);
                            }}
                        >
                            {c.icon && <Icon name={c.icon} sm />}
                            {c.label}
                            <kbd>{c.slash}</kbd>
                        </div>
                    ))}
                </div>
            )}
            {images.length > 0 && (
                <div className="composer-thumbs">
                    {images.map((src, i) => (
                        <div key={i} className="composer-thumb">
                            <img src={src} alt="" />
                            <button type="button" aria-label={`Remove image ${i + 1}`} onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                                <Icon name="close" sm />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {pastes.length > 0 && <BoxCards pastes={pastes} box={box} onOpen={onOpenPaste} setPastes={setPastes} setText={setDraft} />}
            <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                    void addFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                }}
            />
            <textarea
                ref={box}
                rows={1}
                autoFocus={matchMedia("(pointer: fine)").matches}
                aria-label={`Message ${agent}`}
                aria-controls={slash.length > 0 ? slashId : undefined}
                aria-activedescendant={slashAt >= 0 ? `${slashId}-${slashAt}` : undefined}
                placeholder={blocked ?? (busy ? "Queue a follow-up" : `Message ${agent}`)}
                disabled={blocked !== null}
                value={draft}
                onChange={(e) => {
                    setDraft(e.target.value);
                    setSlashActive(0);
                    setSlashDismissed(false);
                }}
                onPaste={(e) => {
                    const pics = canAttach ? Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/")) : [];
                    if (pics.length > 0) {
                        e.preventDefault();
                        void addFiles(pics);
                        return;
                    }
                    // a long text rides as a card, word for word, and the box keeps only what is typed
                    const text = e.clipboardData.getData("text/plain");
                    if (!isLongPaste(text)) return;
                    e.preventDefault();
                    setPastes((cur) => [...cur, newPaste(cur, text)]);
                }}
                onKeyDown={(e) => {
                    // an Enter that confirms an IME candidate must never send the half-written message
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && waiting) return;
                    if (e.key === "Escape" && slash.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        setSlashDismissed(true);
                        return;
                    }
                    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && slash.length > 0) {
                        e.preventDefault();
                        setSlashActive((slashAt + (e.key === "ArrowDown" ? 1 : -1) + slash.length) % slash.length);
                        return;
                    }
                    if (e.key === "Tab" && slash.length > 0) {
                        e.preventDefault();
                        const selected = slash[slashAt];
                        if (selected?.slash) setDraft(`${selected.slash} `);
                        setSlashActive(0);
                        return;
                    }
                    // a soft keyboard's Return is a new line and Send sends; a chosen slash command still runs on it
                    if (e.key === "Enter" && !e.shiftKey && (slash.length > 0 || !matchMedia(SOFT_KEYS).matches)) {
                        e.preventDefault();
                        e.stopPropagation();
                        submit();
                    }
                }}
            />
            <div className="composer-bar">
                {canAttach ? (
                    <Btn
                        sm
                        kind="quiet"
                        icon="image"
                        disabled={images.length >= MAX_IMAGES || blocked !== null}
                        title={images.length >= MAX_IMAGES ? `At most ${MAX_IMAGES} images per message` : "Attach images"}
                        onClick={() => fileInput.current?.click()}
                    />
                ) : (
                    noImages && <Btn sm kind="quiet" icon="image" disabled title={`${noImages} cannot read images`} />
                )}
                <span className="composer-hint">
                    {slash.length > 0 ? "↑ ↓ choose · Enter run · Esc dismiss" : `Enter ${busy ? "queues" : "sends"} · Shift+Enter new line · / commands`}
                </span>
                {meter && (
                    <span
                        className={meter.hot ? "meter hot" : "meter"}
                        title={meter.estimate
                            ? `Context about ${pct}% full: ${kilo(meter.used)} of ${kilo(meter.window)}, an estimate until the next reply reports its usage`
                            : `Context window ${pct}% full: ${kilo(meter.used)} of ${kilo(meter.window)} tokens, from the latest turn`}
                    >
                        <span className="meter-bar"><i style={{ width: `${pct}%` }} /></span>
                        {meter.estimate ? "~" : ""}{kilo(meter.used)} / {kilo(meter.window)}
                    </span>
                )}
                {busy ? (
                    <>
                        <Btn icon="queue" disabled={!draft.trim() && pastes.length === 0} title={slash.length > 0 ? "Run the selected command" : "Line this message up behind the running turn"} onClick={submit}>
                            {slash.length > 0 ? "Run" : "Queue"}
                        </Btn>
                        <Btn kind="danger" icon="stop" disabled={stopPending} onClick={onStop}>
                            {stopPending ? "Stopping…" : "Stop"}
                        </Btn>
                    </>
                ) : (
                    <Btn
                        kind="send"
                        icon="send"
                        disabled={stopPending || !ready || blocked !== null || (empty && queued === 0)}
                        title={empty && queued > 0 ? "Send what is queued" : undefined}
                        onClick={submit}
                    >
                        {slash.length > 0 ? "Run" : "Send"}
                    </Btn>
                )}
            </div>
        </div>
    );
}

export const Composer = memo(ComposerView);
