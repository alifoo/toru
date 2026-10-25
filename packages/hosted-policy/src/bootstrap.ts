import {openRecorderStore} from '@agent-recorder/mcp/store/open';
import {activateOperationalPolicy,dailyLimitsFromEnvironment,deploymentIdentityFromEnvironment} from '@agent-recorder/mcp/policies';
import {createHostedLifecycle} from './adapter.js';
import {deletionBucketConfig,type DeletionBucketJournal} from './deletion-bucket.js';

/** One-time migration under infra/start.sh's process flock, before serving requests. */
export async function bootstrapHostedStore(dataDir:string,env:NodeJS.ProcessEnv,bucket:DeletionBucketJournal){
 if(env.HOSTED_BOOTSTRAP_LEGACY!=='reviewed')throw new Error('hosted_legacy_bootstrap_review_required');
 const expectedLegacyChecksum=env.HOSTED_LEGACY_SNAPSHOT_SHA256;
 if(!expectedLegacyChecksum || !/^[a-f0-9]{64}$/.test(expectedLegacyChecksum))throw new Error('hosted_legacy_snapshot_checksum_required');
 const config=deletionBucketConfig(env);
 if(!config)throw new Error('hosted_deletion_bucket_required');
 const identity=deploymentIdentityFromEnvironment(env),limits=dailyLimitsFromEnvironment(env);
 if(identity.environment==='local')throw new Error('hosted_legacy_bootstrap_requires_deployment_environment');
 const store=await openRecorderStore(dataDir,{expectedLegacyChecksum});
 try{
  activateOperationalPolicy(store,limits,identity);
  createHostedLifecycle(store);
  store.connection.exec(`CREATE TABLE IF NOT EXISTS hosted_deletion_bucket_binding (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),bucket TEXT NOT NULL,bound_at INTEGER NOT NULL
  ) STRICT;`);
  const bound=store.connection.prepare('SELECT bucket FROM hosted_deletion_bucket_binding WHERE singleton=1').get();
  if(bound){
   if(bound.bucket!==config.name)throw new Error('hosted_deletion_bucket_binding_mismatch');
   return {bootstrapped:false};
  }
  await bucket.initialize(dataDir);
  store.transaction(()=>store.connection.prepare('INSERT INTO hosted_deletion_bucket_binding VALUES (1,?,?)').run(config.name,Date.now()));
  return {bootstrapped:true};
 }finally{store.close();}
}
