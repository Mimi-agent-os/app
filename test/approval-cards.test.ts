// A chat's approval cards. chat.tsx is JSX no plain Node runner imports, so its thread model (the stretch from the key counter
// to rebuild) is lifted out of the source with its types stripped and fed the events a turn stream carries; the ChatView wiring
// around it is read from the source. The audit's cases: an expired gate read "Denied", a card answered on another device kept
// this device's guess, a re-attach ticked calls the owner had unticked, and a palette row named one call of four.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

import type { GateAction, TurnEvent } from "../src/api.ts";

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const from = source.indexOf("let seq = 0;");
const to = source.indexOf("/** The db's rows walked");
assert.ok(from > 0 && to > from, "chat.tsx keeps its thread model in one stretch");

interface Gate { key: string; picks: Record<string, boolean>; decisions: Record<string, boolean>; state: string }
interface Turn { segments: Array<{ kind: string; gate?: Gate }>; held?: Record<string, Record<string, boolean>> }
const model = new Function(`${stripTypeScriptTypes(source.slice(from, to))}\nreturn { fold, emptyTurn };`)() as {
    fold: (t: Turn, ev: TurnEvent) => Turn;
    emptyTurn: (id: number) => Turn;
};

const actions: GateAction[] = ["a", "b", "c", "d"].map((id) => ({ id, tool: "calendar_create_event", args: { id } }));
const parked = (t: Turn = model.emptyTurn(1)): Turn => model.fold(t, { type: "approval_required", gate: "g1", actions, deadline: Date.now() + 300_000 });
const card = (t: Turn): Gate => t.segments.find((s) => s.kind === "gate")!.gate!;
const none = { a: false, b: false, c: false, d: false };

test("an expired or cancelled gate reads as such, never as a Deny the owner did not give", () => {
    const ended = (outcome: "approved" | "denied" | "expired" | "gone", decisions: Record<string, boolean>): string =>
        card(model.fold(parked(), { type: "approval_resolved", gate: "g1", outcome, decisions })).state;
    assert.equal(ended("expired", none), "expired");
    assert.equal(ended("gone", none), "cancelled");
    assert.equal(ended("denied", none), "denied");
    assert.equal(ended("approved", { a: true, b: true, c: false, d: false }), "partial");
    assert.equal(ended("approved", { a: true, b: true, c: true, d: true }), "allowed");
});

test("the gateway's word overrules this device's own guess, which another device may have beaten", () => {
    const t = parked();
    // this device pressed Deny, the phone's Allow got there first
    const guessed: Turn = { ...t, segments: t.segments.map((s) => s.kind === "gate" ? { ...s, gate: { ...s.gate!, state: "denied", decisions: none } } : s) };
    const truth = model.fold(guessed, { type: "approval_resolved", gate: "g1", outcome: "approved", decisions: { a: true, b: true, c: true, d: true } });
    assert.equal(card(truth).state, "allowed");
});

test("a re-attach replays an open card with the owner's ticks, not all of them", () => {
    const fresh = card(parked());
    assert.deepEqual(fresh.picks, { a: true, b: true, c: true, d: true });
    const replayed = parked({ ...model.emptyTurn(1), held: { g1: { a: true, b: true, c: false, d: false } } });
    assert.deepEqual(card(replayed).picks, { a: true, b: true, c: false, d: false });
    assert.match(source, /patchTurn\(turnId, \(t\) => fold\(fresh \? \{\s*\.\.\.t,\s*segments: \[\],\s*held: Object\.fromEntries\(t\.segments\.flatMap\(\(s\) => s\.kind === "gate" && s\.gate\.state === "open" \? \[\[s\.gate\.key, s\.gate\.picks\]\] : \[\]\)\),/);
});

test("a card whose stream went quiet is settled by the gate's id from the device-wide event", () => {
    const effect = /const onResolved = \(e: Event\): void => \{([\s\S]*?)\n {8}\};\n {8}window\.addEventListener\("mimi:approvals-changed", onResolved\);/.exec(source);
    assert.ok(effect, "ChatView listens for the gateway's resolutions");
    const body = effect[1] as string;
    assert.match(body, /if \(ev\?\.type !== "approval_resolved"\) return;/);
    assert.match(body, /ev\.outcome === "expired" \? "expired" : ev\.outcome === "gone" \? "cancelled" : ev\.outcome === "denied" \? "denied" : "elsewhere"/);
    assert.match(body, /s\.gate\.key === ev\.gate && s\.gate\.state === "open"/, "only a card still open: a stream's word carries the per-call decisions");
});

test("a late answer takes back only this device's guess, and a passed deadline waits for the gateway instead of guessing", () => {
    assert.match(source, /const state: GateState = !gone \? "open" : lapsed \? "expired" : "elsewhere";/);
    assert.match(source, /s\.gate\.id === gate\.id && s\.gate\.decisions === decisions \?/);
    assert.doesNotMatch(source, /gate\.state === "open" && left <= 0 \? "expired"/);
    assert.match(source, /\{left <= 0 \? <p className="gate-note">Time is up\. Waiting for the gateway to close the request\.<\/p> : <div className="btns">/);
    assert.match(source, /\{state !== "elsewhere" && \(/, "no per-call verdicts this device does not know");
});

test("the palette's row for a batch says how many calls wait", () => {
    assert.match(app, /: `\$\{a\.agent\} · \$\{a\.tool\}\$\{a\.actions\.length > 1 \? ` and \$\{a\.actions\.length - 1\} more` : ""\}`,/);
});
