'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {CLIENTS,type Client} from './agent-setup';
import {AgentIcon} from './landing-interactive';
import {ToruOrb} from './toru-orb';

/** A step of the shot list and the second of the rendered video where it starts. */
type Step={label:string;target?:string;at:number};
type Scene={id:string;tab:string;file:string;place:string;prompt:string;steps:Step[];poster:string;video:string;alt:string};

/**
 * The three demos on the landing, as recorded: each prompt is what the agent was asked, each shot list what it did,
 * and each step starts where it shows in the video.
 */
const scenes:Scene[]=[
 {id:'linear',tab:'Linear',file:'linear-issue-done.mp4',place:'Linear in your Chrome',
  prompt:'Record a demo of our Linear: open “Invite teammates from the empty state”, mark it Done, then create “Ship the changelog video” and end on the issue list.',
  steps:[{label:'Open',target:'Invite teammates from the empty state',at:0},{label:'Set status to',target:'Done',at:7},{label:'Back to',target:'Issues',at:16},{label:'Create',target:'Ship the changelog video',at:17.5},{label:'End on the issue list',at:30}],
  poster:'/landing/linear.jpg',video:'/landing/linear.mp4',alt:'Linear in Chrome: an issue marked Done, then a new issue created'},
 {id:'notion',tab:'Notion',file:'notion-roadmap.mp4',place:'Notion in your Chrome',
  prompt:'Present our Toru page in Notion: the delivery promise, the four steps, then the roadmap, ending on the card “Every video ends on a wide shot”.',
  steps:[{label:'Underline',target:'the delivery promise',at:0},{label:'Sweep',target:'the four steps',at:5},{label:'Read down to',target:'Roadmap',at:7},{label:'Sweep',target:'Complete',at:9.5},{label:'Open',target:'Every video ends on a wide shot',at:14.5},{label:'Point at',target:'Shipped',at:16.5},{label:'Highlight',target:'its description',at:21}],
  poster:'/landing/notion.jpg',video:'/landing/notion.mp4',alt:'Notion in Chrome: a project page read down to its roadmap, and a shipped card opened'},
 {id:'wikipedia',tab:'Wikipedia',file:'wikipedia-screencast.mp4',place:'Wikipedia in your Chrome',
  prompt:'Record a Wikipedia demo: search for “Screencast”, open the article, read down to Uses and highlight what it says about software developers.',
  steps:[{label:'Search for',target:'Screencast',at:0},{label:'Open',target:'the article',at:7.5},{label:'Underline',target:'the title',at:9.5},{label:'Read down to',target:'Uses',at:12.5},{label:'Highlight',target:'the sentence',at:14.5}],
  poster:'/landing/wikipedia.jpg',video:'/landing/wikipedia.mp4',alt:'Wikipedia in Chrome: the Screencast article searched, read and a sentence highlighted'},
];

const clock=(seconds:number)=>`00:${String(Math.floor(seconds)).padStart(2,'0')}`;

/**
 * The hero: Toru's studio playing a real take. The shot list follows the video and a step jumps to it; the settings
 * are the ones these takes were rendered with. The composer starts onboarding.
 */
export function StudioWindow({appUrl}:{appUrl:string}){
 const [sceneId,setSceneId]=useState(scenes[0]!.id);
 const [time,setTime]=useState(0),[duration,setDuration]=useState(0),[playing,setPlaying]=useState(false);
 const video=useRef<HTMLVideoElement>(null);
 const scene=scenes.find(item=>item.id===sceneId)!;
 const current=Math.max(0,scene.steps.findLastIndex(step=>step.at<=time));
 const length=duration||scene.steps.at(-1)!.at+4;

 // Plays while the studio is on screen, unless the viewer asked for less motion; pauses when it scrolls away.
 useEffect(()=>{
  const element=video.current;
  if(!element)return;
  // The metadata can arrive before the page hydrates, and its event with it.
  if(Number.isFinite(element.duration))setDuration(element.duration);
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const observer=new IntersectionObserver(([entry])=>{ if(entry?.isIntersecting)void element.play().catch(()=>undefined); else element.pause(); },{threshold:.2});
  observer.observe(element);
  return ()=>observer.disconnect();
 },[sceneId]);

 const pick=(id:string)=>{setSceneId(id);setTime(0);setDuration(0);};
 const seek=(at:number)=>{ const element=video.current; if(!element)return; element.currentTime=at; setTime(at); void element.play().catch(()=>undefined); };
 const toggle=()=>{ const element=video.current; if(!element)return; if(element.paused)void element.play().catch(()=>undefined); else element.pause(); };

 return <div className="st-stage">
  <section className="st-window" aria-label="Toru studio">
   <div className="st-titlebar">
    <span className="st-lights" aria-hidden="true"><i/><i/><i/></span>
    <span className="st-app"><ToruOrb size={15} still/>toru</span>
    <span className="st-file"><b>{scene.file}</b> — {scene.place}</span>
    <span className="st-status"><i className={playing?'st-blink':''}/>Step {current+1} of {scene.steps.length}</span>
    <span className="st-titlebar-end"><span className="st-mono">recording_run</span></span>
   </div>
   <div className="st-body">
    <aside className="st-panel st-left">
     <div className="st-agent"><AgentIcon client="claude-code" size={15}/><b>Claude Code</b><span className="st-mono">recording_run</span></div>
     <p className="st-prompt">{scene.prompt}</p>
     <p className="st-label"><span>Shot list</span><span>{scene.steps.length} steps</span></p>
     <ol className="st-shots">{scene.steps.map((step,index)=>{
      const state=index<current?'done':index===current?'now':'next';
      return <li key={scene.id+index} className={`st-shot st-${state}`}>
       <button type="button" onClick={()=>seek(step.at)} aria-current={state==='now'?'step':undefined}>
        <span className="st-tick" aria-hidden="true">{state==='done'?'✓':state==='now'?<i/>:null}</span>
        <span className="st-shot-text">{step.label}{step.target&&<> <b>{step.target}</b></>}</span>
        <span className="st-shot-at st-mono">{clock(step.at)}</span>
       </button>
      </li>;})}
     </ol>
     <Composer appUrl={appUrl}/>
    </aside>

    <div className="st-canvas">
     <div className="st-output">
      <video key={scene.id} ref={video} className="st-video" src={scene.video} poster={scene.poster} muted loop playsInline preload="metadata" aria-label={scene.alt}
       onTimeUpdate={event=>setTime(event.currentTarget.currentTime)} onDurationChange={event=>setDuration(event.currentTarget.duration)}
       onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}/>
      <div className="st-panel st-timeline">
       <div className="st-timeline-top">
        <button type="button" className="st-play" onClick={toggle} aria-label={playing?'Pause':'Play'}>
         {playing?<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>:<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>}
        </button>
        <span className="st-mono"><b>{clock(time)}</b> / {clock(length)}</span>
        <span className="st-timeline-note">Rendered by Toru · delivery check passed</span>
       </div>
       <div className="st-track">
        {scene.steps.map((step,index)=>{
         const end=scene.steps[index+1]?.at??length;
         return <button key={scene.id+index} type="button" style={{flexGrow:Math.max(.5,end-step.at)}} className={index<current?'st-clip-done':index===current?'st-clip-now':''} onClick={()=>seek(step.at)} aria-label={`Jump to: ${step.label}${step.target?` ${step.target}`:''}`}/>;
        })}
        <i className="st-playhead" style={{left:`${Math.min(100,time/length*100)}%`}} aria-hidden="true"/>
       </div>
      </div>
     </div>
    </div>

    <aside className="st-panel st-inspector" aria-label="How this take was made">
     <div className="st-insp-head"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/></svg><b>This take</b><span>Toru for Chrome</span></div>
     <div className="st-insp"><p>Background</p><span className="st-insp-value"><i className="st-swatch st-bg-mist" aria-hidden="true"/>Mist, a thin frame</span></div>
     <div className="st-insp"><p>Camera</p><span className="st-insp-note">Zooms to 2× on each click, highlight and list it runs down, and ends on a still wide shot.</span></div>
     <div className="st-insp"><p>Cursor</p><span className="st-insp-note">A hand-like cursor that rests on each target before it presses.</span></div>
     <div className="st-insp"><p>Output</p><span className="st-insp-value st-mono">2560 × 1440 · MP4 + GIF</span><span className="st-insp-note">Pauses cut. Scrolls stay smooth.</span></div>
     <div className="st-insp"><p>Delivery check</p><span className="st-insp-note">Passed. A blank, frozen or badly framed take is held back and not charged.</span></div>
    </aside>
   </div>
  </section>
  <div className="st-tabs" role="tablist" aria-label="Demos recorded with Toru">{scenes.map(item=><button key={item.id} type="button" role="tab" aria-selected={item.id===sceneId} onClick={()=>pick(item.id)}>{item.tab}</button>)}</div>
 </div>;
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
