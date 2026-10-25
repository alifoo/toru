// Native Mac app → real MCP → existing render/export, using only the built-in demo window.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startRecorder} from '../apps/mcp/dist/index.js';
import {createInvite} from '../apps/mcp/dist/invites.js';
import {createRenderHost,resolveBrowserBinary} from '../packages/render-host/dist/index.js';
const dir=await mkdtemp(join(tmpdir(),'toru-mac-proof-'));
const port=process.env.MAC_PROOF_PORT??'43574',base=`http://127.0.0.1:${port}`;
Object.assign(process.env,{DATA_DIR:dir,PORT:port,PUBLIC_URL:base,SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),RECORDER_ENVIRONMENT:'local',LOCAL_BROWSER_ENABLED:'1',LOCAL_BROWSER_PAIR_TTL_MS:String(20*60000)});
const host=createRenderHost({browserBinary:await resolveBrowserBinary()});
const service=await startRecorder({runtime:{createContext:async()=>{throw Error('hosted_browser_not_expected');},render:async(sourcePath,config,signal,onProgress)=>{
 const rendered=await host.render({sourcePath,config,signal,onProgress});
 if(rendered.status!=='rendered')throw Error(rendered.reason);return rendered.bytes;
},close:async()=>{}}});
let sequence=0;
try{
 const invite=await createInvite(dir,randomUUID());
 const call=async(name,args={})=>{
  const r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${invite.token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}})});
  const body=await r.json();if(body.error||body.result?.isError)throw Error(name+': '+JSON.stringify(body));return body.result.structuredContent;
 };
 const pair=await call('desktop_recording_pair');
 execFileSync('open',['-n',process.env.TORU_APP??resolve('apps/macos/build/Toru.app'),'--args','--server',base,'--code',pair.pairingCode]);
 console.log('APP_OPENED: Open demo window, Refresh sources, choose Toru Capture Demo, approve upload, Share selected source.');
 let ready=false;
 for(let i=0;i<1180;i++){if((await call('local_browser_status',{connectionId:pair.connectionId})).status==='ready'){ready=true;break;}await new Promise(r=>setTimeout(r,1000));}
 assert.ok(ready,'App consent not received before pairing expiry');
 if(process.env.MAC_SELECT){
  // Agent-driven source choice: list what the Mac can record and pick the window whose title contains MAC_SELECT.
  const listed=await call('desktop_sources',{connectionId:pair.connectionId});
  const wanted=listed.sources.find(s=>s.title.includes(process.env.MAC_SELECT));
  assert.ok(wanted,'source matching MAC_SELECT listed by the Mac');
  const chosen=await call('desktop_select_source',{connectionId:pair.connectionId,sourceId:wanted.id});
  assert.equal(chosen.selected,wanted.id);console.log('SOURCE_SELECTED',JSON.stringify({id:wanted.id,title:wanted.title,width:wanted.width,height:wanted.height}));
 }
 const opened=await call('desktop_recording_open',{connectionId:pair.connectionId,requestId:randomUUID()});const id=opened.id;
 await call('recording_start',{id});console.log('RECORDING: 15 seconds; click Create demo item in the native demo window.');
 await new Promise(r=>setTimeout(r,15000));
 let captured=await call('recording_stop',{id});
 for(let i=0;captured.status==='stopping'&&i<12;i++)captured=await call('recording_status',{id,waitMs:25000});
 assert.equal(captured.status,'captured');console.log('CAPTURE_UPLOADED');
 const obs=JSON.parse(await readFile(join(dir,'jobs',id,'observation.json'),'utf8'));
 console.log('CAPTURE_METADATA',JSON.stringify({width:obs.width,height:obs.height,durationMs:obs.durationMs}));
 await call('recording_render',{id,requestId:randomUUID()});
 let status;
 for(let i=0;i<24;i++){status=await call('recording_status',{id,waitMs:25000});console.log('RENDER',status.status);if(status.status==='completed')break;if(status.errorCode)throw Error(status.errorCode);}
 assert.equal(status.status,'completed');const links=await call('recording_links',{id});
 const response=await fetch(links.videoUrl);assert.equal(response.status,200);
 const output='/tmp/toru-macos-proof.mp4';await writeFile(output,Buffer.from(await response.arrayBuffer()));
 const preview=await fetch(links.previewUrl);assert.equal(preview.status,200);await writeFile('/tmp/toru-macos-proof.png',Buffer.from(await preview.arrayBuffer()));
 console.log('PROOF_VIDEO',output);
 console.log(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,size:stream=width,height,codec_name,r_frame_rate','-of','json',output],{encoding:'utf8'}));
 execFileSync('ffmpeg',['-v','error','-i',output,'-f','null','-'],{stdio:'pipe'});
 console.log('DECODE_OK');
}finally{await service.stop();await rm(dir,{recursive:true,force:true});}
