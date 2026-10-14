// interfaces.tsx's frame and launch guards, read out of the JSX source and run against stubs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/views/interfaces.tsx", import.meta.url), "utf8");

test("no frame ever opens on the pult's own origin: the browser door's ticket is gone, and nothing launches until the desktop door is attached", () => {
    assert.doesNotMatch(source, /createAppTicket|renewAppTicket|\/mini-app\//);
    assert.match(source, /const door = doorAttached\(\);/);
    assert.match(source, /useEffect\(\(\) => \{\n\s*if \(door && app && current && activeKey/);
    assert.match(source, /\{app && !door && <p className="interfaces-notice" role="status">Interfaces open only in the desktop app on macOS\.<\/p>\}/);
});

test("the frame is inert under the pult's overlays, and the band that names it as an agent page sits outside it", () => {
    assert.match(source, /<iframe [^>]*inert=\{covered\}/);
    // on the toolbar row, the pult's own, shown whenever a page is: never inside the frame's section
    const toolbar = source.slice(source.indexOf('<header className="interfaces-toolbar">'), source.indexOf("</header>"));
    assert.match(toolbar, /\{active\?\.url && <p className="dim3 interfaces-note"><Icon name="app" sm \/>Agent page\. mimi never asks for keys or pairing links here\.<\/p>\}/);
    assert.equal(source.split("mimi never asks for keys").length - 1, 1);
    assert.doesNotMatch(source.slice(source.indexOf("function AppFrame")), /interfaces-note/);
});

// A pin that is not approved has no launch: the gateway answers 403, and the pult must not ask.
const guard = /const launch = useCallback\(\(targetApp: AgentApp, target: AppPage, fresh = false\): void => \{\n\s*if \(([\s\S]*?)\) return;/.exec(source);
assert.ok(guard, "interfaces.tsx guards every launch in one condition");
const refused = new Function("targetApp", `return ${guard[1] as string};`) as (app: { available: boolean; status: string }) => boolean;

test("only an approved and available app is launched", () => {
    assert.equal(refused({ available: true, status: "approved" }), false);
    for (const app of [
        { available: true, status: "blocked" },
        { available: false, status: "approved" }, { available: false, status: "blocked" },
    ]) {
        assert.equal(refused(app), true, `launched ${JSON.stringify(app)}`);
    }
});
