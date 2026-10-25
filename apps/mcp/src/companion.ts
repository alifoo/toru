import {companionDependencies} from './companion-dependencies.js';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FetchWebDriverTransport,WebDriverBrowserDriver,spawnBrowserProcess,stopBrowserProcess,type WebDriverTransport} from '@content-layer/browser';
import {startEgressProxy} from './egress.js';
import {sameProductSite} from './product-origin.js';
import {LOCAL_METHODS,assertLocalCommand,encodeLocal,type LocalCommand} from './local-protocol.js';
import type {Driver} from './recorder.js';
import{privatePageScript}from'./private-page.js';

export function companionServer(value:string):URL{
 const url=new URL(value);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/' ||
  (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('Use an HTTPS Toru server URL (HTTP is only allowed on loopback for development).');
 return url;
}
async function freePort():Promise<number>{
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('local_port_unavailable');
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;
}
export type CompanionOptions={server:string;code:string;consent(url:string,browser:Driver):Promise<void>;log?(message:string):void;signal?:AbortSignal};
export async function runCompanion(options:CompanionOptions):Promise<void>{
 const server=companionServer(options.server),log=options.log??console.log;
 let token:string|undefined,driver:Driver|undefined;
 let transport:WebDriverTransport|undefined,sessionPath:string|undefined,sharing=false;
 const controller=new AbortController();
 const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
 if(options.signal?.aborted)abort();
 const post=async(path:string,value:unknown={},binary=false)=>{
  const response=await fetch(new URL('/local-browser/'+path,server),{method:'POST',redirect:'error',
   headers:{'content-type':binary?'application/octet-stream':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
   body:binary?Buffer.from(value as Uint8Array):JSON.stringify(value),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(binary?120000:30000)])});
  if(!response.ok)throw new Error(`Companion connection failed (${response.status}). Pair again; actions will not be replayed.`);
  return await response.json() as Record<string,unknown>;
 };
 const dependencies=await companionDependencies(log);
 const paired=await post('pair',{code:options.code});
 if(typeof paired.token!=='string'||typeof paired.url!=='string')throw new Error('invalid_pairing_response');
 token=paired.token;const product=new URL(paired.url);
 if(product.protocol!=='https:'||product.username||product.password||product.port||!sameProductSite(product.origin,product.origin))throw new Error('public_https_url_required');
 const viewport={width:Number(globalThis.process.env.TORU_VIEWPORT_WIDTH??1280),height:Number(globalThis.process.env.TORU_VIEWPORT_HEIGHT??720)};
 if(!Number.isInteger(viewport.width)||!Number.isInteger(viewport.height)||viewport.width<800||viewport.width>3840||viewport.height<600||viewport.height>2160)throw new Error('invalid_local_viewport');
 const recordingViewport={...viewport};
 const scratch=await mkdtemp(join(tmpdir(),'toru-companion-'));
 const egress=await startEgressProxy();
 const port=await freePort();
 const process=spawnBrowserProcess(dependencies.driver,[`--port=${port}`,'--allowed-ips=127.0.0.1','--log-level=OFF']);
 const killBrowser=()=>{void stopBrowserProcess(process);};
 controller.signal.addEventListener('abort',killBrowser,{once:true});
 const guard=async()=>{
  if(!driver||!transport||!sessionPath)throw new Error('local_browser_unavailable');
  const url=await driver.currentUrl();
  if(!sameProductSite(url,product.href))throw new Error('local_navigation_blocked');
  if(await transport.request('POST',`${sessionPath}/execute/sync`,{script:privatePageScript,args:[]}))throw new Error('local_sign_in_required');
 };
 try{
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<50&&!controller.signal.aborted;i++){
   try{ready=(await fetch(base+'/status',{signal:AbortSignal.timeout(500)})).ok;}catch{/* ChromeDriver startup */}
   if(ready)break;if(process.exitCode!==null||process.signalCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready)throw new Error('ChromeDriver unavailable. Set CHROMEDRIVER_BINARY to a driver matching your Chrome version.');
  const raw=new FetchWebDriverTransport(base);
  transport={request:async(method,path,body)=>{
   const value=await raw.request(method,path,body);
   if(method==='POST'&&path==='/session'&&value&&typeof value==='object'&&'sessionId' in value)sessionPath='/session/'+encodeURIComponent(String(value.sessionId));
   return value;
  }};
  const browser=new WebDriverBrowserDriver(transport,{chromeBinary:dependencies.chrome,recordingFrameRate:60,
   chromeArguments:[`--user-data-dir=${scratch}`,`--proxy-server=http://127.0.0.1:${egress.port}`,'--proxy-bypass-list=<-loopback>','--disable-quic','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
  driver=await browser.createContext({viewport,fitViewportToWindow:true,allowedOrigins:[product.origin],
   sessionState:Buffer.from(JSON.stringify({cookies:[],origins:[]})),allowDownload:false,allowPopup:false,
   onNavigation:url=>{
    const target=new URL(url);
    if(target.protocol!=='https:'||target.username||target.password||(sharing&&!sameProductSite(target.href,product.href)))throw new Error('local_navigation_blocked');
   }}) as Driver;
  await driver.goto(product.href);
  log('Sign in inside the dedicated Toru Chrome window. Nothing from that window is shared before you continue.');
  while(true){
   await options.consent(product.origin,driver);
   try{await guard();break;}catch(error){
    if(!(error instanceof Error)||!['local_sign_in_required','local_navigation_blocked'].includes(error.message))throw error;
    log('Finish signing in and return to the product in this window before continuing. Sharing is still off.');
   }
  }
  // The user signs in using the native window. Capture then gets a fixed CSS viewport,
  // independent of macOS tiling/window decorations and Retina scaling.
  await transport.request('POST',`${sessionPath}/goog/cdp/execute`,{cmd:'Emulation.setDeviceMetricsOverride',params:{...recordingViewport,deviceScaleFactor:1,mobile:false}});
  Object.assign(viewport,recordingViewport);
  sharing=true;
  await post('ready');
  log('Sharing this window with Toru. Return to your agent and say ready. Press Ctrl+C here to disconnect.');
  while(!controller.signal.aborted){
   const polled=await post('poll');const command=polled.command as LocalCommand|null;
   if(!command)continue;
   if(typeof command.id!=='string'||!Array.isArray(command.args)||!LOCAL_METHODS.includes(command.method))throw new Error('local_method_forbidden');
   let value:unknown,error:string|undefined;
   try{
    assertLocalCommand(command);
    if(!['stopRecording','dispose'].includes(command.method))await guard();
    // Only these explicit driver methods are remotely callable. No evaluate, cookies, storage or filesystem RPC.
    const action=driver[command.method as keyof Driver];
    if(typeof action!=='function')throw new Error('local_method_forbidden');
    value=await (action as (...args:unknown[])=>unknown).apply(driver,command.args);
    if(!['stopRecording','dispose'].includes(command.method))await guard();
    if(command.method==='stopRecording'&&value&&typeof value==='object'&&'body' in value){
     await post(`result/${command.id}/video`,value.body,true);value={...value,body:'local_video_upload'};
    }
   }catch(caught){
    error=caught instanceof Error&&['local_sign_in_required','local_navigation_blocked','local_method_forbidden'].includes(caught.message)?caught.message:'local_browser_action_failed';
    log(error==='local_sign_in_required'?'Sign-in is required again. Stop sharing (Ctrl+C), then ask your agent to pair a fresh window.':error);
   }
   const meta={captureViewport:viewport,recordingMode:driver.recordingMode,recordingElapsedMs:driver.recordingStartedAtMs?Date.now()-driver.recordingStartedAtMs:undefined,
    pointerTrail:driver.pointerTrail?.(),pointerTelemetry:driver.pointerTelemetry?.(),semanticTimeline:driver.semanticTimeline?.()};
   await post(`result/${command.id}`,{...(error?{error}:{value:encodeLocal(value)}),meta});
   if(command.method==='dispose'){driver=undefined;break;}
  }
 }finally{
  options.signal?.removeEventListener('abort',abort);
  controller.signal.removeEventListener('abort',killBrowser);
  await fetch(new URL('/local-browser/disconnect',server),{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)}).catch(()=>undefined);
  await driver?.dispose().catch(()=>undefined);await stopBrowserProcess(process);await egress.close();await rm(scratch,{recursive:true,force:true});
 }
}
async function main(){
 const args=globalThis.process.argv.slice(2);
 if(args.includes('--help')){console.log('Toru companion — local Chrome sign-in and recording\nUsage: node toru-companion.mjs [--server https://mcp.toru.tools]\nRequires Node.js 24+, Chrome, ffmpeg, and macOS or Linux.\nChromeDriver is downloaded from Google when missing. Ask your agent for a pairing code.');return;}
 if(args.includes('--check')){await companionDependencies();console.log('Toru companion dependencies ready.');return;}
 const at=args.indexOf('--server');
 const server=at>=0?args[at+1]:'https://mcp.toru.tools';if(!server)throw new Error('Missing --server URL');
 await companionDependencies();
 const terminal=createInterface({input:stdin,output:stdout});const controller=new AbortController();
 const stop=()=>{controller.abort();terminal.close();};globalThis.process.once('SIGINT',stop);globalThis.process.once('SIGTERM',stop);
 try{
  const code=(await terminal.question('Paste the one-time pairing code from your agent: ')).trim();
  await runCompanion({server,code,signal:controller.signal,consent:async origin=>{
   await terminal.question(`\nOnce signed in to ${origin}, press Enter to let Toru view and control this dedicated window. `);
  }});
 }finally{terminal.close();globalThis.process.removeListener('SIGINT',stop);globalThis.process.removeListener('SIGTERM',stop);}
}
if(globalThis.process.argv[1]&&import.meta.url===pathToFileURL(globalThis.process.argv[1]).href)
 main().catch(error=>{console.error(error instanceof Error?error.message:'companion_failed');globalThis.process.exitCode=1;});
