// The chat's message box: it owns the draft, staged images, pasted-text cards and the slash menu, so a keystroke re-renders only this.
import { memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, Ref } from "react";

import { buildPasted, IMAGE_TOKENS, MAX_IMAGE_BYTES, MAX_IMAGES, parsePasted, TURN_IMAGE_SHARE, type Paste } from "@mimi-os/protocol";

import { Icon } from "../components/icon.tsx";
import { matchSlash, type Command } from "../components/palette.tsx";
import { BoxCards } from "../components/paste-card.tsx";
import { Btn } from "../components/ui.tsx";
import { isLongPaste, newPaste, readDropped, tooLarge } from "../pasted.ts";
import { errorMessage, kilo, plural, SOFT_KEYS } from "../shared.ts";

// wire contract: at most MAX_IMAGES images per message, each a data-URI of at most MAX_IMAGE_BYTES chars
const IMAGE_STEPS: readonly [edge: number, quality: number][] = [[1024, 0.8], [1024, 0.6], [768, 0.6], [512, 0.55]];
// what a tile in the box decodes instead of the message's own JPEG
const PREVIEW: readonly [edge: number, quality: number] = [256, 0.7];

/** A staged image: the data-URI the message sends, and its preview once made. */
interface Staged {
    uri: string;
    preview: string | null;
}

/** `source` as a JPEG data-URI at most `edge` px on its longer side, scaled by the browser's high-quality resize. */
async function jpeg(source: ImageBitmap | HTMLImageElement, width: number, height: number, edge: number, quality: number): Promise<string> {
    const scale = Math.min(1, edge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const sized = await createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
    try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This browser gave no 2D canvas to downscale with.");
        // the size again: an engine that ignores the resize options still draws the right one
        ctx.drawImage(sized, 0, 0, w, h);
        return canvas.toDataURL("image/jpeg", quality);
    } finally {
        sized.close();
    }
}

/** One full-size decode of the file, and from it the message's JPEG under MAX_IMAGE_BYTES and its preview; null when no step fits. */
async function stageFile(file: File): Promise<Staged | null> {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
        for (const [edge, quality] of IMAGE_STEPS) {
            const uri = await jpeg(bitmap, bitmap.width, bitmap.height, edge, quality);
            if (uri.length <= MAX_IMAGE_BYTES) return { uri, preview: await jpeg(bitmap, bitmap.width, bitmap.height, ...PREVIEW) };
        }
        return null;
    } finally {
        bitmap.close();
    }
}

/** The preview of an image staged before: a message that came back unsent, or a carried draft. */
async function previewOf(uri: string): Promise<string> {
    const img = new Image();
    img.src = uri;
    await img.decode();
    return jpeg(img, img.naturalWidth, img.naturalHeight, ...PREVIEW);
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
    /** Puts an unsent message back whole, its pasted texts as cards and its images staged; false, taking nothing, when the box already holds words, cards or images. */
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
    /** The current model's window: the gateway refuses a message whose images would fill more than TURN_IMAGE_SHARE of it. */
    contextTokens?: number | undefined;
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
    agent, draftKey, busy, stopPending, ready, waiting, queued, canAttach, noImages, contextTokens, meter, slash: commands, blocked,
    onSubmit, onStop, onNotice, onOpenPaste, ref,
}: ComposerProps): ReactElement {
    const maxImages = contextTokens ? Math.min(MAX_IMAGES, Math.floor((TURN_IMAGE_SHARE * contextTokens) / IMAGE_TOKENS)) : MAX_IMAGES;
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
    const [images, setImages] = useState<Staged[]>(() => (carried?.agent === agent ? carried.images.map((uri) => ({ uri, preview: null })) : []));
    const previewing = useRef(false);
    const [slashDismissed, setSlashDismissed] = useState(false);
    const [slashActive, setSlashActive] = useState(0);
    const slashId = useId();
    const box = useRef<HTMLTextAreaElement | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const thumbs = useRef<HTMLDivElement | null>(null);
    const staged = images.length > 0;
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

    // images that came back without a preview get one, a decode at a time
    useEffect(() => {
        const next = images.find((s) => s.preview === null);
        if (!next || previewing.current) return;
        previewing.current = true;
        void previewOf(next.uri).catch(() => "").then((preview) => {
            previewing.current = false;
            setImages((cur) => cur.map((s) => (s === next ? { ...s, preview } : s)));
        });
    }, [images]);

    // a mouse wheel turns vertically: the row of images scrolls sideways under it
    useEffect(() => {
        const row = thumbs.current;
        if (!row) return;
        const onWheel = (e: WheelEvent): void => {
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
            e.preventDefault();
            row.scrollLeft += e.deltaY;
        };
        row.addEventListener("wheel", onWheel, { passive: false });
        return () => row.removeEventListener("wheel", onWheel);
    }, [staged]);

    useImperativeHandle(ref, () => ({
        restore: (text, returned) => {
            // whole or not at all: anything already in the box would merge two messages
            if (box.current?.value.trim() || pastes.length > 0 || images.length > 0) return false;
            const back = parsePasted(text);
            setDraft(back.text);
            setPastes(back.pastes);
            setImages(returned.map((uri) => ({ uri, preview: null })));
            return true;
        },
        take: () => {
            const held = { text: buildPasted(pastes, box.current?.value ?? draft), images: images.map((s) => s.uri) };
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
        // everything stays in the box: the gateway would refuse the whole request; images fit by count and size already
        const over = tooLarge(text);
        if (over) {
            onNotice(over);
            return;
        }
        const result = onSubmit(text, images.map((s) => s.uri));
        if (result === "sent" || result === "queued") {
            setDraft("");
            setPastes([]);
            setImages([]);
        }
    };

    /** Stages what fits, each image as soon as it is ready; whatever is dropped is said out loud, after the notes the caller brings, rather than silently discarded. */
    const addFiles = async (files: File[], notes: string[] = []): Promise<void> => {
        const pics = canAttach ? files.filter((f) => f.type.startsWith("image/")) : [];
        const room = maxImages - images.length;
        if (pics.length > 0 && room <= 0) notes.push(`A message carries at most ${maxImages} ${plural(maxImages, "image", "images")}${maxImages < MAX_IMAGES ? " for this model" : ""}.`);
        if (pics.length === 0 || room <= 0) {
            if (notes.length) onNotice(notes.join(" "));
            return;
        }
        let tooBig = 0;
        let unreadable = 0;
        for (const file of pics.slice(0, room)) {
            try {
                const staged = await stageFile(file);
                if (staged === null) tooBig += 1;
                else setImages((cur) => [...cur, staged].slice(0, maxImages));
            } catch {
                unreadable += 1;
            }
        }
        if (pics.length > room) notes.push(`Only ${room} more ${plural(room, "image fits", "images fit")}, a message holds ${maxImages}.`);
        if (tooBig) notes.push(`${tooBig} too detailed to shrink under ${Math.round(MAX_IMAGE_BYTES / 1000)} KB ${plural(tooBig, "was", "were")} skipped.`);
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
            {staged && (
                <div ref={thumbs} className="composer-thumbs">
                    {images.map((s, i) => (
                        <div key={i} className="composer-thumb">
                            {s.preview && <img src={s.preview} alt="" />}
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
                        disabled={images.length >= maxImages || blocked !== null}
                        title={images.length >= maxImages
                            ? `At most ${maxImages} ${plural(maxImages, "image", "images")} per message${maxImages < MAX_IMAGES ? " for this model" : ""}`
                            : images.length > 0 ? `Attach images (${images.length} of ${maxImages})` : "Attach images"}
                        onClick={() => fileInput.current?.click()}
                    />
                ) : (
                    noImages && <Btn sm kind="quiet" icon="image" disabled title={`${noImages} cannot read images`} />
                )}
                {/* the row scrolls most of them out of sight, and a phone shows no hint */}
                {images.length > 1 && <span className="count" title={`${images.length} of ${maxImages} images`}>{images.length}</span>}
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
                        <Btn icon="queue" disabled={empty} title={slash.length > 0 ? "Run the selected command" : "Line this message up behind the running turn"} onClick={submit}>
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
