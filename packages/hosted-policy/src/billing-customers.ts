import {randomUUID} from 'node:crypto';
import {isPackId} from './packs.js';
import type {TransactionalStore} from './index.js';

const accountId=/^acct_[A-Za-z0-9]{8,128}$/;
const customerId=/^cus_[A-Za-z0-9]{8,128}$/;
const sessionId=/^cs_(test|live)_[A-Za-z0-9_]{8,160}$/;
const subscriptionId=/^sub_[A-Za-z0-9]{8,128}$/;
const requestId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const intentLifetimeMs=24*60*60*1000;

export type CheckoutIntent={id:string;owner:string;expiresAt:number};
export type BoundBillingCustomer={owner:string;customerId:string;subscriptionId:string};
export type DeletionBillingSubscription=BoundBillingCustomer&{intentId:string};
export type OpenCheckoutForDeletion={intentId:string;sessionId:string};
export type MissingCheckoutSession={intentId:string;createdAt:number;expiresAt:number};

/** Private checkout identity registry. Binding a customer never grants a video credit. */
export class BillingCustomers {
  constructor(private readonly store:TransactionalStore,private readonly account:string,private readonly livemode:boolean){
    if(!accountId.test(account)||typeof livemode!=='boolean')throw new Error('billing_account_config_invalid');
    store.transaction(()=>{
      const exists=store.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='hosted_checkout_schema'").get();
      const version=exists?store.connection.prepare('SELECT version FROM hosted_checkout_schema WHERE singleton=1').get():undefined;
      if(version&&Number(version.version)>2)throw new Error('checkout_schema_newer_than_binary');
      store.connection.exec(`CREATE TABLE IF NOT EXISTS hosted_checkout_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO hosted_checkout_schema VALUES (1,1);
      CREATE TABLE IF NOT EXISTS hosted_checkout_intents (
        intent_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,livemode INTEGER NOT NULL CHECK(livemode IN (0,1)),
        owner TEXT NOT NULL REFERENCES accounts(owner),request_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        UNIQUE(account_id,livemode,owner,request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS hosted_checkout_plans (intent_id TEXT PRIMARY KEY REFERENCES hosted_checkout_intents(intent_id) ON DELETE CASCADE,plan TEXT NOT NULL CHECK(plan IN ('creator','studio'))) STRICT;
      CREATE TABLE IF NOT EXISTS hosted_checkout_packs (intent_id TEXT PRIMARY KEY REFERENCES hosted_checkout_intents(intent_id) ON DELETE CASCADE,pack TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS hosted_billing_customers (
        account_id TEXT NOT NULL,livemode INTEGER NOT NULL CHECK(livemode IN (0,1)),
        customer_id TEXT NOT NULL,owner TEXT NOT NULL REFERENCES accounts(owner),bound_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,livemode,customer_id),UNIQUE(account_id,livemode,owner)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS hosted_checkout_sessions (
        account_id TEXT NOT NULL,livemode INTEGER NOT NULL CHECK(livemode IN (0,1)),
        session_id TEXT NOT NULL,intent_id TEXT NOT NULL REFERENCES hosted_checkout_intents(intent_id),
        customer_id TEXT NOT NULL,subscription_id TEXT NOT NULL,completed_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,livemode,session_id),UNIQUE(account_id,livemode,intent_id),
        FOREIGN KEY(account_id,livemode,customer_id) REFERENCES hosted_billing_customers(account_id,livemode,customer_id)
      ) STRICT;`);
      if(Number(version?.version??1)<2){
        store.connection.exec(`CREATE TABLE IF NOT EXISTS hosted_checkout_created_sessions (
          account_id TEXT NOT NULL,livemode INTEGER NOT NULL CHECK(livemode IN (0,1)),
          intent_id TEXT NOT NULL REFERENCES hosted_checkout_intents(intent_id),session_id TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,expired_at INTEGER,
          PRIMARY KEY(account_id,livemode,intent_id),UNIQUE(account_id,livemode,session_id)
        ) STRICT;
        UPDATE hosted_checkout_schema SET version=2 WHERE singleton=1;`);
      }
    });
  }

  begin(owner:string,key:string,now=Date.now(),plan='creator'):CheckoutIntent{
    const pack=isPackId(plan);
    if(!['creator','studio'].includes(plan)&&!pack)throw new Error('checkout_plan_invalid');
    if(!owner||owner.length>128||!requestId.test(key)||!Number.isSafeInteger(now)||now<0)
      throw new Error('checkout_intent_invalid');
    return this.store.transaction(()=>{
      const sql=this.store.connection;
      const account=sql.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner);
      if(account?.admission_status!=='admitted')throw new Error('checkout_owner_not_admitted');
      const prior=sql.prepare(`SELECT i.intent_id,i.expires_at,c.expired_at provider_expired_at
        FROM hosted_checkout_intents i LEFT JOIN hosted_checkout_created_sessions c
          ON c.intent_id=i.intent_id AND c.account_id=i.account_id AND c.livemode=i.livemode
        WHERE i.account_id=? AND i.livemode=? AND i.owner=? AND i.request_id=?`)
        .get(this.account,Number(this.livemode),owner,key);
      if(prior){
        const saved=sql.prepare('SELECT plan FROM hosted_checkout_plans WHERE intent_id=?').get(String(prior.intent_id))
          ??sql.prepare('SELECT pack plan FROM hosted_checkout_packs WHERE intent_id=?').get(String(prior.intent_id));
        if((saved?.plan??'creator')!==plan)throw new Error('checkout_plan_conflict');
        if(Number(prior.expires_at)<=now||prior.provider_expired_at!==null)
          throw new Error('checkout_intent_expired');
        return {id:String(prior.intent_id),owner,expiresAt:Number(prior.expires_at)};
      }
      // A pack is a top-up: subscribers may buy one; a new subscription still needs a fresh customer.
      if(!pack&&sql.prepare(`SELECT 1 FROM hosted_billing_customers WHERE account_id=? AND livemode=? AND owner=?`)
        .get(this.account,Number(this.livemode),owner))throw new Error('checkout_existing_customer');
      if(sql.prepare(`SELECT 1 FROM hosted_checkout_intents i
        LEFT JOIN hosted_checkout_created_sessions c ON c.intent_id=i.intent_id
          AND c.account_id=i.account_id AND c.livemode=i.livemode
        WHERE i.account_id=? AND i.livemode=? AND i.owner=? AND i.expires_at>?
          AND c.expired_at IS NULL`)
        .get(this.account,Number(this.livemode),owner,now))throw new Error('checkout_intent_active');
      const id=randomUUID(),expiresAt=now+intentLifetimeMs;
      if(!Number.isSafeInteger(expiresAt))throw new Error('checkout_intent_invalid');
      sql.prepare(`INSERT INTO hosted_checkout_intents
        (intent_id,account_id,livemode,owner,request_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id,this.account,Number(this.livemode),owner,key,now,expiresAt);
      if(pack)sql.prepare('INSERT INTO hosted_checkout_packs VALUES (?,?)').run(id,plan);
      else sql.prepare('INSERT INTO hosted_checkout_plans VALUES (?,?)').run(id,plan);
      return {id,owner,expiresAt};
    });
  }

  /** Persist the provider Session before returning its URL to the caller. */
  recordCreated(intent:CheckoutIntent,session:string,now=Date.now()):void{
    if(!requestId.test(intent.id)||!sessionId.test(session)||
      !session.startsWith(this.livemode?'cs_live_':'cs_test_')||
      !Number.isSafeInteger(now)||now<0)throw new Error('checkout_created_session_invalid');
    this.store.transaction(()=>{
      const sql=this.store.connection;
      const saved=sql.prepare(`SELECT owner,expires_at FROM hosted_checkout_intents
        WHERE intent_id=? AND account_id=? AND livemode=?`)
        .get(intent.id,this.account,Number(this.livemode));
      if(!saved||saved.owner!==intent.owner||saved.expires_at!==intent.expiresAt||now>=intent.expiresAt)
        throw new Error('checkout_intent_expired');
      const previous=sql.prepare(`SELECT session_id,expired_at FROM hosted_checkout_created_sessions
        WHERE account_id=? AND livemode=? AND intent_id=?`)
        .get(this.account,Number(this.livemode),intent.id);
      if(previous){
        if(previous.session_id!==session||previous.expired_at!==null)
          throw new Error('checkout_created_session_conflict');
        return;
      }
      sql.prepare(`INSERT INTO hosted_checkout_created_sessions VALUES (?,?,?,?,?,NULL)`)
        .run(this.account,Number(this.livemode),intent.id,session,now);
    });
  }

  /** Candidate intents for an operator's provider-side recovery scan. */
  missingCreatedSessionsForDeletion(owner:string):MissingCheckoutSession[]{
    if(!owner||owner.length>128)throw new Error('billing_owner_invalid');
    return this.store.connection.prepare(`SELECT i.intent_id,i.created_at,i.expires_at
      FROM hosted_checkout_intents i
      LEFT JOIN hosted_checkout_sessions s ON s.intent_id=i.intent_id
        AND s.account_id=i.account_id AND s.livemode=i.livemode
      LEFT JOIN hosted_checkout_created_sessions c ON c.intent_id=i.intent_id
        AND c.account_id=i.account_id AND c.livemode=i.livemode
      WHERE i.owner=? AND i.account_id=? AND i.livemode=?
        AND s.session_id IS NULL AND c.session_id IS NULL`)
      .all(owner,this.account,Number(this.livemode))
      .map(row=>({intentId:String(row.intent_id),createdAt:Number(row.created_at),expiresAt:Number(row.expires_at)}));
  }

  /** Save a freshly discovered provider Session, including after its local intent deadline. */
  recordRecoveredSession(owner:string,intentId:string,session:string,now=Date.now()):void{
    if(!owner||owner.length>128||!requestId.test(intentId)||!sessionId.test(session)||
      !session.startsWith(this.livemode?'cs_live_':'cs_test_')||
      !Number.isSafeInteger(now)||now<0)throw new Error('checkout_recovery_reference_invalid');
    this.store.transaction(()=>{
      const sql=this.store.connection;
      const intent=sql.prepare(`SELECT owner FROM hosted_checkout_intents
        WHERE intent_id=? AND account_id=? AND livemode=?`)
        .get(intentId,this.account,Number(this.livemode));
      if(!intent||intent.owner!==owner)throw new Error('checkout_recovery_intent_mismatch');
      const completed=sql.prepare(`SELECT session_id FROM hosted_checkout_sessions
        WHERE intent_id=? AND account_id=? AND livemode=?`)
        .get(intentId,this.account,Number(this.livemode));
      if(completed){
        if(completed.session_id!==session)throw new Error('checkout_created_session_conflict');
        return;
      }
      const prior=sql.prepare(`SELECT session_id FROM hosted_checkout_created_sessions
        WHERE intent_id=? AND account_id=? AND livemode=?`)
        .get(intentId,this.account,Number(this.livemode));
      if(prior){
        if(prior.session_id!==session)throw new Error('checkout_created_session_conflict');
        return;
      }
      sql.prepare(`INSERT INTO hosted_checkout_created_sessions VALUES (?,?,?,?,?,NULL)`)
        .run(this.account,Number(this.livemode),intentId,session,now);
    });
  }

  /** This mark follows a fresh provider read proving this exact Session is expired. */
  recordExpired(intentId:string,session:string,now=Date.now()):void{
    if(!requestId.test(intentId)||!sessionId.test(session)||!Number.isSafeInteger(now)||now<0)
      throw new Error('checkout_expired_session_invalid');
    this.store.transaction(()=>{
      const sql=this.store.connection;
      const row=sql.prepare(`SELECT s.session_id,s.recorded_at,s.expired_at,c.session_id completed FROM hosted_checkout_created_sessions s
        LEFT JOIN hosted_checkout_sessions c ON c.intent_id=s.intent_id
          AND c.account_id=s.account_id AND c.livemode=s.livemode
        WHERE s.account_id=? AND s.livemode=? AND s.intent_id=?`)
        .get(this.account,Number(this.livemode),intentId);
      if(!row||row.session_id!==session||row.completed!==null||now<Number(row.recorded_at))
        throw new Error('checkout_expired_session_conflict');
      if(row.expired_at===null)sql.prepare(`UPDATE hosted_checkout_created_sessions SET expired_at=?
        WHERE account_id=? AND livemode=? AND intent_id=?`).run(now,this.account,Number(this.livemode),intentId);
    });
  }

  /** Every unbound intent must have a known Session before automated closure. */
  openCheckoutsForDeletion(owner:string):OpenCheckoutForDeletion[]{
    if(!owner||owner.length>128)throw new Error('billing_owner_invalid');
    const rows=this.store.connection.prepare(`SELECT i.intent_id,c.session_id,c.expired_at FROM hosted_checkout_intents i
      LEFT JOIN hosted_checkout_sessions s ON s.intent_id=i.intent_id
        AND s.account_id=i.account_id AND s.livemode=i.livemode
      LEFT JOIN hosted_checkout_created_sessions c ON c.intent_id=i.intent_id
        AND c.account_id=i.account_id AND c.livemode=i.livemode
      WHERE i.owner=? AND i.account_id=? AND i.livemode=? AND s.session_id IS NULL`)
      .all(owner,this.account,Number(this.livemode));
    if(rows.some(row=>row.session_id===null))throw new Error('billing_unbound_checkout_requires_review');
    return rows.filter(row=>row.expired_at===null)
      .map(row=>({intentId:String(row.intent_id),sessionId:String(row.session_id)}));
  }

  /** Call only with a fresh Checkout Session read from Stripe after matching its verified event. */
  bindCompleted(session:Record<string,unknown>,now=Date.now()):BoundBillingCustomer{
    const metadata=session.metadata&&typeof session.metadata==='object'&&!Array.isArray(session.metadata)
      ?session.metadata as Record<string,unknown>:undefined;
    const id=session.id,customer=session.customer,subscription=session.subscription,intentId=session.client_reference_id;
    if(typeof id!=='string'||!sessionId.test(id)||!id.startsWith(this.livemode?'cs_live_':'cs_test_')||
      session.object!=='checkout.session'||session.livemode!==this.livemode||session.mode!=='subscription'||
      session.status!=='complete'||typeof customer!=='string'||!customerId.test(customer)||
      typeof subscription!=='string'||!subscriptionId.test(subscription)||
      typeof intentId!=='string'||!requestId.test(intentId)||
      metadata?.product!=='agent-recorder'||metadata.intent_id!==intentId||
      !Number.isSafeInteger(session.created)||Number(session.created)<0||
      !Number.isSafeInteger(now)||now<0)
      throw new Error('checkout_session_invalid');
    const apply=():BoundBillingCustomer=>{
      const sql=this.store.connection;
      const intent=sql.prepare(`SELECT owner,created_at,expires_at FROM hosted_checkout_intents
        WHERE intent_id=? AND account_id=? AND livemode=?`)
        .get(intentId,this.account,Number(this.livemode));
      if(!intent)throw new Error('checkout_intent_not_found');
      const owner=String(intent.owner),createdMs=Number(session.created)*1000;
      if(createdMs<Number(intent.created_at)-60_000||createdMs>Number(intent.expires_at)+60_000)
        throw new Error('checkout_intent_expired');
      const ownerState=sql.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner);
      if(ownerState?.admission_status!=='admitted')throw new Error('checkout_owner_not_admitted');
      const created=sql.prepare(`SELECT session_id,expired_at FROM hosted_checkout_created_sessions
        WHERE account_id=? AND livemode=? AND intent_id=?`)
        .get(this.account,Number(this.livemode),intentId);
      if(created&&(created.session_id!==id||created.expired_at!==null))
        throw new Error('checkout_session_conflict');
      const prior=sql.prepare(`SELECT intent_id,customer_id,subscription_id FROM hosted_checkout_sessions
        WHERE account_id=? AND livemode=? AND session_id=?`)
        .get(this.account,Number(this.livemode),id);
      if(prior){
        if(prior.intent_id!==intentId||prior.customer_id!==customer||prior.subscription_id!==subscription)
          throw new Error('checkout_session_conflict');
        return {owner,customerId:customer,subscriptionId:subscription};
      }
      const bound=sql.prepare(`SELECT owner FROM hosted_billing_customers
        WHERE account_id=? AND livemode=? AND customer_id=?`).get(this.account,Number(this.livemode),customer);
      if(bound&&bound.owner!==owner)throw new Error('billing_customer_owner_conflict');
      const existing=sql.prepare(`SELECT customer_id FROM hosted_billing_customers
        WHERE account_id=? AND livemode=? AND owner=?`).get(this.account,Number(this.livemode),owner);
      if(existing&&existing.customer_id!==customer)throw new Error('billing_owner_customer_conflict');
      if(!bound)sql.prepare(`INSERT INTO hosted_billing_customers VALUES (?,?,?,?,?)`)
        .run(this.account,Number(this.livemode),customer,owner,now);
      sql.prepare(`INSERT INTO hosted_checkout_sessions VALUES (?,?,?,?,?,?,?)`)
        .run(this.account,Number(this.livemode),id,intentId,customer,subscription,now);
      return {owner,customerId:customer,subscriptionId:subscription};
    };
    return this.store.connection.isTransaction?apply():this.store.transaction(apply);
  }

  ownerFor(customer:string):string|undefined{
    if(!customerId.test(customer))throw new Error('billing_customer_invalid');
    const row=this.store.connection.prepare(`SELECT owner FROM hosted_billing_customers
      WHERE account_id=? AND livemode=? AND customer_id=?`).get(this.account,Number(this.livemode),customer);
    return row?String(row.owner):undefined;
  }

  /** The pack an intent was opened for, with its owner; undefined for subscription intents. */
  packForIntent(intentId:string):{owner:string;pack:string;createdAt:number;expiresAt:number}|undefined{
    if(!requestId.test(intentId))throw new Error('checkout_intent_invalid');
    const row=this.store.connection.prepare(`SELECT i.owner,p.pack,i.created_at,i.expires_at FROM hosted_checkout_packs p
      JOIN hosted_checkout_intents i ON i.intent_id=p.intent_id WHERE p.intent_id=? AND i.account_id=? AND i.livemode=?`).get(intentId,this.account,Number(this.livemode));
    return row?{owner:String(row.owner),pack:String(row.pack),createdAt:Number(row.created_at),expiresAt:Number(row.expires_at)}:undefined;
  }
  customerForOwner(owner:string):string|undefined{
    if(!owner||owner.length>128)throw new Error('billing_owner_invalid');
    const row=this.store.connection.prepare(`SELECT c.customer_id FROM hosted_billing_customers c
      JOIN accounts a ON a.owner=c.owner
      WHERE c.account_id=? AND c.livemode=? AND c.owner=? AND a.admission_status='admitted'`)
      .get(this.account,Number(this.livemode),owner);
    return row?String(row.customer_id):undefined;
  }

  ownerForSubscription(customer:string,subscription:string):string|undefined{
    if(!customerId.test(customer)||!subscriptionId.test(subscription))throw new Error('billing_subscription_invalid');
    const row=this.store.connection.prepare(`SELECT c.owner FROM hosted_checkout_sessions s
      JOIN hosted_billing_customers c ON c.account_id=s.account_id AND c.livemode=s.livemode
        AND c.customer_id=s.customer_id
      WHERE s.account_id=? AND s.livemode=? AND s.customer_id=? AND s.subscription_id=?`)
      .get(this.account,Number(this.livemode),customer,subscription);
    return row?String(row.owner):undefined;
  }

  /** Refuse an ambiguous or unbound purchase before touching the provider for erasure. */
  subscriptionForDeletion(owner:string):DeletionBillingSubscription{
    if(!owner||owner.length>128)throw new Error('billing_owner_invalid');
    const rows=this.store.connection.prepare(`SELECT s.customer_id,s.subscription_id,i.intent_id FROM hosted_checkout_sessions s
      JOIN hosted_checkout_intents i ON i.intent_id=s.intent_id AND i.account_id=s.account_id AND i.livemode=s.livemode
      WHERE i.owner=?`).all(owner);
    const unresolved=this.store.connection.prepare(`SELECT 1 FROM hosted_checkout_intents i
      LEFT JOIN hosted_checkout_sessions s ON s.intent_id=i.intent_id
        AND s.account_id=i.account_id AND s.livemode=i.livemode
      LEFT JOIN hosted_checkout_created_sessions c ON c.intent_id=i.intent_id
        AND c.account_id=i.account_id AND c.livemode=i.livemode
      WHERE i.owner=? AND s.session_id IS NULL AND c.expired_at IS NULL LIMIT 1`).get(owner);
    if(unresolved)throw new Error('billing_unbound_checkout_requires_review');
    if(rows.length!==1)throw new Error('billing_subscription_requires_review');
    const row=rows[0]!;
    if(this.ownerForSubscription(String(row.customer_id),String(row.subscription_id))!==owner)
      throw new Error('billing_subscription_requires_review');
    return {owner,customerId:String(row.customer_id),subscriptionId:String(row.subscription_id),
      intentId:String(row.intent_id)};
  }
}
