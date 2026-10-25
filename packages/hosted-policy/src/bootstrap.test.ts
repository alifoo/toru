import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readLegacySnapshot} from '@agent-recorder/mcp/store/open';
import {expect,it} from 'vitest';
import {bootstrapHostedStore} from './bootstrap.js';
import {DeletionBucketJournal,type JournalObjects} from './deletion-bucket.js';

it('migrates legacy data once, binds the bucket, and never recreates a missing journal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'recorder-hosted-bootstrap-'));
 const owner=randomUUID(),tokenHash=createHash('sha256').update('synthetic-grant').digest('hex');
 const objects=new Map<string,string>();
 const transport:JournalObjects={async put(key,body){objects.set(key,body);},async get(key){return objects.get(key);},async list(){return [...objects.keys()].sort();}};
 const bucket=new DeletionBucketJournal(transport);
 const env:NodeJS.ProcessEnv={HOSTED_BOOTSTRAP_LEGACY:'reviewed',RECORDER_ENVIRONMENT:'staging',
  RECORDER_INSTANCE_ID:'bootstrap-fixture',POLICY_ACTOR:'bootstrap-test',RECORDER_DEPLOYMENT_ID:'bootstrap-test-1',
  HOSTED_DELETION_BUCKET:'fixture-bucket',HOSTED_DELETION_BUCKET_ENDPOINT:'https://t3.storageapi.dev',
  HOSTED_DELETION_BUCKET_REGION:'auto',HOSTED_DELETION_BUCKET_ACCESS_KEY_ID:'fixture-key',
  HOSTED_DELETION_BUCKET_SECRET_ACCESS_KEY:'fixture-secret'};
 try{
  await writeFile(join(dir,'invites.json'),JSON.stringify({invites:[{owner,tokenHash,expiresAt:Date.now()+60000}]}));
  await expect(bootstrapHostedStore(dir,env,bucket)).rejects.toThrow('hosted_legacy_snapshot_checksum_required');
  env.HOSTED_LEGACY_SNAPSHOT_SHA256=(await readLegacySnapshot(dir)).checksum;
  await expect(bootstrapHostedStore(dir,{...env,HOSTED_LEGACY_SNAPSHOT_SHA256:'0'.repeat(64)},bucket)).rejects.toThrow('legacy_snapshot_mismatch');
  expect(await readFile(join(dir,'invites.json'),'utf8')).toContain(tokenHash);
  expect(await bootstrapHostedStore(dir,env,bucket)).toEqual({bootstrapped:true});
  expect(await bootstrapHostedStore(dir,env,bucket)).toEqual({bootstrapped:false});
  const deletedOwner=randomUUID();
  await bucket.record(dir,deletedOwner);
  // Simulate a crash after the bucket write but before the SQL binding commits.
  const interrupted=new DatabaseSync(join(dir,'recorder.sqlite'));
  try{interrupted.exec('DELETE FROM hosted_deletion_bucket_binding');}finally{interrupted.close();}
  expect(await bootstrapHostedStore(dir,env,bucket)).toEqual({bootstrapped:true});
  expect(objects.get(`${deletedOwner}.json`)).toContain(deletedOwner);
  const replayed:string[]=[];
  expect(await bucket.replay(dir,async value=>{replayed.push(value);})).toEqual({reapplied:1});
  expect(replayed).toEqual([deletedOwner]);
  await expect(bootstrapHostedStore(dir,{...env,HOSTED_DELETION_BUCKET:'other-bucket'},bucket)).rejects.toThrow('hosted_deletion_bucket_binding_mismatch');
  expect(await readdir(join(dir,'migration-backups'))).toHaveLength(1);
  expect(await readFile(join(dir,'invites.json'),'utf8')).toContain('retired');
  const db=new DatabaseSync(join(dir,'recorder.sqlite'));
  try{
   expect(db.prepare('SELECT environment,instance_id FROM instance_identity WHERE singleton=1').get()).toMatchObject({environment:'staging',instance_id:'bootstrap-fixture'});
   expect(db.prepare('SELECT owner FROM grants WHERE token_hash=?').get(tokenHash)).toMatchObject({owner});
   expect(db.prepare('SELECT bucket FROM hosted_deletion_bucket_binding WHERE singleton=1').get()).toMatchObject({bucket:'fixture-bucket'});
  }finally{db.close();}
  objects.delete('manifest.json');
  expect(await bootstrapHostedStore(dir,env,bucket)).toEqual({bootstrapped:false});
  await expect(bucket.replay(dir,async()=>undefined)).rejects.toThrow('deletion_journal_manifest_missing');
 }finally{await rm(dir,{recursive:true,force:true});}
});
