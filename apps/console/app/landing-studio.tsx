'use client';
import {useState,type FormEvent} from 'react';
import {CLIENTS,type Client} from './agent-setup';
import {AgentIcon} from './landing-interactive';
import {ToruOrb} from './toru-orb';

type Step={label:string;target?:string;expect?:string};
type Scene={id:string;tab:string;title:string;place:string;tool:string;prompt:string;steps:Step[];current:number;
 poster:string;video:string;length:string;alt:string;cursor:[number,number];camera:[number,number];card?:boolean};

/** The three things the hero window can show. Prompts and recordings are real Toru recordings from the landing set. */
const scenes:Scene[]=[
 {id:'mac',tab:'Mac app',title:'linear-csv-export',place:'Linear on your Mac',tool:'desktop_recording_run',
  prompt:'Record a demo of our Linear on my Mac: mark “CSV export times out on large workspaces” as Done, go back to the issues and create “Record the launch video”.',
  steps:[{label:'Open',target:'Issues'},{label:'Open',target:'CSV export times out…'},{label:'Set status to',target:'Done',expect:'the issue moves to Done'},{label:'Back to',target:'Issues'},{label:'Create',target:'Record the launch video'},{label:'End on the new issue'}],current:2,
  poster:'/landing/linear.jpg',video:'/landing/linear.mp4',length:'00:34',alt:'Linear on a Mac: an issue marked Done, then a new issue created',cursor:[19,22],camera:[2,6]},
 {id:'chrome',tab:'Web app in your Chrome',title:'notion-roadmap',place:'Notion in your Chrome',tool:'recording_run',
  prompt:'Record the new roadmap flow on our Notion: open the Roadmap, switch to the sprint board and open the first card.',
  steps:[{label:'Open',target:'Roadmap'},{label:'Switch to',target:'By sprint',expect:'the sprint board shows'},{label:'Open the first card'},{label:'End on the card'}],current:1,
  poster:'/landing/notion.jpg',video:'/landing/notion.mp4',length:'00:11',alt:'Notion in Chrome: the roadmap switched to the sprint board and a card opened',cursor:[15,35],camera:[2,14]},
 {id:'brand',tab:'Your brand',title:'Brand · linear.app',place:'saved once, used on every demo',tool:'brand',
  prompt:'Colors, background, padding, a logo, intro and outro cards, a GIF and the output size, saved per product domain. Your agent never has to ask.',
  steps:[{label:'Background',target:'Sky'},{label:'Padding',target:'64 px'},{label:'Logo',target:'corner mark'},{label:'Intro card',target:'title before the flow'},{label:'Outro card',target:'call to action'},{label:'Output',target:'MP4 and GIF'}],current:3,
  poster:'/landing/linear.jpg',video:'/landing/linear.mp4',length:'00:34',alt:'An intro card in the brand saved for linear.app',cursor:[0,0],camera:[0,0],card:true},
];
const backgrounds=['sky','aurora','mint','peach','mist','ocean'] as const;
type Background=typeof backgrounds[number];
const widths=[1280,1920,2560] as const;

/** The hero: Toru's studio, drawn from what a real run shows. Its controls work; the composer starts onboarding. */
export function StudioWindow({appUrl}:{appUrl:string}){
 const [sceneId,setSceneId]=useState(scenes[0]!.id),[playing,setPlaying]=useState(false);
 const [background,setBackground]=useState<Background>('sky'),[width,setWidth]=useState<typeof widths[number]>(1920);
 const [zoom,setZoom]=useState(true),[glide,setGlide]=useState(true),[gif,setGif]=useState(true);
 const scene=scenes.find(item=>item.id===sceneId)!;
 const pick=(id:string)=>{setSceneId(id);setPlaying(false);};
 const brand=scene.id==='brand';
 return <div className="st-stage">
  <section className="st-window" aria-label="Toru studio">
   <div className="st-titlebar">
    <span className="st-lights" aria-hidden="true"><i/><i/><i/></span>
    <span className="st-app"><ToruOrb size={15} still/>toru</span>
    <span className="st-file"><b>{scene.title}</b> — {scene.place}</span>
    {brand?<span className="st-status st-status-brand">Every demo of this product</span>:<span className="st-status"><i className="st-blink"/>Recording · step {scene.current+1} of {scene.steps.length}</span>}
    <span className="st-titlebar-end"><span>Brand · {brand?'linear.app':'Toru Team'}</span><span className="st-mono">{scene.tool}</span></span>
   </div>
   <div className="st-body">
    <aside className="st-panel st-left">
     <div className="st-agent"><AgentIcon client="claude-code" size={15}/><b>Claude Code</b><span className="st-mono">{brand?'saved brand':scene.tool}</span></div>
     <p className="st-prompt">{scene.prompt}</p>
     <p className="st-label"><span>{brand?'Brand':'Shot list'}</span><span>{scene.steps.length} {brand?'settings':'steps'}</span></p>
     <ol className="st-shots">{scene.steps.map((raw,index)=>{
      const step=brand&&raw.label==='Background'?{...raw,target:background[0]!.toUpperCase()+background.slice(1)}:raw;
      const state=index<scene.current?'done':index===scene.current?'now':'next';
      return <li key={step.label+index} className={`st-shot st-${state}`}><span className="st-tick" aria-hidden="true">{state==='done'?'✓':state==='now'?<i className="st-blink"/>:null}</span>
       <span className="st-shot-text">{step.label}{step.target&&<> <b>{step.target}</b></>}{state==='now'&&step.expect&&<small className="st-mono">expect · {step.expect}</small>}</span></li>;})}
     </ol>
     <Composer appUrl={appUrl}/>
    </aside>

    <div className="st-canvas">
     <div className="st-tools" aria-hidden="true">
      <span className="st-tool st-tool-on"><svg viewBox="0 0 24 24"><path d="M5 3l6 16 2.5-6.5L20 10z"/></svg></span>
      <span className="st-tool"><svg viewBox="0 0 24 24"><path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3"/><circle cx="12" cy="12" r="3"/></svg></span>
      <span className="st-tool"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8v6M8 11h6"/></svg></span>
      <span className="st-tool"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10h8M10 14h4"/></svg></span>
      <span className="st-tool"><svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5L20 18M8 16.5L20 6"/></svg></span>
     </div>
     <div className="st-output">
      <p className="st-output-label"><span>Output · {width} × {width*9/16}</span><span>{gif?'MP4 + GIF':'MP4'}</span></p>
      <div className={`st-frame st-bg-${background}`}>
       <div className="st-shot-wrap">
        {brand
         ?<div className="st-card"><span>Toru Team · Linear</span><b>Record the launch video</b></div>
         :playing
          ?<video key={scene.video} src={scene.video} poster={scene.poster} autoPlay muted playsInline controls aria-label={scene.alt}/>
          :<>
            <img src={scene.poster} alt={scene.alt} width={1280} height={720}/>
            {zoom&&<span key={`cam-${scene.id}`} className="st-camera" style={{left:`${scene.camera[0]}%`,top:`${scene.camera[1]}%`}} aria-hidden="true"><i/><i/><i/><i/><em>Camera · 2.0×</em></span>}
            <span key={`cur-${scene.id}`} className={`st-cursor${glide?'':' st-cursor-still'}`} style={{left:`${scene.cursor[0]}%`,top:`${scene.cursor[1]}%`}} aria-hidden="true">
             <i className="st-ripple"/>
             <svg viewBox="0 0 24 24"><path d="M4 2.5l.1 17.2 4.6-4.4 3.1 6.9 3-1.3-3.1-6.8 6.4-.3z"/></svg>
             <em>Navigator · Claude Code</em>
            </span>
           </>}
       </div>
      </div>
      <div className="st-panel st-timeline">
       <div className="st-timeline-top">
        <button type="button" className="st-play" onClick={()=>setPlaying(!playing)} disabled={brand} aria-label={playing?'Back to the recording view':`Play the rendered ${scene.length.replace('00:','')} s demo`}>
         {playing?<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>:<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>}
        </button>
        {brand?<span className="st-mono">Intro card <b>before the flow</b></span>:<span className="st-mono">{playing?'Rendered':'REC'} <b>{playing?scene.length:'00:11'}</b> / {scene.length}</span>}
        <span className="st-timeline-note">{brand?'Applied to every demo of linear.app':playing?'Delivery check passed':'Pauses cut · a zoom on every click'}</span>
       </div>
       <div className="st-track" aria-hidden="true">{scene.steps.map((step,index)=><span key={index} className={index<scene.current?'st-clip-done':index===scene.current?'st-clip-now':''}/>)}<i className={brand?'':'st-playhead'} style={{left:`${(scene.current+.4)/scene.steps.length*100}%`}}/></div>
      </div>
     </div>
    </div>

    <aside className="st-panel st-inspector" aria-label="Output settings">
     <div className="st-insp-head"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/></svg><b>Output frame</b><span>{brand||scene.id==='mac'?'linear.app':'notion.so'}</span></div>
     <div className="st-insp">
      <p>Background</p>
      <div className="st-swatches" role="group" aria-label="Background">{backgrounds.map(value=><button key={value} type="button" className={`st-bg-${value}`} aria-pressed={background===value} aria-label={value} onClick={()=>setBackground(value)}/>)}</div>
      <div className="st-fields st-mono"><span><em>Pad</em>64</span><span><em>Radius</em>14</span></div>
     </div>
     <div className="st-insp">
      <p>Camera</p>
      <Toggle label="Zoom on every click" on={zoom} set={setZoom}/>
     </div>
     <div className="st-insp">
      <p>Cursor</p>
      <Toggle label="Smooth the pointer's travel" on={glide} set={setGlide}/>
      <span className="st-insp-note">Rests on each target before it presses.</span>
     </div>
     <div className="st-insp">
      <p>Output</p>
      <div className="st-seg st-mono" role="group" aria-label="Width">{widths.map(value=><button key={value} type="button" aria-pressed={width===value} onClick={()=>setWidth(value)}>{value}</button>)}</div>
      <div className="st-checks"><span className="st-check st-check-on">MP4</span><button type="button" className={`st-check${gif?' st-check-on':''}`} aria-pressed={gif} onClick={()=>setGif(!gif)}>GIF</button></div>
     </div>
     <div className="st-insp">
      <p>Delivery check</p>
      <span className="st-insp-note">A blank, frozen or too-short take is held back and not charged.</span>
     </div>
    </aside>
   </div>
  </section>
  <div className="st-tabs" role="tablist" aria-label="What Toru records">{scenes.map(item=><button key={item.id} type="button" role="tab" aria-selected={item.id===sceneId} onClick={()=>pick(item.id)}>{item.tab}</button>)}</div>
 </div>;
}

function Toggle({label,on,set}:{label:string;on:boolean;set:(value:boolean)=>void}){
 return <label className="st-toggle"><span>{label}</span><input type="checkbox" checked={on} onChange={event=>set(event.target.checked)}/><i aria-hidden="true"/></label>;
}

/** The studio's composer: the same ask as before. Its text and the chosen agent ride into onboarding. */
function Composer({appUrl}:{appUrl:string}){
 const [flow,setFlow]=useState(''),[client,setClient]=useState<Client>('claude-code'),[hint,setHint]=useState(false);
 function submit(event:FormEvent){
  event.preventDefault();
  if(!flow.trim()){setHint(true);return;}
  window.location.assign(`${appUrl}/onboarding?client=${client}&flow=${encodeURIComponent(flow.trim().slice(0,600))}`);
 }
 return <form className="st-composer" onSubmit={submit}>
  <label htmlFor="st-flow">Your demo</label>
  <textarea id="st-flow" rows={2} value={flow} onChange={event=>{setFlow(event.target.value);setHint(false);}} placeholder="Record our billing page: switch to the annual plan and end on the receipt."/>
  {hint&&<p className="st-hint" role="status">Write what you want recorded first.</p>}
  <div className="st-composer-row">
   <div className="st-pick" role="radiogroup" aria-label="Your agent">{(Object.keys(CLIENTS) as Client[]).map(key=><button key={key} type="button" role="radio" aria-checked={key===client} aria-label={key==='other'?'Other MCP client':CLIENTS[key].title} title={key==='other'?'Other MCP client':CLIENTS[key].title} onClick={()=>setClient(key)}><AgentIcon client={key} size={15}/></button>)}</div>
   <button type="submit" className="primary st-send" data-cta="hero-ask"><span className="record-dot" aria-hidden="true"/>Start free</button>
  </div>
 </form>;
}

type Take={id:string;name:string;meta:string;poster:string;video:string;alt:string;background:Background;size:'lg'|'md'|'sm'};
const takes:Take[]=[
 {id:'linear',name:'linear-issue-done.mp4',meta:'Mac · 34 s',poster:'/landing/linear.jpg',video:'/landing/linear.mp4',alt:'Linear on a Mac: an issue marked Done, then a new issue created',background:'sky',size:'lg'},
 {id:'notion',name:'notion-roadmap.gif',meta:'Chrome · 11 s',poster:'/landing/notion.jpg',video:'/landing/notion.mp4',alt:'Notion in Chrome: the roadmap switched to the sprint board',background:'mint',size:'md'},
 {id:'todo',name:'todomvc-add.mp4',meta:'Chrome · 35 s',poster:'/landing/route-chrome.jpg',video:'/landing/route-chrome.mp4',alt:'TodoMVC in Chrome: a todo typed and added',background:'peach',size:'md'},
 {id:'skills',name:'toru-skills-readme.mp4',meta:'Mac · 33 s',poster:'/landing/route-mac.jpg',video:'/landing/route-mac.mp4',alt:'An editor on a Mac: the Toru skills README',background:'mist',size:'sm'},
];

/** Finished demos on a light table. A recording loads only when someone presses play. */
export function ContactSheet(){
 const [playing,setPlaying]=useState<string>();
 return <div className="st-sheet">
  {takes.map(take=><figure key={take.id} className={`st-take st-take-${take.size}`}>
   <figcaption><b>{take.name}</b><span>{take.meta}</span></figcaption>
   <div className={`st-frame st-bg-${take.background}`}>
    <div className="st-shot-wrap">
     {playing===take.id
      ?<video src={take.video} poster={take.poster} autoPlay muted playsInline controls aria-label={take.alt}/>
      :<><img src={take.poster} alt={take.alt} width={1280} height={720} loading="lazy"/><button type="button" className="st-take-play" onClick={()=>setPlaying(take.id)}><span>Play</span></button></>}
    </div>
   </div>
  </figure>)}
  <figure className="st-take st-take-sm">
   <figcaption><b>Intro card</b><span>Toru Team</span></figcaption>
   <div className="st-frame st-bg-ocean"><div className="st-card"><span>Toru Team · Linear</span><b>Record the launch video</b></div></div>
  </figure>
  <figure className="st-take st-take-sm st-take-held">
   <figcaption><b>take-02 · frozen</b><span>held back, not charged</span></figcaption>
   <div className="st-held" aria-label="A frozen take, held back by the delivery check"><span>Held by the delivery check</span></div>
  </figure>
 </div>;
}
