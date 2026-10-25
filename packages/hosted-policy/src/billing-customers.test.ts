import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {BillingCustomers} from './billing-customers.js';
import {BillingEventInbox} from './billing-events.js';
import {reconcileCheckoutBindings,reconcileCreatorInvoices,reconcileEndedSubscriptions,
  reconcileCreatorRefunds} from './stripe-reconcile.js';
import {CreditLedger} from './index.js';
import {closeBoundSubscriptionForDeletion} from './billing-close.js';
import {closeOpenCheckoutsForDeletion} from './billing-checkout-close.js';

const account='acct_123456789ABC',owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const key='33333333-3333-4333-8333-333333333333';
const creatorPrice='price_123456789ABC';
const created=1_800_000_000_000;

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'recorder-billing-customer-'));
  const db=new DatabaseSync(join(dir,'billing.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE accounts (
    owner TEXT PRIMARY KEY,admission_status TEXT NOT NULL
  ) STRICT;`);
  db.prepare('INSERT INTO accounts VALUES (?,?)').run(owner,'admitted');
  db.prepare('INSERT INTO accounts VALUES (?,?)').run(other,'admitted');
  const store={connection:db,transaction:<T>(work:()=>T):T=>{
    db.exec('BEGIN IMMEDIATE');
    try{const result=work();db.exec('COMMIT');return result;}
    catch(error){db.exec('ROLLBACK');throw error;}
  }};
  return {db,store,close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};
}

function session(intentId:string,overrides:Record<string,unknown>={}){
  return {id:'cs_test_123456789ABC',object:'checkout.session',livemode:false,mode:'subscription',
    status:'complete',payment_status:'paid',customer:'cus_123456789ABC',subscription:'sub_123456789ABC',
    client_reference_id:intentId,created:Math.floor((created+1000)/1000),
    metadata:{product:'agent-recorder',intent_id:intentId},...overrides};
}

it('binds a completed checkout to its persisted intent in the receipt transaction without granting credits',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false);
    const intent=customers.begin(owner,key,created);
    expect(customers.begin(owner,key,created+100)).toEqual(intent);
    expect(()=>customers.begin(owner,'55555555-5555-4555-8555-555555555555',created+100))
      .toThrow('checkout_intent_active');
    expect(intent.expiresAt).toBe(created+24*60*60*1000);
    const inbox=new BillingEventInbox(f.store,account,false);
    const event={id:'evt_123456789ABC',account,livemode:false,type:'checkout.session.completed',
      objectId:'cs_test_123456789ABC',created:Math.floor(created/1000),rawBody:Buffer.from('signed-test-body')};
    inbox.acceptVerified(event,created);
    expect(inbox.processPending(event.id,receipt=>{
      expect(receipt.objectId).toBe(session(intent.id).id);
      expect(customers.bindCompleted(session(intent.id),created+2000)).toEqual({
        owner,customerId:'cus_123456789ABC',subscriptionId:'sub_123456789ABC'
      });
    },created+2000)).toBe(true);
    expect(inbox.processPending(event.id,()=>{throw new Error('duplicate');})).toBe(false);
    expect(customers.ownerFor('cus_123456789ABC')).toBe(owner);
    expect(customers.ownerForSubscription('cus_123456789ABC','sub_123456789ABC')).toBe(owner);
    expect(customers.ownerForSubscription('cus_123456789ABC','sub_999999999XYZ')).toBeUndefined();
    expect(()=>customers.begin(owner,'55555555-5555-4555-8555-555555555555',created+3000))
      .toThrow('checkout_existing_customer');
    expect(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='credit_buckets'").get()).toBeUndefined();
  }finally{await f.close();}
});

it('closes a bound subscription before erasure and revokes unused paid credit once',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),ledger=new CreditLedger(f.store);
    const checkout=customers.begin(owner,key,created);
    customers.bindCompleted(session(checkout.id),created+1000);
    ledger.grantCreatorCycle(owner,'sub_123456789ABC','in_123456789ABC',
      created,created+30*86400000,created+2000);
    const closer={endForDeletion:async(customerId:string,subscriptionId:string,intentId:string)=>{
      expect({customerId,subscriptionId,intentId}).toEqual({customerId:'cus_123456789ABC',
        subscriptionId:'sub_123456789ABC',intentId:checkout.id});
      return created+3000;
    }};
    const first=await closeBoundSubscriptionForDeletion(f.store,customers,ledger,closer,owner,()=>created+4000);
    expect(first).toEqual({effectiveAt:created+3000,revoked:50});
    expect(f.db.prepare('SELECT granted FROM credit_buckets WHERE source=?').get('subscription')!.granted).toBe(0);
    expect(await closeBoundSubscriptionForDeletion(f.store,customers,ledger,closer,owner,()=>created+5000))
      .toEqual({effectiveAt:created+3000,revoked:0});
    expect(f.db.prepare("SELECT count(*) n FROM credit_entries WHERE kind='adjust'").get()!.n).toBe(1);
  }finally{await f.close();}
});

it('persists a created Session and only clears the unbound hold after verified expiry',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    const closer={expireForDeletion:async(id:string,intentId:string)=>{
      expect({id,intentId}).toEqual({id:'cs_test_123456789ABC',intentId:intent.id});
    }};
    await expect(closeOpenCheckoutsForDeletion(customers,closer,owner))
      .rejects.toThrow('billing_unbound_checkout_requires_review');
    customers.recordCreated(intent,'cs_test_123456789ABC',created+1000);
    customers.recordCreated(intent,'cs_test_123456789ABC',created+2000);
    expect(()=>customers.recordCreated(intent,'cs_test_999999999XYZ',created+3000))
      .toThrow('checkout_created_session_conflict');
    expect(customers.openCheckoutsForDeletion(owner)).toEqual([
      {intentId:intent.id,sessionId:'cs_test_123456789ABC'}]);
    expect(await closeOpenCheckoutsForDeletion(customers,closer,owner,()=>created+4000)).toBe(1);
    expect(await closeOpenCheckoutsForDeletion(customers,closer,owner,()=>created+5000)).toBe(0);
    expect(()=>customers.begin(owner,key,created+5000)).toThrow('checkout_intent_expired');
    expect(customers.begin(owner,'55555555-5555-4555-8555-555555555555',created+5000).id)
      .not.toBe(intent.id);
    expect(()=>customers.bindCompleted(session(intent.id),created+4000))
      .toThrow('checkout_session_conflict');
  }finally{await f.close();}
});

it('recovers a provider Session after the local deadline without clearing the deletion hold',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    expect(customers.missingCreatedSessionsForDeletion(owner)).toEqual([
      {intentId:intent.id,createdAt:created,expiresAt:intent.expiresAt}]);
    expect(()=>customers.openCheckoutsForDeletion(owner))
      .toThrow('billing_unbound_checkout_requires_review');
    customers.recordRecoveredSession(owner,intent.id,'cs_test_123456789ABC',intent.expiresAt+1000);
    customers.recordRecoveredSession(owner,intent.id,'cs_test_123456789ABC',intent.expiresAt+2000);
    expect(customers.missingCreatedSessionsForDeletion(owner)).toEqual([]);
    expect(customers.openCheckoutsForDeletion(owner)).toEqual([
      {intentId:intent.id,sessionId:'cs_test_123456789ABC'}]);
    expect(()=>customers.recordRecoveredSession(other,intent.id,'cs_test_123456789ABC'))
      .toThrow('checkout_recovery_intent_mismatch');
    expect(()=>customers.recordRecoveredSession(owner,intent.id,'cs_test_999999999XYZ'))
      .toThrow('checkout_created_session_conflict');
    expect(await closeOpenCheckoutsForDeletion(customers,{
      expireForDeletion:async(sessionId,foundIntent)=>{
        expect([sessionId,foundIntent]).toEqual(['cs_test_123456789ABC',intent.id]);
      }
    },owner,()=>intent.expiresAt+3000)).toBe(1);
    expect(customers.openCheckoutsForDeletion(owner)).toEqual([]);
  }finally{await f.close();}
});

it('upgrades an existing checkout registry without losing its original intent',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    f.db.exec('DROP TABLE hosted_checkout_created_sessions; UPDATE hosted_checkout_schema SET version=1');
    const upgraded=new BillingCustomers(f.store,account,false);
    expect(f.db.prepare('SELECT version FROM hosted_checkout_schema').get()!.version).toBe(2);
    expect(upgraded.begin(owner,key,created+100)).toEqual(intent);
  }finally{await f.close();}
});

it('rejects unrelated shared-account checkout and rolls back customer mapping with receipt on failure',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    expect(()=>customers.bindCompleted(session('44444444-4444-4444-8444-444444444444'))).toThrow('checkout_intent_not_found');
    expect(()=>customers.bindCompleted(session(intent.id,{metadata:{product:'contentlayer',intent_id:intent.id}})))
      .toThrow('checkout_session_invalid');
    expect(()=>customers.bindCompleted(session(intent.id,{created:Math.floor((created+48*60*60*1000)/1000)})))
      .toThrow('checkout_intent_expired');
    const inbox=new BillingEventInbox(f.store,account,false);
    const event={id:'evt_123456789ABC',account,livemode:false,type:'checkout.session.completed',
      objectId:'cs_test_123456789ABC',created:Math.floor(created/1000),rawBody:Buffer.from('signed-test-body')};
    inbox.acceptVerified(event,created);
    expect(()=>inbox.processPending(event.id,()=>{
      customers.bindCompleted(session(intent.id),created+2000);
      throw new Error('later_entitlement_failed');
    })).toThrow('later_entitlement_failed');
    expect(customers.ownerFor('cus_123456789ABC')).toBeUndefined();
    expect(inbox.pending()).toHaveLength(1);
  }finally{await f.close();}
});

it('does not let another owner or Stripe mode claim the same customer',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false);
    const first=customers.begin(owner,key,created),second=customers.begin(other,key,created);
    customers.bindCompleted(session(first.id),created+2000);
    expect(()=>customers.bindCompleted(session(second.id,{
      id:'cs_test_999999999XYZ',metadata:{product:'agent-recorder',intent_id:second.id}
    }),created+2000)).toThrow('billing_customer_owner_conflict');
    expect(customers.ownerFor('cus_123456789ABC')).toBe(owner);
    expect(new BillingCustomers(f.store,account,true).ownerFor('cus_123456789ABC')).toBeUndefined();
    expect(new BillingCustomers(f.store,account,true)
      .ownerForSubscription('cus_123456789ABC','sub_123456789ABC')).toBeUndefined();
  }finally{await f.close();}
});

it('rejects a retry of an expired intent before it can reuse an aged Stripe idempotency key',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false);
    const intent=customers.begin(owner,key,created);
    expect(()=>customers.begin(owner,key,intent.expiresAt)).toThrow('checkout_intent_expired');
    expect(f.db.prepare('SELECT count(*) n FROM hosted_checkout_intents').get()!.n).toBe(1);
    expect(customers.begin(owner,'55555555-5555-4555-8555-555555555555',intent.expiresAt).id)
      .not.toBe(intent.id);
  }finally{await f.close();}
});

it('reconciles Checkout binding after an earlier invoice event and leaves unrelated events pending',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    const inbox=new BillingEventInbox(f.store,account,false);
    inbox.acceptVerified({id:'evt_111111111111',account,livemode:false,type:'invoice.paid',
      objectId:'in_123456789ABC',created:Math.floor(created/1000),rawBody:Buffer.from('invoice')},created);
    inbox.acceptVerified({id:'evt_222222222222',account,livemode:false,type:'checkout.session.completed',
      objectId:'cs_test_123456789ABC',created:Math.floor(created/1000),rawBody:Buffer.from('checkout')},created+1);
    const currentFor=async()=>session(intent.id);
    const verifyCreatorLineItem=async(id:string,price:string)=>{
      expect(id).toBe('cs_test_123456789ABC');expect(price).toBe(creatorPrice);
    };
    expect(await reconcileCheckoutBindings(inbox,{currentFor,verifyCreatorLineItem},customers,creatorPrice)).toEqual([
      {eventId:'evt_222222222222',status:'bound'}
    ]);
    expect(customers.ownerFor('cus_123456789ABC')).toBe(owner);
    expect(inbox.pending().map(row=>row.eventId)).toEqual(['evt_111111111111']);
    expect(await reconcileCheckoutBindings(inbox,{currentFor,verifyCreatorLineItem},customers,creatorPrice)).toEqual([]);
  }finally{await f.close();}
});

it('grants exactly one Creator cycle after a verified invoice and Checkout binding, including out-of-order delivery',async()=>{
  const f=await fixture();
  try{
    const inbox=new BillingEventInbox(f.store,account,false),customers=new BillingCustomers(f.store,account,false),
      ledger=new CreditLedger(f.store),intent=customers.begin(owner,key,created);
    const invoiceId='in_123456789ABC',invoiceEvent='evt_444444444444';
    inbox.acceptVerified({id:invoiceEvent,account,livemode:false,type:'invoice.paid',objectId:invoiceId,
      created:Math.floor(created/1000),rawBody:Buffer.from('invoice')},created);
    const period={invoiceId,customerId:'cus_123456789ABC',subscriptionId:'sub_123456789ABC',
      periodStartMs:created,periodEndMs:created+30*86400000,
      paymentIntentId:'pi_123456789ABC',chargeId:'ch_123456789ABC',
      paidAmount:1900,amountRefunded:0,currency:'usd'};
    const reader={currentFor:async()=>({id:invoiceId,object:'invoice'}),verifyCreatorInvoice:async()=>period};
    expect(await reconcileCreatorInvoices(inbox,reader,customers,ledger,creatorPrice,'prod_123456789ABC'))
      .toEqual([{eventId:invoiceEvent,status:'retry',code:'billing_subscription_unbound'}]);
    expect(f.db.prepare("SELECT count(*) n FROM credit_buckets").get()!.n).toBe(0);
    customers.bindCompleted(session(intent.id),created+2000);
    expect(await reconcileCreatorInvoices(inbox,reader,customers,ledger,creatorPrice,'prod_123456789ABC'))
      .toEqual([{eventId:invoiceEvent,status:'granted'}]);
    expect(await reconcileCreatorInvoices(inbox,reader,customers,ledger,creatorPrice,'prod_123456789ABC')).toEqual([]);
    expect(ledger.usage(owner,created+1000)).toMatchObject({available:50,policy:{version:'creator-v1'}});
    expect(f.db.prepare("SELECT count(*) n FROM hosted_paid_invoices").get()!.n).toBe(1);
    expect(f.db.prepare("SELECT status FROM hosted_billing_events WHERE event_id=?").get(invoiceEvent)?.status)
      .toBe('processed');
  }finally{await f.close();}
});

it('reconciles a terminal subscription once using ended_at and leaves an unrelated subscription pending',async()=>{
  const f=await fixture();
  try{
    const inbox=new BillingEventInbox(f.store,account,false),customers=new BillingCustomers(f.store,account,false),
      ledger=new CreditLedger(f.store),intent=customers.begin(owner,key,created);
    customers.bindCompleted(session(intent.id),created+2000);
    const subscriptionId='sub_123456789ABC',endedAt=created+10*86400000;
    ledger.grantCreatorCycle(owner,subscriptionId,'in_123456789ABC',created,created+30*86400000,created);
    const eventId='evt_555555555555';
    inbox.acceptVerified({id:eventId,account,livemode:false,type:'customer.subscription.deleted',
      objectId:subscriptionId,created:Math.floor(endedAt/1000),rawBody:Buffer.from('ended')},endedAt);
    const reader={currentFor:async()=>({id:subscriptionId,object:'subscription',customer:'cus_123456789ABC',
      status:'canceled',ended_at:Math.floor(endedAt/1000)}),
      verifyEndedSubscription:()=>({customerId:'cus_123456789ABC',subscriptionId,endedAtMs:endedAt})};
    expect(await reconcileEndedSubscriptions(inbox,reader,customers,ledger,25,()=>endedAt))
      .toEqual([{eventId,status:'ended'}]);
    expect(await reconcileEndedSubscriptions(inbox,reader,customers,ledger,25,()=>endedAt)).toEqual([]);
    expect(ledger.usage(owner,endedAt)).toMatchObject({available:10,policy:{version:'free-v1'}});
    const unrelated='evt_666666666666';
    inbox.acceptVerified({id:unrelated,account,livemode:false,type:'customer.subscription.deleted',
      objectId:'sub_999999999XYZ',created:Math.floor(endedAt/1000),rawBody:Buffer.from('other')},endedAt);
    const otherReader={...reader,verifyEndedSubscription:()=>({customerId:'cus_999999999XYZ',
      subscriptionId:'sub_999999999XYZ',endedAtMs:endedAt})};
    expect(await reconcileEndedSubscriptions(inbox,otherReader,customers,ledger,25,()=>endedAt))
      .toEqual([{eventId:unrelated,status:'retry',code:'billing_subscription_unbound'}]);
    expect(inbox.pendingOfType('customer.subscription.deleted')).toHaveLength(1);
  }finally{await f.close();}
});
it('keeps a late paid-invoice event from restoring access after the subscription ended',async()=>{
  const f=await fixture();
  try{
    const inbox=new BillingEventInbox(f.store,account,false),customers=new BillingCustomers(f.store,account,false),
      ledger=new CreditLedger(f.store),intent=customers.begin(owner,key,created);
    customers.bindCompleted(session(intent.id),created+2000);
    const subscriptionId='sub_123456789ABC',invoiceId='in_123456789ABC',endedAt=created+10*86400000;
    inbox.acceptVerified({id:'evt_777777777777',account,livemode:false,type:'customer.subscription.deleted',
      objectId:subscriptionId,created:Math.floor(endedAt/1000),rawBody:Buffer.from('ended')},endedAt);
    inbox.acceptVerified({id:'evt_888888888888',account,livemode:false,type:'invoice.paid',
      objectId:invoiceId,created:Math.floor(created/1000),rawBody:Buffer.from('paid')},endedAt);
    const ending={currentFor:async()=>({id:subscriptionId,object:'subscription'}),
      verifyEndedSubscription:()=>({customerId:'cus_123456789ABC',subscriptionId,endedAtMs:endedAt})};
    expect((await reconcileEndedSubscriptions(inbox,ending,customers,ledger,25,()=>endedAt))[0]?.status).toBe('ended');
    const invoice={currentFor:async()=>({id:invoiceId,object:'invoice'}),
      verifyCreatorInvoice:async()=>({invoiceId,customerId:'cus_123456789ABC',subscriptionId,
        periodStartMs:created,periodEndMs:created+30*86400000,
        paymentIntentId:'pi_123456789ABC',chargeId:'ch_123456789ABC',
        paidAmount:1900,amountRefunded:0,currency:'usd'})};
    expect((await reconcileCreatorInvoices(inbox,invoice,customers,ledger,creatorPrice,'prod_123456789ABC'))[0]?.status)
      .toBe('granted');
    expect(f.db.prepare('SELECT granted,expires_at FROM credit_buckets WHERE source=?').get('subscription'))
      .toEqual({granted:0,expires_at:endedAt});
    expect(ledger.usage(owner,endedAt+1)).toMatchObject({available:10,policy:{version:'free-v1'}});
  }finally{await f.close();}
});

it('reconciles a bound partial refund once and leaves an unrelated charge pending',async()=>{
  const f=await fixture();
  try{
    const inbox=new BillingEventInbox(f.store,account,false),customers=new BillingCustomers(f.store,account,false),
      ledger=new CreditLedger(f.store),intent=customers.begin(owner,key,created);
    customers.bindCompleted(session(intent.id),created+2000);
    const chargeId='ch_123456789ABC',intentId='pi_123456789ABC';
    ledger.grantCreatorCycle(owner,'sub_123456789ABC','in_123456789ABC',created,
      created+30*86400000,created,{intentId,chargeId,amount:1900,currency:'usd'});
    const eventId='evt_999999999XYZ';
    inbox.acceptVerified({id:eventId,account,livemode:false,type:'charge.refunded',objectId:chargeId,
      created:Math.floor(created/1000),rawBody:Buffer.from('partial-refund')},created);
    const refund={chargeId,paymentIntentId:intentId,customerId:'cus_123456789ABC',
      amountCaptured:1900,amountRefunded:950,currency:'usd'};
    const reader={currentFor:async()=>({id:chargeId,object:'charge'}),verifyRefundedCharge:async()=>refund};
    expect(await reconcileCreatorRefunds(inbox,reader,customers,ledger,25,()=>created+1))
      .toEqual([{eventId,status:'adjusted'}]);
    expect(await reconcileCreatorRefunds(inbox,reader,customers,ledger,25,()=>created+2)).toEqual([]);
    expect(ledger.usage(owner,created+2)).toMatchObject({available:25,policy:{version:'creator-v1'}});
    const other='evt_888888888888';
    inbox.acceptVerified({id:other,account,livemode:false,type:'charge.refunded',
      objectId:'ch_999999999XYZ',created:Math.floor(created/1000),rawBody:Buffer.from('other')},created+3);
    const otherReader={...reader,verifyRefundedCharge:async()=>({...refund,chargeId:'ch_999999999XYZ',
      customerId:'cus_999999999XYZ'})};
    expect(await reconcileCreatorRefunds(inbox,otherReader,customers,ledger,25,()=>created+4))
      .toEqual([{eventId:other,status:'retry',code:'creator_payment_unbound'}]);
    expect(inbox.pendingOfType('charge.refunded')).toHaveLength(1);
  }finally{await f.close();}
});

it('keeps a refund receipt pending until its paid invoice has been reconciled',async()=>{
  const f=await fixture();
  try{
    const inbox=new BillingEventInbox(f.store,account,false),customers=new BillingCustomers(f.store,account,false),
      ledger=new CreditLedger(f.store),intent=customers.begin(owner,key,created);
    customers.bindCompleted(session(intent.id),created+2000);
    const chargeId='ch_123456789ABC',intentId='pi_123456789ABC',eventId='evt_999999999XYZ';
    inbox.acceptVerified({id:eventId,account,livemode:false,type:'charge.refunded',objectId:chargeId,
      created:Math.floor(created/1000),rawBody:Buffer.from('refund-first')},created);
    const reader={currentFor:async()=>({id:chargeId,object:'charge'}),verifyRefundedCharge:async()=>({
      chargeId,paymentIntentId:intentId,customerId:'cus_123456789ABC',amountCaptured:1900,
      amountRefunded:1900,currency:'usd'
    })};
    expect(await reconcileCreatorRefunds(inbox,reader,customers,ledger,25,()=>created+1))
      .toEqual([{eventId,status:'retry',code:'creator_payment_unbound'}]);
    const invoiceId='in_123456789ABC';
    inbox.acceptVerified({id:'evt_777777777777',account,livemode:false,type:'invoice.paid',objectId:invoiceId,
      created:Math.floor(created/1000),rawBody:Buffer.from('late-invoice')},created+1);
    const invoiceReader={currentFor:async()=>({id:invoiceId,object:'invoice'}),
      verifyCreatorInvoice:async()=>({invoiceId,customerId:'cus_123456789ABC',
        subscriptionId:'sub_123456789ABC',periodStartMs:created,periodEndMs:created+30*86400000,
        paymentIntentId:intentId,chargeId,paidAmount:1900,amountRefunded:1900,currency:'usd'})};
    expect(await reconcileCreatorInvoices(inbox,invoiceReader,customers,ledger,creatorPrice,'prod_123456789ABC'))
      .toEqual([{eventId:'evt_777777777777',status:'granted'}]);
    expect(ledger.usage(owner,created+2)).toMatchObject({available:10,policy:{version:'free-v1'}});
    expect(await reconcileCreatorRefunds(inbox,reader,customers,ledger,25,()=>created+2))
      .toEqual([{eventId,status:'adjusted'}]);
    expect(ledger.usage(owner,created+2)).toMatchObject({available:10,policy:{version:'free-v1'}});
  }finally{await f.close();}
});

it('leaves a failed Checkout reconciliation pending for a corrected provider read',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    const inbox=new BillingEventInbox(f.store,account,false);
    inbox.acceptVerified({id:'evt_222222222222',account,livemode:false,type:'checkout.session.completed',
      objectId:'cs_test_123456789ABC',created:Math.floor(created/1000),rawBody:Buffer.from('checkout')},created);
    const verifyCreatorLineItem=async()=>undefined;
    expect(await reconcileCheckoutBindings(inbox,{currentFor:async()=>session(intent.id,{
      metadata:{product:'contentlayer',intent_id:intent.id}
    }),verifyCreatorLineItem},customers,creatorPrice)).toEqual([{eventId:'evt_222222222222',status:'retry',code:'checkout_session_invalid'}]);
    expect(customers.ownerFor('cus_123456789ABC')).toBeUndefined();
    expect(inbox.pending()).toHaveLength(1);
    expect(await reconcileCheckoutBindings(inbox,{currentFor:async()=>session(intent.id),verifyCreatorLineItem},customers,creatorPrice))
      .toEqual([{eventId:'evt_222222222222',status:'bound'}]);
  }finally{await f.close();}
});

it('lets a valid Checkout proceed behind a retrying shared-account receipt',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    const inbox=new BillingEventInbox(f.store,account,false);
    for(const [id,objectId,at] of [
      ['evt_111111111111','cs_test_111111111111',created],
      ['evt_222222222222','cs_test_222222222222',created+1]
    ] as const)inbox.acceptVerified({id,account,livemode:false,type:'checkout.session.completed',
      objectId,created:Math.floor(created/1000),rawBody:Buffer.from(id)},at);
    const reader={currentFor:async(receipt:{objectId:string})=>session(intent.id,{
      id:receipt.objectId,metadata:receipt.objectId==='cs_test_111111111111'
        ?{product:'contentlayer',intent_id:intent.id}:{product:'agent-recorder',intent_id:intent.id}
    }),verifyCreatorLineItem:async()=>undefined};
    expect((await reconcileCheckoutBindings(inbox,reader,customers,creatorPrice,1))[0]?.status).toBe('retry');
    expect(await reconcileCheckoutBindings(inbox,reader,customers,creatorPrice,1)).toEqual([
      {eventId:'evt_222222222222',status:'bound'}
    ]);
    expect(customers.ownerFor('cus_123456789ABC')).toBe(owner);
    expect(inbox.pendingOfType('checkout.session.completed').map(row=>row.eventId))
      .toEqual(['evt_111111111111']);
  }finally{await f.close();}
});

it('keeps a Checkout receipt pending when its Stripe line item is not the configured price',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false),intent=customers.begin(owner,key,created);
    const inbox=new BillingEventInbox(f.store,account,false);
    inbox.acceptVerified({id:'evt_222222222222',account,livemode:false,type:'checkout.session.completed',
      objectId:'cs_test_123456789ABC',created:Math.floor(created/1000),rawBody:Buffer.from('checkout')},created);
    const currentFor=async()=>session(intent.id);
    const rejectPrice=async()=>{throw new Error('billing_checkout_line_items_invalid');};
    expect(await reconcileCheckoutBindings(inbox,{currentFor,verifyCreatorLineItem:rejectPrice},customers,creatorPrice))
      .toEqual([{eventId:'evt_222222222222',status:'retry',code:'billing_checkout_line_items_invalid'}]);
    expect(customers.ownerFor('cus_123456789ABC')).toBeUndefined();
    expect(inbox.pending()).toHaveLength(1);
  }finally{await f.close();}
});

it('binds checkout retries to the selected plan',async()=>{
  const f=await fixture();
  try{
    const customers=new BillingCustomers(f.store,account,false);
    const intent=customers.begin(owner,key,created,'studio');
    expect(customers.begin(owner,key,created+1,'studio')).toEqual(intent);
    expect(()=>customers.begin(owner,key,created+1,'creator')).toThrow('checkout_plan_conflict');
  }finally{await f.close();}
});
