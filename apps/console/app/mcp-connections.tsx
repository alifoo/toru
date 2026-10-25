"use client";
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ToruOrb } from "./toru-orb";
type Connection={connected:boolean;blocked:boolean;lastUsedAt:number|null};
type Mac={id:string;name:string;status:'ready'|'in_use'|'awaiting_approval'|'offline'|'revoked'};
/** One headline for the whole setup: MCP client first, then the Mac's own state. Never sends a connected user back to installation steps. */
export function connectionHeadline(connection:Connection,macs:Mac[]):{title:string;detail:string} {
  if(connection.blocked)return {title:'Disconnected',detail:'OAuth access is blocked at Toru, including token renewals.'};
  if(!connection.connected)return {title:'Connect your agent',detail:'Add Toru to Claude or another MCP client to start recording.'};
  const live=macs.filter(mac=>mac.status!=='revoked');
  const recording=live.find(mac=>mac.status==='in_use'),ready=live.find(mac=>mac.status==='ready'),online=live.find(mac=>mac.status==='awaiting_approval');
  if(recording)return {title:`Recording on ${recording.name}`,detail:'Your agent is recording the approved source. Stop from the Mac app or wait for it to finish.'};
  if(ready)return {title:'Ready to record',detail:`${ready.name} is online with an approved source. Tell your agent to start recording.`};
  if(online)return {title:'Mac connected',detail:`${online.name} is online. Your agent can pick a window and record it.`};
  return {title:'Connected',detail:'Your agent can use Toru. Start the next recording from your agent’s conversation.'};
}
/** The agent's connection to Toru, then whatever the page puts under it (which can depend on whether an agent is connected). */
export function McpConnections({children,newRecording=false}:{children:ReactNode|((connected:boolean)=>ReactNode);newRecording?:boolean}) {
  const [connection,setConnection]=useState<Connection|null>(null);
  const [macs,setMacs]=useState<Mac[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try {
      const response=await fetch('/api/connections',{cache:'no-store',signal});
      if(!response.ok)throw new Error();
      const body=await response.json();
      if(!signal?.aborted){setConnection(body);setError('');}
      const devices=await fetch('/api/devices',{cache:'no-store',signal});
      if(devices.ok){const list=await devices.json();if(!signal?.aborted&&Array.isArray(list.devices))setMacs(list.devices);}
    }catch{if(!signal?.aborted)setError('Could not check your connection. Try again.');}
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    const update=()=>{if(!document.hidden)void refresh(controller.signal);};
    update();const timer=setInterval(update,15000);window.addEventListener('focus',update);
    return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',update);};
  },[refresh]);
  async function change(enabled:boolean) {
    if(busy)return;setBusy(true);setError('');
    try {
      const response=await fetch('/api/connections',{method:enabled?'POST':'DELETE'});
      if(!response.ok)throw new Error();
      setConnection(await response.json());
    }catch{setError('Could not update access. Try again.');}finally{setBusy(false);}
  }
  const headline=connection?connectionHeadline(connection,macs):undefined;
  const tone=!connection?'waiting':connection.blocked?'offline':connection.connected?'ready':'waiting';
  return <div className="cx">
    {!connection && !error && <section className="cx-card cx-agent" role="status"><ToruOrb size={22} still /><p className="cx-quiet">Checking your connection…</p></section>}
    {error && <p className="cx-error" role="status">{error} <button type="button" className="cx-text" onClick={()=>void refresh()}>Retry</button></p>}
    {connection && headline && <section className="cx-card cx-agent" aria-label="Your agent">
      <span className={`cx-dot cx-${tone}`} aria-hidden="true" />
      <div className="cx-agent-copy"><h2>{headline.title}</h2><p>{headline.detail}</p>{connection.lastUsedAt && <small>Last used {new Date(connection.lastUsedAt).toLocaleString()}</small>}</div>
      <div className="cx-actions">
        {connection.connected && <a className="cx-button" href="/onboarding?step=prompt&from=demos">Create a demo prompt</a>}
        {connection.connected && <button type="button" className="cx-text" disabled={busy} onClick={()=>void change(false)}>{busy?'Updating…':'Disconnect'}</button>}
        {connection.blocked && <button type="button" className="cx-button" disabled={busy} onClick={()=>void change(true)}>{busy?'Updating…':'Allow reconnection'}</button>}
      </div>
    </section>}
    {connection?.blocked && <p className="cx-quiet">Remove Toru in your client’s connector settings to revoke its saved authorization. Allowing reconnection here lets existing authorizations work again. To use another Toru account, sign out here and reconnect in your client.</p>}
    {connection && (typeof children==='function'?children(connection.connected&&!connection.blocked):children)}
  </div>;
}
