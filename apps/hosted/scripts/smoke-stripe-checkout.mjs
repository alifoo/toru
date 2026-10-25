/** Provider smoke: test-mode Checkout creation and expiry, without a payment. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {closeOpenCheckoutsForDeletion} from '@agent-recorder/hosted-policy/dist/billing-checkout-close.js';
import {StripeCheckoutClient} from '@agent-recorder/hosted-policy/dist/stripe-checkout.js';
import {StripeCheckoutCloser} from '@agent-recorder/hosted-policy/dist/stripe-checkout-close.js';

const key=process.env.HOSTED_STRIPE_SECRET_KEY;
const account=process.env.HOSTED_STRIPE_ACCOUNT_ID;
const priceId=process.env.HOSTED_STRIPE_CREATOR_PRICE_ID;
const productId=process.env.HOSTED_STRIPE_CREATOR_PRODUCT_ID;
if(!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key??'')||!account||!priceId||!productId||
  process.env.HOSTED_STRIPE_LIVEMODE!=='false')
  throw new Error('checkout_test_full_api_key_required');

const directory=await mkdtemp(join(tmpdir(),'recorder-stripe-sandbox-'));
const owner=randomUUID(),requestId=randomUUID();
const closer=new StripeCheckoutCloser({account,livemode:false,secretKey:key});
let session, intent;
try{
  intent=await withRecorderStore(directory,db=>{
    db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
    return new BillingCustomers(db,account,false).begin(owner,requestId);
  });
  const client=new StripeCheckoutClient({account,livemode:false,secretKey:key,
    priceId,productId,amountMinor:1900,currency:'usd',returnOrigin:'https://recorder.example.com/'});
  session=await client.createCreatorSession(intent);
  await withRecorderStore(directory,db=>new BillingCustomers(db,account,false).recordCreated(intent,session.id));
  const first=await withRecorderStore(directory,db=>closeOpenCheckoutsForDeletion(
    new BillingCustomers(db,account,false),closer,owner));
  const second=await withRecorderStore(directory,db=>closeOpenCheckoutsForDeletion(
    new BillingCustomers(db,account,false),closer,owner));
  const local=await withRecorderStore(directory,db=>db.connection.prepare(`SELECT s.expired_at,
    (SELECT count(*) FROM hosted_checkout_sessions WHERE intent_id=s.intent_id) completed
    FROM hosted_checkout_created_sessions s WHERE s.session_id=?`).get(session.id));
  assert.equal(first,1);assert.equal(second,0);
  assert.ok(Number.isSafeInteger(local?.expired_at)&&local.expired_at>0);
  assert.equal(local.completed,0);
  console.log(JSON.stringify({mode:'test',account,sessionId:session.id,created:1,expired:1,
    repeatedClosure:0,paidCredits:0}));
}catch(error){
  if(session&&intent)await closer.expireForDeletion(session.id,intent.id).catch(()=>undefined);
  throw error;
}finally{await rm(directory,{recursive:true,force:true});}
