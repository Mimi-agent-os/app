// The shell's one `/events` subscription: the Inbox unread count, inbox toasts and approval toasts. Call useInboxUnread exactly once.
import { useCallback, useEffect, useRef, useState } from "react";

import { listInbox } from "../inbox-api.ts";
import { subscribeEvents, type ApprovalEvent, type InboxItemEvent } from "../events.ts";
import { announceApproval, itemAuthor, notifyInboxItem } from "../sys-notify.ts";
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
        window.addEventListener("mimi:inbox-changed", refresh);
        window.addEventListener("mimi:resync", refresh);
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
            stop();
        };
    }, [refresh]);

    return unread;
}
