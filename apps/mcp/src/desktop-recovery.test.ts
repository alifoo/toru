import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {Recorder,type RecorderOptions} from './recorder.js';
import {openRecorderStore} from './store/open.js';
import {DesktopDeviceStore} from './store/desktop-devices.js';
import {DesktopUploadStore} from './store/desktop-uploads.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'desktop-recovery-')),owner=randomUUID(),id=randomUUID();
 const db=await openRecorderStore(dir);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
 const device=new DesktopDeviceStore(db).register(owner,'Mac');
 const job={id,owner,status:'recording',createdAt:Date.now(),expiresAt:Date.now()+3600000,allowedOrigins:[],desktopDeviceId:device.deviceId,privacyMode:'user-approved-unredacted',rawFile:'raw.mp4'};
 db.connection.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(id,owner,job.status,job.createdAt,job.expiresAt,JSON.stringify(job));
 const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisomsynthetic capture')]);
 const uploads=new DesktopUploadStore(db,dir),args=[owner,device.deviceId,id] as const;
 await uploads.begin(...args,bytes.length,createHash('sha256').update(bytes).digest('hex'),{width:1280,height:720,durationMs:2500});
 await uploads.append(...args,0,bytes);await uploads.complete(...args);db.close();
 const finalized=vi.fn(),abandon=vi.fn();
 const options:RecorderOptions={dataDir:dir,encryptionKey:randomBytes(32),createContext:vi.fn(),render:vi.fn(async()=>Buffer.from('rendered')),
 lifecycle:()=>({admit:vi.fn(),usage:()=>({}),delivered:vi.fn(),abandon,captureFinalized:finalized,beforeAccountErase:async()=>{}})};
 let recorder=new Recorder(options);await recorder.initialize();
 cleanups.push(async()=>{await recorder.close();await rm(dir,{recursive:true,force:true});});
 return {dir,owner,id,device,bytes,args,finalized,abandon,get recorder(){return recorder;},async restart(){await recorder.close();recorder=new Recorder(options);await recorder.initialize();}};
}
it('publishes a completed upload into its original interrupted job and retries without extending retention',async()=>{
 const f=await fixture();expect(f.abandon).toHaveBeenCalledOnce();
 expect((await f.recorder.call(f.owner,'recording_status',{id:f.id})).structuredContent?.status).toBe('interrupted');
 const [a,b]=await Promise.all([f.recorder.recoverDesktopUpload(...f.args),f.recorder.recoverDesktopUpload(...f.args)]);
 expect(a.status).toBe('captured');expect(b).toEqual(a);expect(f.finalized).toHaveBeenCalledOnce();
 expect(await readFile(join(f.dir,'jobs',f.id,'raw.mp4'))).toEqual(f.bytes);
 expect(JSON.parse(await readFile(join(f.dir,'jobs',f.id,'observation.json'),'utf8'))).toMatchObject({width:1280,height:720,durationMs:2500,pointerTrail:[],idleRanges:[]});
 await f.restart();expect((await f.recorder.recoverDesktopUpload(...f.args)).expiresAt).toBe(a.expiresAt);
 expect(f.finalized).toHaveBeenCalledOnce();
 await f.recorder.call(f.owner,'recording_render',{id:f.id});
 await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id:f.id})).structuredContent?.status).toBe('completed'));
 expect((await f.recorder.recoverDesktopUpload(...f.args)).status).toBe('completed');
});
it('rejects the wrong owner, wrong device and revoked devices without publishing media',async()=>{
 const f=await fixture();
 await expect(f.recorder.recoverDesktopUpload(randomUUID(),f.device.deviceId,f.id)).rejects.toThrow('desktop_upload_not_allowed');
 await expect(f.recorder.recoverDesktopUpload(f.owner,randomUUID(),f.id)).rejects.toThrow('desktop_upload_not_allowed');
 const db=await openRecorderStore(f.dir);new DesktopDeviceStore(db).revoke(f.owner,f.device.deviceId);db.close();
 await expect(f.recorder.recoverDesktopUpload(...f.args)).rejects.toThrow('desktop_upload_not_allowed');
 await expect(readFile(join(f.dir,'jobs',f.id,'raw.mp4'))).rejects.toMatchObject({code:'ENOENT'});
});

it('retries a publication interrupted after raw linking and does not render unfinished publication',async()=>{
 const f=await fixture();
 const internals=f.recorder as unknown as {atomic(path:string,value:unknown):Promise<void>};
 const original=internals.atomic.bind(internals);
 const spy=vi.spyOn(internals,'atomic').mockImplementationOnce(async()=>{
  await expect(f.recorder.call(f.owner,'recording_render',{id:f.id})).rejects.toThrow('capacity_busy');
  throw new Error('disk write interrupted');
 });
 await expect(f.recorder.recoverDesktopUpload(...f.args)).rejects.toThrow('disk write interrupted');
 expect((await f.recorder.call(f.owner,'recording_status',{id:f.id,waitMs:0})).structuredContent?.status).toBe('interrupted');
 expect(await readFile(join(f.dir,'jobs',f.id,'desktop-upload.mp4'))).toEqual(f.bytes);
 spy.mockImplementation(original);await f.restart();
 expect((await f.recorder.recoverDesktopUpload(...f.args)).status).toBe('captured');
 expect(f.finalized).toHaveBeenCalledOnce();
});
it('rechecks revocation while publication is in flight',async()=>{
 const f=await fixture();
 const internals=f.recorder as unknown as {atomic(path:string,value:unknown):Promise<void>};
 const original=internals.atomic.bind(internals);
 vi.spyOn(internals,'atomic').mockImplementationOnce(async(path,value)=>{
  const db=await openRecorderStore(f.dir);new DesktopDeviceStore(db).revoke(f.owner,f.device.deviceId);db.close();
  await original(path,value);
 });
 await expect(f.recorder.recoverDesktopUpload(...f.args)).rejects.toThrow('desktop_upload_not_allowed');
 expect(f.finalized).not.toHaveBeenCalled();
 expect((await f.recorder.call(f.owner,'recording_status',{id:f.id,waitMs:0})).structuredContent?.status).toBe('interrupted');
 await expect(f.recorder.call(f.owner,'recording_render',{id:f.id})).rejects.toThrow('capture_unavailable');
});

it('requires authorized publication after a crash with raw and observation already written',async()=>{
 const f=await fixture();
 const db=await openRecorderStore(f.dir);
 const job=JSON.parse(String(db.connection.prepare('SELECT metadata FROM jobs WHERE id=?').get(f.id)!.metadata));
 job.desktopRecoveryPending=true;job.durationMs=2500;job.rawExpiresAt=job.expiresAt;
 db.connection.prepare('UPDATE jobs SET metadata=? WHERE id=?').run(JSON.stringify(job),f.id);db.close();
 await writeFile(join(f.dir,'jobs',f.id,'raw.mp4'),f.bytes);
 await writeFile(join(f.dir,'jobs',f.id,'observation.json'),JSON.stringify({width:1280,height:720,durationMs:2500}));
 await f.restart();
 await expect(f.recorder.call(f.owner,'recording_render',{id:f.id})).rejects.toThrow('capture_unavailable');
 expect((await f.recorder.recoverDesktopUpload(...f.args)).status).toBe('captured');
 await f.recorder.call(f.owner,'recording_render',{id:f.id});
 await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id:f.id,waitMs:0})).structuredContent?.status).toBe('completed'));
});

it('drains in-flight publication before account erasure and cannot resurrect its files',async()=>{
 const f=await fixture();
 const internals=f.recorder as unknown as {atomic(path:string,value:unknown):Promise<void>};
 const original=internals.atomic.bind(internals);
 let resume!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{resume=resolve;});
 const entry=new Promise<void>(resolve=>{entered=resolve;});
 vi.spyOn(internals,'atomic').mockImplementationOnce(async(path,value)=>{entered();await gate;await original(path,value);});
 const publication=f.recorder.recoverDesktopUpload(...f.args);
 const rejected=expect(publication).rejects.toThrow('service_draining');
 await entry;
 const deletion=f.recorder.deleteAccountData(f.owner);
 resume();await rejected;await deletion;
 await expect(readFile(join(f.dir,'jobs',f.id,'raw.mp4'))).rejects.toMatchObject({code:'ENOENT'});
 await expect(readFile(join(f.dir,'jobs',f.id,'desktop-upload.mp4'))).rejects.toMatchObject({code:'ENOENT'});
 const db=await openRecorderStore(f.dir);
 expect(db.connection.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)?.admission_status).toBe('deleted');
 expect(db.connection.prepare('SELECT count(*) n FROM jobs WHERE id=?').get(f.id)?.n).toBe(0);db.close();
});
