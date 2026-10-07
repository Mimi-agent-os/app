// The chat screen: header, streaming thread and dock. CallsTab is exported for the agent page.
// SECURITY: no dangerouslySetInnerHTML here; Markdown renders React elements, and only agent text is parsed as markdown.
import {
    Fragment,
    lazy,
    memo,
    Suspense,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type { DragEvent, ReactElement, SyntheticEvent } from "react";
import { createPortal, flushSync } from "react-dom";

import { buildPasted, parsePasted, type OwnerAnswer, type OwnerQuestion, type Paste } from "@mimi-os/protocol";

import {
    getLlmCallRaw,
    listHistory,
    listLlmCalls,
    listModels,
    attachTurn,
    resumeAgent,
    runTurn,
    stopTurn,
    truncateFrom,
    type AgentSummary,
    type ConversationInfo,
    type GateAction,
    type HistoryMessage,
    type LlmCallInfo,
    type ModelSummary,
    type TurnEvent,
} from "../api.ts";
import { agentState, openEmptyChat, refreshAgent, useChats } from "../agent-chats.ts";
import { useInterfaces, type AgentApp } from "../app-api.ts";
import { resolveApproval } from "../approval-api.ts";
import { ApiError, getSnapshot } from "../channel.ts";
import type { ApprovalResolvedEvent, ChatChangedDetail } from "../events.ts";
import { useChatActions } from "../components/chat-row.tsx";
import { useDialog } from "../components/dialog.tsx";
import { Icon } from "../components/icon.tsx";
import { CopyTextButton, Markdown } from "../components/markdown.tsx";
import { Menu } from "../components/menu.tsx";
import { ConnLine } from "../components/nav-bar.tsx";
import type { Command } from "../components/palette.tsx";
import { BoxCards, PasteCard, PasteViewer } from "../components/paste-card.tsx";
import { QuestionCard, type AskOutcome } from "../components/question-card.tsx";
import { useToast } from "../components/toast.tsx";
import { AgentMark, BackButton, Btn, Disclose, Empty, LoadBoundary } from "../components/ui.tsx";
import { isLongPaste, newPaste, tooLarge } from "../pasted.ts";
import { go, here, holdBack, releaseBack } from "../route.ts";
import { clock, countdown, errorMessage, Err, isDelegation, kilo, plural, SOFT_KEYS, useDevDetails, when } from "../shared.ts";
import { usd } from "../spend.ts";
import { androidApp } from "../tauri.ts";
import { carryDraft, Composer, type ComposerHandle, type SubmitResult } from "./composer.tsx";
import "../chat.css";

// loaded on the first switch to Web, so opening a chat never waits for it
const InterfacesTab = lazy(() => import("./interfaces.tsx"));

const PAGE = 60;
// the tail-follow and the "Jump to latest" offer must agree on what counts as the tail
const NEAR_BOTTOM = 100;
const NEAR_TOP = 240;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

// keys only; module scope so a reloaded history can never collide with a live turn
let seq = 0;
const uid = (): number => ++seq;
const sid = (): string => `s${uid()}`;

// the last loaded window of each chat, outside React so the per-chat remount paints at once
const HISTORY_CACHE = new Map<string, { rows: HistoryMessage[]; more: boolean }>();
const HISTORY_CACHE_MAX = 24;

// ── the thread model ─────────────────────────────────────────────────────────

// `partial`: a batch answered call by call, where neither "allowed" nor "denied" is the truth; `elsewhere`: allowed on another
// device, with which calls unknown here; `cancelled`: the turn stopped before anyone answered
type GateState = "open" | "allowed" | "denied" | "partial" | "expired" | "cancelled" | "elsewhere";

/** One approval of a whole tool batch; `key` is the server's gate id, echoed back with the decisions. */
interface Gate {
    id: number;
    key: string;
    actions: GateAction[];
    picks: Record<string, boolean>;
    decisions: Record<string, boolean>;
    /** Epoch ms when the gateway denies on its own. */
    deadline: number;
    state: GateState;
}

const allOf = (actions: readonly GateAction[], value: boolean): Record<string, boolean> =>
    Object.fromEntries(actions.map((a): [string, boolean] => [a.id, value]));

function settled(actions: readonly GateAction[], decisions: Record<string, boolean>): GateState {
    const yes = actions.filter((a) => decisions[a.id]).length;
    if (yes === 0) return "denied";
    return yes === actions.length ? "allowed" : "partial";
}

/** An ask_owner question; `key` is the server's gate id, and the card sends the reply itself. */
interface Ask {
    key: string;
    questions: OwnerQuestion[];
    /** Epoch ms when the gateway gives up on an answer. */
    deadline: number;
    outcome: AskOutcome;
    answers: OwnerAnswer[] | null;
}

/** `result` exists only in restored history: undefined means "not known here", never "returned nothing". */
interface Call {
    name: string;
    arguments: string;
    id?: string | undefined;
    result?: string;
}

type Segment =
    | { kind: "think"; id: string; text: string }
    | { kind: "text"; id: string; text: string; meta?: HistoryMessage["meta"]; at?: string | undefined }
    | { kind: "tools"; id: string; calls: Call[] }
    | { kind: "gate"; id: string; gate: Gate }
    | { kind: "ask"; id: string; ask: Ask };

interface Turn {
    kind: "turn";
    id: number;
    origin: "live" | "db";
    segments: Segment[];
    errors: string[];
    running: boolean;
    /** A `done` arrived; its absence once the reader finished means the connection broke. */
    done: boolean;
    restoring?: boolean;
    turnSeq?: number;
    /** How the turn ended when that deserves a line of its own, like a stop. */
    status?: string;
    meta?: HistoryMessage["meta"];
    /** Per open gate, the ticks the owner had set before a re-attach replays the turn. */
    held?: Record<string, Record<string, boolean>>;
}

// the loop's own stop marker, shown as the turn's status line instead of bracketed text in the reply
const STOP_MARK = /\[stopped by user\]\s*$/;

interface Said {
    kind: "msg";
    id: number;
    text: string;
    images?: string[] | undefined;
    actor?: NonNullable<HistoryMessage["meta"]>["actor"];
    at?: string | undefined;
}

/** A compaction seam as the db records it. */
interface Note {
    kind: "note";
    id: number;
    text: string;
}

type Item = Said | Note | Turn;

const emptyTurn = (id: number): Turn => ({ kind: "turn", id, origin: "live", segments: [], errors: [], running: true, done: false });

/** What following one turn to its end came to. */
interface Followed {
    got: boolean;
    /** A `done` arrived. */
    ended: boolean;
    /** The turn's own `error` event. */
    failed: boolean;
    turnSeq: number;
    /** Why the POST failed before anything streamed. */
    refused?: string | undefined;
}

// a gate still open when the stream ends was decided by the server's own timeout; a question still open went with its turn
const closeTurn = (t: Turn): Turn => ({
    ...t,
    running: false,
    segments: t.segments.map((s) => s.kind === "gate" && s.gate.state === "open" ? { ...s, gate: { ...s.gate, state: "expired" } }
        : s.kind === "ask" && s.ask.outcome === "open" ? { ...s, ask: { ...s.ask, outcome: "gone" } }
        : s),
});

// once a gate is the last segment, the next chunk of text cannot reach the reply above it
function extend(segs: Segment[], kind: "think" | "text", text: string): Segment[] {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) return [...segs.slice(0, -1), { ...last, text: last.text + text }];
    return [...segs, { kind, id: sid(), text }];
}

// pure and synchronous: it runs inside the read loop, where an await would stop the stream draining
function fold(t: Turn, ev: TurnEvent): Turn {
    switch (ev.type) {
        case "turn_started":
            return t.turnSeq === undefined && Number.isSafeInteger(ev.turnSeq) && ev.turnSeq > 0 ? { ...t, turnSeq: ev.turnSeq } : t;
        case "text":
            return { ...t, segments: extend(t.segments, "text", ev.text) };
        case "thinking":
            return { ...t, segments: extend(t.segments, "think", ev.text) };
        case "tool_calls": {
            // a second batch with no text between it and the first is the same round to the reader
            const add: Call[] = ev.calls.map((c) => ({ name: c.name, arguments: c.arguments, id: c.id }));
            const last = t.segments.at(-1);
            return last?.kind === "tools"
                ? { ...t, segments: [...t.segments.slice(0, -1), { ...last, calls: [...last.calls, ...add] }] }
                : { ...t, segments: [...t.segments, { kind: "tools", id: sid(), calls: add }] };
        }
        case "restart": {
            // the fallback model redoes the round: drop streamed prose and unanswered calls back to the first thing that happened
            const kept = t.segments.findLastIndex((s) => !(s.kind === "think" || s.kind === "text" || (s.kind === "tools" && s.calls.every((c) => c.result === undefined))));
            return kept === t.segments.length - 1 ? t : { ...t, segments: t.segments.slice(0, kept + 1) };
        }
        case "approval_required":
            return {
                ...t,
                segments: [...t.segments, {
                    kind: "gate",
                    id: sid(),
                    gate: {
                        id: uid(),
                        key: ev.gate,
                        actions: ev.actions,
                        picks: t.held?.[ev.gate] ?? allOf(ev.actions, true),
                        decisions: {},
                        deadline: ev.deadline,
                        state: "open",
                    },
                }],
            };
        case "approval_resolved":
            // on a replay this is the only thing that stops an answered gate from rendering as open; it also overrules this
            // device's own guess, since another device may have answered first
            return {
                ...t,
                segments: t.segments.map((s) =>
                    s.kind === "gate" && s.gate.key === ev.gate
                        ? { ...s, gate: { ...s.gate, decisions: ev.decisions, picks: ev.decisions,
                            state: ev.outcome === "expired" ? "expired" : ev.outcome === "gone" ? "cancelled" : settled(s.gate.actions, ev.decisions) } }
                        : s,
                ),
            };
        case "question_required":
            return {
                ...t,
                segments: [...t.segments, {
                    kind: "ask",
                    id: sid(),
                    ask: { key: ev.gate, questions: ev.questions, deadline: ev.deadline, outcome: "open", answers: null },
                }],
            };
        case "question_resolved":
            // the gateway's word wins over the card's own: answered elsewhere, dismissed, expired
            return {
                ...t,
                segments: t.segments.map((s) =>
                    s.kind === "ask" && s.ask.key === ev.gate ? { ...s, ask: { ...s.ask, outcome: ev.outcome, answers: ev.answers } } : s,
                ),
            };
        case "tool_result":
            return {
                ...t,
                segments: t.segments.map((s) =>
                    s.kind === "tools" && s.calls.some((c) => c.id === ev.id && c.result === undefined)
                        ? { ...s, calls: s.calls.map((c) => (c.id === ev.id && c.result === undefined ? { ...c, result: ev.text } : c)) }
                        : s,
                ),
            };
        case "error":
            return { ...t, errors: [...t.errors, ev.message] };
        case "done": {
            const meta: NonNullable<HistoryMessage["meta"]> = {};
            if (ev.finalCallId) meta.callId = ev.finalCallId;
            if (ev.registryModel) meta.registryModel = ev.registryModel;
            if (ev.requestedModel) meta.requestedModel = ev.requestedModel;
            if (ev.reportedModel) meta.reportedModel = ev.reportedModel;
            if (ev.completionTokens !== undefined) meta.completionTokens = ev.completionTokens;
            if (ev.callDurationMs !== undefined) meta.callDurationMs = ev.callDurationMs;
            if (ev.turnDurationMs !== undefined) meta.turnDurationMs = ev.turnDurationMs;
            if (ev.rounds !== undefined) meta.rounds = ev.rounds;
            return { ...t, done: true, meta };
        }
        default:
            // log, tool_call, compacted and unknown events leave the turn as it is
            return t;
    }
}

/** The db's rows walked into the same items a live turn produces; built from the whole loaded window so a turn cut by a page boundary reassembles. */
function rebuild(rows: readonly HistoryMessage[]): Item[] {
    const out: Item[] = [];
    let turn: Turn | null = null;
    for (const row of rows) {
        if (row.summary) {
            turn = null;
            out.push({ kind: "note", id: row.id, text: row.content });
            continue;
        }
        if (row.role === "user") {
            turn = null;
            out.push({ kind: "msg", id: row.id, text: row.content, images: row.images, actor: row.meta?.actor, at: row.at });
            continue;
        }
        if (!turn) {
            turn = { kind: "turn", id: row.id, origin: "db", segments: [], errors: [], running: false, done: false };
            out.push(turn);
        }
        if (row.role === "tool") {
            // folded onto the call it answers; with that call above the loaded window it stays a nameless result until the older page arrives
            const call = row.toolCallId === undefined ? undefined
                : turn.segments.findLast((s) => s.kind === "tools" && s.calls.some((c) => c.id === row.toolCallId && c.result === undefined));
            const asked = call?.kind === "tools" ? call.calls.find((c) => c.id === row.toolCallId && c.result === undefined) : undefined;
            const last = turn.segments.at(-1);
            if (asked) asked.result = row.content;
            else if (last?.kind === "tools") last.calls.push({ name: "", arguments: "", result: row.content, id: row.toolCallId });
            else turn.segments.push({ kind: "tools", id: `r${row.id}`, calls: [{ name: "", arguments: "", result: row.content, id: row.toolCallId }] });
            continue;
        }
        if (row.thinking) turn.segments.push({ kind: "think", id: `k${row.id}`, text: row.thinking });
        let text = row.content;
        if (STOP_MARK.test(text)) {
            text = text.replace(STOP_MARK, "").trimEnd();
            turn.status = "Generation stopped";
        }
        if (text) turn.segments.push({ kind: "text", id: `t${row.id}`, text, meta: row.meta, at: row.at });
        if (row.toolCalls?.length) {
            turn.segments.push({ kind: "tools", id: `c${row.id}`, calls: row.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, id: c.id })) });
        }
    }
    return out;
}

// ── thread pieces ────────────────────────────────────────────────────────────

// the ref covers cache hits, where the load event may fire before onLoad is attached
function ChatImage({ src, label, onOpen }: { src: string; label: string; onOpen: (from: HTMLButtonElement) => void }): ReactElement {
    const [state, setState] = useState<"wait" | "ok" | "bad">("wait");
    if (state === "bad") return <span className="chat-image bad" title="Image unavailable"><Icon name="image" /></span>;
    return (
        <button type="button" className={`chat-image ${state}`} aria-label={label} disabled={state === "wait"} onClick={(e) => onOpen(e.currentTarget)}>
            <img
                src={src}
                alt=""
                loading="lazy"
                ref={(el) => { if (el?.complete) setState(el.naturalWidth > 0 ? "ok" : "bad"); }}
                onLoad={() => setState("ok")}
                onError={() => setState("bad")}
            />
        </button>
    );
}

function ImageViewer({ images, start, from, onClose }: {
    images: readonly string[];
    start: number;
    from: HTMLButtonElement;
    onClose: () => void;
}): ReactElement {
    const [at, setAt] = useState(start);
    const [failed, setFailed] = useState(-1);
    const shade = useRef<HTMLDivElement | null>(null);
    const pressed = useRef(false);
    const many = images.length > 1;
    const name = many ? `Image ${at + 1} of ${images.length}` : "Image";
    const step = (by: number): void => setAt((i) => (i + by + images.length) % images.length);

    const close = (): void => {
        const thumb = from.parentElement?.children[at];
        const to = thumb instanceof HTMLButtonElement && !thumb.disabled ? thumb : from;
        if (to.isConnected) to.focus({ preventScroll: true });
        onClose();
    };
    const latest = useRef(close);
    latest.current = close;
    // keys on window, not the shade: WebKit gives a clicked button no focus, so it drops to body
    useEffect(() => {
        const box = shade.current;
        if (!box) return undefined;
        const hold = holdBack(() => latest.current());
        const onKey = (e: KeyboardEvent): void => {
            // Cmd+B checks for no modal and Cmd+K only for a .dlg: neither may act behind the viewer
            e.stopPropagation();
            if (e.key === "Escape") latest.current();
            else if (many && (e.key === "ArrowLeft" || e.key === "ArrowRight")) step(e.key === "ArrowLeft" ? -1 : 1);
            else if (e.key === "Tab") {
                const stops = box.querySelectorAll("button");
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
            className="mback dlgback image-viewer"
            role="dialog"
            aria-modal="true"
            aria-label={name}
            // a press dragged off a button, or the second click of the double-click that opened the viewer, ends here: neither closes
            onPointerDown={(e) => { pressed.current = !(e.target instanceof Element && e.target.closest("button")); }}
            onClick={(e) => { if (e.detail < 2 && pressed.current && !(e.target instanceof Element && e.target.closest("button"))) close(); }}
        >
            <button type="button" className="btn icon image-viewer-close" aria-label="Close image" title="Close (Escape)" autoFocus onClick={close}>
                <Icon name="close" />
            </button>
            {failed === at ? (
                <span className="chat-image bad" role="img" aria-label={`${name} unavailable`}><Icon name="image" /></span>
            ) : (
                <img key={at} src={images[at]} alt={name} onError={() => setFailed(at)} />
            )}
            {many && (
                <div className="image-viewer-bar">
                    <button type="button" className="btn icon" aria-label="Previous image" onClick={() => step(-1)}><Icon name="chevron" /></button>
                    <span className="num" aria-live="polite">{at + 1} of {images.length}</span>
                    <button type="button" className="btn icon" aria-label="Next image" onClick={() => step(1)}><Icon name="chevron" /></button>
                </div>
            )}
        </div>,
        document.body,
    );
}

type Speaker = "human" | "agent" | "system" | "unknown";

type OnOpenPaste = (paste: Paste, from: HTMLButtonElement) => void;

const Bubble = memo(function Bubble({ speaker, who, text, md, images, at, head = true, sent, editId, onEdit, onImage, onOpenPaste }: {
    speaker: Speaker;
    who: string;
    text: string;
    /** Agent text only: your own asterisks come back verbatim. */
    md?: boolean | undefined;
    images?: string[] | undefined;
    at?: string | undefined;
    /** Only a turn's first reply carries the name line. */
    head?: boolean | undefined;
    /** A live message you just sent, the one thing in the thread that animates in. */
    sent?: boolean | undefined;
    editId?: number | undefined;
    /** Your own db-backed messages only: an edit truncates the chat from there. */
    onEdit?: ((id: number) => void) | undefined;
    onImage?: ((images: string[], start: number, from: HTMLButtonElement) => void) | undefined;
    onOpenPaste?: OnOpenPaste | undefined;
}): ReactElement {
    // an agent's reply is its own words: only a message sent from a box can carry pasted blocks
    const { pastes, text: typed } = useMemo(() => (md ? { pastes: [], text } : parsePasted(text)), [md, text]);
    const time = at ? <time className="msg-time" dateTime={`${at.replace(" ", "T")}Z`}>{clock(at)}</time> : null;
    const copy = text ? <CopyTextButton text={[...pastes.map((p) => p.text), typed].filter(Boolean).join("\n\n")} label="Copy message" /> : null;
    return (
        <article className={sent ? "msg is-sent" : "msg"} data-speaker={speaker}>
            {speaker !== "human" && head && (
                <header className="msg-who">
                    <span className="msg-name">{who}</span>
                    {time}
                    <span className="msg-actions">{copy}</span>
                </header>
            )}
            <div className="msg-body">
                {images && images.length > 0 && (
                    <div className="chat-images">
                        {images.map((src, i) => (
                            <ChatImage
                                key={i}
                                src={src}
                                label={images.length > 1 ? `Open image ${i + 1} of ${images.length}` : "Open image"}
                                onOpen={(from) => onImage?.(images, i, from)}
                            />
                        ))}
                    </div>
                )}
                {pastes.length > 0 && (
                    <div className="paste-cards">
                        {pastes.map((p, i) => <PasteCard key={i} paste={p} preview={2} onOpen={(paste, from) => onOpenPaste?.(paste, from)} />)}
                    </div>
                )}
                {typed && (md ? <Markdown text={typed} /> : <span>{typed}</span>)}
            </div>
            {speaker === "human" && (
                <footer className="msg-foot">
                    {time}
                    {copy}
                    {onEdit && editId !== undefined && (
                        <Btn kind="quiet" sm title="Edit this message and continue from here" onClick={() => onEdit(editId)}>Edit</Btn>
                    )}
                </footer>
            )}
        </article>
    );
});

// in place, not a modal, so what an edit would delete stays visible below it; pasted texts come back as cards and leave with the words
function EditBox({ text, busy, onSave, onCancel, onOpenPaste }: {
    text: string;
    /** A turn is running: saving would race it. */
    busy: boolean;
    onSave: (text: string) => void;
    onCancel: () => void;
    onOpenPaste: OnOpenPaste;
}): ReactElement {
    const [start] = useState(() => parsePasted(text));
    const [value, setValue] = useState(start.text);
    const [pastes, setPastes] = useState(start.pastes);
    const box = useRef<HTMLTextAreaElement | null>(null);
    const empty = !value.trim() && pastes.length === 0;
    return (
        <div className="msg msg-edit" data-speaker="human">
            {pastes.length > 0 && <BoxCards pastes={pastes} box={box} onOpen={onOpenPaste} setPastes={setPastes} setText={setValue} />}
            <textarea
                ref={box}
                autoFocus
                aria-label="Edit message"
                rows={3}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onPaste={(e) => {
                    // as in the message box: a long text rides as a card
                    const pasted = e.clipboardData.getData("text/plain");
                    if (!isLongPaste(pasted)) return;
                    e.preventDefault();
                    setPastes((cur) => [...cur, newPaste(cur, pasted)]);
                }}
                onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Escape") {
                        e.stopPropagation();
                        onCancel();
                    } else if (e.key === "Enter" && !e.shiftKey && !matchMedia(SOFT_KEYS).matches) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!empty && !busy) onSave(buildPasted(pastes, value.trim()));
                    }
                }}
            />
            <div className="msg-edit-bar">
                <span>Saving deletes everything below</span>
                <Btn kind="quiet" sm onClick={onCancel}>Cancel</Btn>
                <Btn kind="primary" sm disabled={empty || busy} title={busy ? "Wait for the running turn to end" : undefined} onClick={() => onSave(buildPasted(pastes, value.trim()))}>
                    Save and send
                </Btn>
            </div>
        </div>
    );
}

const HEAD: Record<GateState, string> = {
    open: "Awaiting approval",
    allowed: "Allowed",
    denied: "Denied",
    partial: "Partly allowed",
    expired: "Expired",
    cancelled: "Cancelled",
    elsewhere: "Answered elsewhere",
};

const OUTCOME: Record<GateState, string> = {
    open: "",
    allowed: "Everything below went ahead with these arguments.",
    denied: "Nothing below ran. The agent learned of the refusal and carried on without it.",
    partial: "The ticked calls went ahead. The agent got their results and a refusal for the rest, and carried on from there.",
    expired: "Nobody answered in time, so nothing below ran. The agent was told the request expired.",
    cancelled: "The turn stopped before anyone answered. Nothing below ran.",
    elsewhere: "Answered on another device, so this one cannot tell which calls ran. The agent's reply says.",
};

/** Open: every call with its exact arguments and one pair of buttons for the batch. Answered: the same card, kept as the record of what ran. */
function GateCard({ gate, now, onToggle, onAnswer }: {
    gate: Gate;
    /** Ticks once a second while the gate is open. */
    now: number;
    onToggle: (action: string) => void;
    onAnswer: (decisions: Record<string, boolean>) => void;
}): ReactElement {
    const whole = gate.actions.map((a) => `${a.tool}(${JSON.stringify(a.args, null, 2)})`).join("\n\n");
    const many = gate.actions.length > 1;
    const label = many ? `${gate.actions.length} calls` : (gate.actions[0]?.tool ?? "");
    const left = gate.deadline - now;
    const state = gate.state;

    if (state !== "open") {
        const allowed = (a: GateAction): boolean => state === "allowed" || (state === "partial" && (gate.decisions[a.id] ?? false));
        const refused = state === "denied" || state === "partial";
        return (
            <div className="gate resolved">
                <div className="gh">
                    <b>{HEAD[state]}</b>
                    <span className="mono">{label}</span>
                </div>
                <div className="gb">
                    <p className="gate-note">{OUTCOME[state]}</p>
                    {state !== "elsewhere" && (
                        <ul className="gate-verdicts">
                            {gate.actions.map((a) => (
                                <li key={a.id}>
                                    <span className="mono">{a.tool}</span>
                                    <span data-allowed={allowed(a) || undefined}>{allowed(a) ? "allowed" : refused ? "refused" : "not run"}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <Disclose flush summary={many ? "Show the full calls" : "Show the full call"}>{whole}</Disclose>
                </div>
            </div>
        );
    }

    const picked = gate.actions.filter((a) => gate.picks[a.id]).length;
    return (
        <div className="gate">
            <div className="gh">
                <b>{HEAD.open}</b>
                <span className="mono">{label}</span>
                <span className="countdown">{left <= 0 ? "time is up" : countdown(left)}</span>
            </div>
            <div className="gb">
                <p className="sum">
                    {many
                        ? "These calls change something outside, so the turn stopped here. Below are the exact arguments each tool will run with. Untick anything that must not run: Allow runs what stays ticked, and the agent is told the rest were refused."
                        : "This call changes something outside, so the turn stopped here. Below are the exact arguments the tool will run with."}
                </p>
                <div className="gate-acts">
                    {gate.actions.map((a) => {
                        const args = Object.entries(a.args);
                        const on = gate.picks[a.id] ?? false;
                        // a label, so the whole row is the click target; an unticked call dims but stays readable
                        return (
                            <label key={a.id} className="gate-act" data-off={on ? undefined : ""}>
                                <input type="checkbox" checked={on} onChange={() => onToggle(a.id)} aria-label={`Allow ${a.tool}`} />
                                <div className="gate-act-body">
                                    <span className="mono">{a.tool}</span>
                                    <dl className="facts">
                                        {args.length === 0 && <><dt>Arguments</dt><dd>None</dd></>}
                                        {args.map(([k, v]) => {
                                            // strings stay themselves: JSON-quoting a body the owner has to read would bury it in escapes
                                            const shown = typeof v === "string" ? v : JSON.stringify(v);
                                            return (
                                                <Fragment key={k}>
                                                    <dt>{k}</dt>
                                                    <dd title={shown}>{clip(shown, 160)}</dd>
                                                </Fragment>
                                            );
                                        })}
                                    </dl>
                                </div>
                            </label>
                        );
                    })}
                </div>
                <Disclose flush summary={many ? "Show the full calls" : "Show the full call"}>{whole}</Disclose>
                {/* the gateway decides a passed deadline, by its own clock: the card waits for its word, not this device's guess */}
                {left <= 0 ? <p className="gate-note">Time is up. Waiting for the gateway to close the request.</p> : <div className="btns">
                    <Btn kind="primary" disabled={picked === 0} title={picked === 0 ? "Nothing is ticked. Deny is for that." : undefined} onClick={() => onAnswer(gate.picks)}>
                        {picked === gate.actions.length ? "Allow" : `Allow ${picked} of ${gate.actions.length}`}
                    </Btn>
                    <Btn kind="danger" onClick={() => onAnswer(allOf(gate.actions, false))}>{many ? "Deny all" : "Deny"}</Btn>
                    {/* only ⌘⏎ is advertised: Escape is refused while focus is in a field, and the composer usually has it */}
                    <span className="hint">Allow <kbd>⌘⏎</kbd></span>
                </div>}
            </div>
        </div>
    );
}

type OnToggle = (turnId: number, gate: Gate, action: string) => void;
type OnAnswer = (turnId: number, gate: Gate, decisions: Record<string, boolean>) => void;
type OnSettle = (turnId: number, gate: string, outcome: "answered" | "dismissed", answers: OwnerAnswer[] | null) => void;

// history turns hold no open gate, so they share these instead of fresh closures that would defeat memo
const NO_TOGGLE: OnToggle = () => undefined;
const NO_ANSWER: OnAnswer = () => undefined;
const NO_SETTLE: OnSettle = () => undefined;

/** One turn in the order it happened; the errors sit at the end, as diagnostics about it. */
const TurnBlock = memo(function TurnBlock({ agent, turn, now, onToggle, onAnswer, onSettle }: {
    agent: string;
    turn: Turn;
    /** Non-zero only for the turn holding the open gate, so the 1s tick re-renders nothing else. */
    now: number;
    onToggle: OnToggle;
    onAnswer: OnAnswer;
    onSettle: OnSettle;
}): ReactElement {
    const dev = useDevDetails();
    const restoredNarrative = turn.restoring && (!turn.running || turn.turnSeq === undefined);
    const segments = restoredNarrative ? turn.segments.filter((s) => s.kind === "gate" || s.kind === "ask") : turn.segments;
    const firstText = segments.find((s) => s.kind === "text");
    const finalText = segments.findLast((s) => s.kind === "text");
    const meta = finalText?.meta ?? turn.meta;
    const genModel = meta?.registryModel ?? meta?.reportedModel ?? meta?.requestedModel;
    // an estimated call's output is a guess: the gateway gives it no speed, and neither does this line
    const genSpeed = meta?.completionTokens != null && meta.callDurationMs && !meta.usageEstimated ? Math.round(meta.completionTokens / (meta.callDurationMs / 1000)) : null;
    const thought = segments.flatMap((s) => (s.kind === "think" ? [s.text] : [])).join("\n\n");
    const visible = segments.some((s) => s.kind === "text" || (s.kind === "gate" && s.gate.state === "open") || (s.kind === "ask" && s.ask.outcome === "open"));
    return (
        <div className="msg-turn">
            {thought.trim() && (
                <details className="chat-thinking">
                    <summary><span>{turn.running && !finalText ? "Thinking…" : "Thinking"}</span><Icon name="chevron" sm /></summary>
                    <div className="chat-thinking-body"><Markdown text={thought} /></div>
                </details>
            )}
            {segments.map((s) => {
                if (s.kind === "text") {
                    const actor = (s.meta ?? (s === finalText ? turn.meta : undefined))?.actor;
                    const speaker: Speaker = actor?.kind ?? (turn.origin === "db" ? "unknown" : "agent");
                    const who = speaker === "human" ? "You" : speaker === "system" ? "System" : speaker === "unknown" ? "Sender not recorded" : actor?.agent ?? agent;
                    return <Bubble key={s.id} speaker={speaker} who={who} md text={s.text} at={s.at} head={s === firstText} />;
                }
                if (s.kind === "gate") {
                    return (
                        <GateCard
                            key={s.id}
                            gate={s.gate}
                            now={now}
                            onToggle={(action) => onToggle(turn.id, s.gate, action)}
                            onAnswer={(decisions) => onAnswer(turn.id, s.gate, decisions)}
                        />
                    );
                }
                if (s.kind === "ask") {
                    return (
                        <QuestionCard
                            key={s.id}
                            gate={s.ask.key}
                            questions={s.ask.questions}
                            deadline={s.ask.deadline}
                            outcome={s.ask.outcome}
                            answers={s.ask.answers}
                            onSettled={(outcome, answers) => onSettle(turn.id, s.ask.key, outcome, answers)}
                        />
                    );
                }
                if (s.kind === "tools" && dev) {
                    return (
                        <div key={s.id} className="chat-tools">
                            {s.calls.map((call, i) => {
                                let parsed: unknown = undefined;
                                try {
                                    parsed = call.arguments ? JSON.parse(call.arguments) : undefined;
                                } catch {
                                    // shown raw below
                                }
                                const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.entries(parsed) : null;
                                const preview = fields
                                    ? fields.map(([k, v]) => `${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), 40)}`).join(", ")
                                    : clip(call.arguments, 90);
                                return (
                                    <details key={call.id ?? `c${i}`} className="chat-call">
                                        <summary>
                                            <span className="chat-call-name" title={call.name || undefined}>{call.name || "result"}</span>
                                            {preview && <span className="chat-call-args">{preview}</span>}
                                            <span className={call.result === undefined ? "chat-call-dot pending" : "chat-call-dot"} aria-hidden="true" />
                                            <Icon name="chevron" sm />
                                        </summary>
                                        <div className="chat-call-body">
                                            {call.arguments && <pre>{parsed === undefined ? call.arguments : JSON.stringify(parsed, null, 2)}</pre>}
                                            {call.result !== undefined && <pre className="chat-call-result">{clip(call.result, 4000)}</pre>}
                                        </div>
                                    </details>
                                );
                            })}
                        </div>
                    );
                }
                return null;
            })}
            {turn.running && !visible && !thought.trim() && (
                <div className="chat-typing" role="status">
                    <i /><i /><i />
                    <span>{restoredNarrative ? "Response in progress" : `${agent} is responding`}</span>
                </div>
            )}
            {!turn.restoring && !turn.running && (genModel || genSpeed !== null) && (
                <div className="chat-genmeta">
                    {genModel && <span className="chat-genmeta-model">{genModel}</span>}
                    {genSpeed !== null && (
                        <span className="chat-genmeta-speed" title="Output tokens, thinking included, over the model call">
                            <b>{genSpeed}</b> tok/s
                        </span>
                    )}
                </div>
            )}
            {/* a quiet line, not an Err: a stop is a decision, not a failure */}
            {turn.status && <div className="chat-genmeta"><span>{turn.status}</span></div>}
            {turn.errors.map((m, i) => <Err key={i}>{m}</Err>)}
            {turn.origin === "live" && !turn.running && !turn.done && turn.errors.length === 0 && (
                <Err>The stream broke before the turn ended. The answer above may be incomplete.</Err>
            )}
        </div>
    );
});

/** The history window, memoized apart from the live turn so a stream chunk never re-renders it. */
const PastThread = memo(function PastThread({ agent, items, editing, canEdit, onEdit, onEditSave, onEditCancel, onImage, onOpenPaste }: {
    agent: string;
    items: readonly Item[];
    editing: number | null;
    canEdit: boolean;
    onEdit: (id: number) => void;
    onEditSave: (id: number, text: string) => void;
    onEditCancel: () => void;
    onImage: (images: string[], start: number, from: HTMLButtonElement) => void;
    onOpenPaste: OnOpenPaste;
}): ReactElement {
    const dev = useDevDetails();
    return (
        <>
            {items.map((it) => {
                if (it.kind === "turn") return <TurnBlock key={`h${it.id}`} agent={agent} turn={it} now={0} onToggle={NO_TOGGLE} onAnswer={NO_ANSWER} onSettle={NO_SETTLE} />;
                if (it.kind === "note") {
                    return dev ? (
                        <div key={`h${it.id}`} className="compacted">
                            <span>Session folded</span>
                            <span className="compacted-note">Everything above stays in the thread. Only what goes to the model got shorter.</span>
                            <Disclose flush summary="Read the summary the model now sees instead">{it.text}</Disclose>
                        </div>
                    ) : null;
                }
                if (editing === it.id) {
                    return <EditBox key={`h${it.id}`} text={it.text} busy={!canEdit} onSave={(text) => onEditSave(it.id, text)} onCancel={onEditCancel} onOpenPaste={onOpenPaste} />;
                }
                const speaker: Speaker = it.actor?.kind ?? "unknown";
                const who = speaker === "human" ? "You" : speaker === "agent" ? (it.actor?.agent ?? "Agent") : speaker === "system" ? "System" : "Sender not recorded";
                return (
                    <Bubble
                        key={`h${it.id}`}
                        speaker={speaker}
                        who={who}
                        md={speaker === "agent"}
                        text={it.text}
                        images={it.images}
                        at={it.at}
                        editId={it.id}
                        // only while nothing runs (truncating under a live turn would delete rows it is still writing), and only words can be edited
                        onEdit={canEdit && speaker === "human" && it.text ? onEdit : undefined}
                        onImage={onImage}
                        onOpenPaste={onOpenPaste}
                    />
                );
            })}
        </>
    );
});

// ── the model call trace and published interfaces ────────────────────────────

// hand-rolled details: the raw payload is fetched on first open only, and it is model traffic, so it renders as text
function CallRow({ agent, call }: { agent: string; call: LlmCallInfo }): ReactElement {
    const [raw, setRaw] = useState<string | null>(null);
    const started = useRef(false);

    const load = (e: SyntheticEvent<HTMLDetailsElement>): void => {
        if (!e.currentTarget.open || started.current) return;
        started.current = true;
        getLlmCallRaw(agent, call.id).then(
            (payload) => setRaw(JSON.stringify(payload, null, 2)),
            (err: unknown) => setRaw(`Could not read the raw payload: ${errorMessage(err)}`),
        );
    };

    // spent is input + output, its cost at today's price beside it, and an estimate is marked as one
    const tokens = call.promptTokens == null ? "no usage reported"
        : call.usageEstimated ? `≈${kilo(call.promptTokens)} in → ≈${kilo(call.completionTokens ?? 0)} out${call.cost > 0 ? ` · ≈${usd(call.cost)}` : ""}, estimated`
        : `${kilo(call.promptTokens)} in → ${kilo(call.completionTokens ?? 0)} out${call.cost > 0 ? ` · ${usd(call.cost)}` : ""}`;
    const parts = [
        `#${call.id}`,
        when(call.createdAt),
        call.scope + (call.conversationId === null ? "" : ` · chat ${call.conversationId}`),
        call.model ?? "?",
        tokens,
        call.durationMs === null ? "" : call.durationMs >= 1000 ? `${Math.round(call.durationMs / 100) / 10}s` : `${call.durationMs}ms`,
        call.tokensPerSec === null ? "" : `${Math.round(call.tokensPerSec)} tok/s`,
    ].filter((x) => x !== "");
    return (
        <details className="disclose call-row" onToggle={load}>
            <summary>
                <span>{parts.join(" · ")} ·</span>
                <span className={call.finishReason === "stop" ? undefined : "call-bad"}>{call.finishReason ?? "?"}</span>
            </summary>
            <pre>{raw ?? "Loading…"}</pre>
        </details>
    );
}

// one list is the gateway's newest calls, the agent's or one chat's, so its header says "last N"
const CALLS_SHOWN = 100;

export function CallsTab({ agent }: { agent: string }): ReactElement {
    const { rows: chats } = useChats(agent);
    const [chat, setChat] = useState<number | null>(null);
    // keyed by what was asked: another chat's list never shows, and a refetch keeps this one on screen
    const [loaded, setLoaded] = useState<{ key: string; calls: LlmCallInfo[] } | null>(null);
    const [err, setErr] = useState("");
    // a recorded call or a new price (every cost here is at the current price): refetched in place
    const [live, setLive] = useState(0);
    const key = JSON.stringify([agent, chat]);
    const calls = loaded?.key === key ? loaded.calls : null;
    useEffect(() => {
        let alive = true;
        listLlmCalls(agent, CALLS_SHOWN, chat ?? undefined).then(
            (list) => { if (alive) { setLoaded({ key, calls: list }); setErr(""); } },
            (e: unknown) => { if (alive) setErr(errorMessage(e, "Could not load this agent's model calls.")); },
        );
        return () => { alive = false; };
    }, [agent, chat, key, live]);

    useEffect(() => {
        const refresh = (): void => setLive((value) => value + 1);
        window.addEventListener("mimi:usage-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
        return () => {
            window.removeEventListener("mimi:usage-changed", refresh);
            window.removeEventListener("mimi:resync", refresh);
        };
    }, []);

    const estimated = calls?.filter((c) => c.usageEstimated).length ?? 0;
    const summary = calls && calls.length > 0 ? [
        `${calls.length === CALLS_SHOWN ? "Last" : "All"} ${calls.length} ${plural(calls.length, "call", "calls")}`,
        `${kilo(calls.reduce((n, c) => n + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0))} tokens spent`,
        usd(calls.reduce((n, c) => n + c.cost, 0)),
        estimated > 0 ? `${estimated} estimated` : "",
    ].filter((x) => x !== "").join(" · ") : "";
    return (
        <>
            <div className="calls-head">
                <select aria-label="Which calls" value={chat ?? ""} onChange={(e) => setChat(e.target.value === "" ? null : Number(e.target.value))}>
                    <option value="">Every chat and the agent's own calls</option>
                    {(chats ?? []).map((c) => <option key={c.id} value={c.id}>{c.title ?? "Untitled"}</option>)}
                </select>
                <span className="dim" title="Spent is input + output. Cost is at each model's current price.">{summary}</span>
            </div>
            {err ? <Err>{err}</Err>
                : !calls ? <Empty>Loading calls…</Empty>
                : calls.length === 0 ? <Empty>{chat === null ? "No model calls yet." : "No model calls in this chat yet."}</Empty>
                : <div>{calls.map((c) => <CallRow key={c.id} agent={agent} call={c} />)}</div>}
        </>
    );
}

// ── the header ───────────────────────────────────────────────────────────────

const ChatHead = memo(function ChatHead({
    agent, title, emptyChat, word, tone, elsewhere, renaming, web, app, apps, onView, onRenameStart, onRename, onMenu, onPick,
}: {
    agent: string;
    title: string;
    emptyChat: boolean;
    word?: string | undefined;
    tone?: string | undefined;
    elsewhere: number;
    renaming: boolean;
    /** Whether the agent's interface shows in place of the thread; null hides the switch. */
    web: boolean | null;
    app: string | undefined;
    apps: readonly AgentApp[];
    onView: (web: boolean, app: string | undefined) => void;
    onRenameStart: () => void;
    /** null cancels. */
    onRename: (title: string | null) => void;
    onMenu: (at: HTMLElement) => void;
    onPick: (at: HTMLElement) => void;
}): ReactElement {
    const cancelled = useRef(false);
    return (
        <header className="head chat-head">
            <BackButton count={elsewhere} />
            <div className="head-main">
                <h1 className="head-title">
                    {renaming ? (
                        <input
                            type="text"
                            className="chat-title-input"
                            defaultValue={title}
                            maxLength={120}
                            aria-label="Chat title"
                            autoFocus
                            onFocus={(e) => {
                                cancelled.current = false;
                                e.currentTarget.select();
                            }}
                            onKeyDown={(e) => {
                                if (e.nativeEvent.isComposing) return;
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                } else if (e.key === "Escape") {
                                    e.stopPropagation();
                                    cancelled.current = true;
                                    e.currentTarget.blur();
                                }
                            }}
                            // the one commit point, so Enter and a blur cannot both rename
                            onBlur={(e) => onRename(cancelled.current ? null : e.currentTarget.value)}
                        />
                    ) : emptyChat ? (
                        // an empty chat is reused by the next new chat, so it takes no name until its first message
                        <span className="chat-title-text">{title}</span>
                    ) : (
                        <button type="button" className="chat-title-btn" title="Rename" onClick={onRenameStart}>{title}</button>
                    )}
                </h1>
                <div className="head-sub">
                    {emptyChat ? (
                        <button type="button" className="agent-pick" aria-haspopup="menu" onClick={(e) => onPick(e.currentTarget)}>
                            to <b>{agent}</b><Icon name="chevron" sm />
                        </button>
                    ) : (
                        <button type="button" className="head-agent" onClick={() => go({ at: "agent", agent })}>
                            <AgentMark agent={agent} /><span className="head-agent-name">{agent}</span><Icon name="chevron" sm />
                        </button>
                    )}
                    <ConnLine>{word && <span className="state" data-tone={tone}>{word}</span>}</ConnLine>
                </div>
            </div>
            <div className="head-acts">
                {web !== null && (
                    <div className="seg chat-view" role="group" aria-label="Show">
                        {/* at 900px and below the pressed button hides, so focus moves to the one shown in its place */}
                        <button type="button" className={web ? "" : "on"} aria-pressed={!web} onClick={(e) => {
                            const b = e.currentTarget;
                            flushSync(() => onView(false, app));
                            if (!b.checkVisibility()) (b.nextElementSibling as HTMLButtonElement | null)?.focus();
                        }}>Chat</button>
                        <button type="button" className={web ? "on" : ""} aria-pressed={web} onClick={(e) => {
                            const b = e.currentTarget;
                            flushSync(() => onView(true, app));
                            if (!b.checkVisibility()) (b.previousElementSibling as HTMLButtonElement | null)?.focus();
                        }}>Web</button>
                    </div>
                )}
                {web === true && apps.length > 1 && (
                    <select className="chat-web-pick" aria-label="Interface" value={app} onChange={(e) => onView(true, e.target.value)}>
                        {apps.map((a) => <option key={a.appId} value={a.appId}>{a.title}</option>)}
                    </select>
                )}
                {!emptyChat && (
                    <button type="button" className="btn icon" aria-label={`New chat with ${agent}`} title="New chat" onClick={() => go({ at: "new", agent })}>
                        <Icon name="plus" />
                    </button>
                )}
                <button type="button" className="btn icon" aria-label="Chat actions" aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)}>
                    <Icon name="more" />
                </button>
            </div>
        </header>
    );
});

/** The new-chat route while its empty chat is found or created: the empty chat's own frame, so nothing moves when it lands. */
export function ChatPending({ agent }: { agent: string }): ReactElement {
    return (
        <section className="chat-screen" aria-busy="true" aria-label="New chat">
            <header className="head chat-head">
                <BackButton />
                <div className="head-main">
                    <h1 className="head-title"><span className="chat-title-text">New chat</span></h1>
                    <div className="head-sub">
                        <span className="agent-pick" aria-disabled="true">to <b>{agent}</b><Icon name="chevron" sm /></span>
                        <ConnLine />
                    </div>
                </div>
                <div className="head-acts">
                    <button type="button" className="btn icon" aria-label="Chat actions" disabled><Icon name="more" /></button>
                </div>
            </header>
            <div className="thread">
                <ChatStart agent={agent} />
            </div>
            <div className="chat-dock">
                <div className="composer">
                    <textarea rows={1} disabled aria-label={`Message ${agent}`} placeholder={`Message ${agent}`} />
                    <div className="composer-bar">
                        <span className="composer-hint">Enter sends · Shift+Enter new line · / commands</span>
                        <Btn kind="send" icon="send" disabled>Send</Btn>
                    </div>
                </div>
            </div>
        </section>
    );
}

/** The empty chat's welcome, the same whether the chat is found yet or not; `recent` offers the agent's last chats back. */
function ChatStart({ agent, recent = [] }: { agent: string; recent?: readonly ConversationInfo[] | undefined }): ReactElement {
    return (
        <div className="chat-start">
            <AgentMark agent={agent} size="xl" />
            <h2>Start a chat with {agent}</h2>
            <p>It gets a title after your first message.</p>
            {recent.length > 0 && (
                <p className="chat-start-recent">
                    Recent with {agent}:{" "}
                    {recent.map((c, i) => (
                        <Fragment key={c.id}>
                            {i > 0 && ", "}
                            <button type="button" onClick={() => go({ at: "chat", agent, id: c.id })}>{c.title ?? "Untitled"}</button>
                        </Fragment>
                    ))}
                </p>
            )}
        </div>
    );
}

// ── the queue ────────────────────────────────────────────────────────────────

// follow-ups typed while a turn runs, per chat and in send order; mirrored to localStorage because a queued message is a promise
const QUEUE = new Map<string, string[]>();
const QUEUE_KEY = "mimi-os:chat-queue";

// the Chat or Web choice and the interface picked, per agent, for as long as the app runs
const VIEWS = new Map<string, { web: boolean; app: string | undefined }>();

// ── the chat ─────────────────────────────────────────────────────────────────

interface ChatProps {
    agent: string;
    conversation: number;
    me: AgentSummary;
    agents: readonly AgentSummary[];
    gated: boolean;
    elsewhere: number;
    slash: readonly Command[];
}

function ChatView({ agent, conversation, me, agents, gated, elsewhere, slash }: ChatProps): ReactElement {
    const key = `${agent}#${conversation}`;
    // the loaded window of history, oldest first; null until the first page, since an empty thread and an unread one differ
    const [rows, setRows] = useState<HistoryMessage[] | null>(() => HISTORY_CACHE.get(key)?.rows ?? null);
    const history = useRef(rows);
    history.current = rows;
    // a thread painted from the cache never fades in
    const [fresh] = useState(() => !HISTORY_CACHE.has(key));
    const [more, setMore] = useState(() => HISTORY_CACHE.get(key)?.more ?? false);
    const [older, setOlder] = useState(false);
    // everything since this screen opened, apart from `rows` so a prepend never disturbs the streaming turn
    const [live, setLive] = useState<(Said | Turn)[]>([]);
    const [below, setBelow] = useState(false);
    const [info, setInfo] = useState<ConversationInfo | null>(null);
    const [error, setError] = useState("");
    const [models, setModels] = useState<ModelSummary[] | null>(null);
    const [notice, setNotice] = useState("");
    const [syncError, setSyncError] = useState("");
    const pendingSync = useRef<number | null>(null);
    const [queue, setQueue] = useState<string[]>(() => {
        const held = QUEUE.get(key);
        if (held) return held;
        let list: string[] = [];
        try {
            const parsed: unknown = JSON.parse(localStorage.getItem(`${QUEUE_KEY}:${key}`) ?? "[]");
            // filtered, not trusted: any other tab could have written this
            if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === "string");
        } catch {
            // corrupt or unavailable storage must not keep a chat from opening
        }
        QUEUE.set(key, list);
        return list;
    });
    // the queue for code between renders: the drain is a chain of awaits
    const queued = useRef<string[]>(queue);
    const [editing, setEditing] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [stopPending, setStopPending] = useState(false);
    // the newest turn this screen streamed to its end: a list read taken during it can land later, still saying busy
    const [finished, setFinished] = useState(0);
    const [renaming, setRenaming] = useState(false);
    const [menu, setMenu] = useState<HTMLElement | null>(null);
    const [pick, setPick] = useState<HTMLElement | null>(null);
    // held here, not in the bubble: a finished turn swaps the live message for its history row, and the viewer must outlive that
    const [viewing, setViewing] = useState<{ images: string[]; start: number; from: HTMLButtonElement } | null>(null);
    const [reading, setReading] = useState<{ paste: Paste; from: HTMLButtonElement } | null>(null);
    const dialog = useDialog();
    const toast = useToast();
    const actions = useChatActions(agent);
    const listEntry = useChats(agent);
    const listRows = listEntry.rows;
    const listed = listRows?.find((c) => c.id === conversation);
    const headFailed = useRef("");
    const interfaces = useInterfaces(agent, me.connected);
    const [view, setView] = useState(() => VIEWS.get(agent) ?? { web: false, app: undefined });
    const webApp = interfaces.apps.find((a) => a.appId === view.app) ?? interfaces.apps[0];
    // a remembered Web holds through the first read of the list, so the thread does not flash in first
    const onWeb = !androidApp && view.web && (webApp !== undefined || (interfaces.loading && interfaces.error === null));
    const [webSeen, setWebSeen] = useState(onWeb);
    if (onWeb && !webSeen) setWebSeen(true);
    const onView = useCallback((web: boolean, app: string | undefined): void => {
        VIEWS.set(agent, { web, app });
        setView({ web, app });
    }, [agent]);
    const composer = useRef<ComposerHandle | null>(null);

    const thread = useRef<HTMLDivElement | null>(null);
    // one pending scroll to the bottom, set on open and on send; streaming growth follows `stick` instead
    const jump = useRef(true);
    // scrollHeight just before an older page is prepended, the anchor the offset is restored against
    const pin = useRef<number | null>(null);
    const grew = useRef(0);
    // a ref, not state: the scroll handler fires far faster than renders and would launch duplicate reads
    const loading = useRef(false);
    // which chat the effects belong to, so a late page is never spliced into the wrong one
    const opened = useRef("");
    const abort = useRef<AbortController | null>(null);
    // riding the tail: true until the reader scrolls away from the bottom
    const stick = useRef(true);
    // one re-attach per running turn
    const attachedFor = useRef("");
    // `busy` for code between renders: the drain starts one statement after setBusy(false)
    const running = useRef(false);
    // a stopped turn must not release the queue behind it
    const stopping = useRef(false);
    // the POST itself never delivered, so the text still belongs to whoever typed it
    const unsent = useRef(false);

    useEffect(() => {
        let alive = true;
        void listModels().then((m) => { if (alive) setModels(m); }).catch(() => undefined);
        return () => { alive = false; };
    }, []);

    // during our own turn the list's busy flag would re-attach this screen to the turn it is already streaming
    useEffect(() => {
        if (!running.current && listed) setInfo(listed);
    }, [listed]);

    const row = listed ?? info;
    const stillBusy = (c: ConversationInfo | null | undefined): boolean => c?.busy === true && !(c.activeTurnSeq !== undefined && c.activeTurnSeq <= finished);
    const infoBusy = stillBusy(info);
    const emptyChat = live.length === 0 && (rows === null ? listed?.messages === 0 : rows.length === 0 && !more);
    const title = row?.title ?? (emptyChat ? "New chat" : "Untitled");

    // the model that will answer: the latest turn's, by its registry uid (a rename keeps it), else its name, else the registry default
    const currentModel = useMemo(() => {
        const meta = (rows ?? []).findLast((r) => r.meta?.modelUid || r.meta?.registryModel)?.meta;
        return models?.find((m) => meta?.modelUid && m.modelUid === meta.modelUid) ?? models?.find((m) => m.name === meta?.registryModel) ?? models?.find((m) => m.isDefault) ?? null;
    }, [rows, models]);

    // a point-in-time reading of the latest prompt against its model's window; an estimate after a newer compaction or when that call reported no usage
    const meter = useMemo(() => {
        const src = rows ?? [];
        const promptAt = src.findLastIndex((r) => r.meta?.promptTokens != null);
        const summaryAt = src.findLastIndex((r) => r.summary);
        const meta = src[promptAt]?.meta;
        const estimate = summaryAt > promptAt || meta?.usageEstimated === true;
        const used = summaryAt > promptAt
            ? Math.ceil(src.slice(summaryAt).reduce((n, r) => n + r.content.length, 0) / 4)
            : (meta?.promptTokens ?? null);
        if (used === null) return null;
        const window = (models?.find((m) => meta?.modelUid && m.modelUid === meta.modelUid) ?? models?.find((m) => m.name === meta?.registryModel) ?? models?.find((m) => m.isDefault))?.contextTokens ?? 0;
        return window > 0 ? { used, window, estimate, hot: used / window >= 0.85 } : null;
    }, [rows, models]);

    const replay = live.findLast((item) => item.kind === "turn" && item.restoring && item.running && item.turnSeq !== undefined);
    const replayFrom = replay?.kind === "turn" ? replay.turnSeq : undefined;
    // appends after the replay boundary stay stored; the turn's completion restores the whole history
    const past = useMemo(() => rows === null ? [] : rebuild(replayFrom === undefined ? rows : rows.filter((r) => r.id <= replayFrom)), [rows, replayFrom]);

    // the one way the queue changes: the ref first, so a drain under way sees it, then the render, then the store
    const writeQueue = useCallback((next: string[]): void => {
        queued.current = next;
        setQueue(next);
        QUEUE.set(key, next);
        try {
            if (next.length === 0) localStorage.removeItem(`${QUEUE_KEY}:${key}`);
            else localStorage.setItem(`${QUEUE_KEY}:${key}`, JSON.stringify(next));
        } catch {
            // the in-memory copy still carries this session
        }
    }, [key]);

    const patchTurn = useCallback((id: number, fn: (t: Turn) => Turn): void => {
        setLive((list) => list.map((it) => (it.kind === "turn" && it.id === id ? fn(it) : it)));
    }, []);

    const reconcileHistory = useCallback(async (
        through: number,
        signal: AbortSignal,
        completion?: Extract<TurnEvent, { type: "done" }>,
    ): Promise<boolean> => {
        const known = history.current;
        const newest = known?.at(-1)?.id;
        try {
            let page = await listHistory(agent, conversation, PAGE);
            const incoming = [...page.items];
            let oldest = page.items[0]?.id;
            while (page.hasMore && newest !== undefined && oldest !== undefined && oldest > newest) {
                if (signal.aborted || opened.current !== key) return false;
                const before = oldest;
                page = await listHistory(agent, conversation, PAGE, before);
                oldest = page.items[0]?.id;
                if (oldest === undefined || oldest >= before) throw new Error("The gateway could not return the missing messages.");
                incoming.unshift(...page.items);
            }
            if (signal.aborted || opened.current !== key) return false;
            if (incoming.length === 0 && (known?.length ?? 0) > 0) throw new Error("The gateway returned an incomplete conversation history.");
            const refreshed = incoming.map((r) => {
                if (!completion?.finalCallId || r.meta?.callId !== completion.finalCallId) return r;
                const meta = { ...r.meta };
                if (completion.turnDurationMs !== undefined) meta.turnDurationMs = completion.turnDurationMs;
                if (completion.rounds !== undefined) meta.rounds = completion.rounds;
                return { ...r, meta };
            });
            setRows((current) => [...new Map([...(current ?? []), ...refreshed].map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id));
            if (!known?.length || !page.hasMore) setMore(page.hasMore);
            // a turn the gateway lost (a restart mid-turn) stays on screen, closed as broken
            const answered = incoming.at(-1)?.role !== "user";
            setLive((current) => current.filter((item) => item.id > through || (!answered && item.id === through)));
            if (pendingSync.current === null || pendingSync.current <= through) {
                pendingSync.current = null;
                setSyncError("");
            }
            return true;
        } catch (e) {
            if (signal.aborted || opened.current !== key) return false;
            pendingSync.current = Math.max(pendingSync.current ?? through, through);
            setSyncError(`Could not refresh the completed response. ${errorMessage(e)}`);
            return false;
        }
    }, [agent, conversation, key]);

    const refreshHead = useCallback(async (): Promise<void> => {
        try {
            const list = await refreshAgent(agent);
            setInfo(list.find((c) => c.id === conversation) ?? null);
        } catch (e) {
            headFailed.current = errorMessage(e);
            setNotice(headFailed.current);
        }
    }, [agent, conversation]);

    // the store retries a failed list by itself (a gateway restart), and its success ends this screen's notice of the failure
    const listFresh = listRows !== null && !listEntry.stale;
    useEffect(() => {
        if (!listFresh || headFailed.current === "") return;
        const failed = headFailed.current;
        headFailed.current = "";
        setNotice((m) => (m === failed ? "" : m));
    }, [listFresh]);

    /** One turn folded into turnId from its POST or GET …/stream, re-attached after a break; one that ended meanwhile is read from history. */
    const follow = useCallback(async (turnId: number, post: AsyncGenerator<TurnEvent> | null, signal: AbortSignal): Promise<Followed> => {
        const run: Followed = { got: false, ended: false, failed: false, turnSeq: 0 };
        let completion: Extract<TurnEvent, { type: "done" }> | undefined;
        let source = post ?? attachTurn(agent, conversation, signal);
        let attached = post === null;
        // a stream the gateway cuts while the channel stays up is attached again at most 3 times
        let chances = 3;
        for (;;) {
            let heard = false;
            let broke: unknown = null;
            try {
                for await (const ev of source) {
                    // a replay starts the turn over, so what was drawn before the break goes
                    const fresh = attached && !heard;
                    heard = true;
                    run.got = true;
                    if (ev.type === "turn_started") run.turnSeq = ev.turnSeq;
                    if (ev.type === "done") {
                        run.ended = true;
                        completion = ev;
                    }
                    if (ev.type === "error") run.failed = true;
                    // the replay rebuilds each open card, which must come back with the owner's ticks, not all of them
                    patchTurn(turnId, (t) => fold(fresh ? {
                        ...t,
                        segments: [],
                        held: Object.fromEntries(t.segments.flatMap((s) => s.kind === "gate" && s.gate.state === "open" ? [[s.gate.key, s.gate.picks]] : [])),
                    } : t, ev));
                }
            } catch (e) {
                broke = e;
            }
            if (signal.aborted || run.ended || run.failed) break;
            if (!attached && !heard && broke !== null) {
                run.refused = errorMessage(broke);
                break;
            }
            if (attached && broke instanceof ApiError && broke.status === 409) {
                await reconcileHistory(turnId, signal);
                break;
            }
            if (getSnapshot().state === "ready") chances -= 1;
            // only an attach that cannot be made leaves the break on screen; with no error the turn's own line says it
            if (chances < 0 || broke instanceof ApiError) {
                if (broke !== null) {
                    const message = errorMessage(broke);
                    patchTurn(turnId, (t) => ({ ...t, errors: [...t.errors, message] }));
                }
                break;
            }
            // waits for the channel to be ready again
            source = attachTurn(agent, conversation, signal);
            attached = true;
        }
        if (completion && !signal.aborted) await reconcileHistory(turnId, signal, completion);
        return run;
    }, [agent, conversation, patchTurn, reconcileHistory]);

    // the newest page laid over what is shown, on open and again once an agent that refused it is back
    const loadNewest = useCallback((alive: () => boolean): void => {
        listHistory(agent, conversation, PAGE).then(
            (page) => {
                if (!alive() || opened.current !== key) return;
                setError("");
                const current = history.current;
                const curNewest = current?.at(-1)?.id;
                const pageOldest = page.items[0]?.id;
                // a gap wider than one page cannot be bridged by a merge: trust the fresh newest page
                const gap = curNewest !== undefined && pageOldest !== undefined && pageOldest > curNewest;
                if (!current || current.length === 0 || gap) {
                    setRows(page.items);
                    setMore(page.hasMore);
                } else {
                    // from its oldest row on the page is the whole truth: a row it lacks there was cut by an edit on another device
                    const kept = pageOldest === undefined ? [] : current.filter((r) => r.id < pageOldest);
                    setRows([...kept, ...page.items].sort((a, b) => a.id - b.id));
                    if (!page.hasMore) setMore(false);
                }
            },
            (e: unknown) => {
                if (alive()) setError(errorMessage(e));
            },
        );
    }, [agent, conversation, key]);

    useEffect(() => {
        opened.current = key;
        attachedFor.current = "";
        let alive = true;
        const cached = HISTORY_CACHE.get(key);
        setRows(cached?.rows ?? null);
        setLive([]);
        setMore(cached?.more ?? false);
        setBelow(false);
        setError("");
        setNotice("");
        setSyncError("");
        pendingSync.current = null;
        jump.current = true;
        pin.current = null;
        grew.current = 0;
        loading.current = false;
        loadNewest(() => alive);
        void refreshHead();
        return () => {
            alive = false;
        };
    }, [key, loadNewest, refreshHead]);

    const refused = error !== "";
    useEffect(() => {
        if (!me.connected || !refused) return undefined;
        let alive = true;
        loadNewest(() => alive);
        return () => {
            alive = false;
        };
    }, [me.connected, refused, loadNewest]);

    const refresh = useCallback((): void => {
        const through = pendingSync.current;
        if (through === null || running.current) return;
        const controller = new AbortController();
        abort.current = controller;
        running.current = true;
        setBusy(true);
        void reconcileHistory(through, controller.signal).finally(() => {
            if (abort.current !== controller) return;
            abort.current = null;
            running.current = false;
            setBusy(false);
        });
    }, [reconcileHistory]);

    // a read refused while the agent was away (a gateway restart) is retried once it is back
    useEffect(() => {
        if (me.connected) refresh();
    }, [me.connected, refresh]);

    // a turn, an edit or a compaction from another device, or a reconnect that may have missed one, reloads the newest page;
    // a turn this screen streams or replays reconciles the history itself when it ends
    useEffect(() => {
        let alive = true;
        const reload = (): void => {
            if (!running.current) loadNewest(() => alive);
        };
        const changed = (e: Event): void => {
            const { agent: name, sessions } = (e as CustomEvent<ChatChangedDetail>).detail;
            if (name === agent && sessions.includes(conversation)) reload();
        };
        window.addEventListener("mimi:chat-changed", changed);
        window.addEventListener("mimi:resync", reload);
        return () => {
            alive = false;
            window.removeEventListener("mimi:chat-changed", changed);
            window.removeEventListener("mimi:resync", reload);
        };
    }, [agent, conversation, loadNewest]);

    useEffect(() => {
        if (rows === null) return;
        // re-inserted, so this chat is the newest in iteration order
        HISTORY_CACHE.delete(key);
        HISTORY_CACHE.set(key, { rows, more });
        const oldest = HISTORY_CACHE.keys().next().value;
        if (HISTORY_CACHE.size > HISTORY_CACHE_MAX && oldest !== undefined) HISTORY_CACHE.delete(oldest);
    }, [key, rows, more]);

    // the previous page, prepended without moving what the reader is looking at
    const loadOlder = useCallback(async (): Promise<void> => {
        const oldest = rows?.[0];
        if (!oldest || !more || loading.current) return;
        const at = opened.current;
        loading.current = true;
        setOlder(true);
        try {
            const page = await listHistory(agent, conversation, PAGE, oldest.id);
            if (opened.current !== at) return;
            if (page.items.length === 0) {
                // an empty page cannot move the cursor, so `hasMore` here would repeat this request forever
                setMore(false);
                if (page.hasMore) setNotice("Older history could not be read. The gateway skipped broken rows.");
                return;
            }
            pin.current = thread.current?.scrollHeight ?? null;
            setRows((prev) => [...new Map([...page.items, ...(prev ?? [])].map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id));
            setMore(page.hasMore);
        } catch (e) {
            setNotice(errorMessage(e));
        } finally {
            loading.current = false;
            setOlder(false);
        }
    }, [agent, conversation, more, rows]);

    // a history shorter than the viewport cannot scroll to the top trigger, so it back-fills
    useEffect(() => {
        const el = thread.current;
        if (!el || !more || rows === null) return;
        if (el.scrollHeight <= el.clientHeight) void loadOlder();
    }, [rows, more, loadOlder]);

    // leaving drops the socket only: the gateway keeps the turn running, and coming back re-attaches
    useEffect(() => () => abort.current?.abort(), [key]);

    // the one place scrolling is written; layout, not effect, since an offset restored after paint is a visible jump
    useLayoutEffect(() => {
        const el = thread.current;
        if (!el) return;
        if (pin.current !== null) {
            el.scrollTop += el.scrollHeight - pin.current;
            pin.current = null;
        } else if (jump.current) {
            if (rows !== null) {
                el.scrollTop = el.scrollHeight;
                jump.current = false;
                stick.current = true;
                setBelow(false);
            }
        } else if (el.scrollHeight !== grew.current) {
            // a shrink counts too (a gate collapsing); only growth below a reader who scrolled up raises the offer
            if (stick.current) el.scrollTop = el.scrollHeight;
            else if (el.scrollHeight > grew.current && el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM) setBelow(true);
        }
        grew.current = el.scrollHeight;
    });

    const onScroll = useCallback((): void => {
        const el = thread.current;
        if (!el) return;
        // written here only: whatever moved the viewport, the distance to the bottom decides whether to follow
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
        if (stick.current) setBelow(false);
        if (el.scrollTop < NEAR_TOP) void loadOlder();
    }, [loadOlder]);

    const toBottom = useCallback((): void => {
        const el = thread.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        stick.current = true;
        setBelow(false);
    }, []);

    // the keyboard, a growing draft or the queue shrink the thread from below with no render and no scroll: whoever rides the tail stays on it
    useEffect(() => {
        const el = thread.current;
        if (!el) return undefined;
        const follow = new ResizeObserver(() => {
            // a message being edited in the thread keeps its place: the keyboard it raised must not scroll it away
            const editing = document.activeElement instanceof HTMLTextAreaElement && el.contains(document.activeElement);
            if (stick.current && !editing) el.scrollTop = el.scrollHeight;
        });
        follow.observe(el);
        return () => follow.disconnect();
    }, []);

    // a turn running with nobody watching (a reload, another window) is re-attached and replayed from its first event
    useEffect(() => {
        if (!infoBusy) {
            attachedFor.current = "";
            return;
        }
        if (busy || rows === null || attachedFor.current === key) return;
        attachedFor.current = key;
        const turnId = uid();
        // the half-drawn copy a lost socket left behind is about to be replayed in full
        setLive((list) => [
            ...list.filter((it) => !(it.kind === "turn" && it.origin === "live" && !it.running && !it.done)),
            { ...emptyTurn(turnId), restoring: true },
        ]);
        setBusy(true);
        running.current = true;
        stopping.current = false;
        const ctl = new AbortController();
        abort.current = ctl;
        void (async (): Promise<void> => {
            const run = await follow(turnId, null, ctl.signal);
            if (!run.got && ctl.signal.aborted) setLive((list) => list.filter((it) => it.id !== turnId));
            abort.current = null;
            patchTurn(turnId, closeTurn);
            setFinished((f) => Math.max(f, run.turnSeq));
            setBusy(false);
            running.current = false;
            // the fresh row lands busy=false before the guard clears, so this effect does not re-attach to the finished turn
            if (!ctl.signal.aborted) await refreshHead();
            if (run.got && !run.ended) attachedFor.current = "";
            if (run.ended && !run.failed && !stopping.current && !ctl.signal.aborted) handlers.current.drain();
        })();
    }, [infoBusy, busy, rows, key, patchTurn, refreshHead, follow]);

    // kept on the gate itself, so ⌘⏎ sends exactly the ticks on screen
    const toggle = useCallback<OnToggle>((turnId, gate, action) => {
        patchTurn(turnId, (t) => ({
            ...t,
            segments: t.segments.map((s) =>
                s.kind === "gate" && s.gate.id === gate.id && s.gate.state === "open"
                    ? { ...s, gate: { ...s.gate, picks: { ...s.gate.picks, [action]: !s.gate.picks[action] } } }
                    : s,
            ),
        }));
    }, [patchTurn]);

    const answer = useCallback<OnAnswer>((turnId, gate, decisions) => {
        const next = settled(gate.actions, decisions);
        patchTurn(turnId, (t) => ({
            ...t,
            segments: t.segments.map((s) => (s.kind === "gate" && s.gate.id === gate.id && s.gate.state === "open" ? { ...s, gate: { ...s.gate, state: next, decisions } } : s)),
        }));
        // fire and forget: the stream drains elsewhere. A 409 means the gate is gone; the clock says whether it lapsed or was answered elsewhere
        void resolveApproval(gate.key, decisions).catch((e: unknown) => {
            const gone = e instanceof ApiError && e.status === 409;
            const lapsed = gate.deadline - Date.now() <= 0;
            setNotice(gone
                ? lapsed ? "Too late. That gate had already expired and nothing ran." : "That gate was already answered elsewhere. The first answer counts."
                : `The answer did not go through: ${errorMessage(e)}`);
            patchTurn(turnId, (t) => {
                if (!gone && !t.running) return t;
                const state: GateState = !gone ? "open" : lapsed ? "expired" : "elsewhere";
                return {
                    ...t,
                    // only this device's own guess is taken back: the gateway's word may already have replaced it (a new decisions object)
                    segments: t.segments.map((s) => (s.kind === "gate" && s.gate.id === gate.id && s.gate.decisions === decisions ? { ...s, gate: { ...s.gate, state, decisions: {} } } : s)),
                };
            });
        });
    }, [patchTurn]);

    // the gateway's word on a gate whose turn stream never brought it here (a dropped stream): settled by gate id
    useEffect(() => {
        const onResolved = (e: Event): void => {
            const ev = (e as CustomEvent<ApprovalResolvedEvent | undefined>).detail;
            if (ev?.type !== "approval_resolved") return;
            const state: GateState = ev.outcome === "expired" ? "expired" : ev.outcome === "gone" ? "cancelled" : ev.outcome === "denied" ? "denied" : "elsewhere";
            setLive((list) => list.map((it) => it.kind !== "turn" || !it.segments.some((s) => s.kind === "gate" && s.gate.key === ev.gate && s.gate.state === "open") ? it : {
                ...it,
                segments: it.segments.map((s) => s.kind === "gate" && s.gate.key === ev.gate && s.gate.state === "open" ? { ...s, gate: { ...s.gate, state } } : s),
            }));
        };
        window.addEventListener("mimi:approvals-changed", onResolved);
        return () => window.removeEventListener("mimi:approvals-changed", onResolved);
    }, []);

    const settle = useCallback<OnSettle>((turnId, gate, outcome, answers) => {
        patchTurn(turnId, (t) => ({
            ...t,
            segments: t.segments.map((s) => (s.kind === "ask" && s.ask.key === gate && s.ask.outcome === "open" ? { ...s, ask: { ...s.ask, outcome, answers } } : s)),
        }));
    }, [patchTurn]);

    /** One message start to finish; true when the turn ended cleanly, the only case that may release the queue. */
    const deliver = async (text: string, imgs: string[]): Promise<boolean> => {
        unsent.current = false;
        jump.current = true;
        const msgId = uid();
        const turnId = uid();
        setLive((list) => [...list, { kind: "msg", id: msgId, text, images: imgs }, emptyTurn(turnId)]);
        setBusy(true);
        running.current = true;
        stopping.current = false;
        const ctl = new AbortController();
        abort.current = ctl;
        const run = await follow(turnId, runTurn(agent, conversation, text, imgs, ctl.signal), ctl.signal);
        if (run.refused) {
            // refused before anything reached the agent: the message comes back out of the thread
            setLive((list) => list.filter((it) => it.id !== msgId && it.id !== turnId));
            setNotice(`Could not send: ${run.refused}`);
            unsent.current = true;
        }
        abort.current = null;
        patchTurn(turnId, closeTurn);
        setFinished((f) => Math.max(f, run.turnSeq));
        setBusy(false);
        running.current = false;
        // aborted means another chat is on screen now
        if (!ctl.signal.aborted) void refreshHead();
        return run.ended && !run.failed && !stopping.current && !ctl.signal.aborted;
    };

    // each follow-up leaves the queue before it is sent; a turn that does not finish keeps the rest queued
    const drainQueue = async (): Promise<void> => {
        if (running.current || stopPending || rows === null) return;
        for (;;) {
            const next = queued.current[0];
            if (next === undefined) return;
            writeQueue(queued.current.slice(1));
            const text = next.trim();
            if (!text) continue;
            if (await deliver(text, [])) continue;
            if (unsent.current) writeQueue([text, ...queued.current]);
            const left = queued.current.length;
            setNotice(left === 0
                ? "That turn did not finish, so nothing more was sent."
                : `That turn did not finish, so the ${left} queued ${plural(left, "message was", "messages were")} not sent. Edit or remove ${plural(left, "it", "them")} above the box, then send when you are ready.`);
            return;
        }
    };

    const restoreUnsent = (text: string, imgs: string[]): void => {
        // the box takes the images back whatever it holds; the queue only ever takes words
        if (composer.current?.restore(text, imgs) || !text) return;
        writeQueue([text, ...queued.current]);
        setNotice((m) => `${m} The unsent message is back in the queue.`.trim());
    };

    const send = async (text: string, imgs: string[]): Promise<void> => {
        const clean = await deliver(text, imgs);
        if (unsent.current) restoreUnsent(text, imgs);
        if (clean) await drainQueue();
    };

    const submit = (text: string, imgs: string[]): SubmitResult => {
        if (running.current) {
            if (!text) return "refused";
            writeQueue([...queued.current, text]);
            return "queued";
        }
        // before the first page lands, a turn would be ordered against a history that has not arrived
        if (stopPending || rows === null) return "refused";
        if (!text && imgs.length === 0) {
            void drainQueue();
            return "drained";
        }
        void send(text, imgs);
        return "sent";
    };

    const stop = async (): Promise<void> => {
        if (stopPending) return;
        // the stream can end before the stop answers, so the queue is held at once
        stopping.current = running.current;
        setStopPending(true);
        try {
            const r = await stopTurn(agent, conversation);
            if (!r.stopped) {
                toast("Nothing was running.");
                return;
            }
            toast("Stopped.");
            setLive((list) => {
                const last = list.findLast((it) => it.kind === "turn");
                return last ? list.map((x) => (x === last ? { ...last, status: "Generation stopped" } : x)) : list;
            });
        } catch (e) {
            setNotice(errorMessage(e));
        } finally {
            setStopPending(false);
        }
    };

    // an edit truncates the chat from that row for good, unlike compaction, so the confirm is a danger one
    const editMessage = async (messageId: number, text: string): Promise<void> => {
        if (running.current || rows === null) return;
        const over = tooLarge(text, []);
        if (over) {
            setNotice(over);
            return;
        }
        const ok = await dialog.confirm({
            title: "Send the edited message?",
            body: "Every message after this one is deleted for good: the agent's answer and everything that followed, in the chat and in the model's history. The chat then continues from the edited text.",
            ok: "Delete and send",
            danger: true,
        });
        if (!ok) return;
        try {
            await truncateFrom(agent, conversation, messageId);
        } catch (e) {
            setNotice(`Nothing was deleted. ${errorMessage(e)}`);
            return;
        }
        setEditing(null);
        setRows((prev) => (prev ?? []).filter((r) => r.id < messageId));
        setLive([]);
        const clean = await deliver(text, []);
        if (unsent.current) restoreUnsent(text, []);
        if (clean) await drainQueue();
    };

    // the gateway announces the change, so the shell's agent list catches up by itself
    const resume = async (): Promise<void> => {
        try {
            await resumeAgent(agent);
        } catch (e) {
            toast(`Could not resume ${agent}. ${errorMessage(e)}`);
        }
    };

    const rename = (value: string | null): void => {
        setRenaming(false);
        const next = value?.trim();
        // the field starts from the shown title, "Untitled" included: leaving it as it was renames nothing
        if (row && next && next !== title) void actions.rename(row, next);
        // on a phone that would raise the keyboard again
        if (matchMedia("(pointer: fine)").matches) composer.current?.focus();
    };

    // the latest closures for the stable callbacks handed to memoized children
    const handlers = useRef({ submit, stop, editMessage, rename, drain: drainQueue });
    useLayoutEffect(() => {
        handlers.current = { submit, stop, editMessage, rename, drain: drainQueue };
    });
    const onSubmit = useCallback((text: string, imgs: string[]): SubmitResult => handlers.current.submit(text, imgs), []);
    const onStop = useCallback((): void => void handlers.current.stop(), []);
    const onEditSave = useCallback((id: number, text: string): void => void handlers.current.editMessage(id, text), []);
    const onEditCancel = useCallback((): void => setEditing(null), []);
    const onRename = useCallback((value: string | null): void => handlers.current.rename(value), []);
    const onRenameStart = useCallback((): void => setRenaming(true), []);
    const onImage = useCallback((images: string[], start: number, from: HTMLButtonElement): void => setViewing({ images, start, from }), []);
    const onOpenPaste = useCallback<OnOpenPaste>((paste, from) => setReading({ paste, from }), []);

    let pending: { turn: number; gate: Gate } | null = null;
    // a question takes no gate shortcut: ⌘⏎ and Escape answer approvals only
    let asking = false;
    for (const it of live) {
        if (it.kind !== "turn") continue;
        for (const s of it.segments) {
            if (s.kind === "gate" && s.gate.state === "open") pending = { turn: it.id, gate: s.gate };
            if (s.kind === "ask" && s.ask.outcome === "open") asking = true;
        }
    }
    const waiting = pending !== null;

    // only the newest open gate is bound, re-bound on every change so ⌘⏎ sends the ticks as they stand
    useEffect(() => {
        if (!pending) return undefined;
        const { turn, gate } = pending;
        const onKey = (e: KeyboardEvent): void => {
            if (e.isComposing || e.defaultPrevented || !thread.current?.getClientRects().length || thread.current.inert) return;
            if (document.querySelector('dialog[open], [aria-modal="true"], [role="menu"]')) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (gate.actions.some((a) => gate.picks[a.id])) answer(turn, gate, gate.picks);
            } else if (e.key === "Escape") {
                // in a field, Escape means leave the field, never deny the agent's calls
                const el = document.activeElement;
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
                e.preventDefault();
                answer(turn, gate, allOf(gate.actions, false));
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [pending, answer]);

    useEffect(() => {
        if (!waiting) return undefined;
        // refreshed at once: the card decides on `deadline - now` whether the gate is already dead
        setNow(Date.now());
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [waiting]);

    const responding = busy || stillBusy(row);
    const quiet = agentState(me, false, false);
    const word = gated || waiting || asking ? "needs you" : responding ? "responding" : quiet?.word;
    const tone = gated || waiting || asking ? "warn" : responding ? "accent" : quiet?.tone;
    const blocked = !me.connected ? `${agent} is offline` : me.paused ? `${agent} is paused. Resume it to send.` : null;
    // files dragged from the desktop drop anywhere on the chat; enter and leave fire per child, so they are counted
    const [dropping, setDropping] = useState(false);
    const dragDepth = useRef(0);
    const takesDrop = (e: DragEvent<HTMLElement>): boolean => !onWeb && blocked === null && e.dataTransfer.types.includes("Files");
    const compact = slash.find((c) => c.slash === "/compact");
    const recent = emptyChat ? (listRows ?? []).filter((c) => c.id !== conversation && !c.archived && !isDelegation(c) && c.messages > 0).slice(0, 2) : [];

    return (
        <section
            className="chat-screen"
            aria-label={title}
            data-view={onWeb ? "web" : undefined}
            onDragEnter={(e) => {
                if (!takesDrop(e)) return;
                dragDepth.current += 1;
                setDropping(true);
            }}
            onDragOver={(e) => {
                if (!takesDrop(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={(e) => {
                if (!takesDrop(e)) return;
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDropping(false);
            }}
            onDrop={(e) => {
                if (!takesDrop(e)) return;
                e.preventDefault();
                dragDepth.current = 0;
                setDropping(false);
                composer.current?.attach(Array.from(e.dataTransfer.files));
            }}
        >
            <ChatHead
                agent={agent}
                title={title}
                emptyChat={emptyChat}
                word={word}
                tone={tone}
                elsewhere={elsewhere}
                renaming={renaming}
                web={androidApp || (webApp === undefined && !onWeb) ? null : onWeb}
                app={webApp?.appId}
                apps={interfaces.apps}
                onView={onView}
                onRenameStart={onRenameStart}
                onRename={onRename}
                onMenu={setMenu}
                onPick={setPick}
            />
            <div className="thread" ref={thread} onScroll={onScroll} inert={onWeb}>
                {/* zero height with margin-top:auto: a short history settles at the bottom without breaking scroll */}
                {!emptyChat && <div className="threadfill" />}
                {syncError && (
                    <Err>
                        <span>{syncError}</span>
                        <Btn kind="quiet" sm disabled={busy} onClick={refresh}>Refresh response</Btn>
                    </Err>
                )}
                {error && <Err>{error}</Err>}
                {rows === null && !error && !emptyChat && (
                    <div className="skel-wait" aria-hidden="true">
                        {[0, 1, 2].map((n) => (
                            <article key={n} className="msg" data-speaker="agent">
                                <header className="msg-who"><span className="skel" style={{ width: 88 }} /></header>
                                <div className="msg-body">
                                    <span className="skel" style={{ width: "94%" }} />
                                    <span className="skel" style={{ width: n % 2 ? "68%" : "82%" }} />
                                </div>
                            </article>
                        ))}
                    </div>
                )}
                {rows !== null && (older ? (
                    <div className="thread-top" role="status" aria-label="Loading older messages"><span className="skel" style={{ width: 140 }} /></div>
                ) : more && (
                    // keyed off `more`, never the page size: the gateway skips a corrupt row without refilling its slot
                    <div className="thread-top">{rows.length === 0 ? "Older messages exist, but this page gave nothing to page back from." : "Scroll up to load older messages."}</div>
                ))}
                {emptyChat ? <ChatStart agent={agent} recent={recent} /> : rows !== null && (
                    <div className={fresh ? "thread-past enter" : "thread-past"}>
                        <PastThread
                            agent={agent}
                            items={past}
                            editing={editing}
                            canEdit={!busy}
                            onEdit={setEditing}
                            onEditSave={onEditSave}
                            onEditCancel={onEditCancel}
                            onImage={onImage}
                            onOpenPaste={onOpenPaste}
                        />
                    </div>
                )}
                {live.map((it) =>
                    it.kind === "msg" ? (
                        // no edit here: a live message has no db id to truncate from until the chat is next read
                        <Bubble key={`l${it.id}`} speaker="human" who="You" text={it.text} images={it.images} sent onImage={onImage} onOpenPaste={onOpenPaste} />
                    ) : (
                        <TurnBlock key={`l${it.id}`} agent={agent} turn={it} now={it.id === pending?.turn ? now : 0} onToggle={toggle} onAnswer={answer} onSettle={settle} />
                    ),
                )}
                {below && (
                    // sticky with no height of its own: showing it must not count as new content arriving
                    <div className="to-bottom-anchor">
                        <button type="button" className="to-bottom" onClick={toBottom}><Icon name="chevron" sm />Jump to latest</button>
                    </div>
                )}
            </div>
            <div className="chat-dock" inert={onWeb}>
                {/* above the box, not atop the thread: a long chat would keep it scrolled out of sight while the box waits on it */}
                {notice && <Err><span>{notice}</span><Btn kind="quiet" sm onClick={() => setNotice("")}>Hide</Btn></Err>}
                {queue.length > 0 && (
                    <div className="queue">
                        <p className="queue-note">
                            {queue.length} queued. {busy ? "They send in order when this turn ends well." : "They go out in order after your next message."}
                        </p>
                        {queue.map((text, i) => {
                            // a queued message is the text it will send: its pasted blocks show as names, and only the words are edited here
                            const { pastes, text: typed } = parsePasted(text);
                            return (
                                // index keys: the entries have no identity of their own, and their order is what is being edited
                                <div key={i} className="queue-row">
                                    <span className="queue-n">{i + 1}</span>
                                    <div className="queue-item">
                                        {pastes.length > 0 && (
                                            <div className="queue-pastes">
                                                {pastes.map((p, j) => (
                                                    <button key={j} type="button" className="queue-paste" title={`Open ${p.title}`} onClick={(e) => onOpenPaste(p, e.currentTarget)}>{p.title}</button>
                                                ))}
                                            </div>
                                        )}
                                        <textarea
                                            className="queue-text"
                                            rows={1}
                                            aria-label={`Queued message ${i + 1}`}
                                            value={typed}
                                            onChange={(e) => writeQueue(queued.current.map((q, j) => (j === i ? buildPasted(parsePasted(q).pastes, e.target.value) : q)))}
                                        />
                                    </div>
                                    <Btn kind="quiet" sm icon="close" title="Remove from the queue" onClick={() => writeQueue(queued.current.filter((_, j) => j !== i))} />
                                </div>
                            );
                        })}
                    </div>
                )}
                <Composer
                    ref={composer}
                    agent={agent}
                    draftKey={key}
                    busy={busy}
                    stopPending={stopPending}
                    ready={rows !== null}
                    waiting={waiting}
                    queued={queue.length}
                    canAttach={currentModel?.vision === true}
                    noImages={currentModel && !currentModel.vision ? currentModel.name : null}
                    meter={meter}
                    slash={slash}
                    blocked={blocked}
                    onSubmit={onSubmit}
                    onStop={onStop}
                    onNotice={setNotice}
                    onOpenPaste={onOpenPaste}
                />
                {row?.archived && <p className="chat-status">Archived. It stays out of the list until you unarchive it.</p>}
            </div>
            {webSeen && (
                <div className="chat-web" hidden={!onWeb}>
                    <LoadBoundary>
                        <Suspense fallback={<span className="skel skel-wait" style={{ width: 180, margin: 24 }} />}>
                            <InterfacesTab agent={agent} initialApp={webApp?.appId} data={{ ...interfaces, apps: webApp ? [webApp] : [] }} />
                        </Suspense>
                    </LoadBoundary>
                </div>
            )}
            {menu && (
                <Menu
                    label="Chat actions"
                    at={menu}
                    onClose={() => setMenu(null)}
                    items={[
                        ...(me.paused ? [{ id: "resume", label: "Resume agent", icon: "play" as const, run: () => void resume() }, "sep" as const] : []),
                        { id: "pin", label: row?.pinned ? "Unpin" : "Pin", icon: "pin", disabled: !row || emptyChat, run: () => { if (row) void actions.pin(row); } },
                        { id: "rename", label: "Rename", icon: "edit", disabled: emptyChat, run: () => setRenaming(true) },
                        {
                            id: "compact",
                            label: "Compact",
                            icon: "models",
                            // the phone composer shows the bar alone, so the numbers are read here
                            detail: meter ? `${meter.estimate ? "~" : ""}${kilo(meter.used)} / ${kilo(meter.window)}` : undefined,
                            disabled: !compact || responding || emptyChat,
                            run: () => { void Promise.resolve().then(() => compact?.run()).catch((e: unknown) => toast(errorMessage(e))); },
                        },
                        ...(responding ? [{ id: "stop", label: "Stop the turn", icon: "stop" as const, run: () => void stop() }] : []),
                        "sep",
                        { id: "archive", label: row?.archived ? "Unarchive" : "Archive", icon: "archive", disabled: !row || emptyChat, run: () => { if (row) void actions.archive(row); } },
                        { id: "delete", label: "Delete…", icon: "close", danger: true, disabled: !row, run: () => { if (row) void actions.remove(row); } },
                    ]}
                />
            )}
            {pick && (
                <Menu
                    label="Start the chat with"
                    at={pick}
                    onClose={() => setPick(null)}
                    items={agents.map((a) => ({
                        id: a.name,
                        label: a.name,
                        detail: agentState(a, false, false)?.word,
                        // an offline agent could not answer the draft, and this agent is where it already is
                        disabled: a.name === agent || !a.connected,
                        run: () => {
                            const from = here();
                            openEmptyChat(a.name).then((id) => {
                                // the owner moved on meanwhile: the draft stays where it was typed
                                if (here() !== from) return;
                                const held = composer.current?.take();
                                carryDraft(a.name, held?.text ?? "", held?.images ?? []);
                                go({ at: "chat", agent: a.name, id }, { replace: true });
                            }, (e: unknown) => toast(errorMessage(e)));
                        },
                    }))}
                />
            )}
            {viewing && (
                <ImageViewer
                    images={viewing.images}
                    start={viewing.start}
                    from={viewing.from}
                    onClose={() => {
                        setViewing(null);
                        // the opener left with its live bubble; on a phone, focusing the composer would raise the keyboard
                        if (!viewing.from.isConnected && matchMedia("(pointer: fine)").matches) composer.current?.focus();
                    }}
                />
            )}
            {reading && (
                <PasteViewer
                    paste={reading.paste}
                    from={reading.from}
                    onClose={() => {
                        setReading(null);
                        if (!reading.from.isConnected && matchMedia("(pointer: fine)").matches) composer.current?.focus();
                    }}
                />
            )}
            {dropping && (
                <div className="drop-veil" aria-hidden="true">
                    <span>{currentModel?.vision === true ? "Drop images or text files to attach" : `Drop text files to attach. ${currentModel?.name ?? "This model"} cannot read images.`}</span>
                </div>
            )}
        </section>
    );
}

const Chat = memo(ChatView);
export default Chat;
