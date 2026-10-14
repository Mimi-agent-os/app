// The Interfaces tab fits its window: one toolbar row, a page that takes the rest down to a low floor, and mimi's passing lines over the page, never above it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const source = await read("src/views/interfaces.tsx");
const css = await read("src/interfaces.css");
const frame = source.slice(source.indexOf("function AppFrame"));
const toolbar = source.slice(source.indexOf('<header className="interfaces-toolbar">'), source.indexOf("</header>"));

test("one toolbar row: the app's title, the agent-page line and every control; the agent is named by the header above", () => {
    assert.match(toolbar, /<h2 className="interfaces-title">\{app\?\.title \?\? "Interfaces"\}<\/h2>/);
    assert.doesNotMatch(source, /@\{agent\}<\/span>|interfaces-heading/);
    assert.match(toolbar, /className="interfaces-app-choice"/);
    assert.match(toolbar, />Refresh list<\/Btn>/);
    assert.match(toolbar, /\{active\?\.url && <Btn sm kind="quiet" icon="refresh" disabled=\{active\.pending\} title="Reload this page; unsaved work may be lost" onClick=\{\(\) => frame\.current\?\.reload\(\)\}>Reload interface<\/Btn>\}/);
    assert.doesNotMatch(source, /interfaces-page-actions/);
    // the line wraps under the title on a narrow window rather than being cut short
    assert.match(css, /\.interfaces-note\{[^}]*flex:1 1 240px;/);
    assert.doesNotMatch(css, /\.interfaces-note\{[^}]*(ellipsis|nowrap)/);
});

test("a narrow toolbar stays one row: Refresh and Reload fold into one ⋯ that holds both, and the note wraps beside the title", () => {
    assert.match(css, /\.interfaces-toolbar\{[^}]*container-type:inline-size\}/);
    assert.match(toolbar, /\{active\?\.url && <button type="button" className="btn icon sm interfaces-more" aria-label="Interface actions" aria-haspopup="menu" onClick=\{\(event\) => setMore\(event\.currentTarget\)\}><Icon name="more" sm \/><\/button>\}/);
    assert.match(source, /\{more && <Menu label="Interface actions" at=\{more\} onClose=\{\(\) => setMore\(null\)\}/);
    assert.match(source, /\{ id: "refresh", label: "Refresh list", icon: "refresh", disabled: loading, run: refresh \}/);
    assert.match(source, /\{ id: "reload", label: "Reload interface", icon: "refresh", disabled: !active\?\.url \|\| active\.pending, run: \(\) => frame\.current\?\.reload\(\) \}/);
    assert.match(css, /\.interfaces-tools>\.interfaces-more\{display:none\}/);
    const fold = css.slice(css.indexOf("@container (max-width:599px){"), css.indexOf("\n}\n", css.indexOf("@container")));
    assert.match(fold, /\.interfaces-note\{flex-basis:160px\}/);
    // only beside a ⋯: with no page open, Refresh list alone fits and stays labelled
    assert.match(fold, /\.interfaces-tools:has\(>\.interfaces-more\)>\.btn:not\(\.interfaces-more\)\{display:none\}/);
    assert.match(fold, /\.interfaces-tools>\.interfaces-more\{display:inline-flex\}/);
});

test("Reload stays the frame's own: a fresh grant, then the same frame's src, never a new frame", () => {
    assert.match(source, /ref=\{key === activeKey \? frame : undefined\}/);
    const reload = frame.slice(frame.indexOf("useImperativeHandle(ref"), frame.indexOf("}), [agent, state.appId, state.route]);"));
    assert.match(reload, /setReload\(\(value\) => value \+ 1\);/);
    assert.match(reload, /void grantFor\(agent, state\.appId, true\)\.then\(\(\) => frameUrl\(state\.appId, state\.route\)\)\.then\(\(url\) => \{\s*if \(frame\.current\) frame\.current\.src = url;/);
    assert.match(reload, /setIssue\(errorMessage\(reason, "Could not reload this interface\."\)\)/);
});

test("loading, launching and refreshing float over the page's foot and take no clicks, so the page is laid out once at its final size", () => {
    assert.match(source, /const passing = active\?\.pending && !awaitingFrame \? "Launching interface…" : loading && known \? "Refreshing interfaces…" : null;/);
    // in the tab's flow only while no page is in view, where nothing can be resized
    assert.match(source, /\{passing && !active\?\.url && <p className="dim3" role="status">\{passing\}<\/p>\}/);
    assert.equal(source.split("Refreshing interfaces…").length - 1, 1);
    assert.equal(source.split("Launching interface…").length - 1, 1);
    assert.match(frame, /const line = !loaded && !issue \? "Loading interface page…" : passing;/);
    assert.match(frame, /<iframe [^\n]*\/>\n\s*\{line && <p className="interfaces-status" role="status">\{line\}<\/p>\}\n\s*<\/section>/);
    assert.match(css, /\.interfaces-page\{position:relative;/);
    assert.match(css, /\.interfaces-status\{position:absolute;left:var\(--s3\);bottom:var\(--s3\);[^}]*pointer-events:none\}/);
});

test("the tab never scrolls around a frame that scrolls: the page takes the rest down to a floor that fits a 480px window", () => {
    assert.match(css, /\.interfaces-page\{[^}]*flex:1 1 0;[^}]*min-height:160px\}/);
    assert.match(css, /\.interfaces-frame\{[^}]*flex:1 1 0;[^}]*min-height:0;/);
    assert.match(css, /\.interfaces-skel\{[^}]*min-height:0;/);
    assert.doesNotMatch(css, /min-height:(240|280|320)px|flex:1 0 auto/);
});
