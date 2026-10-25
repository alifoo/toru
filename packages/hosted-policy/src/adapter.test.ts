import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile,rename,symlink,cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { Recorder, type RecorderOptions } from '@agent-recorder/mcp/recorder';
import { createHostedLifecycle } from './adapter.js';
import {CreditLedger} from './index.js';
import {BillingCustomers} from './billing-customers.js';
import {closeBoundSubscriptionForDeletion} from './billing-close.js';
import {closeOpenCheckoutsForDeletion} from './billing-checkout-close.js';
import {eraseAccountData} from '@agent-recorder/mcp/erasure';
import {openRecorderStore} from '@agent-recorder/mcp/store/open';
import {recordDeletion,replayDeletions} from './deletion-journal.js';
import {DeletionBucketJournal,type JournalObjects} from './deletion-bucket.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{try{for(const work of cleanup.splice(0)) await work();}finally{vi.unstubAllEnvs();}});
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'recorder-hosted-')),owner=randomUUID();
  const driver={goto:vi.fn(async()=>undefined),dispose:vi.fn(async()=>undefined),startRecording:vi.fn(),recordingMode:'screencast',
    redactSensitiveText:vi.fn(),stopRecording:vi.fn(async()=>({body:Buffer.from('raw'),redactionPassed:true})),
    screenshot:vi.fn(async()=>({body:Buffer.from('preview'),redactionPassed:true})),pointerTrail:()=>[],pointerTelemetry:()=>[],semanticTimeline:()=>[]};
  const render=vi.fn(async()=>Buffer.from('synthetic-video'));
  const createContext=vi.fn(async()=>driver) as unknown as RecorderOptions['createContext'];
  const options:RecorderOptions={dataDir:dir,encryptionKey:randomBytes(32),lifecycle:createHostedLifecycle,createContext,render};
  let recorder=new Recorder(options);await recorder.initialize();
  cleanup.push(async()=>{await recorder.close();await rm(dir,{recursive:true,force:true});});
  const usage=async()=> (await recorder.call(owner,'account_usage',{})).structuredContent;
  const open=async(requestId=randomUUID())=>String((await recorder.call(owner,'session_open',{url:'https://example.com',requestId})).structuredContent!.id);
  return {dir,owner,driver,render,options,usage,open,get recorder(){return recorder;},restart:async()=>{await recorder.close();recorder=new Recorder(options);await recorder.initialize();}};
}
async function capture(f:Awaited<ReturnType<typeof fixture>>,id:string) {
  await f.recorder.call(f.owner,'recording_start',{id});
  await f.recorder.call(f.owner,'recording_stop',{id});
}
it('binds an independent bucket journal, validates every intent, and replays after volume restore',async()=>{
 const f=await fixture(),id=await f.open();await capture(f,id);await f.recorder.close();
 const entries=new Map<string,string>();
 const objects:JournalObjects={async put(key,body){entries.set(key,body);},async get(key){return entries.get(key);},async list(){return [...entries.keys()].sort();}};
 const journal=new DeletionBucketJournal(objects);
 await expect(journal.record(f.dir,f.owner)).rejects.toThrow('deletion_journal_manifest_missing');
 expect(await journal.initialize(f.dir)).toEqual({initialized:true});
 expect(await journal.initialize(f.dir)).toEqual({initialized:false});
 await journal.record(f.dir,f.owner);
 entries.set('unknown.json','{}');
 const erase=(owner:string)=>eraseAccountData(f.dir,owner,createHostedLifecycle,{tombstoneMissingAccount:true});
 await expect(journal.replay(f.dir,erase)).rejects.toThrow('invalid_deletion_journal_entry');
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('admitted');}
 finally{db.close();}
 entries.delete('unknown.json');
 expect(await journal.replay(f.dir,erase)).toEqual({reapplied:1});
 expect(await journal.replay(f.dir,erase)).toEqual({reapplied:1});
 const deleted=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{expect(deleted.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('deleted');}
 finally{deleted.close();}
 await expect(readFile(join(f.dir,'jobs',id,'raw.webm'))).rejects.toMatchObject({code:'ENOENT'});
});
it('tombstones an identity that requests deletion before creating Recorder data',async()=>{
 const f=await fixture(),owner=randomUUID(),journal=await mkdtemp(join(tmpdir(),'new-account-erasure-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);
 expect(await f.recorder.deleteAccountData(owner)).toMatchObject({state:'data_removed',jobs:0,imports:0});
 expect(JSON.parse(await readFile(join(journal,`${owner}.json`),'utf8'))).toMatchObject({owner});
 expect(await f.recorder.deleteAccountData(owner)).toMatchObject({state:'data_removed',jobs:0});
 await f.restart();
 expect((await f.recorder.call(owner,'account_usage',{})).structuredContent).toMatchObject({admission:{state:'deleted'}});
});
it('refuses online and offline erasure until Checkout is resolved and its subscription ended',async()=>{
 const f=await fixture(),journal=await mkdtemp(join(tmpdir(),'billing-erasure-journal-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);
 await f.usage();
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 const store={connection:db,transaction:<T>(work:()=>T):T=>{
   db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}
   catch(error){db.exec('ROLLBACK');throw error;}
 }};
 try{
  const customers=new BillingCustomers(store,'acct_123456789ABC',false);
  const intent=customers.begin(f.owner,randomUUID());
  const closer={endForDeletion:vi.fn(async()=>Date.now()-1000)};
  await expect(closeBoundSubscriptionForDeletion(store,customers,new CreditLedger(store),closer,f.owner))
    .rejects.toThrow('billing_unbound_checkout_requires_review');
  expect(closer.endForDeletion).not.toHaveBeenCalled();
  await expect(f.recorder.deleteAccountData(f.owner)).rejects.toThrow('account_deletion_review_required');
  await expect(readFile(join(journal,`${f.owner}.json`))).rejects.toMatchObject({code:'ENOENT'});
  expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('admitted');
  customers.bindCompleted({id:'cs_test_123456789ABC',object:'checkout.session',livemode:false,
    mode:'subscription',status:'complete',customer:'cus_123456789ABC',subscription:'sub_123456789ABC',
    client_reference_id:intent.id,created:Math.floor(Date.now()/1000),
    metadata:{product:'agent-recorder',intent_id:intent.id}});
  await expect(f.recorder.deleteAccountData(f.owner)).rejects.toThrow('account_deletion_review_required');
  await f.recorder.close();
  await expect(eraseAccountData(f.dir,f.owner)).rejects.toThrow('extension_deletion_adapter_required');
  await expect(eraseAccountData(f.dir,f.owner,createHostedLifecycle)).rejects.toThrow('account_deletion_review_required');
  expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('admitted');
  expect(await closeBoundSubscriptionForDeletion(store,customers,new CreditLedger(store),closer,f.owner))
    .toMatchObject({revoked:0});
  expect(closer.endForDeletion).toHaveBeenCalledWith('cus_123456789ABC','sub_123456789ABC',intent.id);
  await f.restart();
  await expect(f.recorder.deleteAccountData(f.owner)).resolves.toMatchObject({state:'data_removed',financialRecordsRetained:true});
  expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('deleted');
 }finally{db.close();}
});
it('blocks erasure of an unended paid invoice even without a Checkout intent',async()=>{
 const f=await fixture();await f.usage();
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{
  const store={connection:db,transaction:<T>(work:()=>T):T=>{
    db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}
    catch(error){db.exec('ROLLBACK');throw error;}
  }};
  const ledger=new CreditLedger(store),now=Date.now();
  ledger.grantCreatorCycle(f.owner,'sub_123456789ABC','in_123456789ABC',now-1000,now+86400000,now);
  await expect(f.recorder.deleteAccountData(f.owner)).rejects.toThrow('account_deletion_review_required');
  expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('admitted');
 }finally{db.close();}
});
it('erases an abandoned Checkout owner only after the known provider Session is expired',async()=>{
 const f=await fixture(),journal=await mkdtemp(join(tmpdir(),'expired-checkout-journal-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);
 await f.usage();
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 const store={connection:db,transaction:<T>(work:()=>T):T=>{
   db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}
   catch(error){db.exec('ROLLBACK');throw error;}
 }};
 try{
  const customers=new BillingCustomers(store,'acct_123456789ABC',false);
  const intent=customers.begin(f.owner,randomUUID());
  customers.recordCreated(intent,'cs_test_123456789ABC');
  await expect(f.recorder.deleteAccountData(f.owner)).rejects.toThrow('account_deletion_review_required');
  const closer={expireForDeletion:vi.fn(async()=>undefined)};
  expect(await closeOpenCheckoutsForDeletion(customers,closer,f.owner)).toBe(1);
  expect(closer.expireForDeletion).toHaveBeenCalledWith('cs_test_123456789ABC',intent.id);
  expect(await f.recorder.deleteAccountData(f.owner)).toMatchObject({state:'data_removed'});
 }finally{db.close();}
});
it('blocks a Checkout intent while the external deletion journal is pending',async()=>{
  const f=await fixture();await f.usage();
  vi.stubEnv('HOSTED_DELETION_JOURNAL',join(f.dir,'unsafe-journal'));
  const store=await openRecorderStore(f.dir),db=store.connection;
  try{
    db.prepare('INSERT INTO grants(token_hash,owner,expires_at,created_at) VALUES (?,?,?,?)')
      .run('a'.repeat(64),f.owner,Date.now()+86_400_000,Date.now());
    const lifecycle=createHostedLifecycle(store);
    const pending=lifecycle.beforeAccountErase!(f.owner);
    expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('deleted');
    expect(db.prepare('SELECT revoked_at FROM grants WHERE owner=?').get(f.owner)!.revoked_at).toBeTypeOf('number');
    expect(()=>new BillingCustomers(store,'acct_123456789ABC',false).begin(f.owner,randomUUID()))
      .toThrow('checkout_owner_not_admitted');
    await expect(pending).rejects.toThrow('deletion_journal_must_be_outside_data');
    // Journal failures leave access denied for a safe retry, not a payable account.
    expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('deleted');
  }finally{store.close();}
});
it('expires old telemetry on restart without counting an old admission again',async()=>{
 const f=await fixture();await f.usage();
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{
  const old=Date.now()-31*86400000;
  db.prepare('UPDATE hosted_admissions SET admitted_at=? WHERE owner=?').run(old,f.owner);
  db.prepare('UPDATE hosted_product_events SET occurred_at=? WHERE owner=?').run(old,f.owner);
  expect(db.prepare('SELECT count(*) n FROM hosted_product_events WHERE owner=?').get(f.owner)!.n).toBe(1);
  await f.restart();
  expect(db.prepare('SELECT count(*) n FROM hosted_product_events WHERE owner=?').get(f.owner)!.n).toBe(0);
  await f.usage();
  expect(db.prepare('SELECT count(*) n FROM hosted_product_events WHERE owner=?').get(f.owner)!.n).toBe(0);
 }finally{db.close();}
});
it('returns pending for stuck browser creation, keeps metadata for retry and never navigates after the timeout',async()=>{
 const f=await fixture(),journal=await mkdtemp(join(tmpdir(),'timeout-erasure-journal-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);await f.usage();
 let release!:()=>void;
 vi.mocked(f.options.createContext).mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return f.driver as never;});
 const opening=f.open().then(value=>({value}),error=>({error}));
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const deletion=f.recorder.deleteAccountData(f.owner).then(value=>({value}),error=>({error}));
  await vi.waitFor(()=>expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(30001);
  expect(await deletion).toMatchObject({error:{message:'account_deletion_pending'}});
  expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('deleted');
  expect(db.prepare('SELECT count(*) n FROM jobs WHERE owner=?').get(f.owner)!.n).toBe(1);
  vi.useRealTimers();release();expect(await opening).toHaveProperty('error');
  expect(f.driver.goto).not.toHaveBeenCalled();
  expect(await f.recorder.deleteAccountData(f.owner)).toMatchObject({jobs:1,state:'data_removed'});
 }finally{vi.useRealTimers();release();await opening;db.close();}
});
it('erases during credential verification and prevents a late login from recreating imports',async()=>{
 const f=await fixture(),journal=await mkdtemp(join(tmpdir(),'login-erasure-journal-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);
 let release!:()=>void;
 const exportState=vi.fn(async()=>({cookies:[],origins:[]}));
 Object.assign(f.driver,{connectWithCredentials:async()=>new Promise<void>(resolve=>{release=resolve;}),exportStorageState:exportState});
 const opened=(await f.recorder.call(f.owner,'session_connect',{url:'https://example.com',requestId:randomUUID()})).structuredContent!;
 await f.recorder.submitConnectionCredentials(f.owner,String(opened.id),'fixture@example.com','disposable-fixture-password');
 expect(release).toBeTypeOf('function');
 expect(await f.recorder.deleteAccountData(f.owner)).toMatchObject({jobs:1,imports:0});
 release();await new Promise(resolve=>setImmediate(resolve));
 expect(exportState).not.toHaveBeenCalled();expect(f.driver.dispose).toHaveBeenCalledTimes(1);
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{
  for(const table of ['jobs','session_imports'])expect(db.prepare(`SELECT count(*) n FROM ${table} WHERE owner=?`).get(f.owner)!.n).toBe(0);
 }finally{db.close();}
});
it('removes a waiting account without stopping another owner browser',async()=>{
 const f=await fixture(),journal=await mkdtemp(join(tmpdir(),'queued-erasure-journal-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);
 const active=await f.open(),victim=randomUUID();
 const queued=(await f.recorder.call(victim,'queue_enqueue',{version:1,operation:'session_open',requestId:randomUUID(),arguments:{url:'https://example.com'}})).structuredContent!;
 expect(queued.state).toBe('queued');
 expect(await f.recorder.deleteAccountData(victim)).toMatchObject({jobs:0});
 expect(f.driver.dispose).not.toHaveBeenCalled();
 expect(f.recorder.accountQueue(victim)).toEqual([]);
 expect((await f.recorder.call(f.owner,'recording_status',{id:active,waitMs:0})).structuredContent!.status).toBe('ready');
 await f.recorder.call(f.owner,'session_close',{id:active});
 expect(f.options.createContext).toHaveBeenCalledTimes(1);
});
it('waits for browser opening to settle and prevents navigation after deletion has revoked the account',async()=>{
 const f=await fixture(),journal=await mkdtemp(join(tmpdir(),'opening-erasure-journal-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);
 await f.usage();
 let release!:()=>void;
 vi.mocked(f.options.createContext).mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return f.driver as never;});
 const opening=f.open().then(value=>({value}),error=>({error}));
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 let completed=false;const deletion=f.recorder.deleteAccountData(f.owner).then(value=>{completed=true;return value;});
 await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(journal,`${f.owner}.json`),'utf8')).owner).toBe(f.owner));
 expect(completed).toBe(false);release();
 const outcome=await opening;expect(outcome).toHaveProperty('error');
 await deletion;expect(f.driver.goto).not.toHaveBeenCalled();expect(f.driver.dispose).toHaveBeenCalledTimes(1);
});
it.each(['ready','recording','captured','rendering'])('erases an online account during %s and keeps the service usable for another account',async phase=>{
 const f=await fixture(),journal=await mkdtemp(join(tmpdir(),'online-erasure-journal-'));
 cleanup.push(()=>rm(journal,{recursive:true,force:true}));vi.stubEnv('HOSTED_DELETION_JOURNAL',journal);
 const id=await f.open();
 if(phase!=='ready')await f.recorder.call(f.owner,'recording_start',{id});
 if(['captured','rendering'].includes(phase))await f.recorder.call(f.owner,'recording_stop',{id});
 if(phase==='rendering'){
  vi.mocked(f.options.render).mockImplementationOnce(async(_source,_config,signal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
  await f.recorder.call(f.owner,'recording_render',{id});
 }
 expect(await f.recorder.deleteAccountData(f.owner)).toMatchObject({state:'data_removed',jobs:1});
 expect(f.driver.dispose).toHaveBeenCalledTimes(1);
 expect(JSON.parse(await readFile(join(journal,`${f.owner}.json`),'utf8'))).toMatchObject({owner:f.owner,version:1});
 await expect(f.recorder.artifact(f.owner,id,'video')).rejects.toThrow('recording_not_found');
 await expect(f.recorder.importSession(f.owner,{cookies:[],origins:[]},['https://example.com'])).rejects.toThrow('account_not_admitted');
 expect(await f.usage()).toMatchObject({admission:{state:'deleted'}});
 const other=randomUUID(),opened=(await f.recorder.call(other,'session_open',{url:'https://example.com',requestId:randomUUID()})).structuredContent!;
 expect(opened.status).toBe('ready');await f.recorder.call(other,'session_close',{id:opened.id});
});
it('requires matching operator confirmation in the real deletion CLI before erasing data',async()=>{
 const f=await fixture(),id=await f.open();await capture(f,id);await f.recorder.close();
 const journal=await mkdtemp(join(tmpdir(),'recorder-deletion-journal-'));cleanup.push(()=>rm(journal,{recursive:true,force:true}));
 const cli=fileURLToPath(new URL('../dist/erasure-cli.js',import.meta.url));
 const run=(confirmation:string)=>spawnSync(process.execPath,[cli,'--data-dir',f.dir,'--journal',journal,'--owner',f.owner,'--confirm-owner',confirmation],{encoding:'utf8'});
 expect(run(randomUUID()).status).not.toBe(0);
 expect(await readFile(join(f.dir,'jobs',id,'raw.webm'),'utf8')).toBe('raw');
 const erased=run(f.owner);expect(erased.status,erased.stderr).toBe(0);
 expect(JSON.parse(erased.stdout)).toMatchObject({state:'data_removed',jobs:1,imports:0,backupsErased:false});
 const repeated=run(f.owner);expect(repeated.status,repeated.stderr).toBe(0);
 expect(JSON.parse(repeated.stdout)).toMatchObject({jobs:0});
 await f.restart();expect(await f.usage()).toMatchObject({admission:{state:'deleted'}});
});
it('reapplies deletion after restoring an older volume and tombstones owners absent from that snapshot',async()=>{
 const f=await fixture(),id=await f.open();await capture(f,id);await f.recorder.close();
 const work=await mkdtemp(join(tmpdir(),'recorder-restored-deletion-'));cleanup.push(()=>rm(work,{recursive:true,force:true}));
 const restored=join(work,'restored'),journal=join(work,'journal');await cp(f.dir,restored,{recursive:true});
 await recordDeletion(journal,f.dir,f.owner);
 const absentOwner=randomUUID();await recordDeletion(journal,f.dir,absentOwner);
 await eraseAccountData(f.dir,f.owner,createHostedLifecycle);
 expect(await readFile(join(restored,'jobs',id,'raw.webm'),'utf8')).toBe('raw');
 const manifestPath=join(journal,'manifest.json'),manifest=await readFile(manifestPath,'utf8');
 await writeFile(manifestPath,JSON.stringify({...JSON.parse(manifest),environment:'staging'}));
 await expect(replayDeletions(journal,restored)).rejects.toThrow('deletion_journal_volume_identity_mismatch');
 expect(await readFile(join(restored,'jobs',id,'raw.webm'),'utf8')).toBe('raw');
 await writeFile(manifestPath,manifest);
 expect(await replayDeletions(journal,restored)).toEqual({reapplied:2});
 await expect(readFile(join(restored,'jobs',id,'raw.webm'))).rejects.toMatchObject({code:'ENOENT'});
 const db=new DatabaseSync(join(restored,'recorder.sqlite'));
 try{
  for(const owner of [f.owner,absentOwner])expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner)!.admission_status).toBe('deleted');
  expect(db.prepare('SELECT state FROM credit_reservations WHERE job_id=?').get(id)!.state).toBe('released');
  expect(db.prepare('SELECT count(*) n FROM usage_reservations WHERE owner=? AND job_id IS NOT NULL').get(f.owner)!.n).toBe(0);
 }finally{db.close();}
 expect(await replayDeletions(journal,restored)).toEqual({reapplied:2});
 await expect(recordDeletion(join(restored,'unsafe-journal'),restored,f.owner)).rejects.toThrow('deletion_journal_must_be_outside_data');
 await writeFile(join(journal,`${absentOwner}.json`),'truncated');
 await expect(replayDeletions(journal,restored)).rejects.toThrow();
 await f.restart();
});
it('erases delivered media and imported login state without refunding delivery or deleting another tenant',async()=>{
 const f=await fixture(),id=await f.open();await capture(f,id);
 await f.recorder.call(f.owner,'recording_render',{id});
 await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
 const imported=await f.recorder.importSession(f.owner,{cookies:[{name:'session',value:'disposable-secret',domain:'example.com'}]},['https://example.com']);
 const other=randomUUID();
 const retained=await f.recorder.importSession(other,{cookies:[{name:'session',value:'another-disposable-secret',domain:'example.com'}]},['https://example.com']);
 const before=await readFile(join(f.dir,'imports',`${retained.id}.json`));
 expect(await f.usage()).toMatchObject({used:1,reserved:0,available:9});
 await f.recorder.close();
 expect(await eraseAccountData(f.dir,f.owner,createHostedLifecycle)).toMatchObject({jobs:1,imports:1});
 await expect(readFile(join(f.dir,'imports',`${imported.id}.json`))).rejects.toMatchObject({code:'ENOENT'});
 await expect(readFile(join(f.dir,'jobs',id,'video.mp4'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(join(f.dir,'imports',`${retained.id}.json`))).toEqual(before);
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{
  expect(db.prepare('SELECT state FROM credit_reservations WHERE job_id=?').get(id)!.state).toBe('committed');
  expect(db.prepare('SELECT used,reserved FROM credit_buckets WHERE owner=?').get(f.owner)).toMatchObject({used:1,reserved:0});
  // The capture returned its credit at stop; the render reserved it again and spent it, and erasure refunds nothing.
  expect(db.prepare("SELECT kind FROM credit_entries WHERE owner=? AND job_id=? ORDER BY rowid").all(f.owner,id).map(row=>row.kind)).toEqual(['reserve','release','reserve','commit']);
  expect(db.prepare('SELECT count(*) n FROM session_imports WHERE owner=?').get(f.owner)!.n).toBe(0);
  expect(db.prepare('SELECT count(*) n FROM session_imports WHERE owner=?').get(other)!.n).toBe(1);
 }finally{db.close();}
 await f.restart();
 await expect(f.recorder.artifact(f.owner,id,'video')).rejects.toThrow('recording_not_found');
});
it('fails closed on unsafe media paths and retries without losing the deletion inventory',async()=>{
 const f=await fixture(),id=await f.open();await capture(f,id);await f.recorder.close();
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{
  db.prepare('INSERT INTO grants(token_hash,owner,expires_at,created_at) VALUES (?,?,?,?)').run('f'.repeat(64),f.owner,Date.now()+60000,Date.now());
  await rename(join(f.dir,'jobs'),join(f.dir,'preserved-jobs'));
  await symlink(join(f.dir,'preserved-jobs'),join(f.dir,'jobs'));
  await expect(eraseAccountData(f.dir,f.owner,createHostedLifecycle)).rejects.toThrow('erasure_unsafe_directory');
  expect(db.prepare('SELECT count(*) n FROM jobs WHERE owner=?').get(f.owner)!.n).toBe(1);
  expect(db.prepare('SELECT revoked_at FROM grants WHERE owner=?').get(f.owner)!.revoked_at).not.toBeNull();
  expect(await readFile(join(f.dir,'preserved-jobs',id,'raw.webm'),'utf8')).toBe('raw');
  await rm(join(f.dir,'jobs'));await rename(join(f.dir,'preserved-jobs'),join(f.dir,'jobs'));
  await eraseAccountData(f.dir,f.owner,createHostedLifecycle);
  expect(db.prepare('SELECT count(*) n FROM jobs WHERE owner=?').get(f.owner)!.n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM credit_entries WHERE owner=? AND kind='release'").get(f.owner)!.n).toBe(1);
 }finally{db.close();}
 await f.restart();
});
it('erases stopped account media, revokes access, preserves other accounts and releases only undelivered credit',async()=>{
 const f=await fixture(),id=await f.open();await capture(f,id);
 const other=randomUUID();await f.recorder.call(other,'account_usage',{});
 await expect(eraseAccountData(f.dir,f.owner,createHostedLifecycle)).rejects.toThrow('recorder_store_busy');
 await f.recorder.close();
 await expect(eraseAccountData(f.dir,f.owner)).rejects.toThrow('extension_deletion_adapter_required');
 expect(await eraseAccountData(f.dir,f.owner,createHostedLifecycle)).toMatchObject({state:'data_removed',jobs:1,backupsErased:false});
 await expect(readFile(join(f.dir,'jobs',id,'raw.webm'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await eraseAccountData(f.dir,f.owner,createHostedLifecycle)).toMatchObject({jobs:0});
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{
  expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(f.owner)!.admission_status).toBe('deleted');
  expect(db.prepare('SELECT state FROM credit_reservations WHERE job_id=?').get(id)!.state).toBe('released');
  expect(db.prepare("SELECT count(*) n FROM credit_entries WHERE owner=? AND kind='release'").get(f.owner)!.n).toBe(1);
  expect(db.prepare('SELECT count(*) n FROM hosted_product_events WHERE owner=?').get(f.owner)!.n).toBe(0);
  expect(db.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(other)!.admission_status).toBe('admitted');
 }finally{db.close();}
 await f.restart();expect(await f.usage()).toMatchObject({admission:{state:'deleted'}});
 expect((await f.recorder.operationalMetrics()).product).toMatchObject({admissionOutcomes:{groups:expect.arrayContaining([
   expect.objectContaining({cohort:'deleted',source:'free',admittedJobs:1,committed:0,released:1,reserved:0}),
 ])}});
 await expect(f.open()).rejects.toThrow('beta_admission_required');
});
it('counts a started attempt but never finalized capture or delivery when capture fails',async()=>{
 const f=await fixture(),id=await f.open();
 f.driver.stopRecording.mockRejectedValueOnce(new Error('capture failed'));
 await f.recorder.call(f.owner,'recording_start',{id});
 await expect(f.recorder.call(f.owner,'recording_stop',{id})).rejects.toThrow('capture failed');
 const product=(await f.recorder.operationalMetrics()).product as {groups:Array<{event:string;events:number}>};
 expect(product.groups).toContainEqual({cohort:'unclassified',event:'demo_started',events:1,accounts:1});
 expect(product.groups.some(group=>['capture_finalized','render_completed'].includes(group.event))).toBe(false);
 expect(product).toMatchObject({admissionOutcomes:{groups:expect.arrayContaining([
   expect.objectContaining({cohort:'unclassified',source:'free',admittedJobs:1,committed:0,released:1,reserved:0}),
 ])},computeByOutcome:{groups:expect.arrayContaining([
   expect.objectContaining({cohort:'unclassified',source:'free',state:'released',kind:'browser_ms',jobs:1,reservations:1}),
 ])}});
 expect(await f.usage()).toMatchObject({available:10,used:0,reserved:0});
});
async function expireStoredJob(f:Awaited<ReturnType<typeof fixture>>,id:string,wholeJob:boolean) {
  const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
  try {
    const job=JSON.parse(String(db.prepare('SELECT metadata FROM jobs WHERE id=?').get(id)!.metadata));
    job.rawExpiresAt=Date.now()-1;
    if(wholeJob)job.expiresAt=Date.now()-1;
    db.prepare('UPDATE jobs SET metadata=?,expires_at=? WHERE id=?').run(JSON.stringify(job),job.expiresAt,id);
  }finally{db.close();}
}
it('expires an undelivered capture, releases its reservation once and never replays the original request',async()=>{
  const f=await fixture(),requestId=randomUUID(),id=await f.open(requestId);
  await f.recorder.call(f.owner,'recording_start',{id});
  expect(await f.usage()).toMatchObject({available:9,reserved:1,used:0});
  // A capture is not a video: the credit comes back when the session ends, not a day later.
  await f.recorder.call(f.owner,'recording_stop',{id});
  expect(await f.usage()).toMatchObject({available:10,reserved:0,used:0});
  expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent).toMatchObject({status:'captured',canRetryRender:true});
  await expireStoredJob(f,id,true);await f.restart();
  expect(await f.usage()).toMatchObject({available:10,reserved:0,used:0});
  await expect(readFile(join(f.dir,'jobs',id,'raw.webm'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(f.open(requestId)).rejects.toThrow('recording_not_found');
  expect(f.options.createContext).toHaveBeenCalledTimes(1);
  await f.restart();expect(await f.usage()).toMatchObject({available:10,reserved:0,used:0});
});
it('returns the credit a capture from before the change still holds when the server restarts',async()=>{
  const f=await fixture();
  // What older code did: a session that ended captured kept its credit reserved until the job expired.
  f.options.lifecycle=store=>{const hosted=createHostedLifecycle(store);
    return {...hosted,abandon(job){if((job as {status?:string}).status!=='captured')hosted.abandon(job);}};};
  await f.restart();
  const id=await f.open();await capture(f,id);
  expect(await f.usage()).toMatchObject({available:9,reserved:1,used:0});
  f.options.lifecycle=createHostedLifecycle;await f.restart();
  expect(await f.usage()).toMatchObject({available:10,reserved:0,used:0});
  await f.recorder.call(f.owner,'recording_render',{id});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
  expect(await f.usage()).toMatchObject({available:9,reserved:0,used:1});
});
it('expires raw inputs before the delivered MP4 without refunding a delivered video',async()=>{
  const f=await fixture(),id=await f.open();await capture(f,id);
  await f.recorder.call(f.owner,'recording_render',{id});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
  await expireStoredJob(f,id,false);await f.restart();
  for(const name of ['raw.webm','observation.json'])await expect(readFile(join(f.dir,'jobs',id,name))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile((await f.recorder.artifact(f.owner,id,'video')).path,'utf8')).toBe('synthetic-video');
  expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent).toMatchObject({status:'completed',canRetryRender:false});
  expect(await f.usage()).toMatchObject({available:9,reserved:0,used:1});
  await expireStoredJob(f,id,true);await f.restart();
  await expect(f.recorder.artifact(f.owner,id,'video')).rejects.toThrow('recording_not_found');
  expect(await f.usage()).toMatchObject({available:9,reserved:0,used:1});
});
it('blocks direct open, connection and queued execution when beta capacity is zero, before any browser or credit reservation',async()=>{
  vi.stubEnv('HOSTED_BETA_CAPACITY','0');
  const f=await fixture();
  // A previously issued credential must not bypass admission by skipping account_usage.
  for(const operation of ['session_open','session_connect']) {
    await expect(f.recorder.call(f.owner,operation,{url:'https://example.com',requestId:randomUUID()})).rejects.toThrow('beta_admission_required');
  }
  const queued=(await f.recorder.call(f.owner,'queue_enqueue',{
    version:1,operation:'session_open',requestId:randomUUID(),arguments:{url:'https://example.com'},
  })).structuredContent!;
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'queue_status',{jobId:queued.jobId})).structuredContent)
    .toMatchObject({state:'failed',result:{errorCode:'beta_admission_required'}}),{timeout:3000});
  expect(f.options.createContext).not.toHaveBeenCalled();
  expect(await f.usage()).toMatchObject({admission:{state:'waiting'}});
  const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
  try {
    for(const table of ['jobs','credit_reservations','credit_entries','usage_reservations']) {
      expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    }
  }finally{db.close();}
});
it('caps hosted render reservations across accounts and releases a rejected reservation',async()=>{
  vi.stubEnv('HOSTED_DAILY_RENDER_MINUTES','10');
  const f=await fixture(),id=await f.open();await capture(f,id);
  const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
  try{
    const other=randomUUID(),day=new Date().toISOString().slice(0,10);
    db.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(other,Date.now());
    db.prepare('INSERT INTO daily_usage(owner,day,render_ms) VALUES (?,?,1)').run(other,day);
    await expect(f.recorder.call(f.owner,'recording_render',{id,requestId:randomUUID()}))
      .rejects.toThrow('daily_service_limit');
    expect(f.render).not.toHaveBeenCalled();
    expect(db.prepare('SELECT render_ms FROM daily_usage WHERE owner=? AND day=?').get(f.owner,day)!.render_ms).toBe(0);
    expect(db.prepare(`SELECT settled_amount FROM usage_reservations
      WHERE job_id=? AND kind='render_ms'`).get(id)!.settled_amount).toBe(0);
    expect((await f.recorder.operationalMetrics()).product).toMatchObject({
      renderBudget:{dayUtc:day,limitMs:600000,usedAndReservedMs:1,remainingMs:599999}});
  }finally{db.close();}
});

it('applies Free duration, deduplicates admission, charges only delivery and never download/rerender',async()=>{
  const f=await fixture(),requestId=randomUUID(),id=await f.open(requestId);
  expect(await f.open(requestId)).toBe(id);expect(f.driver.goto).toHaveBeenCalledTimes(1);
  await expect(f.recorder.call(f.owner,'session_open',{url:'https://other.example.com',requestId})).rejects.toThrow('request_id_conflict');
  expect(await f.usage()).toMatchObject({available:9,reserved:1,used:0});
  expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.remainingSessionMs).toBeLessThanOrEqual(600000);
  expect((await f.recorder.operationalMetrics()).product).toMatchObject({computeUsage:{groups:expect.arrayContaining([
    expect.objectContaining({cohort:'unclassified',kind:'browser_ms',reservations:1,settledMs:0,unsettledReservations:1,unsettledReservedMs:600000}),
  ])},admissionOutcomes:{groups:expect.arrayContaining([
    expect.objectContaining({cohort:'unclassified',source:'free',admittedJobs:1,committed:0,released:0,reserved:1}),
  ])},computeByOutcome:{groups:expect.arrayContaining([
    expect.objectContaining({cohort:'unclassified',source:'free',state:'reserved',kind:'browser_ms',jobs:1,reservations:1,settledMs:0,unsettledReservedMs:600000}),
  ])}});
  await capture(f,id);
  f.render.mockRejectedValueOnce(new Error('encoder failure'));
  await f.recorder.call(f.owner,'recording_render',{id});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('captured'));
  expect(await f.usage()).toMatchObject({available:9,reserved:1,used:0});
  await f.recorder.call(f.owner,'recording_render',{id});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
  expect(await f.usage()).toMatchObject({available:9,reserved:0,used:1});
  expect(await readFile((await f.recorder.artifact(f.owner,id,'video')).path,'utf8')).toBe('synthetic-video');
  await f.recorder.call(f.owner,'recording_render',{id,padding:20});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
  expect(await f.usage()).toMatchObject({available:9,reserved:0,used:1});
  await f.recorder.call(f.owner,'recording_render',{id,padding:30});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
  await expect(f.recorder.call(f.owner,'recording_render',{id,padding:40})).rejects.toThrow('rerender_limit');
  expect(await f.usage()).toMatchObject({available:9,reserved:0,used:1});
  await f.restart();expect(await f.open(requestId)).toBe(id);expect(f.driver.goto).toHaveBeenCalledTimes(1);
  const metrics=await f.recorder.operationalMetrics();
  expect(metrics.product).toMatchObject({groups:expect.arrayContaining([
    {cohort:'unclassified',event:'admission_granted',events:1,accounts:1},
    {cohort:'unclassified',event:'demo_started',events:1,accounts:1},
    {cohort:'unclassified',event:'capture_finalized',events:1,accounts:1},
    {cohort:'unclassified',event:'render_completed',events:1,accounts:1},
  ])});
  expect(metrics.product).toMatchObject({computeUsage:{groups:expect.arrayContaining([
    expect.objectContaining({cohort:'unclassified',kind:'browser_ms',reservations:1,unsettledReservations:0}),
    expect.objectContaining({cohort:'unclassified',kind:'render_ms',reservations:5,unsettledReservations:0}),
  ])},admissionOutcomes:{groups:expect.arrayContaining([
    expect.objectContaining({cohort:'unclassified',source:'free',admittedJobs:1,committed:1,released:0,reserved:0}),
  ])},computeByOutcome:{groups:expect.arrayContaining([
    expect.objectContaining({cohort:'unclassified',source:'free',state:'committed',kind:'browser_ms',jobs:1,reservations:1}),
    expect.objectContaining({cohort:'unclassified',source:'free',state:'committed',kind:'render_ms',jobs:1,reservations:5}),
  ])}});
  expect(JSON.stringify(metrics.product)).not.toContain(f.owner);
});
it('applies the paid cycle policy to a new recording and charges its subscription bucket',async()=>{
  const f=await fixture();await f.usage();
  const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
  try{
    const ledger=new CreditLedger({connection:db,transaction:<T>(work:()=>T):T=>{
      db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}
      catch(error){db.exec('ROLLBACK');throw error;}
    }});
    const now=Date.now();
    ledger.grantCreatorCycle(f.owner,'sub_123456789ABC','in_123456789ABC',now-1000,now+30*86400000,now);
  }finally{db.close();}
  expect(await f.usage()).toMatchObject({available:50,policy:{version:'creator-v1',captureMs:300000,videoRetentionMs:30*86400000}});
  const id=await f.open();
  expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.remainingSessionMs)
    .toBeGreaterThan(600000);
  await capture(f,id);
  await f.recorder.call(f.owner,'recording_render',{id});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
  expect(await f.usage()).toMatchObject({available:49,used:1,reserved:0});
  const verify=new DatabaseSync(join(f.dir,'recorder.sqlite'));
  try{expect(verify.prepare("SELECT source FROM credit_buckets b JOIN credit_reservations r ON r.bucket_id=b.id WHERE r.job_id=?")
    .get(id)?.source).toBe('subscription');}
  finally{verify.close();}
});
it('does not reserve on busy/pause, releases failed browser creation and closes without capture',async()=>{
  const f=await fixture(),id=await f.open();
  await expect(f.open()).rejects.toThrow('capacity_busy');
  await f.recorder.call(f.owner,'session_close',{id});expect(await f.usage()).toMatchObject({available:10,reserved:0,used:0});
  await writeFile(join(f.dir,'paused'),'paused');await expect(f.open()).rejects.toThrow('admissions_paused');await rm(join(f.dir,'paused'));
  vi.mocked(f.options.createContext).mockRejectedValueOnce(new Error('browser failed'));
  await expect(f.open()).rejects.toThrow('browser failed');
  expect(await f.usage()).toMatchObject({available:10,reserved:0,used:0});
});
it('reconciles published MP4 after a failed delivery transaction, with no browser replay or double charge',async()=>{
  const f=await fixture(),id=await f.open();await capture(f,id);
  const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
  db.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON credit_entries WHEN NEW.kind='commit' BEGIN SELECT RAISE(ABORT,'injected_failure'); END");
  try {
    await f.recorder.call(f.owner,'recording_render',{id});
    await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('captured'));
    expect(await f.usage()).toMatchObject({used:0,reserved:1});
    await expect(f.recorder.artifact(f.owner,id,'video')).rejects.toThrow('artifact_not_published');
    db.exec('DROP TRIGGER fail_delivery');await f.restart();
    expect(await f.usage()).toMatchObject({used:1,reserved:0});
    expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed');
    expect(f.driver.goto).toHaveBeenCalledTimes(1);expect(f.render).toHaveBeenCalledTimes(1);
    await f.restart();expect(await f.usage()).toMatchObject({used:1,reserved:0});
  }finally{db.close();}
});

it('deduplicates render retries across restart and preserves failed attempt results',async()=>{
  const f=await fixture(),id=await f.open();await capture(f,id);
  const requestId=randomUUID();
  f.render.mockRejectedValueOnce(new Error('encoder unavailable'));
  await f.recorder.call(f.owner,'recording_render',{id,requestId});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('captured'));
  const failed=await f.recorder.call(f.owner,'recording_render',{id,requestId});
  expect(failed.structuredContent).toMatchObject({status:'captured',errorCode:'render_failed',requestId});
  expect(f.render).toHaveBeenCalledTimes(1);
  await expect(f.recorder.call(f.owner,'recording_render',{id,requestId,padding:20})).rejects.toThrow('request_id_conflict');
  const retryId=randomUUID();await f.recorder.call(f.owner,'recording_render',{id,requestId:retryId});
  await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent!.status).toBe('completed'));
  await f.restart();
  expect((await f.recorder.call(f.owner,'recording_render',{id,requestId:retryId})).structuredContent).toMatchObject({status:'completed',requestId:retryId});
  expect((await f.recorder.call(f.owner,'recording_render',{id,requestId})).structuredContent).toMatchObject({status:'captured',errorCode:'render_failed'});
  expect(f.render).toHaveBeenCalledTimes(2);
  expect(await f.usage()).toMatchObject({used:1,reserved:0});
});

it('queues without reserving credits or opening Chrome, polls a ready session, and cancels safely',async()=>{
  const f=await fixture(),busyId=await f.open(),other=randomUUID();
  const requestId=randomUUID();
  const request={version:1,operation:'session_open',requestId,arguments:{url:'https://example.com'}};
  const queued=(await f.recorder.call(other,'queue_enqueue',request)).structuredContent!;
  const jobId=String(queued.jobId);
  expect(queued.state).toBe('queued');
  expect((await f.recorder.call(other,'queue_enqueue',request)).structuredContent!.jobId).toBe(jobId);
  expect((await f.recorder.call(other,'account_usage',{})).structuredContent).toMatchObject({available:10,reserved:0});
  expect(f.options.createContext).toHaveBeenCalledTimes(1);
  await expect(f.recorder.call(f.owner,'queue_status',{jobId})).rejects.toThrow('queued_job_not_found');
  expect(f.recorder.accountQueue(f.owner)).toEqual([]);
  expect(f.recorder.accountQueue(other)).toHaveLength(1);
  expect(JSON.stringify(f.recorder.accountQueue(other))).not.toContain('tokenHash');
  expect(()=>f.recorder.cancelQueuedJob(f.owner,jobId)).toThrow('queued_job_not_found');
  await f.recorder.call(f.owner,'session_close',{id:busyId});
  await vi.waitFor(async()=>expect((await f.recorder.call(other,'queue_status',{jobId})).structuredContent!.result).toMatchObject({status:'ready'}),{timeout:3000});
  expect((await f.recorder.call(other,'account_usage',{})).structuredContent).toMatchObject({available:9,reserved:1});
  await f.recorder.call(other,'queue_cancel',{jobId});
  await vi.waitFor(async()=>expect((await f.recorder.call(other,'queue_status',{jobId})).structuredContent!.state).toBe('canceled'),{timeout:3000});
  expect((await f.recorder.call(other,'account_usage',{})).structuredContent).toMatchObject({available:10,reserved:0});
});

it('retains waiting work across restart and rejects a revoked submitting grant before execution',async()=>{
  const f=await fixture(),busyId=await f.open(),owner=randomUUID(),tokenHash='b'.repeat(64);
  const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
  try {
    db.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
    db.prepare('INSERT INTO grants(token_hash,owner,expires_at,created_at) VALUES (?,?,?,?)').run(tokenHash,owner,Date.now()+60000,Date.now());
    const authorization=Object.assign(async()=>true,{tokenHash});
    const jobId=String((await f.recorder.call(owner,'queue_enqueue',{version:1,operation:'session_open',requestId:randomUUID(),arguments:{url:'https://example.com'}},authorization)).structuredContent!.jobId);
    db.prepare('UPDATE grants SET revoked_at=? WHERE token_hash=?').run(Date.now(),tokenHash);
    await f.restart();
    await vi.waitFor(async()=>expect((await f.recorder.call(owner,'queue_status',{jobId})).structuredContent!.state).toBe('failed'),{timeout:3000});
    expect((await f.recorder.call(owner,'queue_status',{jobId})).structuredContent!.result).toMatchObject({errorCode:'authorization_revoked'});
    expect(f.options.createContext).toHaveBeenCalledTimes(1);
    expect((await f.recorder.call(owner,'account_usage',{})).structuredContent).toMatchObject({available:10,reserved:0});
    expect((await f.recorder.call(f.owner,'recording_status',{id:busyId,waitMs:0})).structuredContent!.status).toBe('interrupted');
  }finally{db.close();}
});

it('accepts feedback only after publication and removes it during account erasure',async()=>{
 const f=await fixture(),id=await f.open();await capture(f,id);
 expect(()=>f.recorder.recordingFeedback(f.owner,id,{useful:true})).toThrow('recording_not_found');
 await f.recorder.call(f.owner,'recording_render',{id});
 await f.recorder.call(f.owner,'recording_status',{id,waitMs:1000});
 expect(f.recorder.recordingFeedback(f.owner,id,{useful:false,reason:'quality'})).toMatchObject({state:'saved'});
 expect(()=>f.recorder.recordingFeedback(randomUUID(),id,{useful:true})).toThrow('recording_not_found');
 await f.recorder.close();await eraseAccountData(f.dir,f.owner,createHostedLifecycle);
 const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));
 try{expect(db.prepare('SELECT count(*) n FROM hosted_recording_feedback WHERE owner=?').get(f.owner)!.n).toBe(0);}finally{db.close();}
});

it('recovers a desktop upload after abandonment, survives a queued render restart, and charges once',async()=>{
 const f=await fixture(),deviceId=randomUUID();
 Object.assign(f.driver,{capturePrivacy:'user-approved-desktop'});
 f.options.createLocalContext=async()=>f.driver as unknown as Awaited<ReturnType<RecorderOptions['createContext']>>;
 const id=String((await f.recorder.call(f.owner,'session_open',{url:'https://toru.tools',localConnectionId:deviceId})).structuredContent!.id);
 await f.recorder.call(f.owner,'recording_start',{id});
 f.driver.stopRecording.mockRejectedValueOnce(new Error('connection lost'));
 await f.recorder.call(f.owner,'recording_stop',{id});
 await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent?.status).toBe('interrupted'));
 expect(await f.usage()).toMatchObject({reserved:0,used:0,available:10});
 // The same Mac finishes locally and resumes upload after the service loses its capture lease.
 const db=await openRecorderStore(f.dir);
 const now=Date.now(),bytes=Buffer.from('synthetic finalized desktop media');
 db.connection.prepare('INSERT INTO desktop_devices VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(deviceId,f.owner,'Mac',now,now,'a'.repeat(64),now+3600000,'b'.repeat(64),now+3600000);
 await writeFile(join(f.dir,'jobs',id,'desktop-upload.mp4'),bytes);
 db.connection.prepare('INSERT INTO desktop_uploads VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,f.owner,deviceId,bytes.length,'c'.repeat(64),bytes.length,1,now,now+3600000,JSON.stringify({width:1280,height:720,durationMs:2500}));
 db.close();await f.restart();
 expect((await f.recorder.recoverDesktopUpload(f.owner,deviceId,id)).status).toBe('captured');
 // A queued render is running when this service is stopped and reopened on the same volume.
 f.render.mockImplementationOnce((_source?:unknown,_config?:unknown,signal?:AbortSignal)=>new Promise<Buffer<ArrayBuffer>>((_resolve,reject)=>{
  signal!.addEventListener('abort',()=>reject(new Error('service stopped')),{once:true});
 }));
 const request={version:1,operation:'recording_render',requestId:randomUUID(),arguments:{id}};
 const queued=(await f.recorder.call(f.owner,'queue_enqueue',request)).structuredContent!;
 await vi.waitFor(()=>expect(f.render).toHaveBeenCalledOnce());
 expect(await f.usage()).toMatchObject({reserved:1,used:0,available:9});
 await f.restart();
 expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent?.status).toBe('captured');
 expect((await f.recorder.call(f.owner,'queue_status',{jobId:queued.jobId})).structuredContent?.state).not.toBe('running');
 const retry={id,requestId:randomUUID()};
 await f.recorder.call(f.owner,'recording_render',retry);
 await vi.waitFor(async()=>expect((await f.recorder.call(f.owner,'recording_status',{id,waitMs:0})).structuredContent?.status).toBe('completed'));
 await f.recorder.call(f.owner,'recording_render',retry);
 expect((await f.recorder.recoverDesktopUpload(f.owner,deviceId,id)).status).toBe('completed');
 expect(await f.usage()).toMatchObject({reserved:0,used:1,available:9});
 expect(f.driver.startRecording).toHaveBeenCalledOnce();
 const final=await openRecorderStore(f.dir);
 expect(final.connection.prepare("SELECT count(*) n FROM credit_entries WHERE job_id=? AND kind='commit'").get(id)!.n).toBe(1);
 final.close();
});

it('recording_run sign-in: connect then open with one requestId reserves one credit, without conflict or a busy browser',async()=>{
 const f=await fixture(),requestId=randomUUID();
 // The connect browser takes a moment to close after the import is saved, like a real Chrome quit.
 Object.assign(f.driver,{connectWithCredentials:vi.fn(async()=>undefined),exportStorageState:vi.fn(async()=>({cookies:[],origins:[]})),
   dispose:vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,300));})});
 f.recorder.saveDemoAccount(f.owner,'https://example.com','demo@example.com','vault-secret');
 const connection=(await f.recorder.call(f.owner,'session_connect',{url:'https://example.com/login',useDemoAccount:true,requestId})).structuredContent!;
 let status:Record<string,unknown>={};
 await vi.waitFor(async()=>{status=(await f.recorder.call(f.owner,'connection_status',{id:String(connection.id),waitMs:0})).structuredContent!;expect(status.connectionStatus).toBe('ready');});
 const opened=await f.recorder.call(f.owner,'session_open',{url:'https://example.com',importId:String(status.importId),requestId});
 expect(opened.isError,JSON.stringify(opened.content)).toBeFalsy();
 expect(opened.structuredContent).toMatchObject({status:'ready'});
 // A transport retry of the open is still idempotent.
 expect((await f.recorder.call(f.owner,'session_open',{url:'https://example.com',importId:String(status.importId),requestId})).structuredContent!.id).toBe(opened.structuredContent!.id);
 expect(await f.usage()).toMatchObject({reserved:1});
 // The sign-in and the session it unlocked are one daily browser start; reusing the import later is another.
 const starts=()=>{const db=new DatabaseSync(join(f.dir,'recorder.sqlite'));try{return Number(db.prepare('SELECT coalesce(sum(browser_starts),0) n FROM daily_usage WHERE owner=?').get(f.owner)!.n);}finally{db.close();}};
 expect(starts()).toBe(1);
 await f.recorder.call(f.owner,'session_close',{id:String(opened.structuredContent!.id)});
 await f.recorder.call(f.owner,'session_open',{url:'https://example.com',importId:String(status.importId),requestId:randomUUID()});
 expect(starts()).toBe(2);
});

it('an operator grant adds never-expiring credits once per grantId, spent after the free bucket',async()=>{
 const f=await fixture();
 expect(await f.usage()).toMatchObject({available:10});
 const db=await openRecorderStore(f.dir);
 try{
  const ledger=new CreditLedger(db),grantId=randomUUID();
  expect(ledger.grantAdmin(f.owner,3,grantId)).toMatchObject({credits:3,alreadyGranted:false});
  expect(ledger.grantAdmin(f.owner,3,grantId)).toMatchObject({credits:3,alreadyGranted:true});
  expect(()=>ledger.grantAdmin(f.owner,4,grantId)).toThrow('admin_grant_conflict');
  expect(()=>ledger.grantAdmin(f.owner,101,randomUUID())).toThrow('admin_grant_invalid');
  expect(()=>ledger.grantAdmin(f.owner,1,'not-a-uuid')).toThrow('admin_grant_invalid');
  expect(()=>ledger.grantAdmin(randomUUID(),1,randomUUID())).toThrow('account_not_found');
 }finally{db.close();}
 expect(await f.usage()).toMatchObject({available:13});
 // The free allowance is spent first; the operator grant waits behind it.
 const id=await f.open();await capture(f,id);
 const bucket=(job:string)=>{const sql=new DatabaseSync(join(f.dir,'recorder.sqlite'));try{return String(sql.prepare('SELECT b.source FROM credit_reservations r JOIN credit_buckets b ON b.id=r.bucket_id WHERE r.job_id=?').get(job)!.source);}finally{sql.close();}};
 expect(bucket(id)).toBe('free');
});
