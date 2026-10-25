import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {LocalBrowserBridge} from './local-browser.js';
import {openRecorderStore} from './store/open.js';

// Exercise the real HTTP handler and SQLite, without a listening socket.
async function post(bridge:LocalBrowserBridge,path:string,value:unknown={},token?:string,headers:Record<string,string>={}){
 const req=Readable.from([Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value))]) as IncomingMessage;
 req.method='POST';req.headers={...(token?{authorization:`Bearer ${token}`} :{}),...headers};
 const res=new EventEmitter() as ServerResponse;
 let status=0,body='';
 res.writeHead=((code:number)=>{status=code;return res;}) as ServerResponse['writeHead'];
 res.end=((chunk:string)=>{body=chunk;return res;}) as ServerResponse['end'];
 await bridge.http(req,res,new URL('https://mcp.toru.tools/local-browser/'+path));
 return {status,value:JSON.parse(body)};
}
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'toru-desktop-connection-'));
 const db=await openRecorderStore(dir);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run('owner',Date.now());db.close();
 let bridge=new LocalBrowserBridge(dir);
 cleanups.push(async()=>{bridge.close();await rm(dir,{recursive:true,force:true});});
 const pair=bridge.pair('owner','https://toru.tools',async()=>true,'desktop');
 const response=await post(bridge,'pair',{code:pair.pairingCode,persistent:true,deviceName:'Mac'});
 expect(response.status).toBe(200);
 return {dir,get bridge(){return bridge;},pair,credentials:response.value,restart(){bridge.close();bridge=new LocalBrowserBridge(dir);}};
}
const options={viewport:{width:1280,height:720},allowedOrigins:['https://toru.tools'],sessionState:Buffer.from('{}'),onNavigation:vi.fn(),allowDownload:false as const,allowPopup:false as const};
it('reconnects after restart with the same identity but requires new consent and MCP authorization',async()=>{
 const f=await fixture(),id=f.pair.connectionId;
 expect(f.credentials.deviceId).toBe(id);
 expect((await post(f.bridge,'pair',{code:f.pair.pairingCode,persistent:true})).status).toBe(401);
 f.restart();
 const refresh=await post(f.bridge,'device/refresh',{refreshToken:f.credentials.refreshToken});
 expect(refresh.status).toBe(200);const token=refresh.value.accessToken;
 expect((await post(f.bridge,'device/resume',{},f.credentials.accessToken)).status).toBe(401);
 expect((await post(f.bridge,'device/resume',{},token)).status).toBe(200);
 expect(f.bridge.status('owner',id).status).not.toBe('ready');
 expect((await post(f.bridge,'ready',{},token)).status).toBe(409);
 await post(f.bridge,'ready',{captureConsent:true},token);
 await expect(f.bridge.createContext('owner',id,options)).rejects.toThrow('local_browser_disconnected');
 await expect(f.bridge.bindDesktop('other',id,async()=>true)).rejects.toThrow('local_browser_not_found');
 await f.bridge.bindDesktop('owner',id,async()=>true);
 const driver=await f.bridge.createContext('owner',id,options);
 const disposing=driver.dispose();const command=(await post(f.bridge,'poll',{},token)).value.command;
 expect(command.method).toBe('dispose');
 await post(f.bridge,'result/'+command.id,{value:null},token);await disposing;
 // The share stays on after a recording: the Mac is ready for the next session without a new approval.
 expect((await f.bridge.desktopDevices('owner'))[0]?.status).toBe('ready');
 await expect(driver.startRecording()).rejects.toThrow('local_browser_disconnected');
 await f.bridge.bindDesktop('owner',id,async()=>true);
 await f.bridge.createContext('owner',id,options);
 await expect(driver.startRecording()).rejects.toThrow('local_browser_disconnected');
});
it('revokes the durable device and rejects both access and refresh credentials',async()=>{
 const f=await fixture();
 expect(await f.bridge.revokeDesktop('other',f.pair.connectionId)).toBe(false);
 expect((await post(f.bridge,'device/revoke',{},f.credentials.accessToken)).status).toBe(200);
 expect((await post(f.bridge,'device/resume',{},f.credentials.accessToken)).status).toBe(401);
 expect((await post(f.bridge,'device/refresh',{refreshToken:f.credentials.refreshToken})).status).toBe(401);
 expect((await f.bridge.desktopDevices('owner'))[0]?.status).toBe('revoked');
});

it.each([{width:1280,height:720},{width:180,height:1080},{width:320,height:200}])('delivers a chunked capture with viewport $width × $height only to its matching pending stop command',async(viewport)=>{
 const f=await fixture(),id=randomUUID(),token=f.credentials.accessToken;
 const db=await openRecorderStore(f.dir);
 db.connection.prepare('INSERT INTO jobs(id,owner,status,created_at,expires_at,metadata) VALUES (?,?,?,?,?,?)').run(id,'owner','recording',Date.now(),Date.now()+3600000,JSON.stringify({desktopDeviceId:f.pair.connectionId,privacyMode:'user-approved-unredacted'}));db.close();
 await post(f.bridge,'ready',{captureConsent:true},token);
 const driver=await f.bridge.createContext('owner',f.pair.connectionId,{...options,captureId:id});
 const started=driver.startRecording();const start=(await post(f.bridge,'poll',{},token)).value.command;
 expect(start.args).toEqual([{captureId:id}]);await post(f.bridge,'result/'+start.id,{value:null},token);await started;
 const stopped=driver.stopRecording();const stop=(await post(f.bridge,'poll',{},token)).value.command;
 const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisomsynthetic capture')]);
 const path='desktop-upload/'+id+'/';
 expect((await post(f.bridge,path+'begin',{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media:{...viewport,durationMs:15234}},token)).status).toBe(200);
 expect((await post(f.bridge,path+'chunk',bytes,token,{'x-toru-offset':'0'})).status).toBe(200);
 expect((await post(f.bridge,path+'complete',{},token)).value.complete).toBe(true);
 expect((await post(f.bridge,'result/'+stop.id,{value:{body:'desktop_upload',captureId:randomUUID(),contentType:'video/mp4',redactionPassed:false}},token)).status).toBe(400);
 await post(f.bridge,'result/'+stop.id,{value:{body:'desktop_upload',captureId:id,contentType:'video/webm',redactionPassed:true},meta:{recordingElapsedMs:99999,captureViewport:{width:1920,height:1080}}},token);
 const result=await stopped;
 expect(result.body).toEqual(bytes);
 expect(result.contentType).toBe('video/mp4');
 expect(result.redactionPassed).toBe(false);
 expect(driver.captureViewport).toEqual(viewport);
 expect(driver.recordingDurationMs).toBe(15234);
});

it('asks the Mac for a window size preset and keeps what it reports about the window',async()=>{
 const f=await fixture(),id=randomUUID(),token=f.credentials.accessToken;
 const db=await openRecorderStore(f.dir);
 db.connection.prepare('INSERT INTO jobs(id,owner,status,created_at,expires_at,metadata) VALUES (?,?,?,?,?,?)').run(id,'owner','recording',Date.now(),Date.now()+3600000,JSON.stringify({desktopDeviceId:f.pair.connectionId,privacyMode:'user-approved-unredacted'}));db.close();
 await post(f.bridge,'ready',{captureConsent:true,control:true},token);
 await f.bridge.bindDesktop('owner',f.pair.connectionId,async()=>true,'1440x900');
 const driver=await f.bridge.createContext('owner',f.pair.connectionId,{...options,captureId:id}) as Awaited<ReturnType<LocalBrowserBridge['createContext']>>&{desktopWindow?:unknown};
 const started=driver.startRecording();const start=(await post(f.bridge,'poll',{},token)).value.command;
 expect(start.args).toEqual([{captureId:id,windowSize:'1440x900'}]);
 await post(f.bridge,'result/'+start.id,{value:null,meta:{captureViewport:{width:2304,height:1440},desktopWindow:{requested:'1440x900',width:1440,height:900,resized:true,extra:'dropped'}}},token);await started;
 expect(driver.desktopWindow).toEqual({requested:'1440x900',width:1440,height:900,resized:true});
 const stopped=driver.stopRecording();const stop=(await post(f.bridge,'poll',{},token)).value.command;
 const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisomsynthetic capture')]);
 const path='desktop-upload/'+id+'/';
 expect((await post(f.bridge,path+'begin',{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media:{width:2304,height:1440,durationMs:15234}},token)).status).toBe(200);
 expect((await post(f.bridge,path+'chunk',bytes,token,{'x-toru-offset':'0'})).status).toBe(200);
 expect((await post(f.bridge,path+'complete',{},token)).value.complete).toBe(true);
 // At Stop the window is back at its own size: the report says so.
 await post(f.bridge,'result/'+stop.id,{value:{body:'desktop_upload',captureId:id,contentType:'video/mp4',redactionPassed:false},meta:{desktopWindow:{requested:'1440x900',width:1440,height:900,resized:true,restored:true}}},token);
 await stopped;
 expect(driver.desktopWindow).toEqual({requested:'1440x900',width:1440,height:900,resized:true,restored:true});
 expect(driver.captureViewport).toEqual({width:2304,height:1440});
});

it('defaults the window preset to 1920x1080 and works with a Mac that reports nothing about the window',async()=>{
 const f=await fixture(),id=randomUUID(),token=f.credentials.accessToken;
 await post(f.bridge,'ready',{captureConsent:true},token);
 await f.bridge.bindDesktop('owner',f.pair.connectionId,async()=>true);
 const driver=await f.bridge.createContext('owner',f.pair.connectionId,{...options,captureId:id}) as Awaited<ReturnType<LocalBrowserBridge['createContext']>>&{desktopWindow?:unknown};
 const started=driver.startRecording();const start=(await post(f.bridge,'poll',{},token)).value.command;
 expect(start.args).toEqual([{captureId:id,windowSize:'1920x1080'}]);
 // A Mac before 0.4.2 ignores windowSize and sends no desktopWindow; a malformed one is dropped, never fatal.
 await post(f.bridge,'result/'+start.id,{value:null,meta:{captureViewport:{width:1280,height:720},desktopWindow:{width:'wide'}}},token);
 await expect(started).resolves.toBeNull();
 expect(driver.desktopWindow).toBeUndefined();
 expect(driver.captureViewport).toEqual({width:1280,height:720});
});

it('keeps an idle durable Mac leased while it polls and refreshes before credential expiry',async()=>{
 const f=await fixture(),id=f.pair.connectionId;
 vi.useFakeTimers({toFake:['Date']});cleanups.push(async()=>{vi.useRealTimers();});
 const start=Date.now();
 let token=f.credentials.accessToken;
 expect((await post(f.bridge,'device/resume',{},token)).status).toBe(200);
 expect((await post(f.bridge,'ready',{captureConsent:true},token)).status).toBe(200);
 for(const minutes of [12,24,36,48]){
  vi.setSystemTime(start+minutes*60000);
  // The Mac rotates its credential ahead of the 15-minute access expiry without a capture command.
  const rotated=await post(f.bridge,'device/refresh',{refreshToken:f.credentials.refreshToken});
  if(rotated.status===200){f.credentials.refreshToken=rotated.value.refreshToken;token=rotated.value.accessToken;}
  expect(rotated.status).toBe(200);
  expect((await post(f.bridge,'ready',{captureConsent:true},token)).status).toBe(200);
  expect(f.bridge.status('owner',id).status).toBe('ready');
 }
 expect((await f.bridge.desktopDevices('owner'))[0]?.status).toBe('ready');
 // Without polling or refresh, the lease still lapses.
 vi.setSystemTime(start+48*60000+31*60000);
 expect((await post(f.bridge,'ready',{captureConsent:true},token)).status).toBe(401);
});

it('records only scrubbed opt-in diagnostics and honors the desktop-sessions disable flag',async()=>{
 const f=await fixture(),token=f.credentials.accessToken;
 expect((await post(f.bridge,'diagnostics',{event:'capture_failed',code:'scstream_3815',appVersion:'0.1.0'},token)).value).toEqual({recorded:true});
 expect((await post(f.bridge,'diagnostics',{event:'Bad Event',code:'x'},token)).status).toBe(400);
 expect((await post(f.bridge,'diagnostics',{event:'upload_failed',code:'<script>',appVersion:'../x'},token)).value).toEqual({recorded:true});
 expect((await post(f.bridge,'diagnostics',{event:'upload_failed'})).status).toBe(401);
 const report=f.bridge.diagnostics();
 expect(report.counts).toEqual({'capture_failed:scstream_3815':1,'upload_failed:unclassified':1});
 expect(report.recent.map(r=>r.appVersion)).toEqual(['0.1.0','unknown']);
 expect(JSON.stringify(report)).not.toContain('script');
 f.bridge.desktopEnabled=false;
 expect(()=>f.bridge.pair('owner','https://toru.tools',async()=>true,'desktop')).toThrow('desktop_sessions_disabled');
 expect((await post(f.bridge,'device/resume',{},token)).status).toBe(503);
 expect((await post(f.bridge,'desktop-recording/begin',{requestId:'7e0d0b2c-0d1e-4a7b-9c2d-5f6a7b8c9d0e'},token)).status).toBe(503);
 // Existing uploads of already captured media are still accepted while new sessions are off.
 expect((await post(f.bridge,'desktop-upload/7e0d0b2c-0d1e-4a7b-9c2d-5f6a7b8c9d0e/status',{},token)).status).not.toBe(503);
 expect(f.bridge.pair('owner','https://toru.tools',async()=>true).status).toBe('waiting_for_companion');
});

it('negotiates the Mac app version: old apps get 426 with update info, uploads of existing captures keep working',async()=>{
 const f=await fixture(),token=f.credentials.accessToken;
 const req=(path:string,version?:string,value:unknown={})=>post(f.bridge,path,value,token,version?{'x-toru-app-version':version}:{});
 expect((await post(f.bridge,'version')).status).toBe(200);
 f.bridge.minimumAppVersion='0.2.0';f.bridge.latestAppVersion='0.3.0';
 const old=await req('device/refresh','0.1.9',{refreshToken:f.credentials.refreshToken});
 expect(old.status).toBe(426);expect(old.value).toMatchObject({error:'app_update_required',minimumAppVersion:'0.2.0',latestAppVersion:'0.3.0'});
 expect((await req('device/resume',undefined)).status).toBe(426);
 expect((await req('device/resume','0.2.0')).status).toBe(200);
 expect((await req('desktop-recording/begin','0.1.0',{requestId:'7e0d0b2c-0d1e-4a7b-9c2d-5f6a7b8c9d0e'})).status).toBe(426);
 // Completing or publishing an upload that already began is never blocked by a version bump.
 expect((await req('desktop-upload/7e0d0b2c-0d1e-4a7b-9c2d-5f6a7b8c9d0e/status','0.1.0')).status).not.toBe(426);
 expect((await req('device/revoke','0.1.0')).status).toBe(200);
});

it('notifies the recorder-side driver when a claimed Mac disconnects on its own',async()=>{
 const f=await fixture(),id=f.pair.connectionId,token=f.credentials.accessToken;
 await post(f.bridge,'device/resume',{},token);await post(f.bridge,'ready',{captureConsent:true},token);
 await f.bridge.bindDesktop('owner',id,async()=>true);
 const driver=await f.bridge.createContext('owner',id,options) as unknown as {onDisconnect(cb:()=>void):void;startRecording():Promise<unknown>};
 let fired=0;driver.onDisconnect(()=>{fired++;});
 expect((await post(f.bridge,'disconnect',{},token)).status).toBe(200);
 expect(fired).toBe(1);
 await expect(driver.startRecording()).rejects.toThrow('local_browser_disconnected');
 // A later disconnect of an unclaimed device does not re-fire.
 await post(f.bridge,'device/resume',{},token);await post(f.bridge,'disconnect',{},token);expect(fired).toBe(1);
});

it('lets the agent list and choose the Mac source through the command channel',async()=>{
 const f=await fixture(),id=f.pair.connectionId,token=f.credentials.accessToken;
 await post(f.bridge,'device/resume',{},token);await post(f.bridge,'ready',{captureConsent:true},token);
 const serve=(async()=>{for(let i=0;i<2;i++){const c=(await post(f.bridge,'poll',{},token)).value.command;
  const value=c.method==='listSources'?{sources:[{id:'window-1',title:'Helium — Acme',kind:'window',width:1200,height:800,selected:false},{id:'display-1',title:'Entire display 1',kind:'display',width:1920,height:1080,selected:true}],selected:'display-1'}
   :{selected:'window-1',title:'Helium — Acme',width:1200,height:800};
  await post(f.bridge,'result/'+c.id,{value},token);}})();
 const listed=await f.bridge.desktopSources('owner',id);
 expect(listed.selected).toBe('display-1');expect((listed.sources as Array<{id:string}>).map(s=>s.id)).toEqual(['window-1','display-1']);
 const chosen=await f.bridge.desktopSelectSource('owner',id,'window-1');
 expect(chosen).toMatchObject({selected:'window-1',title:'Helium — Acme'});
 await serve;
 await expect(f.bridge.desktopSources('other',id)).rejects.toThrow('local_browser_not_found');
});
