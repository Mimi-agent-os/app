// The ask_owner card: an agent's questions with their options, answered in the chat or from Inbox, then kept as the record.
import { useId, useState } from "react";
import type { ReactElement } from "react";

import { QUESTION_OTHER_MAX, type OwnerAnswer, type OwnerQuestion, type QuestionOutcome, type QuestionReply } from "@mimi-os/protocol";

import { questionAnswers, replyQuestion, type QuestionDraft } from "../approval-api.ts";
import { ApiError } from "../channel.ts";
import { errorMessage } from "../shared.ts";
import { Btn, Countdown } from "./ui.tsx";
import "../chat.css";

export type AskOutcome = "open" | QuestionOutcome;

// the picks outlive the card: a replayed stream or a move between the chat and Inbox mounts it again
const DRAFTS = new Map<string, QuestionDraft[]>();

const HEAD: Record<AskOutcome, string> = {
    open: "Awaiting your answer",
    answered: "Answered",
    dismissed: "Dismissed",
    expired: "Expired",
    gone: "Closed",
};

const NOTE: Record<AskOutcome, string> = {
    open: "",
    answered: "The agent got these answers and went on from there.",
    dismissed: "You dismissed the questions. The agent was told to go on without the answers.",
    expired: "Nobody answered in time. The agent was told to go on without the answers.",
    gone: "The question closed before an answer: the turn was stopped or the gateway restarted.",
};

export function QuestionCard({ gate, questions, deadline, outcome, answers, closed, onSettled }: {
    gate: string;
    questions: readonly OwnerQuestion[];
    /** Epoch ms when the gateway gives up on an answer. */
    deadline: number;
    outcome: AskOutcome;
    /** The picks once answered, null otherwise. */
    answers: readonly OwnerAnswer[] | null;
    /** The gateway no longer lists this question, so nothing sent from here could land. */
    closed?: boolean | undefined;
    onSettled: (outcome: "answered" | "dismissed", answers: OwnerAnswer[] | null) => void;
}): ReactElement {
    const id = useId();
    const [drafts, setDrafts] = useState(() => DRAFTS.get(gate) ?? questions.map((): QuestionDraft => ({ picked: [], other: "", withOther: false })));
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const [gone, setGone] = useState(false);

    if (outcome !== "open") {
        return (
            <div className="gate ask resolved">
                <div className="gh"><b>{HEAD[outcome]}</b></div>
                <div className="gb">
                    <p className="gate-note">{NOTE[outcome]}</p>
                    <ol className="ask-record">
                        {questions.map((q, i) => {
                            const answer = answers?.[i];
                            return (
                                <li key={i}>
                                    <span>{q.question}</span>
                                    {answer && answer.selected.length > 0 && <span className="ask-picked">{answer.selected.join(", ")}</span>}
                                    {answer?.other && <span className="ask-own">“{answer.other}”</span>}
                                </li>
                            );
                        })}
                    </ol>
                </div>
            </div>
        );
    }

    const reply = questionAnswers(questions, drafts);
    const shut = gone || closed === true;
    const edit = (i: number, change: (draft: QuestionDraft) => QuestionDraft): void => {
        const next = drafts.map((d, j) => (j === i ? change(d) : d));
        DRAFTS.set(gate, next);
        setDrafts(next);
    };
    const send = async (body: QuestionReply): Promise<void> => {
        if (sending || shut) return;
        setSending(true);
        setError("");
        try {
            await replyQuestion(gate, body);
            DRAFTS.delete(gate);
            onSettled("answers" in body ? "answered" : "dismissed", "answers" in body ? body.answers : null);
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) setGone(true);
            else setError(errorMessage(e, "The answer did not go through. Try again."));
        } finally {
            setSending(false);
        }
    };

    return (
        <div
            className={shut ? "gate ask resolved" : "gate ask"}
            onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing || !(e.target instanceof HTMLInputElement)) return;
                e.preventDefault();
                if (reply) void send({ answers: reply });
            }}
        >
            <div className="gh">
                <b>{shut ? HEAD.gone : HEAD.open}</b>
                {!shut && <Countdown deadline={deadline} />}
            </div>
            <div className="gb">
                {questions.map((q, i) => {
                    const draft = drafts[i] ?? { picked: [], other: "", withOther: false };
                    const name = `${id}-q${i}`;
                    return (
                        <fieldset key={i} className="ask-q">
                            <legend className="ask-question">
                                {q.question}
                                {q.multi && <span className="ask-hint"> Pick any that apply.</span>}
                            </legend>
                            <div
                                className="ask-opts"
                                onKeyDown={(e) => {
                                    // radios move on arrows natively; checkboxes get the same within their group
                                    if (!(e.target instanceof HTMLInputElement) || e.target.type !== "checkbox") return;
                                    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                                    if (step === 0) return;
                                    e.preventDefault();
                                    const boxes = [...e.currentTarget.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
                                    boxes[(boxes.indexOf(e.target) + step + boxes.length) % boxes.length]?.focus();
                                }}
                            >
                                {q.options.map((o) => {
                                    const on = draft.picked.includes(o.label);
                                    return (
                                        <label key={o.label} className="ask-opt">
                                            <input
                                                type={q.multi ? "checkbox" : "radio"}
                                                name={name}
                                                checked={on}
                                                disabled={shut}
                                                onChange={() => edit(i, (d) => q.multi
                                                    ? { ...d, picked: on ? d.picked.filter((p) => p !== o.label) : [...d.picked, o.label] }
                                                    : { ...d, picked: [o.label], withOther: false })}
                                            />
                                            <span className="ask-opt-body">
                                                <span>{o.label}</span>
                                                {o.description && <small>{o.description}</small>}
                                            </span>
                                        </label>
                                    );
                                })}
                                {q.other && (
                                    <div className="ask-opt ask-other">
                                        <input
                                            type={q.multi ? "checkbox" : "radio"}
                                            id={`${name}-other`}
                                            name={name}
                                            checked={draft.withOther}
                                            disabled={shut}
                                            onChange={() => edit(i, (d) => q.multi ? { ...d, withOther: !d.withOther } : { ...d, picked: [], withOther: true })}
                                        />
                                        <span className="ask-opt-body">
                                            <label htmlFor={`${name}-other`}>Other</label>
                                            <input
                                                type="text"
                                                value={draft.other}
                                                maxLength={QUESTION_OTHER_MAX}
                                                placeholder="In your own words"
                                                aria-label="Other, in your own words"
                                                disabled={shut}
                                                // typing is choosing Other; for a single pick it replaces the option picked
                                                onChange={(e) => {
                                                    const text = e.target.value;
                                                    edit(i, (d) => ({ ...d, other: text, withOther: true, picked: q.multi ? d.picked : [] }));
                                                }}
                                            />
                                        </span>
                                    </div>
                                )}
                            </div>
                        </fieldset>
                    );
                })}
                {(error || shut) && <div className="err" role="alert">{error || "This question is no longer open."}</div>}
                <div className="btns">
                    <Btn kind="primary" disabled={reply === null || sending || shut} title={reply === null ? "Answer every question first." : undefined} onClick={() => { if (reply) void send({ answers: reply }); }}>
                        {sending ? "Sending…" : "Send"}
                    </Btn>
                    <Btn kind="quiet" disabled={sending || shut} onClick={() => void send({ dismiss: true })}>Dismiss</Btn>
                    <span className="hint">Send <kbd>⏎</kbd></span>
                </div>
            </div>
        </div>
    );
}
