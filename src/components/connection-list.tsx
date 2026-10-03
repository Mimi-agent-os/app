// The URLs that reach the paired gateway, all on one device key, so switching never re-pairs: Settings > Connection lists them, and the pairing gate while a paired device dials.
import { useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import { dropGateway, gatewayAddress, getSnapshot, normalizeGateway, savedGateways, subscribe, useGateway } from "../channel.ts";
import { Btn, Pill } from "./ui.tsx";

export function ConnectionList(): ReactElement {
    const { state } = useSyncExternalStore(subscribe, getSnapshot);
    // they live in the device key, which announces no change: read again after each one made here
    const [urls, setUrls] = useState(savedGateways);
    const [adding, setAdding] = useState("");
    const active = gatewayAddress();

    const add = (): void => {
        useGateway(adding);
        setAdding("");
        setUrls(savedGateways());
    };

    return (
        <div className="conn-urls">
            {urls.map((url) => (
                <div key={url} className="conn-url">
                    <span className="mono" title={url}>{url}</span>
                    {url === active ? (
                        <Pill tone={state === "ready" ? "ok" : state === "incompatible" || state === "reconnecting" ? "bad" : "warn"}>
                            {state === "ready" ? "Active" : state === "incompatible" ? "Needs update" : state === "reconnecting" ? "Retrying" : "Connecting"}
                        </Pill>
                    ) : <Btn sm onClick={() => { useGateway(url); setUrls(savedGateways()); }}>Use</Btn>}
                    {urls.length > 1 && <Btn sm kind="quiet" onClick={() => { dropGateway(url); setUrls(savedGateways()); }}>Remove</Btn>}
                </div>
            ))}
            <div className="conn-add">
                <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={adding}
                    placeholder="http://100.x.y.z:8080"
                    onChange={(event) => setAdding(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && normalizeGateway(adding)) add(); }}
                    className="mono"
                    aria-label="Another URL for this gateway"
                />
                <Btn sm disabled={!normalizeGateway(adding)} onClick={add}>Add URL</Btn>
            </div>
        </div>
    );
}
