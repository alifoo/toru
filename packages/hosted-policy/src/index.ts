import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface TransactionalStore {
  connection:DatabaseSync;
  transaction<T>(work:()=>T):T;
}
export const freePolicy=Object.freeze({version:'free-v1',videos:10,captureMs:120_000,sessionMs:600_000,rerenders:2,rawRetentionMs:86_400_000,videoRetentionMs:7*86_400_000});
export const creatorPolicy=Object.freeze({version:'creator-v1',videos:50,captureMs:300_000,sessionMs:1_200_000,rerenders:2,rawRetentionMs:86_400_000,videoRetentionMs:30*86_400_000});
export const studioPolicy=Object.freeze({...creatorPolicy,version:'studio-v1',videos:150});
export function paidPolicy(version:unknown){ if(version==='studio-v1')return studioPolicy;if(version==='creator-v1')return creatorPolicy;throw new Error('paid_policy_invalid'); }
export type CreditReservation={jobId:string;owner:string;requestId:string;state:'reserved'|'committed'|'released';bucketId:string;artifactId:string|null};
export type CreatorPayment={intentId:string;chargeId:string;amount:number;currency:string};

const schema=`
CREATE TABLE IF NOT EXISTS hosted_schema(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS credit_buckets (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner),
 source TEXT NOT NULL CHECK(source IN ('free','subscription','extra','admin')), cycle_id TEXT NOT NULL,
 policy_version TEXT NOT NULL, granted INTEGER NOT NULL CHECK(granted>=0),
 reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0), used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
 starts_at INTEGER NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL,
 UNIQUE(owner,source,cycle_id), CHECK(reserved+used<=granted)
) STRICT;
CREATE TABLE IF NOT EXISTS credit_reservations (
 job_id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner), request_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, bucket_id TEXT NOT NULL REFERENCES credit_buckets(id),
 state TEXT NOT NULL CHECK(state IN ('reserved','committed','released')), artifact_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(owner,request_id), CHECK((state='committed')=(artifact_id IS NOT NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS credit_entries (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner), bucket_id TEXT NOT NULL REFERENCES credit_buckets(id),
 job_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('grant','reserve','commit','release','adjust')),
 amount INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS credit_entries_no_update BEFORE UPDATE ON credit_entries BEGIN SELECT RAISE(ABORT,'immutable_credit_entry'); END;
CREATE TRIGGER IF NOT EXISTS credit_entries_no_delete BEFORE DELETE ON credit_entries BEGIN SELECT RAISE(ABORT,'immutable_credit_entry'); END;
CREATE TABLE IF NOT EXISTS hosted_exports (
  job_id TEXT NOT NULL REFERENCES credit_reservations(job_id), artifact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(job_id,artifact_id)
) STRICT;
CREATE TABLE IF NOT EXISTS hosted_paid_invoices (
 invoice_id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(owner),
 subscription_id TEXT NOT NULL,period_start INTEGER NOT NULL,period_end INTEGER NOT NULL,
 bucket_id TEXT NOT NULL UNIQUE REFERENCES credit_buckets(id),created_at INTEGER NOT NULL,
 UNIQUE(owner,subscription_id,period_start)
) STRICT;
CREATE TABLE IF NOT EXISTS hosted_subscription_ends (
 subscription_id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(owner),
 effective_at INTEGER NOT NULL,recorded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS credit_entries_owner_time ON credit_entries(owner,created_at DESC);
INSERT OR IGNORE INTO hosted_schema VALUES (5);`;

function identifier(value:string) {if(!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('invalid_credit_identifier');}
function time(value:number) {if(!Number.isSafeInteger(value)||value<0) throw new Error('invalid_credit_time');}

/** Private hosted policy. No payment provider, commercial secret or entitlement is needed by the MIT engine. */
export class CreditLedger {
  constructor(private readonly store:TransactionalStore) {
    store.transaction(()=>{
      const exists=store.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='hosted_schema'").get();
      if(exists && Number(store.connection.prepare('SELECT max(version) v FROM hosted_schema').get()!.v)>8) throw new Error('hosted_schema_newer_than_binary');
      store.connection.exec(schema);
      if(Number(store.connection.prepare('SELECT max(version) v FROM hosted_schema').get()!.v)<6){
        store.connection.exec(`ALTER TABLE hosted_paid_invoices ADD COLUMN payment_intent_id TEXT;
          ALTER TABLE hosted_paid_invoices ADD COLUMN paid_amount INTEGER;
          ALTER TABLE hosted_paid_invoices ADD COLUMN currency TEXT;
          CREATE UNIQUE INDEX hosted_paid_payment_intent ON hosted_paid_invoices(payment_intent_id)
            WHERE payment_intent_id IS NOT NULL;
          INSERT OR IGNORE INTO hosted_schema VALUES (6);`);
      }
      if(Number(store.connection.prepare('SELECT max(version) v FROM hosted_schema').get()!.v)<7){
        store.connection.exec(`ALTER TABLE hosted_paid_invoices ADD COLUMN charge_id TEXT;
          CREATE UNIQUE INDEX hosted_paid_charge ON hosted_paid_invoices(charge_id)
            WHERE charge_id IS NOT NULL;
          CREATE TABLE hosted_payment_refunds (
            charge_id TEXT PRIMARY KEY,payment_intent_id TEXT NOT NULL,
            owner TEXT NOT NULL REFERENCES accounts(owner),invoice_id TEXT NOT NULL REFERENCES hosted_paid_invoices(invoice_id),
            refunded_amount INTEGER NOT NULL CHECK(refunded_amount>0),paid_amount INTEGER NOT NULL CHECK(paid_amount>0),
            recorded_at INTEGER NOT NULL
          ) STRICT;
          INSERT OR IGNORE INTO hosted_schema VALUES (7);`);
      }
      if(Number(store.connection.prepare('SELECT max(version) v FROM hosted_schema').get()!.v)<8){
        // One-off credit packs: paid once, never expire, drawn after subscription and free credits.
        store.connection.exec(`CREATE TABLE hosted_pack_purchases (
            payment_intent_id TEXT PRIMARY KEY,charge_id TEXT NOT NULL UNIQUE,
            owner TEXT NOT NULL REFERENCES accounts(owner),pack_id TEXT NOT NULL,
            credits INTEGER NOT NULL CHECK(credits>0),paid_amount INTEGER NOT NULL CHECK(paid_amount>0),currency TEXT NOT NULL,
            bucket_id TEXT NOT NULL UNIQUE REFERENCES credit_buckets(id),created_at INTEGER NOT NULL
          ) STRICT;
          INSERT OR IGNORE INTO hosted_schema VALUES (8);`);
      }
      // Generic engine contract: offline erasure must load this extension's lifecycle.
      store.connection.exec(`CREATE TABLE IF NOT EXISTS recorder_extension_requirements (
        operation TEXT PRIMARY KEY
      ) STRICT;
      INSERT OR IGNORE INTO recorder_extension_requirements VALUES ('account_erasure');`);
    });
  }
  private atomic<T>(work:()=>T):T {
    if(!this.store.connection.isTransaction) return this.store.transaction(work);
    // Admission/publication may already hold the engine transaction. Savepoints preserve
    // atomicity even if the caller catches a ledger error before deciding its own rollback.
    const savepoint=`credits_${randomUUID().replaceAll('-','')}`;
    const sql=this.store.connection;
    sql.exec(`SAVEPOINT ${savepoint}`);
    try {const result=work();sql.exec(`RELEASE ${savepoint}`);return result;}
    catch(error) {sql.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);throw error;}
  }
  private entry(owner:string,bucketId:string,jobId:string|null,kind:string,amount:number,key:string,now:number) {
    this.store.connection.prepare('INSERT INTO credit_entries VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),owner,bucketId,jobId,kind,amount,key,now);
  }
  private activeCreator(owner:string,now:number){
    return this.store.connection.prepare(`SELECT id,expires_at,policy_version FROM credit_buckets
      WHERE owner=? AND source='subscription' AND starts_at<=? AND expires_at>?
      ORDER BY starts_at DESC LIMIT 1`).get(owner,now,now);
  }
  private ensureFree(owner:string,now:number) {
    identifier(owner);time(now);
    const date=new Date(now),year=date.getUTCFullYear(),month=date.getUTCMonth();
    const cycle=date.toISOString().slice(0,7),start=Date.UTC(year,month,1),end=Date.UTC(year,month+1,1);
    const sql=this.store.connection;
    const existing=sql.prepare("SELECT id FROM credit_buckets WHERE owner=? AND source='free' AND cycle_id=?").get(owner,cycle);
    if(this.activeCreator(owner,now))return undefined;
    // A paid cycle that ended this UTC month has already supplied part or all of Free's allowance.
    const paidUsed=Number(sql.prepare(`SELECT count(*) n FROM credit_entries e JOIN credit_buckets b ON b.id=e.bucket_id
      WHERE e.owner=? AND b.source='subscription' AND e.kind='commit' AND e.created_at>=? AND e.created_at<?`)
      .get(owner,start,end)!.n);
    const paidReserved=Number(sql.prepare(`SELECT count(*) n FROM credit_reservations r
      JOIN credit_buckets b ON b.id=r.bucket_id WHERE r.owner=? AND r.state='reserved' AND b.source='subscription'`)
      .get(owner)!.n);
    const granted=Math.max(0,freePolicy.videos-paidUsed-paidReserved);
    if(existing){
      const row=sql.prepare('SELECT granted,used,reserved FROM credit_buckets WHERE id=?').get(String(existing.id))!;
      const target=Math.max(Number(row.used)+Number(row.reserved),granted);
      if(target!==Number(row.granted)){
        sql.prepare('UPDATE credit_buckets SET granted=? WHERE id=?').run(target,String(existing.id));
        this.entry(owner,String(existing.id),null,'adjust',target-Number(row.granted),
          `adjust:${owner}:free:${cycle}:${randomUUID()}`,now);
      }
      return String(existing.id);
    }
    const id=randomUUID();
    sql.prepare('INSERT INTO credit_buckets(id,owner,source,cycle_id,policy_version,granted,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,owner,'free',cycle,freePolicy.version,granted,start,end,now);
    this.entry(owner,id,null,'grant',granted,`grant:${owner}:free:${cycle}`,now);
    return id;
  }
  grantCreatorCycle(owner:string,subscriptionId:string,invoiceId:string,start:number,end:number,
    now=Date.now(),payment?:CreatorPayment,policyVersion:string=creatorPolicy.version){
    const policy=paidPolicy(policyVersion);
    identifier(owner);time(start);time(end);time(now);
    if(!/^sub_[A-Za-z0-9]{8,128}$/.test(subscriptionId)||!/^in_[A-Za-z0-9]{8,160}$/.test(invoiceId)||
      end<=start||end-start>40*86_400_000||payment!==undefined&&
      (!/^pi_[A-Za-z0-9]{8,128}$/.test(payment.intentId)||
        !/^ch_[A-Za-z0-9]{8,128}$/.test(payment.chargeId)||!Number.isSafeInteger(payment.amount)||
        payment.amount<1||!/^[a-z]{3}$/.test(payment.currency)))throw new Error('creator_cycle_invalid');
    return this.atomic(()=>{
      const sql=this.store.connection;
      const reused=payment?sql.prepare('SELECT invoice_id FROM hosted_paid_invoices WHERE payment_intent_id=?')
        .get(payment.intentId):undefined;
      if(reused&&reused.invoice_id!==invoiceId)throw new Error('creator_payment_conflict');
      const reusedCharge=payment?sql.prepare('SELECT invoice_id FROM hosted_paid_invoices WHERE charge_id=?')
        .get(payment.chargeId):undefined;
      if(reusedCharge&&reusedCharge.invoice_id!==invoiceId)throw new Error('creator_payment_conflict');
      const existing=sql.prepare(`SELECT owner,subscription_id,period_start,period_end,bucket_id,
        payment_intent_id,charge_id,paid_amount,currency FROM hosted_paid_invoices WHERE invoice_id=?`).get(invoiceId);
      if(existing){
        const bucket=sql.prepare('SELECT policy_version FROM credit_buckets WHERE id=?').get(String(existing.bucket_id));
        if(bucket?.policy_version!==policy.version)throw new Error('creator_invoice_conflict');
        if(existing.owner!==owner||existing.subscription_id!==subscriptionId||
          existing.period_start!==start||existing.period_end!==end)throw new Error('creator_invoice_conflict');
        if(payment){
          if(existing.payment_intent_id!==null&&
            (existing.payment_intent_id!==payment.intentId||existing.paid_amount!==payment.amount||
              existing.currency!==payment.currency))throw new Error('creator_payment_conflict');
          if(existing.charge_id!==null&&existing.charge_id!==payment.chargeId)
            throw new Error('creator_payment_conflict');
          if(existing.payment_intent_id===null)sql.prepare(`UPDATE hosted_paid_invoices
            SET payment_intent_id=?,paid_amount=?,currency=? WHERE invoice_id=?`)
            .run(payment.intentId,payment.amount,payment.currency,invoiceId);
          if(existing.charge_id===null)sql.prepare('UPDATE hosted_paid_invoices SET charge_id=? WHERE invoice_id=?')
            .run(payment.chargeId,invoiceId);
        }
        return String(existing.bucket_id);
      }
      if(sql.prepare("SELECT 1 FROM accounts WHERE owner=? AND admission_status='admitted'").get(owner)===undefined)
        throw new Error('creator_owner_not_admitted');
      if(sql.prepare(`SELECT 1 FROM hosted_paid_invoices WHERE owner=?
        AND period_start<? AND period_end>?`).get(owner,end,start))throw new Error('creator_cycle_overlap');
      const cycle=`${subscriptionId}:${start}`;
      if(sql.prepare("SELECT 1 FROM credit_buckets WHERE owner=? AND source='subscription' AND cycle_id=?").get(owner,cycle))
        throw new Error('creator_cycle_conflict');
      // First upgrade replaces this month's Free allowance; existing in-flight reservations count
      // until commit/release so concurrent captures cannot exceed 50 total deliveries.
      const prior=sql.prepare("SELECT 1 FROM credit_buckets WHERE owner=? AND source='subscription' LIMIT 1").get(owner);
      const date=new Date(start),freeWindowStart=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1);
      const free=prior?undefined:sql.prepare(`SELECT coalesce(sum(used+reserved),0) n FROM credit_buckets
        WHERE owner=? AND source='free' AND starts_at<? AND expires_at>?`).get(owner,end,freeWindowStart);
      const ended=sql.prepare('SELECT owner,effective_at FROM hosted_subscription_ends WHERE subscription_id=?')
        .get(subscriptionId);
      if(ended&&ended.owner!==owner)throw new Error('creator_subscription_owner_conflict');
      const granted=ended?0:Math.max(0,policy.videos-Number(free?.n??0));
      const expiresAt=ended?Math.max(start,Math.min(end,Number(ended.effective_at))):end;
      const bucketId=randomUUID();
      sql.prepare('INSERT INTO credit_buckets(id,owner,source,cycle_id,policy_version,granted,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(bucketId,owner,'subscription',cycle,policy.version,granted,start,expiresAt,now);
      this.entry(owner,bucketId,null,'grant',granted,`grant:${owner}:subscription:${cycle}`,now);
      sql.prepare(`INSERT INTO hosted_paid_invoices
        (invoice_id,owner,subscription_id,period_start,period_end,bucket_id,created_at,
          payment_intent_id,paid_amount,currency,charge_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(invoiceId,owner,subscriptionId,start,end,bucketId,now,
          payment?.intentId??null,payment?.amount??null,payment?.currency??null,payment?.chargeId??null);
      return bucketId;
    });
  }
  endCreatorSubscription(owner:string,subscriptionId:string,effectiveAt:number,now=Date.now()){
    identifier(owner);time(effectiveAt);time(now);
    if(!/^sub_[A-Za-z0-9]{8,128}$/.test(subscriptionId)||effectiveAt>now+60_000)
      throw new Error('creator_subscription_end_invalid');
    return this.atomic(()=>{
      const sql=this.store.connection;
      const prior=sql.prepare('SELECT owner,effective_at FROM hosted_subscription_ends WHERE subscription_id=?')
        .get(subscriptionId);
      if(prior&&prior.owner!==owner)throw new Error('creator_subscription_owner_conflict');
      const end=prior?Math.min(Number(prior.effective_at),effectiveAt):effectiveAt;
      sql.prepare(`INSERT INTO hosted_subscription_ends VALUES (?,?,?,?)
        ON CONFLICT(subscription_id) DO UPDATE SET effective_at=min(effective_at,excluded.effective_at)`)
        .run(subscriptionId,owner,end,now);
      const cycles=sql.prepare(`SELECT i.bucket_id,b.starts_at,b.expires_at,b.granted,b.used,b.reserved
        FROM hosted_paid_invoices i JOIN credit_buckets b ON b.id=i.bucket_id
        WHERE i.owner=? AND i.subscription_id=?`).all(owner,subscriptionId);
      let revoked=0;
      for(const cycle of cycles){
        const bucketId=String(cycle.bucket_id),expiresAt=Math.max(Number(cycle.starts_at),Math.min(Number(cycle.expires_at),end));
        const unused=Number(cycle.granted)-Number(cycle.used)-Number(cycle.reserved);
        sql.prepare('UPDATE credit_buckets SET expires_at=?,granted=used+reserved WHERE id=?').run(expiresAt,bucketId);
        if(unused>0){
          this.entry(owner,bucketId,null,'adjust',-unused,`end:${subscriptionId}:${bucketId}`,now);
          revoked+=unused;
        }
      }
      return {effectiveAt:end,revoked};
    });
  }
  creatorInvoiceForCharge(chargeId:string){
    if(!/^ch_[A-Za-z0-9]{8,128}$/.test(chargeId))throw new Error('creator_charge_invalid');
    const row=this.store.connection.prepare(`SELECT owner,subscription_id,invoice_id,payment_intent_id,
      paid_amount,currency FROM hosted_paid_invoices WHERE charge_id=?`).get(chargeId);
    if(!row)return undefined;
    return {owner:String(row.owner),subscriptionId:String(row.subscription_id),invoiceId:String(row.invoice_id),
      paymentIntentId:String(row.payment_intent_id),paidAmount:Number(row.paid_amount),currency:String(row.currency)};
  }
  private capRefundedBucket(bucketId:string,owner:string,refunded:number,paid:number,key:string,now:number){
    const sql=this.store.connection;
    const row=sql.prepare('SELECT granted,used,reserved FROM credit_buckets WHERE id=? AND owner=?')
      .get(bucketId,owner);
    if(!row)throw new Error('creator_invoice_conflict');
    const gross=Number(sql.prepare(`SELECT coalesce(sum(amount),0) n FROM credit_entries
      WHERE bucket_id=? AND (kind='grant' OR
        (kind='adjust' AND idempotency_key LIKE 'creator-free-release:%'))`).get(bucketId)?.n);
    const retained=Math.floor(gross*(paid-refunded)/paid);
    const target=Math.max(Number(row.used)+Number(row.reserved),Math.min(Number(row.granted),retained));
    const removed=Number(row.granted)-target;
    if(removed>0){
      sql.prepare('UPDATE credit_buckets SET granted=? WHERE id=?').run(target,bucketId);
      this.entry(owner,bucketId,null,'adjust',-removed,key,now);
    }
    return removed;
  }
  /** Apply the provider's cumulative refund amount; never reclaim delivered or in-flight work. */
  refundCreatorCharge(owner:string,chargeId:string,intentId:string,refunded:number,paid:number,now=Date.now()){
    identifier(owner);time(now);
    if(!/^ch_[A-Za-z0-9]{8,128}$/.test(chargeId)||!/^pi_[A-Za-z0-9]{8,128}$/.test(intentId)||
      !Number.isSafeInteger(refunded)||!Number.isSafeInteger(paid)||paid<1||refunded<1||refunded>paid)
      throw new Error('creator_refund_invalid');
    return this.atomic(()=>{
      const sql=this.store.connection;
      const invoice=sql.prepare(`SELECT invoice_id,owner,payment_intent_id,paid_amount,bucket_id
        FROM hosted_paid_invoices WHERE charge_id=?`).get(chargeId);
      if(!invoice||invoice.owner!==owner||invoice.payment_intent_id!==intentId||invoice.paid_amount!==paid)
        throw new Error('creator_payment_unbound');
      const prior=sql.prepare('SELECT owner,invoice_id,payment_intent_id,paid_amount,refunded_amount FROM hosted_payment_refunds WHERE charge_id=?')
        .get(chargeId);
      if(prior&&(prior.owner!==owner||prior.invoice_id!==invoice.invoice_id||
        prior.payment_intent_id!==intentId||prior.paid_amount!==paid))throw new Error('creator_refund_conflict');
      const cumulative=Math.max(refunded,Number(prior?.refunded_amount??0));
      sql.prepare(`INSERT INTO hosted_payment_refunds VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(charge_id) DO UPDATE SET refunded_amount=max(refunded_amount,excluded.refunded_amount),
          recorded_at=excluded.recorded_at`).run(chargeId,intentId,owner,String(invoice.invoice_id),cumulative,paid,now);
      const removed=this.capRefundedBucket(String(invoice.bucket_id),owner,cumulative,paid,
        `refund:${chargeId}:${cumulative}`,now);
      if(cumulative===paid)sql.prepare(`UPDATE credit_buckets
        SET expires_at=min(expires_at,max(starts_at,?)) WHERE id=?`).run(now,String(invoice.bucket_id));
      return {invoiceId:String(invoice.invoice_id),refundedAmount:cumulative,revoked:removed};
    });
  }
  policyForReservation(jobId:string){
    identifier(jobId);
    const row=this.store.connection.prepare(`SELECT b.source,b.policy_version,r.owner,r.created_at FROM credit_reservations r
      JOIN credit_buckets b ON b.id=r.bucket_id WHERE r.job_id=?`).get(jobId);
    if(!row)throw new Error('credit_reservation_not_found');
    if(row.source==='subscription')return paidPolicy(row.policy_version);
    const paid=this.activeCreator(String(row.owner),Number(row.created_at));
    return paid?paidPolicy(paid.policy_version):freePolicy;
  }
  usage(owner:string,now=Date.now(),cursor?:string) {
    return this.atomic(()=>{
      this.ensureFree(owner,now);
      const sql=this.store.connection;
      const paid=this.activeCreator(owner,now);
      const total=sql.prepare(`SELECT coalesce(sum(granted-used-reserved),0) available,coalesce(sum(used),0) used,coalesce(sum(reserved),0) reserved
        FROM credit_buckets WHERE owner=? AND starts_at<=? AND (expires_at IS NULL OR expires_at>?)
          AND (?=0 OR source<>'free')`).get(owner,now,now,paid?1:0)!;
      let before:{created_at:number;rowid:number}|undefined;
      if(cursor!==undefined){
        if(!/^[0-9a-f-]{36}$/i.test(cursor))throw new Error('invalid_history_cursor');
        before=sql.prepare('SELECT created_at,rowid FROM credit_entries WHERE id=? AND owner=?').get(cursor,owner) as typeof before;
        if(!before)throw new Error('invalid_history_cursor');
      }
      const rows=sql.prepare(`SELECT e.id,e.job_id,e.kind,e.amount,e.created_at,b.source,b.cycle_id
        FROM credit_entries e JOIN credit_buckets b ON b.id=e.bucket_id
        WHERE e.owner=? ${before?'AND (e.created_at<? OR (e.created_at=? AND e.rowid<?))':''}
        ORDER BY e.created_at DESC,e.rowid DESC LIMIT 31`).all(owner,...(before?[before.created_at,before.created_at,before.rowid]:[]));
      const history=rows.slice(0,30).map(row=>({id:String(row.id),jobId:row.job_id===null?null:String(row.job_id),
        kind:String(row.kind),amount:Number(row.amount),createdAt:new Date(Number(row.created_at)).toISOString(),
        source:String(row.source),cycle:String(row.cycle_id)}));
      const current=new Date(now);
      return {history,historyHasMore:rows.length>30,historyNextCursor:rows.length>30?history.at(-1)!.id:null,available:Number(total.available),used:Number(total.used),reserved:Number(total.reserved),policy:paid?paidPolicy(paid.policy_version):freePolicy,renewsAt:paid?new Date(Number(paid.expires_at)).toISOString():new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()+1,1)).toISOString()};
    });
  }
  private read(jobId:string):CreditReservation {
    const row=this.store.connection.prepare('SELECT * FROM credit_reservations WHERE job_id=?').get(jobId);
    if(!row) throw new Error('credit_reservation_not_found');
    return {jobId:String(row.job_id),owner:String(row.owner),requestId:String(row.request_id),state:row.state as CreditReservation['state'],bucketId:String(row.bucket_id),artifactId:row.artifact_id===null?null:String(row.artifact_id)};
  }
  reserve(owner:string,jobId:string,requestId:string,inputHash:string,now=Date.now()):CreditReservation {
    [owner,jobId,requestId].forEach(identifier);time(now);
    if(!/^[a-f0-9]{64}$/.test(inputHash)) throw new Error('invalid_credit_input_hash');
    return this.atomic(()=>{
      const sql=this.store.connection;
      const previous=sql.prepare('SELECT job_id,input_hash FROM credit_reservations WHERE owner=? AND request_id=?').get(owner,requestId);
      if(previous) {
        if(previous.input_hash!==inputHash || previous.job_id!==jobId) throw new Error('credit_request_conflict');
        return this.read(jobId);
      }
      if(sql.prepare('SELECT 1 FROM credit_reservations WHERE job_id=?').get(jobId)) throw new Error('credit_request_conflict');
      this.ensureFree(owner,now);
      const paid=this.activeCreator(owner,now);
      const bucket=sql.prepare(`SELECT id FROM credit_buckets WHERE owner=? AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) AND granted-used-reserved>0
        AND (?=0 OR source<>'free')
        ORDER BY CASE source WHEN 'subscription' THEN 0 WHEN 'free' THEN 1 WHEN 'extra' THEN 2 ELSE 3 END,
          expires_at IS NULL,expires_at,created_at,id LIMIT 1`).get(owner,now,now,paid?1:0);
      if(!bucket) throw new Error('video_credit_limit');
      const bucketId=String(bucket.id);
      sql.prepare('UPDATE credit_buckets SET reserved=reserved+1 WHERE id=?').run(bucketId);
      sql.prepare('INSERT INTO credit_reservations VALUES (?,?,?,?,?,?,?,?,?)').run(jobId,owner,requestId,inputHash,bucketId,'reserved',null,now,now);
      this.entry(owner,bucketId,jobId,'reserve',1,`reserve:${jobId}`,now);
      return this.read(jobId);
    });
  }
  /** Recovered captures keep their job identity, but released credit must be available again. */
  reserveRecovered(owner:string,jobId:string,now=Date.now()):CreditReservation {
    time(now);
    return this.atomic(()=>{
      const row=this.read(jobId);
      if(row.owner!==owner)throw new Error('credit_reservation_not_found');
      if(row.state!=='released')return row;
      const sql=this.store.connection;
      this.ensureFree(owner,now);
      const paid=this.activeCreator(owner,now);
      const bucket=sql.prepare(`SELECT id FROM credit_buckets WHERE owner=? AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) AND granted-used-reserved>0
        AND (?=0 OR source<>'free')
        ORDER BY CASE source WHEN 'subscription' THEN 0 WHEN 'free' THEN 1 WHEN 'extra' THEN 2 ELSE 3 END,
          expires_at IS NULL,expires_at,created_at,id LIMIT 1`).get(owner,now,now,paid?1:0);
      if(!bucket)throw new Error('video_credit_limit');
      const bucketId=String(bucket.id);
      const generation=Number(sql.prepare("SELECT count(*) n FROM credit_entries WHERE job_id=? AND kind='reserve'").get(jobId)!.n);
      sql.prepare('UPDATE credit_buckets SET reserved=reserved+1 WHERE id=?').run(bucketId);
      sql.prepare("UPDATE credit_reservations SET state='reserved',bucket_id=?,updated_at=? WHERE job_id=?").run(bucketId,now,jobId);
      this.entry(owner,bucketId,jobId,'reserve',1,`reserve:${jobId}:recovery:${generation}`,now);
      return this.read(jobId);
    });
  }
  /** A verified one-off pack payment grants an 'extra' bucket once; replays return the same bucket. */
  grantPack(owner:string,packId:string,credits:number,payment:CreatorPayment,now=Date.now()):{bucketId:string;credits:number;alreadyGranted:boolean} {
    identifier(owner);time(now);
    if(!/^pack-[0-9]{1,3}$/.test(packId)||!Number.isSafeInteger(credits)||credits<1||credits>1000||
      !/^pi_[A-Za-z0-9]{8,128}$/.test(payment.intentId)||!/^ch_[A-Za-z0-9]{8,128}$/.test(payment.chargeId)||
      !Number.isSafeInteger(payment.amount)||payment.amount<1||!/^[a-z]{3}$/.test(payment.currency))throw new Error('pack_grant_invalid');
    return this.atomic(()=>{
      const sql=this.store.connection;
      const existing=sql.prepare('SELECT owner,pack_id,credits,charge_id,bucket_id FROM hosted_pack_purchases WHERE payment_intent_id=?').get(payment.intentId);
      if(existing){
        if(existing.owner!==owner||existing.pack_id!==packId||Number(existing.credits)!==credits||existing.charge_id!==payment.chargeId)throw new Error('pack_payment_conflict');
        return {bucketId:String(existing.bucket_id),credits,alreadyGranted:true};
      }
      if(sql.prepare('SELECT 1 FROM hosted_pack_purchases WHERE charge_id=?').get(payment.chargeId))throw new Error('pack_payment_conflict');
      if(!sql.prepare('SELECT 1 FROM accounts WHERE owner=?').get(owner))throw new Error('account_not_found');
      const bucketId=randomUUID();
      sql.prepare('INSERT INTO credit_buckets(id,owner,source,cycle_id,policy_version,granted,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,NULL,?)')
        .run(bucketId,owner,'extra',`pack:${payment.intentId}`,'pack-v1',credits,now,now);
      sql.prepare('INSERT INTO hosted_pack_purchases VALUES (?,?,?,?,?,?,?,?,?)')
        .run(payment.intentId,payment.chargeId,owner,packId,credits,payment.amount,payment.currency,bucketId,now);
      this.entry(owner,bucketId,null,'grant',credits,`pack:${payment.intentId}`,now);
      return {bucketId,credits,alreadyGranted:false};
    });
  }
  /**
   * An operator grant (support, testing): an 'admin' bucket that never expires and is spent after every other
   * source. Idempotent per grantId; the same id with a different owner or amount is a conflict.
   */
  grantAdmin(owner:string,credits:number,grantId:string,now=Date.now()):{bucketId:string;credits:number;alreadyGranted:boolean} {
    identifier(owner);time(now);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)||!Number.isSafeInteger(credits)||credits<1||credits>100)throw new Error('admin_grant_invalid');
    return this.atomic(()=>{
      const sql=this.store.connection,cycle=`admin:${grantId.toLowerCase()}`;
      const existing=sql.prepare("SELECT id,owner,granted FROM credit_buckets WHERE source='admin' AND cycle_id=?").get(cycle);
      if(existing){
        if(existing.owner!==owner||Number(existing.granted)!==credits)throw new Error('admin_grant_conflict');
        return {bucketId:String(existing.id),credits,alreadyGranted:true};
      }
      if(!sql.prepare('SELECT 1 FROM accounts WHERE owner=?').get(owner))throw new Error('account_not_found');
      const bucketId=randomUUID();
      sql.prepare('INSERT INTO credit_buckets(id,owner,source,cycle_id,policy_version,granted,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,NULL,?)')
        .run(bucketId,owner,'admin',cycle,'admin-v1',credits,now,now);
      this.entry(owner,bucketId,null,'grant',credits,cycle,now);
      return {bucketId,credits,alreadyGranted:false};
    });
  }
  commit(owner:string,jobId:string,artifactId:string,now=Date.now()):CreditReservation {
    identifier(artifactId);time(now);
    return this.atomic(()=>{
      const row=this.read(jobId);
      if(row.owner!==owner) throw new Error('credit_reservation_not_found');
      if(row.state==='committed') return row; // Subsequent renders/downloads never charge again.
      if(row.state==='released') throw new Error('credit_reservation_released');
      const sql=this.store.connection;
      sql.prepare('UPDATE credit_buckets SET reserved=reserved-1,used=used+1 WHERE id=?').run(row.bucketId);
      sql.prepare("UPDATE credit_reservations SET state='committed',artifact_id=?,updated_at=? WHERE job_id=?").run(artifactId,now,jobId);
      this.entry(owner,row.bucketId,jobId,'commit',1,`commit:${jobId}`,now);
      return this.read(jobId);
    });
  }
  release(owner:string,jobId:string,now=Date.now()):CreditReservation {
    time(now);
    return this.atomic(()=>{
      const row=this.read(jobId);
      if(row.owner!==owner) throw new Error('credit_reservation_not_found');
      if(row.state!=='reserved') return row;
      const sql=this.store.connection;
      sql.prepare('UPDATE credit_buckets SET reserved=reserved-1 WHERE id=?').run(row.bucketId);
      sql.prepare("UPDATE credit_reservations SET state='released',updated_at=? WHERE job_id=?").run(now,jobId);
      const generation=Number(sql.prepare("SELECT count(*) n FROM credit_entries WHERE job_id=? AND kind='reserve'").get(jobId)!.n);
      const suffix=generation>1?`:recovery:${generation-1}`:'';
      this.entry(owner,row.bucketId,jobId,'release',1,`release:${jobId}${suffix}`,now);
      const source=sql.prepare('SELECT source FROM credit_buckets WHERE id=?').get(row.bucketId)?.source;
      if(source==='subscription'){
        const ended=sql.prepare(`SELECT 1 FROM hosted_paid_invoices i JOIN hosted_subscription_ends e
          ON e.subscription_id=i.subscription_id AND e.owner=i.owner WHERE i.bucket_id=?`).get(row.bucketId);
        if(ended){
          sql.prepare('UPDATE credit_buckets SET granted=granted-1 WHERE id=?').run(row.bucketId);
          this.entry(owner,row.bucketId,jobId,'adjust',-1,`end-release:${jobId}${suffix}`,now);
        }
        const refund=sql.prepare(`SELECT f.refunded_amount,f.paid_amount FROM hosted_payment_refunds f
          JOIN hosted_paid_invoices i ON i.invoice_id=f.invoice_id WHERE i.bucket_id=?`).get(row.bucketId);
        if(refund)this.capRefundedBucket(row.bucketId,owner,Number(refund.refunded_amount),
          Number(refund.paid_amount),`refund-release:${jobId}`,now);
      }
      if(source==='free'){
        const paid=this.activeCreator(owner,now);
        if(paid){
          const paidBucket=sql.prepare('SELECT granted FROM credit_buckets WHERE id=?').get(String(paid.id));
          const refunded=sql.prepare(`SELECT 1 FROM hosted_payment_refunds f
            JOIN hosted_paid_invoices i ON i.invoice_id=f.invoice_id WHERE i.bucket_id=?`).get(String(paid.id));
          if(paidBucket&&!refunded&&Number(paidBucket.granted)<paidPolicy(paid.policy_version).videos){
            sql.prepare('UPDATE credit_buckets SET granted=granted+1 WHERE id=?').run(String(paid.id));
            this.entry(owner,String(paid.id),jobId,'adjust',1,`creator-free-release:${jobId}`,now);
          }
        }
      }
      return this.read(jobId);
    });
  }
}
