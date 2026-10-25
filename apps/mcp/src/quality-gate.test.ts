import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {Recorder,type RecorderOptions} from './recorder.js';
import {openRecorderStore} from './store/open.js';
import {DesktopDeviceStore} from './store/desktop-devices.js';
import {DesktopUploadStore} from './store/desktop-uploads.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
// A captured desktop job (published through the recovery path) is the cheapest real job that can be rendered.
async function fixture(verdicts:Array<{passed:boolean;reasons:string[]}>){
 const dir=await mkdtemp(join(tmpdir(),'quality-gate-')),owner=randomUUID(),id=randomUUID();
 const db=await openRecorderStore(dir);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
 const device=new DesktopDeviceStore(db).register(owner,'Mac');
 const job={id,owner,status:'recording',createdAt:Date.now(),expiresAt:Date.now()+3600000,allowedOrigins:[],desktopDeviceId:device.deviceId,privacyMode:'user-approved-unredacted',rawFile:'raw.mp4'};
 db.connection.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(id,owner,job.status,job.createdAt,job.expiresAt,JSON.stringify(job));
 const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisomsynthetic capture')]);
 const uploads=new DesktopUploadStore(db,dir),args=[owner,device.deviceId,id] as const;
 await uploads.begin(...args,bytes.length,createHash('sha256').update(bytes).digest('hex'),{width:1280,height:720,durationMs:2500});
 await uploads.append(...args,0,bytes);await uploads.complete(...args);db.close();
 const delivered=vi.fn(),abandon=vi.fn(),beforeRender=vi.fn();
 const assess=vi.fn(async()=>({...verdicts.shift()!,metrics:{}}));
 const options:RecorderOptions={dataDir:dir,encryptionKey:randomBytes(32),createContext:vi.fn(),render:vi.fn(async()=>Buffer.from('rendered-bytes')),assessQuality:assess,
  lifecycle:()=>({admit:vi.fn(),usage:()=>({}),delivered,abandon,beforeRender,beforeAccountErase:async()=>{}})};
 const recorder=new Recorder(options);await recorder.initialize();
 cleanups.push(async()=>{await recorder.close();await rm(dir,{recursive:true,force:true});});
 await recorder.recoverDesktopUpload(...args);
 // initialize() abandons the never-captured 'recording' job before recovery; only render-time calls matter here.
 abandon.mockClear();
 return {dir,owner,id,recorder,delivered,abandon,beforeRender,assess};
}
async function settled(f:Awaited<ReturnType<typeof fixture>>){
 let status:Record<string,unknown>={};
 await vi.waitFor(async()=>{status=(await f.recorder.call(f.owner,'recording_status',{id:f.id})).structuredContent as Record<string,unknown>;expect(status.status).not.toBe('rendering');},{timeout:5000});
 return status;
}
it('keeps a video that fails the delivery check unbilled and undelivered, then delivers it on explicit acceptance',async()=>{
 const f=await fixture([{passed:false,reasons:['blank_frames']},{passed:false,reasons:['blank_frames']}]);
 await f.recorder.call(f.owner,'recording_render',{id:f.id,requestId:randomUUID()});
 const flagged=await settled(f);
 expect(flagged).toMatchObject({status:'captured',errorCode:'quality_review',needsReview:true});
 expect(String(flagged.instruction)).toContain('blank_frames');
 expect(f.delivered).not.toHaveBeenCalled();expect(f.abandon).toHaveBeenCalled();
 await expect(readFile(join(f.dir,'jobs',f.id,'video.mp4'))).rejects.toMatchObject({code:'ENOENT'});
 await f.recorder.call(f.owner,'recording_render',{id:f.id,requestId:randomUUID(),acceptReview:true});
 const accepted=await settled(f);
 expect(accepted.status).toBe('completed');expect((accepted.qualityReview as {accepted?:boolean}).accepted).toBe(true);
 expect(f.delivered).toHaveBeenCalledOnce();
 expect(await readFile(join(f.dir,'jobs',f.id,'video.mp4'),'utf8')).toBe('rendered-bytes');
});
it('delivers and charges normally when the check passes',async()=>{
 const f=await fixture([{passed:true,reasons:[]}]);
 await f.recorder.call(f.owner,'recording_render',{id:f.id,requestId:randomUUID()});
 const done=await settled(f);
 expect(done.status).toBe('completed');expect(f.delivered).toHaveBeenCalledOnce();expect(f.abandon).not.toHaveBeenCalled();
 expect(f.assess).toHaveBeenCalledOnce();
});
