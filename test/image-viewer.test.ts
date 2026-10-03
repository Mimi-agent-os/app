// chat.tsx is JSX no plain Node runner imports, so the image viewer's contract is read out of its source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const viewer = source.slice(source.indexOf("function ImageViewer("), source.indexOf("\n}\n", source.indexOf("function ImageViewer(")));

test("the viewer holds a Back entry of its own while it is up, and gives it back as it closes", () => {
    assert.match(viewer, /const hold = holdBack\(\(\) => latest\.current\(\)\);/);
    assert.match(viewer, /return \(\) => \{\s*releaseBack\(hold\);/);
    assert.doesNotMatch(source, /pushState|history\.back\(\)/, "route.ts owns history: the chat writes no entry of its own");
});

test("the viewer lies on the dialog's shade, above the palette and every sheet", () => {
    assert.match(viewer, /className="mback dlgback /);
});
