/** The pairing gate: this browser's own device identity on the channel.
 *  While unpaired it asks for the one link `mimi pair` prints, which names the gateway address too; typing
 *  the address by hand is the fallback for a link that names none. Once this page has been online it is gone:
 *  a dropped connection shows in each screen header instead, and the URLs live in Settings > Connection.
 *  Until then a paired device that cannot connect gets the same URL list here, to switch to one that answers. */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { PROTOCOL_VERSION } from "@mimi-os/protocol";

import {
    forgetDevice,
    gatewayAddress,
    getSnapshot,
    normalizeGateway,
    pairWithInvite,
    readPairLink,
    recheckProtocol,
    savedGateways,
    subscribe,
    takePendingInvite,
    type ChannelSnapshot,
} from "../channel.ts";
import { ConnectionList } from "../components/connection-list.tsx";
import { Btn } from "../components/ui.tsx";
import { useDialog } from "../components/dialog.tsx";
import { DesktopMenu } from "../components/desktop-menu.tsx";
import mascot from "../assets/mimi-mascot.png";

export function PairGate(): ReactElement | null {
    const [snap, setSnap] = useState<ChannelSnapshot>(getSnapshot);
    const [inviteInput, setInviteInput] = useState("");
    const [gatewayInput, setGatewayInput] = useState(() => normalizeGateway(gatewayAddress()) || "http://127.0.0.1:46464");
    const [manual, setManual] = useState(false);
    const [busy, setBusy] = useState(false);
    // the Retry on the incompatible notice waits for the next snapshot, whatever it says
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState("");
    const dialog = useDialog();
    const dialogEl = useRef<HTMLDialogElement>(null);
    const live = useRef(true);
    const working = useRef(false);

    useEffect(() => {
        live.current = true;
        const unsub = subscribe((s) => {
            if (!live.current) return;
            setSnap(s);
            setChecking(false);
        });
        return () => {
            live.current = false;
            unsub();
        };
    }, []);

    const doPair = async (uri: string, gateway?: string): Promise<void> => {
        if (working.current) return;
        working.current = true;
        setBusy(true);
        setError("");
        try {
            await pairWithInvite(uri, gateway);
            if (live.current) setInviteInput("");
        } catch (e) {
            if (live.current) setError(e instanceof Error && e.message.trim() ? e.message : "Could not pair this device. Check the link and try again.");
        } finally {
            working.current = false;
            if (live.current) setBusy(false);
        }
    };

    // The invite channel.ts stripped out of the hash is redeemed once, on first mount; without one it has already dialled.
    useEffect(() => {
        const hashUri = takePendingInvite();
        if (hashUri) void doPair(hashUri);
    }, []);

    const ready = snap.state === "ready";
    const dialing = snap.state === "connecting" || snap.state === "reconnecting";
    // once this page has been online, a redial (a dropped socket, a switched URL) or a gateway that needs an update waits behind each header's connection line
    const [wasReady, setWasReady] = useState(ready);
    if (ready && !wasReady) setWasReady(true);
    const visible = !ready && !(wasReady && (dialing || snap.state === "incompatible"));

    // the dialog is unmounted rather than closed, so the focus it took is handed back to its opener by hand
    const opener = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const el = dialogEl.current;
        if (visible && el && !el.open) {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            el.showModal();
        }
        if (visible) return;
        if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
        opener.current = null;
    }, [visible]);

    const cleanAndForget = async (): Promise<void> => {
        const yes = await dialog.confirm({
            title: "Clean and forget?",
            body: "This device drops its paired identity and every saved gateway URL. You will pair again with a fresh invite.",
            ok: "Clean and forget",
            danger: true,
        });
        if (yes) forgetDevice();
    };

    if (!visible) return null;
    let link: { uri: string; address: string } | null = null;
    try { link = inviteInput.trim() ? readPairLink(inviteInput) : null; } catch { link = null; }
    // a link that names no gateway needs one typed; any other can still be overridden by hand
    const forced = link !== null && link.address === "";
    const typed = manual || forced;
    const submit = (): void => void doPair(inviteInput.trim(), typed ? gatewayInput : undefined);
    const sasGrouped = snap.sas && snap.sas.length === 6 ? `${snap.sas.slice(0, 3)}-${snap.sas.slice(3)}` : snap.sas;
    const active = gatewayAddress();

    return (
        <dialog ref={dialogEl} className="pairgate" aria-label="Connect to mimi-os" onCancel={(event) => event.preventDefault()}>
            <div className="paircard">
                <div className="pair-brand"><img src={mascot} alt="" /><span className="wm">mimi-os</span><DesktopMenu gate /></div>

                {dialing && (
                    <>
                        <h2>{snap.state === "connecting" ? "Connecting…" : "Reconnecting…"}</h2>
                        <p role="status">{active}</p>
                        {/* only once a dial has failed: every launch passes through "connecting" */}
                        {snap.state === "reconnecting" && savedGateways().length > 0 && (
                            <>
                                <p className="pair-note">Another URL may reach this gateway. Switching keeps the same pairing.</p>
                                <ConnectionList />
                            </>
                        )}
                    </>
                )}
                {!ready && snap.state === "pending_activation" && (
                    <>
                        <h2>Approve this device</h2>
                        <p>On a paired device, open Settings, Access, and approve this one when it shows the same code.</p>
                        <p className="pair-code" role="status">{sasGrouped}</p>
                    </>
                )}
                {!ready && snap.state === "incompatible" && (
                    <>
                        <h2>Update needed</h2>
                        <p role="status">
                            {snap.peer === undefined ? "The gateway speaks a different protocol version" : `The gateway speaks protocol ${snap.peer}`}, this app speaks {PROTOCOL_VERSION}. Update the gateway and the app together.
                        </p>
                        <p className="pair-note">This app checks again on its own, less often as time goes on.</p>
                        <Btn kind="primary" disabled={checking} onClick={() => { setChecking(true); recheckProtocol(); }}>{checking ? "Checking…" : "Retry"}</Btn>
                    </>
                )}
                {!ready && snap.state === "rejected" && (
                    <>
                        <h2>Not paired</h2>
                        <p>This device is not paired with this gateway anymore.</p>
                        <Btn kind="primary" onClick={() => void cleanAndForget()}>Clean and forget</Btn>
                    </>
                )}
                {!ready && snap.state === "pairing_required" && (
                    <>
                        <h2>Connect to mimi-os</h2>
                        <p>Run <code className="mono">mimi pair</code> in a terminal on the gateway, then paste the link it prints.</p>
                        <div className="pair-form">
                            <label>Pairing link
                                <input
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={inviteInput}
                                    placeholder="mimi://pair/v2?…"
                                    disabled={busy}
                                    onChange={(event) => setInviteInput(event.target.value)}
                                    onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
                                    className="mono"
                                />
                            </label>
                            {link !== null && link.address !== "" && !manual && (
                                <p className="pair-note">Gateway <span className="mono">{link.address}</span>, from the link.</p>
                            )}
                            {forced && <p className="pair-note">This link names no gateway. Enter its address below.</p>}
                            {typed && (
                                <label>Gateway address
                                    <input
                                        type="text"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={gatewayInput}
                                        placeholder="http://127.0.0.1:46464"
                                        disabled={busy}
                                        onChange={(event) => setGatewayInput(event.target.value)}
                                        onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
                                        className="mono"
                                    />
                                </label>
                            )}
                            <div className="pair-acts">
                                {forced ? <span /> : (
                                    <Btn kind="quiet" sm disabled={busy} onClick={() => setManual((value) => !value)}>
                                        {manual ? "Use the address in the link" : "Enter the address by hand"}
                                    </Btn>
                                )}
                                <Btn kind="primary" sm disabled={busy || !inviteInput.trim()} onClick={submit}>
                                    {busy ? "Pairing…" : "Pair"}
                                </Btn>
                            </div>
                        </div>
                    </>
                )}
                {error && <p role="alert" style={{ color: "var(--bad)" }}>{error}</p>}
            </div>
        </dialog>
    );
}
