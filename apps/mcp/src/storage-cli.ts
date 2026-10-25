import { backupRecorderVolume, pruneLegacyMigrationBackup, pruneRecorderBackups, restoreRecorderBackup, verifyRecorderBackup } from './store/backup.js';
import {readLegacySnapshot} from './store/open.js';

async function run(args:string[]) {
  const option=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  const directory=option('--data-dir') ?? process.env.DATA_DIR ?? '/data';
  const destination=option('--output');
  const backup=option('--backup');
  if(args[0]==='inspect-legacy') {
    const snapshot=await readLegacySnapshot(directory);
    if(!snapshot.sources.length)throw new Error('legacy_snapshot_missing');
    console.log(JSON.stringify({checksum:snapshot.checksum,sourceFiles:snapshot.sources.length,
      grants:snapshot.invites.length,owners:new Set([...snapshot.invites,...snapshot.usage,...snapshot.jobs,...snapshot.imports].map(value=>value.owner)).size,
      jobs:snapshot.jobs.length,imports:snapshot.imports.length}));return;
  }
  if(args[0]==='prune' && option('--backup-root') && option('--retention-days')) {
    const days=Number(option('--retention-days'));
    const result=await pruneRecorderBackups(directory,option('--backup-root')!,days,args.includes('--apply'));
    console.log(JSON.stringify(result));return;
  }
  if(args[0]==='prune-migration' && option('--retention-days')) {
    const result=await pruneLegacyMigrationBackup(directory,Number(option('--retention-days')),args.includes('--apply'));
    console.log(JSON.stringify(result));return;
  }
  let result;
  if(args[0]==='backup' && destination) result=await backupRecorderVolume(directory,destination);
  else if(args[0]==='verify' && backup) result=await verifyRecorderBackup(backup);
  else if(args[0]==='restore' && backup && destination) result=await restoreRecorderBackup(backup,destination);
  else throw new Error('usage: storage-cli inspect-legacy --data-dir DIR | backup --data-dir DIR --output NEW_DIR | verify --backup DIR | restore --backup DIR --output NEW_ABS_DIR | prune --data-dir DIR --backup-root ABS_DIR --retention-days DAYS [--apply] | prune-migration --data-dir DIR --retention-days DAYS [--apply]');
  console.log(JSON.stringify({verified:true,files:result.files.length,bytes:result.files.reduce((total,file)=>total+file.bytes,0)}));
}
if(import.meta.url===`file://${process.argv[1]}`) run(process.argv.slice(2)).catch((error:unknown)=>{
  console.error(error instanceof Error?error.message:'storage_command_failed');process.exitCode=1;
});
