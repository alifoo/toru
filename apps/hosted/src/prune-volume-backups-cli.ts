import {legacyBackupBucketConfig,legacyBackupBucketObjects} from '@agent-recorder/hosted-policy/dist/legacy-backup-bucket.js';
import {pruneBackupObjects} from '@agent-recorder/hosted-policy/dist/legacy-backup-retention.js';
import {volumeBackupLayout,volumeBackupRoot} from '@agent-recorder/hosted-policy/dist/volume-backup.js';

async function main(){
  const args=process.argv.slice(2);
  if(args.length>1||args.some(value=>value!=='--apply'))throw new Error('volume_backup_prune_arguments_invalid');
  const config=legacyBackupBucketConfig(process.env);
  console.log(JSON.stringify(await pruneBackupObjects(legacyBackupBucketObjects(config,volumeBackupRoot),
    Number(process.env.HOSTED_BACKUP_RETENTION_DAYS),args.includes('--apply'),Date.now(),volumeBackupLayout)));
}
main().catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)?error.message:'volume_backup_prune_failed';
  console.error(code);process.exitCode=1;
});
