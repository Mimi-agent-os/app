// Full: the agent's interface fills the window and the chat is a panel over it, read out of chat.tsx, the stylesheets and the shell.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const source = await read("src/views/chat.tsx");
const css = await read("src/chat.css");
const layout = await read("src/layout.css");
const app = await read("src/App.tsx");

test("Full is a third choice from 1100px; narrower, a remembered Full shows as Web", () => {
    assert.match(source, /const roomyQuery = matchMedia\("\(min-width: 1100px\)"\);/);
    assert.match(source, /const full = onWeb && view\.mode === "full" && roomy;/);
    assert.match(source, /onClick=\{\(\) => onView\("full", app\)\}>Full<\/button>/);
    assert.match(css, /@media \(max-width:1099px\)\{\.chat-view \.chat-view-full\{display:none\}\}/);
});

test("the frame is mounted once and only hidden: no view and no panel state takes it down", () => {
    const web = source.slice(source.indexOf("{webSeen && ("), source.indexOf("</LoadBoundary>", source.indexOf("{webSeen && (")));
    assert.match(web, /^\{webSeen && \(\s*<div className="chat-web" hidden=\{!onWeb\}>/);
    assert.doesNotMatch(web, /full|panelOpen/);
    assert.equal(source.split("<InterfacesTab ").length - 1, 1, "one frame, never a second copy for Full");
});

test("the panel is the chat's own thread and dock, never a copy: one pane in every view", () => {
    assert.equal(source.split('className="thread" ref={thread}').length - 1, 1);
    assert.equal(source.split("<Composer\n").length - 1, 1);
    assert.match(css, /\.chat-screen\[data-panel\]>\.chat-pane\{z-index:2;justify-self:end;width:min\(var\(--pane-w\),calc\(100% - var\(--s4\)\)\);margin:var\(--s2\);border:1px solid var\(--line-2\)/);
    assert.doesNotMatch(css.slice(css.indexOf("/* Full:"), css.indexOf("/* header */")), /box-shadow|backdrop-filter|gradient/, "a hairline, never a shadow or glass");
    // Web keeps the shape the thread was last seen in, so a trip through Web never reflows it out of its place
    assert.match(source, /if \(!onWeb && panelShape\) setPanelShape\(false\);\s*if \(full && !panelShape\) setPanelShape\(true\);/);
});

test("the panel hangs from the right edge: its left edge dragged left, or ArrowLeft, makes it wider", () => {
    assert.match(source, /drag\.width = Math\.min\(PANEL_MAX, Math\.max\(PANEL_MIN, Math\.round\(drag\.start \+ drag\.from - e\.clientX\)\)\);/);
    assert.match(source, /setWidth\(panelWidth \+ \(e\.key === "ArrowLeft" \? step : -step\)\);/);
    assert.match(source, /const PANEL_MIN = 320;\s*const PANEL_MAX = 640;/);
    assert.match(source, /return Math\.min\(PANEL_MAX, Math\.max\(PANEL_MIN, stored \|\| 420\)\);/);
    assert.match(source, /role="separator"\s*aria-orientation="vertical"/);
    // closed, it slides toward the edge it hangs from
    assert.match(css, /\.chat-screen\[data-view=full\]:not\(\[data-open\]\)>\.chat-pane\{visibility:hidden;opacity:0;translate:var\(--s3\) 0\}/);
});

test("the button and Escape close the panel, focus goes in on open and back on close, and Escape never denies a call here", () => {
    const toggle = source.slice(source.indexOf("const togglePanel = useCallback"), source.indexOf("}, [panelOpen, count, agent, toBottom]);"));
    assert.match(toggle, /if \(!opening\) \{\s*launcher\.current\?\.focus\(\);/);
    assert.match(toggle, /composer\.current\?\.focus\(\);/);
    assert.match(source, /document\.addEventListener\("keydown", onKey\);/, "on document: before the gate's binding on window");
    assert.match(source, /if \(panelOpen\) togglePanel\(\);\s*else onSide\(\);/);
    assert.match(source, /className="btn icon chat-pane-close" aria-label="Close the chat" title="Close \(Escape\)" onClick=\{togglePanel\}/);
});

test("closed, the button counts what waits in this chat and dots a reply not yet seen", () => {
    assert.match(source, /const count = Math\.max\(gates, open\);/);
    assert.match(source, /if \(!responding && full && !panelOpen\) setUnseen\(true\);/);
    assert.match(source, /\{count > 0 \? <span className="count warn">\{count\}<\/span> : unseen && <span className="dot" data-tone="accent" \/>\}/);
    assert.match(source, /<img src=\{avatar \?\? mascot\} alt="" draggable=\{false\}/, "the agent's avatar, or mimi");
    assert.match(app, /gates=\{gatesHere\}/);
});

test("the shell owns the sidebar: Full hides it whole, and there every sidebar control, the palette and ⌘B show or hide it whole", () => {
    assert.doesNotMatch(source, /full-sidebar|setBare|=== "b" && \(e\.metaKey/, "no second sidebar state and no second ⌘B in the chat");
    assert.match(app, /const BARE_KEY = "mimi-os:full-sidebar";/);
    assert.match(app, /const toggleSide = inFull \? toggleBare : toggleFold;/);
    assert.match(app, /if \(key === "b" && wideQuery\.matches\) \{\s*e\.preventDefault\(\);\s*toggleSide\(\);/);
    assert.match(app, /const hidden = inFull \? bare : folded;\s*out\.push\(\{\s*id: "do:sidebar",\s*label: hidden \? "Show the sidebar" : "Hide the sidebar",[\s\S]*?run: toggleSide,/);
    assert.match(app, /onFold=\{inFull && !folded \? toggleBare : toggleFold\}/, "in Full the sidebar's own hide hides it whole; the rail's show still unfolds it");
    assert.match(app, /bare=\{bare\} onSide=\{toggleBare\} onFull=\{setInFull\}/);
    assert.match(app, /data-bare=\{inFull && bare \? "" : undefined\}/);
    // before paint, so the sidebar never flashes in on the way into Full
    assert.match(source, /useLayoutEffect\(\(\) => \{\s*onFull\(full\);\s*return \(\) => onFull\(false\);\s*\}, \[full, onFull\]\);/);
    assert.match(source, /\{bare && \(\s*<button type="button" className="btn icon chat-side" aria-label="Show the sidebar"/, "the header control shows only while the sidebar is hidden");
    assert.match(source, /bare=\{full && bare\}/);
    assert.match(layout, /\.app\[data-bare\]\{grid-template-columns:0 minmax\(0,1fr\)\}/);
    assert.match(layout, /\.app\[data-bare\]>:is\(\.side,\.bar\)\{display:none\}/);
    assert.match(layout, /\.app\[data-bare\]>\.work\{margin:0;border:0;border-radius:0\}/);
});

test("keys pressed inside the interface: its bridge forwards Escape, which only closes the panel, and ⌘B, which the shell takes", () => {
    assert.match(source, /if \(\(e as CustomEvent<string>\)\.detail === "Escape" && panelOpen\) togglePanel\(\);/);
    assert.match(source, /window\.addEventListener\("mimi:frame-key", onFrameKey\);/);
    assert.match(app, /if \(\(e as CustomEvent<string>\)\.detail === "b" && wideQuery\.matches\) toggleSide\(\);/);
});

test("narrower than 1100px, picking another interface keeps a remembered Full", () => {
    assert.match(source, /mode=\{view\.mode\}/);
    assert.match(source, /<select className="chat-web-pick" aria-label="Interface" value=\{app\} onChange=\{\(e\) => onView\(mode, e\.target\.value\)\}>/);
});
