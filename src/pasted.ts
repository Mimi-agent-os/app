// Pasted text in the box: when a paste becomes a card, what a dropped file becomes, and whether a message fits the gateway.
// The <pasted_text> blocks a message carries are protocol's buildPasted() and parsePasted().
import { lineCount, type Paste } from "@mimi-os/protocol";

/** A paste over either limit becomes a card instead of landing in the box. */
export const PASTE_CHARS = 2000;
export const PASTE_LINES = 30;
/** The largest dropped file that becomes a card. */
export const FILE_MAX = 900_000;
/** The gateway refuses a request body over 1 000 000 bytes; the rest is headroom. */
export const BODY_BUDGET = 990_000;

const UTF8 = new TextEncoder();

export const isLongPaste = (text: string): boolean => text.length > PASTE_CHARS || lineCount(text) > PASTE_LINES;

/** A long paste as the next card of a box, numbered after the highest "Pasted text n" already there. */
export function newPaste(cards: readonly Paste[], text: string): Paste {
    const n = 1 + Math.max(0, ...cards.map((p) => Number(/^Pasted text (\d+)$/.exec(p.title)?.[1] ?? 0)));
    return { title: `Pasted text ${n}`, lines: lineCount(text), text };
}

/** Bytes as a card or a notice says them: 812 B, 4.2 KB, 640 KB, 1.21 MB. */
export function size(bytes: number): string {
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 999_500) return `${Number((bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0))} KB`;
    return `${Number((bytes / 1_000_000).toFixed(2))} MB`;
}

export const textSize = (text: string): string => size(UTF8.encode(text).length);

/** Null when the request body fits the gateway, else the notice that says how much has to go. */
export function tooLarge(text: string, images: readonly string[]): string | null {
    const bytes = UTF8.encode(JSON.stringify({ text, images })).length;
    if (bytes <= BODY_BUDGET) return null;
    return `This message is ${size(bytes)} and one message carries at most ${size(BODY_BUDGET)}. Remove at least ${Math.ceil((bytes - BODY_BUDGET) / 1000)} KB, then send again.`;
}

const TEXT_EXT = new Set([
    "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "org", "tex", "bib", "log", "csv", "tsv", "json", "jsonl", "ndjson", "json5",
    "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "xml", "html", "htm", "css", "scss", "sass", "less",
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro", "py", "pyi", "rb", "rs", "go", "java", "kt", "kts",
    "scala", "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "m", "php", "pl", "lua", "r", "dart", "ex", "exs", "erl",
    "hs", "clj", "zig", "nim", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql", "proto", "diff", "patch",
    "srt", "vtt", "gradle", "dockerfile", "makefile", "gitignore", "editorconfig", "lock",
]);
const TEXT_TYPE = /^text\/|^application\/(json|xml|javascript|ecmascript|x-javascript|x-sh|x-shellscript|sql|yaml|x-yaml|toml|graphql|x-ndjson|x-httpd-php|x-tex)$|^application\/[\w.-]+\+(json|xml)$/;

export type Dropped = { kind: "image" } | { kind: "text"; paste: Paste } | { kind: "refused"; reason: string };

/** What a dropped file becomes: an image for the image path, a card titled with its name, or the sentence saying why neither. */
export async function readDropped(file: File): Promise<Dropped> {
    if (file.type.startsWith("image/")) return { kind: "image" };
    const dot = file.name.lastIndexOf(".");
    const ext = (dot < 0 ? file.name : file.name.slice(dot + 1)).toLowerCase();
    // an untyped file (a README, a .env) is read anyway, and the NUL check decides
    const textual = TEXT_EXT.has(ext) || TEXT_TYPE.test(file.type) || file.type === "" || file.type === "application/octet-stream";
    if (!textual) return { kind: "refused", reason: `${file.name} is neither text nor an image.` };
    if (file.size > FILE_MAX) return { kind: "refused", reason: `${file.name} is over ${size(FILE_MAX)}.` };
    const text = await file.text();
    if (text.includes("\0")) return { kind: "refused", reason: `${file.name} is not text.` };
    return { kind: "text", paste: { title: file.name, lines: lineCount(text), text } };
}
