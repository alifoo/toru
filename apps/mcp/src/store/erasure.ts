import {lstat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {exclusiveProcessLock} from './lock.js';
import {openRecorderStore,databaseName} from './open.js';
import type {LifecycleFactory,LifecycleJob,RecorderLifecycle} from '../lifecycle.js';
import type {RecorderDatabase} from './database.js';

/** Operator recovery path; the service must be stopped. Retains the account tombstone and extension records. */
export async function eraseAccountData(dataDir:string,owner:string,lifecycleFactory?:LifecycleFactory,options:{tombstoneMissingAccount?:boolean}={}){
  z.uuid().parse(owner);
  const root=resolve(dataDir);
  if(!(await lstat(join(root,databaseName))).isFile())throw new Error('recorder_database_missing');
  const unlock=exclusiveProcessLock(join(root,'.runtime-lock.sqlite'));
  let store:Awaited<ReturnType<typeof openRecorderStore>>|undefined;
  try{
    store=await openRecorderStore(root);
    return await eraseAccountDataInStore(store,root,owner,lifecycleFactory?.(store),options);
  }finally{store?.close();unlock();}
}
/** Caller must hold the runtime lock and stop all work for this owner before invoking. */
export async function eraseAccountDataInStore(store:RecorderDatabase,root:string,owner:string,lifecycle?:RecorderLifecycle,options:{tombstoneMissingAccount?:boolean}={}){
    z.uuid().parse(owner);
    const sql=store.connection;
    // Extensions register their own erasure requirement in this generic table.
    // A caller cannot silently discard extension-owned records by omitting its adapter.
    const extensionTable=sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recorder_extension_requirements'").get();
    const extensionRequiresErasure=extensionTable&&sql.prepare("SELECT 1 FROM recorder_extension_requirements WHERE operation='account_erasure'").get();
    if(extensionRequiresErasure&&(!lifecycle?.assertAccountEraseAllowed||!lifecycle.eraseAccountData))
      throw new Error('extension_deletion_adapter_required');
    lifecycle?.assertAccountEraseAllowed?.(owner);
    if(!sql.prepare('SELECT 1 FROM accounts WHERE owner=?').get(owner)){
      if(!options.tombstoneMissingAccount)throw new Error('account_not_found');
      sql.prepare("INSERT INTO accounts(owner,created_at,admission_status,deleted_at) VALUES (?,?,'deleted',?)").run(owner,Date.now(),Date.now());
    }
    const jobs=sql.prepare('SELECT id,metadata FROM jobs WHERE owner=?').all(owner).map(row=>({id:z.uuid().parse(row.id),job:JSON.parse(String(row.metadata)) as LifecycleJob}));
    if(jobs.some(entry=>entry.job.owner!==owner||entry.job.id!==entry.id))throw new Error('recording_owner_conflict');
    const imports=sql.prepare('SELECT id FROM session_imports WHERE owner=?').all(owner).map(row=>z.uuid().parse(row.id));
    if(jobs.some(entry=>entry.job.policy)&&!lifecycle)throw new Error('extension_deletion_adapter_required');
    store.transaction(()=>{
      sql.prepare("UPDATE accounts SET admission_status='deleted',deleted_at=coalesce(deleted_at,?),clerk_user_id=NULL WHERE owner=?").run(Date.now(),owner);
      sql.prepare('UPDATE grants SET revoked_at=coalesce(revoked_at,?) WHERE owner=?').run(Date.now(),owner);
      sql.prepare("UPDATE queue_entries SET state=CASE WHEN state IN ('queued','running') THEN 'canceled' ELSE state END,payload='{}',result=NULL,worker_id=NULL,lease_until=NULL WHERE owner=?").run(owner);
      for(const entry of jobs)lifecycle?.abandon(entry.job);
    });
    // Retain metadata until files are removed, so a crash or permission failure can be retried.
    for(const directory of ['jobs','imports']){
      const info=await lstat(join(root,directory)).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(info&&!info.isDirectory())throw new Error('erasure_unsafe_directory');
    }
    for(const entry of jobs)await rm(join(root,'jobs',entry.id),{recursive:true,force:true});
    for(const id of imports)await rm(join(root,'imports',`${id}.json`),{force:true});
    store.transaction(()=>{
      sql.prepare('UPDATE usage_reservations SET job_id=NULL WHERE owner=?').run(owner);
      for(const table of ['desktop_devices','jobs','session_imports','preparation_notes','navigation_runs','operation_requests','queue_entries','queue_owner_turns'])sql.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner);
      // Toru for Chrome creates its table on first use.
      if(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extension_devices'").get())sql.prepare('DELETE FROM extension_devices WHERE owner=?').run(owner);
      lifecycle?.eraseAccountData?.(owner);
    });
    return {...lifecycle?.accountEraseReceipt?.(owner),state:'data_removed',jobs:jobs.length,imports:imports.length,
      accountTombstoneRetained:true,backupsErased:false};
}
