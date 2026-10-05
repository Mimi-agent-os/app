// The shell's one `/events` subscription: the Inbox unread count, inbox toasts, approval toasts and finished replies. Call useInboxUnread exactly once.
import { useCallback, useEffect, useRef, useState } from "react";

import type { ReplyFinishedDetail } from "../agent-chats.ts";
import { listInbox } from "../inbox-api.ts";
import { subscribeEvents, type ApprovalEvent, type InboxItemEvent } from "../events.ts";
import { announceApproval, announceReply, itemAuthor, notifyInboxItem } from "../sys-notify.ts";
import { go } from "../route.ts";
import { useToast } from "./toast.tsx";

export function useInboxUnread(): number {
    const [unread, setUnread] = useState(0);
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const request = useRef(0);
    const refresh = useCallback((): void => {
        const serial = ++request.current;
        void listInbox({ limit: 1 }).then((page) => { if (serial === request.current) setUnread(page.unread); }).catch(() => undefined);
    }, []);

    useEffect(() => {
        refresh();
        const onReply = (e: Event): void => announceReply((e as CustomEvent<ReplyFinishedDetail>).detail, toastRef.current);
        window.addEventListener("mimi:inbox-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
        window.addEventListener("mimi:reply-finished", onReply);
        const stop = subscribeEvents({
            onInboxItem: (event: InboxItemEvent) => {
                toastRef.current(`${itemAuthor(event) ?? "System"}: ${event.title}`);
                void notifyInboxItem(event, () => go({ at: "inbox" }));
            },
            onApproval: (event: ApprovalEvent) => announceApproval(event, toastRef.current),
        });
        return () => {
            window.removeEventListener("mimi:inbox-changed", refresh);
            window.removeEventListener("mimi:resync", refresh);
            window.removeEventListener("mimi:reply-finished", onReply);
            stop();
        };
    }, [refresh]);

    return unread;
}
