import {LegacyWorkspaceRedirect} from './legacy-workspace-redirect';
import {APP_URL} from './site';
import {AgentIcon,InstallTabs} from './landing-interactive';
import {ContactSheet,StudioWindow} from './landing-studio';
import {CLIENTS,type Client} from './agent-setup';
import {plans,sourceUrl} from './pricing/plans';
import {PlanCard} from './pricing/plan-card';
import type {ReactNode} from 'react';
import { ToruOrb } from "./toru-orb";
import { PublicFooter, PublicHeader, PublicPage } from "./public-chrome";
export { PublicFooter, PublicHeader, PublicPage };
export const recordingFaqs=[
 {question:'What is Toru?',answer:'Toru is the recording infrastructure your AI agent uses to record product demos itself. Your agent plans the flow from your code and records it in your Chrome or the app on your Mac; Toru supplies the capture, the camera moves, your brand and a check of every take, and hands back an MP4 and a GIF.'},
 {question:'Which model clicks through my product?',answer:'Yours. The agent you already use (Claude Code, Cursor, Codex) drives the flow with Toru\'s tools, a few tokens per step. Toru adds no model of its own and no model cost.'},
 {question:'Which agents work with Toru?',answer:'Claude Code, Claude, Cursor, Codex and any client that supports remote MCP servers. Install the Toru skill (alifoo/toru-skills) or add https://mcp.toru.tools/mcp as a connector and sign in to Toru.'},
 {question:'Where do my product passwords go?',answer:'Nowhere. Toru records in your own Chrome, where you are already signed in, or on your Mac. It never asks for a password or a code, and a sign-in page stops the run instead of being recorded.'},
 {question:'What is the delivery check?',answer:'Before a demo is delivered, Toru checks the rendered video. A blank, frozen or too-short video is held back, shown as needing review, and never charged. You can record again or choose to receive it anyway.'},
 {question:'Can I use my brand?',answer:'Yes. Save colors, background, padding, a logo, intro and outro cards, a GIF and the output size for each product domain. Every demo of that product is rendered with it, without your agent having to ask.'},
 {question:'Can Toru record in my own Chrome?',answer:'Yes, that is how Toru records web apps. Install Toru for Chrome and pair it once; for each recording your agent opens your product in a window of its own and records it there through Toru, signed in as you, without a sharing dialog. Your cookies and browser storage never leave Chrome.'},
 {question:'Can Toru record a native Mac app?',answer:'Yes. Toru for Mac records a window or display you choose, with the same agent, account and credits. When you allow it, your agent operates that window through Toru, in the background, while you keep working.'},
 {question:'What does Toru cost?',answer:'Free includes 10 credits each month. Creator costs US$19 per month for 50 credits and Studio US$49 per month for 150. Credit packs that never expire are available on top of any plan. One credit is one delivered video that passed the check. Your AI agent subscription is separate.'},
];
/** Only once the repository is public: the answer points at it. */
const openSourceFaq=sourceUrl?[{question:'Is Toru open source?',answer:`Yes, under the MIT license. All of Toru is public at ${sourceUrl}: the recorder, the Chrome extension, the Mac app and the console. Run it yourself, with no model key to bring, or let us run it for you.`},
 {question:'Why pay if Toru is open source?',answer:'You don\'t have to: self-hosting is free, forever. The hosted plans are for teams who would rather ship than operate a recorder: no servers, render workers or storage to run, links that work the moment a video is ready, updates the day they ship, and a person to answer when something breaks. Every paid plan also funds the open-source project.'}]:[];
/** The landing page answers the questions people ask before they connect it. */
const landingFaqs=[...openSourceFaq,
 {question:'How is this different from Loom or Screen Studio?',answer:'Those tools record you doing the flow. With Toru, your agent does the flow from a prompt; Toru records it, adds the zooms, cursor and your brand, and checks the video before it reaches you. Toru is the infrastructure; your agent is the operator.'},
 {question:'Does my agent get my passwords?',answer:'No. It sees the product address and the plan. You are already signed in in your own Chrome or on your Mac, and a sign-in page stops the recording instead of being recorded.'},
 {question:'What uses a credit?',answer:'One delivered video that passed the check. A blank, frozen or too-short take is held back and costs nothing; downloads and technical retries do not use another credit.'},
 {question:'Can it record a Mac app?',answer:'Yes. Toru for Mac records the window you share and, when you allow it, operates that window for your agent. Same account, same credits.'},
];
const agents:Client[]=['claude-code','claude','cursor','codex'];
/** A section opening: one line, in ink. */
function Heading({id,title}:{id:string;title:string}){
 return <header className="st-heading"><h2 id={id}>{title}</h2></header>;
}

export function PublicLanding(){
 const schema={'@context':'https://schema.org','@graph':[
  {'@type':'Organization','@id':'https://toru.tools/#organization',name:'Toru',url:'https://toru.tools',logo:'https://toru.tools/icon.png',description:'A recording tool your AI agent uses on its own to record your product demos in your own Chrome or on your Mac.',email:'support@toru.tools'},
  {'@type':'SoftwareApplication',name:'Toru',url:'https://toru.tools',applicationCategory:'MultimediaApplication',operatingSystem:'Web, macOS',description:recordingFaqs[0]!.answer,offers:plans.map(plan=>({'@type':'Offer',name:plan.name,price:String(plan.price),priceCurrency:'USD',url:'https://toru.tools/pricing'}))},
  {'@type':'FAQPage',mainEntity:landingFaqs.map(item=>({'@type':'Question',name:item.question,acceptedAnswer:{'@type':'Answer',text:item.answer}}))},
 ]};
 return <div className="public-site marketing-site lw-site st-site"><LegacyWorkspaceRedirect/>
  <div className="lw-container"><PublicHeader/></div>
  <main>
   <section className="st-hero" aria-labelledby="landing-title">
    <ToruOrb size={76}/>
    <h1 id="landing-title">Recording infrastructure for your agent.</h1>
    <p className="st-lede">Your coding agent records your product demos itself: launch clips, changelog GIFs, help-center guides and bug repros. Toru is its camera, editor and brand kit, and checks every take.</p>
    <div className="st-hero-actions">
     <a className="primary st-cta" href={APP_URL} data-cta="hero-start-free"><span className="record-dot" aria-hidden="true"/>Start free</a>
     {sourceUrl&&<a className="st-github" href={sourceUrl} target="_blank" rel="noreferrer" data-cta="hero-github-star"><GitHubMark/>Star on GitHub</a>}
    </div>
    <p className="st-trust">10 free demos a month · No card required · {sourceUrl?<a href={sourceUrl} target="_blank" rel="noreferrer">Open source, MIT</a>:'Open source, MIT'}</p>
   </section>
   <StudioWindow appUrl={APP_URL}/>

   <section className="st-agents" aria-label="Agents Toru works with">
    <p>Works inside the agent you already use</p>
    <ul>{agents.map(key=><li key={key}><AgentIcon client={key} size={20}/>{CLIENTS[key].title}</li>)}<li><a href="/docs"><AgentIcon client="other" size={20}/>Any MCP client</a></li></ul>
   </section>

   <section className="st-section" id="use-cases" aria-labelledby="uses-title">
    <Heading id="uses-title" title="What your agent can record for you."/>
    <dl className="st-uses">{useCases.map(([title,body,prompt])=><div key={title}><dt>{title}</dt><dd><span>{body}</span><q>{prompt}</q></dd></div>)}</dl>
    <ContactSheet/>
   </section>

   <section className="st-section" id="how-it-works" aria-label="Connect your agent">
    <div className="st-connect">
     <div className="st-connect-copy"><h3>Connected in five minutes.</h3><p>Pick your agent and paste the commands. Then pair <a href="/chrome">Toru for Chrome</a> or <a href="/mac">Toru for Mac</a> from the one link your agent sends you.</p></div>
     <InstallTabs/>
    </div>
   </section>




   <section className="st-section" id="pricing" aria-labelledby="pricing-title">
    <Heading id="pricing-title" title="Pay only for demos that pass."/>
    <div className="pricing-grid st-pricing">
     {plans.map(plan=><PlanCard key={plan.id} plan={plan} action={<a className="primary" href={plan.price===0?APP_URL:`${APP_URL}/pricing`} data-cta={`landing-plan-${plan.id}`}>{plan.price===0&&<span className="record-dot" aria-hidden="true"/>}{plan.price===0?'Start free':`Choose ${plan.name}`}</a>}/>)}
    </div>
    <p className="st-note">A credit is used only when a video passes the check. <a href="/pricing">Compare the plans</a> or <a href="mailto:support@toru.tools?subject=Toru%20for%20my%20team">talk to us</a> about a team.</p>
   </section>

   {sourceUrl&&<section className="st-section" id="open-source" aria-labelledby="oss-title">
    <div className="st-oss">
     <div className="st-oss-copy">
      <p className="st-oss-tag">Open source · MIT</p>
      <h2 id="oss-title">Every line of Toru is yours to read and run.</h2>
      <p>The recorder, Toru for Chrome, Toru for Mac and the console are public. Self-host it for free with no model key to bring, since your agent does the driving. The hosted plans fund the project and spare you the servers.</p>
      <div className="st-oss-actions">
       <a className="st-github" href={sourceUrl} target="_blank" rel="noreferrer" data-cta="oss-github-star"><GitHubMark/>Star on GitHub</a>
       <a className="st-link" href="/docs#self-host" data-cta="oss-self-host">Self-host guide <span aria-hidden="true">→</span></a>
      </div>
     </div>
     <ul className="st-oss-parts">{openParts.map(([name,body,icon])=><li key={name}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={icon}/></svg><b>{name}</b><span>{body}</span></li>)}</ul>
    </div>
   </section>}

   <section className="st-section st-faq" id="faq" aria-labelledby="faq-title">
    <h2 id="faq-title">Questions before you connect it.</h2>
    <div>{landingFaqs.map((item,index)=><details key={item.question} open={index===0}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div>
   </section>

  </main><PublicFooter/><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(schema).replace(/</g,'\\u003c')}}/>
 </div>;
}

/** What the public repository holds, as the open-source section lists it, with a stroke icon (24-unit box). */
const openParts:Array<[string,string,string]>=[
 ['Recorder','The MCP server your agent talks to: capture, camera, render and the delivery check.','M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18'],
 ['Toru for Chrome','The extension that records in your own signed-in Chrome.','M4 5h16v14H4zM4 9h16M7 7h.01M9.5 7h.01'],
 ['Toru for Mac','The app that records, and lets your agent operate, a window on your Mac.','M5 6h14v10H5zM3 19h18M10 16l-.5 3M14 16l.5 3'],
 ['Console','Demos, connections, brand and billing, the same one we host.','M4 4h16v16H4zM9 4v16M9 10h11'],
];

/** What people record with Toru: the outcome, then a prompt they would actually send. */
const useCases:Array<[string,string,string]>=[
 ['Launch videos','A polished walkthrough for Product Hunt, your landing page or the announcement post.','Record the new onboarding flow for our launch.'],
 ['Changelog clips','A short clip or GIF for every feature you merge, in the release notes the same day.','Make a GIF of the CSV export for the changelog.'],
 ['Help-center guides','Docs that show the real screen and stay current: run the same prompt again when the UI changes.','Re-record the billing settings guide.'],
 ['Sales and onboarding demos','The exact flow a prospect asked about, without booking a screen share.','Show how a manager approves an invoice.'],
 ['Bug reports','A video of the bug on the issue, so whoever picks it up sees it before reading a line.','Record the steps that reproduce issue #412.'],
 ['Social posts','Short clips for X and LinkedIn, cut tight and in your brand.','Cut a 20-second clip of the new dashboard.'],
];
function GitHubMark(){
 return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>;
}



export function SiteFooter() {
  return <footer className="site-footer"><span>toru <span className="footer-note">/ Limited public beta</span></span><nav aria-label="Legal and support"><a href="https://toru.tools/pricing">Pricing</a><a href="https://toru.tools/terms">Terms</a><a href="https://toru.tools/privacy">Privacy</a><a href="mailto:support@toru.tools">Get in touch</a></nav></footer>;
}

export function ToruLoading() {
  return <main className="loading-page" aria-busy="true">
    <div className="loading-quiet" role="status" aria-live="polite"><ToruOrb size={28} /><span>Loading…</span></div>
  </main>;
}
