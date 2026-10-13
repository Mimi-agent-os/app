/** 16px stroke icon registry — one source, so the same glyph in the sidebar, a row and the palette can't drift; stroke is `currentColor`, so no colour prop. */

const PATHS = {
    plus: "M8 3.4v9.2M3.4 8h9.2",
    back: "M13 8H3.2M7.4 3.6 3 8l4.4 4.4",
    refresh: "M13.2 8a5.2 5.2 0 1 1-1.75-3.9|M13.4 1.9v3.2h-3.2",
    play: "M5.6 3.4 12 8l-6.4 4.6z",
    check: "m3.6 8.4 3 3 5.8-6.9",
    chevron: "m6.2 3.8 4.2 4.2-4.2 4.2",
    warn: "M8 2.6 14.4 13.4H1.6z|M8 6.4v3.1M8 11.5v.1",
    filter: "M2.6 4.2h10.8M4.6 8h6.8M6.6 11.8h2.8",
    // three EQUAL bars, deliberately not `filter`'s tapering three: at 14px «narrow this list
    // down» and «bring the sidebar back» must not be the same glyph
    menu: "M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8",
    dash: "M2.5 10.4a5.5 5.5 0 1 1 11 0|M8 10.4 10.7 7",
    settings: "M2.5 4.8h11M2.5 11.2h11",
    send: "M2.6 8 13.4 3.2 9.2 13.4 7.5 9.1z",
    power: "M8 1.8v6.1M4.7 3.5a5.5 5.5 0 1 0 6.6 0",
    // archive lives ENTIRELY in EXTRA (lid rect + body) — a copy of the body here would be
    // stroked twice on top of itself
    chat: "M2.6 7.6c0-2.76 2.42-5 5.4-5s5.4 2.24 5.4 5-2.42 5-5.4 5c-.65 0-1.28-.1-1.86-.3L3.1 13.4l1-2.3A4.85 4.85 0 0 1 2.6 7.6z",
    // rounded frame in EXTRA (rect + sun); this stroke is the mountain line that reads it as a picture
    image: "M2.6 11.3 6 8l1.9 1.8 2.5-2.7 3 3.1",
    bell: "M8 2.4a3 3 0 0 0-3 3v1.3c0 1.5-.6 2.9-1.7 3.9h9.4c-1.1-1-1.7-2.4-1.7-3.9V5.4a3 3 0 0 0-3-3z|M6.5 12.2a1.5 1.5 0 0 0 3 0",
    // thumbtack: cap bar, tapered body, needle
    pin: "M5 3.4h6|M6.2 3.4 5.6 8.4h4.8L9.8 3.4|M8 8.4v4.4",
    edit: "M3.4 12.6 4.2 9.8 9.8 4.2 11.8 6.2 6.2 11.8z|M8 6 10 8",
    pause: "M6.2 4v8M9.8 4v8",
    close: "M4.2 4.2 11.8 11.8|M11.8 4.2 4.2 11.8",
} as const;

/** Glyphs that need more than paths — circles and rects the stroke set uses. */
const EXTRA: Partial<Record<IconName, React.ReactElement>> = {
    more: <><circle cx="3.5" cy="8" r=".8" /><circle cx="8" cy="8" r=".8" /><circle cx="12.5" cy="8" r=".8" /></>,
    image: <><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.8" /><circle cx="5.5" cy="6.1" r="1.05" /></>,
    settings: (
        <>
            <circle cx="6" cy="4.8" r="1.7" />
            <circle cx="10.5" cy="11.2" r="1.7" />
        </>
    ),
    stop: <rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.2" />,
    info: (
        <>
            <circle cx="8" cy="8" r="5.6" />
            <path d="M8 7.4v3.4M8 5.1v.1" />
        </>
    ),
    search: (
        <>
            <circle cx="7.2" cy="7.2" r="4.4" />
            <path d="m10.6 10.6 2.9 2.9" />
        </>
    ),
    key: (
        <>
            <circle cx="5.4" cy="10.6" r="2.7" />
            <path d="M7.35 8.65 13.4 2.6M11.3 4.7l1.5 1.5M9.4 6.6l1.5 1.5" />
        </>
    ),
    models: (
        <>
            <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" />
            <path d="M6.4 1.7v2.5M9.6 1.7v2.5M6.4 11.8v2.5M9.6 11.8v2.5M1.7 6.4h2.5M1.7 9.6h2.5M11.8 6.4h2.5M11.8 9.6h2.5" />
        </>
    ),
    queue: (
        <path d="M2.2 9.6h3l1 2h3.6l1-2h3M2.2 9.6 4 3.6a1.2 1.2 0 0 1 1.15-.85h5.7A1.2 1.2 0 0 1 12 3.6l1.8 6v2.4a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z" />
    ),
    // a window with its title bar: an agent's interface
    app: (
        <>
            <rect x="2.4" y="3" width="11.2" height="10" rx="1.6" />
            <path d="M2.4 6.2h11.2" />
        </>
    ),
    archive: (
        <>
            <rect x="2.4" y="2.6" width="11.2" height="3" rx="1" />
            <path d="M3.4 5.6v6.4a1.4 1.4 0 0 0 1.4 1.4h6.4a1.4 1.4 0 0 0 1.4-1.4V5.6M6.4 8.5h3.2" />
        </>
    ),
};

export type IconName =
    | keyof typeof PATHS
    | "stop"
    | "info"
    | "search"
    | "key"
    | "models"
    | "queue"
    | "more"
    | "app"
    | "archive";

export function Icon({ name, sm }: { name: IconName; sm?: boolean }): React.ReactElement {
    const raw = name in PATHS ? PATHS[name as keyof typeof PATHS] : "";
    return (
        <svg className={sm ? "i sm" : "i"} viewBox="0 0 16 16" aria-hidden="true">
            {/* "|" separates subpaths that must not join into one stroke run */}
            {raw ? raw.split("|").map((d, i) => <path key={i} d={d} />) : null}
            {EXTRA[name]}
        </svg>
    );
}
