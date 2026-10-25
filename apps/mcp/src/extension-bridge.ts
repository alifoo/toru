import { pageStyle } from './page-style.js';
import { siteUrl } from './site.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {isLocalDevelopmentUrl,type BrowserContextOptions} from '@content-layer/browser';
import type {Driver} from './recorder.js';
import {sameProductSite} from './product-origin.js';
import {withRecorderStore} from './store/open.js';
import {ExtensionDeviceStore} from './store/extension-devices.js';
import {decodeLocal,LOCAL_METHODS,MAX_LOCAL_JSON,MAX_LOCAL_VIDEO,type LocalMethod} from './local-protocol.js';

/** What the extension may be asked to do: the companion's page methods, plus opening the product tab. Never desktop sources. */
export const EXTENSION_METHODS=['open',...LOCAL_METHODS.filter(method=>method!=='listSources'&&method!=='selectSource')] as const;
export type ExtensionMethod=typeof EXTENSION_METHODS[number];
export type ExtensionCommand={id:string;method:ExtensionMethod;args:unknown[]};
type Pending={command:ExtensionCommand;sent:boolean;resolve(value:unknown):void;reject(error:Error):void;timer:NodeJS.Timeout;video?:Buffer};
type Live={id:string;owner:string;lastSeen:number;claimed:boolean;generation:number;pending?:Pending;wake?:()=>void;onDisconnect?:()=>void};
type Pairing={owner:string;expiresAt:number;authorize:()=>Promise<boolean>};

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const onlineWindowMs=45_000;
const pairingTtlMs=10*60_000;
const forwardedErrors=['local_sign_in_required','local_navigation_blocked','local_method_forbidden','extension_tab_closed','extension_debugger_unavailable'];
const answer=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
/** A reported video frame size: even integers a browser can encode, up to 4K. */
export function captureSize(value:unknown):{width:number;height:number}|undefined{
 const size=value as {width?:unknown;height?:unknown}|undefined;
 if(!size||typeof size!=='object')return undefined;
 const {width,height}=size;
 if(!Number.isInteger(width)||!Number.isInteger(height))return undefined;
 if(Number(width)<640||Number(width)>3840||Number(height)<360||Number(height)>2160||Number(width)%2||Number(height)%2)return undefined;
 return {width:Number(width),height:Number(height)};
}
async function body(req:IncomingMessage,limit:number){
 const chunks:Buffer[]=[];let bytes=0;
 for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw new Error('body_too_large');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
const connectPage=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Connect Chrome · Toru</title>
<style>
${pageStyle}
.icon::before{content:"";width:18px;height:18px;border-radius:50%;border:2px solid #7b8892;border-top-color:transparent;animation:spin 1s linear infinite}
.card:has([data-state=connected]) .icon::before{content:"✓";width:auto;height:auto;border:0;animation:none}
.card:has([data-state=failed]) .icon::before,.card:has([data-state=invalid]) .icon::before,.card:has([data-state=missing]) .icon::before{content:"!";width:auto;height:auto;border:0;animation:none;color:#914e46}
[data-state=failed],[data-state=invalid]{color:#914e46}
@media(prefers-reduced-motion:reduce){.icon::before{animation:none;border-top-color:#7b8892}}@media(max-width:480px){.card{padding:22px}}
</style></head>
<body><main><div class="brand">toru</div><section class="card" aria-live="polite">
<div class="icon" aria-hidden="true"></div><h1 id="toru-extension-heading">Connect this Chrome</h1>
<p id="toru-extension-status" data-state="missing">The Toru extension is not installed in this Chrome yet. Install it, then open this link again.</p>
</section><p class="fine">Toru only records the windows it opens for your recordings. <a href="${siteUrl}">${new URL(siteUrl).host}</a></p></main></body></html>`;

/**
 * Toru for Chrome. A paired extension lends Toru one tab in the user's own Chrome for each recording:
 * it opens the product, Jev drives it over chrome.debugger and the extension uploads the screencast.
 * Its own routes, table and tools: the companion and the Mac app are unaffected.
 */
export class ExtensionBridge {
 private live=new Map<string,Live>();
 private pairings=new Map<string,Pairing>();
 private cleanup=setInterval(()=>{const now=Date.now();for(const [hash,pairing] of this.pairings)if(pairing.expiresAt<=now)this.pairings.delete(hash);},30_000).unref();
 constructor(private dataDir:string,private owners:readonly string[]=[]){}
 /** Beta: an optional allowlist of accounts that see the tools. Empty means everyone. */
 allows(owner:string){return this.owners.length===0||this.owners.includes(owner);}
 private store<T>(work:(store:ExtensionDeviceStore)=>T):Promise<T>{return withRecorderStore(this.dataDir,db=>work(new ExtensionDeviceStore(db)));}
 /** A connection id the recorder should hand to this bridge rather than the companion's. */
 owns(id:string){return this.live.has(id);}
 /** One-time code for the connect page; the extension exchanges it for its own rotating credentials. */
 pair(owner:string,authorize:()=>Promise<boolean>){
  for(const [hash,pairing] of this.pairings)if(pairing.owner===owner)this.pairings.delete(hash);
  if(this.pairings.size>=256)throw new Error('extension_pairing_capacity');
  const code=randomBytes(32).toString('base64url'),expiresAt=Date.now()+pairingTtlMs;
  this.pairings.set(digest(code),{owner,expiresAt,authorize});
  return {pairingCode:code,expiresAt:new Date(expiresAt).toISOString()};
 }
 async devices(owner:string){
  return (await this.store(store=>store.list(owner))).map(device=>{
   const live=this.live.get(device.id),online=Boolean(live&&live.lastSeen>Date.now()-onlineWindowMs);
   return {connectionId:device.id,name:device.name,createdAt:new Date(device.createdAt).toISOString(),lastSeenAt:new Date(live?.lastSeen??device.lastSeenAt).toISOString(),
    status:!online?'offline':live?.claimed?'in_use':'ready'};
  });
 }
 async revoke(owner:string,id:string){
  const revoked=await this.store(store=>store.revoke(owner,id));
  const live=this.live.get(id);if(revoked&&live?.owner===owner){this.release(live,'extension_disconnected');this.live.delete(id);}
  return revoked;
 }
 private release(d:Live,reason:string){
  const wasClaimed=d.claimed;d.claimed=false;d.generation++;d.wake?.();
  const notify=d.onDisconnect;delete d.onDisconnect;if(wasClaimed)notify?.();
  if(d.pending){clearTimeout(d.pending.timer);d.pending.reject(new Error(reason));delete d.pending;}
 }
 close(){clearInterval(this.cleanup);for(const d of this.live.values())this.release(d,'extension_disconnected');this.live.clear();this.pairings.clear();}
 async createContext(owner:string,id:string,options:BrowserContextOptions & {captureId?:string}):Promise<Driver>{
  const d=this.live.get(id);
  if(!d||d.owner!==owner)throw new Error('local_browser_not_found');
  if(d.lastSeen<=Date.now()-onlineWindowMs)throw new Error('extension_offline');
  if(d.claimed)throw new Error('local_browser_in_use');
  const product=options.allowedOrigins[0];
  if(!product)throw new Error('local_browser_product_mismatch');
  d.claimed=true;const generation=++d.generation;
  const meta:Record<string,unknown>={};let opened=false,pendingMark:Promise<unknown>|undefined;
  const invoke=async(method:ExtensionMethod,args:unknown[])=>{
   if(d.generation!==generation||!d.claimed)throw new Error('local_browser_disconnected');
   if(pendingMark){const previous=pendingMark;pendingMark=undefined;await previous;}
   const result=await this.command(d,method,args) as {value?:unknown;meta?:Record<string,unknown>};
   const incoming=result.meta??{};
   if(method==='stopRecording'&&typeof incoming.recordingElapsedMs==='number'&&Number.isFinite(incoming.recordingElapsedMs)&&incoming.recordingElapsedMs>0&&incoming.recordingElapsedMs<=305000)meta.recordingDurationMs=incoming.recordingElapsedMs;
   for(const key of ['recordingMode','recordingElapsedMs','pointerTrail','pointerTelemetry','semanticTimeline','identitySightings'])if(Object.hasOwn(incoming,key))meta[key]=incoming[key];
   const viewport=incoming.captureViewport as {width?:unknown;height?:unknown}|undefined;
   if(viewport&&Number.isInteger(viewport.width)&&Number.isInteger(viewport.height)&&Number(viewport.width)>=640&&Number(viewport.width)<=3840&&Number(viewport.height)>=360&&Number(viewport.height)<=2160)meta.captureViewport=viewport;
   // The video's own frame size: the viewport captured at a device scale (2560x1440 for 1920x1080 at 4/3), or less on a
   // machine that could not encode that. Pointer and zoom coordinates stay in captureViewport's CSS pixels.
   const size=captureSize(incoming.captureSize);if(size)meta.captureSize=size;
   if(typeof meta.recordingElapsedMs==='number')meta.recordingStartedAtMs=Date.now()-meta.recordingElapsedMs;
   return result.value;
  };
  return new Proxy({}, {get:(_target,key)=>{
   if(key==='then')return undefined;
   if(key==='onDisconnect')return (callback:()=>void)=>{if(d.generation===generation&&d.claimed)d.onDisconnect=callback;};
   if(key==='capturePrivacy')return undefined;
   if(key==='captureViewport'||key==='captureSize'||key==='recordingMode'||key==='recordingStartedAtMs'||key==='recordingDurationMs')return meta[key];
   // Where email addresses were on screen, so the render blurs them before anything else sees the video.
   if(['pointerTrail','pointerTelemetry','semanticTimeline','identitySightings'].includes(String(key)))return ()=>meta[String(key)]??[];
   if(key==='markDemoMoment')return (...args:unknown[])=>{pendingMark=invoke('markDemoMoment',args);void pendingMark.catch(()=>undefined);};
   if(key==='exportStorageState'||key==='connectWithCredentials')return async()=>{throw new Error('local_credentials_stay_local');};
   if(key==='goto')return async(url:string)=>{
    options.onNavigation(url,0);
    if(!opened){
     // The first navigation opens the product in a new tab of the user's Chrome, already signed in.
     // A development server on the user's machine (localhost, *.test…) opens only on the product's exact origin.
     const localDevelopment=isLocalDevelopmentUrl(url)&&new URL(url).origin===new URL(product).origin;
     if(!localDevelopment&&!sameProductSite(url,product))throw new Error('local_browser_product_mismatch');
     opened=true;
     // The page layout to record. An extension before 0.1.8 ignores it and records 1280x720; each reports what it used.
     const current=await invoke('open',[{url,allowedOrigins:options.allowedOrigins,viewport:{width:options.viewport.width,height:options.viewport.height}}]);
     if(typeof current!=='string')throw new Error('local_browser_url_invalid');
     options.onNavigation(current,0);return;
    }
    return invoke('goto',[url]);
   };
   if(key==='dispose')return async()=>{try{if(opened)await invoke('dispose',[]);}finally{if(d.generation===generation){d.claimed=false;delete d.onDisconnect;}}};
   // Optional driver features the extension does not offer (contentLayers…) read as
   // absent; a callable stub would reject unobserved and take the whole server down.
   // Known protocol methods the extension refuses (desktop sources) still reject when called.
   if(!(LOCAL_METHODS as readonly string[]).includes(String(key))&&!(EXTENSION_METHODS as readonly string[]).includes(String(key)))return undefined;
   return (...args:unknown[])=>invoke(String(key) as ExtensionMethod,args);
  }}) as Driver;
 }
 private command(d:Live,method:ExtensionMethod,args:unknown[]):Promise<unknown>{
  if(!EXTENSION_METHODS.includes(method))return Promise.reject(new Error('local_method_forbidden'));
  if(d.lastSeen<=Date.now()-onlineWindowMs)return Promise.reject(new Error('extension_offline'));
  if(d.pending)return Promise.reject(new Error('local_browser_action_in_progress'));
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.release(d,'local_browser_disconnected'),method==='stopRecording'?180_000:method==='open'?60_000:45_000).unref();
   d.pending={command:{id:randomUUID(),method,args},sent:false,resolve,reject,timer};d.wake?.();
  });
 }
 async http(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
  if(!url.pathname.startsWith('/extension/'))return false;
  if(req.method==='GET'&&url.pathname==='/extension/connect'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});
   res.end(connectPage);return true;
  }
  // Only the extension itself calls the API: no page may use a pairing code or a device token.
  const origin=req.headers.origin;
  if(origin!==undefined&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)){answer(res,403,{error:'origin_forbidden'});return true;}
  try{
   if(req.method!=='POST'){answer(res,405,{error:'method_not_allowed'});return true;}
   if(url.pathname==='/extension/pair'){
    const input=JSON.parse((await body(req,1024)).toString());
    const hash=typeof input.code==='string'?digest(input.code):'';
    const pairing=this.pairings.get(hash);
    this.pairings.delete(hash);
    if(!pairing||pairing.expiresAt<=Date.now()||!this.allows(pairing.owner)||!await pairing.authorize()){answer(res,401,{error:'pairing_code_invalid'});return true;}
    const credentials=await this.store(store=>store.register(pairing.owner,typeof input.deviceName==='string'?input.deviceName:'Chrome'));
    this.live.set(credentials.deviceId,{id:credentials.deviceId,owner:pairing.owner,lastSeen:Date.now(),claimed:false,generation:0});
    answer(res,200,{...credentials,connectionId:credentials.deviceId});return true;
   }
   if(url.pathname==='/extension/refresh'){
    const input=JSON.parse((await body(req,1024)).toString());
    const renewed=typeof input.refreshToken==='string'?await this.store(store=>store.refresh(input.refreshToken)):undefined;
    answer(res,renewed?200:401,renewed??{error:'device_credentials_expired'});return true;
   }
   const token=req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
   const identity=token?await this.store(store=>store.authenticate(token)):undefined;
   if(!identity){answer(res,401,{error:'device_credentials_expired'});return true;}
   let d=this.live.get(identity.id);
   if(!d){
    if(this.live.size>=1024){answer(res,503,{error:'extension_capacity'});return true;}
    d={id:identity.id,owner:identity.owner,lastSeen:0,claimed:false,generation:0};this.live.set(d.id,d);
   }
   d.lastSeen=Date.now();
   if(url.pathname==='/extension/revoke'){await this.revoke(d.owner,d.id);answer(res,200,{revoked:true});return true;}
   if(url.pathname==='/extension/status'){answer(res,200,{connectionId:d.id,status:d.claimed?'in_use':'ready'});return true;}
   if(url.pathname==='/extension/poll'){
    if(d.wake){d.wake();await new Promise(resolve=>setImmediate(resolve));}
    if(!d.pending)await new Promise<void>(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);res.off('close',finish);if(d!.wake===finish)delete d!.wake;resolve();};const timer=setTimeout(finish,20_000);d!.wake=finish;res.once('close',finish);});
    if(res.destroyed)return true;
    d.lastSeen=Date.now();
    const pending=d.pending;
    if(!pending||pending.sent){answer(res,200,{command:null});return true;}
    pending.sent=true;
    answer(res,200,{command:pending.command});return true;
   }
   const match=/^\/extension\/result\/([0-9a-f-]{36})(\/video)?$/.exec(url.pathname);
   if(match){
    const pending=d.pending;
    if(!pending||pending.command.id!==match[1]||!pending.sent){answer(res,409,{error:'stale_command'});return true;}
    if(match[2]){
     if(pending.command.method!=='stopRecording'||pending.video){answer(res,409,{error:'unexpected_video'});return true;}
     const video=await body(req,MAX_LOCAL_VIDEO);if(d.pending!==pending)throw new Error('stale_command');
     pending.video=video;answer(res,200,{received:true});return true;
    }
    const input=JSON.parse((await body(req,MAX_LOCAL_JSON)).toString());
    if(d.pending!==pending)throw new Error('stale_command');
    const value=decodeLocal(input.value) as Record<string,unknown>|undefined;
    if(value?.body==='local_video_upload'){if(!pending.video)throw new Error('missing_video');value.body=pending.video;}
    clearTimeout(pending.timer);delete d.pending;
    if(input.error)console.warn(JSON.stringify({event:'extension_command_failed',method:pending.command.method,error:String(input.error).slice(0,60),detail:typeof input.detail==='string'?input.detail.replace(/[^\w .:<>()-]/g,'').slice(0,160):undefined}));
    if(input.error)pending.reject(new Error(forwardedErrors.includes(input.error)?input.error:'local_browser_action_failed'));
    else pending.resolve({value,meta:input.meta});
    answer(res,200,{received:true});return true;
   }
   answer(res,404,{error:'not_found'});
  }catch{if(!res.headersSent)answer(res,400,{error:'extension_request_invalid'});}
  return true;
 }
}
