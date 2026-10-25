// One focused local acceptance: external MCP client -> SQL/queue -> isolated browser -> offline render -> MP4.
// Synthetic account and public Selenium fixture only. Docker containers/networks and media are disposable.
import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {createServer} from 'node:net';
import {connect} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startRecorder} from '@agent-recorder/mcp';
import {createHostedLifecycle} from '@agent-recorder/hosted-policy/dist/adapter.js';
import {createWorkerBackedRuntime} from '../dist/remote-runtime.js';

const image=process.env.RECORDER_TEST_IMAGE??'agent-recorder:remote-e2e';
const profile=process.env.RECORDER_TEST_SECCOMP??'/tmp/recorder-seccomp-egress-candidate.json';
const suffix=randomBytes(5).toString('hex');
const network=`recorder-internal-${suffix}`;
const browser=`recorder-browser-${suffix}`;
const egress=`recorder-egress-${suffix}`;
const relay=`recorder-relay-${suffix}`;
const containerNetwork=process.env.RECORDER_TEST_CONTAINER_NETWORK==='1';
const parentContainer=process.env.RECORDER_TEST_PARENT_CONTAINER;
const sharedMediaDir=process.env.RECORDER_TEST_SHARED_MEDIA_DIR;
const sharedMediaVolume=process.env.RECORDER_TEST_SHARED_MEDIA_VOLUME;
if(containerNetwork&&(!parentContainer||!sharedMediaDir||!sharedMediaVolume))
 throw new Error('container_smoke_configuration_missing');
const workerToken=randomBytes(32).toString('base64url');
const invite=randomBytes(32).toString('base64url');
const owner=randomUUID();
const otherInvite=randomBytes(32).toString('base64url');
const otherOwner=randomUUID();
const dataDir=await mkdtemp(join(tmpdir(),'recorder-remote-service-'));
let service;
function docker(args,env=process.env){
 return execFileSync('docker',args,{env,encoding:'utf8',timeout:40_000,stdio:['ignore','pipe','pipe']}).trim();
}
function dockerAsync(args,signal){
 return new Promise((resolve,reject)=>{
  execFile('docker',args,{encoding:'utf8',timeout:180_000,maxBuffer:1024*1024,signal},
   (error,stdout,stderr)=>error?reject(new Error(stderr||error.message,{cause:error})):resolve(stdout.trim()));
 });
}
async function freePort(){
 const socket=createServer();
 const port=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.close();reject(new Error('local_listener_unavailable'));},3000);
  socket.once('error',error=>{clearTimeout(timer);reject(error);});
  socket.listen(0,'127.0.0.1',()=>{clearTimeout(timer);resolve(socket.address().port);});
 });
 await new Promise(resolve=>socket.close(resolve));
 return port;
}
const seccomp=`seccomp=${profile}`;
const small=['--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges',
 '--security-opt',seccomp,'--read-only','--tmpfs','/tmp:rw,size=64m,mode=1777'];
const browserSecurity=['--user','1000:1000','--cap-drop','ALL','--cap-add','SYS_CHROOT',
 '--security-opt','no-new-privileges','--security-opt',seccomp,'--pids-limit','256',
 '--memory','2g','--cpus','2','--shm-size','256m','--tmpfs','/tmp:rw,size=1g,mode=1777'];
const workerMount=process.env.RECORDER_TEST_BIND_WORKER==='1'?
 ['--mount',`type=bind,src=${join(process.cwd(),'apps/hosted/dist/browser-worker.js')},dst=/app/apps/hosted/dist/browser-worker.js,readonly`]:[];
try{
 const port=await freePort(),relayPort=containerNetwork?undefined:await freePort();
 docker(['network','create','--internal','--driver','bridge',network]);
 if(containerNetwork)docker(['network','connect',network,parentContainer]);
 docker(['run','-d','--rm','--pull=never','--name',egress,'--network','bridge',...small,
  '--pids-limit','64','--memory','256m','--cpus','0.5','--entrypoint','node',image,
  '/app/apps/hosted/dist/egress-worker.js']);
 docker(['network','connect','--alias','recorder-egress',network,egress]);
 docker(['run','-d','--rm','--pull=never','--name',browser,'--network',network,
  '--network-alias','recorder-browser',...browserSecurity,'--env','RECORDER_WORKER_TOKEN',
  '--env','RECORDER_WORKER_PORT=37842','--env','CHROMEDRIVER_PORT=9515',
  ...workerMount,'--entrypoint','node',image,'/app/apps/hosted/dist/browser-worker.js'],
  {...process.env,RECORDER_WORKER_TOKEN:workerToken});
 docker(['run','-d','--rm','--pull=never','--name',relay,'--network','bridge',
  ...(containerNetwork?[]:['--publish',`127.0.0.1:${relayPort}:37842`]),...small,'--pids-limit','64',
  '--memory','128m','--cpus','0.5','--entrypoint','node',image,
  '/app/apps/hosted/dist/worker-relay.js']);
 docker(['network','connect','--alias','recorder-relay',network,relay]);
 const relayHost=containerNetwork?'recorder-relay':'127.0.0.1';
 const relayEndpoint=`http://${relayHost}:${containerNetwork?37842:relayPort}`;
 const health=async()=>fetch(`${relayEndpoint}/status`,{
  headers:{authorization:`Bearer ${workerToken}`},signal:AbortSignal.timeout(1000)});
 let ready=false;
 for(let attempt=0;attempt<40;attempt++){
  try{ready=(await health()).ok;}catch{/* startup */}
  if(ready)break;
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'isolated_worker_unavailable');
 await writeFile(join(dataDir,'invites.json'),JSON.stringify({invites:[
  {owner,tokenHash:createHash('sha256').update(invite).digest('hex'),expiresAt:Date.now()+3600_000},
  ...(process.env.TENANT_ISOLATION_SMOKE==='1'?[{owner:otherOwner,
   tokenHash:createHash('sha256').update(otherInvite).digest('hex'),expiresAt:Date.now()+3600_000}]:[]),
 ]}),{mode:0o600});
 process.env.DATA_DIR=dataDir;
 process.env.PUBLIC_URL=`http://127.0.0.1:${port}`;
 process.env.PORT=String(port);
 process.env.SESSION_ENCRYPTION_KEY=randomBytes(32).toString('base64');
 process.env.RECORDER_ENVIRONMENT='local';
 process.env.RECORDER_INSTANCE_ID='local';
 process.env.HOSTED_USAGE_COHORT='fixture';
 const render=async(sourcePath,config,signal)=>{
  signal.throwIfAborted();
  const media=await mkdtemp(join(sharedMediaDir??tmpdir(),'recorder-offline-render-'));
  try{
   await chmod(media,0o777); // synthetic local Docker Desktop bind; never a production mount
   await copyFile(sourcePath,join(media,'raw.webm'));
   await writeFile(join(media,'config.json'),JSON.stringify(config));
   await chmod(join(media,'raw.webm'),0o644);
   await chmod(join(media,'config.json'),0o644);
   const mount=containerNetwork?`type=volume,src=${sharedMediaVolume},dst=${sharedMediaDir}`:
    `type=bind,src=${media},dst=/media`;
   const workerMedia=containerNetwork?media:'/media';
   try{
    await dockerAsync(['run','--rm','--pull=never','--network','none','--read-only',...browserSecurity,
     '--env','HOME=/tmp','--mount',mount,
     '--entrypoint','node',image,'/app/apps/hosted/dist/render-worker.js',
     `${workerMedia}/raw.webm`,`${workerMedia}/config.json`,`${workerMedia}/video.mp4`],signal);
   }catch(error){console.error('isolated_render_error:',error.message);throw error;}
   signal.throwIfAborted();
   return await readFile(join(media,'video.mp4'));
  }finally{await rm(media,{recursive:true,force:true});}
 };
 const runtime=createWorkerBackedRuntime({
  allocateBrowser:async()=>({endpoint:'http://[fd12::1]:37842',token:workerToken,close:async()=>{}}),
  chromeBinary:'/usr/bin/chromium',render,
  fetchImplementation:(input,init)=>fetch(`${relayEndpoint}${new URL(input).pathname}`,init),
  connectWorker:()=>connect({host:relayHost,port:containerNetwork?37842:relayPort}),
 });
 service=await startRecorder({lifecycle:createHostedLifecycle,runtime});
 const output=join(dataDir,'result.mp4');
 const child=spawn(process.execPath,['apps/mcp/src/smoke.mjs'],{
  env:{...process.env,RECORDER_URL:process.env.PUBLIC_URL,RECORDER_TOKEN:invite,
   RECORDER_MODE:'hosted',QUEUE_SMOKE:'1',SMOKE_OUTPUT:output},stdio:'inherit',
 });
 const code=await new Promise(resolve=>child.once('exit',resolve));
 assert.equal(code,0,'external_mcp_smoke_failed');
 const video=await readFile(output);assert.ok(video.length>10_000);
 console.log(JSON.stringify({phase:'remote_mcp_video_delivered',bytes:video.length}));
 if(process.env.TENANT_ISOLATION_SMOKE==='1'){
  const db=new DatabaseSync(join(dataDir,'recorder.sqlite'),{readOnly:true});
  let recordingId;
  try{
   recordingId=db.prepare('SELECT id FROM jobs WHERE owner=?').get(owner)?.id;
   assert.equal(db.prepare("SELECT count(*) n FROM hosted_product_events WHERE owner=? AND name='mcp_connected'").get(owner)?.n,1,
    'first owner MCP activation was not deduplicated');
  }
  finally{db.close();}
  assert.equal(typeof recordingId,'string');
  const client=new Client({name:'recorder-other-tenant-smoke',version:'1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',process.env.PUBLIC_URL),{
   requestInit:{headers:{Authorization:`Bearer ${otherInvite}`}},
  }));
  let otherSession;
  const call=async(name,args)=>{
   const result=await client.callTool({name,arguments:args});
   assert.notEqual(result.isError,true,`${name}: ${JSON.stringify(result.content)}`);
   return result.structuredContent??result;
  };
  try{
   assert.equal((await call('account_usage',{})).used,0);
   const denied=await client.callTool({name:'recording_links',arguments:{id:recordingId}});
   assert.equal(denied.isError,true,'other owner received recording links');
   assert.ok(!JSON.stringify(denied).includes('videoUrl'),'denial leaked a media link');
   const queued=await call('queue_enqueue',{version:1,operation:'session_open',requestId:randomUUID(),
    arguments:{url:'https://www.selenium.dev/selenium/web/web-form.html'}});
   for(let attempt=0;attempt<60;attempt++){
    const status=await call('queue_status',{jobId:queued.jobId});
    if(status.result?.id){otherSession=status.result.id;break;}
    assert.ok(['queued','running'].includes(status.state),JSON.stringify(status));
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
   assert.ok(otherSession,'second tenant session did not open');
   const observed=await call('browser_observe',{id:otherSession});
   assert.ok(!observed.page.includes('Recorded by your agent'),'prior tenant form value leaked');
  }finally{
   if(otherSession)await call('session_close',{id:otherSession}).catch(()=>undefined);
   await client.close();
  }
  const contextOptions={viewport:{width:1280,height:720},allowedOrigins:['https://www.selenium.dev'],
   onNavigation:()=>undefined,allowDownload:false,allowPopup:false};
  const cookieName=`tenant_probe_${suffix}`,cookieValue=randomBytes(12).toString('hex');
  const first=await runtime.createContext({...contextOptions,sessionState:new TextEncoder().encode(JSON.stringify({
   cookies:[{name:cookieName,value:cookieValue,domain:'www.selenium.dev',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}],origins:[],
  }))});
  try{
   await first.goto('https://www.selenium.dev/selenium/web/web-form.html');
   assert.ok((await first.exportStorageState()).cookies.some(cookie=>cookie.name===cookieName&&cookie.value===cookieValue),
    'first context failed to restore synthetic cookie');
  }finally{await first.dispose();}
  const second=await runtime.createContext({...contextOptions,sessionState:new TextEncoder().encode(JSON.stringify({cookies:[],origins:[]}))});
  try{
   await second.goto('https://www.selenium.dev/selenium/web/web-form.html');
   assert.ok(!(await second.exportStorageState()).cookies.some(cookie=>cookie.name===cookieName),
    'prior context cookie leaked into the next context');
  }finally{await second.dispose();}
  const metricsDb=new DatabaseSync(join(dataDir,'recorder.sqlite'),{readOnly:true});
  try{assert.equal(metricsDb.prepare("SELECT count(*) n FROM hosted_product_events WHERE owner=? AND name='mcp_connected'").get(otherOwner)?.n,1,
   'second owner MCP activation missing or duplicated');}
  finally{metricsDb.close();}
  console.log(JSON.stringify({phase:'two_tenant_isolation_verified',crossOwnerMediaDenied:true,
   secondTenantFormClean:true,successiveWorkerCookieClean:true,mcpActiveAccounts:2}));
 }
}finally{
 await service?.stop().catch(()=>undefined);
 for(const name of [browser,egress,relay])try{docker(['rm','-f',name]);}catch{/* may never have started */}
 if(containerNetwork)try{docker(['network','disconnect','-f',network,parentContainer]);}catch{/* may never have connected */}
 try{docker(['network','rm',network]);}catch{/* may never have been created */}
 await rm(dataDir,{recursive:true,force:true});
}
