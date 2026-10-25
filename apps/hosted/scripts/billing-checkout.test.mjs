import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {createStripeCheckoutHandler,stripeCheckoutConfigFromEnvironment} from '../dist/billing-checkout.js';

const owner='11111111-1111-4111-8111-111111111111';
const requestId='22222222-2222-4222-8222-222222222222';
const adminKey='synthetic-admin-key-123456789';
const env={HOSTED_CHECKOUT_MODE:'test',RECORDER_ENVIRONMENT:'staging',HOSTED_STRIPE_LIVEMODE:'false',
  INVITE_ADMIN_KEY:adminKey,HOSTED_STRIPE_ACCOUNT_ID:'acct_123456789ABC',
  HOSTED_STRIPE_SECRET_KEY:'sk_test_123456789ABC',HOSTED_STRIPE_CREATOR_PRICE_ID:'price_123456789ABC',
  HOSTED_STRIPE_CREATOR_PRODUCT_ID:'prod_123456789ABC',HOSTED_STRIPE_CREATOR_AMOUNT_MINOR:'1900',
  HOSTED_CHECKOUT_RETURN_ORIGIN:'https://recorder.example.com/'};
const url=new URL('https://recorder.example/admin/billing/checkout');

function request(value={owner,requestId},headers={}){
  const input=Readable.from([Buffer.from(JSON.stringify(value))]);
  input.method='POST';input.headers={authorization:`Bearer ${adminKey}`,'content-type':'application/json',...headers};
  return input;
}
function reply(){return {status:0,body:'',writeHead(status){this.status=status;return this;},end(body=''){this.body=body;}};}

test('checkout route stays absent by default and requires matching environment, mode and key',()=>{
  assert.equal(stripeCheckoutConfigFromEnvironment({}),undefined);
  assert.throws(()=>stripeCheckoutConfigFromEnvironment({...env,RECORDER_ENVIRONMENT:'production'}),/checkout_config_invalid/);
  assert.throws(()=>stripeCheckoutConfigFromEnvironment({...env,HOSTED_STRIPE_LIVEMODE:'true'}),/checkout_config_invalid/);
  assert.equal(stripeCheckoutConfigFromEnvironment(env).stripe.amountMinor,1900);
  const live={...env,HOSTED_CHECKOUT_MODE:'live',RECORDER_ENVIRONMENT:'production',
    HOSTED_STRIPE_LIVEMODE:'true',HOSTED_STRIPE_SECRET_KEY:'sk_live_123456789ABC',
    HOSTED_STRIPE_PORTAL_CONFIGURATION_ID:'bpc_123456789ABC'};
  assert.equal(stripeCheckoutConfigFromEnvironment(live).stripe.livemode,true);
  assert.throws(()=>stripeCheckoutConfigFromEnvironment({...live,HOSTED_STRIPE_SECRET_KEY:env.HOSTED_STRIPE_SECRET_KEY}),/checkout_config_invalid/);
});

test('admin checkout route reuses one durable intent and refuses a second active purchase',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recorder-checkout-route-'));
  try{
    await withRecorderStore(dir,db=>db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)')
      .run(owner,Date.now()));
    const seen=[];
    const client={createCreatorSession:async(intent)=>{
      seen.push(intent.id);
      return {id:'cs_test_123456789ABC',url:'https://checkout.stripe.com/c/pay/cs_test_123456789ABC'};
    }};
    const handler=createStripeCheckoutHandler(dir,stripeCheckoutConfigFromEnvironment(env),client);
    const forbidden=reply();await handler(request({owner,requestId},{authorization:'Bearer wrong'}),forbidden,url);
    assert.equal(forbidden.status,404);assert.equal(seen.length,0);
    const crossOrigin=reply();await handler(request({owner,requestId},{origin:'https://attacker.example'}),crossOrigin,url);
    assert.equal(crossOrigin.status,403);assert.equal(seen.length,0);
    const oversized=reply();await handler(request({owner,requestId,padding:'x'.repeat(1100)}),oversized,url);
    assert.equal(oversized.status,413);assert.equal(seen.length,0);
    const first=reply();await handler(request(),first,url);
    assert.equal(first.status,201);assert.equal(JSON.parse(first.body).id,'cs_test_123456789ABC');
    assert.equal(await withRecorderStore(dir,db=>db.connection.prepare(
      'SELECT session_id FROM hosted_checkout_created_sessions WHERE intent_id=?').get(seen[0])?.session_id),
    'cs_test_123456789ABC');
    const retry=reply();await handler(request(),retry,url);
    assert.equal(retry.status,201);assert.deepEqual(seen,[seen[0],seen[0]]);
    const competing=reply();await handler(request({owner,requestId:'33333333-3333-4333-8333-333333333333'}),competing,url);
    assert.equal(competing.status,409);assert.equal(JSON.parse(competing.body).error,'checkout_intent_active');
    assert.equal(seen.length,2);
    await withRecorderStore(dir,db=>db.connection.prepare('UPDATE hosted_checkout_intents SET expires_at=0 WHERE owner=?')
      .run(owner));
    const expired=reply();await handler(request(),expired,url);
    assert.equal(expired.status,409);assert.equal(JSON.parse(expired.body).error,'checkout_intent_expired');
    assert.equal(seen.length,2);
    await writeFile(join(dir,'paused'),'paused');
    const paused=reply();await handler(request({owner,requestId:'44444444-4444-4444-8444-444444444444'}),paused,url);
    assert.equal(paused.status,503);assert.equal(JSON.parse(paused.body).error,'admissions_paused');
    assert.equal(seen.length,2);
    const unsupported=reply();assert.equal(await handler(request(),unsupported,new URL('https://recorder.example/healthz')),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
