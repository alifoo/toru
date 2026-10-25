'use client';

import {useEffect,useRef,useState} from 'react';

type Usage={admission?:{state:string};policy?:{version:string}};

export function BillingControls({usage}:{usage:Usage|null}){
  const [working,setWorking]=useState(false);
  const [message,setMessage]=useState('');
  const requestId=useRef<string|null>(null);
  const creator=['creator-v1','studio-v1'].includes(usage?.policy?.version??'');
  const admitted=usage?.admission?.state==='admitted';
  useEffect(()=>{
    const result=new URLSearchParams(window.location.search).get('billing');
    if(result==='success')setMessage('Stripe returned to Toru. Your paid allowance appears after payment is verified; this page refreshes automatically.');
    if(result==='cancelled')setMessage('Checkout was cancelled. No paid credit was added.');
  },[]);

  async function open(kind:'checkout'|'portal'){
    if(working)return;
    setWorking(true);setMessage(kind==='checkout'?'Preparing secure Checkout…':'Opening billing management…');
    try{
      if(kind==='checkout'&&!requestId.current)requestId.current=crypto.randomUUID();
      const response=await fetch(`/api/billing/${kind}`,{
        method:'POST',headers:{'content-type':'application/json'},
        ...(kind==='checkout'?{body:JSON.stringify({requestId:requestId.current})}:{}),cache:'no-store'
      });
      const body=await response.json().catch(()=>null);
      if(!response.ok||typeof body?.url!=='string'){
        setMessage(body?.error==='checkout_intent_active'?'A Checkout is already open for this account. Finish it or wait for it to expire.'
          :body?.error==='checkout_owner_not_admitted'?'The beta is full. Creator becomes available after admission.'
          :'Billing is temporarily unavailable. No payment was started; retry shortly.');
        return;
      }
      window.location.assign(body.url);
    }catch{setMessage('Billing is temporarily unavailable. No payment was started; retry shortly.');}
    finally{setWorking(false);}
  }

  // Upgrading happens on the plan cards above; this panel is for a subscription that exists, and for checkout's return message.
  if(!creator)return message?<p className="cx-quiet" role="status">{message}</p>:null;
  return <section className="cx-card bl-manage" aria-label="Subscription">
    <div><h2>Your subscription</h2><p>Payment method, invoices and cancellation are in Stripe. <a href="https://toru.tools/terms#refunds">14-day refund policy</a>.</p></div>
    <button type="button" className="cx-button" disabled={working} onClick={()=>void open('portal')}>Manage billing ↗</button>
    {message&&<p className="cx-quiet" role="status">{message}</p>}
  </section>;
}
