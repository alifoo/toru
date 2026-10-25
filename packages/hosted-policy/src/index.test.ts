import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreditLedger, type TransactionalStore } from './index.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const work of cleanup.splice(0)) await work();});
const hash='a'.repeat(64),now=Date.parse('2026-09-27T12:00:00Z');
function store(connection:DatabaseSync):TransactionalStore {
  return {connection,transaction<T>(work:()=>T):T {connection.exec('BEGIN IMMEDIATE');try {const result=work();connection.exec('COMMIT');return result;}catch(error){connection.exec('ROLLBACK');throw error;}}};
}
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'recorder-credits-')),path=join(dir,'db.sqlite');
  const db=new DatabaseSync(path);db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;CREATE TABLE accounts(owner TEXT PRIMARY KEY,admission_status TEXT NOT NULL);INSERT INTO accounts VALUES ('owner','admitted'),('other','admitted');");
  cleanup.push(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  return {db,path,ledger:new CreditLedger(store(db))};
}
it('grants ten per UTC calendar month, without accumulating old free credits',async()=>{
  const {db,ledger}=await fixture();
  expect(ledger.usage('owner',now).available).toBe(10);
  expect(ledger.usage('owner',now).available).toBe(10);
  ledger.reserve('owner','job','request',hash,now);ledger.commit('owner','job','artifact',now);
  expect(ledger.usage('owner',now)).toMatchObject({available:9,used:1,reserved:0});
  expect(ledger.usage('owner',Date.parse('2026-10-01T00:00:00Z'))).toMatchObject({available:10,used:0,reserved:0});
  expect(db.prepare("SELECT count(*) n FROM credit_entries WHERE kind='grant'").get()!.n).toBe(2);
});
it('replaces Free with a paid cycle, counts existing use, and returns to Free after expiry',async()=>{
  const {db,ledger}=await fixture();
  const subscription='sub_123456789ABC',invoice='in_123456789ABC';
  const end=Date.parse('2026-10-27T12:00:00Z');
  ledger.reserve('owner','free-job','free-request',hash,now);
  ledger.commit('owner','free-job','free-artifact',now);
  ledger.reserve('owner','in-flight','in-flight-request',hash,now);
  const bucket=ledger.grantCreatorCycle('owner',subscription,invoice,now,end,now);
  expect(ledger.grantCreatorCycle('owner',subscription,invoice,now,end,now)).toBe(bucket);
  expect(()=>ledger.grantCreatorCycle('owner',subscription,'in_999999999XYZ',now,end,now))
    .toThrow('creator_cycle_overlap');
  expect(ledger.usage('owner',now)).toMatchObject({available:48,used:0,reserved:0,policy:{version:'creator-v1',videos:50}});
  const paidUse=Date.parse('2026-10-10T12:00:00Z');
  ledger.reserve('owner','paid-job','paid-request',hash,paidUse);
  expect(ledger.policyForReservation('paid-job').version).toBe('creator-v1');
  ledger.commit('owner','paid-job','paid-artifact',paidUse);
  expect(ledger.usage('owner',paidUse)).toMatchObject({available:47,used:1,reserved:0});
  ledger.release('owner','in-flight',paidUse);
  expect(ledger.usage('owner',paidUse)).toMatchObject({available:48,used:1,reserved:0});
  expect(db.prepare("SELECT granted FROM credit_buckets WHERE id=?").get(bucket)?.granted).toBe(49);
  expect(ledger.usage('owner',end).policy.version).toBe('free-v1');
  expect(ledger.usage('owner',end)).toMatchObject({available:9,used:0,reserved:0});
});
it('does not reissue unused Free credits after a delayed paid invoice is reconciled',async()=>{
  const {db,ledger}=await fixture();
  const october=Date.parse('2026-10-05T12:00:00Z'),paidUse=Date.parse('2026-10-15T12:00:00Z');
  const end=Date.parse('2026-10-27T12:00:00Z');
  ledger.usage('owner',october);
  ledger.reserve('owner','oct-free','oct-free-request',hash,october);
  ledger.commit('owner','oct-free','oct-free-artifact',october);
  ledger.grantCreatorCycle('owner','sub_123456789ABC','in_123456789ABC',now,end,october);
  expect(ledger.usage('owner',october)).toMatchObject({available:49,policy:{version:'creator-v1'}});
  ledger.reserve('owner','oct-paid','oct-paid-request',hash,paidUse);
  ledger.commit('owner','oct-paid','oct-paid-artifact',paidUse);
  expect(ledger.usage('owner',end)).toMatchObject({available:8,used:1,policy:{version:'free-v1'}});
  expect(db.prepare("SELECT granted FROM credit_buckets WHERE owner='owner' AND source='free' AND cycle_id='2026-10'").get()?.granted)
    .toBe(9);
  expect(ledger.usage('owner',end).history.filter(entry=>entry.kind==='adjust')).toHaveLength(1);
});
it('grants a renewal once at the next paid period without minting Free in between',async()=>{
  const {db,ledger}=await fixture(),subscription='sub_123456789ABC';
  const end=Date.parse('2026-10-27T12:00:00Z'),secondEnd=Date.parse('2026-11-27T12:00:00Z');
  ledger.grantCreatorCycle('owner',subscription,'in_123456789ABC',now,end,now);
  ledger.reserve('owner','first-paid','first-paid-request',hash,now);
  ledger.commit('owner','first-paid','first-paid-artifact',now);
  ledger.grantCreatorCycle('owner',subscription,'in_999999999XYZ',end,secondEnd,end);
  expect(ledger.usage('owner',end)).toMatchObject({available:50,used:0,policy:{version:'creator-v1'}});
  expect(db.prepare("SELECT count(*) n FROM credit_buckets WHERE owner='owner' AND source='free'").get()!.n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM hosted_paid_invoices WHERE owner='owner'").get()!.n).toBe(2);
  expect(()=>ledger.grantCreatorCycle('owner',subscription,'in_444444444444',end,secondEnd,end))
    .toThrow('creator_cycle_overlap');
});
it('binds a paid cycle to one payment intent and rejects conflicting invoice reuse',async()=>{
  const {db,ledger}=await fixture(),subscription='sub_123456789ABC',invoice='in_123456789ABC';
  const end=now+30*86400000,payment={intentId:'pi_123456789ABC',chargeId:'ch_123456789ABC',amount:1900,currency:'usd'};
  const bucket=ledger.grantCreatorCycle('owner',subscription,invoice,now,end,now,payment);
  expect(ledger.grantCreatorCycle('owner',subscription,invoice,now,end,now,payment)).toBe(bucket);
  expect(db.prepare(`SELECT payment_intent_id,charge_id,paid_amount,currency FROM hosted_paid_invoices WHERE invoice_id=?`)
    .get(invoice)).toEqual({payment_intent_id:payment.intentId,charge_id:payment.chargeId,
      paid_amount:1900,currency:'usd'});
  expect(()=>ledger.grantCreatorCycle('owner',subscription,invoice,now,end,now,
    {...payment,amount:1800})).toThrow('creator_payment_conflict');
  expect(()=>ledger.grantCreatorCycle('owner',subscription,'in_999999999XYZ',end,end+30*86400000,end,payment))
    .toThrow('creator_payment_conflict');
  expect(db.prepare('SELECT count(*) n FROM hosted_paid_invoices').get()?.n).toBe(1);
});

it('migrates existing paid invoice rows and can bind their verified payment on retry',async()=>{
  const {db,ledger}=await fixture(),subscription='sub_123456789ABC',invoice='in_123456789ABC';
  const end=now+30*86400000,bucket=ledger.grantCreatorCycle('owner',subscription,invoice,now,end,now);
  db.exec(`DROP INDEX hosted_paid_charge;
    DROP INDEX hosted_paid_payment_intent;
    DROP TABLE hosted_payment_refunds;
    ALTER TABLE hosted_paid_invoices DROP COLUMN charge_id;
    ALTER TABLE hosted_paid_invoices DROP COLUMN payment_intent_id;
    ALTER TABLE hosted_paid_invoices DROP COLUMN paid_amount;
    ALTER TABLE hosted_paid_invoices DROP COLUMN currency;
    DROP TABLE hosted_pack_purchases;
    DELETE FROM hosted_schema WHERE version IN (6,7,8);`);
  const reopened=new CreditLedger(store(db));
  expect(reopened.grantCreatorCycle('owner',subscription,invoice,now,end,now,
    {intentId:'pi_123456789ABC',chargeId:'ch_123456789ABC',amount:1900,currency:'usd'})).toBe(bucket);
  expect(db.prepare('SELECT max(version) v FROM hosted_schema').get()?.v).toBe(8);
  expect(db.prepare('SELECT payment_intent_id,charge_id FROM hosted_paid_invoices WHERE invoice_id=?').get(invoice))
    .toEqual({payment_intent_id:'pi_123456789ABC',charge_id:'ch_123456789ABC'});
});
it('applies cumulative partial and full refunds without reclaiming delivered or in-flight videos',async()=>{
  const {db,ledger}=await fixture(),payment={intentId:'pi_123456789ABC',
    chargeId:'ch_123456789ABC',amount:1900,currency:'usd'};
  const bucket=ledger.grantCreatorCycle('owner','sub_123456789ABC','in_123456789ABC',
    now,now+30*86400000,now,payment);
  ledger.reserve('owner','delivered','delivered-request',hash,now);
  ledger.commit('owner','delivered','artifact',now);
  ledger.reserve('owner','in-flight','in-flight-request',hash,now);
  expect(ledger.creatorInvoiceForCharge(payment.chargeId)).toMatchObject({
    owner:'owner',invoiceId:'in_123456789ABC',paymentIntentId:payment.intentId,paidAmount:1900
  });
  expect(ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,950,1900,now+1))
    .toEqual({invoiceId:'in_123456789ABC',refundedAmount:950,revoked:25});
  expect(ledger.usage('owner',now+1)).toMatchObject({available:23,used:1,reserved:1,
    policy:{version:'creator-v1'}});
  expect(ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,950,1900,now+2).revoked).toBe(0);
  expect(ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,500,1900,now+3).revoked).toBe(0);
  expect(ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,1900,1900,now+4))
    .toEqual({invoiceId:'in_123456789ABC',refundedAmount:1900,revoked:23});
  expect(db.prepare('SELECT granted,used,reserved,expires_at FROM credit_buckets WHERE id=?').get(bucket))
    .toEqual({granted:2,used:1,reserved:1,expires_at:now+4});
  expect(ledger.usage('owner',now+4)).toMatchObject({available:8,policy:{version:'free-v1'}});
  ledger.release('owner','in-flight',now+5);
  expect(db.prepare('SELECT granted,used,reserved FROM credit_buckets WHERE id=?').get(bucket))
    .toEqual({granted:1,used:1,reserved:0});
  expect(ledger.usage('owner',now+5)).toMatchObject({available:9,policy:{version:'free-v1'}});
  expect(db.prepare('SELECT count(*) n FROM hosted_payment_refunds').get()?.n).toBe(1);
});

it('does not restore Creator credits from a released Free reservation after a partial refund',async()=>{
  const {db,ledger}=await fixture(),payment={intentId:'pi_123456789ABC',
    chargeId:'ch_123456789ABC',amount:1900,currency:'usd'};
  ledger.reserve('owner','free-flight','free-flight-request',hash,now);
  const bucket=ledger.grantCreatorCycle('owner','sub_123456789ABC','in_123456789ABC',
    now,now+30*86400000,now,payment);
  expect(ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,950,1900,now+1).revoked)
    .toBe(25);
  ledger.release('owner','free-flight',now+2);
  expect(db.prepare('SELECT granted FROM credit_buckets WHERE id=?').get(bucket)?.granted).toBe(24);
});
it('rolls back a refund marker and balance together when the audit write fails',async()=>{
  const {db,ledger}=await fixture(),payment={intentId:'pi_123456789ABC',
    chargeId:'ch_123456789ABC',amount:1900,currency:'usd'};
  const bucket=ledger.grantCreatorCycle('owner','sub_123456789ABC','in_123456789ABC',
    now,now+30*86400000,now,payment);
  db.exec(`CREATE TRIGGER reject_refund BEFORE INSERT ON credit_entries
    WHEN NEW.idempotency_key LIKE 'refund:%' BEGIN SELECT RAISE(ABORT,'injected_refund_failure'); END;`);
  expect(()=>ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,950,1900,now+1))
    .toThrow('injected_refund_failure');
  expect(db.prepare('SELECT count(*) n FROM hosted_payment_refunds').get()?.n).toBe(0);
  expect(db.prepare('SELECT granted FROM credit_buckets WHERE id=?').get(bucket)?.granted).toBe(50);
  db.exec('DROP TRIGGER reject_refund');
  expect(ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,950,1900,now+2).revoked).toBe(25);
});
it('ends paid access at the actual termination time, preserves settled work and revokes unused credits once',async()=>{
  const {db,ledger}=await fixture(),subscription='sub_123456789ABC';
  const end=Date.parse('2026-10-27T12:00:00Z'),terminated=now+2*86400000;
  const bucket=ledger.grantCreatorCycle('owner',subscription,'in_123456789ABC',now,end,now);
  ledger.reserve('owner','delivered','delivered-request',hash,now);
  ledger.commit('owner','delivered','artifact',now);
  ledger.reserve('owner','in-flight','in-flight-request',hash,now);
  expect(ledger.endCreatorSubscription('owner',subscription,terminated,terminated))
    .toEqual({effectiveAt:terminated,revoked:48});
  expect(ledger.endCreatorSubscription('owner',subscription,terminated,terminated))
    .toEqual({effectiveAt:terminated,revoked:0});
  expect(db.prepare('SELECT granted,used,reserved,expires_at FROM credit_buckets WHERE id=?').get(bucket))
    .toEqual({granted:2,used:1,reserved:1,expires_at:terminated});
  expect(ledger.usage('owner',terminated)).toMatchObject({available:8,policy:{version:'free-v1'}});
  ledger.release('owner','in-flight',terminated);
  expect(ledger.usage('owner',terminated)).toMatchObject({available:9,policy:{version:'free-v1'}});
  expect(db.prepare('SELECT granted,used,reserved FROM credit_buckets WHERE id=?').get(bucket))
    .toEqual({granted:1,used:1,reserved:0});
  expect(ledger.commit('owner','delivered','another-artifact',terminated).state).toBe('committed');
  expect(db.prepare("SELECT count(*) n FROM credit_entries WHERE kind='adjust' AND bucket_id=?").get(bucket)!.n).toBe(2);
});
it('does not reopen a terminated subscription when its paid invoice arrives afterward',async()=>{
  const {db,ledger}=await fixture(),subscription='sub_123456789ABC';
  const terminated=now+86400000,end=now+30*86400000;
  expect(ledger.endCreatorSubscription('owner',subscription,terminated,terminated).revoked).toBe(0);
  const bucket=ledger.grantCreatorCycle('owner',subscription,'in_123456789ABC',now,end,terminated+1);
  expect(db.prepare('SELECT granted,expires_at FROM credit_buckets WHERE id=?').get(bucket))
    .toEqual({granted:0,expires_at:terminated});
  expect(ledger.usage('owner',terminated+1)).toMatchObject({available:10,policy:{version:'free-v1'}});
});
it('holds Free capacity for paid jobs still in flight after cancellation, then restores it on release',async()=>{
  const {ledger}=await fixture(),subscription='sub_123456789ABC';
  const end=Date.parse('2026-10-27T12:00:00Z'),before=end-1000;
  ledger.grantCreatorCycle('owner',subscription,'in_123456789ABC',now,end,now);
  ledger.reserve('owner','will-release','release-request',hash,before);
  ledger.reserve('owner','will-deliver','deliver-request',hash,before);
  ledger.endCreatorSubscription('owner',subscription,end,end);
  expect(ledger.usage('owner',end)).toMatchObject({available:8,policy:{version:'free-v1'}});
  ledger.release('owner','will-release',end);
  expect(ledger.usage('owner',end)).toMatchObject({available:9,policy:{version:'free-v1'}});
  ledger.commit('owner','will-deliver','paid-artifact',end+1);
  expect(ledger.usage('owner',end+1)).toMatchObject({available:9,policy:{version:'free-v1'}});
  for(let i=0;i<9;i++)ledger.reserve('owner',`free-after-${i}`,`free-request-${i}`,hash,end+2);
  expect(()=>ledger.reserve('owner','extra','extra-request',hash,end+2)).toThrow('video_credit_limit');
});
it('reserves the last credit once across connections and rolls back denied admissions',async()=>{
  const {path,ledger,db}=await fixture();
  for(let i=0;i<9;i++) ledger.reserve('owner',`job-${i}`,`req-${i}`,hash,now);
  const connection=new DatabaseSync(path);
  try {
    const other=new CreditLedger(store(connection));
    ledger.reserve('owner','last','last-request',hash,now);
    expect(()=>other.reserve('owner','denied','denied-request',hash,now)).toThrow('video_credit_limit');
    expect(ledger.usage('owner',now)).toMatchObject({available:0,reserved:10,used:0});
    expect(db.prepare('SELECT count(*) n FROM credit_reservations').get()!.n).toBe(10);
  }finally{connection.close();}
});
it('deduplicates reserve/commit/release and refuses request reuse with different input or job',async()=>{
  const {db,ledger}=await fixture();
  const first=ledger.reserve('owner','job','request',hash,now);
  expect(ledger.reserve('owner','job','request',hash,now)).toEqual(first);
  expect(()=>ledger.reserve('owner','job','request','b'.repeat(64),now)).toThrow('credit_request_conflict');
  expect(()=>ledger.reserve('owner','different-job','request',hash,now)).toThrow('credit_request_conflict');
  expect(()=>ledger.commit('other','job','artifact',now)).toThrow('credit_reservation_not_found');
  expect(()=>ledger.release('other','job',now)).toThrow('credit_reservation_not_found');
  ledger.commit('owner','job','artifact',now);
  ledger.commit('owner','job','rerender-artifact',now);
  expect(ledger.release('owner','job',now).state).toBe('committed');
  expect(ledger.usage('owner',now)).toMatchObject({available:9,reserved:0,used:1});
  expect(db.prepare("SELECT count(*) n FROM credit_entries WHERE kind='commit'").get()!.n).toBe(1);
});
it('releases undelivered work once but cannot deliver from a released reservation',async()=>{
  const {ledger}=await fixture();ledger.reserve('owner','job','request',hash,now);
  ledger.release('owner','job',now);ledger.release('owner','job',now);
  expect(ledger.usage('owner',now)).toMatchObject({available:10,reserved:0,used:0});
  expect(()=>ledger.commit('owner','job','artifact',now)).toThrow('credit_reservation_released');
});
it('charges an in-flight job to its original bucket after monthly rollover and reconnect',async()=>{
  const {db,path,ledger}=await fixture();ledger.reserve('owner','job','request',hash,now);
  const next=Date.parse('2026-10-01T00:00:00Z');
  const connection=new DatabaseSync(path);
  try{
    const reconnected=new CreditLedger(store(connection));
    expect(reconnected.usage('owner',next).available).toBe(10);
    reconnected.commit('owner','job','artifact',next);
    expect(reconnected.usage('owner',next)).toMatchObject({available:10,used:0,reserved:0});
    expect(db.prepare("SELECT reserved,used FROM credit_buckets WHERE cycle_id='2026-09'").get()).toEqual({reserved:0,used:1});
  }finally{connection.close();}
});
it('rolls back balance and state when audit insertion fails and keeps entries immutable',async()=>{
  const {db,ledger}=await fixture();ledger.reserve('owner','job','request',hash,now);
  db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON credit_entries WHEN NEW.kind='commit' BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(()=>ledger.commit('owner','job','artifact',now)).toThrow('injected');
  expect(ledger.usage('owner',now)).toMatchObject({available:9,reserved:1,used:0});
  expect(db.prepare('SELECT state FROM credit_reservations').get()!.state).toBe('reserved');
  expect(()=>db.exec('DELETE FROM credit_entries')).toThrow('immutable_credit_entry');
  expect(()=>db.exec('UPDATE credit_entries SET amount=99')).toThrow('immutable_credit_entry');
});

it('participates in an engine transaction and rolls back the credit when job admission fails',async()=>{
  const {db,ledger}=await fixture();
  expect(()=>store(db).transaction(()=>{
    ledger.reserve('owner','job','request',hash,now);
    throw new Error('job_insert_failed');
  })).toThrow('job_insert_failed');
  expect(db.prepare('SELECT count(*) n FROM credit_reservations').get()!.n).toBe(0);
  expect(db.prepare('SELECT count(*) n FROM credit_entries').get()!.n).toBe(0);
  store(db).transaction(()=>{
    ledger.reserve('owner','job','request',hash,now);
    expect(()=>ledger.reserve('owner','different-job','request',hash,now)).toThrow('credit_request_conflict');
    ledger.commit('owner','job','artifact',now);
  });
  expect(ledger.usage('owner',now)).toMatchObject({available:9,used:1,reserved:0});
});

it('returns bounded owner-only credit history with reservations and settlement, without internal keys',async()=>{
  const {ledger}=await fixture();
  ledger.reserve('owner','delivered','request-delivered',hash,now);ledger.commit('owner','delivered','artifact',now+1);
  ledger.reserve('owner','failed','request-failed',hash,now+2);ledger.release('owner','failed',now+3);
  ledger.reserve('other','other-job','other-request',hash,now);
  const usage=ledger.usage('owner',now+4);
  expect(usage.history.map(event=>event.kind)).toEqual(['release','reserve','commit','reserve','grant']);
  expect(usage.history[0]).toMatchObject({jobId:'failed',amount:1,source:'free',cycle:'2026-09'});
  expect(JSON.stringify(usage.history)).not.toMatch(/other-job|other-request|request-delivered|idempotency|input_hash/);
  expect(usage.historyHasMore).toBe(false);
  for(let i=0;i<20;i++){ledger.reserve('owner',`retry-${i}`,`retry-request-${i}`,hash,now+10+i);ledger.release('owner',`retry-${i}`,now+10+i);}
  const recent=ledger.usage('owner',now+100);
  expect(recent.history).toHaveLength(30);expect(recent.historyHasMore).toBe(true);
});

it('paginates tied timestamps without gaps and rejects another account’s cursor',async()=>{
  const {ledger}=await fixture();
  for(let i=0;i<35;i++){
    ledger.reserve('owner',`page-job-${i}`,`page-request-${i}`,hash,now);
    ledger.release('owner',`page-job-${i}`,now);
  }
  const first=ledger.usage('owner',now);
  expect(first.history).toHaveLength(30);expect(first.historyNextCursor).toBeTruthy();
  // New activity after page one must not shift the position of older pages.
  ledger.reserve('owner','later-job','later-request',hash,now+1);
  ledger.release('owner','later-job',now+1);
  const second=ledger.usage('owner',now+1,first.historyNextCursor!);
  const third=ledger.usage('owner',now+1,second.historyNextCursor!);
  const entries=[...first.history,...second.history,...third.history];
  expect(entries).toHaveLength(71);expect(new Set(entries.map(row=>row.id)).size).toBe(71);
  expect(entries.filter(row=>row.kind==='grant')).toHaveLength(1);
  expect(third.historyNextCursor).toBeNull();expect(third.historyHasMore).toBe(false);
  const foreign=ledger.usage('other',now).history[0]!.id;
  expect(()=>ledger.usage('owner',now,foreign)).toThrow('invalid_history_cursor');
  expect(()=>ledger.usage('owner',now,'bad')).toThrow('invalid_history_cursor');
});

it('grants Studio limits and keeps invoice replay and refunds scoped to its policy',async()=>{
  const {ledger}=await fixture();
  const end=now+30*86400000;
  const payment={intentId:'pi_studio12345678',chargeId:'ch_studio12345678',amount:4900,currency:'usd'};
  ledger.grantCreatorCycle('owner','sub_studio12345678','in_studio12345678',now,end,now,payment,'studio-v1');
  expect(ledger.usage('owner',now)).toMatchObject({available:150,policy:{version:'studio-v1',videos:150,captureMs:300000}});
  ledger.reserve('owner','studio-job','studio-request',hash,now);
  expect(ledger.policyForReservation('studio-job').version).toBe('studio-v1');
  expect(()=>ledger.grantCreatorCycle('owner','sub_studio12345678','in_studio12345678',now,end,now,payment,'creator-v1')).toThrow('creator_invoice_conflict');
  ledger.grantCreatorCycle('owner','sub_studio12345678','in_studio12345678',now,end,now,payment,'studio-v1');
  expect(ledger.usage('owner',now).available).toBe(149);
  ledger.refundCreatorCharge('owner',payment.chargeId,payment.intentId,4900,4900,now);
  expect(ledger.usage('owner',now).policy.version).toBe('free-v1');
});

it('re-reserves recovered captures, accounts for repeated release, and commits only once',async()=>{
 const {ledger,db}=await fixture();
 ledger.reserve('owner','job','request',hash,now);ledger.release('owner','job',now);
 expect(()=>ledger.reserveRecovered('other','job',now)).toThrow('credit_reservation_not_found');
 ledger.reserveRecovered('owner','job',now);ledger.reserveRecovered('owner','job',now);
 expect(ledger.usage('owner',now)).toMatchObject({reserved:1,used:0,available:9});
 ledger.release('owner','job',now);ledger.reserveRecovered('owner','job',now);
 ledger.commit('owner','job','artifact',now);ledger.commit('owner','job','artifact-again',now);
 ledger.reserveRecovered('owner','job',now);
 expect(ledger.usage('owner',now)).toMatchObject({reserved:0,used:1,available:9});
 expect(db.prepare("SELECT kind,count(*) n FROM credit_entries WHERE job_id='job' GROUP BY kind ORDER BY kind").all()).toEqual([{kind:'commit',n:1},{kind:'release',n:2},{kind:'reserve',n:3}]);
});
it('refuses recovery without available credit and reserves from the current cycle after rollover',async()=>{
 const {ledger}=await fixture();ledger.reserve('owner','job','request',hash,now);ledger.release('owner','job',now);
 for(let i=0;i<10;i++){ledger.reserve('owner',`job-${i}`,`req-${i}`,hash,now);ledger.commit('owner',`job-${i}`,`art-${i}`,now);}
 expect(()=>ledger.reserveRecovered('owner','job',now)).toThrow('video_credit_limit');
 const next=Date.parse('2026-10-01T00:00:00Z');ledger.reserveRecovered('owner','job',next);ledger.commit('owner','job','recovered',next);
 expect(ledger.usage('owner',next)).toMatchObject({used:1,reserved:0,available:9});
});
