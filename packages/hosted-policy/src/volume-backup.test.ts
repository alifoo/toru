import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {expect,it} from 'vitest';
import {openRecorderStore} from '@agent-recorder/mcp/store/open';
import {activateOperationalPolicy,dailyLimitsFromEnvironment} from '@agent-recorder/mcp/policies';
import {eraseAccountData} from '@agent-recorder/mcp/erasure';
import {createHostedLifecycle} from './adapter.js';
import {DeletionBucketJournal} from './deletion-bucket.js';
import {pruneBackupObjects,type LegacyBackupRetentionObjects} from './legacy-backup-retention.js';
import {exportVolumeBackup,restoreVolumeBackup,volumeBackupLayout,volumeBackupRoot} from './volume-backup.js';

const identity={environment:'staging' as const,instanceId:'backup-fixture'},sha=(body:Uint8Array)=>createHash('sha256').update(body).digest('hex');
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'recorder-volume-bucket-')),source=join(root,'source');await mkdir(source);
  const owner=randomUUID(),job=randomUUID(),importId=randomUUID(),id=randomUUID(),now=Date.now();
  const store=await openRecorderStore(source);
  try{
    activateOperationalPolicy(store,dailyLimitsFromEnvironment({}),{...identity,actor:'fixture',deploymentId:randomUUID()});
    createHostedLifecycle(store);
    store.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,now);
    store.connection.prepare('INSERT INTO grants(token_hash,owner,expires_at,created_at) VALUES (?,?,?,?)').run('a'.repeat(64),owner,now+3600_000,now);
    store.connection.prepare('INSERT INTO daily_usage(owner,day,browser_ms) VALUES (?,?,?)').run(owner,'2026-09-29',1234);
    const metadata={id:job,owner,status:'completed',createdAt:now,expiresAt:now+3600_000,allowedOrigins:['https://example.com']};
    store.connection.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(job,owner,'completed',now,now+3600_000,JSON.stringify(metadata));
    store.connection.prepare('INSERT INTO session_imports(id,owner,expires_at,checksum,relative_path) VALUES (?,?,?,?,?)')
      .run(importId,owner,now+3600_000,'ciphertext-checksum',`imports/${importId}.json`);
  }finally{store.close();}
  await mkdir(join(source,'jobs',job),{recursive:true});await mkdir(join(source,'imports'));
  const media=Buffer.alloc(9*1024*1024,42);await writeFile(join(source,'jobs',job,'video.mp4'),media);
  await writeFile(join(source,'imports',`${importId}.json`),'synthetic-encrypted-import');
  await writeFile(join(source,'sandbox-vms.json'),JSON.stringify(['synthetic_sandbox_id_1234']));
  const values=new Map<string,Uint8Array>(),objects:LegacyBackupRetentionObjects={
    async put(key,body){values.set(key,Uint8Array.from(body));},
    async get(key){const value=values.get(key);return value&&Uint8Array.from(value);},
    async list(){return [...values].map(([key,body])=>({key,modifiedAt:now,etag:sha(body)}));},
    async remove(key){values.delete(key);}
  };
  const entries=new Map<string,string>(),journal=new DeletionBucketJournal({
    async put(key,body){entries.set(key,body);},async get(key){return entries.get(key);},async list(){return [...entries.keys()];}
  });await journal.initialize(source);
  return {root,source,owner,job,importId,id,objects,values,entries,journal,media,now,
    close:async()=>{values.clear();await rm(root,{recursive:true,force:true});}};
}
const replay=(f:Awaited<ReturnType<typeof fixture>>)=>(dir:string)=>
  f.journal.replay(dir,owner=>eraseAccountData(dir,owner,createHostedLifecycle,{tombstoneMissingAccount:true})).then(()=>undefined);

it('requires deletion replay before it opens or publishes a restore',async()=>{
  const objects:LegacyBackupRetentionObjects={
    async get(){throw new Error('bucket_must_not_be_read');},
    async put(){throw new Error('bucket_must_not_be_written');},
    async list(){throw new Error('bucket_must_not_be_listed');},
    async remove(){throw new Error('bucket_must_not_be_modified');}
  };
  await expect(restoreVolumeBackup(objects,randomUUID(),join(tmpdir(),'unpublished'), 'a'.repeat(64),
    identity,join(tmpdir(),'active'),undefined as never)).rejects.toThrow('volume_restore_deletion_replay_required');
});

it('round-trips SQL, multi-chunk media, encrypted import and VM journal, preserving identity and retrying the same ID',async()=>{
  const f=await fixture();
  try{
    const result=await exportVolumeBackup(f.source,f.objects,f.id,identity);
    expect(result.manifest.files.find(file=>file.path.endsWith('/video.mp4'))?.chunks).toHaveLength(2);
    expect((await exportVolumeBackup(f.source,f.objects,f.id,identity)).manifestSha256).toBe(result.manifestSha256);
    const destination=join(f.root,'restored');
    await expect(restoreVolumeBackup(f.objects,f.id,destination,result.manifestSha256,identity,f.source,undefined as never))
      .rejects.toThrow('volume_restore_deletion_replay_required');
    expect(await readdir(f.root)).not.toContain('restored');
    await restoreVolumeBackup(f.objects,f.id,destination,result.manifestSha256,identity,f.source,replay(f));
    expect(sha(await readFile(join(destination,'jobs',f.job,'video.mp4')))).toBe(sha(f.media));
    expect(await readFile(join(destination,'imports',`${f.importId}.json`),'utf8')).toBe('synthetic-encrypted-import');
    expect(JSON.parse(await readFile(join(destination,'sandbox-vms.json'),'utf8'))).toEqual(['synthetic_sandbox_id_1234']);
    const db=new DatabaseSync(join(destination,'recorder.sqlite'),{readOnly:true});
    try{
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(db.prepare('SELECT owner FROM grants').get()?.owner).toBe(f.owner);
      expect(db.prepare('SELECT browser_ms FROM daily_usage').get()?.browser_ms).toBe(1234);
    }finally{db.close();}
    await expect(restoreVolumeBackup(f.objects,f.id,destination,result.manifestSha256,identity,f.source,replay(f))).rejects.toThrow('volume_restore_destination_exists');
    await symlink(f.source,join(f.root,'alias'),'dir');
    await expect(restoreVolumeBackup(f.objects,f.id,join(f.root,'alias','nested'),result.manifestSha256,identity,f.source,replay(f)))
      .rejects.toThrow('volume_restore_inside_active_volume');
  }finally{await f.close();}
});

it('rejects tampered chunks and unsafe manifests without publishing a restore',async()=>{
  const f=await fixture();
  try{
    const result=await exportVolumeBackup(f.source,f.objects,f.id,identity),prefix=volumeBackupRoot+f.id+'/';
    const key=[...f.values.keys()].find(value=>value.endsWith('/data/0/0'))!;f.values.set(key,Buffer.from('tampered'));
    await expect(restoreVolumeBackup(f.objects,f.id,join(f.root,'bad'),result.manifestSha256,identity,f.source,replay(f)))
      .rejects.toThrow('volume_backup_remote_mismatch');
    expect(await readdir(f.root)).not.toContain('bad');
    const altered=JSON.parse(Buffer.from(f.values.get(prefix+'manifest.json')!).toString());
    altered.files[0].path='../escape';altered.volume.files[0].path='../escape';
    const body=Buffer.from(JSON.stringify(altered));f.values.set(prefix+'manifest.json',body);
    await expect(restoreVolumeBackup(f.objects,f.id,join(f.root,'unsafe'),sha(body),identity,f.source,replay(f)))
      .rejects.toThrow('volume_backup_manifest_invalid');
    expect(await readdir(f.root)).not.toContain('unsafe');
  }finally{await f.close();}
});

it('replays an independent deletion recorded after the snapshot before publishing restored data',async()=>{
  const f=await fixture();
  try{
    const result=await exportVolumeBackup(f.source,f.objects,f.id,identity);
    await f.journal.record(f.source,f.owner);
    const destination=join(f.root,'replayed');
    await restoreVolumeBackup(f.objects,f.id,destination,result.manifestSha256,identity,f.source,replay(f));
    await expect(readFile(join(destination,'jobs',f.job,'video.mp4'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(join(destination,'imports',`${f.importId}.json`))).rejects.toMatchObject({code:'ENOENT'});
    const db=new DatabaseSync(join(destination,'recorder.sqlite'),{readOnly:true});
    try{
      expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)?.admission_status).toBe('deleted');
      expect(db.prepare('SELECT revoked_at FROM grants WHERE owner=?').get(f.owner)?.revoked_at).not.toBeNull();
    }finally{db.close();}
    f.entries.set('manifest.json','{}');
    await expect(restoreVolumeBackup(f.objects,f.id,join(f.root,'journal-failed'),result.manifestSha256,identity,f.source,
      async dir=>{await f.journal.replay(dir,async()=>undefined);})).rejects.toThrow('deletion_journal_volume_identity_mismatch');
    expect(await readdir(f.root)).not.toContain('journal-failed');
  }finally{await f.close();}
});

it('expires complete SQL backups through the shared fenced sweep and prevents restored/reused IDs',async()=>{
  const f=await fixture();
  try{
    const result=await exportVolumeBackup(f.source,f.objects,f.id,identity),future=f.now+20*86_400_000;
    const preview=await pruneBackupObjects(f.objects,7,false,future,volumeBackupLayout);
    expect(preview.expiredBackups).toBe(1);expect(preview.plannedObjects).toBe(f.values.size);
    const applied=await pruneBackupObjects(f.objects,7,true,future,volumeBackupLayout);
    expect(applied.removedObjects).toBe(preview.plannedObjects);
    expect([...f.values.keys()]).toEqual([volumeBackupRoot+f.id+'/expired.json']);
    await expect(restoreVolumeBackup(f.objects,f.id,join(f.root,'expired'),result.manifestSha256,identity,f.source,replay(f)))
      .rejects.toThrow('volume_backup_expired');
    await expect(exportVolumeBackup(f.source,f.objects,f.id,identity)).rejects.toThrow('volume_backup_expired');
  }finally{await f.close();}
});

it('refuses a wrong source/restore identity and never publishes after a replay failure',async()=>{
  const f=await fixture();
  try{
    const wrong={...identity,instanceId:'another-instance'};
    await expect(exportVolumeBackup(f.source,f.objects,f.id,wrong)).rejects.toThrow('volume_backup_identity_mismatch');
    expect(f.values.size).toBe(0);
    const result=await exportVolumeBackup(f.source,f.objects,f.id,identity);
    await expect(restoreVolumeBackup(f.objects,f.id,join(f.root,'wrong'),result.manifestSha256,wrong,f.source,replay(f)))
      .rejects.toThrow('volume_backup_identity_mismatch');
    await expect(restoreVolumeBackup(f.objects,f.id,join(f.root,'failed'),result.manifestSha256,identity,f.source,
      async()=>{throw new Error('journal_unavailable');})).rejects.toThrow('journal_unavailable');
    expect((await readdir(f.root)).filter(name=>name==='failed'||name.startsWith('.recorder-volume-restore-'))).toEqual([]);
  }finally{await f.close();}
});
