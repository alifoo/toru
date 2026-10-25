'use client';
import {useState} from 'react';
import {CLIENTS,type Client} from './agent-setup';

type Route = {id:string;tab:string;label:string;title:string;body:string;checks:string[];window:string;tools:Array<[string,string]>;cta:[string,string]};

const routes:Route[] = [
 {id:'chrome',tab:'Your Chrome',label:'Toru for Chrome · beta',title:'Record where you are already signed in.',
  body:'Pair your Chrome once. For each recording, your agent opens your product in a window of its own and records it there through Toru, with your session and no sharing dialog.',
  checks:['No click per recording','Only the window Toru opens','Cookies stay in Chrome','Sign-in pages stop the run'],
  window:'Your Chrome',tools:[['extension_pair','Connect this Chrome once'],['extension_devices','See it ready'],['recording_run','Your agent records in your Chrome'],['recording_links','MP4 and GIF']],cta:['Get Toru for Chrome','/chrome']},
 {id:'mac',tab:'Your Mac',label:'Toru for Mac · macOS 15+',title:'Native apps, recorded the same way.',
  body:'Toru for Mac records the window or display you choose, with the same agent, account and credits. You approve what is shared; the video is rendered and checked like every other demo.',
  checks:['One window or one display','You approve each share','Real cursor, native capture','Same brand and delivery check'],
  window:'Your Mac',tools:[['desktop_devices','Your paired Macs'],['desktop_sources','Windows you can share'],['desktop_select_source','Pick the window'],['desktop_recording_run','Your agent records the window'],['recording_links','MP4 and GIF']],cta:['Get Toru for Mac','/mac']},
 {id:'brand',tab:'Your brand',label:'Every demo',title:'Set your brand once. Every demo wears it.',
  body:'Colors, background, padding, a logo, intro and outro cards, a GIF and the output size, saved per product domain. Your agent never has to ask.',
  checks:['Per product domain','Intro and outro cards','GIF beside every MP4','Up to 2560 px wide'],
  window:'Brand',tools:[['Colors','Background and accents'],['Logo','Corner mark'],['Intro card','Title before the flow'],['Outro card','Call to action at the end'],['Output','1280, 1920 or 2560 px']],cta:['Set up your brand','APP']},
];

export function RouteDirectory({appUrl}:{appUrl:string}){
 const [active,setActive]=useState(routes[0]!.id);
 const route=routes.find(item=>item.id===active)!;
 const href=route.cta[1]==='APP'?appUrl:route.cta[1];
 return <div className={`lx-directory lx-tint-${route.id}`}>
  <div className="lx-tabs" role="tablist" aria-label="Recording routes">
   {routes.map(item=><button key={item.id} role="tab" type="button" id={`route-tab-${item.id}`} aria-selected={item.id===active} aria-controls="route-panel" onClick={()=>setActive(item.id)}>{item.tab}</button>)}
  </div>
  <div className="lx-directory-body" role="tabpanel" id="route-panel" aria-labelledby={`route-tab-${route.id}`}>
   <div className="lx-window" aria-hidden="true">
    <div className="lx-window-bar"><span className="lx-lights"><i/><i/><i/></span><b>{route.window}</b><span>{route.tools.length} {route.id==='brand'?'settings':'tools'}</span></div>
    <ul>{route.tools.map(([name,detail],index)=><li key={name} className={index===0?'lx-current':''}><span className="lx-tool-icon"/><b>{name}</b><span>{detail}</span></li>)}</ul>
    <div className="lx-drop">“Record the new invoice flow and end on the paid invoice.”</div>
   </div>
   <div className="lx-route-copy">
    <p className="lx-eyebrow">{route.label}</p>
    <h3>{route.title}</h3>
    <p>{route.body}</p>
    <ul className="lx-checks">{route.checks.map(check=><li key={check}>{check}</li>)}</ul>
    <a className="primary lx-cta" href={href}>{route.cta[0]} <span aria-hidden="true">›</span></a>
   </div>
  </div>
 </div>;
}

export function ExperienceDemos(){
 const [zoomed,setZoomed]=useState(false);
 const [format,setFormat]=useState<'mp4'|'gif'>('mp4');
 const [width,setWidth]=useState(1920);
 const [check,setCheck]=useState<'idle'|'running'|'passed'|'held'>('idle');
 const [frozen,setFrozen]=useState(false);
 const [brand,setBrand]=useState<'midnight'|'ocean'|'sunset'>('ocean');
 const runCheck=()=>{setCheck('running');window.setTimeout(()=>setCheck(frozen?'held':'passed'),1100);};
 return <div className="lx-experience-grid">
  <article className="lx-demo">
   <div className="lx-demo-stage">
    <button type="button" className={`lx-zoom ${zoomed?'lx-zoomed':''}`} onClick={()=>setZoomed(!zoomed)} aria-pressed={zoomed} aria-label="Click to zoom on the Save button">
     <span className="lx-zoom-frame"><span className="lx-zoom-row"/><span className="lx-zoom-row lx-short"/><span className="lx-zoom-save">Save invoice</span><span className="lx-zoom-cursor" aria-hidden="true"/></span>
    </button>
   </div>
   <div className="lx-demo-copy"><h3>Zoom where it matters</h3><p>Every click is framed and the cursor glides between them. Click the card to see the camera move.</p></div>
  </article>
  <article className="lx-demo">
   <div className="lx-demo-stage">
    <div className="lx-mini-panel">
     <p className="lx-mini-label">Output</p>
     <div className="lx-segment" role="group" aria-label="Format">{(['mp4','gif'] as const).map(value=><button key={value} type="button" aria-pressed={format===value} onClick={()=>setFormat(value)}>{value.toUpperCase()}</button>)}</div>
     <div className="lx-segment lx-segment-small" role="group" aria-label="Width">{[1280,1920,2560].map(value=><button key={value} type="button" aria-pressed={width===value} onClick={()=>setWidth(value)}>{value}</button>)}</div>
     <p className="lx-file"><span className="lx-file-icon" aria-hidden="true"/>invoice-flow<b>.{format}</b><small>{width} px</small></p>
    </div>
   </div>
   <div className="lx-demo-copy"><h3>Pick the output, see the file</h3><p>MP4 for the docs, GIF for the changelog, at the width you publish. Both come back with every demo.</p></div>
  </article>
  <article className="lx-demo">
   <div className="lx-demo-stage">
    <div className="lx-mini-panel">
     <label className="lx-toggle"><span>Simulate a frozen video</span><input type="checkbox" checked={frozen} onChange={event=>{setFrozen(event.target.checked);setCheck('idle');}}/><i aria-hidden="true"/></label>
     <button type="button" className="lx-run" onClick={runCheck} disabled={check==='running'}>{check==='running'?'Checking…':'Run the delivery check'}</button>
     <div className="lx-progress" aria-hidden="true"><span className={check==='running'?'lx-running':check==='idle'?'':'lx-done'}/></div>
     <p className="lx-verdict" role="status">{check==='passed'?'Passed. Delivered, 1 credit.':check==='held'?'Held for review. Not charged.':check==='running'?'Looking at every frame…':'Waiting for a video'}</p>
    </div>
   </div>
   <div className="lx-demo-copy"><h3>Checked before it reaches you</h3><p>Blank, frozen or too-short videos are held back and never charged. Only demos that pass use a credit.</p></div>
  </article>
  <article className="lx-demo">
   <div className="lx-demo-stage">
    <div className="lx-mini-panel">
     <div className={`lx-brand-preview lx-bg-${brand}`}><span className="lx-brand-screen"><span className="lx-zoom-row"/><span className="lx-zoom-row lx-short"/></span><span className="lx-brand-logo">toru</span></div>
     <div className="lx-swatches" role="group" aria-label="Background">{(['midnight','ocean','sunset'] as const).map(value=><button key={value} type="button" className={`lx-swatch lx-bg-${value}`} aria-pressed={brand===value} aria-label={value} onClick={()=>setBrand(value)}/>)}</div>
    </div>
   </div>
   <div className="lx-demo-copy"><h3>Your brand, every time</h3><p>Background, logo and cards come from the brand you saved for the product. Pick a background to try it.</p></div>
  </article>
 </div>;
}

/** An agent's own mark, beside its name. */
export function AgentIcon({client,size=16}:{client:Client;size?:number}){return <img className="tl-agent-icon" src={CLIENTS[client].icon} alt="" width={size} height={size}/>;}

/** Setup step one, per agent, with a copy button on every command. */
export function InstallTabs(){
 const [client,setClient]=useState<Client>('claude-code'),[copied,setCopied]=useState<string>();
 async function copy(code:string){try{await navigator.clipboard.writeText(code);setCopied(code);window.setTimeout(()=>setCopied(undefined),1400);}catch{setCopied(undefined);}}
 return <div className="tl-install tl-glass">
  <div className="tl-install-top"><b>Connect your agent</b><div className="tl-segment tl-segment-small" role="tablist" aria-label="Your agent">{(Object.keys(CLIENTS) as Client[]).map(key=><button key={key} type="button" role="tab" aria-selected={key===client} onClick={()=>setClient(key)}><AgentIcon client={key}/>{CLIENTS[key].title}</button>)}</div></div>
  <ol className="tl-cmds">{CLIENTS[client].steps.map(step=><li key={step.text}><span>{step.text}</span>{step.code&&<div className="tl-code"><code>{step.code}</code><button type="button" onClick={()=>copy(step.code!)}>{copied===step.code?'Copied':'Copy'}</button></div>}</li>)}</ol>
 </div>;
}
