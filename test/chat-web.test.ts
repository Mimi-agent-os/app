// The chat's Chat / Web switch and its notices, read out of chat.tsx and chat.css: JSX no plain Node runner imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/views/chat.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/chat.css", import.meta.url), "utf8");

test("the switch shows for an agent with an interface, never in the Android app", () => {
    assert.match(source, /const interfaces = useInterfaces\(agent, me\.connected\);/);
    assert.match(source, /const onWeb = !androidApp && view\.web && /);
    assert.match(source, /web=\{androidApp \|\| \(webApp === undefined && !onWeb\) \? null : onWeb\}/);
    assert.match(source, /\{web !== null && \(\s*<div className="seg chat-view" role="group"/);
});

test("switching is local state remembered per agent, never a route, so it adds no history entry", () => {
    const onView = /const onView = useCallback\(\(web: boolean, app: string \| undefined\): void => \{([\s\S]*?)\}, \[agent\]\);/.exec(source);
    assert.ok(onView, "one callback switches");
    assert.doesNotMatch(onView[1] as string, /go\(|history\./);
    assert.match(onView[1] as string, /VIEWS\.set\(agent, \{ web, app \}\);/);
    assert.match(source, /useState\(\(\) => VIEWS\.get\(agent\) \?\? \{ web: false, app: undefined \}\)/);
});

test("the interface is the agent page's own tab, lazily loaded, handed one app so its picker never leaves the chat", () => {
    assert.match(source, /const InterfacesTab = lazy\(\(\) => import\("\.\/interfaces\.tsx"\)\);/);
    assert.match(source, /<InterfacesTab agent=\{agent\} initialApp=\{webApp\?\.appId\} data=\{\{ \.\.\.interfaces, apps: webApp \? \[webApp\] : \[\] \}\} \/>/);
    assert.match(source, /<select className="chat-web-pick" aria-label="Interface"/);
});

test("both views stay mounted: the thread and the dock are hidden and inert under Web, the frame hidden under Chat", () => {
    assert.match(source, /<div className="thread" ref=\{thread\} onScroll=\{onScroll\} inert=\{onWeb\}>/);
    assert.match(source, /<div className="chat-dock" inert=\{onWeb\}>/);
    assert.match(source, /\{webSeen && \(\s*<div className="chat-web" hidden=\{!onWeb\}>/);
    assert.match(css, /\.chat-screen\[data-view=web\]>:is\(\.thread,\.chat-dock\)\{visibility:hidden\}/, "visibility, not display: the thread keeps its scroll");
    assert.match(css, /\.chat-web\{grid-area:2\/1\/4\/2;/);
    assert.match(css, /\.chat-screen>\.thread\{grid-area:2\/1\}/, "placed, or auto-placement would push the thread past the pane");
    assert.match(css, /\.chat-screen>\.chat-dock\{grid-area:3\/1\}/);
    assert.match(source, /!thread\.current\?\.getClientRects\(\)\.length \|\| thread\.current\.inert\) return;/, "a gate's keys sleep while the thread is hidden");
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
