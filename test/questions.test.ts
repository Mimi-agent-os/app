// ask_owner on the app side: when a card's picks make a valid reply, and what replyQuestion posts. approval-api.ts runs for
// real over a stubbed channel that records each request and answers like the gateway's /reply route.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import type { OwnerQuestion } from "@mimi-os/protocol";

import type { QuestionDraft } from "../src/approval-api.ts";

const stub = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const CHANNEL = stub(
    "export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }" +
    "export const checkedFetch = (path, init = {}) => globalThis.__fetch(path, init);" +
    "export const readJson = async (c) => JSON.parse(await c.res.text());",
);
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "./channel.ts" && context.parentURL?.endsWith("/src/approval-api.ts")) return { url: CHANNEL, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const changed: string[] = [];
Object.assign(globalThis, { window: { dispatchEvent: (e: Event) => { changed.push(e.type); return true; } } });

const { questionAnswers, replyQuestion } = await import("../src/approval-api.ts");

const pick = (q: Partial<OwnerQuestion> = {}): OwnerQuestion => ({
    question: "Which day?",
    options: [{ label: "Monday" }, { label: "Tuesday", description: "After the review" }, { label: "Friday" }],
    ...q,
});
const draft = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({ picked: [], other: "", withOther: false, ...over });

test("a single pick is an answer; nothing picked is not", () => {
    assert.deepEqual(questionAnswers([pick()], [draft({ picked: ["Tuesday"] })]), [{ selected: ["Tuesday"] }]);
    assert.equal(questionAnswers([pick()], [draft()]), null);
});

test("a single question with two picks is refused, a multi one takes them in the options' order", () => {
    assert.equal(questionAnswers([pick()], [draft({ picked: ["Friday", "Monday"] })]), null);
    assert.deepEqual(questionAnswers([pick({ multi: true })], [draft({ picked: ["Friday", "Monday"] })]), [{ selected: ["Monday", "Friday"] }]);
});

test("a label that is not an option of the question never travels", () => {
    assert.equal(questionAnswers([pick()], [draft({ picked: ["Sunday"] })]), null);
    assert.deepEqual(questionAnswers([pick({ multi: true })], [draft({ picked: ["Sunday", "Friday"] })]), [{ selected: ["Friday"] }]);
});

test("Other counts only where the question allows it, only when chosen, and only with words in it", () => {
    const open = pick({ other: true });
    assert.deepEqual(questionAnswers([open], [draft({ withOther: true, other: "  Any evening  " })]), [{ selected: [], other: "Any evening" }]);
    assert.equal(questionAnswers([open], [draft({ withOther: true, other: "   " })]), null, "a ticked Other with nothing typed");
    assert.equal(questionAnswers([open], [draft({ other: "Any evening" })]), null, "typed, then un-ticked");
    assert.equal(questionAnswers([pick()], [draft({ withOther: true, other: "Any evening" })]), null, "the question takes no own words");
    assert.deepEqual(
        questionAnswers([pick({ multi: true, other: true })], [draft({ picked: ["Monday"], withOther: true, other: "or Sunday" })]),
        [{ selected: ["Monday"], other: "or Sunday" }],
    );
    assert.equal(questionAnswers([open], [draft({ withOther: true, other: "x".repeat(2001) })]), null, "over QUESTION_OTHER_MAX");
    assert.deepEqual(
        questionAnswers([pick({ multi: true, other: true })], [draft({ picked: ["Monday"], withOther: true, other: " " })]),
        [{ selected: ["Monday"] }],
        "a multi pick stands without the empty Other, as the gateway takes it",
    );
});

test("every question needs its own valid answer, in order", () => {
    const two = [pick(), pick({ question: "Which room?", options: [{ label: "A" }, { label: "B" }] })];
    assert.equal(questionAnswers(two, [draft({ picked: ["Monday"] }), draft()]), null);
    assert.equal(questionAnswers(two, [draft({ picked: ["Monday"] })]), null, "a draft missing for the second question");
    assert.deepEqual(questionAnswers(two, [draft({ picked: ["Monday"] }), draft({ picked: ["B"] })]), [{ selected: ["Monday"] }, { selected: ["B"] }]);
});

test("replyQuestion posts the answers or the dismissal to the gate's /reply, and says the list changed", async () => {
    const sent: { path: string; method: unknown; body: unknown }[] = [];
    Object.assign(globalThis, {
        __fetch: (path: string, init: RequestInit) => {
            sent.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
            return Promise.resolve({ res: new Response(JSON.stringify({ ok: true })) });
        },
    });
    changed.length = 0;
    await replyQuestion("g/1", { answers: [{ selected: ["Monday"], other: "early" }] });
    await replyQuestion("g2", { dismiss: true });
    assert.deepEqual(sent, [
        { path: "/approvals/g%2F1/reply", method: "POST", body: { answers: [{ selected: ["Monday"], other: "early" }] } },
        { path: "/approvals/g2/reply", method: "POST", body: { dismiss: true } },
    ]);
    assert.deepEqual(changed, ["mimi:approvals-changed", "mimi:approvals-changed"]);
});

test("a refusal reaches the card with its status; a second, different reply while one is in flight is refused", async () => {
    let release: () => void = () => undefined;
    Object.assign(globalThis, {
        __fetch: (path: string) => path.startsWith("/approvals/gone/")
            ? Promise.reject(Object.assign(new Error("that gate is no longer open"), { status: 409 }))
            : new Promise((done) => { release = () => done({ res: new Response(JSON.stringify({ ok: true })) }); }),
    });
    await assert.rejects(replyQuestion("gone", { dismiss: true }), { status: 409 });
    const first = replyQuestion("slow", { answers: [{ selected: ["A"] }] });
    const same = replyQuestion("slow", { answers: [{ selected: ["A"] }] });
    await assert.rejects(replyQuestion("slow", { dismiss: true }), /already in progress/);
    release();
    await Promise.all([first, same]);
    await assert.rejects(replyQuestion("..", { dismiss: true }), /no longer open/);
});
