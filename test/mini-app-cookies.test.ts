// The mini-app cookie jar (RFC 6265bis): parsing, matching, the script/HttpOnly line, limits and persistence, against a fake localStorage.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        get length() { return store.size; },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    },
});

let instance = 0;
const load = (): Promise<typeof import("../src/mini-app-cookies.ts")> =>
    import(new URL(`../src/mini-app-cookies.ts?case=${++instance}`, import.meta.url).href) as Promise<typeof import("../src/mini-app-cookies.ts")>;

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const DAY = 86_400_000;
const { parseCookieLine, matchCookies } = await load();

test.beforeEach(() => {
    store.clear();
    mock.timers.enable({ apis: ["Date"], now: NOW });
});
test.afterEach(() => mock.timers.reset());

test("the name, value and default path of a plain line", () => {
    assert.deepEqual(parseCookieLine("sid=abc", "/x/y/z", NOW), { n: "sid", v: "abc", p: "/x/y", e: null, h: false, s: false, ss: "lax" });
    for (const [path, expected] of [["/x", "/"], ["", "/"], ["/x/", "/x"], ["/x/y?q=/a/b", "/x"], ["relative", "/"]] as const) {
        assert.equal(parseCookieLine("a=b", path, NOW)?.p, expected, path);
    }
    assert.equal(parseCookieLine("a=b; Path=/app", "/x/y", NOW)?.p, "/app");
    assert.equal(parseCookieLine("a=b; Path=app", "/x/y", NOW)?.p, "/x", "a Path that does not start with / is the default");
    assert.deepEqual(parseCookieLine("  a  =  b c  ; secure; HTTPONLY; SameSite=Strict", "/", NOW), { n: "a", v: "b c", p: "/", e: null, h: true, s: true, ss: "strict" });
    assert.equal(parseCookieLine("a=b; samesite=None", "/", NOW)?.ss, "none");
    assert.equal(parseCookieLine("a=b; samesite=bogus", "/", NOW)?.ss, "lax");
    assert.equal(parseCookieLine("a=b\tc", "/", NOW)?.v, "b\tc", "a horizontal tab is not a control character here");
    assert.equal(parseCookieLine("a=b; Domain=example.com", "/", NOW)?.n, "a", "Domain is ignored: every cookie is host-only per app");
});

test("nameless, empty, oversized and control-character lines", () => {
    assert.deepEqual(parseCookieLine("justvalue", "/", NOW)?.n, "");
    assert.equal(parseCookieLine("justvalue", "/", NOW)?.v, "justvalue");
    assert.equal(parseCookieLine("=", "/", NOW), null);
    assert.equal(parseCookieLine(" ; Path=/", "/", NOW), null);
    assert.equal(parseCookieLine("a=b\nc", "/", NOW), null);
    assert.equal(parseCookieLine("a=b\u0000", "/", NOW), null);
    assert.ok(parseCookieLine(`a=${"x".repeat(4096)}`, "/", NOW) === null, "name and value over 4096 bytes");
    assert.ok(parseCookieLine(`a=${"x".repeat(4095)}`, "/", NOW) !== null, "exactly 4096 bytes is allowed");
    assert.ok(parseCookieLine(`a=${"€".repeat(1366)}`, "/", NOW) === null, "the 4096 limit counts UTF-8 bytes");
    assert.ok(parseCookieLine(`a=${"€".repeat(1365)}`, "/", NOW));
});

test("Expires by the RFC 6265 date algorithm, Max-Age over it, both capped at 400 days", () => {
    const at = (line: string): number | null | undefined => parseCookieLine(line, "/", NOW)?.e;
    assert.equal(at("a=b; Expires=Wed, 21 Oct 2015 07:28:00 GMT"), Date.UTC(2015, 9, 21, 7, 28, 0));
    assert.equal(at("a=b; Expires=Wed, 21-Oct-15 07:28:00 GMT"), Date.UTC(2015, 9, 21, 7, 28, 0), "a two-digit year below 70 is 20xx");
    assert.equal(at("a=b; expires=Thu, 01-Jan-70 00:00:01 GMT"), 1000, "a two-digit year from 70 is 19xx");
    assert.equal(at("a=b; Expires=Sunday, 06-Nov-94 08:49:37 GMT"), Date.UTC(1994, 10, 6, 8, 49, 37));
    assert.equal(at("a=b; Expires=Sun Nov  6 08:49:37 1994"), Date.UTC(1994, 10, 6, 8, 49, 37), "asctime order");
    assert.equal(at("a=b; Expires=Wed, 31 Feb 2015 07:28:00 GMT"), null, "an impossible day is no date");
    assert.equal(at("a=b; Expires=Wed, 21 Oct 2015"), null, "a date without a time is no date");
    assert.equal(at("a=b; Expires=Wed, 21 Oct 1600 07:28:00 GMT"), null);
    assert.equal(at("a=b; Expires=Wed, 21 Oct 2015 24:00:00 GMT"), null);
    assert.equal(at("a=b; Max-Age=60; Expires=Wed, 21 Oct 2015 07:28:00 GMT"), NOW + 60_000);
    assert.equal(at("a=b; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=60"), NOW + 60_000);
    assert.equal(at("a=b; Max-Age=0"), 0);
    assert.equal(at("a=b; Max-Age=-5"), 0);
    assert.equal(at("a=b; Max-Age=1.5"), null, "a Max-Age that is not an integer is ignored");
    assert.equal(at("a=b; Max-Age=99999999999"), NOW + 400 * DAY);
    assert.equal(at("a=b; Expires=Fri, 31 Dec 9999 23:59:59 GMT"), NOW + 400 * DAY);
});

test("the __Secure- and __Host- prefixes", () => {
    assert.equal(parseCookieLine("__Secure-a=1", "/", NOW), null);
    assert.ok(parseCookieLine("__Secure-a=1; Secure", "/", NOW));
    assert.ok(parseCookieLine("__Host-a=1; Secure; Path=/", "/x/y", NOW));
    assert.equal(parseCookieLine("__Host-a=1; Secure", "/", NOW), null, "__Host- needs an explicit Path=/");
    assert.equal(parseCookieLine("__Host-a=1; Secure; Path=/x", "/", NOW), null);
    assert.equal(parseCookieLine("__Host-a=1; Secure; Path=/; Domain=example.com", "/", NOW), null);
    assert.equal(parseCookieLine("__HOST-a=1; Path=/", "/", NOW), null, "prefixes match case-insensitively");
    assert.equal(parseCookieLine("__Secure-a", "/", NOW), null, "a nameless cookie cannot pose as a prefixed one");
});

test("path matching and order: longer paths first, then creation order", () => {
    const cookie = (n: string, p: string, e: number | null = null) => ({ n, v: n, p, e });
    const jar = [cookie("root", "/"), cookie("a", "/a"), cookie("aslash", "/a/"), cookie("ab", "/a/b"), cookie("root2", "/"), cookie("gone", "/", NOW - 1)];
    const names = (path: string): string[] => matchCookies(jar, path, NOW).map((c) => c.n);
    assert.deepEqual(names("/a"), ["a", "root", "root2"]);
    assert.deepEqual(names("/a/"), ["aslash", "a", "root", "root2"]);
    assert.deepEqual(names("/a/b/c"), ["ab", "aslash", "a", "root", "root2"]);
    assert.deepEqual(names("/ab"), ["root", "root2"], "/a does not match /ab");
    assert.deepEqual(names("/a?x=/a/b"), ["a", "root", "root2"], "the query is not the path");
});

test("HttpOnly cookies go out in the Cookie header and never reach document.cookie", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    assert.equal(jar.storeCookies(scope, ["sid=secret; HttpOnly", "theme=dark"], "http"), true);
    assert.equal(jar.cookieHeader(scope, "same"), "sid=secret; theme=dark");
    assert.deepEqual(jar.scriptCookies("g1", "wren"), [{ n: "theme", v: "dark", p: "/", e: null }]);
    assert.equal(jar.storeCookies(scope, ["sid=rotated; HttpOnly"], "http"), false, "an HttpOnly change is invisible to scripts");
    assert.equal(jar.storeCookies(scope, ["sid=exposed"], "http"), true, "the server may turn it into a script cookie");
});

test("a script can neither set an HttpOnly cookie nor overwrite one", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    jar.storeCookies(scope, ["sid=secret; HttpOnly; Path=/"], "http");
    assert.equal(jar.storeCookies(scope, ["sid=forged; Path=/"], "script"), false);
    assert.equal(jar.storeCookies(scope, ["other=1; HttpOnly"], "script"), false);
    assert.equal(jar.cookieHeader(scope, "same"), "sid=secret");
    assert.equal(jar.storeCookies(scope, ["sid=forged; Path=/x"], "script"), true, "another path is another cookie");
});

test("a replacement keeps its creation slot; Max-Age=0 and a past Expires delete", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    jar.storeCookies(scope, ["a=1", "b=2", "c=3"], "http");
    assert.equal(jar.storeCookies(scope, ["a=10"], "http"), true);
    assert.equal(jar.cookieHeader(scope, "same"), "a=10; b=2; c=3");
    assert.equal(jar.storeCookies(scope, ["a=10"], "http"), false, "the same value again changes nothing a script can see");
    assert.equal(jar.storeCookies(scope, ["b=; Max-Age=0"], "http"), true);
    assert.equal(jar.storeCookies(scope, ["c=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"], "script"), true);
    assert.equal(jar.storeCookies(scope, ["nothing=; Max-Age=0"], "http"), false);
    assert.equal(jar.cookieHeader(scope, "same"), "a=10");
});

test("a Max-Age cookie is gone once it expires", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    jar.storeCookies(scope, ["short=1; Max-Age=2", "long=1; Max-Age=60"], "http");
    mock.timers.tick(2_000);
    assert.equal(jar.cookieHeader(scope, "same"), "long=1");
    assert.deepEqual(jar.scriptCookies("g1", "wren").map((c) => c.n), ["long"]);
});

test("the pult's own launch leaves SameSite=Strict out and Lax too unless it is a GET; anything else from another site carries SameSite=None only", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    jar.storeCookies(scope, ["strict=1; SameSite=Strict", "lax=1; SameSite=Lax", "none=1; SameSite=None; Secure", "plain=1"], "http");
    assert.equal(jar.cookieHeader(scope, "same"), "strict=1; lax=1; none=1; plain=1");
    assert.equal(jar.cookieHeader(scope, "same", "POST"), "strict=1; lax=1; none=1; plain=1");
    assert.equal(jar.cookieHeader(scope, "launch"), "lax=1; none=1; plain=1");
    assert.equal(jar.cookieHeader(scope, "launch", "HEAD"), "lax=1; none=1; plain=1");
    assert.equal(jar.cookieHeader(scope, "launch", "POST"), "none=1");
    assert.equal(jar.cookieHeader(scope, "cross"), "none=1");
});

test("50 cookies and 32 KiB per app, the least recently used evicted first", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    jar.storeCookies(scope, Array.from({ length: 50 }, (_, i) => `c${i}=${i}`), "http");
    mock.timers.tick(1);
    jar.storeCookies(scope, ["c0=again"], "http");
    mock.timers.tick(1);
    assert.equal(jar.storeCookies(scope, ["c50=50"], "http"), true);
    const names = jar.scriptCookies("g1", "wren").map((c) => c.n);
    assert.equal(names.length, 50);
    assert.ok(names.includes("c0"), "c0 was touched, so c1 went instead");
    assert.ok(!names.includes("c1"));

    const big = await load();
    big.storeCookies(scope, Array.from({ length: 10 }, (_, i) => `b${i}=${"x".repeat(4000)}`), "http");
    const kept = big.scriptCookies("g1", "wren");
    assert.ok(kept.reduce((sum, c) => sum + c.n.length + c.v.length, 0) <= 32 * 1024);
    assert.deepEqual(kept.map((c) => c.n), ["b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"]);
});

test("persistent cookies survive a reload of the pult; session cookies do not", async () => {
    const first = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    first.storeCookies(scope, ["session=1", "kept=1; Max-Age=3600; HttpOnly", "soon=1; Max-Age=10"], "http");
    const saved = JSON.parse(store.get("mimi-os:cookies:g1:wren") ?? "[]") as { n: string }[];
    assert.deepEqual(saved.map((c) => c.n), ["kept", "soon"]);
    assert.deepEqual(Object.keys(saved[0] ?? {}).sort(), ["c", "e", "h", "n", "p", "s", "ss", "v"]);
    mock.timers.tick(20_000);
    const second = await load();
    assert.equal(second.cookieHeader(scope, "same"), "kept=1");
    assert.deepEqual((JSON.parse(store.get("mimi-os:cookies:g1:wren") ?? "[]") as { n: string }[]).map((c) => c.n), ["kept"], "expired entries are pruned on load");
    second.storeCookies(scope, ["kept=; Max-Age=0"], "http");
    assert.equal(store.has("mimi-os:cookies:g1:wren"), false, "an emptied jar leaves nothing on disk");
});

test("one jar per gateway and app, and a forgotten device clears them all", async () => {
    const jar = await load();
    jar.storeCookies({ gateway: "g1", appId: "wren", path: "/" }, ["a=1; Max-Age=60"], "http");
    jar.storeCookies({ gateway: "g1", appId: "files", path: "/" }, ["b=1; Max-Age=60"], "http");
    jar.storeCookies({ gateway: "g2", appId: "wren", path: "/" }, ["c=1; Max-Age=60"], "http");
    assert.equal(jar.cookieHeader({ gateway: "g1", appId: "wren", path: "/" }, "same"), "a=1");
    assert.equal(jar.cookieHeader({ gateway: "g1", appId: "files", path: "/" }, "same"), "b=1");
    assert.equal(jar.cookieHeader({ gateway: "g2", appId: "wren", path: "/" }, "same"), "c=1");
    store.set("mimi-os:device", "{}");
    jar.clearCookies();
    assert.deepEqual([...store.keys()], ["mimi-os:device"]);
    assert.equal(jar.cookieHeader({ gateway: "g1", appId: "wren", path: "/" }, "same"), "");
});

test("a jar belongs to the agent pin it was filled under: the same pin keeps it, another one empties it on disk and in memory", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    jar.pinJar("g1", "wren", "aaaa");
    jar.storeCookies(scope, ["session=1", "kept=1; Max-Age=3600"], "http");
    jar.storeCookies({ gateway: "g1", appId: "files", path: "/" }, ["other=1; Max-Age=3600"], "http");
    jar.pinJar("g1", "wren", "aaaa");
    assert.equal(jar.cookieHeader(scope, "same"), "session=1; kept=1");
    jar.pinJar("g1", "wren", "bbbb");
    assert.equal(jar.cookieHeader(scope, "same"), "");
    assert.equal(store.has("mimi-os:cookies:g1:wren"), false);
    assert.equal(store.get("mimi-os:cookies:g1:wren:pin"), "bbbb");
    assert.equal(jar.cookieHeader({ gateway: "g1", appId: "files", path: "/" }, "same"), "other=1", "another app's jar is left alone");

    jar.storeCookies(scope, ["kept=2; Max-Age=3600"], "http");
    const reloaded = await load();
    reloaded.pinJar("g1", "wren", "bbbb");
    assert.equal(reloaded.cookieHeader(scope, "same"), "kept=2", "a reload of the pult under the same pin keeps the jar");
    jar.clearCookies();
    assert.equal(store.has("mimi-os:cookies:g1:wren:pin"), false, "a forgotten device forgets the pins too");
});

test("a document.cookie value beyond Latin-1 goes upstream as its UTF-8 bytes", async () => {
    const jar = await load();
    const scope = { gateway: "g1", appId: "wren", path: "/" };
    jar.storeCookies(scope, ["price=5€"], "script");
    assert.equal(jar.scriptCookies("g1", "wren")[0]?.v, "5€");
    assert.equal(Buffer.from(jar.cookieHeader(scope, "same"), "latin1").toString("utf8"), "price=5€");
});
