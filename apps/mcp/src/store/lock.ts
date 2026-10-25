import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** SQLite's exclusive rollback-journal lock is released by the kernel after SIGKILL too. */
export function exclusiveProcessLock(path:string): () => void {
  mkdirSync(dirname(path), {recursive:true,mode:0o700});
  closeSync(openSync(path,'a',0o600)); chmodSync(path,0o600);
  const lock = new DatabaseSync(path);
  try {
    lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
  } catch {
    lock.close(); throw new Error('recorder_store_busy');
  }
  let closed = false;
  return () => {if(!closed) {lock.close();closed = true;}};
}
