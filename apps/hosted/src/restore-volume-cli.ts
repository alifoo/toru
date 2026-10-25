import {deploymentIdentityFromEnvironment} from '@agent-recorder/mcp/policies';
import {eraseAccountData} from '@agent-recorder/mcp/erasure';
import {createHostedLifecycle} from '@agent-recorder/hosted-policy/dist/adapter.js';
import {deletionBucketFromEnvironment} from '@agent-recorder/hosted-policy/dist/deletion-bucket.js';
import {restoreVolumeBackup,volumeBackupRoot} from '@agent-recorder/hosted-policy/dist/volume-backup.js';
import {legacyBackupBucketConfig,legacyBackupBucketObjects} from '@agent-recorder/hosted-policy/dist/legacy-backup-bucket.js';

async function main(){
  const id=process.env.HOSTED_VOLUME_BACKUP_ID,hash=process.env.HOSTED_VOLUME_BACKUP_MANIFEST_SHA256;
  const destination=process.env.HOSTED_VOLUME_RESTORE_DIR;
  if(!id||!hash||!destination)throw new Error('volume_restore_configuration_required');
  const deployment=deploymentIdentityFromEnvironment(process.env),config=legacyBackupBucketConfig(process.env);
  const bucket=deletionBucketFromEnvironment(process.env);
  if(!bucket)throw new Error('volume_restore_deletion_bucket_required');
  const result=await restoreVolumeBackup(legacyBackupBucketObjects(config,volumeBackupRoot),id,destination,hash,
    {environment:deployment.environment,instanceId:deployment.instanceId},process.env.DATA_DIR??'/data',
    directory=>bucket.replay(directory,owner=>eraseAccountData(directory,owner,createHostedLifecycle,{tombstoneMissingAccount:true})).then(()=>undefined));
  console.log(JSON.stringify({backupId:id,manifestSha256:result.manifestSha256,files:result.manifest.files.length,
    deletionReplay:'verified'}));
}
main().catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)?error.message:'volume_restore_failed';
  console.error(code);process.exitCode=1;
});
