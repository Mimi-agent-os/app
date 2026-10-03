// The agent mark read as source: one component draws it everywhere, the roster feeds it, and both CSPs let its blob: picture render.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const count = (source: string, needle: string): number => source.split(needle).length - 1;

test("every place that shows an agent's mark draws AgentMark, and none draws the letter by hand", async () => {
    const places: [string, number][] = [
        // the sidebar row and the folded rail
        ["src/components/home-list.tsx", 2],
        // the empty chat's welcome and the chat header
        ["src/views/chat.tsx", 2],
        ["src/views/agent-page.tsx", 1],
        ["src/views/inbox.tsx", 1],
        ["src/components/approval-requests.tsx", 1],
    ];
    for (const [path, marks] of places) {
        const source = await read(path);
        assert.equal(count(source, "<AgentMark agent="), marks, path);
        // only the loading skeleton keeps a bare, empty mark
        assert.equal(count(source, "\"agent-mark"), path.endsWith("home-list.tsx") ? 1 : 0, path);
    }
    const header = /className="head-agent" onClick=\{\(\) => go\(\{ at: "agent", agent \}\)\}>\s*<AgentMark agent=\{agent\} \/><span className="head-agent-name">\{agent\}<\/span>/;
    assert.ok(header.test(await read("src/views/chat.tsx")), "the chat header's agent link leads with the mark");
});

test("the mark shows the avatar, and the letter while it loads, on error or with none", async () => {
    const ui = await read("src/components/ui.tsx");
    const mark = ui.slice(ui.indexOf("export function AgentMark"), ui.indexOf("\n}\n", ui.indexOf("export function AgentMark")));
    assert.match(mark, /const src = useAvatar\(agent\);/);
    assert.match(mark, /src && src !== broken \? <img src=\{src\} alt="" draggable=\{false\} onError=\{\(\) => setBroken\(src\)\} \/> : agent\.slice\(0, 1\)\.toUpperCase\(\)/);
    assert.match(mark, /aria-hidden="true"/);
});

test("every roster answer feeds the avatars, and agent_changed refetches the roster", async () => {
    const app = await read("src/App.tsx");
    const reload = app.slice(app.indexOf("const reloadRegistries"), app.indexOf("const reloadApprovals"));
    assert.match(reload, /if \(request !== registryRequest\.current\) return;\s*setAvatars\(rows\);/);
    assert.match(app, /window\.addEventListener\("mimi:agent-changed", everything\);/);
    assert.match(app, /const everything = \(\): void => \{[^}]*reloadRegistries\(\)/);
    assert.match(await read("src/events.ts"), /agent_changed: "mimi:agent-changed"/);
});

test("the picture is a square crop at the mark's own sizes", async () => {
    const css = await read("src/styles.css");
    assert.match(css, /\.agent-mark\{[^}]*overflow:hidden/);
    assert.match(css, /\.agent-mark img\{display:block;width:100%;height:100%;object-fit:cover\}/);
});

test("both CSPs let a blob: picture render", async () => {
    const pult = /img-src ([^;]+)/.exec(await read("index.html"))?.[1]?.split(" ");
    const shell = /img-src ([^;]+)/.exec((JSON.parse(await read("tauri/src-tauri/tauri.conf.json")) as { app: { security: { csp: string } } }).app.security.csp)?.[1]?.split(" ");
    assert.ok(pult?.includes("blob:"));
    assert.ok(shell?.includes("blob:"));
});
