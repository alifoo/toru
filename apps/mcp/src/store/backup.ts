import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { RecorderDatabase } from './database.js';
import { databaseName } from './open.js';
import { exclusiveProcessLock } from './lock.js';

async function sha256(path:string) {
  const digest=createHash('sha256');
  for await(const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function sync(path:string) {
  const handle=await open(path,'r');try {await handle.sync();} finally {await handle.close();}
}
async function durableWrite(path:string,value:string) {
  const temporary=`${path}.${randomUUID()}.tmp`;
  const handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
  await rename(temporary,path);await sync(dirname(path));
}
const manifestSchema=z.object({version:z.literal(1),createdAt:z.number().int().nonnegative(),files:z.array(z.object({
  path:z.string().refine(path=>path===databaseName || /^(jobs|imports)\//.test(path)).refine(path=>!path.split('/').some(part=>part==='' || part==='.' || part==='..') && !path.includes('\\')),
  bytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),sha256:z.string().regex(/^[a-f0-9]{64}$/),
}))});
export type VolumeManifest=z.infer<typeof manifestSchema>;

function pathsOverlap(left:string,right:string) {
  const path=relative(left,right);
  return !path || (path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path));
}

async function canonicalNewPath(path:string) {
  return join(await realpath(dirname(path)),basename(path));
}

/** Requires a stopped recorder. Includes metadata, retained media and encrypted imports, never the key. */
export async function backupRecorderVolume(dataDir:string,destination:string):Promise<VolumeManifest> {
  const source=resolve(dataDir),target=resolve(destination);
  if(pathsOverlap(await realpath(source),await canonicalNewPath(target))) throw new Error('backup_must_be_outside_data_directory');
  if(!(await lstat(join(source,databaseName))).isFile()) throw new Error('recorder_database_missing');
  const releaseRuntime=exclusiveProcessLock(join(source,'.runtime-lock.sqlite'));
  let releaseMigration:(()=>void)|undefined;
  let db:RecorderDatabase|undefined;
  let reserved=false,published=false;
  const temporary=`${target}.${randomUUID()}.partial`;
  try {
    releaseMigration=exclusiveProcessLock(join(source,'.migration-lock.sqlite'));
    db=new RecorderDatabase(join(source,databaseName));
    if(!db.connection.prepare("SELECT 1 FROM legacy_imports WHERE source='legacy-v1'").get()) throw new Error('recorder_store_not_initialized');
    // An existing target, even empty, must not be overwritten.
    try {await mkdir(target,{mode:0o700});reserved=true;}
    catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST') throw new Error('backup_destination_exists');throw error;}
    await mkdir(temporary,{mode:0o700});
    await db.snapshot(join(temporary,databaseName));
    const manifest:VolumeManifest={version:1,createdAt:Date.now(),files:[]};
    async function collect(relativePath:string,copy:boolean):Promise<void> {
      const from=join(copy?source:temporary,relativePath),to=join(temporary,relativePath);
      let info;
      try {info=await lstat(from);} catch(error) {if(copy && ['jobs','imports'].includes(relativePath) && (error as NodeJS.ErrnoException).code==='ENOENT') return;throw error;}
      if(info.isDirectory()) {
        await mkdir(to,{recursive:true,mode:0o700});
        for(const name of (await readdir(from)).sort()) await collect(`${relativePath}/${name}`,copy);
        await sync(to);return;
      }
      if(!info.isFile()) throw new Error('backup_symlink_or_special_file');
      if(copy) await copyFile(from,to);
      const handle=await open(to,'r+');try {await handle.chmod(0o600);await handle.sync();} finally {await handle.close();}
      const hash=await sha256(to);
      if(copy && hash!==await sha256(from)) throw new Error('backup_source_changed');
      manifest.files.push({path:relativePath,bytes:info.size,sha256:hash});
    }
    await collect(databaseName,false);
    await collect('jobs',true);await collect('imports',true);
    const file=await open(join(temporary,'manifest.json'),'wx',0o600);
    try {await file.writeFile(JSON.stringify(manifest,null,2));await file.sync();} finally {await file.close();}
    await sync(temporary);
    await verifyRecorderBackup(temporary);
    // The destination parent is operator-owned; keep backups private and use unique target names.
    await rename(temporary,target);published=true;await sync(dirname(target));
    return manifest;
  } finally {
    db?.close();releaseMigration?.();releaseRuntime();
    await rm(temporary,{recursive:true,force:true});
    if(reserved && !published) await rmdir(target).catch(()=>undefined);
  }
}

export async function verifyRecorderBackup(directory:string):Promise<VolumeManifest> {
  const root=resolve(directory);
  if(!(await lstat(root)).isDirectory()) throw new Error('invalid_backup_directory');
  const manifest=manifestSchema.parse(JSON.parse(await readFile(join(root,'manifest.json'),'utf8')));
  if(!manifest.files.some(file=>file.path===databaseName) || new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length) throw new Error('invalid_backup_manifest');
  const expected=new Set(['manifest.json',...manifest.files.map(file=>file.path)]);
  async function rejectUnexpected(path:string,prefix=''):Promise<void> {
    for(const entry of await readdir(path,{withFileTypes:true})) {
      const name=prefix?`${prefix}/${entry.name}`:entry.name;
      if(entry.isDirectory()) await rejectUnexpected(join(path,entry.name),name);
      else if(!entry.isFile() || !expected.has(name)) throw new Error('unexpected_backup_file');
    }
  }
  await rejectUnexpected(root);
  for(const file of manifest.files) {
    const components=file.path.split('/');
    for(let length=1;length<components.length;length++) if(!(await lstat(join(root,...components.slice(0,length)))).isDirectory()) throw new Error('invalid_backup_directory');
    const path=join(root,file.path),info=await lstat(path);
    if(!info.isFile() || info.size!==file.bytes || await sha256(path)!==file.sha256) throw new Error('backup_checksum_mismatch');
  }
  return manifest;
}

/** Restore only manifest-listed files into a new directory; never replace a live volume. */
export async function restoreRecorderBackup(backupDirectory:string,destination:string):Promise<VolumeManifest> {
  if(!isAbsolute(destination))throw new Error('restore_destination_must_be_absolute');
  const source=resolve(backupDirectory),target=resolve(destination);
  const canonicalSource=await realpath(source),canonicalTarget=await canonicalNewPath(target);
  if(pathsOverlap(canonicalSource,canonicalTarget)||pathsOverlap(canonicalTarget,canonicalSource))throw new Error('restore_destination_overlaps_backup');
  const manifest=await verifyRecorderBackup(source);
  let reserved=false,published=false;
  const temporary=`${target}.${randomUUID()}.partial`;
  try {
    try{await mkdir(target,{mode:0o700});reserved=true;}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('restore_destination_exists');throw error;}
    await mkdir(temporary,{mode:0o700});
    for(const file of manifest.files){
      const from=join(source,file.path),to=join(temporary,file.path);
      await mkdir(dirname(to),{recursive:true,mode:0o700});
      await copyFile(from,to);
      const handle=await open(to,'r+');try{await handle.chmod(0o600);await handle.sync();}finally{await handle.close();}
      if(await sha256(to)!==file.sha256)throw new Error('restore_checksum_mismatch');
    }
    const manifestPath=join(temporary,'manifest.json');
    await copyFile(join(source,'manifest.json'),manifestPath);
    const manifestHandle=await open(manifestPath,'r+');
    try{await manifestHandle.chmod(0o600);await manifestHandle.sync();}finally{await manifestHandle.close();}
    const db=new DatabaseSync(join(temporary,databaseName),{readOnly:true});
    try{
      const applicationId=Number(db.prepare('PRAGMA application_id').get()!.application_id);
      const integrity=String(db.prepare('PRAGMA integrity_check').get()!.integrity_check);
      const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();
      if(applicationId!==0x41525243||integrity!=='ok'||foreignKeys.length)throw new Error('restore_database_invalid');
    }finally{db.close();}
    await verifyRecorderBackup(temporary);
    await sync(temporary);
    await rename(temporary,target);published=true;await sync(dirname(target));
    return manifest;
  }finally{
    await rm(temporary,{recursive:true,force:true});
    if(reserved&&!published)await rmdir(target).catch(()=>undefined);
  }
}

/** Operator-only rotation for complete volume backups; dry-run unless apply is explicit. */
export async function pruneRecorderBackups(dataDir:string,backupRoot:string,retentionDays:number,apply=false,now=Date.now()) {
  if(!isAbsolute(backupRoot)||!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>365||
    !Number.isSafeInteger(now)||now<0)throw new Error('invalid_backup_retention');
  const source=resolve(dataDir),root=resolve(backupRoot);
  const canonicalSource=await realpath(source),canonicalRoot=await realpath(root);
  if(pathsOverlap(canonicalSource,canonicalRoot)||pathsOverlap(canonicalRoot,canonicalSource))throw new Error('backup_root_overlaps_data_directory');
  if(!(await lstat(root)).isDirectory())throw new Error('invalid_backup_directory');
  const cutoff=now-retentionDays*86400000;
  const expired:string[]=[];
  for(const entry of await readdir(root,{withFileTypes:true})) {
    if(!entry.isDirectory())continue;
    const path=join(root,entry.name);
    let manifest:VolumeManifest;
    try{manifest=await verifyRecorderBackup(path);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(manifest.createdAt<cutoff)expired.push(entry.name);
  }
  if(apply)for(const name of expired)await rm(join(root,name),{recursive:true});
  return {retentionDays,cutoff:new Date(cutoff).toISOString(),expired,deleted:apply?expired:[]};
}

/** Retire the one-time cutover copy only after its SQL receipt proves successful import. */
export async function pruneLegacyMigrationBackup(dataDir:string,retentionDays:number,apply=false,now=Date.now()) {
  if(!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>365||!Number.isSafeInteger(now)||now<0)
    throw new Error('invalid_backup_retention');
  const source=resolve(dataDir),reference=join(source,'legacy-backup.json');
  const releaseRuntime=exclusiveProcessLock(join(source,'.runtime-lock.sqlite'));
  let releaseMigration:(()=>void)|undefined;
  let db:RecorderDatabase|undefined;
  try{
    releaseMigration=exclusiveProcessLock(join(source,'.migration-lock.sqlite'));
    let value:{path?:unknown;checksum?:unknown;expiredAt?:unknown};
    try{value=JSON.parse(await readFile(reference,'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'none'};throw error;}
    if(!value||typeof value!=='object')throw new Error('invalid_legacy_backup_reference');
    if(value.expiredAt!==undefined)return {state:'already_pruned'};
    if(typeof value.path!=='string'||typeof value.checksum!=='string')throw new Error('invalid_legacy_backup_reference');
    const target=resolve(value.path),relativePath=relative(join(source,'migration-backups'),target);
    if(!/^[0-9a-f-]{36}$/i.test(relativePath)||relativePath.includes(sep))throw new Error('invalid_legacy_backup_reference');
    if(!(await lstat(join(source,databaseName))).isFile())throw new Error('recorder_database_missing');
    db=new RecorderDatabase(join(source,databaseName));
    const receipt=db.connection.prepare("SELECT checksum,imported_at FROM legacy_imports WHERE source='legacy-v1'").get();
    if(!receipt||receipt.checksum!==value.checksum)throw new Error('legacy_import_not_verified');
    const importedAt=Number(receipt.imported_at),cutoff=now-retentionDays*86400000;
    if(importedAt>=cutoff)return {state:'retained',importedAt,retentionDays};
    if(!apply)return {state:'expired',importedAt,retentionDays};
    try{if(!(await lstat(target)).isDirectory())throw new Error('invalid_legacy_backup_directory');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await rm(target,{recursive:true,force:true});
    await sync(dirname(target));
    await durableWrite(reference,JSON.stringify({checksum:value.checksum,expiredAt:now}));
    return {state:'deleted',importedAt,retentionDays};
  }finally{db?.close();releaseMigration?.();releaseRuntime();}
}
