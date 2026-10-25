import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {RecorderDatabase} from './database.js';
import {DesktopDeviceStore} from './desktop-devices.js';
import {DesktopUploadStore} from './desktop-uploads.js';
import {DatabaseSync} from 'node:sqlite';
const media={width:1280,height:720,durationMs:15234};
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'toru-upload-')),path=join(dir,'recorder.sqlite'),id=randomUUID(),owner=randomUUID();
 let db=new RecorderDatabase(path);
 cleanups.push(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
 const device=new DesktopDeviceStore(db).register(owner,'Mac');
 const metadata={desktopDeviceId:device.deviceId,privacyMode:'user-approved-unredacted'};
 db.connection.prepare('INSERT INTO jobs(id,owner,status,created_at,expires_at,metadata) VALUES (?,?,?,?,?,?)').run(id,owner,'recording',Date.now(),Date.now()+3600000,JSON.stringify(metadata));
 const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisomsynthetic capture')]);
 const hash=createHash('sha256').update(bytes).digest('hex');
 return {dir,id,owner,deviceId:device.deviceId,bytes,hash,get db(){return db;},store:()=>new DesktopUploadStore(db,dir),restart(){db.close();db=new RecorderDatabase(path);}};
}
it('resumes after restart and lost acknowledgment without duplicating or changing bytes',async()=>{
 const f=await fixture(),args=[f.owner,f.deviceId,f.id] as const;
 await f.store().begin(...args,f.bytes.length,f.hash,media);
 await f.store().append(...args,0,f.bytes.subarray(0,12));f.restart();
 expect((await f.store().begin(...args,f.bytes.length,f.hash,media)).received).toBe(12);
 expect((await f.store().append(...args,0,f.bytes.subarray(0,12))).received).toBe(12);
 await expect(f.store().append(...args,0,Buffer.from('changed'))).rejects.toThrow('desktop_chunk_conflict');
 await expect(f.store().append(...args,13,f.bytes.subarray(12))).rejects.toThrow('desktop_chunk_offset_invalid');
 await f.store().append(...args,12,f.bytes.subarray(12));
 await f.store().complete(...args);f.restart();
 expect((await f.store().complete(...args)).complete).toBe(true);
 expect(f.store().status(...args).media).toEqual(media);
 expect(await readFile(f.store().completedFile(...args))).toEqual(f.bytes);
 expect((await f.store().append(...args,0,f.bytes.subarray(0,12))).complete).toBe(true);
});
it('recovers rename-before-receipt crashes and enforces ownership/revocation',async()=>{
 const f=await fixture(),args=[f.owner,f.deviceId,f.id] as const;
 await f.store().begin(...args,f.bytes.length,f.hash,media);await f.store().append(...args,0,f.bytes);
 await rename(join(f.dir,'jobs',f.id,'desktop-upload.partial'),join(f.dir,'jobs',f.id,'desktop-upload.mp4'));f.restart();
 expect((await f.store().complete(...args)).complete).toBe(true);
 expect(()=>f.store().status('other',f.deviceId,f.id)).toThrow('desktop_upload_not_allowed');
 new DesktopDeviceStore(f.db).revoke(f.owner,f.deviceId);
 expect(()=>f.store().status(...args)).toThrow('desktop_upload_not_allowed');
});
it('rejects changed manifests, incomplete content and checksum failures',async()=>{
 const f=await fixture(),args=[f.owner,f.deviceId,f.id] as const;
 await f.store().begin(...args,f.bytes.length,'0'.repeat(64),media);
 await expect(f.store().begin(...args,f.bytes.length,f.hash,media)).rejects.toThrow('desktop_upload_conflict');
 await expect(f.store().complete(...args)).rejects.toThrow('desktop_upload_incomplete');
 await f.store().append(...args,0,f.bytes);
 await expect(f.store().complete(...args)).rejects.toThrow('desktop_upload_checksum_invalid');
 expect(f.store().status(...args).complete).toBe(false);
});
it('keeps finalized media metadata immutable through retries and rejects invalid manifests',async()=>{
 const f=await fixture(),args=[f.owner,f.deviceId,f.id] as const;
 for(const invalid of [undefined,{...media,width:0},{...media,height:2161},{...media,width:1.5},{...media,durationMs:0},{...media,durationMs:305001},{...media,durationMs:Infinity}]){
  await expect(f.store().begin(...args,f.bytes.length,f.hash,invalid)).rejects.toThrow();
 }
 expect(f.db.connection.prepare('SELECT count(*) n FROM desktop_uploads').get()?.n).toBe(0);
 await f.store().begin(...args,f.bytes.length,f.hash,media);
 await f.store().append(...args,0,f.bytes);await f.store().complete(...args);f.restart();
 for(const field of ['width','height','durationMs'] as const){
  await expect(f.store().begin(...args,f.bytes.length,f.hash,{...media,[field]:media[field]+1})).rejects.toThrow('desktop_upload_conflict');
 }
 // JSON field order is not part of the manifest identity.
 expect((await f.store().begin(...args,f.bytes.length,f.hash,{durationMs:media.durationMs,height:media.height,width:media.width})).media).toEqual(media);
});
it('migrates existing uploads without inventing metadata and permits only an authorized matching backfill',async()=>{
 const f=await fixture(),args=[f.owner,f.deviceId,f.id] as const;
 await f.store().begin(...args,f.bytes.length,f.hash,media);
 await f.store().append(...args,0,f.bytes);await f.store().complete(...args);
 f.db.close();
 const old=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 old.exec('DROP TABLE demo_accounts; ALTER TABLE desktop_uploads DROP COLUMN media_metadata; PRAGMA user_version=12;');old.close();
 f.restart();
 expect(f.store().status(...args)).toMatchObject({media:null,complete:true,received:f.bytes.length});
 await expect(f.store().begin('other',f.deviceId,f.id,f.bytes.length,f.hash,media)).rejects.toThrow('desktop_upload_not_allowed');
 await expect(f.store().begin(...args,f.bytes.length,'0'.repeat(64),media)).rejects.toThrow('desktop_upload_conflict');
 expect(f.store().status(...args).media).toBeNull();
 expect((await f.store().begin(...args,f.bytes.length,f.hash,media)).media).toEqual(media);
 f.restart();
 expect(f.store().status(...args).media).toEqual(media);
 expect(await readFile(f.store().completedFile(...args))).toEqual(f.bytes);
});
