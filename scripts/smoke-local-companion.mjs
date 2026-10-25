// Real local Chrome + outbound companion + MCP + Jev + render. Synthetic fixture only.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startRecorder} from '../apps/mcp/dist/index.js';
import {createInvite} from '../apps/mcp/dist/invites.js';
import {runCompanion} from '../apps/mcp/dist/companion.js';
const fixture=process.env.PRODUCT_FIXTURE_URL;
if(!fixture||!process.env.PRODUCT_FIXTURE_PASSWORD)throw Error('Synthetic HTTPS fixture URL and password required');
const dir=await mkdtemp(join(tmpdir(),'toru-local-proof-'));
const output=process.env.LOCAL_PROOF_OUTPUT??'/tmp/toru-local-browser-proof.mp4';
Object.assign(process.env,{DATA_DIR:dir,PORT:'43572',PUBLIC_URL:'http://127.0.0.1:43572',SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),RECORDER_ENVIRONMENT:'local',LOCAL_BROWSER_ENABLED:'1',CHROMEDRIVER_PORT:'43573'});
// The real Jev proof spends the operator's own TypeSafe budget; the key comes from the environment only.
if(!process.env.TYPESAFE_API_KEY)throw Error('TYPESAFE_API_KEY is required for the real Jev proof');
const service=await startRecorder();const abort=new AbortController();let companion;
try{
 const invite=await createInvite(dir,randomUUID());let request=0;
 const call=async(name,args={})=>{
  if(name!=='local_browser_status')console.log('MCP_CALL',name);
  const response=await fetch(process.env.PUBLIC_URL+'/mcp',{method:'POST',headers:{authorization:`Bearer ${invite.token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++request,method:'tools/call',params:{name,arguments:args}})});
  const body=await response.json();if(body.error||body.result?.isError)throw Error(name+': '+JSON.stringify(body));return body.result.structuredContent;
 };
 const pair=await call('local_browser_pair',{url:fixture+'/login'});
 let consentComplete=false;
 companion=runCompanion({server:process.env.PUBLIC_URL,code:pair.pairingCode,signal:abort.signal,consent:async(_url,browser)=>{
  assert.equal((await call('local_browser_status',{connectionId:pair.connectionId})).status,'waiting_for_local_sign_in');
  // This synthetic credential is typed entirely on the local side, never through MCP.
  await new Promise(r=>setTimeout(r,1500));
  const page=await browser.readPage();

  if(page.includes('Visit Site')){
   const ref=page.split('\n').find(line=>line.includes('Visit Site'))?.match(/ref_\d+/)?.[0];
   assert.ok(ref);await browser.pointer('left_click',{type:'ref',ref});await new Promise(r=>setTimeout(r,1000));await browser.goto(fixture+'/login');
  }
  for(let i=0;i<50;i++){if(await browser.transport.request('POST',browser.basePath+'/execute/sync',{script:'return !!document.querySelector("input[type=password]")',args:[]}))break;await new Promise(r=>setTimeout(r,100));}
  await browser.transport.request('POST',browser.basePath+'/execute/sync',{script:"const f=document.querySelector('form');f.querySelector('input[type=password]').value=arguments[0];f.submit();return true;",args:[process.env.PRODUCT_FIXTURE_PASSWORD]});
  for(let i=0;i<50;i++){if((await browser.currentUrl()).endsWith('/sheets'))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok((await browser.currentUrl()).endsWith('/sheets'));
  consentComplete=true;console.log('LOCAL_LOGIN_OK (no credentials sent to MCP)');
 }});
 let companionError;companion.catch(error=>{companionError=error;console.log('COMPANION_ERROR',error.message);});
 for(let i=0;i<150;i++){
  if(companionError)throw companionError;
  if((await call('local_browser_status',{connectionId:pair.connectionId})).status==='ready')break;
  await new Promise(r=>setTimeout(r,200));
 }
 assert.ok(consentComplete);
 const opened=await call('session_open',{url:fixture,localConnectionId:pair.connectionId,requestId:randomUUID()});const id=opened.id;
 const before=await call('browser_observe',{id,mode:'outline'});assert.ok(before.page.includes('New sheet name'));
 await call('recording_start',{id});
 await call('navigation_start',{id,requestId:randomUUID(),goal:'Create a new sheet named Local browser proof. Stop when the new sheet exists and its page is visible.',guidance:'Type Local browser proof into New sheet name, then click Create sheet. The fixture contains only synthetic data.',maximumActions:6});
 let nav;
 for(let i=0;i<15;i++){
  nav=await call('navigation_status',{id,waitMs:25000});console.log('JEV_STATUS',JSON.stringify({status:nav.status,actions:nav.actions,reason:nav.reason,costUsd:nav.costUsd}));
  if(nav.status==='needs_input'){await call('navigation_guide',{id,inputId:nav.input.inputId,value:'Local browser proof',instruction:'Use this as the new sheet name.'});continue;}
  if(!['running','queued'].includes(nav.status))break;
 }
 const observed=await call('browser_observe',{id,mode:'outline'});assert.ok(observed.page.includes('Find people for this sheet'), 'Jev did not create sheet');assert.match(new URL(observed.url).pathname,/^\/sheets\/\d+$/);
 await call('mark_demo_moment',{id,kind:'result',note:'Sheet created locally'});
 await call('browser_wait',{id,ms:4000,until:'duration'});
 await call('recording_stop',{id});console.log('CAPTURED');
 const observation=JSON.parse(await readFile(join(dir,'jobs',id,'observation.json'),'utf8'));
 console.log('CAPTURE_METADATA',JSON.stringify({width:observation.width,height:observation.height,durationMs:observation.durationMs,pointerSamples:observation.pointerTelemetry.length,semanticActions:observation.semanticTimeline.length}));
 await call('recording_render',{id,requestId:randomUUID()});
 let status;
 for(let i=0;i<24;i++){status=await call('recording_status',{id,waitMs:25000});console.log('RENDER_STATUS',status.status);if(status.status==='completed')break;if(status.errorCode)throw Error(status.errorCode);}
 assert.equal(status.status,'completed');const links=await call('recording_links',{id});
 const video=await fetch(links.videoUrl);assert.equal(video.status,200);await writeFile(output,Buffer.from(await video.arrayBuffer()));
 console.log('PROOF_VIDEO',output);console.log(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,size','-of','json',output],{encoding:'utf8'}));
 await companion;
}catch(error){console.error('PROOF_FAILED',error);throw error;}finally{abort.abort();await companion?.catch(()=>undefined);await service.stop();await rm(dir,{recursive:true,force:true});}
