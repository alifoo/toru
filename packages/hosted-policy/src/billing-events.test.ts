import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {BillingEventInbox,type VerifiedBillingEvent} from './billing-events.js';

const account='acct_123456789ABC',otherAccount='acct_999999999XYZ';
const verified=(id='evt_123456789ABC',created=100):VerifiedBillingEvent=>({
  id,account,livemode:false,type:'invoice.paid',objectId:'in_123456789ABC',created,
  rawBody:Buffer.from(JSON.stringify({id,created,customer:'cus_private',email:'private@example.com'}))
});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'recorder-billing-events-'));
  const path=join(directory,'billing.sqlite');
  const connections:DatabaseSync[]=[];
  const open=(stripeAccount=account,livemode=false)=>{
    const db=new DatabaseSync(path);connections.push(db);
    return new BillingEventInbox({connection:db,transaction:work=>{
      db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}
      catch(error){db.exec('ROLLBACK');throw error;}
    }},stripeAccount,livemode);
  };
  return {open,path,connections,close:async()=>{for(const db of connections)db.close();await rm(directory,{recursive:true,force:true});}};
}

it('persists verified receipts before processing and deduplicates replay across restart',async()=>{
  const f=await fixture();
  try {
    const first=f.open(),event=verified();
    expect(first.acceptVerified(event,200)).toEqual({eventId:event.id,status:'pending',duplicate:false});
    expect(first.acceptVerified(event,201)).toEqual({eventId:event.id,status:'pending',duplicate:true});
    const reopened=f.open();
    expect(reopened.pending()).toEqual([{eventId:event.id,type:'invoice.paid',objectId:event.objectId,created:100}]);
    expect(reopened.processPending(event.id,()=>{},300)).toBe(true);
    expect(reopened.processPending(event.id,()=>{throw new Error('duplicate_applied');},301)).toBe(false);
    expect(first.acceptVerified(event,400)).toEqual({eventId:event.id,status:'processed',duplicate:true});
    expect(reopened.pending()).toEqual([]);
    const db=new DatabaseSync(f.path);
    try {expect(db.prepare('PRAGMA table_info(hosted_billing_events)').all().map(row=>row.name)).not.toContain('body');}
    finally{db.close();}
  }finally{await f.close();}
});

it('rejects a changed event under the same ID and keeps account/mode boundaries',async()=>{
  const f=await fixture();
  try {
    const inbox=f.open(),event=verified();inbox.acceptVerified(event);
    expect(()=>inbox.acceptVerified({...event,rawBody:Buffer.from('changed')})).toThrow('billing_event_id_conflict');
    expect(()=>inbox.acceptVerified({...event,account:otherAccount})).toThrow('billing_account_or_mode_mismatch');
    expect(()=>inbox.acceptVerified({...event,livemode:true})).toThrow('billing_account_or_mode_mismatch');
    expect(()=>inbox.acceptVerified({...event,rawBody:Buffer.alloc(256*1024+1)})).toThrow('billing_event_invalid');
    expect(inbox.pending()).toHaveLength(1);
  }finally{await f.close();}
});

it('does not infer entitlement order from Stripe event timestamps',async()=>{
  const f=await fixture();
  try {
    const inbox=f.open(),later=verified('evt_222222222222',200),earlier=verified('evt_111111111111',100);
    inbox.acceptVerified(later,300);
    inbox.acceptVerified(earlier,301);
    expect(inbox.pending().map(row=>row.eventId)).toEqual([later.id,earlier.id]);
    expect(inbox.processPending(earlier.id,()=>{})).toBe(true);
    expect(inbox.pending().map(row=>row.eventId)).toEqual([later.id]);
  }finally{await f.close();}
});

it('lists only pending receipts for the configured Stripe account and mode',async()=>{
  const f=await fixture();
  try {
    const test=f.open(),other=f.open(otherAccount),live=f.open(account,true);
    const testEvent=verified('evt_111111111111');
    const otherEvent={...verified('evt_222222222222'),account:otherAccount};
    const liveEvent={...verified('evt_333333333333'),livemode:true};
    test.acceptVerified(testEvent,100);
    other.acceptVerified(otherEvent,101);
    live.acceptVerified(liveEvent,102);
    expect(test.pending().map(row=>row.eventId)).toEqual([testEvent.id]);
    expect(other.pending().map(row=>row.eventId)).toEqual([otherEvent.id]);
    expect(live.pending().map(row=>row.eventId)).toEqual([liveEvent.id]);
    expect(test.processPending(otherEvent.id,()=>{})).toBe(false);
    expect(other.pending()).toHaveLength(1);
  }finally{await f.close();}
});

it('rolls back the entitlement write and receipt together, then applies once on retry',async()=>{
  const f=await fixture();
  try {
    const inbox=f.open(),event=verified();
    inbox.acceptVerified(event);
    const db=f.connections[0]!;
    db.exec('CREATE TABLE billing_effects(event_id TEXT PRIMARY KEY) STRICT');
    expect(()=>inbox.processPending(event.id,receipt=>{
      expect(receipt.eventId).toBe(event.id);
      db.prepare('INSERT INTO billing_effects VALUES (?)').run(event.id);
      throw new Error('entitlement_failed');
    })).toThrow('entitlement_failed');
    expect(inbox.pending()).toHaveLength(1);
    expect(db.prepare('SELECT count(*) total FROM billing_effects').get()?.total).toBe(0);
    expect(inbox.processPending(event.id,()=>{
      db.prepare('INSERT INTO billing_effects VALUES (?)').run(event.id);
    })).toBe(true);
    expect(inbox.processPending(event.id,()=>{throw new Error('duplicate_applied');})).toBe(false);
    expect(db.prepare('SELECT count(*) total FROM billing_effects').get()?.total).toBe(1);
    expect(inbox.pending()).toEqual([]);
  }finally{await f.close();}
});

it('rotates failed receipts behind untried events across process restarts',async()=>{
  const f=await fixture();
  try{
    const inbox=f.open();
    const first=verified('evt_111111111111'),second=verified('evt_222222222222'),
      third=verified('evt_333333333333');
    inbox.acceptVerified(first,100);
    inbox.acceptVerified(second,101);
    inbox.acceptVerified(third,102);
    expect(inbox.pendingOfType('invoice.paid',1)[0]?.eventId).toBe(first.id);
    expect(inbox.deferPending(first.id)).toBe(true);
    const reopened=f.open();
    expect(reopened.pendingOfType('invoice.paid',2).map(row=>row.eventId)).toEqual([second.id,third.id]);
    expect(reopened.deferPending(second.id)).toBe(true);
    expect(reopened.deferPending(third.id)).toBe(true);
    expect(reopened.pendingOfType('invoice.paid',2).map(row=>row.eventId)).toEqual([first.id,second.id]);
    expect(reopened.processPending(first.id,()=>{})).toBe(true);
    expect(reopened.deferPending(first.id)).toBe(false);
  }finally{await f.close();}
});

it('upgrades the existing billing inbox without losing pending receipts',async()=>{
  const f=await fixture();
  try{
    const inbox=f.open(),event=verified();
    inbox.acceptVerified(event,100);
    const db=f.connections[0]!;
    db.exec('DROP INDEX hosted_billing_retry_order');
    db.exec('ALTER TABLE hosted_billing_events DROP COLUMN last_attempt_seq');
    db.exec('UPDATE hosted_billing_schema SET version=1 WHERE singleton=1');
    const upgraded=f.open();
    expect(upgraded.pendingOfType('invoice.paid')).toEqual([{
      eventId:event.id,type:event.type,objectId:event.objectId,created:event.created
    }]);
    expect(db.prepare('SELECT version FROM hosted_billing_schema').get()?.version).toBe(2);
  }finally{await f.close();}
});
