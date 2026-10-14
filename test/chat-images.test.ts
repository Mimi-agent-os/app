// Images in a message, from the box through the queue to the bubbles, read out of chat.tsx, composer.tsx, image-grid.tsx and chat.css:
// JSX no plain Node runner imports. The fetch and cache under the bubbles run for real in message-images.test.ts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { IMAGE_TOKENS, MAX_IMAGE_BYTES, MAX_IMAGES, TURN_IMAGE_SHARE } from "@mimi-os/protocol";

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const composer = await readFile(new URL("../src/views/composer.tsx", import.meta.url), "utf8");
const grid = await readFile(new URL("../src/components/image-grid.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/chat.css", import.meta.url), "utf8");
const bubble = source.slice(source.indexOf("const Bubble = memo("), source.indexOf("\n});\n", source.indexOf("const Bubble = memo(")));
const submit = /const submit = \(text: string, imgs: string\[\]\): SubmitResult => \{([\s\S]*?)\n {4}\};/.exec(source)?.[1] ?? "";
const boxSubmit = composer.slice(composer.indexOf("const submit = (): void => {"), composer.indexOf("const addFiles"));

test("a message carries up to 32 images of 480 000 chars each, fewer when they would fill over half the model's window", () => {
    assert.equal(MAX_IMAGES, 32);
    assert.equal(MAX_IMAGE_BYTES, 480_000);
    assert.match(composer, /const maxImages = contextTokens \? Math\.min\(MAX_IMAGES, Math\.floor\(\(TURN_IMAGE_SHARE \* contextTokens\) \/ IMAGE_TOKENS\)\) : MAX_IMAGES;/);
    assert.equal(Math.min(MAX_IMAGES, Math.floor((TURN_IMAGE_SHARE * 128_000) / IMAGE_TOKENS)), 32, "a 128k window takes the full 32");
    assert.equal(Math.min(MAX_IMAGES, Math.floor((TURN_IMAGE_SHARE * 32_000) / IMAGE_TOKENS)), 10, "a 32k window takes 10");
    assert.match(source, /contextTokens=\{currentModel\?\.contextTokens\}/, "the box knows the window of the model that will answer");
    assert.match(composer, /const room = maxImages - images\.length;/, "paste, drop and the attach button all stage through addFiles");
    assert.match(composer, /disabled=\{images\.length >= maxImages \|\| blocked !== null\}/);
});

test("each image is decoded once, full size, and shrunk step by step under the per-image budget; the box shows a small preview made at staging", () => {
    assert.match(composer, /const IMAGE_STEPS: readonly \[edge: number, quality: number\]\[\] = \[\[1024, 0\.8\], \[1024, 0\.6\], \[768, 0\.6\], \[512, 0\.55\]\];/);
    const stage = composer.slice(composer.indexOf("async function stageFile("), composer.indexOf("async function previewOf("));
    assert.equal(stage.match(/createImageBitmap\(/g)?.length, 1, "one decode of the file");
    assert.match(stage, /if \(uri\.length <= MAX_IMAGE_BYTES\) return \{ uri, preview: await jpeg\(bitmap, bitmap\.width, bitmap\.height, \.\.\.PREVIEW\) \};/);
    assert.match(composer, /const PREVIEW: readonly \[edge: number, quality: number\] = \[256, 0\.7\];/);
    assert.match(composer, /createImageBitmap\(source, \{ resizeWidth: w, resizeHeight: h, resizeQuality: "high" \}\)/);
    assert.match(composer, /ctx\.drawImage\(sized, 0, 0, w, h\);/, "an engine that ignores the resize options still gets the right size");
    // one at a time, each shown as soon as it is ready
    assert.match(composer, /for \(const file of pics\.slice\(0, room\)\) \{\s*try \{\s*const staged = await stageFile\(file\);\s*if \(staged === null\) tooBig \+= 1;\s*else setImages\(\(cur\) => \[\.\.\.cur, staged\]\.slice\(0, maxImages\)\);/);
    assert.match(composer, /\{s\.preview && <img src=\{s\.preview\} alt="" \/>\}/, "a tile decodes the preview, never the message's JPEG");
    assert.match(composer, /const next = images\.find\(\(s\) => s\.preview === null\);\s*if \(!next \|\| previewing\.current\) return;/, "images that come back get previews one decode at a time");
});

test("the box's images sit in one row that scrolls sideways, so 32 never grow the box past the window", () => {
    assert.match(css, /\.composer-thumbs\{display:flex;gap:var\(--s2\);overflow-x:auto;/);
    assert.doesNotMatch(css, /\.composer-thumbs\{[^}]*flex-wrap:wrap/);
    assert.match(css, /\.composer-thumb\{position:relative;width:56px;height:56px;flex:none;/);
    assert.match(composer, /\{images\.length > 1 && <span className="count" title=\{`\$\{images\.length\} of \$\{maxImages\} images`\}>\{images\.length\}<\/span>\}/, "a count beside the attach button, on a phone too, says what the row scrolls out of sight");
    assert.match(composer, /if \(Math\.abs\(e\.deltaY\) <= Math\.abs\(e\.deltaX\) \|\| row\.scrollWidth <= row\.clientWidth\) return;\s*e\.preventDefault\(\);\s*row\.scrollLeft \+= e\.deltaY;/, "a vertical wheel scrolls the row sideways");
    assert.match(composer, /row\.addEventListener\("wheel", onWheel, \{ passive: false \}\);/, "a passive listener could not keep the page from scrolling too");
});

test("a bubble shows its images above its pasted cards and its text, and one of images alone renders no text line and no Copy", () => {
    const images = bubble.indexOf("{images !== undefined && <ImageGrid images={images} at={imagesAt} onImage={onImage} />}");
    const pastes = bubble.indexOf('<div className="paste-cards">');
    const text = bubble.indexOf("{typed && (md ? <Markdown text={typed} /> : <span>{typed}</span>)}");
    assert.ok(images !== -1 && pastes !== -1 && text !== -1 && images < pastes && pastes < text, "images, then pasted cards, then the words");
    assert.match(bubble, /const copy = text \? <CopyTextButton text=\{/);
    assert.match(grid, /<div ref=\{grid\} className=\{count > 4 \? "chat-images many" : "chat-images"\}>/);
    assert.match(css, /\.chat-images\{display:flex;flex-wrap:wrap;gap:var\(--s2\);white-space:normal\}/, "no gap above the images");
    assert.match(css, /\.chat-images:not\(:last-child\)\{margin-bottom:10px\}/, "the gap sits between the images and the text that follows");
    assert.match(css, /\.chat-images\.many \.chat-image\{width:64px;height:64px\}/, "32 images stay a few rows of small tiles");
    assert.match(css, /\.msg-foot:empty\{display:none\}/, "a live images-only bubble has nothing in its footer and no stray row");
});

test("the live message renders its data-URIs; a stored row carries a count and a key the grid fetches its images by", () => {
    assert.match(source, /<Bubble key=\{`l\$\{it\.id\}`\} speaker="human" who="You" text=\{it\.text\} images=\{it\.images\} sent onImage=\{onImage\} onOpenPaste=\{onOpenPaste\} \/>/);
    assert.match(source, /out\.push\(\{ kind: "msg", id: row\.id, text: row\.content, images: row\.images, actor: row\.meta\?\.actor, at: row\.at \}\);/);
    assert.match(source, /imagesAt=\{imagesKey\(agent, conversation, it\.id\)\}/);
    assert.match(grid, /const shown = stored \? loaded : images;/);
    assert.match(grid, /onOpen=\{\(from\) => onImage\?\.\(shown, i, from\)\}/, "the viewer gets the loaded data-URIs");
});

test("a stored grid fetches while near the screen and lets go when it leaves, so a long chat never holds every image", () => {
    assert.match(grid, /new IntersectionObserver\(/);
    assert.match(grid, /loadImages\(at, mine\.signal\)\.then\(\(got\) => \{\s*if \(ctl !== mine\) return;\s*setLoaded\(got\);/);
    assert.match(grid, /ctl\?\.abort\(\);\s*ctl = null;\s*setLoaded\(null\);/);
    assert.match(grid, /return \(\) => \{\s*watch\.disconnect\(\);\s*ctl\?\.abort\(\);\s*\};/);
    assert.match(grid, /loading="lazy"\s*decoding="async"/);
    assert.match(grid, /: <span key=\{i\} className="chat-image" \/>/, "placeholders keep the tiles' frames, so the thread never jumps");
});

test("the message just sent seeds the cache under its turnSeq, so its stored row shows the images with no fetch", () => {
    assert.match(source, /if \(ev\.type === "turn_started"\) \{\s*run\.turnSeq = ev\.turnSeq;\s*seedImages\(imagesKey\(agent, conversation, ev\.turnSeq\), sent\);\s*\}/);
    assert.match(source, /await follow\(turnId, runTurn\(agent, conversation, text, imgs, ctl\.signal\), ctl\.signal, imgs\);/);
    assert.match(grid, /useState<string\[\] \| null>\(\(\) => \(stored && at !== undefined \? cachedImages\(at\) \?\? null : null\)\)/);
});

test("after a newer summary the meter's estimate counts each image at IMAGE_TOKENS", () => {
    assert.equal(IMAGE_TOKENS, 1_500);
    assert.match(source, /Math\.ceil\(src\.slice\(summaryAt\)\.reduce\(\(n, r\) => n \+ r\.content\.length \/ 4 \+ \(r\.images \?\? 0\) \* IMAGE_TOKENS, 0\)\)/);
});

test("Edit is offered only on a message with words to edit", () => {
    assert.match(source, /onEdit=\{canEdit && speaker === "human" && it\.text \? onEdit : undefined\}/);
});

test("while a turn runs a message queues with its images, the box empties, and the queue's images together stay within one message's worth", () => {
    assert.match(submit, /if \(running\.current\) \{\s*if \(!text && imgs\.length === 0\) return "refused";/);
    assert.match(submit, /const held = queued\.current\.reduce\(\(n, q\) => n \+ q\.images\.length, 0\);\s*if \(imgs\.length > 0 && held \+ imgs\.length > MAX_IMAGES\) \{\s*setNotice\(`The queue holds \$\{held\} \$\{plural\(held, "image", "images"\)\} and carries \$\{MAX_IMAGES\} until it sends\. This message stays in the box\.`\);\s*return "refused";\s*\}/);
    assert.match(submit, /writeQueue\(\[\.\.\.queued\.current, \{ text, images: imgs \}\]\);\s*return "queued";/);
    assert.match(submit, /if \(!text && imgs\.length === 0\) \{\s*void drainQueue\(\);\s*return "drained";\s*\}\s*void send\(text, imgs\);/);
    assert.match(boxSubmit, /if \(result === "sent" \|\| result === "queued"\) \{\s*setDraft\(""\);\s*setPastes\(\[\]\);\s*setImages\(\[\]\);\s*\}/);
    assert.doesNotMatch(composer, /carries text only/);
    assert.match(composer, /<Btn icon="queue" disabled=\{empty\}/, "Queue takes images alone");
    assert.match(composer, /const empty = !draft\.trim\(\) && images\.length === 0 && pastes\.length === 0;/);
});

test("a queued message is sent with its images; the store keeps only words, so a reload drops images and messages of images alone", () => {
    assert.match(source, /const text = next\.text\.trim\(\);\s*if \(!text && next\.images\.length === 0\) continue;\s*if \(await deliver\(text, next\.images\)\) continue;/);
    assert.match(source, /const words = next\.flatMap\(\(q\) => \(q\.text \? \[\{ text: q\.text \}\] : \[\]\)\);/);
    assert.match(source, /localStorage\.setItem\(`\$\{QUEUE_KEY\}:\$\{key\}`, JSON\.stringify\(words\)\)/);
    assert.match(source, /return typeof text === "string" && text \? \[\{ text, images: \[\] \}\] : \[\];/);
    assert.match(source, /\{item\.images\.length > 0 && <QueuedImages images=\{item\.images\} \/>\}/, "a queued row shows its images and their count");
    assert.match(grid, /\{images\.slice\(0, 3\)\.map\(\(src, i\) => <img key=\{i\} src=\{src\} alt="" decoding="async" \/>\)\}\s*<span>\{images\.length\} \{plural\(images\.length, "image", "images"\)\}<\/span>/);
    assert.match(source, /j === i \? \{ \.\.\.q, text: buildPasted\(parsePasted\(q\.text\)\.pastes, e\.target\.value\) \} : q/, "editing a row's words keeps its images");
});

test("an unsent message comes back whole: to the box when it holds nothing, else to the front of the queue", () => {
    assert.match(source, /if \(composer\.current\?\.restore\(text, imgs\)\) return;\s*writeQueue\(\[\{ text, images: imgs \}, \.\.\.queued\.current\]\);/);
    assert.match(composer, /restore: \(text, returned\) => \{\s*\/\/[^\n]*\n\s*if \(box\.current\?\.value\.trim\(\) \|\| pastes\.length > 0 \|\| images\.length > 0\) return false;/);
    assert.match(composer, /setImages\(returned\.map\(\(uri\) => \(\{ uri, preview: null \}\)\)\);\s*return true;/);
});

test("a turn that fails before turn_started stored nothing, so its message comes back like a refused POST, images and all", () => {
    assert.match(source, /if \(ev\.type === "error"\) \{\s*run\.failed = true;\s*\/\/[^\n]*\n\s*if \(post && !run\.turnSeq\) run\.refused = ev\.message;\s*\}/);
    assert.match(source, /if \(run\.refused\) \{[^}]*setNotice\(`Could not send: \$\{run\.refused\}`\);\s*unsent\.current = true;/);
    assert.match(source, /const clean = await deliver\(text, imgs\);\s*if \(unsent\.current\) restoreUnsent\(text, imgs\);/);
});

test("a queued message refused on its way out goes back to the front of the queue, and the notice keeps the reason", () => {
    assert.match(source, /if \(unsent\.current\) \{\s*\/\/[^\n]*\n\s*writeQueue\(\[\{ text, images: next\.images \}, \.\.\.queued\.current\]\);\s*setNotice\(\(m\) => `\$\{m\} The unsent message is back in the queue\.`\.trim\(\)\);\s*return;\s*\}/);
});
