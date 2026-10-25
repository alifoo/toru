import { siteUrl } from './site.js';
import { appUpdateRequired, compareVersions } from './app-version.js';
import {readFile} from 'node:fs/promises';
import {DesktopUploadStore,desktopChunkBytes} from './store/desktop-uploads.js';
import {withRecorderStore} from './store/open.js';
import {DesktopDeviceStore} from './store/desktop-devices.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {BrowserContextOptions} from '@content-layer/browser';
import type {Driver} from './recorder.js';
import {sameProductSite} from './product-origin.js';
import {decodeLocal,LOCAL_METHODS,MAX_LOCAL_JSON,MAX_LOCAL_VIDEO,type LocalCommand,type LocalMethod} from './local-protocol.js';
import {DEFAULT_WINDOW_SIZE,desktopWindow,type WindowSizePreset} from './desktop-window.js';

type Pending={command:LocalCommand;sent:boolean;resolve(value:unknown):void;reject(error:Error):void;timer:NodeJS.Timeout;video?:Buffer};
type Device={control?:boolean;windowSize?:WindowSizePreset;onDisconnect?:()=>void;captureId?:string;durable?:boolean;generation?:number;lastSeen?:number;mode:"browser"|"desktop";id:string;owner:string;url:string;codeHash?:string;tokenHash?:string;expiresAt:number;ready:boolean;claimed:boolean;closed:boolean;authorize:()=>Promise<boolean>;pending?:Pending;wake?:()=>void};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const DESKTOP_CONTROL_METHODS:readonly string[]=['readPage','pageText','pointer','formInput','typeText','pressKey','scrollBy','redactSensitiveText'];
/** One-time pairing code lifetime. Only local smoke tests raise it; bounded to 30 minutes. */
const pairingTtlMs=()=>{const raw=Number(process.env.LOCAL_BROWSER_PAIR_TTL_MS);return Number.isFinite(raw)&&raw>=60000&&raw<=30*60000?raw:5*60000;};
const answer=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req:IncomingMessage,limit:number){
 const chunks:Buffer[]=[];let bytes=0;
 for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw new Error('body_too_large');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}

/** Only outbound companion requests. Pairing binds one temporary browser to one owner. */
export class LocalBrowserBridge {
 private devices=new Map<string,Device>();
 /** Runbook flag: when false, no new Mac pairing/resume/manual capture; existing uploads and publication still work. */
 desktopEnabled=true;
 /** Version negotiation with the Mac app (runbook + updater): below the minimum, desktop routes answer 426. */
 minimumAppVersion:string|undefined;
 latestAppVersion:string|undefined;
 appVersionInfo(){return {minimumAppVersion:this.minimumAppVersion??'0.0.0',latestAppVersion:this.latestAppVersion??null,downloadUrl:`${siteUrl}/mac`,appcastUrl:`${siteUrl}/downloads/appcast.xml`};}
 private diagnosticCounts=new Map<string,number>();
 private diagnosticRecent:Array<{at:string;event:string;code:string;appVersion:string}>=[];
 /** Opt-in, scrubbed failure reports from the Mac app: event + error code + app version only. */
 diagnostics(){return {counts:Object.fromEntries(this.diagnosticCounts),recent:[...this.diagnosticRecent]};}
 constructor(private dataDir?:string,private recoverUpload?:(owner:string,deviceId:string,id:string)=>Promise<Record<string,unknown>>,
  private beginManualCapture?:(owner:string,deviceId:string,requestId:string)=>Promise<Record<string,unknown>>){}
 private store<T>(work:(store:DesktopDeviceStore)=>T):Promise<T>{
  if(!this.dataDir)throw new Error('desktop_persistence_unavailable');
  return withRecorderStore(this.dataDir,db=>work(new DesktopDeviceStore(db)));
 }
 async desktopDevices(owner:string){
  if(!this.dataDir)return [];
  return (await this.store(store=>store.list(owner))).map(device=>{
   const live=this.devices.get(device.id),online=Boolean(live&&!live.closed&&(live.lastSeen??0)>Date.now()-45000);
   return {...device,connectionId:device.id,control:live?.control===true,status:device.revoked?'revoked':!online?'offline':live?.claimed?'in_use':live?.ready?'ready':'awaiting_approval',
    nextAction:device.revoked?'pair_again':online&&live?.ready?(live.control?'desktop_recording_run':'desktop_recording_open'):'approve_source_in_mac_app'};
  });
 }
 /** Windows and displays the paired Mac can record right now, as the app lists them. */
 async desktopSources(owner:string,id:string){
  const d=this.owned(owner,id);if(d.mode!=='desktop')throw new Error('desktop_connection_required');
  return (await this.command(d,'listSources',[]) as {value:{sources:unknown[];selected:string|null}}).value;
 }
 /** Choose what the next recording captures; refused while a capture is running. */
 async desktopSelectSource(owner:string,id:string,sourceId:string){
  const d=this.owned(owner,id);if(d.mode!=='desktop')throw new Error('desktop_connection_required');
  return (await this.command(d,'selectSource',[{sourceId}]) as {value:{selected:string|null;title?:string}}).value;
 }
 async revokeDesktop(owner:string,id:string){
  const revoked=await this.store(store=>store.revoke(owner,id));
  const live=this.devices.get(id);if(revoked&&live?.owner===owner)this.disconnect(live);
  return revoked;
 }
 /** windowSize: the preset the Mac gives the shared window for the next recording when control is allowed (1920x1080 by default). */
 async bindDesktop(owner:string,id:string,authorize:()=>Promise<boolean>,windowSize:WindowSizePreset=DEFAULT_WINDOW_SIZE){
  const d=this.owned(owner,id);
  if(d.mode!=='desktop'||d.claimed)throw new Error('desktop_connection_unavailable');
  if(!await authorize())throw new Error('unauthorized');
  d.authorize=authorize;d.windowSize=windowSize;
 }
 private cleanup=setInterval(()=>{for(const d of this.devices.values())if(d.expiresAt<=Date.now()){this.disconnect(d);this.devices.delete(d.id);}},30000).unref();
 pair(owner:string,url:string,authorize:()=>Promise<boolean>,mode:"browser"|"desktop"="browser"){
  const target=new URL(url);
  if(target.protocol!=='https:'||target.username||target.password||target.port||!sameProductSite(target.origin,target.origin))throw new Error('public_https_url_required');
  if(mode==='desktop'&&!this.desktopEnabled)throw new Error('desktop_sessions_disabled');
  for(const d of this.devices.values())if(d.owner===owner&&!d.claimed&&!d.durable){this.disconnect(d);this.devices.delete(d.id);}
  if(this.devices.size>=128)throw new Error('local_browser_capacity');
  const id=randomUUID(),code=randomBytes(32).toString('base64url'),expiresAt=Date.now()+pairingTtlMs();
  this.devices.set(id,{mode,id,owner,url,codeHash:digest(code),expiresAt,ready:false,claimed:false,closed:false,authorize});
  return {connectionId:id,pairingCode:code,expiresAt:new Date(expiresAt).toISOString(),status:'waiting_for_companion',instruction:'Run the Toru companion locally with this one-time pairing code. Sign in directly in its Chrome window, then press Enter in the companion to allow Toru to observe and control that window. End this turn and ask the user to reply ready. No passwords or cookies belong in chat.'};
 }
 status(owner:string,id:string){const d=this.owned(owner,id);return {connectionId:id,mode:d.mode,...(d.mode==='desktop'?{control:d.control===true}:{}),status:d.closed?'disconnected':d.claimed?'in_use':d.ready?'ready':d.tokenHash?'waiting_for_local_sign_in':'waiting_for_companion',expiresAt:new Date(d.expiresAt).toISOString()};}
 private owned(owner:string,id:string){const d=this.devices.get(id);if(!d||d.owner!==owner)throw new Error('local_browser_not_found');return d;}
 private disconnect(d:Device){const wasClaimed=d.claimed;d.closed=true;d.ready=false;d.claimed=false;d.generation=(d.generation??0)+1;d.wake?.();const notify=d.onDisconnect;delete d.onDisconnect;if(wasClaimed)notify?.();if(d.pending){clearTimeout(d.pending.timer);d.pending.reject(new Error('local_browser_disconnected'));delete d.pending;}}
 close(){clearInterval(this.cleanup);for(const d of this.devices.values())this.disconnect(d);this.devices.clear();}
 async createContext(owner:string,id:string,options:BrowserContextOptions & {captureId?:string}):Promise<Driver>{
  const d=this.owned(owner,id);
  if(d.closed||d.expiresAt<=Date.now()||!await d.authorize())throw new Error('local_browser_disconnected');
  if(!d.ready)throw new Error('local_browser_sign_in_pending');
  if(d.claimed)throw new Error('local_browser_in_use');
  if(!options.allowedOrigins[0]||!sameProductSite(options.allowedOrigins[0],d.url))throw new Error('local_browser_product_mismatch');
  if(options.captureId)d.captureId=options.captureId;
  d.claimed=true;const generation=d.generation=(d.generation??0)+1;
  const meta:Record<string,unknown>={};let initialGoto=true,pendingMark:Promise<unknown>|undefined;
  const invoke=async(method:LocalMethod,args:unknown[])=>{
   if(d.generation!==generation||!d.claimed)throw new Error('local_browser_disconnected');
   if(pendingMark){const previous=pendingMark;pendingMark=undefined;await previous;}
   // A Mac before 0.4.2 reads only captureId and records the window as it is.
   const result=await this.command(d,method,d.mode==='desktop'&&method==='startRecording'&&options.captureId?[{captureId:options.captureId,...(d.windowSize?{windowSize:d.windowSize}:{})}]:args) as {value?:unknown;meta?:Record<string,unknown>};
   const incoming=result.meta??{};
   if(method==='stopRecording' && typeof incoming.recordingElapsedMs==='number' && Number.isFinite(incoming.recordingElapsedMs) && incoming.recordingElapsedMs>0 && incoming.recordingElapsedMs<=305000)meta.recordingDurationMs=incoming.recordingElapsedMs;
   for(const key of ['recordingMode','recordingElapsedMs','pointerTrail','pointerTelemetry','semanticTimeline','identitySightings','contentLayers'])if(Object.hasOwn(incoming,key))meta[key]=incoming[key];
   if(d.mode==='desktop'){const window=desktopWindow(incoming.desktopWindow);if(window)meta.desktopWindow=window;}
   const viewport=incoming.captureViewport as {width?:unknown;height?:unknown}|undefined;
   if(viewport&&Number.isInteger(viewport.width)&&Number.isInteger(viewport.height)&&Number(viewport.width)>=(d.mode==='desktop'?2:640)&&Number(viewport.width)<=3840&&Number(viewport.height)>=(d.mode==='desktop'?2:360)&&Number(viewport.height)<=2160)meta.captureViewport=viewport;
   if(typeof meta.recordingElapsedMs==='number')meta.recordingStartedAtMs=Date.now()-meta.recordingElapsedMs;
   return result.value;
  };
  return new Proxy({}, {get:(_target,key)=>{
   if(key==='then')return undefined;
   // The recorder learns about a Mac that stopped on its own (window closed, sleep, lock) without waiting for the next command.
   if(key==='onDisconnect')return (callback:()=>void)=>{if(d.generation===generation&&d.claimed)d.onDisconnect=callback;};
   if(key==='capturePrivacy')return d.mode==='desktop'?'user-approved-desktop':undefined;
   if(key==='captureViewport'||key==='recordingMode'||key==='recordingStartedAtMs'||key==='recordingDurationMs'||key==='contentLayers'||key==='desktopWindow')return meta[key];
   if(['pointerTrail','pointerTelemetry','semanticTimeline','identitySightings'].includes(String(key)))return ()=>meta[String(key)]??[];
   if(key==='markDemoMoment')return (...args:unknown[])=>{pendingMark=invoke('markDemoMoment',args);void pendingMark.catch(()=>undefined);};
   if(key==='exportStorageState'||key==='connectWithCredentials')return async()=>{throw new Error('local_credentials_stay_local');};
   if(key==='goto')return async(url:string)=>{options.onNavigation(url,0);if(initialGoto){initialGoto=false;const current=await invoke('currentUrl',[]);if(typeof current!=='string')throw new Error('local_browser_url_invalid');options.onNavigation(current,0);return;}return invoke('goto',[url]);};
   // Unsupported optional driver features read as absent rather than as a stub that rejects unobserved.
   if(!(LOCAL_METHODS as readonly string[]).includes(String(key)))return undefined;
   return (...args:unknown[])=>invoke(String(key) as LocalMethod,args);
  }}) as Driver;
 }
 private command(d:Device,method:LocalMethod,args:unknown[]):Promise<unknown>{
  // A Mac whose user allowed it also answers the page methods, so Jev can operate the shared window.
  const desktopControl=d.mode==='desktop'&&d.control===true&&DESKTOP_CONTROL_METHODS.includes(method);
  if(d.mode==='desktop'&&!desktopControl&&!['currentUrl','startRecording','stopRecording','screenshot','dispose','markDemoMoment','listSources','selectSource'].includes(method))return Promise.reject(new Error('desktop_capture_only'));
  if(d.mode!=='desktop'&&['listSources','selectSource'].includes(method))return Promise.reject(new Error('local_method_forbidden'));
  if(!LOCAL_METHODS.includes(method))return Promise.reject(new Error('local_method_forbidden'));
  if(d.closed||!d.ready||d.expiresAt<=Date.now())return Promise.reject(new Error('local_browser_disconnected'));
  if(d.pending)return Promise.reject(new Error('local_browser_action_in_progress'));
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.disconnect(d),method==='stopRecording'?180000:45000).unref();
   d.pending={command:{id:randomUUID(),method,args},sent:false,resolve,reject,timer};d.wake?.();
  });
 }
 async http(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
  if(!url.pathname.startsWith('/local-browser/'))return false;
  if(req.headers.origin!==undefined){answer(res,403,{error:'origin_forbidden'});return true;}
  try {
   if(url.pathname==='/local-browser/version'&&['GET','POST'].includes(req.method??'')){answer(res,200,this.appVersionInfo());return true;}
   const appVersion=req.headers['x-toru-app-version'];
   const desktopRoute=/^\/local-browser\/(device\/(refresh|resume)|desktop-recording\/begin|desktop-upload\/[0-9a-f-]{36}\/begin)$/.test(url.pathname)
    ||(url.pathname==='/local-browser/pair'&&req.method==='POST'&&appVersion!==undefined);
   if(desktopRoute&&appUpdateRequired(appVersion,this.minimumAppVersion)){
    answer(res,426,{error:'app_update_required',...this.appVersionInfo()});return true;
   }
   if(url.pathname==='/local-browser/device/refresh'&&req.method==='POST'){
    const input=JSON.parse((await body(req,1024)).toString());
    const renewed=typeof input.refreshToken==='string'?await this.store(store=>store.refresh(input.refreshToken)):undefined;
    answer(res,renewed?200:401,renewed??{error:'device_credentials_expired'});return true;
   }
   if(url.pathname==='/local-browser/pair'&&req.method==='POST'){
    const input=JSON.parse((await body(req,1024)).toString());
    const hash=typeof input.code==='string'?digest(input.code):'';
    const d=[...this.devices.values()].find(item=>item.codeHash===hash&&!item.closed&&item.expiresAt>Date.now());
    if(!d||!await d.authorize()||d.codeHash!==hash){answer(res,401,{error:'pairing_code_invalid'});return true;}
    delete d.codeHash;
    if(d.mode==='desktop'&&input.persistent===true){
     const credentials=await this.store(store=>store.register(d.owner,typeof input.deviceName==='string'?input.deviceName:'Mac',Date.now(),d.id));
     d.durable=true;d.tokenHash=digest(credentials.accessToken);d.lastSeen=Date.now();d.expiresAt=Date.now()+30*60000;
     answer(res,200,{...credentials,token:credentials.accessToken,connectionId:d.id,mode:d.mode,url:d.url});return true;
    }
    const token=randomBytes(32).toString('base64url');d.tokenHash=digest(token);d.expiresAt=Date.now()+30*60000;
    answer(res,200,{connectionId:d.id,token,url:d.url,expiresAt:d.expiresAt,mode:d.mode});return true;
   }
   const token=req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
   let d=token?[...this.devices.values()].find(item=>item.tokenHash===digest(token)):undefined;
   if(token&&this.dataDir&&(!d||d.durable)){
    const identity=await this.store(store=>store.authenticate(token));
    if(!identity){if(d)this.disconnect(d);answer(res,401,{error:'device_credentials_expired'});return true;}
    d=this.devices.get(identity.id);
    if(!d){
     if(this.devices.size>=128){answer(res,503,{error:'local_browser_capacity'});return true;}
     d={id:identity.id,owner:identity.owner,mode:'desktop',url:siteUrl,durable:true,expiresAt:Date.now()+30*60000,ready:false,claimed:false,closed:true,authorize:async()=>false};
     this.devices.set(d.id,d);
    }
    d.tokenHash=digest(token);d.lastSeen=Date.now();
    // A live durable Mac keeps its lease while it keeps polling; consent still ends with every recording or Stop sharing.
    if(!d.closed)d.expiresAt=Math.max(d.expiresAt,Date.now()+30*60000);
   }
   const upload=/^\/local-browser\/desktop-upload\/([0-9a-f-]{36})\/(begin|chunk|complete|status|publish)$/.exec(url.pathname);
   if(upload&&d?.durable&&this.dataDir&&req.method==='POST'){
    const owner=d.owner,deviceId=d.id,id=upload[1]!;
    if(upload[2]==='publish'){
     if(!this.recoverUpload)throw new Error('desktop_recovery_unavailable');
     answer(res,200,await this.recoverUpload(owner,deviceId,id));return true;
    }
    const input=upload[2]==='begin'?JSON.parse((await body(req,2048)).toString()):undefined;
    const chunk=upload[2]==='chunk'?await body(req,desktopChunkBytes):undefined;
    const value=await withRecorderStore(this.dataDir,db=>{
     const store=new DesktopUploadStore(db,this.dataDir!);
     if(upload[2]==='begin')return store.begin(owner,deviceId,id,input.bytes,input.sha256,input.media);
     if(upload[2]==='chunk')return store.append(owner,deviceId,id,Number(req.headers['x-toru-offset']),chunk!);
     if(upload[2]==='complete')return store.complete(owner,deviceId,id);
     return store.status(owner,deviceId,id);
    });
    answer(res,200,value);return true;
   }
   if(d?.durable&&req.method==='POST'&&url.pathname==='/local-browser/diagnostics'){
    const input=JSON.parse((await body(req,1024)).toString());
    const event=typeof input.event==='string'&&/^[a-z][a-z0-9_]{2,40}$/.test(input.event)?input.event:undefined;
    const code=typeof input.code==='string'&&/^[a-z0-9_]{0,70}$/.test(input.code)?input.code:'unclassified';
    const appVersion=typeof input.appVersion==='string'&&/^[0-9]+(\.[0-9]+){0,3}$/.test(input.appVersion)?input.appVersion:'unknown';
    if(!event){answer(res,400,{error:'diagnostic_event_invalid'});return true;}
    const key=`${event}:${code||'none'}`;
    if(this.diagnosticCounts.size>=200&&!this.diagnosticCounts.has(key)){answer(res,200,{recorded:false});return true;}
    this.diagnosticCounts.set(key,(this.diagnosticCounts.get(key)??0)+1);
    this.diagnosticRecent.push({at:new Date().toISOString(),event,code,appVersion});if(this.diagnosticRecent.length>50)this.diagnosticRecent.shift();
    answer(res,200,{recorded:true});return true;
   }
   if(d?.durable&&(url.pathname==='/local-browser/desktop-recording/begin'||url.pathname==='/local-browser/device/resume')&&!this.desktopEnabled){
    answer(res,503,{error:'desktop_sessions_disabled'});return true;
   }
   if(d?.durable&&this.dataDir&&req.method==='POST'&&url.pathname==='/local-browser/desktop-recording/begin'){
    // Manual Record in the Mac app: no agent command, no pending stop; the upload endpoints above carry the bytes.
    if(!this.beginManualCapture)throw new Error('desktop_manual_capture_unavailable');
    const input=JSON.parse((await body(req,1024)).toString());
    if(typeof input.requestId!=='string'){answer(res,400,{error:'request_id_required'});return true;}
    try{answer(res,200,await this.beginManualCapture(d.owner,d.id,input.requestId));}
    catch(error){answer(res,409,{error:error instanceof Error?error.message:'desktop_manual_capture_failed'});}
    return true;
   }
   if(d?.durable&&req.method==='POST'&&url.pathname==='/local-browser/device/resume'){
    if(d.claimed||d.pending){answer(res,409,{error:'recording_in_progress'});return true;}
    d.closed=false;d.ready=false;d.expiresAt=Date.now()+30*60000;
    answer(res,200,{connectionId:d.id,mode:'desktop',nextAction:'approve_source'});return true;
   }
   if(d?.durable&&req.method==='POST'&&url.pathname==='/local-browser/device/revoke'){
    await this.revokeDesktop(d.owner,d.id);answer(res,200,{revoked:true});return true;
   }
   if(!d||d.closed||d.expiresAt<=Date.now()||((!d.durable||d.claimed)&&!await d.authorize())){if(d)this.disconnect(d);answer(res,401,{error:'local_browser_disconnected'});return true;}
   if(req.method==='POST'&&url.pathname==='/local-browser/ready'){
    if(d.mode==='desktop'){const consent=JSON.parse((await body(req,1024)).toString());if(consent.captureConsent!==true){answer(res,409,{error:'desktop_capture_consent_required'});return true;}d.control=consent.control===true;}
    if(d.claimed){answer(res,409,{error:'recording_in_progress'});return true;}
    d.ready=true;answer(res,200,{ready:true});return true;}
   if(req.method==='POST'&&url.pathname==='/local-browser/disconnect'){this.disconnect(d);answer(res,200,{disconnected:true});return true;}
   if(req.method==='POST'&&url.pathname==='/local-browser/poll'){
    if(!d.ready){answer(res,409,{error:'local_browser_sign_in_pending'});return true;}
    if(d.wake){answer(res,409,{error:'poll_in_progress'});return true;}
    if(!d.pending)await new Promise<void>(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);res.off('close',finish);delete d.wake;resolve();};const timer=setTimeout(finish,20000);d.wake=finish;res.once('close',finish);});
    if(res.destroyed)return true;
    if(d.closed){answer(res,401,{error:'local_browser_disconnected'});return true;}
    const pending=d.pending;
    if(pending?.sent){answer(res,200,{command:null});return true;}
    if(pending)pending.sent=true;
    answer(res,200,{command:pending?.command??null});return true;
   }
   const match=/^\/local-browser\/result\/([0-9a-f-]{36})(\/video)?$/.exec(url.pathname);
   if(req.method==='POST'&&match){
    const pending=d.pending;
    if(!pending||pending.command.id!==match[1]||!pending.sent){answer(res,409,{error:'stale_command'});return true;}
    if(match[2]){
     if(pending.command.method!=='stopRecording'||pending.video){answer(res,409,{error:'unexpected_video'});return true;}
     const video=await body(req,MAX_LOCAL_VIDEO);if(d.closed||d.pending!==pending)throw new Error('stale_command');pending.video=video;answer(res,200,{received:true});return true;
    }
    const input=JSON.parse((await body(req,MAX_LOCAL_JSON)).toString());
    if(d.closed||d.pending!==pending)throw new Error('stale_command');
    const value=decodeLocal(input.value) as Record<string,unknown>|undefined;
    if(value?.body==='desktop_upload'){
     if(!d.durable||!this.dataDir||pending.command.method!=='stopRecording'||value.captureId!==d.captureId)throw new Error('desktop_upload_not_allowed');
     value.body=await withRecorderStore(this.dataDir,db=>{
      const store=new DesktopUploadStore(db,this.dataDir!),id=String(value.captureId);
      const media=store.status(d!.owner,d!.id,id).media;
      if(!media)throw new Error('desktop_upload_metadata_required');
      // The durable upload manifest is authoritative, even if the Stop acknowledgment is retried.
      // What Toru did in the window (cursor path, clicks, actions) comes from the app; size and duration from the manifest.
      const reported=(key:string)=>Array.isArray(input.meta?.[key])?input.meta[key].slice(0,20000):[];
      const window=desktopWindow(input.meta?.desktopWindow);
      input.meta={captureViewport:{width:media.width,height:media.height},...(media.layers?{contentLayers:media.layers}:{}),...(window?{desktopWindow:window}:{}),recordingMode:'screencast',recordingElapsedMs:media.durationMs,pointerTrail:reported('pointerTrail'),pointerTelemetry:reported('pointerTelemetry'),semanticTimeline:reported('semanticTimeline'),identitySightings:reported('identitySightings')};
      value.contentType='video/mp4';value.redactionPassed=false;
      return readFile(store.completedFile(d!.owner,d!.id,id));
     });
     if(d.closed||d.pending!==pending)throw new Error('stale_command');
    }
    if(value?.body==='local_video_upload'){if(!pending.video)throw new Error('missing_video');value.body=pending.video;}
    clearTimeout(pending.timer);delete d.pending;
    if(input.error)pending.reject(new Error(['local_sign_in_required','local_navigation_blocked','local_method_forbidden'].includes(input.error)?input.error:'local_browser_action_failed'));
    else pending.resolve({value,meta:input.meta});
    if(pending.command.method==='dispose'){
     // A shared Mac stays ready for the next recording until the user stops sharing; only the session claim ends.
     if(d.durable){d.claimed=false;}else this.disconnect(d);
    }
    answer(res,200,{received:true});return true;
   }
   answer(res,404,{error:'not_found'});
  }catch{if(!res.headersSent)answer(res,400,{error:'local_request_invalid'});}
  return true;
 }
}
