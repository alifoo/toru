import {legacyBackupBucketConfig,legacyBackupBucketObjects} from '@agent-recorder/hosted-policy/dist/legacy-backup-bucket.js';
import {pruneLegacyBackupObjects} from '@agent-recorder/hosted-policy/dist/legacy-backup-retention.js';

async function main(){
  const args=process.argv.slice(2);
  if(args.length>1||args.some(value=>value!=='--apply'))throw new Error('legacy_backup_prune_arguments_invalid');
  const days=Number(process.env.HOSTED_BACKUP_RETENTION_DAYS);
  const config=legacyBackupBucketConfig(process.env);
  const result=await pruneLegacyBackupObjects(legacyBackupBucketObjects(config),days,args.includes('--apply'));
  console.log(JSON.stringify(result));
}
main().catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)?error.message:'legacy_backup_prune_failed';
  console.error(code);process.exitCode=1;
});
