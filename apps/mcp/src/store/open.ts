import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, rename, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RecorderDatabase } from './database.js';
import { importLegacySnapshot, readLegacySnapshot } from './legacy.js';
import { exclusiveProcessLock } from './lock.js';

export const databaseName = 'recorder.sqlite';
export {readLegacySnapshot} from './legacy.js';
const retired = 'Legacy JSON storage retired. Use recorder.sqlite; do not start a JSON-only binary.\n';
async function durableWrite(path:string, contents:string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp,'wx',0o600);
  try {await file.writeFile(contents);await file.sync();} finally {await file.close();}
  await rename(temp,path);
  const directory = await open(dirname(path),'r');
  try {await directory.sync();} finally {await directory.close();}
}
async function checksum(path:string) {
  const hash = createHash('sha256');
  for await(const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Before any SQL cutover, preserve metadata AND retained media on the exclusively locked volume. */
async function legacyBackup(dataDir:string) {
  const target = join(dataDir,'migration-backups',randomUUID());
  await mkdir(target,{recursive:true,mode:0o700});
  const manifest:{path:string;bytes:number;sha256:string}[] = [];
  async function copy(relative:string) {
    const source = join(dataDir,relative);
    let info;
    try {info = await lstat(source);} catch(error) {if((error as NodeJS.ErrnoException).code === 'ENOENT') return;throw error;}
    if(info.isDirectory()) {
      await mkdir(join(target,relative),{recursive:true,mode:0o700});
      for(const name of (await readdir(source)).sort()) await copy(`${relative}/${name}`);
      return;
    }
    if(!info.isFile()) throw new Error('invalid_legacy_backup_file');
    const destination = join(target,relative);
    await copyFile(source,destination);
    const handle = await open(destination,'r+');
    try {await handle.chmod(0o600);await handle.sync();} finally {await handle.close();}
    const sha256 = await checksum(destination);
    if(sha256 !== await checksum(source)) throw new Error('legacy_backup_mismatch');
    manifest.push({path:relative,bytes:info.size,sha256});
  }
  for(const name of ['invites.json','usage.json','jobs','imports']) await copy(name);
  await durableWrite(join(target,'manifest.json'),JSON.stringify({version:1,files:manifest},null,2));
  // Persist directory entries before publishing a SQL receipt that depends on this backup.
  async function syncDirectories(path:string):Promise<void> {
    for(const entry of await readdir(path,{withFileTypes:true})) if(entry.isDirectory()) await syncDirectories(join(path,entry.name));
    const handle = await open(path,'r');try {await handle.sync();} finally {await handle.close();}
  }
  await syncDirectories(target);
  const parent = await open(dirname(target),'r');try {await parent.sync();} finally {await parent.close();}
  return target;
}

/** Serialized initialization; afterwards auth/CLI use short SQL transactions alongside the runtime. */
export async function openRecorderStore(dataDir:string,options:{expectedLegacyChecksum?:string}={}):Promise<RecorderDatabase> {
  const expected=options.expectedLegacyChecksum;
  if(expected!==undefined && !/^[a-f0-9]{64}$/.test(expected))throw new Error('invalid_legacy_snapshot_checksum');
  let release:(() => void)|undefined;
  for(let attempt=0; attempt<200; attempt++) {
    try {release = exclusiveProcessLock(join(dataDir,'.migration-lock.sqlite'));break;}
    catch(error) {if(!(error instanceof Error) || error.message !== 'recorder_store_busy' || attempt === 199) throw error;}
    await new Promise(resolve => setTimeout(resolve,25));
  }
  if(!release) throw new Error('recorder_store_busy');
  let db:RecorderDatabase|undefined;
  try {
    db = new RecorderDatabase(join(dataDir,databaseName));
    const receipt=db.connection.prepare("SELECT checksum FROM legacy_imports WHERE source='legacy-v1'").get();
    if(receipt && expected && receipt.checksum!==expected)throw new Error('legacy_snapshot_mismatch');
    if(!receipt) {
      const snapshot = await readLegacySnapshot(dataDir);
      if(expected && (!snapshot.sources.length || snapshot.checksum!==expected))throw new Error('legacy_snapshot_mismatch');
      if(snapshot.sources.length) {
        const backupPath = await legacyBackup(dataDir);
        const verified = await readLegacySnapshot(dataDir);
        if(verified.checksum !== snapshot.checksum) throw new Error('legacy_changed_during_backup');
        // Non-sensitive reference to the independently verifiable backup.
        await durableWrite(join(dataDir,'legacy-backup.json'),JSON.stringify({path:backupPath,checksum:snapshot.checksum}));
      }
      importLegacySnapshot(db,snapshot);
    }
    // Crash between SQL commit and retirement is repaired on the next open, never re-imported.
    for(const name of ['invites.json','usage.json']) {
      const path = join(dataDir,name);
      let content:string|undefined;
      try {content = await readFile(path,'utf8');} catch(error) {if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      if(content !== retired) await durableWrite(path,retired);
    }
    return db;
  } catch(error) {db?.close();throw error;}
  finally {release();}
}

export async function withRecorderStore<T>(dataDir:string, work:(db:RecorderDatabase)=>T|Promise<T>):Promise<T> {
  const db = await openRecorderStore(dataDir);
  try {return await work(db);} finally {db.close();}
}
