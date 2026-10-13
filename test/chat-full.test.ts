// Full: the agent's interface is the whole window, with only the chat's button and panel and Exit over it, read out of chat.tsx, the stylesheets and the shell.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const source = await read("src/views/chat.tsx");
const css = await read("src/chat.css");
const layout = await read("src/layout.css");
const app = await read("src/App.tsx");
const tab = await read("src/views/interfaces.tsx");
const fullCss = css.slice(css.indexOf("/* Full:"), css.indexOf("/* header */"));

test("Full is a third choice from 1100px; narrower, a remembered Full shows as Web", () => {
    assert.match(source, /const roomyQuery = matchMedia\("\(min-width: 1100px\)"\);/);
    assert.match(source, /const full = onWeb && view\.mode === "full" && roomy;/);
    assert.match(source, /className="chat-view-full" aria-pressed=\{false\}/);
    assert.match(css, /@media \(max-width:1099px\)\{\.chat-view \.chat-view-full\{display:none\}\}/);
});

test("Full draws no header: the chat's own header is not rendered there, and nothing of the shell is", () => {
    assert.match(source, /\{!full && \(\s*<ChatHead\s/);
    assert.equal(source.split("<ChatHead").length - 1, 1, "one header, and Full has none");
    assert.match(source, /view=\{androidApp \|\| \(webApp === undefined && !onWeb\) \? null : onWeb \? "web" : "chat"\}/);
    assert.match(app, /data-full=\{inFull \? "" : undefined\}/);
    assert.match(layout, /\.app\[data-full\]\{grid-template-columns:0 minmax\(0,1fr\)\}/);
    assert.match(layout, /\.app\[data-full\]>:is\(\.side,\.bar\)\{display:none\}/);
    assert.match(layout, /\.app\[data-full\]>\.work\{margin:0;border:0;border-radius:0\}/);
    // before paint, so the sidebar never flashes in on the way into Full
    assert.match(source, /useLayoutEffect\(\(\) => \{\s*onFull\(full\);\s*return \(\) => onFull\(false\);\s*\}, \[full, onFull\]\);/);
});

test("Full draws no strip: the tab's toolbar, the page switcher, the agent-page line and Reload are Web's, and the page goes edge to edge", () => {
    assert.match(fullCss, /\.chat-screen\[data-view=full\] :is\(\.interfaces-toolbar,\.interfaces-pages,\.interfaces-note,\.interfaces-page-actions\)\{display:none\}/);
    // a class, never an inline style, or no stylesheet could hide it
    assert.match(tab, /<p className="dim3 interfaces-note"><Icon name="app" sm \/>Agent page\./);
    assert.match(fullCss, /\.chat-screen\[data-view=full\] \.interfaces-tab\{gap:0;padding:0\}/);
    assert.match(fullCss, /\.chat-screen\[data-view=full\] :is\(\.interfaces-frame,\.interfaces-skel\)\{min-height:0;border:0;border-radius:0\}/);
    // what mimi says about the page (loading, offline, an error) stays, clear of Exit
    assert.match(fullCss, /\.interfaces-page>:is\(\[role=status\],\.err\)\)\{align-self:flex-start;max-width:calc\(100% - 128px\);/);
});

test("the frame is mounted once and only hidden: no view and no panel state takes it down", () => {
    const web = source.slice(source.indexOf("{webSeen && ("), source.indexOf("</LoadBoundary>", source.indexOf("{webSeen && (")));
    assert.match(web, /^\{webSeen && \(\s*<div className="chat-web" hidden=\{!onWeb\}>/);
    assert.doesNotMatch(web, /full|panelOpen/);
    assert.equal(source.split("<InterfacesTab ").length - 1, 1, "one frame, never a second copy for Full");
});

test("Exit is mimi's own control over the frame, never in it, quiet like the chat's button, and the panel hangs below it", () => {
    const corner = source.slice(source.indexOf('<div className="chat-corner">'), source.indexOf("{webSeen && ("));
    assert.match(source, /\{full && \(\s*\/\/ [^\n]*\n\s*<div className="chat-corner">/);
    assert.match(corner, /className="chat-exit"/);
    assert.match(corner, /aria-keyshortcuts="Escape"/);
    assert.match(corner, /onClick=\{exitFull\}/);
    assert.match(corner, />\s*Exit<kbd>Esc<\/kbd>\s*</);
    assert.ok(source.indexOf('<div className="chat-corner">') < source.indexOf('<div className="chat-web"'), "drawn by the pult, outside the frame's box");
    assert.match(fullCss, /\.chat-exit\{[^}]*border:1px solid var\(--line-2\);border-radius:var\(--pill\);background:var\(--panel-2\);/);
    assert.match(fullCss, /\.chat-corner\{grid-area:2\/1;z-index:3;align-self:start;justify-self:end;[^}]*margin:var\(--s3\);/);
    // the panel's top margin is the corner's margin, Exit's height and a gap: it starts under Exit; Exit, the panel and the button share one right edge
    assert.match(fullCss, /\.chat-screen\[data-panel\]>\.chat-pane\{[^}]*margin:calc\(var\(--s3\) \+ var\(--ctl-h\) \+ var\(--s2\)\) var\(--s3\) var\(--s3\);/);
    assert.match(fullCss, /\.chat-launch\{[^}]*width:48px;height:48px;margin:var\(--s3\);/);
    assert.match(fullCss, /\.chat-exit\{[^}]*height:var\(--ctl-h\);/);
    assert.doesNotMatch(fullCss, /box-shadow|backdrop-filter|gradient/, "hairlines, never a shadow or glass");
});

test("Exit goes back to the view Full was entered from, Web or Chat, and focus follows", () => {
    const onView = /const onView = useCallback\(\(mode: ChatMode, app: string \| undefined\): void => \{([\s\S]*?)\}, \[agent, view\]\);/.exec(source);
    assert.ok(onView);
    assert.match(onView[1] as string, /const next = \{ mode, app, from: mode === "full" && view\.mode !== "full" \? view\.mode : view\.from \};/);
    assert.match(source, /const VIEWS = new Map<string, \{ mode: ChatMode; app: string \| undefined; from: "chat" \| "web" \}>\(\);/);
    const exit = source.slice(source.indexOf("const exitFull = useCallback"), source.indexOf("}, [onView, view]);"));
    assert.match(exit, /flushSync\(\(\) => onView\(view\.from, view\.app\)\);/);
    assert.match(exit, /if \(!at \|\| at === document\.body \|\| !at\.checkVisibility\(\)\) screen\?\.querySelector<HTMLButtonElement>\("\.chat-view \[aria-pressed=true\]"\)\?\.focus\(\);/);
    // the Full button leaves with the header: focus goes to Exit
    assert.match(source, /flushSync\(\(\) => onView\("full", app\)\);\s*screen\?\.querySelector<HTMLButtonElement>\("\.chat-exit"\)\?\.focus\(\);/);
});

test("Escape closes an open panel first, then leaves Full; one held down takes one step; an Escape forwarded from the interface does the same", () => {
    const keys = source.slice(source.indexOf("// one step per Escape"), source.indexOf("}, [full, panelOpen, togglePanel, exitFull]);"));
    assert.match(keys, /const step = \(\): void => \{\s*if \(panelOpen\) togglePanel\(\);\s*else exitFull\(\);\s*\};/);
    assert.match(keys, /e\.preventDefault\(\);\s*\/\/ [^\n]*\n\s*if \(!e\.repeat\) step\(\);/);
    assert.match(keys, /if \(\(e as CustomEvent<string>\)\.detail === "Escape"\) step\(\);/);
    assert.match(keys, /document\.addEventListener\("keydown", onKey\);/, "on document: before the gate's binding on window, so Escape never denies here");
    assert.match(keys, /window\.addEventListener\("mimi:frame-key", onFrameKey\);/);
    assert.doesNotMatch(keys, /onSide|bare/);
    assert.match(source, /if \(!full\) return undefined;\s*\/\/ one step per Escape/, "outside Full, Escape is the gate's and the fields' own");
});

test("the agent-page note shows once on entering Full, drawn by mimi, then fades and goes", () => {
    assert.match(source, /const \[note, setNote\] = useState\(full\);\s*const \[wasFull, setWasFull\] = useState\(full\);\s*if \(full !== wasFull\) \{\s*setWasFull\(full\);\s*setNote\(full\);\s*\}/);
    assert.match(source, /if \(!note\) return undefined;\s*const t = setTimeout\(\(\) => setNote\(false\), NOTE_MS\);/);
    assert.match(source, /const NOTE_MS = 4000;/);
    assert.match(source, /\{note && <p className="chat-note" role="note"><Icon name="app" sm \/>Agent page\. mimi never asks for keys or pairing links here\.<\/p>\}/);
    assert.equal(source.split("mimi never asks for keys").length - 1, 1, "one note, in the corner");
    // fades out just before NOTE_MS takes it away: 3.7 s + 220 ms < 4 s
    assert.match(css, /\.chat-note\{animation:fade-in var\(--dur-2\) var\(--ease-out\) both,fade-out var\(--dur-3\) var\(--ease-in\) 3\.7s forwards\}/);
    assert.match(fullCss, /\.chat-note\{[^}]*background:var\(--panel-2\);color:var\(--ink-3\);font:var\(--f-xs\)/);
    assert.match(fullCss, /\.chat-corner\{[^}]*pointer-events:none\}/, "the note never takes a click meant for the page");
});

test("the panel is the chat's own thread and dock, never a copy: one pane in every view", () => {
    assert.equal(source.split('className="thread" ref={thread}').length - 1, 1);
    assert.equal(source.split("<Composer\n").length - 1, 1);
    assert.match(css, /\.chat-screen\[data-panel\]>\.chat-pane\{z-index:2;justify-self:end;width:min\(var\(--pane-w\),calc\(100% - var\(--s4\)\)\);/);
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

test("the button and the panel's close move focus in on open and back on close", () => {
    const toggle = source.slice(source.indexOf("const togglePanel = useCallback"), source.indexOf("}, [panelOpen, count, agent, toBottom]);"));
    assert.match(toggle, /if \(!opening\) \{\s*launcher\.current\?\.focus\(\);/);
    assert.match(toggle, /composer\.current\?\.focus\(\);/);
    assert.match(source, /className="btn icon chat-pane-close" aria-label="Close the chat" title="Close \(Escape\)" onClick=\{togglePanel\}/);
});

test("closed, the button counts what waits in this chat and dots a reply not yet seen", () => {
    assert.match(source, /const count = Math\.max\(gates, open\);/);
    assert.match(source, /if \(!responding && full && !panelOpen\) setUnseen\(true\);/);
    assert.match(source, /\{count > 0 \? <span className="count warn">\{count\}<\/span> : unseen && <span className="dot" data-tone="accent" \/>\}/);
    assert.match(source, /<img src=\{avatar \?\? mascot\} alt="" draggable=\{false\}/, "the agent's avatar, or mimi");
    assert.match(app, /gates=\{gatesHere\}/);
});

test("⌘B means nothing in Full: no sidebar to show, no second sidebar state, no palette command", () => {
    assert.doesNotMatch(app, /full-sidebar|BARE_KEY|toggleBare|toggleSide|setBare/);
    assert.doesNotMatch(source, /\bonSide\b|\bbare\b|chat-side|=== "b" && \(e\.metaKey/);
    assert.match(app, /if \(key === "b" && wideQuery\.matches && !inFull\) \{\s*e\.preventDefault\(\);\s*toggleFold\(\);/);
    assert.match(app, /if \(\(e as CustomEvent<string>\)\.detail === "b" && wideQuery\.matches && !inFull\) toggleFold\(\);/);
    assert.match(app, /if \(wide && !inFull\) \{\s*out\.push\(\{\s*id: "do:sidebar",/);
    assert.match(app, /slash=\{slash\} onFull=\{setInFull\} \/>/);
    assert.match(app, /onFold=\{toggleFold\}/);
});

test("narrower than 1100px, picking another interface keeps a remembered Full", () => {
    assert.match(source, /mode=\{view\.mode\}/);
    assert.match(source, /<select className="chat-web-pick" aria-label="Interface" value=\{app\} onChange=\{\(e\) => onView\(mode, e\.target\.value\)\}>/);
});
