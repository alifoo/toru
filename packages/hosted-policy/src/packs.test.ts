import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {openRecorderStore} from '@agent-recorder/mcp/store/open';
import {CreditLedger} from './index.js';
import {BillingCustomers} from './billing-customers.js';
import {BillingEventInbox} from './billing-events.js';
import {reconcilePackPurchases} from './stripe-reconcile.js';
import {creditPacks,isPackId} from './packs.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const c of cleanups.splice(0))await c();});
async function db(){
 const dir=await mkdtemp(join(tmpdir(),'packs-'));const store=await openRecorderStore(dir);
 cleanups.push(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 return store;
}
const payment={intentId:'pi_123456789ABC',chargeId:'ch_123456789ABC',amount:1350,currency:'usd'};
it('catalogue has placeholder prices and ids',()=>{
 expect(creditPacks.map(p=>[p.id,p.credits,p.amountMinor])).toEqual([['pack-1',1,90],['pack-15',15,1350],['pack-30',30,2700]]);
 expect(isPackId('pack-15')).toBe(true);expect(isPackId('creator')).toBe(false);
});
it('grants a pack once per payment, never expiring, drawn after free credits',async()=>{
 const store=await db(),owner=randomUUID(),now=Date.UTC(2026,9,7);
 store.connection.prepare("INSERT INTO accounts(owner,created_at,admission_status) VALUES (?,?,'admitted')").run(owner,now);
 const ledger=new CreditLedger(store);
 const first=ledger.grantPack(owner,'pack-15',15,payment,now);
 expect(first).toMatchObject({credits:15,alreadyGranted:false});
 expect(ledger.grantPack(owner,'pack-15',15,payment,now+1)).toEqual({...first,alreadyGranted:true});
 expect(()=>ledger.grantPack(owner,'pack-30',30,payment,now)).toThrow('pack_payment_conflict');
 expect(()=>ledger.grantPack(owner,'pack-1',1,{...payment,intentId:'pi_other123456'},now)).toThrow('pack_payment_conflict');
 const usage=ledger.usage(owner,now);
 expect(usage.available).toBe(25);
 // Free credits are consumed before the pack.
 const reservation=ledger.reserve(owner,randomUUID(),randomUUID(),'a'.repeat(64),now);
 const bucket=store.connection.prepare('SELECT source FROM credit_buckets WHERE id=?').get(reservation.bucketId)!;
 expect(bucket.source).toBe('free');
 expect(ledger.usage(owner,Date.UTC(2027,3,1)).available).toBe(25);
});
it('subscribers can open a pack checkout and the pack is granted by reconciliation exactly once',async()=>{
 const store=await db(),owner=randomUUID(),now=1_800_000_000_000;
 store.connection.prepare("INSERT INTO accounts(owner,created_at,admission_status) VALUES (?,?,'admitted')").run(owner,now);
 const customers=new BillingCustomers(store,'acct_123456789ABC',false);
 store.connection.prepare('INSERT INTO hosted_billing_customers VALUES (?,?,?,?,?)').run('acct_123456789ABC',0,'cus_123456789ABC',owner,now);
 expect(()=>customers.begin(owner,randomUUID(),now,'creator')).toThrow('checkout_existing_customer');
 const intent=customers.begin(owner,randomUUID(),now,'pack-15');
 expect(customers.packForIntent(intent.id)).toMatchObject({owner,pack:'pack-15'});
 customers.recordCreated(intent,'cs_test_123456789ABC',now);
 const inbox=new BillingEventInbox(store,'acct_123456789ABC',false),ledger=new CreditLedger(store);
 inbox.acceptVerified({id:'evt_123456789ABC',account:'acct_123456789ABC',livemode:false,type:'checkout.session.completed',objectId:'cs_test_123456789ABC',created:Math.floor(now/1000)+10,rawBody:Buffer.from('{}')});
 const session={id:'cs_test_123456789ABC',object:'checkout.session',livemode:false,mode:'payment',status:'complete',payment_status:'paid',client_reference_id:intent.id,created:Math.floor(now/1000)+5,payment_intent:'pi_123456789ABC',metadata:{product:'agent-recorder',intent_id:intent.id,pack:'pack-15'}};
 const reader={currentFor:async()=>session,verifyPackPayment:async()=>({paymentIntentId:'pi_123456789ABC',chargeId:'ch_123456789ABC',amount:1350,currency:'usd'})};
 const packs=[{id:'pack-15',priceId:'price_123456789ABC',productId:'prod_123456789ABC',amountMinor:1350,credits:15}];
 expect(await reconcilePackPurchases(inbox,reader,customers,ledger,packs)).toEqual([{eventId:'evt_123456789ABC',status:'granted'}]);
 expect(ledger.usage(owner,now).available).toBe(15+10);
 expect(await reconcilePackPurchases(inbox,reader,customers,ledger,packs)).toEqual([]);
 expect(ledger.usage(owner,now).available).toBe(25);
 // Without configured packs nothing is granted and the receipt stays pending.
 expect(await reconcilePackPurchases(inbox,reader,customers,ledger,[])).toEqual([]);
});
