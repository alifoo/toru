// Focused release-gate run with the installed Toru app and a disposable local backend.
// Cycle 1: window capture with interaction. Cycle 2: same device, fresh approval, whole display, no new pairing.
// Cycle 3: user closes the recorded window mid-recording → safe stop, local file kept → Retry upload → render.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startRecorder} from '../apps/mcp/dist/index.js';
import {createInvite} from '../apps/mcp/dist/invites.js';
import {createRenderHost,resolveBrowserBinary} from '../packages/render-host/dist/index.js';
const dir=await mkdtemp(join(tmpdir(),'toru-mac-gate-'));
const port=process.env.MAC_PROOF_PORT??'43574',base=`http://127.0.0.1:${port}`;
const evidence=resolve('docs/launch/evidence');await mkdir(evidence,{recursive:true});
Object.assign(process.env,{DATA_DIR:dir,PORT:port,PUBLIC_URL:base,SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),RECORDER_ENVIRONMENT:'local',LOCAL_BROWSER_ENABLED:'1',LOCAL_BROWSER_PAIR_TTL_MS:String(20*60000)});
const host=createRenderHost({browserBinary:await resolveBrowserBinary()});
const service=await startRecorder({runtime:{createContext:async()=>{throw Error('hosted_browser_not_expected');},render:async(sourcePath,config,signal,onProgress)=>{
 const rendered=await host.render({sourcePath,config,signal,onProgress});
 if(rendered.status!=='rendered')throw Error(rendered.reason);return rendered.bytes;
},close:async()=>{}}});
let sequence=0;const say=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const invite=await createInvite(dir,randomUUID());
 const call=async(name,args={})=>{
  const r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${invite.token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}})});
  const body=await r.json();if(body.error||body.result?.isError)throw Error(name+': '+JSON.stringify(body));return body.result.structuredContent;
 };
 const waitReady=async(connectionId,label)=>{for(let i=0;i<1180;i++){if((await call('local_browser_status',{connectionId})).status==='ready')return;await sleep(1000);}assert.fail(label+': approval not received');};
 const waitStatus=async(id,accept)=>{let s;for(let i=0;i<40;i++){s=await call('recording_status',{id,waitMs:25000});if(accept.includes(s.status))return s;if(s.errorCode&&!accept.includes('interrupted'))throw Error(s.errorCode);}return s;};
 const renderAndVerify=async(id,tag)=>{
  await call('recording_render',{id,requestId:randomUUID()});
  const status=await waitStatus(id,['completed']);assert.equal(status.status,'completed');
  const links=await call('recording_links',{id});const video=await fetch(links.videoUrl);assert.equal(video.status,200);
  if(links.previewUrl){const preview=await fetch(links.previewUrl);assert.equal(preview.status,200);await writeFile(join(evidence,`${tag}-2026-10-06.png`),Buffer.from(await preview.arrayBuffer()));}
  const out=join(evidence,`${tag}-2026-10-06.mp4`);await writeFile(out,Buffer.from(await video.arrayBuffer()));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height,codec_name','-of','json',out],{encoding:'utf8'}));
  execFileSync('ffmpeg',['-v','error','-i',out,'-f','null','-'],{stdio:'pipe'});
  say(tag,'MP4 ok',JSON.stringify({id,...probe.streams[0],duration:probe.format.duration}));
 };
 const pair=await call('desktop_recording_pair');
 execFileSync('open',['-n',process.env.TORU_APP??'/Applications/Toru.app','--args','--server',base,'--code',pair.pairingCode]);
 const skip=(process.env.MAC_GATE_SKIP??'').split(',');let id,s;
 if(!skip.includes('1')){
 say('CYCLE 1 — in Toru: Open demo window, Refresh, choose "Toru Capture Demo", approve, Share selected source.');
 await waitReady(pair.connectionId,'cycle 1');
 id=(await call('desktop_recording_open',{connectionId:pair.connectionId,requestId:randomUUID()})).id;
 await call('recording_start',{id});say('CYCLE 1 recording 15 s — click Create demo item a few times.');await sleep(15000);
 s=await call('recording_stop',{id});while(s.status==='stopping')s=await waitStatus(id,['captured','interrupted']);
 assert.equal(s.status,'captured');await renderAndVerify(id,'gate1-window');
 }

 if(!skip.includes('2')){
 const devices=await call('desktop_devices');assert.equal(devices.devices.length,1,'one paired Mac');
 const device=devices.devices[0];assert.equal(device.connectionId,pair.connectionId);
 say('CYCLE 2 — same Mac, no new code. In Toru: Refresh, choose "Entire display …", approve, Share selected source. Keep the demo window visible.');
 await waitReady(pair.connectionId,'cycle 2');
 assert.equal((await call('desktop_devices')).devices[0].status,'ready');
 id=(await call('desktop_recording_open',{connectionId:pair.connectionId,requestId:randomUUID()})).id;
 await call('recording_start',{id});say('CYCLE 2 recording 10 s — move the mouse and click Create demo item.');await sleep(10000);
 s=await call('recording_stop',{id});while(s.status==='stopping')s=await waitStatus(id,['captured','interrupted']);
 assert.equal(s.status,'captured');
 const obs=JSON.parse(await readFile(join(dir,'jobs',id,'observation.json'),'utf8'));say('CYCLE 2 display capture',JSON.stringify({width:obs.width,height:obs.height,durationMs:obs.durationMs}));
 assert.ok(obs.width<=1920&&obs.height<=1080&&obs.width%2===0&&obs.height%2===0,'bounded even dimensions');
 await renderAndVerify(id,'gate3-display');
 }

 say('CYCLE 3 — edge case. In Toru: Refresh, choose a window, approve, Share. When recording starts, close that window (or sleep the display).');
 await waitReady(pair.connectionId,'cycle 3');
 id=(await call('desktop_recording_open',{connectionId:pair.connectionId,requestId:randomUUID()})).id;
 await call('recording_start',{id});say('CYCLE 3 recording — close the demo window now. Waiting up to 60 s for the safe stop.');
 let interrupted;for(let i=0;i<40;i++){const st=await call('recording_status',{id,waitMs:5000});say('CYCLE 3 poll',st.status,st.errorCode??'',st.connectionStatus??'');if(st.status==='interrupted'){interrupted=st;break;}await sleep(2000);}
 assert.ok(interrupted,'backend observed the interrupted session');say('CYCLE 3 backend status',interrupted.status,interrupted.errorCode??'');
 const journal=join(homedir(),'Movies/Toru');const manifests=(await readdir(journal)).filter(f=>f.endsWith('.json'));
 const local=(await Promise.all(manifests.map(async f=>JSON.parse(await readFile(join(journal,f),'utf8'))))).find(m=>m.id.toLowerCase()===id);
 assert.ok(local,'local journal entry for the interrupted capture');assert.equal(local.stage,'saved');assert.ok(local.durationMs>0);
 say('CYCLE 3 local capture kept',JSON.stringify({stage:local.stage,durationMs:local.durationMs}));
 say('CYCLE 3 — in Toru: the capture appears under Local recordings as Saved. Click "Retry upload".');
 let recovered;for(let i=0;i<180;i++){const st=await call('recording_status',{id});if(st.status==='captured'){recovered=st;break;}await sleep(2000);}
 assert.ok(recovered,'retry upload published the capture');await renderAndVerify(id,'gate4-interrupted-recovered');
 say('GATE PASSED: window capture, second recording without re-pairing, display capture, safe stop on window close, retry upload, three decodable MP4s.');
}finally{await service.stop();await rm(dir,{recursive:true,force:true});}
