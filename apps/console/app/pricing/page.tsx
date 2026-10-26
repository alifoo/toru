import type {Metadata} from 'next';
import {headers} from 'next/headers';
import {Pricing} from './pricing';
import {plans,sourceUrl} from './plans';
import {PlanCard} from './plan-card';
import {PublicHeader,PublicFooter} from '../public-landing';
import {isAppHost,APP_URL} from '../site';
export async function generateMetadata():Promise<Metadata>{
 return {title:'Pricing: Free, Creator and Studio plans · Toru',description:'Free: 10 demos a month. Creator: $19 a month for 50. Studio: $49 for 150. One credit per delivered demo; held-back takes are never charged.',alternates:{canonical:'https://toru.tools/pricing'},...(isAppHost((await headers()).get('host'))?{robots:{index:false,follow:false}}:{})};
}
export default async function PricingPage(){
 if(isAppHost((await headers()).get('host')))return <Pricing/>;
 return <div className="public-site pricing-site lw-site"><div className="lw-container"><PublicHeader/></div><main className="pricing-main"><header className="pricing-heading"><h1>Pay for demos that pass.</h1><p>One credit per delivered demo; a held-back take is never charged. Start free, upgrade when your agent records more.</p></header>
  <div className="pricing-grid">{plans.map(plan=><PlanCard key={plan.id} plan={plan} action={<a className="primary" href={plan.id==='free'?APP_URL:`${APP_URL}/pricing`} data-cta={`pricing-${plan.id}`}>{plan.id==='free'?'Start free':`Choose ${plan.name}`}</a>}/>)}</div>
  <p className="pricing-note">A team, a contract or invoices{sourceUrl?', or help running Toru yourself':''}? <a href="mailto:support@toru.tools?subject=Toru%20for%20my%20team">Talk to us</a>.{sourceUrl&&<> Rather run it yourself? Toru is open source and free to self-host. <a href={sourceUrl} target="_blank" rel="noreferrer">See the code</a></>}</p>
  <p className="pricing-note">Prices in USD, billed monthly. One credit is used when the first MP4 from a recording is delivered. Downloads and technical retries do not use another credit. Unused credits do not roll over.</p>
  <section className="pricing-included"><h2>Included in every plan</h2><div><span>One-prompt demos</span><span>Delivery check before charging</span><span>Brand per product</span><span>MP4 and GIF</span><span>Your Chrome or your Mac</span><span>Claude, Cursor, Codex via MCP</span></div></section>
  <section className="pricing-faq"><h2>Before you start</h2><p>You need an MCP-compatible agent, such as Claude Code, Claude, Cursor or Codex. Your agent subscription is separate. Toru is in limited public beta; checkout is available after account admission. Cancel renewal in the app. Paid plans include a <a href="/terms#refunds">14-day refund policy</a>.</p></section>
 </main><PublicFooter/></div>;
}
