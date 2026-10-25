// Offline cutover rehearsal on a private copy. No provider credentials or production writes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readLegacySnapshot} from '../apps/mcp/dist/store/open.js';
import {bootstrapHostedStore} from '../packages/hosted-policy/dist/bootstrap.js';
import {DeletionBucketJournal} from '../packages/hosted-policy/dist/deletion-bucket.js';

const args=process.argv.slice(2);
const option=(name)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const source=option('--source'),expected=option('--expected-checksum');
const grants=Number(option('--expected-grants')),owners=Number(option('--expected-owners'));
if(args.length!==8 || !source || !isAbsolute(source) || !/^[a-f0-9]{64}$/.test(expected??'') ||
 !Number.isSafeInteger(grants) || grants<0 || !Number.isSafeInteger(owners) || owners<0){
 process.stderr.write('usage: rehearse-legacy-bootstrap --source ABS_PRIVATE_BACKUP_DIR --expected-checksum SHA256 --expected-grants N --expected-owners N\n');
 process.exit(2);
}

const work=await mkdtemp(join(tmpdir(),'recorder-cutover-rehearsal-'));
const dataDir=join(work,'data');
try{
 const original=await readLegacySnapshot(source);
 assert.ok(original.sources.length,'legacy_snapshot_missing');
 assert.equal(original.checksum,expected,'source_snapshot_mismatch');
 await cp(source,dataDir,{recursive:true,force:false,errorOnExist:true});
 const copied=await readLegacySnapshot(dataDir);
 assert.equal(copied.checksum,expected,'backup_copy_mismatch');
 assert.equal(copied.invites.length,grants,'legacy_grant_count_mismatch');
 const expectedOwners=new Set([...copied.invites,...copied.usage,...copied.jobs,...copied.imports].map(value=>value.owner)).size;
 assert.equal(expectedOwners,owners,'legacy_owner_count_mismatch');

 const objects=new Map();
 const bucket=new DeletionBucketJournal({
  async put(key,body){objects.set(key,body);},
  async get(key){return objects.get(key);},
  async list(){return [...objects.keys()].sort();},
 });
 const env={HOSTED_BOOTSTRAP_LEGACY:'reviewed',HOSTED_LEGACY_SNAPSHOT_SHA256:expected,
  RECORDER_ENVIRONMENT:'staging',RECORDER_INSTANCE_ID:`rehearsal-${randomUUID()}`,
  POLICY_ACTOR:'offline-rehearsal',RECORDER_DEPLOYMENT_ID:'offline-rehearsal',
  HOSTED_DELETION_BUCKET:'rehearsal-only',HOSTED_DELETION_BUCKET_ENDPOINT:'https://t3.storageapi.dev',
  HOSTED_DELETION_BUCKET_REGION:'auto',HOSTED_DELETION_BUCKET_ACCESS_KEY_ID:'fixture',
  HOSTED_DELETION_BUCKET_SECRET_ACCESS_KEY:'fixture'};
 assert.deepEqual(await bootstrapHostedStore(dataDir,env,bucket),{bootstrapped:true});
 assert.deepEqual(await bootstrapHostedStore(dataDir,env,bucket),{bootstrapped:false});
 const db=new DatabaseSync(join(dataDir,'recorder.sqlite'));
 try{
  assert.equal(db.prepare('SELECT count(*) n FROM grants').get().n,grants);
  assert.equal(db.prepare('SELECT count(*) n FROM accounts').get().n,owners);
  assert.equal(db.prepare("SELECT checksum FROM legacy_imports WHERE source='legacy-v1'").get().checksum,expected);
  assert.equal(db.prepare('SELECT bucket FROM hosted_deletion_bucket_binding WHERE singleton=1').get().bucket,'rehearsal-only');
 }finally{db.close();}
 assert.match(await readFile(join(dataDir,'invites.json'),'utf8'),/Legacy JSON storage retired/);
 assert.equal((await bucket.replay(dataDir,async()=>{})).reapplied,0);
 process.stdout.write(`${JSON.stringify({result:'passed',checksum:expected,grants,owners,journalBound:true,retryIdempotent:true})}\n`);
}finally{await rm(work,{recursive:true,force:true});}
