// chat.tsx's stop-marker pattern, read out of the JSX source and run on its own.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const declared = /^const STOP_MARK = \/(.+)\/;$/m.exec(source);
assert.ok(declared, "chat.tsx declares STOP_MARK as a plain regex literal");
const STOP_MARK = new RegExp(declared[1] as string);

test("the stop marker is recognised only where the loop appends it", () => {
    assert.match("Here is half an answer [stopped by user]", STOP_MARK);
    assert.match("Here is half an answer [stopped by user]  \n", STOP_MARK);
    assert.doesNotMatch("[stopped by user] and then more text", STOP_MARK);
    assert.doesNotMatch("nothing was stopped here", STOP_MARK);
    assert.equal("Half an answer.  [stopped by user]".replace(STOP_MARK, "").trimEnd(), "Half an answer.");
});

test("a long message the marker does not end matches in linear time", () => {
    const text = `${" ".repeat(200_000)}[stopped by use`;
    const started = performance.now();
    assert.doesNotMatch(text, STOP_MARK);
    assert.ok(performance.now() - started < 1000, "the pattern must not backtrack over the whitespace run");
});
