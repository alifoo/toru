'use client';

import { SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/nextjs';
import { useEffect, useRef, useState } from 'react';
import { PublicFooter, PublicHeader } from '../public-chrome';
import { PlanCard } from './plan-card';

import {plans, creditPacks, creditPacksEnabled} from './plans';
type PaidPlan = 'creator' | 'studio';

export function Pricing() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  // The site's own nav; signed in, its end opens the console instead of asking to sign up.
  const account = isSignedIn ? <><a className="st-signin" href="/">Open Toru</a><UserButton /></> : isLoaded ? <><SignInButton mode="modal"><button type="button" className="st-signin st-signin-button">Sign in</button></SignInButton><SignUpButton mode="modal"><button type="button" className="primary st-nav-cta"><span className="record-dot" aria-hidden="true" />Start free</button></SignUpButton></> : undefined;
  return <div className="public-site pricing-site lw-site st-site">
    <div className="lw-container"><PublicHeader account={account} /></div>
    <main className="pricing-main"><header className="pricing-heading"><h1>Pricing</h1><p>Recording infrastructure for your agent. Start free, upgrade when you need more.</p></header>
      <PlanCards key={userId ?? 'signed-out'} signedIn={Boolean(isSignedIn)} loaded={isLoaded} />
      <p className="pricing-note">1 credit = 1 delivered video that passed the check. Prices in USD, billed monthly. Cancel renewal anytime. Paid plans include a <a href="https://toru.tools/terms#refunds">14-day refund policy</a>.</p>
      {creditPacksEnabled && <section className="pricing-included" aria-labelledby="packs-title"><h2 id="packs-title">Credit packs</h2><p className="pricing-note">Need a few more videos without changing plan? Packs never expire and stack on top of any plan.</p><div>{creditPacks.map(pack=><span key={pack.id}>{pack.credits} {pack.credits===1?'credit':'credits'} · US${pack.price.toFixed(2)}</span>)}</div></section>}
      <section className="pricing-included" aria-labelledby="included-title"><h2 id="included-title">Included in every plan</h2><div><span>One-prompt demos</span><span>Delivery check before charging</span><span>Brand per product</span><span>MP4 and GIF</span><span>Sign-in without sharing passwords</span><span>Claude, Cursor, Codex via MCP</span></div></section>
      <section className="pricing-faq" aria-labelledby="questions-title"><h2 id="questions-title">Questions</h2>
        <details><summary>How do credits work?</summary><p>1 credit = 1 delivered video that passed Toru’s delivery check (not blank, not static, not too short). Videos held for review, failed runs, re-renders and downloads never use a credit.</p></details>
        <details><summary>Do I need my own AI agent?</summary><p>Yes. Connect Toru to your MCP-compatible agent. Your agent handles navigation and reasoning; Toru provides the browser, capture and export. Your agent’s subscription or model usage is separate.</p></details>
        <details><summary>When do my credits renew?</summary><p>Free renews each UTC calendar month. Paid allowances renew each monthly billing cycle after payment is verified. Unused credits do not roll over. Free credits already used count toward your first paid cycle.</p></details>
        <details><summary>Can I cancel or change plans?</summary><p>Cancel renewal from Billing → Manage billing. You retain access through your paid period unless refunded. To switch between paid plans, contact <a href="mailto:support@toru.tools">support@toru.tools</a>.</p></details>
        <details><summary>Is there a beta waiting list?</summary><p>Toru is in a limited public beta. If capacity is full, you can join the waiting list; checkout becomes available once your account is admitted. Payment does not bypass the waiting list.</p></details>
      </section>
    </main><PublicFooter />
  </div>;
}

/** The plans with working buttons: sign up, check out, or manage the plan you have. Used on /pricing and in Billing. */
export function PlanCards({signedIn, loaded}:{signedIn:boolean;loaded:boolean}) {
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<PaidPlan | null>(null);
  const [message, setMessage] = useState('');
  const requestIds = useRef<Partial<Record<PaidPlan,string>>>({});
  const inFlight = useRef(false);
  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    void fetch('/api/usage', {cache:'no-store',signal:controller.signal}).then(async response => {
      if(response.ok) setCurrent((await response.json())?.policy?.version ?? null);
    }).catch(()=>undefined);
    return () => controller.abort();
  }, [signedIn]);
  async function checkout(plan:PaidPlan) {
    if(inFlight.current)return;
    inFlight.current=true;setBusy(plan);setMessage('Opening secure checkout…');
    try {
      // Ensure a newly signed-up account has been registered for beta admission.
      const usage = await fetch('/api/usage',{cache:'no-store'});
      if(!usage.ok)throw new Error('Please retry in a moment. We could not check your account.');
      const state = await usage.json();
      if(state.admission?.state!=='admitted')throw new Error('Your account is on the beta waiting list. Checkout is available once you are admitted.');
      if(['creator-v1','studio-v1'].includes(state.policy?.version)){setCurrent(state.policy.version);throw new Error('You already have a paid plan. Manage billing in Billing or contact support to switch plans.');}
      const requestId=requestIds.current[plan]??=crypto.randomUUID();
      const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({plan,requestId}),signal:AbortSignal.timeout(25000)});
      const body=await response.json();
      if(!response.ok)throw new Error(body.error==='checkout_intent_active'?'You already have an open checkout. Finish it or wait for it to expire before choosing a different plan.':body.error==='checkout_existing_customer'?'Open Billing to manage your existing billing account.':'Checkout is temporarily unavailable. Please try again.');
      const url=new URL(body.url);
      if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw new Error('Checkout is temporarily unavailable.');
      window.location.assign(url.toString());
    } catch(error) {setMessage(error instanceof Error?error.message:'Checkout is temporarily unavailable.');}
    finally {inFlight.current=false;setBusy(null);}
  }
  const paid=current==='creator-v1'||current==='studio-v1';
  // Until usage answers, a signed-in account is on Free: that is where every account starts.
  const isCurrent=(id:string)=>current===`${id}-v1`||(id==='free'&&(current===null||current==='free-v1'));
  return <><div className="pricing-grid">{plans.map(plan=><PlanCard key={plan.id} plan={plan} current={signedIn&&isCurrent(plan.id)} action={
    !loaded?<button className="primary" disabled>Loading…</button>
    :!signedIn?<SignUpButton mode="modal" forceRedirectUrl={plan.id==='free'?'/':'/pricing'}><button className="primary">{plan.id==='free'?'Start free':`Choose ${plan.name}`}</button></SignUpButton>
    :isCurrent(plan.id)?(plan.id==='free'?<a className="primary" href="/#demos">Record a demo</a>:<a className="primary" href="/#plan">Manage your plan</a>)
    :plan.id==='free'?<a className="primary" href="mailto:support@toru.tools?subject=Change%20Toru%20plan">Contact to switch</a>
    :paid?<a className="primary" href="mailto:support@toru.tools?subject=Change%20Toru%20plan">Contact to switch</a>
    :<button className="primary" disabled={busy!==null} onClick={()=>void checkout(plan.id)}>{busy===plan.id?'Opening checkout…':`Choose ${plan.name}`}</button>} />)}</div><p className="pricing-status" role="status">{message}</p></>;
}
