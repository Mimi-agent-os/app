/** Model text renders as React elements; unfinished fences remain code while streaming. */
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import "../markdown.css";

// stack guard, not a style limit — e.g. `">".repeat(50_000)` costs one recursive call per level; past this depth the text still renders, just flat
const MAX_DEPTH = 6;


// `text` fields hold raw source — inline parsing happens at render time, once
type Block =
    | { t: "p"; text: string }
    | { t: "h"; level: 1 | 2 | 3; text: string }
    | { t: "code"; lang: string; code: string }
    | { t: "hr" }
    | { t: "quote"; blocks: Block[] }
    | { t: "list"; ordered: boolean; start: number; items: Block[][] }
    | { t: "table"; head: string[]; align: ("left" | "center" | "right")[]; rows: string[][] };

interface Fence {
    /** Closer must be the same character and at least as long — lets a ```` fence contain a ``` line. */
    run: string;
    lang: string;
}

// whitelisted, not escaped — this lands in both a class name and an attribute, and comes from model text
function label(info: string): string {
    const word = info.split(/\s+/)[0] ?? "";
    const clean = word.replace(/[^A-Za-z0-9+#._-]/g, "");
    return clean.slice(0, 24).toLowerCase();
}

function fence(line: string): Fence | null {
    const s = line.trimStart();
    const c = s.charAt(0);
    if (c !== "`" && c !== "~") return null;
    let n = 0;
    while (s.charAt(n) === c) n++;
    if (n < 3) return null;
    const rest = s.slice(n).trim();
    // a backtick fence's info string may not itself contain a backtick — that is the only thing
    // telling ```` ```js ```` apart from a line that merely starts with inline code
    if (c === "`" && rest.includes("`")) return null;
    return { run: c.repeat(n), lang: label(rest) };
}

/** Closes a fence: same character, at least as long, and nothing else on the line. */
function closes(line: string, f: Fence): boolean {
    const s = line.trim();
    if (s.length < f.run.length) return false;
    const c = f.run.charAt(0);
    for (const ch of s) if (ch !== c) return false;
    return true;
}

// hand-written, not regex: the obvious pattern backtracks quadratically on a long near-match, which is exactly what untrusted text supplies
function isRule(line: string): boolean {
    const s = line.trim();
    if (s.length < 3) return false;
    const c = s.charAt(0);
    if (c !== "-" && c !== "*" && c !== "_") return false;
    let n = 0;
    for (const ch of s) {
        if (ch === c) n++;
        else if (ch !== " " && ch !== "\t") return false;
    }
    return n >= 3;
}

// a space after the hashes is required (so "#deploy" mid-sentence stays prose); levels beyond 3 collapse onto h3, since the stylesheet only styles three
function heading(line: string): { level: 1 | 2 | 3; text: string } | null {
    const s = line.trimStart();
    let n = 0;
    while (s.charAt(n) === "#") n++;
    if (n === 0 || n > 6) return null;
    const rest = s.slice(n);
    if (rest !== "" && !rest.startsWith(" ")) return null;
    const level = (n > 3 ? 3 : n) as 1 | 2 | 3;
    // the trimmed text cannot end in whitespace, so `\s#+$` has nothing to backtrack over
    const text = rest.trim().replace(/\s#+$/, "");
    return { level, text: text.trim() };
}

interface Marker {
    indent: number;
    ordered: boolean;
    /** Where an ordered list starts counting — `3.` must render as 3 or the model's own cross-references point at the wrong line. */
    num: number;
    body: string;
    /** Column the item's content starts at — how much to dedent continuation lines by. */
    width: number;
}

function marker(line: string): Marker | null {
    let i = 0;
    while (line.charAt(i) === " ") i++;
    // past this, a line is a code-ish continuation of whatever came before, not a new item
    if (i > 8) return null;
    const c = line.charAt(i);
    let after = i;
    let ordered = false;
    let num = 1;
    if (c === "-" || c === "*" || c === "+") {
        after = i + 1;
    } else if (c >= "0" && c <= "9") {
        let d = i;
        while (line.charAt(d) >= "0" && line.charAt(d) <= "9" && d - i < 9) d++;
        const dot = line.charAt(d);
        if (dot !== "." && dot !== ")") return null;
        ordered = true;
        num = Number(line.slice(i, d));
        after = d + 1;
    } else return null;
    if (line.charAt(after) !== " ") return null; // "1.x" and "-x" are prose
    let body = after;
    while (line.charAt(body) === " ") body++;
    return { indent: i, ordered, num, body: line.slice(body), width: body };
}

const isQuote = (line: string): boolean => line.trimStart().startsWith(">");

function unquote(line: string): string {
    const s = line.trimStart().slice(1);
    return s.startsWith(" ") ? s.slice(1) : s;
}

function starts(line: string): boolean {
    return (
        isRule(line) ||
        heading(line) !== null ||
        fence(line) !== null ||
        isQuote(line) ||
        marker(line) !== null
    );
}

function cells(line: string): string[] | null {
    const src = line.trim();
    if (!src.includes("|")) return null;
    const out: string[] = [];
    let cell = "";
    let ticks = 0;
    let trailingDivider = false;
    for (let i = 0; i < src.length; i++) {
        const c = src.charAt(i);
        trailingDivider = false;
        if (c === "\\" && src.charAt(i + 1) === "|") { cell += "|"; i++; continue; }
        if (c === "`") {
            let end = i + 1;
            while (src.charAt(end) === "`") end++;
            const count = end - i;
            if (ticks === 0) ticks = count;
            else if (ticks === count) ticks = 0;
            cell += src.slice(i, end);
            i = end - 1;
            continue;
        }
        if (c === "|" && !ticks) { out.push(cell.trim()); cell = ""; trailingDivider = true; continue; }
        cell += c;
    }
    out.push(cell.trim());
    if (src.startsWith("|")) out.shift();
    if (trailingDivider) out.pop();
    return out.length ? out : null;
}

function divider(line: string, width: number): ("left" | "center" | "right")[] | null {
    const cs = cells(line);
    if (!cs || cs.length !== width) return null;
    const out: ("left" | "center" | "right")[] = [];
    for (const c of cs) {
        if (!/^:?-{3,}:?$/.test(c)) return null;
        out.push(c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left");
    }
    return out;
}

const dedent = (line: string, width: number): string => {
    let i = 0;
    while (i < width && line.charAt(i) === " ") i++;
    return line.slice(i);
};

function collectList(
    lines: readonly string[],
    from: number,
    first: Marker,
    depth: number,
): { block: Block; next: number } {
    const items: string[][] = [];
    let cur: string[] = [first.body];
    let width = first.width;
    let i = from + 1;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        if (line.trim() === "") {
            // a blank ends the list unless what follows still belongs to it (a loose list, or an
            // item with two paragraphs). Only one line of lookahead: two blanks mean "over".
            const next = lines[i + 1] ?? "";
            const nm = marker(next);
            const inside = next.trim() !== "" && next.startsWith(" ".repeat(width));
            if ((!nm || nm.ordered !== first.ordered) && !inside) break;
            cur.push("");
            i++;
            continue;
        }
        const m = marker(line);
        if (m && m.indent <= first.indent + 1) {
            // a bullet list touching a numbered one is TWO lists — merging them would renumber
            // or unnumber somebody's steps
            if (m.ordered !== first.ordered) break;
            items.push(cur);
            cur = [m.body];
            width = m.width;
            i++;
            continue;
        }
        // an unindented heading/rule/fence/quote ends the list; anything indented, and any plain
        // wrapped line, continues the current item
        if (line.charAt(0) !== " " && starts(line)) break;
        cur.push(dedent(line, width));
        i++;
    }
    items.push(cur);
    return {
        block: {
            t: "list" as const,
            ordered: first.ordered,
            start: first.num,
            items: items.map((it) => parseBlocks(it.join("\n"), depth + 1)),
        },
        next: i,
    };
}

// line-oriented, single-pass; anything it can't classify falls through to a paragraph
function parseBlocks(src: string, depth: number): Block[] {
    if (depth > MAX_DEPTH) return src.trim() === "" ? [] : [{ t: "p", text: src }];
    const lines = src.split("\n");
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        if (line.trim() === "") {
            i++;
            continue;
        }

        const f = fence(line);
        if (f) {
            let close = -1;
            for (let j = i + 1; j < lines.length; j++) {
                if (closes(lines[j] ?? "", f)) {
                    close = j;
                    break;
                }
            }
            if (close !== -1) {
                out.push({ t: "code", lang: f.lang, code: lines.slice(i + 1, close).join("\n") });
                i = close + 1;
                continue;
            }
            // A stream commonly arrives before its closing fence. Keep it visibly code while it is incomplete.
            out.push({ t: "code", lang: f.lang, code: lines.slice(i + 1).join("\n") });
            break;
        }

        const head = cells(line);
        const aligns = head ? divider(lines[i + 1] ?? "", head.length) : null;
        if (head && aligns) {
            const rows: string[][] = [];
            i += 2;
            while (i < lines.length) {
                const row = cells(lines[i] ?? "");
                if (!row || row.length !== head.length) break;
                rows.push(row);
                i++;
            }
            out.push({ t: "table", head, align: aligns, rows });
            continue;
        }

        if (isRule(line)) {
            out.push({ t: "hr" });
            i++;
            continue;
        }

        const h = heading(line);
        if (h) {
            out.push({ t: "h", level: h.level, text: h.text });
            i++;
            continue;
        }

        if (isQuote(line)) {
            const held: string[] = [];
            while (i < lines.length && isQuote(lines[i] ?? "")) {
                held.push(unquote(lines[i] ?? ""));
                i++;
            }
            // strict: only `>`-prefixed lines are in the quote — a wrapped line without one becomes its own paragraph
            out.push({ t: "quote", blocks: parseBlocks(held.join("\n"), depth + 1) });
            continue;
        }

        const m = marker(line);
        if (m) {
            const { block, next } = collectList(lines, i, m, depth);
            out.push(block);
            i = next;
            continue;
        }

        // newlines are kept and become <br> at inline render — markdown's "soft break is a space" rule reads as a bug here
        const held = [line];
        i++;
        while (i < lines.length) {
            const l = lines[i] ?? "";
            if (l.trim() === "" || starts(l)) break;
            const tableHead = cells(l);
            if (tableHead && divider(lines[i + 1] ?? "", tableHead.length)) break;
            held.push(l);
            i++;
        }
        out.push({ t: "p", text: held.join("\n") });
    }
    return out;
}


// anything after a backslash that isn't in this set keeps the backslash — a Windows path must survive being written down
const ESCAPABLE = "\\`*_[]()#+-.!>~";

// whitelist, not a blacklist of javascript:/data:/etc — anything but http(s) renders as literal source text and stays unclickable
function isHttp(url: string): boolean {
    const s = url.trim().toLowerCase();
    return s.startsWith("http://") || s.startsWith("https://");
}

const isSpace = (c: string): boolean => c === "" || c === " " || c === "\t" || c === "\n";

// left-to-right scan; `seek` memoises "absent from here" so a line of ten thousand lone asterisks doesn't rescan to the end ten thousand times
function inline(src: string, depth: number): ReactNode[] {
    if (depth > MAX_DEPTH) return [src];
    const out: ReactNode[] = [];
    let buf = "";
    const flush = (): void => {
        if (buf !== "") {
            out.push(buf);
            buf = "";
        }
    };

    // token → smallest offset from which it's known absent; must be an offset, not a bare boolean, or a scan past a later valid closer would wrongly mark it absent everywhere before that point too
    const absent: Record<string, number> = {};
    const seek = (tok: string, from: number): number => {
        const known = absent[tok];
        if (known !== undefined && from >= known) return -1;
        const at = src.indexOf(tok, from);
        if (at === -1) absent[tok] = known === undefined ? from : Math.min(known, from);
        return at;
    };

    // emphasis may not open before a space or close after one — that's what keeps "2 * 3 * 4" arithmetic
    const closer = (ch: string, need: number, from: number): number => {
        let j = seek(ch, from);
        while (j !== -1) {
            let cn = 0;
            while (src.charAt(j + cn) === ch) cn++;
            if (cn >= need && !isSpace(src.charAt(j - 1))) return j;
            j = seek(ch, j + cn);
        }
        return -1;
    };

    let i = 0;
    while (i < src.length) {
        const c = src.charAt(i);

        if (c === "\\") {
            const next = src.charAt(i + 1);
            // a trailing backslash is the operator mid-keystroke — print it, don't eat a character that hasn't arrived yet
            if (next !== "" && ESCAPABLE.includes(next)) {
                buf += next;
                i += 2;
            } else {
                buf += c;
                i++;
            }
            continue;
        }

        if (c === "\n") {
            flush();
            // an array index is a safe key here: this tree is a pure function of `src` with no state to preserve across a reorder
            out.push(<br key={out.length} />);
            i++;
            continue;
        }

        if (c === "`") {
            let n = 0;
            while (src.charAt(i + n) === "`") n++;
            const tok = "`".repeat(n);
            const j = seek(tok, i + n);
            if (j === -1) {
                buf += tok;
                i += n;
                continue;
            }
            flush();
            // a text node, never parsed further — the one place a reader can quote a `**` without it disappearing
            out.push(<code key={out.length}>{src.slice(i + n, j)}</code>);
            i = j + n;
            continue;
        }

        if (c === "*") {
            let n = 0;
            while (src.charAt(i + n) === "*") n++;
            // one asterisk italic, two bold, three both; a fourth and beyond is capped rather than invented into something
            const use = n >= 3 ? 3 : n;
            const j = isSpace(src.charAt(i + n)) ? -1 : closer("*", use, i + n);
            if (j === -1) {
                // unterminated (or arithmetic): literal, and the scan moves past exactly it so the rest still parses normally
                buf += "*".repeat(n);
                i += n;
                continue;
            }
            flush();
            const body = inline(src.slice(i + n, j), depth + 1);
            out.push(
                use === 1 ? (
                    <em key={out.length}>{body}</em>
                ) : use === 2 ? (
                    <strong key={out.length}>{body}</strong>
                ) : (
                    <em key={out.length}>
                        <strong>{body}</strong>
                    </em>
                ),
            );
            // a closer longer than the opener leaves its extras behind, read as a fresh run next turn
            i = j + use;
            continue;
        }

        if (c === "~" && src.charAt(i + 1) === "~") {
            const j = seek("~~", i + 2);
            if (j === -1 || isSpace(src.charAt(i + 2)) || isSpace(src.charAt(j - 1))) { buf += "~~"; i += 2; continue; }
            flush();
            out.push(<del key={out.length}>{inline(src.slice(i + 2, j), depth + 1)}</del>);
            i = j + 2;
            continue;
        }

        if (c === "[") {
            // no `!` case above this one, deliberately: `![alt](url)` renders as a link with a literal "!", never an <img> — an image would be a beacon fetched the moment the answer scrolls past, where a link waits for a click
            const rb = seek("]", i + 1);
            const rp = rb === -1 || src.charAt(rb + 1) !== "(" ? -1 : seek(")", rb + 2);
            if (rp === -1) {
                // half a link, or none — only the bracket is literal, so the label still parses as the prose it may be
                buf += c;
                i++;
                continue;
            }
            const url = src.slice(rb + 2, rp).trim();
            if (!isHttp(url)) {
                // unusable scheme stays source text, brackets and all — nothing about it is clickable
                buf += src.slice(i, rp + 1);
                i = rp + 1;
                continue;
            }
            flush();
            out.push(
                <a key={out.length} href={url} target="_blank" rel="noreferrer noopener">
                    {inline(src.slice(i + 1, rb), depth + 1)}
                </a>,
            );
            i = rp + 1;
            continue;
        }

        buf += c;
        i++;
    }
    flush();
    return out;
}


export function CopyTextButton({ text, label }: { text: string; label: string }): ReactElement {
    const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);

    return (
        <button
            type="button"
            className="btn quiet sm"
            aria-label={label}
            title={status === "failed" ? "Clipboard unavailable. Select the text to copy it." : label}
            onClick={() => {
                void (async () => {
                    try {
                        await navigator.clipboard.writeText(text);
                        setStatus("copied");
                    } catch {
                        setStatus("failed");
                    }
                    clearTimeout(timer.current);
                    timer.current = setTimeout(() => setStatus("idle"), 2400);
                })();
            }}
        >
            <span aria-live="polite">
                {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
            </span>
        </button>
    );
}

function renderBlocks(blocks: readonly Block[], depth: number): ReactNode[] {
    return blocks.map((b, n) => {
        switch (b.t) {
            case "p":
                return <p key={n}>{inline(b.text, depth)}</p>;
            case "h": {
                const kids = inline(b.text, depth);
                if (b.level === 1) return <h1 key={n}>{kids}</h1>;
                if (b.level === 2) return <h2 key={n}>{kids}</h2>;
                return <h3 key={n}>{kids}</h3>;
            }
            case "code":
                return (
                    <div key={n} className="md-code">
                        <div className="md-code-head">
                            <span>{b.lang || "code"}</span>
                            <CopyTextButton text={b.code} label="Copy code" />
                        </div>
                        <pre>
                            <code className={b.lang ? `language-${b.lang}` : undefined}>
                                {b.code}
                            </code>
                        </pre>
                    </div>
                );
            case "hr":
                return <hr key={n} />;
            case "quote":
                return <blockquote key={n}>{renderBlocks(b.blocks, depth + 1)}</blockquote>;
            case "list": {
                const items = b.items.map((item, j) => {
                    // a one-paragraph item renders as bare inline content — wrapping it in a <p> would give every tight bullet a paragraph's vertical margins
                    const only = item.length === 1 ? item[0] : undefined;
                    const raw = only?.t === "p" ? only.text : "";
                    const task = /^\[([ xX])\]\s+/.exec(raw);
                    const content = task ? raw.slice(task[0].length) : raw;
                    return (
                        <li key={j} className={task ? "md-task-item" : undefined}>
                            {task && <input className="md-task" type="checkbox" checked={(task[1] ?? "").toLowerCase() === "x"} disabled aria-label={(task[1] ?? "").toLowerCase() === "x" ? "completed" : "not completed"} />}
                            {only !== undefined && only.t === "p"
                                ? inline(content, depth)
                                : renderBlocks(item, depth + 1)}
                        </li>
                    );
                });
                return b.ordered ? (
                    <ol key={n} start={b.start !== 1 ? b.start : undefined}>
                        {items}
                    </ol>
                ) : (
                    <ul key={n}>{items}</ul>
                );
            }
            case "table":
                return <div key={n} className="md-table-wrap"><table><thead><tr>{b.head.map((c, i) => <th key={i} style={{ textAlign: b.align[i] ?? "left" }}>{inline(c, depth)}</th>)}</tr></thead><tbody>{b.rows.map((row, r) => <tr key={r}>{row.map((c, i) => <td key={i} style={{ textAlign: b.align[i] ?? "left" }}>{inline(c, depth)}</td>)}</tr>)}</tbody></table></div>;
        }
    });
}

// reparsing the whole text is O(n) per token, so over a long streamed answer that's O(n²);
// useDeferredValue lets React drop intermediate tokens under load instead of parsing each one
export const Markdown = memo(function Markdown({ text }: { text: string }): ReactElement {
    const shown = useDeferredValue(text);
    const blocks = useMemo(() => renderBlocks(parseBlocks(shown, 0), 0), [shown]);
    return <div className="md">{blocks}</div>;
});
