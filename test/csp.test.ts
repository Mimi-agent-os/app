// The pult's CSP as index.html and tauri.conf.json ship it.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const directives = (policy: string): Map<string, string[]> =>
    new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).filter((words) => words[0]).map(([name, ...sources]) => [name as string, sources]));

const html = await read("index.html");
const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
assert.ok(meta, "index.html carries a CSP meta");
const pult = directives(meta[1] as string);
const tauri = directives((JSON.parse(await read("tauri/src-tauri/tauri.conf.json")) as { app: { security: { csp: string } } }).app.security.csp);

test("a frame is the pult's own or a mini-app's mimiapp: origin, never another site, in the browser or the desktop shell", () => {
    assert.deepEqual(pult.get("frame-src"), ["'self'", "mimiapp:"]);
    assert.deepEqual(tauri.get("frame-src"), ["'self'", "mimiapp:"]);
    assert.deepEqual(pult.get("object-src"), ["'none'"]);
});

test("nothing may frame the pult, which holds the device key: the desktop policy and the dev server both say so", async () => {
    assert.deepEqual(tauri.get("frame-ancestors"), ["'none'"]);
    assert.match(await read("vite.config.ts"), /headers: \{ "content-security-policy": "frame-ancestors 'none'" \}/);
});

test("the policy is in force before any script or stylesheet in index.html", () => {
    const at = html.indexOf(meta[0]);
    for (const tag of ["<script", "<link rel=\"stylesheet\""]) assert.ok(!html.includes(tag) || html.indexOf(tag) > at, `${tag} comes before the CSP`);
});

test("fonts are bundled, so the desktop and Android shells render them: no font host in either policy, no remote stylesheet", async () => {
    assert.deepEqual(pult.get("font-src"), ["'self'", "data:"]);
    assert.deepEqual(tauri.get("font-src"), ["'self'", "data:"]);
    assert.deepEqual(pult.get("style-src"), ["'self'", "'unsafe-inline'"]);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/);
    const files = [...(await read("src/styles.css")).matchAll(/url\(\.\/(assets\/fonts\/[\w.-]+\.woff2)\)/g)].map((m) => m[1] as string);
    assert.ok(files.length > 0);
    for (const file of files) await access(new URL(`../src/${file}`, import.meta.url));
});

test("no script may eval, in the browser or the desktop shell", () => {
    assert.ok(!pult.get("script-src")?.includes("'unsafe-eval'"));
    assert.ok(!tauri.get("script-src")?.includes("'unsafe-eval'"));
});

test("the pult still dials any gateway it is given, and the desktop shell still reaches its IPC", () => {
    for (const scheme of ["ws:", "wss:", "http:", "https:", "ipc:"]) assert.ok(pult.get("connect-src")?.includes(scheme), `connect-src lacks ${scheme}`);
});
