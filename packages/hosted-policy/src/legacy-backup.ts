import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,mkdtemp,mkdir,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {readLegacySnapshot} from '@agent-recorder/mcp/store/open';

export type LegacyBackupObjectStore={put(key:string,body:Uint8Array):Promise<void>;get(key:string):Promise<Uint8Array|undefined>};
export type LegacyBackupManifest={version:1;backupId:string;createdAt:number;semanticChecksum:string;
  files:Array<{path:string;bytes:number;sha256:string}>};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximumFileBytes=64*1024*1024,maximumTotalBytes=512*1024*1024;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

function validatePath(path:string){
  if(!path||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..')||
    !/^(invites\.json|usage\.json|jobs|imports|jobs\/.+|imports\/.+)$/.test(path))
    throw new Error('invalid_legacy_backup_path');
}

export function parseLegacyBackupManifest(body:Uint8Array,backupId:string):LegacyBackupManifest{
  if(body.length>1024*1024)throw new Error('legacy_backup_manifest_invalid');
  let manifest:LegacyBackupManifest;
  try{manifest=JSON.parse(Buffer.from(body).toString('utf8')) as LegacyBackupManifest;}
  catch{throw new Error('legacy_backup_manifest_invalid');}
  if(!manifest||manifest.version!==1||manifest.backupId!==backupId||
    !Number.isSafeInteger(manifest.createdAt)||manifest.createdAt<0||
    !/^[0-9a-f]{64}$/i.test(manifest.semanticChecksum)||
    !Array.isArray(manifest.files)||manifest.files.length>5000)
    throw new Error('legacy_backup_manifest_invalid');
  let total=0;const paths=new Set<string>();
  for(const file of manifest.files){
    if(!file||typeof file.path!=='string'||
      !Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>maximumFileBytes||
      typeof file.sha256!=='string'||!/^[0-9a-f]{64}$/i.test(file.sha256))
      throw new Error('legacy_backup_manifest_invalid');
    validatePath(file.path);
    if(file.path==='jobs'||file.path==='imports'||paths.has(file.path))
      throw new Error('legacy_backup_manifest_invalid');
    paths.add(file.path);total+=file.bytes;
    if(total>maximumTotalBytes)throw new Error('legacy_backup_manifest_invalid');
  }
  if(!paths.has('invites.json')&&!paths.has('usage.json')&&!Array.from(paths).some(path=>path.startsWith('jobs/')))
    throw new Error('legacy_backup_manifest_invalid');
  return manifest;
}

async function requireUnexpired(objects:LegacyBackupObjectStore,prefix:string){
  if(await objects.get(`${prefix}expired.json`))throw new Error('legacy_backup_expired');
}

async function sourceFiles(dataDir:string){
  const files:Array<{path:string;body:Buffer;bytes:number;sha256:string}>=[];
  let total=0;
  async function collect(path:string,optional:boolean):Promise<void>{
    validatePath(path);
    let info;
    try{info=await lstat(join(dataDir,path));}
    catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(info.isDirectory()){
      if(path==='invites.json'||path==='usage.json')throw new Error('invalid_legacy_backup_file');
      for(const name of (await readdir(join(dataDir,path))).sort())await collect(`${path}/${name}`,false);
      return;
    }
    if(!info.isFile()||path==='jobs'||path==='imports'||info.size>maximumFileBytes)
      throw new Error('invalid_legacy_backup_file');
    total+=info.size;if(total>maximumTotalBytes||files.length>=5000)throw new Error('legacy_backup_too_large');
    const body=await readFile(join(dataDir,path));
    if(body.length!==info.size)throw new Error('legacy_backup_source_changed');
    files.push({path,body,bytes:body.length,sha256:hash(body)});
  }
  for(const path of ['invites.json','usage.json','jobs','imports'])await collect(path,true);
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

async function validateLegacyRoot(dataDir:string){
  const expected=new Set(['invites.json','usage.json','jobs','imports','.process-lock','lost+found']);
  for(const name of await readdir(dataDir)){
    if(!expected.has(name))throw new Error('legacy_backup_unrecognized_volume_entry');
    if(name==='lost+found'){
      const info=await lstat(join(dataDir,name));
      if(!info.isDirectory()||(await readdir(join(dataDir,name))).length)
        throw new Error('legacy_backup_unrecognized_volume_entry');
    }
    if(name==='.process-lock'&&!(await lstat(join(dataDir,name))).isFile())
      throw new Error('legacy_backup_unrecognized_volume_entry');
  }
}

/** Run only with the Recorder process stopped and its volume lock held by the maintenance entrypoint. */
export async function exportLegacyBackup(dataDir:string,objects:LegacyBackupObjectStore,backupId:string,now=Date.now()){
  if(!uuid.test(backupId)||!Number.isSafeInteger(now)||now<0)throw new Error('legacy_backup_id_invalid');
  try{await lstat(join(dataDir,'recorder.sqlite'));throw new Error('legacy_backup_requires_json_volume');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await validateLegacyRoot(dataDir);
  const before=await readLegacySnapshot(dataDir);
  if(!before.sources.length)throw new Error('legacy_snapshot_missing');
  const files=await sourceFiles(dataDir);
  const prefix=`agent-recorder/legacy-backups/v1/${backupId}/`;
  await requireUnexpired(objects,prefix);
  const manifestKey=`${prefix}manifest.json`;
  const manifest:LegacyBackupManifest={version:1,backupId,createdAt:now,semanticChecksum:before.checksum,
    files:files.map(({path,bytes,sha256})=>({path,bytes,sha256}))};
  const existing=await objects.get(manifestKey);
  if(existing){
    const previous=parseLegacyBackupManifest(existing,backupId);
    if(
      previous.semanticChecksum!==before.checksum||
      JSON.stringify(previous.files)!==JSON.stringify(manifest.files))throw new Error('legacy_backup_id_conflict');
    manifest.createdAt=previous.createdAt;
  }
  for(const file of files){
    const key=prefix+file.path;
    if(!existing)await objects.put(key,file.body);
    const remote=await objects.get(key);
    if(!remote||remote.length!==file.bytes||hash(remote)!==file.sha256)
      throw new Error('legacy_backup_remote_mismatch');
    const current=await readFile(join(dataDir,file.path));
    if(current.length!==file.bytes||hash(current)!==file.sha256)
      throw new Error('legacy_backup_source_changed');
  }
  const after=await readLegacySnapshot(dataDir);
  if(after.checksum!==before.checksum)throw new Error('legacy_backup_source_changed');
  for(const file of files){
    const current=await readFile(join(dataDir,file.path));
    if(current.length!==file.bytes||hash(current)!==file.sha256)
      throw new Error('legacy_backup_source_changed');
  }
  const manifestBody=Buffer.from(JSON.stringify(manifest));
  if(manifestBody.length>1024*1024)throw new Error('legacy_backup_manifest_invalid');
  await requireUnexpired(objects,prefix);
  if(!existing)await objects.put(manifestKey,manifestBody);
  const published=await objects.get(manifestKey);
  if(!published||!Buffer.from(published).equals(manifestBody))throw new Error('legacy_backup_manifest_mismatch');
  await requireUnexpired(objects,prefix);
  return {manifest,manifestSha256:hash(manifestBody),reused:Boolean(existing)};
}

/** Restore to a new directory only. The caller supplies the expected manifest digest from the export receipt. */
export async function restoreLegacyBackup(objects:LegacyBackupObjectStore,backupId:string,
  destination:string,expectedManifestSha256:string){
  if(!uuid.test(backupId)||!/^[0-9a-f]{64}$/i.test(expectedManifestSha256)||
    !destination.startsWith('/')||resolve(destination)==='/')throw new Error('legacy_restore_arguments_invalid');
  const target=resolve(destination);
  try{await lstat(target);throw new Error('legacy_restore_destination_exists');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const prefix=`agent-recorder/legacy-backups/v1/${backupId}/`;
  await requireUnexpired(objects,prefix);
  const body=await objects.get(`${prefix}manifest.json`);
  if(!body||hash(body)!==expectedManifestSha256)throw new Error('legacy_backup_manifest_mismatch');
  const manifest=parseLegacyBackupManifest(body,backupId);
  const parent=dirname(target);
  const temp=await mkdtemp(join(parent,`.${basename(target)}-restore-`));
  try{
    for(const file of manifest.files){
      const bytes=await objects.get(prefix+file.path);
      if(!bytes||bytes.length!==file.bytes||hash(bytes)!==file.sha256)
        throw new Error('legacy_backup_remote_mismatch');
      const output=join(temp,file.path);
      await mkdir(dirname(output),{recursive:true,mode:0o700});
      await writeFile(output,bytes,{flag:'wx',mode:0o600});
    }
    const restored=await readLegacySnapshot(temp);
    if(restored.checksum!==manifest.semanticChecksum)throw new Error('legacy_backup_semantic_mismatch');
    await requireUnexpired(objects,prefix);
    await rename(temp,target);
    return {manifest,manifestSha256:hash(body)};
  }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
}
