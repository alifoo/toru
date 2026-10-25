import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,rename,stat,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import type {RecorderDatabase} from './database.js';

export const desktopChunkBytes=4*1024*1024;
const maxBytes=256*1024*1024;
const fraction=z.number().finite().min(-0.01).max(1.01);
/** Where the shared window and its menus were inside the recorded region, over time (fractions of it). */
export const desktopLayersSchema=z.object({
 samples:z.array(z.object({
  atMs:z.number().int().min(0).max(305000),
  rects:z.array(z.object({x:fraction,y:fraction,width:fraction,height:fraction,radius:z.number().finite().min(0).max(0.2),kind:z.enum(['window','popup'])}).strict()).max(16),
 }).strict()).max(2000),
}).strict();
export const desktopMediaSchema=z.object({
 width:z.number().int().positive().max(3840),
 height:z.number().int().positive().max(2160),
 durationMs:z.number().int().positive().max(305000),
 layers:desktopLayersSchema.optional(),
}).strict();
export type DesktopMedia=z.infer<typeof desktopMediaSchema>;
type Receipt={captureId:string;bytes:number;received:number;sha256:string;complete:boolean;chunkBytes:number;media:DesktopMedia|null};
const pending=new Map<string,Promise<unknown>>();
async function serialized<T>(key:string,work:()=>Promise<T>):Promise<T>{
 const previous=pending.get(key)??Promise.resolve();
 const next=previous.catch(()=>undefined).then(work);pending.set(key,next);
 try{return await next;}finally{if(pending.get(key)===next)pending.delete(key);}
}
/** Requires the recorder's existing single-process volume lock. Partials stay under the job for backup/erasure. */
export class DesktopUploadStore {
 constructor(private db:RecorderDatabase,private dataDir:string){}
 private file(id:string,complete=false){return join(this.dataDir,'jobs',z.uuid().parse(id),complete?'desktop-upload.mp4':'desktop-upload.partial');}
 private grant(owner:string,deviceId:string,id:string){
  const row=this.db.connection.prepare(`SELECT j.metadata FROM jobs j JOIN accounts a ON a.owner=j.owner
   JOIN desktop_devices d ON d.owner=j.owner WHERE j.id=? AND j.owner=? AND d.id=? AND d.revoked_at IS NULL
   AND a.admission_status='admitted' AND j.expires_at>? AND j.status IN ('recording','interrupted','captured','rendering','completed')`).get(id,owner,deviceId,Date.now());
  if(!row)throw new Error('desktop_upload_not_allowed');
  const job=JSON.parse(String(row.metadata));
  if(job.desktopDeviceId!==deviceId||job.privacyMode!=='user-approved-unredacted'||(job.rawExpiresAt!==undefined&&job.rawExpiresAt<=Date.now()))throw new Error('desktop_upload_not_allowed');
 }
 private receipt(owner:string,deviceId:string,id:string):Receipt{
  this.grant(owner,deviceId,id);
  const row=this.db.connection.prepare('SELECT * FROM desktop_uploads WHERE job_id=? AND owner=? AND device_id=? AND expires_at>?').get(id,owner,deviceId,Date.now());
  if(!row)throw new Error('desktop_upload_not_found');
  return {captureId:id,bytes:Number(row.bytes),received:Number(row.received),sha256:String(row.sha256),complete:row.complete===1,chunkBytes:desktopChunkBytes,
   media:row.media_metadata===null?null:desktopMediaSchema.parse(JSON.parse(String(row.media_metadata)))};
 }
 status(owner:string,deviceId:string,id:string){z.uuid().parse(id);return this.receipt(owner,deviceId,id);}
 async begin(owner:string,deviceId:string,id:string,bytes:number,sha256:string,mediaInput:unknown){
  z.uuid().parse(id);z.number().int().positive().max(maxBytes).parse(bytes);z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
  const media=JSON.stringify(desktopMediaSchema.parse(mediaInput));
  return serialized(resolve(this.dataDir,'desktop-upload-admission'),()=>serialized(this.file(id),async()=>{
   this.grant(owner,deviceId,id);
   const existing=this.db.connection.prepare('SELECT bytes,sha256,media_metadata FROM desktop_uploads WHERE job_id=?').get(id);
   if(existing){
    this.receipt(owner,deviceId,id);
    if(existing.bytes!==bytes||existing.sha256!==sha256||(existing.media_metadata!==null&&existing.media_metadata!==media))throw new Error('desktop_upload_conflict');
    // Pre-migration uploads have no metadata; only the bound device with the same file may supply it.
    if(existing.media_metadata===null)this.db.connection.prepare('UPDATE desktop_uploads SET media_metadata=? WHERE job_id=?').run(media,id);
    return this.receipt(owner,deviceId,id);
   }
   const disk=await statfs(this.dataDir);
   const outstanding=Number(this.db.connection.prepare('SELECT coalesce(sum(bytes-received),0) AS n FROM desktop_uploads WHERE complete=0 AND expires_at>?').get(Date.now())?.n??0);
   if(disk.bavail*disk.bsize<outstanding+bytes+maxBytes)throw new Error('storage_capacity_reached');
   await mkdir(join(this.dataDir,'jobs',id),{recursive:true,mode:0o700});
   const file=await open(this.file(id),'wx',0o600).catch(error=>{if(error.code==='EEXIST')return open(this.file(id),'r+');throw error;});
   try{await file.truncate(0);await file.sync();}finally{await file.close();}
   const directory=await open(join(this.dataDir,'jobs',id),'r');try{await directory.sync();}finally{await directory.close();}
   // Recheck after filesystem awaits: account/device may have been revoked in the meantime.
   this.grant(owner,deviceId,id);
   this.db.connection.prepare('INSERT INTO desktop_uploads(job_id,owner,device_id,bytes,sha256,created_at,expires_at,media_metadata) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,owner,deviceId,bytes,sha256,Date.now(),Date.now()+24*60*60_000,media);
   return this.receipt(owner,deviceId,id);
  }));
 }
 async append(owner:string,deviceId:string,id:string,offset:number,data:Buffer){
  z.uuid().parse(id);z.number().int().nonnegative().parse(offset);
  if(!data.length||data.length>desktopChunkBytes)throw new Error('desktop_chunk_size_invalid');
  return serialized(this.file(id),async()=>{
   const receipt=this.receipt(owner,deviceId,id);
   if(offset>receipt.received||offset+data.length>receipt.bytes)throw new Error('desktop_chunk_offset_invalid');
   const file=await open(this.file(id,receipt.complete),receipt.complete?'r':'r+').catch(error=>{if(error.code==='ENOENT'&&receipt.received===receipt.bytes)return open(this.file(id,true),'r');throw error;});
   try{
    if(offset<receipt.received){
     if(offset+data.length>receipt.received)throw new Error('desktop_chunk_offset_invalid');
     const existing=Buffer.alloc(data.length);const read=await file.read(existing,0,existing.length,offset);
     if(read.bytesRead!==data.length||!existing.equals(data))throw new Error('desktop_chunk_conflict');
     return receipt; // Accepted response was lost: same bytes, same recording.
    }
    if(receipt.complete)throw new Error('desktop_upload_complete');
    let written=0;
    while(written<data.length){const result=await file.write(data,written,data.length-written,offset+written);if(!result.bytesWritten)throw new Error('desktop_write_failed');written+=result.bytesWritten;}
    await file.sync();
    this.grant(owner,deviceId,id);
    this.db.connection.prepare('UPDATE desktop_uploads SET received=? WHERE job_id=? AND received=?').run(offset+data.length,id,offset);
    return this.receipt(owner,deviceId,id);
   }finally{await file.close();}
  });
 }
 async complete(owner:string,deviceId:string,id:string){
  z.uuid().parse(id);
  return serialized(this.file(id),async()=>{
   const receipt=this.receipt(owner,deviceId,id);
   if(receipt.complete)return receipt;
   if(receipt.received!==receipt.bytes)throw new Error('desktop_upload_incomplete');
   // Recover a crash after rename but before publishing the SQL completion receipt.
   let source=this.file(id);
   try{await stat(source);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;source=this.file(id,true);}
   if((await stat(source)).size!==receipt.bytes)throw new Error('desktop_upload_size_invalid');
   const hash=createHash('sha256');for await(const chunk of createReadStream(source))hash.update(chunk);
   if(hash.digest('hex')!==receipt.sha256)throw new Error('desktop_upload_checksum_invalid');
   const header=await open(source,'r');
   try{const data=Buffer.alloc(12);await header.read(data,0,12,0);if(data.toString('ascii',4,8)!=='ftyp')throw new Error('desktop_upload_container_invalid');}finally{await header.close();}
   this.grant(owner,deviceId,id);
   if(source!==this.file(id,true))await rename(source,this.file(id,true));
   const directory=await open(resolve(this.file(id,true),'..'),'r');try{await directory.sync();}finally{await directory.close();}
   this.grant(owner,deviceId,id);
   this.db.connection.prepare('UPDATE desktop_uploads SET complete=1 WHERE job_id=?').run(id);
   return this.receipt(owner,deviceId,id);
  });
 }
 completedFile(owner:string,deviceId:string,id:string){if(!this.receipt(owner,deviceId,id).complete)throw new Error('desktop_upload_incomplete');return this.file(id,true);}
}
