// The per-app cookie jar behind mimiapp:// (RFC 6265bis §5): one host-only jar per (gateway, app), fed by the scheme path, the relay and document.cookie.

export interface CookieScope {
    gateway: string;
    appId: string;
    /** The request path the cookie line arrived on, query allowed. */
    path: string;
}

/** What a frame's document.cookie mirror holds; e is the expiry in ms, null for a session cookie. */
export interface ScriptCookie {
    n: string;
    v: string;
    p: string;
    e: number | null;
}

export interface ParsedCookie extends ScriptCookie {
    h: boolean;
    s: boolean;
    ss: "strict" | "lax" | "none";
}

interface StoredCookie extends ParsedCookie {
    /** Creation and last access, ms. */
    c: number;
    a: number;
}

const COOKIES_MAX = 50;
const APP_BYTES_MAX = 32 * 1024;
const STORAGE_PREFIX = "mimi-os:cookies:";
const utf8 = new TextEncoder();

// creation order, per `${gateway}:${appId}`
const jars = new Map<string, StoredCookie[]>();

/** RFC 6265bis §5.6 for one Set-Cookie line (or a document.cookie assignment); null means ignore it. Self-contained: bridge.js carries its source. */
export function parseCookieLine(line: string, requestPath: string, now: number): ParsedCookie | null {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return null;
    const trim = /^[ \t]+|[ \t]+$/g;
    const semi = line.indexOf(";");
    const pair = semi === -1 ? line : line.slice(0, semi);
    const eq = pair.indexOf("=");
    const n = eq === -1 ? "" : pair.slice(0, eq).replace(trim, "");
    const v = (eq === -1 ? pair : pair.slice(eq + 1)).replace(trim, "");
    if (n === "" && v === "") return null;
    let bytes = 0;
    for (const ch of n + v) {
        const cp = ch.codePointAt(0) ?? 0;
        bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    if (bytes > 4096) return null;
    if (n === "" && /^__(secure|host)-/i.test(v)) return null;

    const DAY_MS = 86_400_000;
    const cap = now + 400 * DAY_MS;
    let expires: number | null = null;
    let maxAge: number | null = null;
    let path: string | null = null;
    let secure = false;
    let httpOnly = false;
    let domain = false;
    let sameSite: ParsedCookie["ss"] = "lax";
    for (const attribute of semi === -1 ? [] : line.slice(semi + 1).split(";")) {
        const at = attribute.indexOf("=");
        const name = (at === -1 ? attribute : attribute.slice(0, at)).replace(trim, "").toLowerCase();
        const value = at === -1 ? "" : attribute.slice(at + 1).replace(trim, "");
        if (value.length > 1024) continue;
        if (name === "expires") {
            // §5.1.1: tokens between delimiters, each field taken from the first token that fits it
            let time: number[] | null = null;
            let day: number | null = null;
            let month: number | null = null;
            let year: number | null = null;
            for (const token of value.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/)) {
                const hms = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?!\d)/.exec(token);
                const named = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.exec(token);
                if (time === null && hms) time = [Number(hms[1]), Number(hms[2]), Number(hms[3])];
                else if (day === null && /^\d{1,2}(?!\d)/.test(token)) day = parseInt(token, 10);
                else if (month === null && named) month = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf((named[1] as string).toLowerCase()) / 3;
                else if (year === null && /^\d{2,4}(?!\d)/.test(token)) year = parseInt(token, 10);
            }
            if (year !== null && year >= 70 && year <= 99) year += 1900;
            else if (year !== null && year <= 69) year += 2000;
            if (time === null || day === null || month === null || year === null) continue;
            const [hour = 0, minute = 0, second = 0] = time;
            if (day < 1 || day > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59) continue;
            const date = new Date(Date.UTC(year, month, day, hour, minute, second));
            if (date.getUTCDate() !== day) continue;
            expires = Math.min(date.getTime(), cap);
        } else if (name === "max-age") {
            if (!/^-?\d+$/.test(value)) continue;
            const seconds = Number(value);
            maxAge = seconds <= 0 ? 0 : Math.min(now + seconds * 1000, cap);
        } else if (name === "path") {
            path = value.startsWith("/") ? value : null;
        } else if (name === "domain") {
            domain ||= value !== "";
        } else if (name === "secure") {
            secure = true;
        } else if (name === "httponly") {
            httpOnly = true;
        } else if (name === "samesite") {
            const mode = value.toLowerCase();
            sameSite = mode === "strict" || mode === "none" ? mode : "lax";
        }
    }
    if (/^__secure-/i.test(n) && !secure) return null;
    if (/^__host-/i.test(n) && (!secure || domain || path !== "/")) return null;
    let p = path;
    if (p === null) {
        const uri = requestPath.split("?")[0] ?? "";
        const last = uri.lastIndexOf("/");
        p = !uri.startsWith("/") || last <= 0 ? "/" : uri.slice(0, last);
    }
    return { n, v, p, e: maxAge ?? expires, h: httpOnly, s: secure, ss: sameSite };
}

/** The unexpired cookies that path-match a request (§5.4), longer paths first, then in creation order. Self-contained: bridge.js carries its source. */
export function matchCookies<T extends ScriptCookie>(cookies: readonly T[], requestPath: string, now: number): T[] {
    const path = requestPath.split("?")[0] || "/";
    return cookies
        .filter((c) => (c.e === null || c.e > now) && (path === c.p || (path.startsWith(c.p) && (c.p.endsWith("/") || path[c.p.length] === "/"))))
        .sort((a, b) => b.p.length - a.p.length);
}

function jarOf(gateway: string, appId: string): StoredCookie[] {
    const key = `${gateway}:${appId}`;
    const held = jars.get(key);
    if (held) return held;
    const jar: StoredCookie[] = [];
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + key) ?? "[]");
        for (const c of Array.isArray(saved) ? saved as Partial<StoredCookie>[] : []) {
            if (typeof c.n !== "string" || typeof c.v !== "string" || typeof c.p !== "string" || typeof c.e !== "number" || typeof c.c !== "number") continue;
            const ss = c.ss === "strict" || c.ss === "none" ? c.ss : "lax";
            jar.push({ n: c.n, v: c.v, p: c.p, e: c.e, h: c.h === true, s: c.s === true, ss, c: c.c, a: c.c });
        }
    } catch {
        // an unreadable jar starts empty; the next change rewrites it
    }
    jar.sort((a, b) => a.c - b.c);
    jars.set(key, jar);
    prune(gateway, appId, jar);
    return jar;
}

function persist(gateway: string, appId: string, jar: readonly StoredCookie[]): void {
    const kept = jar.filter((c) => c.e !== null).map(({ n, v, p, e, h, s, ss, c }) => ({ n, v, p, e, h, s, ss, c }));
    try {
        if (kept.length === 0) localStorage.removeItem(`${STORAGE_PREFIX}${gateway}:${appId}`);
        else localStorage.setItem(`${STORAGE_PREFIX}${gateway}:${appId}`, JSON.stringify(kept));
    } catch {
        // storage full or blocked: the jar still holds them for this pult session
    }
}

function prune(gateway: string, appId: string, jar: StoredCookie[]): void {
    const now = Date.now();
    const live = jar.filter((c) => c.e === null || c.e > now);
    if (live.length === jar.length) return;
    jar.splice(0, jar.length, ...live);
    persist(gateway, appId, jar);
}

/** Stores Set-Cookie lines (from "http") or document.cookie assignments (from "script"); true when what document.cookie can see changed. */
export function storeCookies(scope: CookieScope, lines: readonly string[], from: "http" | "script"): boolean {
    const jar = jarOf(scope.gateway, scope.appId);
    const now = Date.now();
    const seen = (c: StoredCookie | undefined): string | null => (c && !c.h ? `${c.v}\u0000${c.e}` : null);
    let visible = false;
    let durable = false;
    for (const line of lines) {
        const cookie = parseCookieLine(line, scope.path, now);
        if (!cookie || (from === "script" && cookie.h)) continue;
        const at = jar.findIndex((c) => c.n === cookie.n && c.p === cookie.p);
        const old = jar[at];
        if (old?.h && from === "script") continue;
        durable ||= old?.e != null || cookie.e !== null;
        if (cookie.e !== null && cookie.e <= now) {
            if (!old) continue;
            jar.splice(at, 1);
            visible ||= seen(old) !== null;
            continue;
        }
        const stored: StoredCookie = { ...cookie, c: old?.c ?? now, a: now };
        if (old) jar[at] = stored;
        else jar.push(stored);
        visible ||= seen(old) !== seen(stored);
    }
    for (;;) {
        const total = jar.reduce((sum, c) => sum + utf8.encode(c.n + c.v).length, 0);
        if (jar.length <= COOKIES_MAX && total <= APP_BYTES_MAX) break;
        const lru = jar.reduce((best, c) => (c.a < best.a ? c : best));
        jar.splice(jar.indexOf(lru), 1);
        visible ||= !lru.h;
        durable ||= lru.e !== null;
    }
    if (durable) persist(scope.gateway, scope.appId, jar);
    return visible;
}

/** The Cookie header for one request (§5.8.3): "same" sends every cookie; "launch", a navigation the pult itself started, leaves SameSite=Strict out, and Lax too unless the method is GET or HEAD; "cross" sends SameSite=None only. "" when nothing matches. */
export function cookieHeader(scope: CookieScope, site: "same" | "launch" | "cross", method = "GET"): string {
    const jar = jarOf(scope.gateway, scope.appId);
    prune(scope.gateway, scope.appId, jar);
    const now = Date.now();
    const safe = method === "GET" || method === "HEAD";
    const sent = matchCookies(jar.filter((c) => site === "same" || c.ss === "none" || (site === "launch" && c.ss === "lax" && safe)), scope.path, now);
    for (const c of sent) c.a = now;
    const header = sent.map((c) => (c.n === "" ? c.v : `${c.n}=${c.v}`)).join("; ");
    if (!/[^\x00-\xff]/.test(header)) return header;
    // a document.cookie value beyond Latin-1 goes out as its UTF-8 bytes, as a browser sends it
    let bytes = "";
    for (const b of utf8.encode(header)) bytes += String.fromCharCode(b);
    return bytes;
}

/** Every cookie document.cookie may see, in creation order: the mirror the bridge filters by path itself. */
export function scriptCookies(gateway: string, appId: string): ScriptCookie[] {
    const jar = jarOf(gateway, appId);
    prune(gateway, appId, jar);
    return jar.filter((c) => !c.h).map(({ n, v, p, e }) => ({ n, v, p, e }));
}

/** Binds an app's jar to the agent pin behind it: under another pin the jar starts empty, so an agent that takes a used name never inherits its login. */
export function pinJar(gateway: string, appId: string, pin: string): void {
    const key = `${STORAGE_PREFIX}${gateway}:${appId}:pin`;
    try {
        if (localStorage.getItem(key) === pin) return;
        localStorage.setItem(key, pin);
    } catch {
        // storage blocked: the jar cannot prove whose it is, so it starts empty
    }
    jars.delete(`${gateway}:${appId}`);
    persist(gateway, appId, []);
}

/** A forgotten device: every jar and its pin, in memory and on disk. */
export function clearCookies(): void {
    jars.clear();
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
        }
    } catch {
        // nothing persisted to begin with
    }
}
