// A message's images: a live message brings its data-URIs, a stored row only their count, fetched while its bubble is near the screen.
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { cachedImages, loadImages } from "../message-images.ts";
import { plural } from "../shared.ts";
import { Icon } from "./icon.tsx";

// the ref covers cache hits, where the load event may fire before onLoad is attached
function ChatImage({ src, label, onOpen }: { src: string; label: string; onOpen: (from: HTMLButtonElement) => void }): ReactElement {
    const [state, setState] = useState<"wait" | "ok" | "bad">("wait");
    if (state === "bad") return <span className="chat-image bad" title="Image unavailable"><Icon name="image" /></span>;
    return (
        <button type="button" className={`chat-image ${state}`} aria-label={label} disabled={state === "wait"} onClick={(e) => onOpen(e.currentTarget)}>
            <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                ref={(el) => { if (el?.complete) setState(el.naturalWidth > 0 ? "ok" : "bad"); }}
                onLoad={() => setState("ok")}
                onError={() => setState("bad")}
            />
        </button>
    );
}

/** `at` is a stored row's key in message-images.ts; its grid holds the images only while near the screen, so a long chat never keeps them all. */
export function ImageGrid({ images, at, onImage }: {
    images: string[] | number;
    at?: string | undefined;
    onImage?: ((images: string[], start: number, from: HTMLButtonElement) => void) | undefined;
}): ReactElement | null {
    const grid = useRef<HTMLDivElement | null>(null);
    const stored = typeof images === "number";
    // a message just sent is in the cache already, so the swap to its stored row shows no empty frames
    const [loaded, setLoaded] = useState<string[] | null>(() => (stored && at !== undefined ? cachedImages(at) ?? null : null));
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const el = grid.current;
        if (!stored || at === undefined || !el) return undefined;
        let ctl: AbortController | null = null;
        const watch = new IntersectionObserver(([entry]) => {
            if (entry?.isIntersecting) {
                if (ctl) return;
                const mine = new AbortController();
                ctl = mine;
                loadImages(at, mine.signal).then((got) => {
                    if (ctl !== mine) return;
                    setLoaded(got);
                    setFailed(false);
                }, () => {
                    if (ctl === mine) setFailed(true);
                });
                return;
            }
            ctl?.abort();
            ctl = null;
            setLoaded(null);
        }, { root: el.closest(".thread"), rootMargin: "800px 0px" });
        watch.observe(el);
        return () => {
            watch.disconnect();
            ctl?.abort();
        };
    }, [stored, at]);

    const count = stored ? images : images.length;
    if (count === 0) return null;
    const shown = stored ? loaded : images;
    return (
        // many images take smaller tiles, so 32 of them stay a few rows
        <div ref={grid} className={count > 4 ? "chat-images many" : "chat-images"}>
            {shown
                ? shown.map((src, i) => (
                    <ChatImage key={i} src={src} label={count > 1 ? `Open image ${i + 1} of ${count}` : "Open image"} onOpen={(from) => onImage?.(shown, i, from)} />
                ))
                : Array.from({ length: count }, (_, i) => (failed
                    ? <span key={i} className="chat-image bad" title="Image unavailable"><Icon name="image" /></span>
                    : <span key={i} className="chat-image" />))}
        </div>
    );
}

/** A queued message's images: the first few as tiles, and how many. */
export function QueuedImages({ images }: { images: readonly string[] }): ReactElement {
    return (
        <div className="queue-images">
            {images.slice(0, 3).map((src, i) => <img key={i} src={src} alt="" decoding="async" />)}
            <span>{images.length} {plural(images.length, "image", "images")}</span>
        </div>
    );
}
