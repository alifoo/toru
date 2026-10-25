// Jev operates a Mac window end to end: local MCP + Jev → Toru for Mac (dev build) → TextEdit → render.
//
//   TYPESAFE_API_KEY=… node scripts/smoke-macos-control.mjs
//
// Needs: `TORU_BUNDLE_ID=tools.toru.mac.dev apps/macos/build.sh`, `defaults write tools.toru.mac.dev allowControl -bool true`,
// a terminal with Accessibility and Screen Recording (the app is started from it and inherits both), and a
// TextEdit window titled MAC_TARGET (default toru-test.rtf). The "Share" click in the app is made through
// Accessibility by this script, as a stand-in for the user's one-time consent.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startRecorder} from '../apps/mcp/dist/index.js';
import {createInvite} from '../apps/mcp/dist/invites.js';
import {createRenderHost,resolveBrowserBinary} from '../packages/render-host/dist/index.js';

assert.ok(process.env.TYPESAFE_API_KEY,'TYPESAFE_API_KEY is required for Jev');
const ax=resolve('apps/macos/build/toru-ax');
const appBinary=resolve(process.env.TORU_APP??'apps/macos/build/Toru.app','Contents/MacOS/Toru');
const target=process.env.MAC_TARGET??'toru-test.rtf';
const values=JSON.parse(process.env.MAC_VALUES??'{"text entry area":"Recorded by Toru"}');
// The plan an agent writes from the app before asking Toru (required by desktop_recording_run).
const plan=JSON.parse(process.env.MAC_PLAN??JSON.stringify({steps:[
 {screen:'toru-test.rtf window',action:'type',target:'field "text entry area"',value:'Recorded by Toru',expect:'The sentence appears on a new line, selected'},
 {screen:'toru-test.rtf window',action:'click',target:'checkbox "bold"',expect:'The sentence turns bold'},
 {screen:'toru-test.rtf window',action:'click',target:'checkbox "align center"',expect:'The sentence is centered'}],
 finalState:'"Recorded by Toru" is visible in bold and centered'}));
const goal=process.env.MAC_GOAL??'In the TextEdit document, type the sentence "Recorded by Toru" at the end, then make the text bold and center it.';
const dir=await mkdtemp(join(tmpdir(),'toru-mac-control-'));
// A fresh port each run: the app keeps one Keychain item per server, and a rebuilt app may not read an old one.
const port=process.env.MAC_PROOF_PORT??String(43600+Math.floor(Math.random()*300)),base=`http://127.0.0.1:${port}`;
Object.assign(process.env,{DATA_DIR:dir,PORT:port,PUBLIC_URL:base,SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),RECORDER_ENVIRONMENT:'local',LOCAL_BROWSER_ENABLED:'1',LOCAL_BROWSER_PAIR_TTL_MS:String(20*60000)});
const host=createRenderHost({browserBinary:await resolveBrowserBinary()});
const service=await startRecorder({runtime:{createContext:async()=>{throw Error('hosted_browser_not_expected');},render:async(sourcePath,config,signal,onProgress)=>{
 const rendered=await host.render({sourcePath,config,signal,onProgress});
 if(rendered.status!=='rendered')throw Error(rendered.reason);return rendered.bytes;
},close:async()=>{}}});
let app,sequence=0;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const json=(args)=>JSON.parse(execFileSync(ax,args,{encoding:'utf8'}));
try{
 const invite=await createInvite(dir,randomUUID());
 const call=async(name,args={})=>{
  const r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${invite.token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}})});
  const body=await r.json();if(body.error||body.result?.isError)throw Error(name+': '+JSON.stringify(body).slice(0,600));return body.result.structuredContent;
 };
 const pair=await call('desktop_recording_pair');
 app=spawn(appBinary,['--server',base,'--code',pair.pairingCode,'--pair'],{env:{...process.env,TORU_CONTROL_LOG:'1'},stdio:['ignore','ignore',(await import('node:fs')).openSync(process.env.MAC_APP_LOG??'/tmp/toru-mac-control-app.log','w')]});
 // Keep the user's main screen free: with AeroSpace, send the app's window to another workspace.
 const workspace=process.env.MAC_AEROSPACE_WORKSPACE;
 const park=()=>{if(!workspace)return;try{for(const line of execFileSync('aerospace',['list-windows','--all','--format','%{window-id}|%{app-pid}|%{workspace}'],{encoding:'utf8'}).trim().split('\n')){const [id,pid,space]=line.split('|');if(Number(pid)===app.pid&&space!==workspace)execFileSync('aerospace',['move-node-to-workspace','--window-id',id,workspace]);}}catch{}};
 // The user's one-time consent: Share in the main window, or Pair in the floating bar and then in its popover.
 let shared=false;const clicked=new Set();
 for(let i=0;i<60&&!shared;i++){
  await wait(1000);park();
  if((await call('desktop_devices')).devices.some(d=>d.connectionId===pair.connectionId&&d.status!=='offline')){shared=true;break;}
  for(const window of json(['windows','--all','--layers']).filter(w=>w.pid===app.pid&&!clicked.has(w.windowID))){
   let read;try{read=json(['outline',String(window.windowID)]);}catch{continue;}
   const share=/\[(ref_\d+)\] button "(Share selected source|Pair|Connect)"(?! disabled)/.exec(read.outline);
   if(share){execFileSync(ax,['act',String(window.windowID),'click',share[1]]);clicked.add(window.windowID);break;}
  }
 }
 assert.ok(shared,'Share button not reachable in the app');
 let device;
 for(let i=0;i<60;i++){device=(await call('desktop_devices')).devices.find(d=>d.connectionId===pair.connectionId);if(device?.status==='ready')break;await wait(1000);}
 assert.equal(device?.status,'ready');assert.equal(device.control,true,'the app must declare control');console.log('MAC_CONNECTED control=true');
 const listed=await call('desktop_sources',{connectionId:pair.connectionId});
 const wanted=listed.sources.find(s=>s.title.includes(target));
 assert.ok(wanted,`no source titled ${target}: ${listed.sources.map(s=>s.title).join(' | ')}`);
 await call('desktop_select_source',{connectionId:pair.connectionId,sourceId:wanted.id});console.log('SOURCE',wanted.title);
 const run=await call('desktop_recording_run',{connectionId:pair.connectionId,requestId:randomUUID(),goal,plan,values,maximumActions:Number(process.env.MAC_MAX_ACTIONS??8),...(process.env.MAC_RENDER?{render:JSON.parse(process.env.MAC_RENDER)}:{})});
 let status=run;
 const answered=new Set();
 for(let i=0;i<40&&!['done','failed','needs_review'].includes(status.status);i++){
  // The navigator asks for a value it cannot match to a field label: answer with the value the plan gave, like an agent would.
  if(status.status==='needs_input'&&status.input?.inputId&&!answered.has(status.input.inputId)){answered.add(status.input.inputId);
   console.log('INPUT',JSON.stringify(status.input));
   const guided=await call('navigation_guide',{id:status.sessionId,instruction:'Use the value from the plan.',inputId:status.input.inputId,value:Object.values(values)[0]??''}).catch(error=>{if(!/navigation_input_stale/.test(String(error)))throw error;return {stale:true};});
   console.log('GUIDED',JSON.stringify(guided).slice(0,300));}
  status=await call('recording_run_status',{runId:run.runId,waitMs:25000});console.log('RUN',status.status,status.actions??'',status.reason??'');}
 assert.ok(['done','needs_review'].includes(status.status),'run ended '+JSON.stringify(status).slice(0,400));
 const links=await call('recording_links',{id:status.sessionId});
 const output='/tmp/toru-desktop-control.mp4';
 const response=await fetch(links.videoUrl);assert.equal(response.status,200);await writeFile(output,Buffer.from(await response.arrayBuffer()));
 console.log('PROOF_VIDEO',output,JSON.stringify(links.qualityReview?.metrics??{}));
 console.log(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height,codec_name','-of','compact',output],{encoding:'utf8'}));
}finally{
 app?.kill('SIGTERM');await service.stop();await rm(dir,{recursive:true,force:true});
 try{execFileSync('security',['delete-generic-password','-s','tools.toru.mac.dev.device','-a',base],{stdio:'ignore'});}catch{}
}
