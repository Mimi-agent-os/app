import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { OwnerAnswer } from "@mimi-os/protocol";

import {
    getApproval,
    listApprovals,
    resolveApproval,
    type ApprovalDetail,
    type ApprovalSummary,
} from "../approval-api.ts";
import { ApiError } from "../channel.ts";
import { errorMessage } from "../shared.ts";
import { QuestionCard } from "./question-card.tsx";
import { AgentMark, Btn } from "./ui.tsx";
import "../inbox.css";

interface ApprovalRequestsProps {
    /** The gate to show expanded, from Inbox's URL. */
    open?: string | undefined;
    onOpenChat?: ((agent: string, conversation: number) => void) | undefined;
}

export default function ApprovalRequests({ open, onOpenChat }: ApprovalRequestsProps): ReactElement | null {
    const [rows, setRows] = useState<ApprovalSummary[]>([]);
    // an open question the gateway stopped listing stays, showing how it ended, until it is closed
    const [held, setHeld] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [expanded, setExpanded] = useState<string | null>(open ?? null);
    const [opened, setOpened] = useState(open);
    if (open !== opened) {
        setOpened(open);
        if (open !== undefined) setExpanded(open);
    }
    const shown = useRef({ rows, expanded });
    shown.current = { rows, expanded };
    const lifetime = useRef<AbortController | null>(null);
    const request = useRef(0);
    const id = useId();

    const reload = useCallback(async (): Promise<void> => {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted) return;
        const serial = ++request.current;
        try {
            const approvals = await listApprovals(signal);
            if (signal.aborted || serial !== request.current) return;
            const { rows: before, expanded: gate } = shown.current;
            const kept = before.find((row) => row.gate === gate && row.kind === "question" && !approvals.some((a) => a.gate === gate));
            setRows(kept ? [...approvals, kept] : approvals);
            setHeld(kept?.gate ?? null);
            setExpanded(kept || approvals.some((row) => row.gate === gate) ? gate : null);
            setError("");
        } catch (e) {
            if (signal.aborted || serial !== request.current) return;
            setError(errorMessage(e, "Could not load approval requests."));
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void reload();
        const refresh = (): void => { void reload(); };
        window.addEventListener("mimi:approvals-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
        return () => {
            controller.abort();
            window.removeEventListener("mimi:approvals-changed", refresh);
            window.removeEventListener("mimi:resync", refresh);
        };
    }, [reload]);

    if (rows.length === 0 && !error) return null;

    const waiting = rows.length - (held === null ? 0 : 1);
    return <section className="approvals" aria-label="Needs you">
        <div className="approvals-head">
            <h3>{waiting > 0 ? `Needs you (${waiting})` : "Needs you"}</h3>
            <Btn sm icon="refresh" title="Refresh requests" onClick={() => void reload()} />
        </div>
        {error && <p className="approval-error" role="alert">Could not refresh requests: {error}</p>}
        {rows.map((row) => <div className="item approval" key={row.gate}>
            <div className="approval-top">
                <div className="approval-what">
                    <span className="t-sm dim3 approval-agent"><AgentMark agent={row.agent} />{row.agent}</span>
                    <span>{row.label || row.tool}</span>
                </div>
                <button className="btn sm" type="button" aria-expanded={expanded === row.gate} aria-controls={`${id}-approval-detail-${row.gate}`} onClick={() => {
                    // a held question goes once anything is opened or closed
                    if (held !== null) {
                        setRows((current) => current.filter((r) => r.gate !== held));
                        setHeld(null);
                    }
                    setExpanded((current) => current === row.gate ? null : row.gate);
                }}>
                    {expanded === row.gate ? "Close" : row.kind === "question" ? "Answer" : "Review"}
                </button>
            </div>
            {expanded === row.gate && (row.kind === "question"
                ? <QuestionReview key={row.gate} id={`${id}-approval-detail-${row.gate}`} row={row} held={row.gate === held} onOpenChat={onOpenChat} />
                : <ApprovalReview key={row.gate} id={`${id}-approval-detail-${row.gate}`} row={row} onChange={reload} onOpenChat={onOpenChat} />)}
        </div>)}
    </section>;
}

/** A question opened from Inbox: the chat's own card, answerable here. */
function QuestionReview({ id, row, held, onOpenChat }: {
    id: string;
    row: ApprovalSummary;
    /** The gateway no longer lists it. */
    held: boolean;
    onOpenChat: ApprovalRequestsProps["onOpenChat"];
}): ReactElement {
    const [detail, setDetail] = useState<ApprovalDetail | null>(null);
    const [failed, setFailed] = useState<{ message: string; gone: boolean } | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [settled, setSettled] = useState<{ outcome: "answered" | "dismissed"; answers: OwnerAnswer[] | null } | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        setFailed(null);
        getApproval(row.gate, controller.signal).then(
            (next) => setDetail(next),
            (e: unknown) => {
                if (controller.signal.aborted) return;
                const gone = e instanceof ApiError && [404, 409, 410].includes(e.status);
                setFailed({ message: gone ? "This question is no longer open." : errorMessage(e, "Could not load the questions. Try again."), gone });
            },
        );
        return () => controller.abort();
    }, [row.gate, attempt]);

    return <div id={id} className="approval-review">
        {row.room === undefined && row.conversation !== undefined && onOpenChat && <div><Btn sm kind="quiet" icon="chat" onClick={() => onOpenChat(row.agent, row.conversation!)}>Open chat</Btn></div>}
        {!detail && !failed && <span className="t-sm dim3">Loading the questions…</span>}
        {failed && <div className="approval-error" role="alert">{failed.message}{!failed.gone && <div><Btn sm icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Retry</Btn></div>}</div>}
        {detail && <QuestionCard
            gate={detail.gate}
            questions={detail.questions}
            deadline={detail.deadline}
            outcome={settled?.outcome ?? "open"}
            answers={settled?.answers ?? null}
            closed={held}
            onSettled={(outcome, answers) => setSettled({ outcome, answers })}
        />}
    </div>;
}

interface ApprovalReviewProps {
    id: string;
    row: ApprovalSummary;
    onChange: () => Promise<void>;
    onOpenChat: ApprovalRequestsProps["onOpenChat"];
}

function ApprovalReview({ id, row, onChange, onOpenChat }: ApprovalReviewProps): ReactElement {
    const [detail, setDetail] = useState<ApprovalDetail | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const [status, setStatus] = useState<"pending" | "gone" | "answered">("pending");
    const [now, setNow] = useState(Date.now);
    const lifetime = useRef<AbortController | null>(null);
    const saving = useRef(false);
    const request = useRef(0);
    const refreshedExpiry = useRef(false);
    const deadline = detail?.deadline ?? row.deadline;
    const expired = !Number.isFinite(deadline) || now >= deadline;

    const load = useCallback(async (): Promise<void> => {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted) return;
        const serial = ++request.current;
        setLoading(true);
        setError("");
        setDetail(null);
        setSelected(new Set());
        try {
            const next = await getApproval(row.gate, signal);
            if (!signal.aborted && serial === request.current) {
                setDetail(next);
                // every action ticked, like the chat's gate card: Allow is one press, unticking is the exception
                setSelected(new Set(next.actions.map((action) => action.id)));
                setStatus("pending");
            }
        } catch (e) {
            if (signal.aborted || serial !== request.current) return;
            if (e instanceof ApiError && [404, 409, 410].includes(e.status)) {
                setStatus("gone");
                void onChange();
            } else setError(errorMessage(e, "Could not load the action details. Try again."));
        } finally {
            if (!signal.aborted && serial === request.current) setLoading(false);
        }
    }, [row.gate, onChange]);

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void load();
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, [load]);

    useEffect(() => {
        if (expired && !refreshedExpiry.current) {
            refreshedExpiry.current = true;
            void onChange();
        }
    }, [expired, onChange]);

    const answer = async (allow: boolean): Promise<void> => {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted || !detail || detail.actions.length === 0 || saving.current || expired || status !== "pending") return;
        if (Date.now() >= detail.deadline) {
            setNow(Date.now());
            void onChange();
            return;
        }
        saving.current = true;
        setPending(true);
        setError("");
        try {
            await resolveApproval(detail.gate, Object.fromEntries(detail.actions.map((action) => [action.id, allow && selected.has(action.id)])), signal);
            if (signal.aborted) return;
            setStatus("answered");
            void onChange();
        } catch (e) {
            if (signal.aborted) return;
            if (e instanceof ApiError && [404, 409, 410].includes(e.status)) {
                setStatus("gone");
                void onChange();
            } else setError(errorMessage(e, "Could not save this decision. Refresh its status before trying again."));
        } finally {
            saving.current = false;
            if (!signal.aborted) setPending(false);
        }
    };

    const disabled = pending || expired || status !== "pending";
    const statusLine = loading ? "Loading action details…"
        : status === "gone" ? "This request is no longer available."
        : status === "answered" ? "Request answered."
        : expired ? "This request expired. Refreshing its status…"
        : detail ? "Review the arguments. Untick any action you do not allow." : "";
    const all = detail !== null && selected.size === detail.actions.length;
    return <div id={id} className="approval-review">
        {row.room === undefined && row.conversation !== undefined && onOpenChat && <div><Btn sm kind="quiet" icon="chat" onClick={() => onOpenChat(row.agent, row.conversation!)}>Open chat</Btn></div>}
        {statusLine && <span className="t-sm dim3">{statusLine}</span>}
        {detail?.actions.map((action) => <div key={action.id} className="approval-act">
            <label>
                <input type="checkbox" disabled={disabled} checked={selected.has(action.id)} onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(action.id); else next.delete(action.id);
                    return next;
                })} />{action.label}
            </label>
            <pre>{typeof action.detail === "string" ? action.detail : JSON.stringify(action.detail, null, 2)}</pre>
        </div>)}
        {error && <div className="approval-error" role="alert">{error}{!detail && <div><Btn sm icon="refresh" onClick={() => void load()}>Retry details</Btn></div>}</div>}
        {detail && <div className="approval-btns">
            <Btn kind="quiet" sm disabled={disabled || detail.actions.length === 0} onClick={() => void answer(false)}>Deny</Btn>
            <Btn kind="accent" sm disabled={disabled || selected.size === 0} onClick={() => void answer(true)}>
                {pending ? "Saving…" : all ? "Allow" : `Allow ${selected.size} of ${detail.actions.length}`}
            </Btn>
        </div>}
    </div>;
}
