import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {DeletionBucketJournal} from '@agent-recorder/hosted-policy/dist/deletion-bucket.js';
import {bootstrapEmptyHostedStore} from '../dist/bootstrap-empty.js';

const env={RECORDER_ENVIRONMENT:'production',RECORDER_INSTANCE_ID:'recorder-beta-test',
  POLICY_ACTOR:'operator:test',RECORDER_DEPLOYMENT_ID:'deploy-test',
  HOSTED_DELETION_BUCKET:'recorder-test-journal',
  HOSTED_DELETION_BUCKET_ENDPOINT:'https://bucket.example/',
  HOSTED_DELETION_BUCKET_REGION:'auto',
  HOSTED_DELETION_BUCKET_ACCESS_KEY_ID:'test-access',
  HOSTED_DELETION_BUCKET_SECRET_ACCESS_KEY:'test-secret'};

test('fresh volume initialization is idempotent and rejects legacy JSON before migration',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recorder-empty-bootstrap-'));
  const legacy=await mkdtemp(join(tmpdir(),'recorder-legacy-reject-'));
  const objects=new Map();
  const bucket=new DeletionBucketJournal({
    put:async(key,value)=>{objects.set(key,value);},
    get:async key=>objects.get(key),
    list:async()=>[...objects.keys()].sort()
  });
  try{
    await bootstrapEmptyHostedStore(dir,env,bucket);
    await bootstrapEmptyHostedStore(dir,env,bucket);
    assert.deepEqual(JSON.parse(objects.get('manifest.json')),
      {version:1,environment:'production',instanceId:'recorder-beta-test'});
    await writeFile(join(legacy,'invites.json'),JSON.stringify({invites:[]}));
    await assert.rejects(bootstrapEmptyHostedStore(legacy,env,bucket),/empty_bootstrap_legacy_data_present/);
    await assert.rejects(stat(join(legacy,'recorder.sqlite')),{code:'ENOENT'});
  }finally{await rm(dir,{recursive:true,force:true});await rm(legacy,{recursive:true,force:true});}
});
