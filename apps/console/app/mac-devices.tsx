"use client";
import { useCallback, useEffect, useState } from 'react';
type Device={id:string;name:string;status:'ready'|'in_use'|'awaiting_approval'|'offline'|'revoked';lastSeenAt:number;createdAt:number};
type Setup={pairingCode:string;expiresAt:string;serverUrl:string;setupUrl:string;downloadUrl:string};
const label:Record<Device['status'],string>={ready:'Ready to record',in_use:'Recording',awaiting_approval:'Online, waiting for approval',offline:'Offline',revoked:'Disconnected'};
/** Macs are devices, not MCP clients: identity here never carries capture consent. */
export function MacDevices() {
  const [devices,setDevices]=useState<Device[]|null>(null);
  const [setup,setSetup]=useState<Setup|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState('');
  const [copied,setCopied]=useState(false);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try {
      const response=await fetch('/api/devices',{cache:'no-store',signal});
      if(!response.ok)throw new Error();
      const body=await response.json();
      if(!signal?.aborted){setDevices(Array.isArray(body.devices)?body.devices:[]);setError('');}
    }catch{if(!signal?.aborted)setError('Could not load your Macs. Try again.');}
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    const update=()=>{if(!document.hidden)void refresh(controller.signal);};
    update();const timer=setInterval(update,15000);window.addEventListener('focus',update);
    return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',update);};
  },[refresh]);
  async function connect() {
    if(busy)return;setBusy('connect');setError('');setCopied(false);
    try {
      const response=await fetch('/api/devices',{method:'POST'});
      if(!response.ok)throw new Error();
      setSetup(await response.json());
    }catch{setError('Could not create a setup link. Try again.');}finally{setBusy('');}
  }
  async function disconnect(device:Device) {
    if(busy||!window.confirm(`Disconnect ${device.name}? It will need a new setup link to record again. Local videos on that Mac are not affected.`))return;
    setBusy(device.id);setError('');
    try {
      const response=await fetch(`/api/devices?id=${encodeURIComponent(device.id)}`,{method:'DELETE'});
      if(!response.ok)throw new Error();
      await refresh();
    }catch{setError('Could not disconnect this Mac. Try again.');}finally{setBusy('');}
  }
  async function copyCode() {
    if(!setup)return;
    try{await navigator.clipboard.writeText(setup.pairingCode);setCopied(true);}catch{setError('Clipboard unavailable. Select the code and copy it.');}
  }
  return <section className="cx-card cx-device" aria-label="Toru for Mac">
    <header><h2>Toru for Mac</h2><p>Native Mac apps: Toru records the window your agent picks and, if you allow it, operates it.</p></header>
    {devices===null && !error && <p className="cx-quiet" role="status">Checking…</p>}
    {devices && devices.length===0 && <p className="cx-quiet">No Mac paired yet.</p>}
    {devices && devices.length>0 && <ul className="cx-list">
      {devices.map(device=><li key={device.id}>
        <span className={`cx-dot cx-${device.status}`} aria-hidden="true" /><b>{device.name}</b><span>{label[device.status]}</span>
        {device.status!=='revoked' && <button type="button" className="cx-text" disabled={busy!==''} onClick={()=>void disconnect(device)}>{busy===device.id?'Disconnecting…':'Disconnect'}</button>}
      </li>)}
    </ul>}
    {error && <p className="cx-error" role="status">{error} <button type="button" className="cx-text" onClick={()=>void refresh()}>Retry</button></p>}
    <div className="cx-actions">
      <button type="button" className="cx-button" disabled={busy!==''} onClick={()=>void connect()}>{busy==='connect'?'Creating…':devices&&devices.some(d=>d.status!=='revoked')?'Pair another Mac':'Pair a Mac'}</button>
      <a className="cx-text" href="/mac" target="_blank" rel="noreferrer">Download Toru for Mac ↗</a>
    </div>
    {setup && <div className="cx-setup">
      <p>Not installed yet? Paste this into Terminal, then come back:</p>
      <code className="cx-code">curl -fsSL https://toru.tools/install.sh | bash</code>
      <p>Then <a className="cx-text" href={setup.setupUrl}>open Toru with this link</a>, or enter the one-time code <button type="button" className="cx-text" onClick={()=>void copyCode()}>{copied?'(copied)':'(copy)'}</button>:</p>
      <code className="cx-code cx-pairing">{setup.pairingCode}</code>
      <p className="cx-quiet">Server {setup.serverUrl}. The code works once and expires {new Date(setup.expiresAt).toLocaleTimeString()}; keep it out of chats.</p>
    </div>}
  </section>;
}
