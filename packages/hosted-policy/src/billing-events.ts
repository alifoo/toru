import {createHash} from 'node:crypto';
import type {TransactionalStore} from './index.js';

/** Only call this after Stripe's raw-body signature has been verified by the HTTP adapter. */
export type VerifiedBillingEvent={
  id:string;account:string;livemode:boolean;type:string;objectId:string;created:number;rawBody:Buffer;
};

const eventId=/^evt_[A-Za-z0-9]{8,128}$/;
const accountId=/^acct_[A-Za-z0-9]{8,128}$/;
const objectId=/^[a-z][a-z0-9]*_[A-Za-z0-9_]{8,160}$/;
const eventType=/^[a-z][a-z0-9_.]{2,100}$/;
export const maximumBillingBodyBytes=256*1024;

type Receipt={eventId:string;status:'pending'|'processed';duplicate:boolean};
export type PendingBillingEvent={eventId:string;type:string;objectId:string;created:number};

/** Private durable inbox. It deliberately does not grant access or charge a customer. */
export class BillingEventInbox {
  constructor(private readonly store:TransactionalStore,private readonly account:string,private readonly livemode:boolean){
    if(!accountId.test(account)||typeof livemode!=='boolean')throw new Error('billing_account_config_invalid');
    store.transaction(()=>{
      const exists=store.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='hosted_billing_schema'").get();
      const version=exists?store.connection.prepare("SELECT version FROM hosted_billing_schema WHERE singleton=1").get():undefined;
      if(version && Number(version.version)>2)throw new Error('billing_schema_newer_than_binary');
    });
    BillingEventInbox.initialize(store);
  }

  static initialize(store:TransactionalStore){
    store.transaction(()=>{
      store.connection.exec(`CREATE TABLE IF NOT EXISTS hosted_billing_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO hosted_billing_schema VALUES (1,1);
    CREATE TABLE IF NOT EXISTS hosted_billing_events (
      event_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,livemode INTEGER NOT NULL CHECK(livemode IN (0,1)),
      event_type TEXT NOT NULL,object_id TEXT NOT NULL,event_created INTEGER NOT NULL,
      body_sha256 TEXT NOT NULL,received_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processed')),processed_at INTEGER,
      CHECK((status='processed')=(processed_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS hosted_billing_pending ON hosted_billing_events(status,received_at);`);
      const version=Number(store.connection.prepare('SELECT version FROM hosted_billing_schema WHERE singleton=1').get()?.version);
      if(version===1){
        store.connection.exec(`ALTER TABLE hosted_billing_events ADD COLUMN last_attempt_seq INTEGER NOT NULL DEFAULT 0;
          UPDATE hosted_billing_schema SET version=2 WHERE singleton=1;`);
      }
      store.connection.exec(`CREATE INDEX IF NOT EXISTS hosted_billing_retry_order
        ON hosted_billing_events(status,account_id,livemode,event_type,last_attempt_seq,received_at,event_id);`);
    });
  }

  acceptVerified(event:VerifiedBillingEvent,now=Date.now()):Receipt {
    if(event.account!==this.account||event.livemode!==this.livemode)throw new Error('billing_account_or_mode_mismatch');
    if(!eventId.test(event.id)||!eventType.test(event.type)||!objectId.test(event.objectId)||
      !Number.isSafeInteger(event.created)||event.created<0||!Number.isSafeInteger(now)||now<0||
      !Buffer.isBuffer(event.rawBody)||event.rawBody.length===0||event.rawBody.length>maximumBillingBodyBytes)
      throw new Error('billing_event_invalid');
    const sha=createHash('sha256').update(event.rawBody).digest('hex');
    return this.store.transaction(()=>{
      const sql=this.store.connection;
      const previous=sql.prepare('SELECT account_id,livemode,event_type,object_id,event_created,body_sha256,status FROM hosted_billing_events WHERE event_id=?').get(event.id);
      if(previous){
        if(previous.account_id!==event.account||Number(previous.livemode)!==Number(event.livemode)||
          previous.event_type!==event.type||previous.object_id!==event.objectId||
          Number(previous.event_created)!==event.created||previous.body_sha256!==sha)
          throw new Error('billing_event_id_conflict');
        return {eventId:event.id,status:String(previous.status) as Receipt['status'],duplicate:true};
      }
      sql.prepare(`INSERT INTO hosted_billing_events
        (event_id,account_id,livemode,event_type,object_id,event_created,body_sha256,received_at,status)
        VALUES (?,?,?,?,?,?,?,?,'pending')`).run(event.id,event.account,Number(event.livemode),event.type,
          event.objectId,event.created,sha,now);
      return {eventId:event.id,status:'pending',duplicate:false};
    });
  }

  pending(limit=50):PendingBillingEvent[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('billing_limit_invalid');
    return this.store.connection.prepare(`SELECT event_id,event_type,object_id,event_created FROM hosted_billing_events
      WHERE status='pending' AND account_id=? AND livemode=? ORDER BY received_at,event_id LIMIT ?`)
      .all(this.account,Number(this.livemode),limit).map(row=>({
      eventId:String(row.event_id),type:String(row.event_type),objectId:String(row.object_id),created:Number(row.event_created)
    }));
  }

  pendingOfType(type:string,limit=50):PendingBillingEvent[]{
    if(!eventType.test(type)||!Number.isSafeInteger(limit)||limit<1||limit>100)
      throw new Error('billing_limit_invalid');
    return this.store.connection.prepare(`SELECT event_id,event_type,object_id,event_created FROM hosted_billing_events
      WHERE status='pending' AND account_id=? AND livemode=? AND event_type=?
      ORDER BY last_attempt_seq,received_at,event_id LIMIT ?`).all(this.account,Number(this.livemode),type,limit).map(row=>({
      eventId:String(row.event_id),type:String(row.event_type),objectId:String(row.object_id),created:Number(row.event_created)
    }));
  }

  /** Move a failed receipt behind newer/untried receipts without discarding it. */
  deferPending(eventIdValue:string):boolean {
    if(!eventId.test(eventIdValue))throw new Error('billing_event_invalid');
    return this.store.transaction(()=>{
      const next=Number(this.store.connection.prepare(
        'SELECT COALESCE(MAX(last_attempt_seq),0)+1 AS next FROM hosted_billing_events').get()?.next);
      if(!Number.isSafeInteger(next))throw new Error('billing_retry_order_exhausted');
      return this.store.connection.prepare(`UPDATE hosted_billing_events SET last_attempt_seq=?
        WHERE event_id=? AND account_id=? AND livemode=? AND status='pending'`)
        .run(next,eventIdValue,this.account,Number(this.livemode)).changes===1;
    });
  }

  /** Keep the entitlement decision and receipt completion in one SQLite transaction. */
  processPending(eventIdValue:string,apply:(event:PendingBillingEvent)=>void,now=Date.now()):boolean {
    if(!eventId.test(eventIdValue)||!Number.isSafeInteger(now)||now<0)throw new Error('billing_event_invalid');
    return this.store.transaction(()=>{
      const row=this.store.connection.prepare(`SELECT event_id,event_type,object_id,event_created
        FROM hosted_billing_events WHERE event_id=? AND account_id=? AND livemode=? AND status='pending'`)
        .get(eventIdValue,this.account,Number(this.livemode));
      if(!row)return false;
      apply({eventId:String(row.event_id),type:String(row.event_type),objectId:String(row.object_id),created:Number(row.event_created)});
      const result=this.store.connection.prepare(`UPDATE hosted_billing_events SET status='processed',processed_at=?
        WHERE event_id=? AND account_id=? AND livemode=? AND status='pending'`)
        .run(now,eventIdValue,this.account,Number(this.livemode));
      if(result.changes!==1)throw new Error('billing_event_completion_conflict');
      return true;
    });
  }
}
