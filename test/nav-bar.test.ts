// The bar of places and the sidebar, read as source: the desktop bar draws the phone bar's icons, and no interface rows are left in the nav.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every bar cell is an icon over its label, beside the list as on a phone", async () => {
    const bar = await read("src/components/nav-bar.tsx");
    assert.match(bar, /<span className="bar-icon"><Icon name=\{c\.icon\} \/>\{c\.badge\}<\/span>\s*<span className="bar-label">\{c\.label\}<\/span>/);
    const css = await read("src/layout.css");
    assert.match(css, /\n\.bar-cell\{display:inline-flex;flex-direction:column;/, "the base cell stacks the icon over the label");
    assert.doesNotMatch(css, /\.bar-icon>\.i\{display:none\}/, "no width hides the icons");
    assert.doesNotMatch(css, /\.bar:not\(\.rail\) \.bar-icon\{display:contents\}/);
    assert.match(css, /\.bar\.rail \.bar-label\{display:none\}/, "the folded rail keeps the icons alone");
});

test("the sidebar lists agents and chats only: no interface rows, no apps read for them", async () => {
    const list = await read("src/components/home-list.tsx");
    assert.doesNotMatch(list, /agent-app|AgentApp|interfaces/);
    const app = await read("src/App.tsx");
    assert.doesNotMatch(app, /listApps|AgentApp|apps=/);
    assert.doesNotMatch(await read("src/layout.css"), /\.agent-app/);
});

test("a header's title and its sub-line share a centre line, which WebKit's button baseline does not give", async () => {
    const css = await read("src/layout.css");
    assert.match(css, /\n\.head-main\{flex:1;min-width:0;display:flex;align-items:center;/);
});
