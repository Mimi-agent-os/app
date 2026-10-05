/** How an inbox item, a parked approval or a finished reply reaches the owner: the owner's switch, the Tauri-vs-browser
 *  branch, and the attribution rule that keeps an agent out of a headline the owner reads as the gateway's own voice. */
import type { ReplyFinishedDetail } from "./agent-chats.ts";
import type { ShowToast } from "./components/toast.tsx";
import type { ApprovalEvent, InboxItemEvent } from "./events.ts";
import { getInboxItem } from "./inbox-api.ts";
import { formatRoute, gateRoute, go, here, type Route } from "./route.ts";
import { notifyEnabled } from "./shared.ts";
import { androidApp, tauriInvoke } from "./tauri.ts";

// control and format characters (newlines, bidi overrides) are how authored text fakes extra lines or reorders what surrounds it
const flat = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();

// a desktop window behind other apps is shown but not looked at; the phone app is looked at whenever it is shown
const looking = (): boolean => !document.hidden && (androidApp || document.hasFocus());

function show(title: string, body: string, onOpen: () => void, tag = ""): void {
    const invoke = tauriInvoke();
    if (invoke) {
        void invoke("notify", { title, body }).catch(() => undefined);
        return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
        const n = new Notification(title, { body, icon: "/app/favicon.png", tag });
        n.onclick = () => { window.focus(); onOpen(); n.close(); };
    } catch {
        // constructor can throw where only ServiceWorker notifications are allowed (e.g. Android)
    }
}

/** `null` for a gateway item — the "System" label belongs to the pult, never to an agent. */
export const itemAuthor = (event: InboxItemEvent): string | null =>
    (event.source === "agent" && event.agent ? event.agent : null);

/** An agent never authors the headline and never raises a banner over a pult the owner is looking at: both are how
 *  a gateway alert gets forged. A gateway alert's body is what it exists to deliver (the device code) and the event
 *  does not carry it, so it is read back first. */
export async function notifyInboxItem(event: InboxItemEvent, onOpen: () => void): Promise<void> {
    if (!notifyEnabled()) return;
    const author = itemAuthor(event);
    if (author) {
        if (!looking()) show(author, flat(event.title), onOpen);
        return;
    }
    if (event.level !== "action" && looking()) return;
    const item = await getInboxItem(event.id).catch(() => null);
    show(flat(event.title), flat(item?.body ?? ""), onOpen);
}

// the approval toast still on screen, and how many gates it stands for
let burst: { up: () => boolean; count: number } | null = null;

/** A parked gate reaches the owner unless its chat is on screen and looked at (Inbox, for a gate in a parked room); gates that pile up under one toast fold into a line that opens Inbox. */
export function announceApproval(event: ApprovalEvent, toast: ShowToast): void {
    const target = gateRoute(event.agent, event.room, event.session ?? undefined, event.gate);
    const now = here();
    // Inbox lists every gate, whichever one its URL opened
    const onIt = target.at === "inbox" ? now?.at === "inbox" : now !== null && formatRoute(now) === formatRoute(target);
    if (looking() && onIt) return;
    const count = burst?.up() ? burst.count + 1 : 1;
    // an ask or a return gate carries a label in `tool`, so the words never claim a tool is run
    const more = event.actions > 1 ? ` and ${event.actions - 1} more` : "";
    const ask = event.kind === "question" ? "asks you a question" : `needs your approval: ${flat(event.tool)}${more}`;
    const review = (): void => go(count === 1 ? target : { at: "inbox" });
    const headline = count === 1 ? `${event.agent} ${ask}` : `${count} requests waiting`;
    burst = { up: toast(headline, { label: count === 1 && event.kind === "question" ? "Answer" : "Review", run: review }), count };
    // the admitted agent's name heads a banner, never its label; one tag, so banners replace instead of stacking
    if (!notifyEnabled() || looking()) return;
    if (count === 1) show(event.agent, ask, review, "mimi-approval");
    else show(headline, "Review them in Inbox", review, "mimi-approval");
}

/** A finished reply pings as phone push does unless its chat is on screen and looked at; a plain toast never displaces an approval's Review, and the phone app leaves the banner to push. */
export function announceReply(reply: ReplyFinishedDetail, toast: ShowToast): void {
    const target: Route = { at: "chat", agent: reply.agent, id: reply.id };
    const now = here();
    const onIt = now !== null && formatRoute(now) === formatRoute(target);
    if (looking() && onIt) return;
    const title = flat(reply.title ?? "") || "New chat";
    if (!onIt) toast(`${reply.agent} replied in ${title}`);
    if (!notifyEnabled() || looking() || androidApp) return;
    show(`${reply.agent} replied`, title, () => go(target), `mimi-reply${formatRoute(target)}`);
}
