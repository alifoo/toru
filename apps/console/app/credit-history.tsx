'use client';
import { useEffect, useRef, useState } from 'react';

import { collectCreditHistory, type CreditEntry } from './credit-export';
type Page = {history:CreditEntry[];historyNextCursor?:string|null};

export function CreditHistory({ latest }: { latest:Page }) {
  const [snapshot,setSnapshot]=useState<Page|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const [exporting,setExporting]=useState(false);
  const exportController=useRef<AbortController|null>(null);
  const alive=useRef(true),busy=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;exportController.current?.abort();};},[]);
  const page=snapshot??latest;
  async function older(){
    if(busy.current||!page.historyNextCursor)return;
    busy.current=true;setLoading(true);setError('');
    // Freeze the first page while browsing older events; new arrivals cannot shift it.
    setSnapshot(page);
    try{
      const response=await fetch(`/api/usage?historyCursor=${encodeURIComponent(page.historyNextCursor)}`,{cache:'no-store',signal:AbortSignal.timeout(12000)});
      const body=await response.json();
      if(!response.ok||!Array.isArray(body?.history))throw new Error('history_unavailable');
      if(!alive.current)return;
      const seen=new Set(page.history.map(entry=>entry.id));
      setSnapshot({history:[...page.history,...(body.history as CreditEntry[]).filter(entry=>!seen.has(entry.id))],historyNextCursor:body.historyNextCursor});
    }catch{if(alive.current)setError('Older activity is temporarily unavailable. Try again.');}
    finally{busy.current=false;if(alive.current)setLoading(false);}
  }
  async function exportHistory(){
    if(exportController.current)return;
    const controller=new AbortController();exportController.current=controller;
    setExporting(true);setError('');
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
      const result=await collectCreditHistory(async(cursor,signal)=>{
        const response=await fetch(`/api/usage${cursor?`?historyCursor=${encodeURIComponent(cursor)}`:''}`,{cache:'no-store',signal});
        if(!response.ok)throw new Error('history_export_incomplete');
        return response.json();
      },signal);
      if(!alive.current)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`recorder-credit-history-${result.startedAt.slice(0,10)}.json`;
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      setError(`Export prepared with ${result.entries.length} events. New activity after the export started may not be included.`);
    }catch(error){
      if(alive.current)setError(error instanceof Error&&error.message==='history_export_too_large'?'This history exceeds the browser export limit of 100,000 events. Contact the operator for an export; no partial file was generated.':'Export could not be completed. No file was generated. Try again.');
    }finally{exportController.current=null;if(alive.current)setExporting(false);}
  }
  return <details className="usage-history">
    <summary>Credit activity</summary>
    <p>{page.history.length} events shown. Reserved credits become used on delivery, or return when an attempt is abandoned.</p>
    {snapshot && <p>New activity is not added while you browse older entries. <button className="quiet" disabled={loading} onClick={()=>{setSnapshot(null);setError('');}}>Show latest activity</button></p>}
    <ul>{page.history.map(entry=><li key={entry.id}><div><strong>{{grant:'Credits added',reserve:'Credit reserved',commit:'Credit used',release:'Reservation returned',adjust:'Credit adjustment'}[entry.kind]??'Credit activity'}</strong><small>{entry.jobId?`Recording ${entry.jobId.slice(0,8)} · `:''}{entry.source} · {entry.cycle}</small></div><span>{entry.amount} {entry.amount===1?'credit':'credits'}<small>{new Date(entry.createdAt).toLocaleString()}</small></span></li>)}</ul>
    {page.historyNextCursor && <button className="quiet" disabled={loading} onClick={()=>void older()}>{loading?'Loading…':'Load older activity'}</button>}
    <p><button className="quiet" disabled={exporting} onClick={()=>void exportHistory()}>{exporting?'Preparing export…':'Export all credit activity (JSON)'}</button></p>
    <p role="status">{error}</p>
  </details>;
}
