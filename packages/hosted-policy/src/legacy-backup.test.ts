import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {exportLegacyBackup,restoreLegacyBackup,type LegacyBackupObjectStore} from './legacy-backup.js';
import {legacyBackupBucketConfig} from './legacy-backup-bucket.js';

const owner='11111111-1111-4111-8111-111111111111';
const jobId='22222222-2222-4222-8222-222222222222';
const backupId='33333333-3333-4333-8333-333333333333';
const prefix=`agent-recorder/legacy-backups/v1/${backupId}/`;

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'recorder-legacy-export-'));
  await mkdir(join(dir,'jobs',jobId),{recursive:true});
  await writeFile(join(dir,'invites.json'),JSON.stringify({invites:[{
    owner,tokenHash:'a'.repeat(64),expiresAt:2_000_000_000_000
  }]}));
  await writeFile(join(dir,'usage.json'),JSON.stringify({[`${owner}:2026-09-29`]:{
    browserMs:1000,renderMs:2000
  }}));
  await writeFile(join(dir,'jobs',jobId,'job.json'),JSON.stringify({id:jobId,owner,status:'captured',
    createdAt:1_800_000_000_000,expiresAt:1_800_000_060_000,allowedOrigins:['https://example.com']}));
  await writeFile(join(dir,'jobs',jobId,'raw.webm'),Buffer.from('synthetic-media'));
  const objects=new Map<string,Uint8Array>();let puts=0;
  const store:LegacyBackupObjectStore={
    async put(key,body){puts++;objects.set(key,Uint8Array.from(body));},
    async get(key){const body=objects.get(key);return body&&Uint8Array.from(body);}
  };
  return {dir,objects,store,puts:()=>puts,close:()=>rm(dir,{recursive:true,force:true})};
}

it('uploads every legacy file, reads it back, publishes the manifest last and reuses a verified backup',async()=>{
  const f=await fixture();
  try{
    const first=await exportLegacyBackup(f.dir,f.store,backupId,1_800_000_000_000);
    expect(first.reused).toBe(false);
    expect(first.manifest.files.map(file=>file.path)).toEqual([
      'invites.json',`jobs/${jobId}/job.json`,`jobs/${jobId}/raw.webm`,'usage.json'
    ]);
    const raw=f.objects.get(`${prefix}jobs/${jobId}/raw.webm`);
    expect(Buffer.from(raw!)).toEqual(Buffer.from('synthetic-media'));
    const manifest=f.objects.get(`${prefix}manifest.json`)!;
    expect(createHash('sha256').update(manifest).digest('hex')).toBe(first.manifestSha256);
    const count=f.puts();
    const second=await exportLegacyBackup(f.dir,f.store,backupId,1_800_000_050_000);
    expect(second.reused).toBe(true);
    expect(f.puts()).toBe(count);
    expect(second.manifestSha256).toBe(first.manifestSha256);
    f.objects.set(`${prefix}jobs/${jobId}/raw.webm`,Buffer.from('tampered'));
    await expect(exportLegacyBackup(f.dir,f.store,backupId)).rejects.toThrow('legacy_backup_remote_mismatch');
  }finally{await f.close();}
});

it('never publishes a manifest after a failed upload or changed source',async()=>{
  const f=await fixture();
  try{
    const failing:LegacyBackupObjectStore={...f.store,
      async put(key,body){
        if(key.endsWith('usage.json'))throw new Error('bucket_unavailable');
        await f.store.put(key,body);
      }
    };
    await expect(exportLegacyBackup(f.dir,failing,backupId)).rejects.toThrow('bucket_unavailable');
    expect(f.objects.has(`${prefix}manifest.json`)).toBe(false);
    const mutated:LegacyBackupObjectStore={...f.store,
      async put(key,body){
        await f.store.put(key,body);
        if(key.endsWith('raw.webm'))await writeFile(join(f.dir,'jobs',jobId,'raw.webm'),'changed');
      }
    };
    await expect(exportLegacyBackup(f.dir,mutated,backupId)).rejects.toThrow('legacy_backup_source_changed');
    expect(f.objects.has(`${prefix}manifest.json`)).toBe(false);
    await writeFile(join(f.dir,'recorder.sqlite'),'not a legacy volume');
    await expect(exportLegacyBackup(f.dir,f.store,backupId)).rejects.toThrow('legacy_backup_requires_json_volume');
  }finally{await f.close();}
});

it('restores a complete backup into a new directory and refuses tampered objects or manifest',async()=>{
  const f=await fixture();
  const parent=await mkdtemp(join(tmpdir(),'recorder-legacy-restore-'));
  try{
    const exported=await exportLegacyBackup(f.dir,f.store,backupId);
    const destination=join(parent,'restored');
    const result=await restoreLegacyBackup(f.store,backupId,destination,exported.manifestSha256);
    expect(result.manifest.semanticChecksum).toBe(exported.manifest.semanticChecksum);
    expect(await readFile(join(destination,'jobs',jobId,'raw.webm'),'utf8')).toBe('synthetic-media');
    await expect(restoreLegacyBackup(f.store,backupId,destination,exported.manifestSha256))
      .rejects.toThrow('legacy_restore_destination_exists');
    f.objects.set(`${prefix}jobs/${jobId}/raw.webm`,Buffer.from('tampered'));
    await expect(restoreLegacyBackup(f.store,backupId,join(parent,'bad-file'),exported.manifestSha256))
      .rejects.toThrow('legacy_backup_remote_mismatch');
    f.objects.set(`${prefix}manifest.json`,Buffer.from('{}'));
    await expect(restoreLegacyBackup(f.store,backupId,join(parent,'bad-manifest'),exported.manifestSha256))
      .rejects.toThrow('legacy_backup_manifest_mismatch');
  }finally{await f.close();await rm(parent,{recursive:true,force:true});}
});

it('requires a separate private backup bucket configuration',()=>{
  const env={HOSTED_BACKUP_BUCKET:'backup-xyz',HOSTED_BACKUP_BUCKET_ENDPOINT:'https://t3.storageapi.dev/',
    HOSTED_BACKUP_BUCKET_REGION:'auto',HOSTED_BACKUP_BUCKET_ACCESS_KEY_ID:'test',
    HOSTED_BACKUP_BUCKET_SECRET_ACCESS_KEY:'secret',HOSTED_DELETION_BUCKET:'deletions-xyz'};
  expect(legacyBackupBucketConfig(env).name).toBe('backup-xyz');
  expect(()=>legacyBackupBucketConfig({...env,HOSTED_DELETION_BUCKET:'backup-xyz'}))
    .toThrow('legacy_backup_bucket_config_invalid');
  expect(()=>legacyBackupBucketConfig({...env,HOSTED_BACKUP_BUCKET_ENDPOINT:'http://localhost/'}))
    .toThrow('legacy_backup_bucket_config_invalid');
});

it('refuses unknown volume entries rather than silently leaving data out of the backup',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.dir,'.unexpected-data'),'must not be missed');
    await expect(exportLegacyBackup(f.dir,f.store,backupId))
      .rejects.toThrow('legacy_backup_unrecognized_volume_entry');
    expect(f.objects.size).toBe(0);
  }finally{await f.close();}
});
