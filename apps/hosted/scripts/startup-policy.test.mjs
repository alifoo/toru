import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateHostedStartupEnvironment} from '../dist/startup-policy.js';
import {createHostedRuntime} from '../dist/hosted-runtime.js';

const bucket={HOSTED_DELETION_BUCKET:'deletions',HOSTED_DELETION_BUCKET_ENDPOINT:'https://t3.storageapi.dev',
 HOSTED_DELETION_BUCKET_REGION:'auto',HOSTED_DELETION_BUCKET_ACCESS_KEY_ID:'fixture-key',HOSTED_DELETION_BUCKET_SECRET_ACCESS_KEY:'fixture-secret'};
const worker={HOSTED_WORKER_MODE:'railway',HOSTED_WORKER_CHECKPOINT:'recorder-worker-rc1',
 HOSTED_WORKER_IMAGE_SHA256:`sha256:${'a'.repeat(64)}`,RAILWAY_TOKEN:'fixture-project-token',
 RAILWAY_ENVIRONMENT_ID:'123e4567-e89b-12d3-a456-426614174000'};
test('hosted staging and production require a sandbox and independent bucket journal',()=>{
  for(const environment of ['staging','production']){
    assert.throws(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment,CHROME_NO_SANDBOX:'1',...bucket}),/hosted_browser_sandbox_required/);
    assert.throws(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment}),/hosted_deletion_bucket_required/);
    assert.throws(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment,HOSTED_DELETION_JOURNAL:'/data/deletions'}),/hosted_deletion_bucket_required/);
    assert.throws(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment,...bucket,HOSTED_DELETION_JOURNAL:'/deletions'}),/hosted_deletion_journal_conflict/);
    assert.throws(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment,...bucket}),/hosted_isolated_runtime_required/);
    assert.throws(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment,...bucket,...worker,HOSTED_WORKER_IMAGE_SHA256:'worker:latest'}),/hosted_worker_image_digest_required/);
    assert.throws(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment,...bucket,...worker,RAILWAY_TOKEN:''}),/hosted_project_token_required/);
    assert.doesNotThrow(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:environment,...bucket,...worker}));
  }
  assert.doesNotThrow(()=>validateHostedStartupEnvironment({RECORDER_ENVIRONMENT:'local',CHROME_NO_SANDBOX:'1'}));
  assert.throws(()=>validateHostedStartupEnvironment({}),/hosted_environment_required/);
});

test('hosted startup selects a remote runtime only with explicit worker configuration',async()=>{
 assert.equal(createHostedRuntime({RECORDER_ENVIRONMENT:'local'},'/tmp/fixture'),undefined);
 assert.throws(()=>createHostedRuntime({RECORDER_ENVIRONMENT:'production'},'/tmp/fixture'),/hosted_isolated_runtime_required/);
 const runtime=createHostedRuntime({RECORDER_ENVIRONMENT:'production',...worker},'/tmp/fixture');
 assert.ok(runtime);await runtime.close();
});
