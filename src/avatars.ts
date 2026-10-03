// Agent avatars as blob URLs, one per sha256 the roster names: loaded when a hash appears, revoked once no agent names it.
import { useSyncExternalStore } from "react";

import { getAgentAvatar, type AgentSummary } from "./api.ts";

let hashes: ReadonlyMap<string, string> = new Map();
const blobs = new Map<string, string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

/** Called with every roster answer; a hash that failed to load is tried again on the next one. */
export function setAvatars(agents: readonly Pick<AgentSummary, "name" | "avatar">[]): void {
    hashes = new Map(agents.flatMap((a) => (a.avatar ? [[a.name, a.avatar] as const] : [])));
    const named = new Set(hashes.values());
    for (const [hash, url] of blobs) {
        if (named.has(hash)) continue;
        URL.revokeObjectURL(url);
        blobs.delete(hash);
    }
    for (const [agent, hash] of hashes) {
        if (blobs.has(hash) || loading.has(hash)) continue;
        loading.add(hash);
        getAgentAvatar(agent, hash)
            .then((blob) => {
                // the roster moved on while it loaded
                if ([...hashes.values()].includes(hash)) blobs.set(hash, URL.createObjectURL(blob));
            }, () => undefined)
            .finally(() => {
                loading.delete(hash);
                listeners.forEach((l) => l());
            });
    }
    listeners.forEach((l) => l());
}

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** The agent's avatar as a blob URL, or null while it loads, after it failed, or when the agent has none. */
export function useAvatar(agent: string): string | null {
    return useSyncExternalStore(subscribe, () => {
        const hash = hashes.get(agent);
        return hash === undefined ? null : blobs.get(hash) ?? null;
    });
}
