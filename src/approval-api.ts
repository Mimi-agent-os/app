import { QUESTION_OTHER_MAX, type OwnerAnswer, type OwnerQuestion, type QuestionReply } from "@mimi-os/protocol";

import { checkedFetch, readJson } from "./channel.ts";
import { singleFlight } from "./shared.ts";

export interface ApprovalSummary {
    gate: string;
    /** A question (ask_owner) is answered with picks on /reply, never allowed or denied. */
    kind: "approval" | "question";
    agent: string;
    conversation?: number;
    room?: string;
    tool: string;
    label: string;
    actions: { id: string; label: string }[];
    /** UTC "YYYY-MM-DD HH:MM:SS" on the gateway's clock. */
    since: string;
    deadline: number;
}

export interface ApprovalDetail extends Omit<ApprovalSummary, "actions"> {
    actions: { id: string; label: string; detail: unknown }[];
    /** Empty on an approval. */
    questions: OwnerQuestion[];
}

/** One question as the card holds it: the picked labels, and the owner's own words with whether they count. */
export interface QuestionDraft {
    picked: string[];
    other: string;
    withOther: boolean;
}

export async function listApprovals(signal?: AbortSignal): Promise<ApprovalSummary[]> {
    const data = await readJson<{ approvals: ApprovalSummary[] }>(await checkedFetch("/approvals", { signal: signal ?? null }));
    return data.approvals;
}

export async function getApproval(gate: string, signal?: AbortSignal): Promise<ApprovalDetail> {
    const data = await readJson<ApprovalDetail>(await checkedFetch(`/approvals/${encodeURIComponent(gate)}`, { signal: signal ?? null }));
    if (data.gate !== gate || !Array.isArray(data.actions) || data.actions.some((action) =>
        typeof action.id !== "string" || !Object.prototype.hasOwnProperty.call(action, "detail"))) {
        throw new Error("This request did not include the action details needed for review.");
    }
    if (data.kind === "question" && (!Array.isArray(data.questions) || data.questions.length === 0)) {
        throw new Error("This question arrived without its questions.");
    }
    return data;
}

/** The answers a question gate takes, one per question in order, or null while any question still lacks a valid one. */
export function questionAnswers(questions: readonly OwnerQuestion[], drafts: readonly QuestionDraft[]): OwnerAnswer[] | null {
    const answers: OwnerAnswer[] = [];
    for (const [i, q] of questions.entries()) {
        const draft = drafts[i];
        if (!draft) return null;
        const selected = q.options.filter((o) => draft.picked.includes(o.label)).map((o) => o.label);
        const other = q.other === true && draft.withOther ? draft.other.trim() : "";
        if (other.length > QUESTION_OTHER_MAX) return null;
        if (selected.length > 1 && q.multi !== true) return null;
        if (selected.length === 0 && !other) return null;
        const answer: OwnerAnswer = { selected };
        if (other) answer.other = other;
        answers.push(answer);
    }
    return answers;
}

const answers = new Map<string, { tag: string; flight: Promise<void> }>();

export function resolveApproval(gate: string, decisions: Record<string, boolean>, signal?: AbortSignal): Promise<void> {
    if (!gate || gate === "." || gate === "..") return Promise.reject(new Error("This approval request is no longer available."));
    if (signal?.aborted) return Promise.reject(new DOMException("The request was cancelled.", "AbortError"));
    const signature = JSON.stringify(Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b)));
    return singleFlight(answers, gate, signature, "mimi:approvals-changed", async () => {
        const init: RequestInit = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decisions }),
            signal: signal ?? null,
        };
        const response = await readJson<{ ok?: unknown }>(await checkedFetch(`/approvals/${encodeURIComponent(gate)}/answer`, init));
        if (response.ok !== true) throw new Error("The gateway did not confirm this decision. Refresh its status before trying again.");
    });
}

/** Answers a question gate, or dismisses it. A 400 carries what is wrong with the answers, a 409 means the gate is gone. */
export function replyQuestion(gate: string, reply: QuestionReply): Promise<void> {
    if (!gate || gate === "." || gate === "..") return Promise.reject(new Error("This question is no longer open."));
    return singleFlight(answers, gate, JSON.stringify(reply), "mimi:approvals-changed", async () => {
        const init: RequestInit = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(reply),
        };
        const response = await readJson<{ ok?: unknown }>(await checkedFetch(`/approvals/${encodeURIComponent(gate)}/reply`, init));
        if (response.ok !== true) throw new Error("The gateway did not confirm this answer. Refresh its status before trying again.");
    });
}
