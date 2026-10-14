// Stored messages' images, fetched when their bubble nears the screen: one request at a time in the order asked, kept in an LRU by data-URI length.
import { messageImages } from "./api.ts";

/** About three full messages (32 images of 480 000 chars). */
export const IMAGE_CACHE_BYTES = 48 * 1024 * 1024;

interface Entry {
    images: string[];
    bytes: number;
}

interface Ask {
    key: string;
    signal: AbortSignal;
    resolve: (images: string[]) => void;
    reject: (reason: unknown) => void;
}

// a Map iterates in insertion order: the first key is the least recently used
const cache = new Map<string, Entry>();
let held = 0;
const waiting: Ask[] = [];
let fetching = false;

/** A history row's images, keyed agent#conversation#message. */
export const imagesKey = (agent: string, conversation: number, messageId: number): string => `${agent}#${conversation}#${messageId}`;

/** The images when the cache holds them, now the most recently used. */
export function cachedImages(key: string): string[] | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    cache.delete(key);
    cache.set(key, hit);
    return hit.images;
}

/** Keeps a message's images, the least recently used going first past IMAGE_CACHE_BYTES; the message just sent seeds it under its turnSeq.
 *  No images is no change: a turn re-attached without them leaves what its send cached. */
export function seedImages(key: string, images: string[]): void {
    if (images.length === 0) return;
    const old = cache.get(key);
    if (old) {
        cache.delete(key);
        held -= old.bytes;
    }
    const bytes = images.reduce((n, s) => n + s.length, 0);
    if (bytes > IMAGE_CACHE_BYTES) return;
    cache.set(key, { images, bytes });
    held += bytes;
    for (const [k, entry] of cache) {
        if (held <= IMAGE_CACHE_BYTES) break;
        cache.delete(k);
        held -= entry.bytes;
    }
}

/** The images of one stored message: from the cache, else fetched after every earlier ask; an abort while it waits takes it out of line. */
export function loadImages(key: string, signal: AbortSignal): Promise<string[]> {
    const hit = cachedImages(key);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const ask: Ask = { key, signal, resolve, reject };
        waiting.push(ask);
        signal.addEventListener("abort", () => {
            const at = waiting.indexOf(ask);
            if (at < 0) return;
            waiting.splice(at, 1);
            reject(signal.reason);
        }, { once: true });
        void pump();
    });
}

async function pump(): Promise<void> {
    if (fetching) return;
    fetching = true;
    try {
        for (let ask = waiting.shift(); ask; ask = waiting.shift()) {
            // two bubbles of one message: the second finds what the first fetched
            const hit = cachedImages(ask.key);
            if (hit) {
                ask.resolve(hit);
                continue;
            }
            const [agent = "", conversation, messageId] = ask.key.split("#");
            try {
                const images = await messageImages(agent, Number(conversation), Number(messageId), ask.signal);
                seedImages(ask.key, images);
                ask.resolve(images);
            } catch (e) {
                ask.reject(e);
            }
        }
    } finally {
        fetching = false;
    }
}
