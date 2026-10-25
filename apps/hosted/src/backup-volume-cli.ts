import {deploymentIdentityFromEnvironment} from '@agent-recorder/mcp/policies';
import {exportVolumeBackup,volumeBackupRoot} from '@agent-recorder/hosted-policy/dist/volume-backup.js';
import {legacyBackupBucketConfig,legacyBackupBucketObjects} from '@agent-recorder/hosted-policy/dist/legacy-backup-bucket.js';
import {createLegacyBackupMaintenanceServer} from './backup-legacy-http.js';

async function main(){
  if(process.env.RECORDER_MODE!=='backup-volume'||process.env.RECORDER_MAINTENANCE_LOCK!=='held')
    throw new Error('volume_backup_requires_maintenance_entrypoint');
  const id=process.env.HOSTED_VOLUME_BACKUP_ID;
  if(!id||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('volume_backup_id_invalid');
  const port=Number(process.env.PORT??3002);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('volume_backup_port_invalid');
  const config=legacyBackupBucketConfig(process.env),deployment=deploymentIdentityFromEnvironment(process.env);
  const identity={environment:deployment.environment,instanceId:deployment.instanceId};
  let phase:'copying'|'verified'='copying';
  const server=createLegacyBackupMaintenanceServer(()=>phase);
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);server.listen(port,'0.0.0.0',()=>{server.off('error',reject);resolve();});
  });
  const stop=()=>{if(phase!=='verified')process.exit(1);server.close(()=>process.exit(0));server.closeAllConnections();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    const result=await exportVolumeBackup(process.env.DATA_DIR??'/data',legacyBackupBucketObjects(config,volumeBackupRoot),id,identity);
    phase='verified';console.log(JSON.stringify({backupId:id,manifestSha256:result.manifestSha256,
      files:result.manifest.files.length,bytes:result.manifest.files.reduce((sum,file)=>sum+file.bytes,0),reused:result.reused}));
    // Remain in maintenance with the volume locked until the controlled return to hosted.
  }catch(error){
    process.off('SIGTERM',stop);process.off('SIGINT',stop);server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));throw error;
  }
}
main().catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)?error.message:'volume_backup_failed';
  console.error(code);process.exitCode=1;
});
