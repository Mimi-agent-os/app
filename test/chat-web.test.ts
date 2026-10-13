// The chat's Chat / Web switch and its notices, read out of chat.tsx and chat.css: JSX no plain Node runner imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/chat.css", import.meta.url), "utf8");

test("the switch shows for an agent with an interface, never in the Android app", () => {
    assert.match(source, /const interfaces = useInterfaces\(agent, me\.connected\);/);
    assert.match(source, /const onWeb = !androidApp && view\.mode !== "chat" && /);
    assert.match(source, /view=\{androidApp \|\| \(webApp === undefined && !onWeb\) \? null : onWeb \? "web" : "chat"\}/);
    assert.match(source, /\{view !== null && \(\s*<div className="seg chat-view" role="group"/);
});

test("switching is local state remembered per agent, never a route, so it adds no history entry", () => {
    const onView = /const onView = useCallback\(\(mode: ChatMode, app: string \| undefined\): void => \{([\s\S]*?)\}, \[agent, view\]\);/.exec(source);
    assert.ok(onView, "one callback switches");
    assert.doesNotMatch(onView[1] as string, /go\(|history\./);
    assert.match(onView[1] as string, /VIEWS\.set\(agent, next\);\s*setView\(next\);/);
    assert.match(source, /useState\(\(\) => VIEWS\.get\(agent\) \?\? \{ mode: "chat" as ChatMode, app: undefined, from: "web" as const \}\)/);
});

test("the interface is the agent page's own tab, lazily loaded, handed one app so its picker never leaves the chat", () => {
    assert.match(source, /const InterfacesTab = lazy\(\(\) => import\("\.\/interfaces\.tsx"\)\);/);
    assert.match(source, /<InterfacesTab agent=\{agent\} initialApp=\{webApp\?\.appId\} data=\{\{ \.\.\.interfaces, apps: webApp \? \[webApp\] : \[\] \}\} \/>/);
    assert.match(source, /<select className="chat-web-pick" aria-label="Interface"/);
});

test("both views stay mounted: the thread and the dock are hidden and inert under Web, the frame hidden under Chat", () => {
    assert.match(source, /<div className="chat-pane" id=\{paneId\} ref=\{pane\} inert=\{!chatShown\}/);
    assert.match(source, /const chatShown = !onWeb \|\| \(full && panelOpen\);/);
    assert.match(source, /<div className="thread" ref=\{thread\} onScroll=\{onScroll\}>/);
    assert.match(source, /\{webSeen && \(\s*<div className="chat-web" hidden=\{!onWeb\}>/);
    assert.match(css, /\.chat-screen\[data-view=web\]>\.chat-pane\{visibility:hidden\}/, "visibility, not display: the thread keeps its scroll");
    assert.match(css, /\.chat-web\{grid-area:2\/1;/);
    assert.match(css, /\.chat-pane\{grid-area:2\/1;/, "placed, or auto-placement would push the pane past the screen");
    assert.match(source, /!thread\.current\?\.getClientRects\(\)\.length \|\| thread\.current\.closest\("\[inert\]"\)\) return;/, "a gate's keys sleep while the thread is hidden");
});

test("the failed list read's notice clears when the store reads the agent's list again", () => {
    assert.match(source, /headFailed\.current = errorMessage\(e\);\s*setNotice\(headFailed\.current\);/);
    assert.match(source, /const listFresh = listRows !== null && !listEntry\.stale;/);
    assert.match(source, /setNotice\(\(m\) => \(m === failed \? "" : m\)\);\s*\}, \[listFresh\]\);/);
});

test("a first history read refused while the agent was away is made again once it is back", () => {
    assert.match(source, /const refused = error !== "";\s*useEffect\(\(\) => \{\s*if \(!me\.connected \|\| !refused\) return undefined;/);
    assert.match(source, /if \(!alive\(\) \|\| opened\.current !== key\) return;\s*setError\(""\);/);
});
