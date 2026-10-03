// ui.tsx is JSX no plain Node runner imports, so LoadBoundary's "the file never arrived" pattern is read out of its source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/components/ui.tsx", import.meta.url), "utf8");
const literal = /const missing = (\/.+\/[a-z]*)\.test\(error\.message\)/.exec(source)?.[1];
assert.ok(literal, "ui.tsx tells a missing file from a crash with one regex literal");
const missing = new Function(`return ${literal}`)() as RegExp;

test("a chunk that never arrived reads as not loaded in every engine", () => {
    for (const message of [
        "Failed to fetch dynamically imported module: tauri://localhost/assets/gateway-3f2a.js",
        "Importing a module script failed.",
        "error loading dynamically imported module: http://localhost:5173/src/views/inbox.tsx",
    ]) assert.ok(missing.test(message), message);
});

test("a crash while rendering is not mistaken for a missing file", () => {
    for (const message of [
        "undefined is not an object (evaluating 'day.resetsAt')",
        "Cannot read properties of undefined (reading 'resetsAt')",
        "Objects are not valid as a React child",
    ]) assert.ok(!missing.test(message), message);
});
