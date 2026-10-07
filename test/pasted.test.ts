// Pasted text in the box; the block format and its round trips are tested in protocol. pasted.ts runs for real; composer.tsx,
// chat.tsx and paste-card.tsx are JSX no plain Node runner imports, so only their wiring is read from the source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BODY_BUDGET, FILE_MAX, isLongPaste, newPaste, PASTE_CHARS, PASTE_LINES, readDropped, size, textSize, tooLarge } from "../src/pasted.ts";

test("a paste over 2,000 characters or 30 lines becomes a card; one at the limit stays in the box", () => {
    assert.equal(PASTE_CHARS, 2000);
    assert.equal(PASTE_LINES, 30);
    assert.equal(isLongPaste("x".repeat(2000)), false);
    assert.equal(isLongPaste("x".repeat(2001)), true);
    assert.equal(isLongPaste(Array(30).fill("l").join("\n")), false);
    assert.equal(isLongPaste(Array(31).fill("l").join("\n")), true);
    assert.equal(isLongPaste(`${Array(30).fill("l").join("\n")}\n`), false, "a final line break opens no 31st line");
    assert.equal(isLongPaste(Array(31).fill("l").join("\r\n")), true);
    assert.equal(isLongPaste(""), false);
});

test("a long paste is numbered after the highest pasted card in the box, whatever else sits there", () => {
    assert.deepEqual(newPaste([], "a\nb"), { title: "Pasted text 1", lines: 2, text: "a\nb" });
    const box = [newPaste([], "x"), { title: "notes.md", lines: 1, text: "y" }, { title: "Pasted text 3", lines: 1, text: "z" }];
    assert.equal(newPaste(box, "w").title, "Pasted text 4");
    assert.equal(newPaste([{ title: "Pasted text 2", lines: 1, text: "kept after 1 was removed" }], "w").title, "Pasted text 3");
    assert.equal(newPaste([{ title: "Pasted text 1 (copy)", lines: 1, text: "a file name, not a paste" }], "w").title, "Pasted text 1");
});

test("a dropped file: an image keeps the image path, text-like files become cards, binary and other files are refused", async () => {
    assert.deepEqual(await readDropped(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })), { kind: "image" });
    assert.deepEqual(await readDropped(new File(["# Plan\n\n- one"], "plan.md", { type: "text/markdown" })), {
        kind: "text", paste: { title: "plan.md", lines: 3, text: "# Plan\n\n- one" },
    });
    // the extension wins over a type the OS guessed wrong (.ts is MPEG transport stream to many)
    assert.equal((await readDropped(new File(["export const a = 1;\n"], "a.ts", { type: "video/mp2t" }))).kind, "text");
    assert.equal((await readDropped(new File(['{"a":1}'], "data", { type: "application/json" }))).kind, "text");
    assert.equal((await readDropped(new File(["k: v"], "conf.yml", { type: "" }))).kind, "text");
    assert.equal((await readDropped(new File(["all: build"], "Makefile", { type: "" }))).kind, "text");
    assert.equal((await readDropped(new File(["MIT"], "LICENSE", { type: "" }))).kind, "text", "an untyped file is read and left to the NUL check");
    assert.equal((await readDropped(new File(["<svg/>"], "feed.atom", { type: "application/atom+xml" }))).kind, "text");
    const binary = await readDropped(new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1])], "tool", { type: "application/octet-stream" }));
    assert.deepEqual(binary, { kind: "refused", reason: "tool is not text." });
    const nulInText = await readDropped(new File(["looks\u0000like text"], "odd.txt", { type: "text/plain" }));
    assert.equal(nulInText.kind, "refused");
    assert.deepEqual(await readDropped(new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" })), { kind: "refused", reason: "paper.pdf is neither text nor an image." });
    assert.equal((await readDropped(new File(["x"], "a.zip", { type: "application/zip" }))).kind, "refused");
    const big = await readDropped(new File(["x".repeat(FILE_MAX + 1)], "huge.log", { type: "text/plain" }));
    assert.deepEqual(big, { kind: "refused", reason: "huge.log is over 900 KB." });
    assert.equal((await readDropped(new File(["x".repeat(FILE_MAX)], "max.log", { type: "text/plain" }))).kind, "text", "900 KB itself fits");
});

test("the size limit is the JSON body as bytes: escapes, multi-byte text and images all count", () => {
    assert.equal(BODY_BUDGET, 990_000);
    assert.equal(tooLarge("hello", []), null);
    assert.equal(tooLarge("x".repeat(BODY_BUDGET - 30), []), null, `{"text":"…","images":[]} adds 24 bytes`);
    assert.notEqual(tooLarge("x".repeat(BODY_BUDGET), []), null);
    // 600 000 line breaks are 1 200 000 bytes once JSON escapes them, and the body's own 23 bytes come on top
    const breaks = "\n".repeat(600_000);
    assert.equal(tooLarge(breaks, []), "This message is 1.2 MB and one message carries at most 990 KB. Remove at least 211 KB, then send again.");
    // a Cyrillic letter is two bytes, so 500 000 of them do not fit though they are half the characters
    assert.match(tooLarge("ж".repeat(500_000), []) ?? "", /Remove at least 11 KB/);
    const image = `data:image/jpeg;base64,${"A".repeat(187_000)}`;
    assert.equal(tooLarge("x".repeat(240_000), [image, image, image, image]), null);
    assert.equal(tooLarge("x".repeat(250_000), [image, image, image, image]), "This message is 998 KB and one message carries at most 990 KB. Remove at least 9 KB, then send again.");
});

test("sizes read as a card says them", () => {
    assert.equal(size(812), "812 B");
    assert.equal(size(4_150), "4.2 KB");
    assert.equal(size(10_000), "10 KB");
    assert.equal(size(640_400), "640 KB");
    assert.equal(size(999_499), "999 KB");
    assert.equal(size(999_500), "1 MB");
    assert.equal(size(1_214_000), "1.21 MB");
    assert.equal(textSize("ж".repeat(1000)), "2 KB", "a size is bytes, not characters");
});

const composer = await readFile(new URL("../src/views/composer.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const card = await readFile(new URL("../src/components/paste-card.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/chat.css", import.meta.url), "utf8");

test("the box turns a long paste into a card, sends with cards alone, and keeps cards in the draft", () => {
    assert.match(composer, /const text = e\.clipboardData\.getData\("text\/plain"\);\s*if \(!isLongPaste\(text\)\) return;\s*e\.preventDefault\(\);/);
    assert.match(composer, /e\.preventDefault\(\);\s*setPastes\(\(cur\) => \[\.\.\.cur, newPaste\(cur, text\)\]\);/);
    assert.match(composer, /const empty = !draft\.trim\(\) && images\.length === 0 && pastes\.length === 0;/);
    assert.match(composer, /disabled=\{!draft\.trim\(\) && pastes\.length === 0\}/, "Queue takes a message of cards alone");
    assert.match(composer, /const saved = buildPasted\(pastes, draft\);\s*DRAFTS\.set\(draftKey, saved\);/);
    assert.match(composer, /const kept = parsePasted\(held\);/);
});

test("a draft too big for session storage leaves no older one behind to come back on a reload", () => {
    assert.match(composer, /try \{\s*\/\/[^\n]*\n\s*sessionStorage\.removeItem\(`\$\{DRAFT_KEY\}:\$\{draftKey\}`\);\s*if \(saved\) sessionStorage\.setItem\(`\$\{DRAFT_KEY\}:\$\{draftKey\}`, saved\);\s*\} catch \{/);
});

test("the box and an edit share one row of cards: Insert at the caret, and removing the last card hands focus to the text box", () => {
    assert.match(composer, /<BoxCards pastes=\{pastes\} box=\{box\} onOpen=\{onOpenPaste\} setPastes=\{setPastes\} setText=\{setDraft\} \/>/);
    assert.match(chat, /<BoxCards pastes=\{pastes\} box=\{box\} onOpen=\{onOpenPaste\} setPastes=\{setPastes\} setText=\{setValue\} \/>/);
    assert.match(chat, /<textarea\s*ref=\{box\}\s*autoFocus\s*aria-label="Edit message"/);
    const row = card.slice(card.indexOf("export function BoxCards("), card.indexOf("export function PasteViewer("));
    // index keys keep every slot but the last, so only the last card's removal would leave focus on the page's top
    assert.match(row, /key=\{i\}/);
    assert.match(row, /onRemove=\{\(\) => \{\s*if \(i === pastes\.length - 1 && matchMedia\("\(pointer: fine\)"\)\.matches\) box\.current\?\.focus\(\);\s*setPastes\(/);
    assert.match(row, /setText\(el\.value\.slice\(0, el\.selectionStart\) \+ p\.text \+ el\.value\.slice\(el\.selectionEnd\)\);/);
});

test("a long paste into an edit becomes a card as it does in the box", () => {
    const edit = chat.slice(chat.indexOf("function EditBox("), chat.indexOf("const HEAD: Record<GateState, string>"));
    assert.match(edit, /const pasted = e\.clipboardData\.getData\("text\/plain"\);\s*if \(!isLongPaste\(pasted\)\) return;\s*e\.preventDefault\(\);\s*setPastes\(\(cur\) => \[\.\.\.cur, newPaste\(cur, pasted\)\]\);/);
});

test("the size check runs before anything leaves the box, and a refusal keeps the box as it was", () => {
    const submit = composer.slice(composer.indexOf("const submit = (): void => {"), composer.indexOf("const addFiles"));
    const check = submit.indexOf("const over = tooLarge(text, busy ? [] : images);");
    assert.ok(check !== -1 && check < submit.indexOf("onSubmit(text, images)"));
    assert.match(submit, /if \(over\) \{\s*onNotice\(over\);\s*return;\s*\}/);
    assert.match(chat, /const over = tooLarge\(text, \[\]\);\s*if \(over\) \{\s*setNotice\(over\);\s*return;\s*\}\s*const ok = await dialog\.confirm/, "an edit is checked before anything is deleted");
});

test("only messages from a box are read for pasted blocks; the copy is plain; an edit and a queued message keep their cards", () => {
    assert.match(chat, /const \{ pastes, text: typed \} = useMemo\(\(\) => \(md \? \{ pastes: \[\], text \} : parsePasted\(text\)\), \[md, text\]\);/);
    assert.match(chat, /<CopyTextButton text=\{\[\.\.\.pastes\.map\(\(p\) => p\.text\), typed\]\.filter\(Boolean\)\.join\("\\n\\n"\)\} label="Copy message" \/>/);
    assert.match(chat, /const \[start\] = useState\(\(\) => parsePasted\(text\)\);/);
    assert.match(chat, /onSave\(buildPasted\(pastes, value\.trim\(\)\)\)/);
    assert.match(chat, /j === i \? buildPasted\(parsePasted\(q\)\.pastes, e\.target\.value\) : q/);
});

test("a card ends its preview lines with CSS and the viewer holds a Back entry; no shadow anywhere on them", () => {
    assert.match(card, /for \(const \[line\] of paste\.text\.matchAll\(\/\^\.\*\\S\.\*\$\/gm\)\) \{\s*if \(lines\.push\(line\) === preview\) break;/, "whole lines, never a slice of one");
    assert.match(css, /\.paste-line\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:pre;/);
    assert.match(card, /const hold = holdBack\(\(\) => latest\.current\(\)\);/);
    assert.match(card, /className="mback dlgback paste-viewer"/);
    for (const rule of css.match(/[^}]*paste[^{]*\{[^}]*\}/g) ?? []) assert.doesNotMatch(rule, /shadow|gradient/, rule);
});

test("in the viewer's head a long title shrinks and the line count and size keep their width", () => {
    assert.match(css, /\.paste-sheet-head h2\{flex:0 1 auto;min-width:0;[^}]*text-overflow:ellipsis;/);
    assert.match(css, /\.paste-sheet-meta\{flex:none;margin-right:auto;white-space:nowrap;/);
});
