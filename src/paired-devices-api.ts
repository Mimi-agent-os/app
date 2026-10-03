import { apiFetch, readJson, refusal } from "./channel.ts";
import { singleFlight } from "./shared.ts";

type PairedDeviceStatus = "inactive" | "active" | "revoked";

export interface PairedDevice {
    id: string;
    name: string;
    status: PairedDeviceStatus;
    sas: string;
    enrolledAt: string;
    activatedAt: string | null;
    lastSeen: string | null;
    connected: boolean;
}

export interface DeviceInvite {
    /** Carries the pairing secret — render for copying, never log or toast it. */
    uri: string;
    id: string;
    expiresAt: string;
}

export type ApproveMode = "tap" | "code";

const CHANGED = "mimi:paired-devices-changed";

export async function listPairedDevices(signal?: AbortSignal): Promise<PairedDevice[]> {
    const call = await apiFetch("/devices", { signal: signal ?? null });
    if (!call.res.ok) throw new Error(await refusal(call) || `Could not load paired devices (${call.res.status}).`);
    const body = await readJson<{ devices?: unknown }>(call);
    if (!Array.isArray(body.devices)) throw new Error("The gateway returned an invalid paired device list.");
    return body.devices.map((value: unknown) => {
        const row = value as Partial<PairedDevice> | null;
        if (!row || typeof row.id !== "string" || !row.id || typeof row.name !== "string"
            || (row.status !== "inactive" && row.status !== "active" && row.status !== "revoked")
            || typeof row.sas !== "string" || typeof row.enrolledAt !== "string"
            || typeof row.connected !== "boolean") {
            throw new Error("The gateway returned an invalid paired device.");
        }
        return {
            id: row.id, name: row.name, status: row.status, sas: row.sas,
            enrolledAt: row.enrolledAt, connected: row.connected,
            activatedAt: typeof row.activatedAt === "string" ? row.activatedAt : null,
            lastSeen: typeof row.lastSeen === "string" ? row.lastSeen : null,
        };
    });
}

export async function createDeviceInvite(): Promise<DeviceInvite> {
    const call = await apiFetch("/devices/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
    });
    if (!call.res.ok) throw new Error(await refusal(call) || `Could not create a device link (${call.res.status}).`);
    const body = await readJson<Partial<DeviceInvite>>(call);
    if (typeof body.uri !== "string" || !body.uri || typeof body.id !== "string" || !body.id || typeof body.expiresAt !== "string") {
        throw new Error("The gateway returned an invalid device link.");
    }
    window.dispatchEvent(new CustomEvent(CHANGED));
    return { uri: body.uri, id: body.id, expiresAt: body.expiresAt };
}

type DeviceAction = "approve" | "reject" | "revoke";

const decisions = new Map<string, { tag: string; flight: Promise<"resolved" | "gone"> }>();

function decide(id: string, action: DeviceAction, run: () => Promise<"resolved" | "gone">): Promise<"resolved" | "gone"> {
    if (!id || id === "." || id === "..") return Promise.reject(new Error("This device is no longer available."));
    return singleFlight(decisions, id, action, CHANGED, run);
}

export function approveDevice(id: string, code?: string): Promise<"resolved" | "gone"> {
    return decide(id, "approve", async () => {
        const call = await apiFetch(`/devices/${encodeURIComponent(id)}/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        });
        if (call.res.status === 409) throw new Error(await refusal(call) || `The gateway refused the code. Check the six digits on the new device's screen (${call.res.status}).`);
        if ([404, 410].includes(call.res.status)) return "gone";
        if (!call.res.ok) throw new Error(await refusal(call) || `Could not approve this device (${call.res.status}).`);
        const body = await readJson<{ ok?: unknown }>(call);
        if (body.ok !== true) throw new Error("The gateway did not confirm the approval. Refresh the device status before trying again.");
        return "resolved";
    });
}

function terminate(id: string, action: "reject" | "revoke"): Promise<"resolved" | "gone"> {
    return decide(id, action, async () => {
        const call = await apiFetch(`/devices/${encodeURIComponent(id)}/${action}`, { method: "POST" });
        if ([404, 410].includes(call.res.status)) return "gone";
        if (!call.res.ok) throw new Error(await refusal(call) || `Could not ${action} this device (${call.res.status}).`);
        const body = await readJson<{ ok?: unknown }>(call);
        if (body.ok !== true) throw new Error("The gateway did not confirm the decision. Refresh the device status before trying again.");
        return "resolved";
    });
}

export const rejectDevice = (id: string): Promise<"resolved" | "gone"> => terminate(id, "reject");

export const revokeDevice = (id: string): Promise<"resolved" | "gone"> => terminate(id, "revoke");

export async function getDeviceSettings(signal?: AbortSignal): Promise<ApproveMode> {
    const call = await apiFetch("/devices/settings", { signal: signal ?? null });
    if (!call.res.ok) throw new Error(await refusal(call) || `Could not load the device approval mode (${call.res.status}).`);
    const body = await readJson<{ approveMode?: unknown }>(call);
    if (body.approveMode !== "tap" && body.approveMode !== "code") throw new Error("The gateway returned an invalid device approval mode.");
    return body.approveMode;
}

export async function setDeviceSettings(mode: ApproveMode): Promise<ApproveMode> {
    const call = await apiFetch("/devices/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approveMode: mode }),
    });
    if (!call.res.ok) throw new Error(await refusal(call) || `Could not change the device approval mode (${call.res.status}).`);
    const body = await readJson<{ approveMode?: unknown }>(call);
    if (body.approveMode !== "tap" && body.approveMode !== "code") throw new Error("The gateway returned an invalid device approval mode.");
    window.dispatchEvent(new CustomEvent(CHANGED));
    return body.approveMode;
}
