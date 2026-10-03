import { events, type TurnEvent } from "./api.ts";
import { resolveApproval } from "./approval-api.ts";
import { checkedFetch, readJson, type ApiCall } from "./channel.ts";

export interface Room {
    id: string;
    title: string | null;
    participants: string[];
    createdAt: string;
    updatedAt: string;
    busy?: { agent: string; since: number | string };
}

export interface RoomMessage {
    seq: number;
    author: { kind: "human" | "agent" | "system"; agent?: string };
    text: string;
    createdAt: string;
    meta?: {
        callId?: string;
        registryModel?: string;
        requestedModel?: string;
        reportedModel?: string;
        callDurationMs?: number;
        turnDurationMs?: number;
    };
}

export interface RoomMessages {
    messages: RoomMessage[];
    hasMore: boolean;
}

type WireRoom = Omit<Room, "id"> & { id: string | number };

export async function supportsRooms(signal?: AbortSignal): Promise<boolean> {
    const health = await readJson<{ features?: { rooms?: boolean } }>(
        await checkedFetch("/health", signal ? { signal } : {}),
    );
    return health.features?.rooms === true;
}

export async function listRooms(signal?: AbortSignal): Promise<Room[]> {
    const data = await readJson<{ rooms: WireRoom[] }>(
        await checkedFetch("/rooms", signal ? { signal } : {}),
    );
    return data.rooms.map((room) => ({ ...room, id: String(room.id) }));
}

export async function createRoom(title?: string, signal?: AbortSignal): Promise<Room> {
    const data = await readJson<{ room: WireRoom }>(await checkedFetch("/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(title ? { title } : {}),
        ...(signal ? { signal } : {}),
    }));
    return { ...data.room, id: String(data.room.id) };
}

export async function getRoom(id: string, signal?: AbortSignal): Promise<Room> {
    const data = await readJson<{ room: WireRoom }>(
        await checkedFetch(`/rooms/${encodeURIComponent(id)}`, signal ? { signal } : {}),
    );
    return { ...data.room, id: String(data.room.id) };
}

export async function roomMessages(id: string, before?: number, signal?: AbortSignal): Promise<RoomMessages> {
    const query = new URLSearchParams({ limit: "80" });
    if (before !== undefined) query.set("before", String(before));
    return readJson<RoomMessages>(await checkedFetch(
        `/rooms/${encodeURIComponent(id)}/messages?${query}`,
        signal ? { signal } : {},
    ));
}

export async function changeRoomParticipant(id: string, agent: string, add: boolean, signal?: AbortSignal): Promise<Room> {
    const path = `/rooms/${encodeURIComponent(id)}/participants`;
    const data = await readJson<{ room: WireRoom }>(await checkedFetch(
        add ? path : `${path}/${encodeURIComponent(agent)}`,
        {
            method: add ? "POST" : "DELETE",
            ...(add ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ agent }),
            } : {}),
            ...(signal ? { signal } : {}),
        },
    ));
    return { ...data.room, id: String(data.room.id) };
}

/** Resolving this promise acknowledges acceptance; only then may the composer clear its draft. */
export function sendRoomMessage(id: string, text: string, to: string | undefined, signal?: AbortSignal): Promise<ApiCall> {
    return checkedFetch(`/rooms/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, ...(to ? { to } : {}) }),
        ...(signal ? { signal } : {}),
    });
}

export async function* attachRoom(id: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    const call = await checkedFetch(`/rooms/${encodeURIComponent(id)}/stream`, signal ? { signal } : {});
    yield* events(call);
}

export async function stopRoom(id: string, signal?: AbortSignal): Promise<void> {
    await readJson<unknown>(await checkedFetch(`/rooms/${encodeURIComponent(id)}/stop`, {
        method: "POST",
        ...(signal ? { signal } : {}),
    }));
}

export const answerRoomApproval = resolveApproval;
