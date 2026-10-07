// A message of images alone, and images above the text, read out of chat.tsx, composer.tsx and chat.css: JSX no plain Node runner imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const composer = await readFile(new URL("../src/views/composer.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/chat.css", import.meta.url), "utf8");
const bubble = source.slice(source.indexOf("const Bubble = memo("), source.indexOf("\n});\n", source.indexOf("const Bubble = memo(")));

test("a bubble shows its images above its pasted cards and its text, and one of images alone renders no text line and no Copy", () => {
    const images = bubble.indexOf('<div className="chat-images">');
    const pastes = bubble.indexOf('<div className="paste-cards">');
    const text = bubble.indexOf("{typed && (md ? <Markdown text={typed} /> : <span>{typed}</span>)}");
    assert.ok(images !== -1 && pastes !== -1 && text !== -1 && images < pastes && pastes < text, "images, then pasted cards, then the words");
    assert.match(bubble, /const copy = text \? <CopyTextButton text=\{/);
    assert.match(css, /\.chat-images\{display:flex;flex-wrap:wrap;gap:var\(--s2\);white-space:normal\}/, "no gap above the images");
    assert.match(css, /\.chat-images:not\(:last-child\)\{margin-bottom:10px\}/, "the gap sits between the images and the text that follows");
    assert.match(css, /\.msg-foot:empty\{display:none\}/, "a live images-only bubble has nothing in its footer and no stray row");
});

test("the live message you sent and the stored one render through the same bubble with the same images", () => {
    assert.match(source, /<Bubble key=\{`l\$\{it\.id\}`\} speaker="human" who="You" text=\{it\.text\} images=\{it\.images\} sent onImage=\{onImage\} onOpenPaste=\{onOpenPaste\} \/>/);
    assert.match(source, /out\.push\(\{ kind: "msg", id: row\.id, text: row\.content, images: row\.images, actor: row\.meta\?\.actor, at: row\.at \}\);/);
});

test("Edit is offered only on a message with words to edit", () => {
    assert.match(source, /onEdit=\{canEdit && speaker === "human" && it\.text \? onEdit : undefined\}/);
});

test("images alone are sent when nothing runs; while a turn runs they stay in the box with a notice, since the queue holds text", () => {
    const submit = /const submit = \(text: string, imgs: string\[\]\): SubmitResult => \{([\s\S]*?)\n {4}\};/.exec(source);
    assert.ok(submit, "chat.tsx has one submit");
    assert.match(submit[1] as string, /if \(running\.current\) \{\s*if \(!text\) return "refused";/);
    assert.match(submit[1] as string, /if \(!text && imgs\.length === 0\) \{\s*void drainQueue\(\);\s*return "drained";\s*\}\s*void send\(text, imgs\);/);
    assert.match(composer, /const empty = !draft\.trim\(\) && images\.length === 0 && pastes\.length === 0;/);
    assert.match(composer, /if \(result === "sent"\) setImages\(\[\]\);/);
    assert.match(composer, /if \(result === "refused" && busy && !text && images\.length > 0\) onNotice\("A queued message carries text only\. The images stay in the box until this turn ends\."\);/);
});

test("an images-only message that could not be sent goes back to the box, never into the queue as an empty line", () => {
    assert.match(source, /if \(composer\.current\?\.restore\(text, imgs\) \|\| !text\) return;\s*writeQueue\(\[text, \.\.\.queued\.current\]\);/);
});
