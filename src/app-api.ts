import { useCallback, useEffect, useState } from "react";

import { ApiError, apiFetch, readJson, refusal } from "./channel.ts";
import { errorMessage } from "./shared.ts";

export interface AppPage {
    id: string;
    title: string;
    path?: string;
}

export interface AgentApp {
    agent: string;
    appId: string;
    title: string;
    entry?: string;
    pages?: AppPage[];
    available: boolean;
    /** The agent's pin status; only an approved agent may be launched, whatever `available` says. */
    status: "approved" | "blocked";
    revision?: string | number;
    lastSeenAt?: string;
}

/** Every agent's apps in one read, for each agent's Interfaces tab and its chats' Web view. */
export async function listApps(signal: AbortSignal): Promise<AgentApp[]> {
    const call = await apiFetch("/apps", { signal: AbortSignal.any([AbortSignal.timeout(15_000), signal]) });
    if (!call.res.ok) {
        const reason = await refusal(call);
        throw new ApiError(call.res.status, `Could not load interfaces${reason ? `: ${reason}` : ` (${call.res.status}).`}`);
    }
    return (await readJson<{ apps: AgentApp[] }>(call)).apps;
}

export interface InterfacesData {
    apps: AgentApp[];
    loading: boolean;
    error: string | null;
    refresh: () => void;
    /** null until discovery completes. */
    hasInterfaces: boolean | null;
}

export function useInterfaces(agent: string, connected?: boolean): InterfacesData {
    const [apps, setApps] = useState<AgentApp[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);
    const refresh = useCallback(() => setRevision((value) => value + 1), []);

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        void listApps(controller.signal).then((all) => {
            if (!controller.signal.aborted) setApps(all.filter((app) => app.agent === agent));
        }, (reason: unknown) => {
            if (controller.signal.aborted) return;
            setApps([]);
            setError(errorMessage(reason, "Could not load interfaces. Try again."));
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [agent, revision, connected]);

    return { apps, loading, error, refresh, hasInterfaces: apps.length > 0 ? true : loading || error ? null : false };
}
