import {parseLegacyBackupManifest,type LegacyBackupObjectStore} from './legacy-backup.js';

export const legacyBackupRoot='agent-recorder/legacy-backups/v1/';
export type BackupObject={key:string;modifiedAt:number;etag:string};
export type LegacyBackupRetentionObjects=LegacyBackupObjectStore&{
  list():Promise<BackupObject[]>;remove(key:string):Promise<void>;
};
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export type BackupLayout={root:string;allowsPath(path:string):boolean;
  manifest(body:Uint8Array,id:string):{createdAt:number;paths:string[]}};
const legacyLayout:BackupLayout={root:legacyBackupRoot,
  allowsPath:path=>/^(manifest\.json|expired\.json|invites\.json|usage\.json|jobs\/.+|imports\/.+)$/.test(path),
  manifest:(body,id)=>{const value=parseLegacyBackupManifest(body,id);
    return {createdAt:value.createdAt,paths:value.files.map(file=>file.path)};}};
type Marker={version:1;backupId:string;expiredAt:number};
function marker(body:Uint8Array,id:string):Marker{
  let value:Marker;
  try{value=JSON.parse(Buffer.from(body).toString('utf8')) as Marker;}
  catch{throw new Error('legacy_backup_expiry_marker_invalid');}
  if(body.length>1024||value?.version!==1||value.backupId!==id||
    !Number.isSafeInteger(value.expiredAt)||value.expiredAt<0)
    throw new Error('legacy_backup_expiry_marker_invalid');
  return value;
}
function inventory(entries:BackupObject[],layout:BackupLayout){
  if(entries.length>50_000)throw new Error('legacy_backup_inventory_too_large');
  const keys=new Set<string>(),groups=new Map<string,BackupObject[]>();
  for(const entry of entries){
    if(typeof entry.key!=='string'||!entry.key.startsWith(layout.root)||
      !Number.isSafeInteger(entry.modifiedAt)||entry.modifiedAt<0||
      typeof entry.etag!=='string'||!entry.etag||keys.has(entry.key))
      throw new Error('legacy_backup_inventory_invalid');
    const relative=entry.key.slice(layout.root.length),slash=relative.indexOf('/');
    const id=relative.slice(0,slash),path=relative.slice(slash+1);
    if(slash<0||!uuid.test(id)||path.includes('\\')||
      path.split('/').some(part=>!part||part==='.'||part==='..')||
      !layout.allowsPath(path))
      throw new Error('legacy_backup_inventory_invalid');
    keys.add(entry.key);const group=groups.get(id)??[];group.push(entry);groups.set(id,group);
  }
  return groups;
}
const signature=(entries:BackupObject[])=>JSON.stringify([...entries].sort((a,b)=>a.key.localeCompare(b.key)));

/** Explicit operator sweep. Expiry markers fence restore/publication; no conditional-delete support is assumed. */
export async function pruneLegacyBackupObjects(objects:LegacyBackupRetentionObjects,retentionDays:number,
  apply=false,now=Date.now()){
  return pruneBackupObjects(objects,retentionDays,apply,now,legacyLayout);
}

export async function pruneBackupObjects(objects:LegacyBackupRetentionObjects,retentionDays:number,
  apply:boolean,now:number,layout:BackupLayout){
  if(!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>365||
    !Number.isSafeInteger(now)||now<0)throw new Error('legacy_backup_retention_invalid');
  const initial=await objects.list(),groups=inventory(initial,layout),cutoff=now-retentionDays*86_400_000;
  const candidates:Array<{id:string;files:BackupObject[];marker:Marker|undefined;incomplete:boolean}>=[];
  for(const [id,files] of groups){
    const prefix=layout.root+id+'/';
    const expired=files.find(file=>file.key===prefix+'expired.json');
    let prior:Marker|undefined;
    if(expired){
      const body=await objects.get(expired.key);
      if(!body)throw new Error('legacy_backup_inventory_changed');
      prior=marker(body,id);
    }
    const data=files.filter(file=>file.key!==prefix+'expired.json');
    if(!data.length)continue;
    const manifestObject=data.find(file=>file.key===prefix+'manifest.json');
    let latest=Math.max(...data.map(file=>file.modifiedAt));
    if(manifestObject&&!prior){
      const body=await objects.get(manifestObject.key);
      if(!body)throw new Error('legacy_backup_inventory_changed');
      const manifest=layout.manifest(body,id);latest=Math.max(latest,manifest.createdAt);
      const allowed=new Set(manifest.paths.map(path=>prefix+path));allowed.add(manifestObject.key);
      if(data.some(file=>!allowed.has(file.key)))throw new Error('legacy_backup_inventory_invalid');
    }
    if(prior||latest<=cutoff)candidates.push({id,files:data,marker:prior,incomplete:!manifestObject});
  }
  const result={mode:apply?'applied':'dry-run',retentionDays,expiredBackups:candidates.length,
    backupIds:candidates.map(value=>value.id),plannedObjects:candidates.reduce((sum,value)=>sum+value.files.length,0),
    incompleteBackups:candidates.filter(value=>value.incomplete).length,removedObjects:0};
  if(!apply||!candidates.length)return result;
  const refreshed=await objects.list();inventory(refreshed,layout);
  if(signature(refreshed)!==signature(initial))throw new Error('legacy_backup_inventory_changed');
  for(const candidate of candidates){
    const prefix=layout.root+candidate.id+'/',key=prefix+'expired.json';
    const expiry=candidate.marker??{version:1 as const,backupId:candidate.id,expiredAt:now};
    if(!candidate.marker)await objects.put(key,Buffer.from(JSON.stringify(expiry)));
    const persisted=await objects.get(key);
    if(!persisted||JSON.stringify(marker(persisted,candidate.id))!==JSON.stringify(expiry))
      throw new Error('legacy_backup_expiry_marker_unverified');
    // Keep the manifest until the last data deletion. A retry sees the marker and resumes,
    // even if a delayed upload left bytes behind; the ID can never become usable again.
    for(const file of [...candidate.files].sort((a,b)=>
      Number(a.key.endsWith('/manifest.json'))-Number(b.key.endsWith('/manifest.json')))){
      await objects.remove(file.key);result.removedObjects++;
    }
    const remaining=await objects.list();inventory(remaining,layout);
    if(remaining.some(file=>file.key.startsWith(prefix)&&file.key!==key))
      throw new Error('legacy_backup_expiry_incomplete');
  }
  return result;
}
