"use client";
import { useCallback, useEffect, useState } from "react";
type Device = { connectionId: string; name: string; status: "ready" | "in_use" | "offline"; lastSeenAt?: string };
const label: Record<Device["status"], string> = { ready: "Ready to record", in_use: "Recording", offline: "Offline: open Chrome" };

/** Toru for Chrome on this account: the paired browsers, and a one-time link to pair the Chrome you are in. */
export function ChromeDevices() {
  const [devices, setDevices] = useState<Device[] | null>(null), [available, setAvailable] = useState(true);
  const [error, setError] = useState(""), [busy, setBusy] = useState(""), [opened, setOpened] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/extension-devices", { cache: "no-store", signal });
      if (!response.ok) throw new Error();
      const body = await response.json() as { available?: boolean; devices?: Device[] };
      if (!signal?.aborted) { setDevices(Array.isArray(body.devices) ? body.devices : []); setAvailable(body.available !== false); setError(""); }
    } catch { if (!signal?.aborted) setError("Could not load your Chrome browsers."); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const update = () => { if (!document.hidden) void refresh(controller.signal); };
    update(); const timer = setInterval(update, 15000); window.addEventListener("focus", update);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", update); };
  }, [refresh]);
  async function pair() {
    if (busy) return; setBusy("pair"); setError("");
    try {
      const response = await fetch("/api/extension-devices", { method: "POST" });
      const body = await response.json().catch(() => ({})) as { connectUrl?: string };
      if (!response.ok || !body.connectUrl) throw new Error();
      window.open(body.connectUrl, "_blank", "noopener"); setOpened(true);
    } catch { setError("Could not create a pairing link. Try again."); } finally { setBusy(""); }
  }
  async function remove(device: Device) {
    if (busy || !window.confirm(`Disconnect ${device.name}? It will need a new pairing link to record again.`)) return;
    setBusy(device.connectionId); setError("");
    try {
      const response = await fetch(`/api/extension-devices?id=${encodeURIComponent(device.connectionId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      await refresh();
    } catch { setError("Could not disconnect this Chrome. Try again."); } finally { setBusy(""); }
  }
  return <section className="cx-card cx-device" aria-label="Toru for Chrome">
    <header><h2>Toru for Chrome</h2><p>Web apps, recorded in the Chrome you are already signed in to.</p></header>
    {devices === null && !error && <p className="cx-quiet" role="status">Checking…</p>}
    {devices && devices.length === 0 && <p className="cx-quiet">No Chrome paired yet.</p>}
    {devices && devices.length > 0 && <ul className="cx-list">{devices.map(device => <li key={device.connectionId}>
      <span className={`cx-dot cx-${device.status}`} aria-hidden="true" /><b>{device.name}</b><span>{label[device.status]}</span>
      <button type="button" className="cx-text" disabled={busy !== ""} onClick={() => void remove(device)}>{busy === device.connectionId ? "Disconnecting…" : "Disconnect"}</button>
    </li>)}</ul>}
    {opened && <p className="cx-quiet" role="status">The pairing page opened in a new tab. Open it in the Chrome that has Toru for Chrome; it connects by itself.</p>}
    {error && <p className="cx-error" role="alert">{error}</p>}
    <div className="cx-actions">
      {available ? <button type="button" className="cx-button" disabled={busy !== ""} onClick={() => void pair()}>{busy === "pair" ? "Creating…" : devices?.length ? "Pair another Chrome" : "Pair this Chrome"}</button> : <span className="cx-quiet">Toru for Chrome is not open to this account yet.</span>}
      <a className="cx-text" href="/chrome" target="_blank" rel="noreferrer">Install the extension ↗</a>
    </div>
  </section>;
}
