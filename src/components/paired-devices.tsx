import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactElement } from "react";

import {
    approveDevice,
    createDeviceInvite,
    getDeviceSettings,
    listPairedDevices,
    rejectDevice,
    revokeDevice,
    setDeviceSettings,
    type ApproveMode,
    type DeviceInvite,
    type PairedDevice,
} from "../paired-devices-api.ts";
import { holdBack, releaseBack } from "../route.ts";
import { errorMessage, parse, when } from "../shared.ts";
import { Btn, Dot, Empty, KvRow, Panel, Pill } from "./ui.tsx";
import { CopyTextButton } from "./markdown.tsx";
import { useDialog } from "./dialog.tsx";
import { useToast } from "./toast.tsx";
import "../paired-devices.css";

const grouped = (sas: string): string => (sas.length === 6 ? `${sas.slice(0, 3)}-${sas.slice(3)}` : sas);

export function PairedDevices(): ReactElement {
    const dialog = useDialog();
    const toast = useToast();
    const [devices, setDevices] = useState<PairedDevice[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [mode, setMode] = useState<ApproveMode | null>(null);
    const [invite, setInvite] = useState<DeviceInvite | null>(null);
    const [inviteBusy, setInviteBusy] = useState(false);
    const [modeBusy, setModeBusy] = useState(false);
    const [pending, setPending] = useState<Record<string, "approve" | "reject" | "revoke">>({});
    const [now, setNow] = useState(Date.now);
    const [allOpen, setAllOpen] = useState(false);
    const acting = useRef(new Set<string>());
    const live = useRef(true);
    const request = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!allOpen) return undefined;
        const hold = holdBack(() => setAllOpen(false));
        return () => releaseBack(hold);
    }, [allOpen]);

    const refresh = useCallback(async (): Promise<void> => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        setError("");
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
            const [rows, approveMode] = await Promise.all([listPairedDevices(signal), getDeviceSettings(signal).catch(() => null)]);
            if (!live.current || controller.signal.aborted) return;
            setDevices(rows);
            setNow(Date.now());
            if (approveMode !== null) setMode(approveMode);
        } catch (e) {
            if (live.current && !controller.signal.aborted) {
                setError(errorMessage(e, "Could not load paired devices. Try again."));
            }
        } finally {
            if (request.current === controller) {
                request.current = null;
                if (live.current) setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        live.current = true;
        void refresh();
        const changed = (): void => { void refresh(); };
        window.addEventListener("mimi:paired-devices-changed", changed);
        window.addEventListener("mimi:resync", changed);
        return () => {
            live.current = false;
            request.current?.abort();
            window.removeEventListener("mimi:paired-devices-changed", changed);
            window.removeEventListener("mimi:resync", changed);
        };
    }, [refresh]);

    const expiryMs = invite ? parse(invite.expiresAt).getTime() : NaN;
    const seconds = Number.isFinite(expiryMs) ? Math.max(0, Math.ceil((expiryMs - now) / 1000)) : null;
    const expired = seconds === 0;

    useEffect(() => {
        if (!invite || expired) return;
        const clock = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(clock);
    }, [invite, expired]);

    const link = async (): Promise<void> => {
        if (inviteBusy) return;
        setInviteBusy(true);
        try {
            const created = await createDeviceInvite();
            if (live.current) {
                setInvite(created);
                setNow(Date.now());
            }
        } catch (e) {
            if (live.current) toast(errorMessage(e, "Could not create a device link. Try again."));
        } finally {
            if (live.current) setInviteBusy(false);
        }
    };

    const act = async (row: PairedDevice, action: "approve" | "reject" | "revoke", code?: string): Promise<void> => {
        if (acting.current.has(row.id)) return;
        acting.current.add(row.id);
        setPending((old) => ({ ...old, [row.id]: action }));
        try {
            const result = action === "approve" ? await approveDevice(row.id, code)
                : action === "reject" ? await rejectDevice(row.id)
                : await revokeDevice(row.id);
            if (live.current && result === "gone") toast("This device enrollment is no longer available.");
        } catch (e) {
            if (live.current) toast(errorMessage(e, "Could not update this device. Refresh its status before trying again."));
        } finally {
            acting.current.delete(row.id);
            if (live.current) setPending((old) => { const next = { ...old }; delete next[row.id]; return next; });
        }
    };

    const approve = async (row: PairedDevice): Promise<void> => {
        if (mode === "code") {
            const typed = await dialog.prompt({
                title: `Approve «${row.name}»?`,
                body: "Type the six-digit code shown on the new device's screen.",
                placeholder: "123456",
                ok: "Approve",
            });
            if (typed === null) return;
            await act(row, "approve", typed.replace(/[^0-9]/g, ""));
        } else {
            await act(row, "approve");
        }
    };

    const revoke = async (row: PairedDevice): Promise<void> => {
        const yes = await dialog.confirm({
            title: `Revoke «${row.name}»?`,
            body: "This device loses access permanently and its live sessions end now.",
            ok: "Revoke",
            danger: true,
        });
        if (yes) await act(row, "revoke");
    };

    const switchMode = async (next: ApproveMode): Promise<void> => {
        if (modeBusy || mode === next) return;
        setModeBusy(true);
        try {
            const saved = await setDeviceSettings(next);
            if (live.current) setMode(saved);
        } catch (e) {
            if (live.current) toast(errorMessage(e, "Could not change the approval mode. Try again."));
        } finally {
            if (live.current) setModeBusy(false);
        }
    };

    const revokedCount = devices.filter((row) => row.status === "revoked").length;
    const current = devices.filter((row) => row.status !== "revoked");

    const deviceRow = (row: PairedDevice): ReactElement => {
        const busy = pending[row.id];
        return (
            <KvRow
                key={row.id}
                lead={<Dot state={row.connected ? "ok" : "idle"} />}
                name={
                    <span className="paired-name">
                        {row.name}
                        <Pill tone={row.status === "inactive" ? "warn" : row.status === "active" ? "ok" : "bad"}>
                            {row.status === "inactive" ? "awaiting approval" : row.status}
                        </Pill>
                    </span>
                }
                sub={
                    <span className="paired-sub">
                        {row.status === "inactive" && <span className="paired-sas mono">{grouped(row.sas)}</span>}
                        {row.status === "inactive" && (
                            <span>
                                {mode === "code"
                                    ? "The new device shows this code. Type its six digits to approve."
                                    : "Make sure the new device shows the same code, then approve."}
                            </span>
                        )}
                        <span>
                            Enrolled {when(row.enrolledAt)}
                            {row.lastSeen !== null && ` · Last seen ${when(row.lastSeen)}`}
                            {row.connected && " · Connected"}
                        </span>
                    </span>
                }
                actions={
                    row.status === "inactive" ? (
                        <>
                            <Btn kind="primary" sm disabled={!!busy} onClick={() => void approve(row)}>{busy === "approve" ? "Approving…" : "Approve"}</Btn>
                            <Btn kind="quiet" sm disabled={!!busy} onClick={() => void act(row, "reject")}>{busy === "reject" ? "Rejecting…" : "Reject"}</Btn>
                        </>
                    ) : row.status === "active" ? (
                        <Btn kind="quiet" sm disabled={!!busy} onClick={() => void revoke(row)}>{busy === "revoke" ? "Revoking…" : "Revoke"}</Btn>
                    ) : undefined
                }
            />
        );
    };

    return (
        <Panel
            title="Paired devices"
            icon="key"
            aside={
                <>
                    {revokedCount > 0 && (
                        <Btn kind="quiet" sm onClick={() => setAllOpen(true)}>All sessions ({revokedCount} revoked)</Btn>
                    )}
                    <Btn kind="quiet" sm disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</Btn>
                </>
            }
        >
            <div className="paired-invite">
                <div className="paired-invite-head">
                    <p>Link a phone or another computer to this gateway.</p>
                    <Btn kind="primary" sm icon="plus" disabled={inviteBusy} onClick={() => void link()}>
                        {inviteBusy ? "Creating link…" : "Link a device"}
                    </Btn>
                </div>
                {invite && (expired ? (
                    <p className="paired-invite-copy">This link has expired. Create a new one.</p>
                ) : (
                    <>
                        <div className="paired-invite-uri">
                            <code className="mono">{invite.uri}</code>
                            <CopyTextButton text={invite.uri} label="Copy device link" />
                        </div>
                        <p className="paired-invite-copy">
                            This link is single-use{seconds !== null && ` and expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}.
                            {" "}Open it on the new device and it appears below for approval. Creating a new link replaces this one.
                        </p>
                    </>
                ))}
            </div>
            {error && <div role="alert" style={{ padding: 14, color: "var(--bad)" }}>{error}</div>}
            {loading && devices.length === 0 && !error && <Empty>Loading paired devices…</Empty>}
            {!loading && !error && devices.length === 0 && <Empty>No paired devices yet. Link a device to get started.</Empty>}
            {!loading && !error && devices.length > 0 && current.length === 0 && <Empty>No active or pending devices. Open all sessions to see revoked ones.</Empty>}
            {current.map(deviceRow)}
            {mode !== null && (
                <div className="paired-mode">
                    <div className="paired-mode-copy">
                        <b>Approval mode</b>
                        <span>Tap approves a new device with one click while both screens show the same code. Code makes you type the six digits from the new device's screen.</span>
                    </div>
                    <div className="paired-mode-btns" role="group" aria-label="Approval mode">
                        <Btn kind={mode === "tap" ? "primary" : "outline"} sm disabled={modeBusy} onClick={() => void switchMode("tap")}>Tap</Btn>
                        <Btn kind={mode === "code" ? "primary" : "outline"} sm disabled={modeBusy} onClick={() => void switchMode("code")}>Code</Btn>
                    </div>
                </div>
            )}
            {allOpen && createPortal(
                <>
                    <div className="mback" onClick={() => setAllOpen(false)} />
                    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="all-sessions-title"
                        tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") setAllOpen(false); }}>
                        <div className="mhead">
                            <h2 id="all-sessions-title">All sessions</h2>
                            <Btn kind="quiet" sm icon="close" title="Close (Escape)" onClick={() => setAllOpen(false)} />
                        </div>
                        <div className="mbody">
                            {devices.length === 0
                                ? <Empty>No sessions.</Empty>
                                : devices.map(deviceRow)}
                        </div>
                    </div>
                </>,
                document.body,
            )}
        </Panel>
    );
}
