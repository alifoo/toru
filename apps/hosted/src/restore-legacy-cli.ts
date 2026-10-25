import {resolve,sep} from 'node:path';
import {restoreLegacyBackup} from '@agent-recorder/hosted-policy/dist/legacy-backup.js';
import {legacyBackupBucketConfig,legacyBackupBucketObjects} from '@agent-recorder/hosted-policy/dist/legacy-backup-bucket.js';

async function main(){
  const backupId=process.env.HOSTED_LEGACY_BACKUP_ID;
  const checksum=process.env.HOSTED_LEGACY_BACKUP_MANIFEST_SHA256;
  const destination=process.env.HOSTED_LEGACY_RESTORE_DIR;
  if(!backupId||!checksum||!destination)throw new Error('legacy_restore_configuration_required');
  const target=resolve(destination),volume=resolve(process.env.DATA_DIR??'/data');
  if(target===volume||target.startsWith(volume+sep))throw new Error('legacy_restore_inside_active_volume');
  const config=legacyBackupBucketConfig(process.env);
  const result=await restoreLegacyBackup(legacyBackupBucketObjects(config),backupId,destination,checksum);
  console.log(JSON.stringify({backupId,manifestSha256:result.manifestSha256,
    semanticChecksum:result.manifest.semanticChecksum,files:result.manifest.files.length,
    bytes:result.manifest.files.reduce((sum,file)=>sum+file.bytes,0),destination:target}));
}
main().catch((error:unknown)=>{
  console.error(error instanceof Error?error.message:'legacy_restore_failed');process.exitCode=1;
});
