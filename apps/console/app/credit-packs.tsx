'use client';
import {useRef,useState} from 'react';
import {creditPacks,creditPacksEnabled} from './pricing/plans';
type Usage={admission?:{state:string};available?:number;mode?:string};
/** Packs never expire and sit on top of any plan. Shown only behind the feature flag. */
export function CreditPacks({usage,compact=false,onDismiss}:{usage:Usage|null;compact?:boolean;onDismiss?:()=>void}){
  const [working,setWorking]=useState('');
  const [message,setMessage]=useState('');
  const requests=useRef<Record<string,string>>({});
  if(!creditPacksEnabled||usage?.mode!=='hosted'||usage?.admission?.state!=='admitted')return null;
  async function buy(packId:string){
    if(working)return;setWorking(packId);setMessage('Preparing secure Checkout…');
    try{
      requests.current[packId]??=crypto.randomUUID();
      const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:requests.current[packId],plan:packId}),cache:'no-store'});
      const body=await response.json().catch(()=>null);
      if(!response.ok||typeof body?.url!=='string'){
        setMessage(body?.error==='packs_unavailable'?'Credit packs are not on sale yet. Plans are available on the pricing page.':body?.error==='checkout_intent_active'?'A Checkout is already open for this account. Finish it or wait for it to expire.':'Billing is temporarily unavailable. No payment was started; retry shortly.');
        return;
      }
      window.location.assign(body.url);
    }catch{setMessage('Billing is temporarily unavailable. No payment was started; retry shortly.');}
    finally{setWorking('');}
  }
  return <section className={`credit-packs ${compact?'compact':''}`} aria-label="Credit packs">
    <div><h3>{compact?'Keep going with a credit pack':'Credit packs'}</h3><p>One credit = one delivered video that passed the check. Packs never expire and stack on top of your plan.</p></div>
    <ul>{creditPacks.map(pack=><li key={pack.id}><b>{pack.credits} {pack.credits===1?'credit':'credits'}</b><span>US${pack.price.toFixed(2)}</span><button className="primary" disabled={working!==''} onClick={()=>void buy(pack.id)}>{working===pack.id?'Opening…':'Buy'}</button></li>)}</ul>
    <p role="status">{message}</p>
    {onDismiss && <button className="quiet" type="button" onClick={onDismiss}>Not now</button>}
  </section>;
}
