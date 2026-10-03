// One chat as a list row, on the home list and the agent page; it navigates itself and owns its action menu.
import { memo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { deleteConversation, type ConversationInfo } from "../api.ts";
import type { ApprovalSummary } from "../approval-api.ts";
import { dropChat, editChat, useChats, type ChatEdit } from "../agent-chats.ts";
import { back, forgetChat, formatRoute, go, here, leave, WIDE } from "../route.ts";
import { ago, errorMessage, isDelegation } from "../shared.ts";
import { useDialog } from "./dialog.tsx";
import { Icon } from "./icon.tsx";
import { Menu } from "./menu.tsx";
import { useToast } from "./toast.tsx";
import { Countdown, useMinute } from "./ui.tsx";
import "../rows.css";

interface ChatActions {
    pin: (c: ConversationInfo) => Promise<void>;
    rename: (c: ConversationInfo, title?: string) => Promise<void>;
    archive: (c: ConversationInfo) => Promise<void>;
    remove: (c: ConversationInfo) => Promise<void>;
}

/** Pin, rename and archive land in the list at once; the store puts the row back when the gateway refuses, and the toast says why. */
export function useChatActions(agent: string): ChatActions {
    const dialog = useDialog();
    const toast = useToast();
    const rows = useRef<readonly ConversationInfo[] | null>(null);
    rows.current = useChats(agent).rows;

    const patch = async (c: ConversationInfo, edit: ChatEdit): Promise<void> => {
        try {
            await editChat(agent, c.id, edit);
        } catch (e) {
            toast(`${c.title ? `“${c.title}”` : "The chat"} is unchanged. ${errorMessage(e)}`);
        }
    };

    return {
        pin: (c) => patch(c, { pinned: !c.pinned }),
        archive: (c) => patch(c, { archived: !c.archived }),
        rename: async (c, title) => {
            const next = title ?? (await dialog.prompt({ title: "Rename chat", initial: c.title ?? "", ok: "Rename" }));
            if (next && next !== c.title) await patch(c, { title: next });
        },
        remove: async (c) => {
            const empty = c.messages === 0;
            const sure = await dialog.confirm({
                title: `Delete “${c.title ?? (empty ? "New chat" : "Untitled")}”?`,
                body: empty ? "It has no messages yet." : `${c.busy ? "Its running turn stops first. " : ""}This erases the chat and its history for good.`,
                ok: "Delete",
                danger: true,
            });
            if (!sure) return;
            // picked before the row drops, so the shell's gone-chat check cannot move first
            const next = rows.current?.find((x) => x.id !== c.id && !x.archived && !isDelegation(x) && x.messages > 0);
            try {
                await deleteConversation(agent, c.id);
            } catch (e) {
                toast(errorMessage(e));
                return;
            }
            dropChat(agent, c.id);
            forgetChat(agent, c.id);
            const gone = { at: "chat", agent, id: c.id } as const;
            const now = here();
            // a phone steps back to where the chat was opened from; the desktop pane shows the next chat in its place
            if (now && formatRoute(now) === formatRoute(gone) && !matchMedia(WIDE).matches) back();
            else leave(gone, next ? { at: "chat", agent, id: next.id } : { at: "agent", agent });
        },
    };
}

// its own component so only an open menu subscribes to the agent's rows
function RowMenu({ agent, chat, at, onClose }: {
    agent: string;
    chat: ConversationInfo;
    at: HTMLElement | { x: number; y: number };
    onClose: () => void;
}): ReactElement {
    const actions = useChatActions(agent);
    return (
        <Menu
            label="Chat actions"
            at={at}
            onClose={onClose}
            items={[
                { id: "pin", label: chat.pinned ? "Unpin" : "Pin", icon: "pin", run: () => void actions.pin(chat) },
                { id: "rename", label: "Rename…", icon: "edit", run: () => void actions.rename(chat) },
                { id: "archive", label: chat.archived ? "Unarchive" : "Archive", icon: "archive", run: () => void actions.archive(chat) },
                "sep",
                { id: "delete", label: "Delete…", icon: "close", danger: true, run: () => void actions.remove(chat) },
            ]}
        />
    );
}

interface ChatRowProps {
    agent: string;
    chat: ConversationInfo;
    variant: "home" | "full";
    open: boolean;
    gate?: ApprovalSummary | undefined;
    stale?: boolean | undefined;
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 8;

function ChatRowView({ agent, chat, variant, open, gate, stale }: ChatRowProps): ReactElement {
    // re-renders the relative time once a minute
    useMinute();
    const [menu, setMenu] = useState<HTMLElement | { x: number; y: number } | null>(null);
    const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
    const title = chat.title ?? (chat.messages === 0 ? "New chat" : "Untitled");

    const meta: ReactNode = gate ? <Countdown deadline={gate.deadline} />
        : chat.awaitingApproval ? <span className="state" data-tone="warn">needs you</span>
        : chat.busy ? <span className="state" data-tone="accent">responding</span>
        : <time dateTime={`${chat.updatedAt.replace(" ", "T")}Z`}>{ago(chat.updatedAt)}</time>;
    const body = (
        <>
            <span className="chat-title">{title}</span>
            {chat.pinned && <span className="chat-pin" aria-label="Pinned"><Icon name="pin" sm /></span>}
            <span className="chat-meta">{meta}</span>
        </>
    );
    const endPress = (): void => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = null;
    };

    return (
        <div
            className="chat-row"
            data-variant={variant}
            data-open={open || undefined}
            data-stale={stale || undefined}
            onContextMenu={(e) => {
                if (stale) return;
                e.preventDefault();
                endPress();
                setMenu({ x: e.clientX, y: e.clientY });
            }}
        >
            {stale ? (
                <div className="chat-hit" aria-disabled="true" title={`Back when ${agent} reconnects`}>{body}</div>
            ) : (
                <button
                    type="button"
                    className="chat-hit"
                    aria-current={open ? "page" : undefined}
                    onClick={() => go({ at: "chat", agent, id: chat.id })}
                    onPointerDown={(e) => {
                        if (e.pointerType === "mouse") return;
                        const { clientX: x, clientY: y } = e;
                        endPress();
                        press.current = {
                            x,
                            y,
                            timer: setTimeout(() => {
                                press.current = null;
                                // the finger is still down: lifting it clicks the row, or the sheet item now under it, and that one click is eaten
                                const eat = (c: MouseEvent): void => {
                                    c.stopPropagation();
                                    c.preventDefault();
                                };
                                window.addEventListener("click", eat, { capture: true, once: true });
                                window.addEventListener("pointerdown", () => window.removeEventListener("click", eat, true), { capture: true, once: true });
                                setMenu({ x, y });
                            }, LONG_PRESS_MS),
                        };
                    }}
                    onPointerMove={(e) => {
                        const p = press.current;
                        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) endPress();
                    }}
                    onPointerUp={endPress}
                    onPointerCancel={endPress}
                >
                    {body}
                </button>
            )}
            {variant === "full" && !stale && (
                <button type="button" className="btn icon sm chat-more" aria-label={`Actions for ${title}`} onClick={(e) => setMenu(e.currentTarget)}>
                    <Icon name="more" sm />
                </button>
            )}
            {menu && <RowMenu agent={agent} chat={chat} at={menu} onClose={() => setMenu(null)} />}
        </div>
    );
}

export const ChatRow = memo(ChatRowView);
