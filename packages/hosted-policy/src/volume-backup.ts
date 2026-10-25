import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,open,readFile,realpath,rename,rm,rmdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {backupRecorderVolume,restoreRecorderBackup,type VolumeManifest} from '@agent-recorder/mcp/store/backup';
import {type BackupLayout,type LegacyBackupRetentionObjects} from './legacy-backup-retention.js';

export const volumeBackupRoot='agent-recorder/volume-backups/v1/';
const chunkBytes=8*1024*1024,maxBytes=4*1024*1024*1024,maxFileBytes=512*1024*1024;
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,hex=/^[a-f0-9]{64}$/;
const digest=(body:Uint8Array)=>createHash('sha256').update(body).digest('hex');
export type BackupIdentity={environment:'local'|'staging'|'production';instanceId:string};
type BackupFile={path:string;bytes:number;sha256:string;chunks:Array<{bytes:number;sha256:string}>};
export type VolumeBackupManifest={version:1;backupId:string;createdAt:number;identity:BackupIdentity;
  volume:VolumeManifest;files:BackupFile[]};

function validIdentity(value:BackupIdentity){
  if(!value||!['local','staging','production'].includes(value.environment)||
    typeof value.instanceId!=='string'||!/^[A-Za-z0-9_.:@/-]{1,128}$/.test(value.instanceId))
    throw new Error('volume_backup_identity_invalid');
}
function sameIdentity(actual:BackupIdentity,expected:BackupIdentity){
  validIdentity(actual);validIdentity(expected);
  if(actual.environment!==expected.environment||actual.instanceId!==expected.instanceId)
    throw new Error('volume_backup_identity_mismatch');
}
function databaseIdentity(path:string,expected:BackupIdentity){
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const row=db.prepare('SELECT environment,instance_id FROM instance_identity WHERE singleton=1').get();
    if(!row)throw new Error('volume_backup_identity_missing');
    sameIdentity({environment:String(row.environment) as BackupIdentity['environment'],instanceId:String(row.instance_id)},expected);
  }finally{db.close();}
}
function validFilePath(path:string){
  return typeof path==='string'&&!path.includes('\\')&&
    !path.split('/').some(part=>!part||part==='.'||part==='..')&&
    /^(recorder\.sqlite|sandbox-vms\.json|jobs\/.+|imports\/.+)$/.test(path);
}
export function parseVolumeBackupManifest(body:Uint8Array,id:string):VolumeBackupManifest{
  let manifest:VolumeBackupManifest;
  if(body.length>1024*1024)throw new Error('volume_backup_manifest_invalid');
  try{manifest=JSON.parse(Buffer.from(body).toString('utf8')) as VolumeBackupManifest;}
  catch{throw new Error('volume_backup_manifest_invalid');}
  if(!manifest||manifest.version!==1||manifest.backupId!==id||!uuid.test(id)||
    !Number.isSafeInteger(manifest.createdAt)||manifest.createdAt<0||
    !manifest.volume||manifest.volume.version!==1||!Number.isSafeInteger(manifest.volume.createdAt)||
    manifest.volume.createdAt<0||!Array.isArray(manifest.volume.files)||
    !Array.isArray(manifest.files)||manifest.files.length>5001)throw new Error('volume_backup_manifest_invalid');
  validIdentity(manifest.identity);
  let total=0;const paths=new Set<string>();
  for(const file of manifest.files){
    if(!file||!validFilePath(file.path)||paths.has(file.path)||!hex.test(file.sha256)||
      !Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>maxFileBytes||
      !Array.isArray(file.chunks)||file.chunks.length!==Math.ceil(file.bytes/chunkBytes))
      throw new Error('volume_backup_manifest_invalid');
    let bytes=0;
    for(const [index,chunk] of file.chunks.entries()){
      const expected=Math.min(chunkBytes,file.bytes-index*chunkBytes);
      if(!chunk||chunk.bytes!==expected||!hex.test(chunk.sha256))throw new Error('volume_backup_manifest_invalid');
      bytes+=chunk.bytes;
    }
    if(bytes!==file.bytes)throw new Error('volume_backup_manifest_invalid');
    total+=bytes;paths.add(file.path);if(total>maxBytes)throw new Error('volume_backup_too_large');
  }
  const metadata=manifest.files.filter(file=>file.path!=='sandbox-vms.json').map(({path,bytes,sha256})=>({path,bytes,sha256}));
  if(!paths.has('recorder.sqlite')||JSON.stringify(metadata)!==JSON.stringify(manifest.volume.files))
    throw new Error('volume_backup_manifest_invalid');
  return manifest;
}
const chunkPath=(file:number,chunk:number)=>`data/${file}/${chunk}`;
export const volumeBackupLayout:BackupLayout={root:volumeBackupRoot,
  allowsPath:path=>/^(manifest\.json|expired\.json|data\/\d+\/\d+)$/.test(path),
  manifest:(body,id)=>{const value=parseVolumeBackupManifest(body,id);return {createdAt:value.createdAt,
    paths:value.files.flatMap((file,i)=>file.chunks.map((_,j)=>chunkPath(i,j)))};}};
async function unexpired(objects:LegacyBackupRetentionObjects,prefix:string){
  if(await objects.get(prefix+'expired.json'))throw new Error('volume_backup_expired');
}
function journal(body:Uint8Array){
  if(body.length>1024*1024)throw new Error('volume_backup_runtime_journal_invalid');
  const value:unknown=JSON.parse(Buffer.from(body).toString('utf8'));
  if(!Array.isArray(value)||value.length>10_000||new Set(value).size!==value.length||
    value.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{12,128}$/.test(id)))
    throw new Error('volume_backup_runtime_journal_invalid');
}

/** Caller holds the maintenance process lock. Snapshot metadata/media; encryption keys stay external. */
export async function exportVolumeBackup(dataDir:string,objects:LegacyBackupRetentionObjects,id:string,identity:BackupIdentity){
  if(!uuid.test(id))throw new Error('volume_backup_id_invalid');validIdentity(identity);
  identity={environment:identity.environment,instanceId:identity.instanceId};
  const prefix=volumeBackupRoot+id+'/';await unexpired(objects,prefix);
  const previous=await objects.get(prefix+'manifest.json');
  const existing=previous?parseVolumeBackupManifest(previous,id):undefined;
  if(existing)sameIdentity(existing.identity,identity);
  const scratch=await mkdtemp(join(tmpdir(),'recorder-volume-export-'));
  try{
    const snapshot=join(scratch,'snapshot'),volume=await backupRecorderVolume(dataDir,snapshot);
    databaseIdentity(join(snapshot,'recorder.sqlite'),identity);
    const records=[...volume.files];
    try{
      const source=join(dataDir,'sandbox-vms.json'),info=await lstat(source);
      if(!info.isFile()||info.size>1024*1024)throw new Error('volume_backup_runtime_journal_invalid');
      const body=await readFile(source);journal(body);
      await writeFile(join(scratch,'sandbox-vms.json'),body,{flag:'wx',mode:0o600});
      records.push({path:'sandbox-vms.json',bytes:body.length,sha256:digest(body)});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(records.length>5001||records.reduce((sum,file)=>sum+file.bytes,0)>maxBytes||records.some(file=>file.bytes>maxFileBytes))
      throw new Error('volume_backup_too_large');
    const files:BackupFile[]=[];
    for(const [index,record] of records.entries()){
      const path=record.path==='sandbox-vms.json'?join(scratch,record.path):join(snapshot,record.path);
      const input=await open(path,'r'),hash=createHash('sha256'),chunks:BackupFile['chunks']=[];
      try{
        for(let offset=0;offset<record.bytes;offset+=chunkBytes){
          const buffer=Buffer.allocUnsafe(Math.min(chunkBytes,record.bytes-offset));
          let read=0;
          while(read<buffer.length){const result=await input.read(buffer,read,buffer.length-read,offset+read);
            if(!result.bytesRead)throw new Error('volume_backup_source_changed');read+=result.bytesRead;}
          hash.update(buffer);const chunk={bytes:buffer.length,sha256:digest(buffer)},key=prefix+chunkPath(index,chunks.length);
          if(!existing)await objects.put(key,buffer);
          const uploaded=await objects.get(key);
          if(!uploaded||uploaded.length!==chunk.bytes||digest(uploaded)!==chunk.sha256)throw new Error('volume_backup_remote_mismatch');
          chunks.push(chunk);
        }
      }finally{await input.close();}
      if(hash.digest('hex')!==record.sha256)throw new Error('volume_backup_source_changed');
      files.push({...record,chunks});
    }
    if(existing){
      if(JSON.stringify(files)!==JSON.stringify(existing.files))throw new Error('volume_backup_id_conflict');
      volume.createdAt=existing.volume.createdAt;
    }
    const manifest:VolumeBackupManifest={version:1,backupId:id,createdAt:existing?.createdAt??Date.now(),identity,volume,files};
    const body=Buffer.from(JSON.stringify(manifest));parseVolumeBackupManifest(body,id);
    const allowed=new Set(files.flatMap((file,i)=>file.chunks.map((_,j)=>prefix+chunkPath(i,j))));
    if(existing)allowed.add(prefix+'manifest.json');
    if((await objects.list()).some(file=>file.key.startsWith(prefix)&&!allowed.has(file.key)))
      throw new Error('volume_backup_id_conflict');
    await unexpired(objects,prefix);
    if(!existing)await objects.put(prefix+'manifest.json',body);
    const published=await objects.get(prefix+'manifest.json');
    if(!published||!Buffer.from(published).equals(body))throw new Error('volume_backup_manifest_mismatch');
    await unexpired(objects,prefix);
    return {manifest,manifestSha256:digest(body),reused:Boolean(existing)};
  }finally{await rm(scratch,{recursive:true,force:true});}
}

async function canonical(path:string){
  try{return await realpath(path);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    return join(await realpath(dirname(path)),basename(path));
  }
}
/** Offline restore. The independent deletion journal must replay before publication. */
export async function restoreVolumeBackup(objects:LegacyBackupRetentionObjects,id:string,destination:string,
  expectedSha256:string,identity:BackupIdentity,activeDirectory:string,beforePublish:(directory:string)=>Promise<void>){
  if(!uuid.test(id)||!hex.test(expectedSha256)||!isAbsolute(destination)||resolve(destination)==='/')
    throw new Error('volume_restore_arguments_invalid');
  if(typeof beforePublish!=='function')throw new Error('volume_restore_deletion_replay_required');
  const target=resolve(destination),active=await canonical(resolve(activeDirectory)),canonicalTarget=await canonical(target);
  if(canonicalTarget===active||canonicalTarget.startsWith(active+sep)||active.startsWith(canonicalTarget+sep))
    throw new Error('volume_restore_inside_active_volume');
  try{await lstat(target);throw new Error('volume_restore_destination_exists');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const prefix=volumeBackupRoot+id+'/';await unexpired(objects,prefix);
  const body=await objects.get(prefix+'manifest.json');
  if(!body||digest(body)!==expectedSha256)throw new Error('volume_backup_manifest_mismatch');
  const manifest=parseVolumeBackupManifest(body,id);sameIdentity(manifest.identity,identity);
  const scratch=await mkdtemp(join(dirname(target),'.recorder-volume-restore-'));let reserved=false,published=false;
  try{
    const downloaded=join(scratch,'downloaded');await mkdir(downloaded,{mode:0o700});
    for(const [i,file] of manifest.files.entries()){
      const path=file.path==='sandbox-vms.json'?join(scratch,file.path):join(downloaded,file.path);
      await mkdir(dirname(path),{recursive:true,mode:0o700});const output=await open(path,'wx',0o600),hash=createHash('sha256');
      try{
        for(const [j,chunk] of file.chunks.entries()){
          const bytes=await objects.get(prefix+chunkPath(i,j));
          if(!bytes||bytes.length!==chunk.bytes||digest(bytes)!==chunk.sha256)throw new Error('volume_backup_remote_mismatch');
          hash.update(bytes);await output.writeFile(bytes);
        }
        await output.sync();
      }finally{await output.close();}
      if(hash.digest('hex')!==file.sha256)throw new Error('volume_backup_remote_mismatch');
      if(file.path==='sandbox-vms.json')journal(await readFile(path));
    }
    await writeFile(join(downloaded,'manifest.json'),JSON.stringify(manifest.volume),{flag:'wx',mode:0o600});
    const staged=join(scratch,'restored');await restoreRecorderBackup(downloaded,staged);
    databaseIdentity(join(staged,'recorder.sqlite'),identity);
    if(manifest.files.some(file=>file.path==='sandbox-vms.json'))
      await writeFile(join(staged,'sandbox-vms.json'),await readFile(join(scratch,'sandbox-vms.json')),{flag:'wx',mode:0o600});
    await beforePublish(staged);
    await unexpired(objects,prefix);
    try{await mkdir(target,{mode:0o700});reserved=true;}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('volume_restore_destination_exists');throw error;}
    await rename(staged,target);published=true;
    const parent=await open(dirname(target),'r');try{await parent.sync();}finally{await parent.close();}
    return {manifest,manifestSha256:digest(body)};
  }finally{
    await rm(scratch,{recursive:true,force:true});
    if(reserved&&!published)await rmdir(target).catch(()=>undefined);
  }
}
