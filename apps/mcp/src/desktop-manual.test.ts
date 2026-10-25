import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {LocalBrowserBridge} from './local-browser.js';
import {Recorder,type RecorderOptions} from './recorder.js';
import {openRecorderStore} from './store/open.js';
import {DesktopDeviceStore} from './store/desktop-devices.js';

// Manual Record in the Mac app: real HTTP handlers, SQLite and Recorder, without a listening socket or agent session.
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
 const dir=await mkdtemp(join(tmpdir(),'toru-desktop-manual-')),owner=randomUUID();
 const db=await openRecorderStore(dir);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());db.close();
 const admit=vi.fn(()=>({version:'test',sessionMs:600000,captureMs:300000,rawRetentionMs:3600000,videoRetentionMs:7200000})),abandon=vi.fn(),delivered=vi.fn(),beforeRender=vi.fn(),finalized=vi.fn();
 let bridge:LocalBrowserBridge;
 const options:RecorderOptions={dataDir:dir,encryptionKey:randomBytes(32),createContext:vi.fn(),render:vi.fn(async()=>Buffer.from('rendered')),
  createLocalContext:(o,i,opts)=>bridge.createContext(o,i,opts),
  lifecycle:()=>({admit,usage:()=>({}),delivered,abandon,beforeRender,captureFinalized:finalized,beforeAccountErase:async()=>{}})};
 let recorder=new Recorder(options);await recorder.initialize();
 bridge=new LocalBrowserBridge(dir,(o,d,id)=>recorder.recoverDesktopUpload(o,d,id),(o,d,r)=>recorder.beginManualDesktopCapture(o,d,r));
 cleanups.push(async()=>{bridge.close();await recorder.close();await rm(dir,{recursive:true,force:true});});
 const pair=bridge.pair(owner,'https://toru.tools',async()=>true,'desktop');
 const paired=await post(bridge,'pair',{code:pair.pairingCode,persistent:true,deviceName:'Mac'});
 expect(paired.status).toBe(200);
 const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisomsynthetic capture')]);
 return {dir,owner,bytes,credentials:paired.value,admit,abandon,delivered,beforeRender,finalized,get recorder(){return recorder;},get bridge(){return bridge;},
  async restart(){bridge.close();await recorder.close();recorder=new Recorder(options);await recorder.initialize();bridge=new LocalBrowserBridge(dir,(o,d,id)=>recorder.recoverDesktopUpload(o,d,id),(o,d,r)=>recorder.beginManualDesktopCapture(o,d,r));}};
}
async function upload(f:Awaited<ReturnType<typeof fixture>>,id:string,token:string){
 const sha256=createHash('sha256').update(f.bytes).digest('hex');
 expect((await post(f.bridge,`desktop-upload/${id}/begin`,{bytes:f.bytes.length,sha256,media:{width:1280,height:720,durationMs:2500}},token)).status).toBe(200);
 expect((await post(f.bridge,`desktop-upload/${id}/chunk`,f.bytes,token,{'x-toru-offset':'0'})).status).toBe(200);
 expect((await post(f.bridge,`desktop-upload/${id}/complete`,{},token)).status).toBe(200);
 return post(f.bridge,`desktop-upload/${id}/publish`,{},token);
}

it('records manually through the same admitted job, upload and single-charge render path as an agent session',async()=>{
 const f=await fixture(),token=f.credentials.accessToken,requestId=randomUUID();
 const begun=await post(f.bridge,'desktop-recording/begin',{requestId},token);
 expect(begun.status).toBe(200);expect(begun.value).toMatchObject({status:'interrupted',errorCode:'desktop_upload_pending',captureMs:300000});
 const id=String(begun.value.id);
 expect(f.admit).toHaveBeenCalledOnce();expect((f.admit.mock.calls[0] as unknown as unknown[])[1]).toBe(requestId);
 // Idempotent begin after a lost response returns the same job; a different device cannot reuse the request.
 expect((await post(f.bridge,'desktop-recording/begin',{requestId},token)).value.id).toBe(id);
 expect(f.admit).toHaveBeenCalledOnce();
 const agentView=(await f.recorder.call(f.owner,'recording_status',{id})).structuredContent as Record<string,unknown>;
 expect(agentView.errorCode).toBe('desktop_upload_pending');expect(String(agentView.instruction)).toContain('Mac app');
 // Backend restart while the Mac is still recording: the admitted job survives and is not abandoned.
 await f.restart();
 expect(f.abandon).not.toHaveBeenCalled();
 const published=await upload(f,id,token);
 expect(published.status).toBe(200);expect(published.value.status).toBe('captured');expect(f.finalized).toHaveBeenCalledOnce();
 expect(await readFile(join(f.dir,'jobs',id,'raw.mp4'))).toEqual(f.bytes);
 // Publication retry after a lost response is idempotent.
 expect((await post(f.bridge,`desktop-upload/${id}/publish`,{},token)).value.status).toBe('captured');
 await f.recorder.call(f.owner,'recording_render',{id});
 await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id})).structuredContent?.status).toBe('completed'));
 expect(f.beforeRender).toHaveBeenCalledOnce();expect(f.delivered).toHaveBeenCalledOnce();expect(f.abandon).not.toHaveBeenCalled();
});

it('refuses manual capture for revoked devices, malformed requests and unauthenticated callers',async()=>{
 const f=await fixture(),token=f.credentials.accessToken;
 expect((await post(f.bridge,'desktop-recording/begin',{},token)).status).toBe(400);
 expect((await post(f.bridge,'desktop-recording/begin',{requestId:randomUUID()})).status).toBe(401);
 const db=await openRecorderStore(f.dir);new DesktopDeviceStore(db).revoke(f.owner,f.credentials.deviceId);db.close();
 const revoked=await post(f.bridge,'desktop-recording/begin',{requestId:randomUUID()},token);
 expect(revoked.status).toBe(401);
 expect(f.admit).not.toHaveBeenCalled();
});

it('releases the reservation only when an unfinished manual capture expires',async()=>{
 const f=await fixture(),token=f.credentials.accessToken;
 const begun=await post(f.bridge,'desktop-recording/begin',{requestId:randomUUID()},token);
 const id=String(begun.value.id);
 const db=await openRecorderStore(f.dir);
 db.connection.prepare('UPDATE jobs SET expires_at=?, metadata=json_set(metadata,\'$.expiresAt\',?) WHERE id=?').run(Date.now()-1,Date.now()-1,id);db.close();
 await f.restart();
 await f.recorder.call(f.owner,'recording_status',{id:randomUUID()}).catch(()=>undefined);
 await vi.waitFor(()=>expect(f.abandon).toHaveBeenCalledOnce());
 expect((await post(f.bridge,`desktop-upload/${id}/begin`,{bytes:1,sha256:'a'.repeat(64),media:{width:2,height:2,durationMs:1}},token)).status).not.toBe(200);
});

it('marks an agent-opened desktop capture interrupted as soon as the Mac disconnects on its own',{timeout:20000},async()=>{
 const f=await fixture(),token=f.credentials.accessToken,id=f.credentials.deviceId;
 expect((await post(f.bridge,'device/resume',{},token)).status).toBe(200);
 expect((await post(f.bridge,'ready',{captureConsent:true},token)).status).toBe(200);
 await f.bridge.bindDesktop(f.owner,id,async()=>true);
 // Device side: answer the currentUrl probe (session_open) and the startRecording command, then stop serving.
 const serve=async()=>{for(;;){const r=(await post(f.bridge,'poll',{},token));if(r.status!==200)return;const c=r.value.command;if(!c)continue;
  await post(f.bridge,'result/'+c.id,{value:c.method==='currentUrl'?'https://toru.tools':null,meta:{captureViewport:{width:1280,height:720},recordingMode:'screencast',recordingElapsedMs:0,pointerTrail:[],pointerTelemetry:[],semanticTimeline:[]}},token);
  if(c.method==='startRecording')return;}};
 const serving=serve();
 const opened=await f.recorder.call(f.owner,'session_open',{url:'https://toru.tools',localConnectionId:id,requestId:randomUUID()});
 const jobId=String(opened.structuredContent?.id);
 await f.recorder.call(f.owner,'recording_start',{id:jobId});await serving;
 expect((await f.recorder.call(f.owner,'recording_status',{id:jobId})).structuredContent?.status).toBe('recording');
 // The Mac stops by itself (window closed / sleep) and tells the bridge.
 expect((await post(f.bridge,'disconnect',{},token)).status).toBe(200);
 await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id:jobId})).structuredContent?.status).toBe('interrupted'),{timeout:5000});
 expect(f.abandon).toHaveBeenCalledOnce();
});
