import {createHmac} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingEventInbox} from '@agent-recorder/hosted-policy/dist/billing-events.js';
import {createStripeWebhookHandler,stripeWebhookConfigFromEnvironment} from '../dist/billing-webhook.js';

const secret='whsec_syntheticOnly123456789';
const account='acct_123456789ABC';
const config={account,livemode:false,secrets:[secret]};
const event={id:'evt_123456789ABC',object:'event',created:Math.floor(Date.now()/1000),
  livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_test_123456789ABC'}}};
const body=Buffer.from(JSON.stringify(event));
const signature=()=>{
  const timestamp=Math.floor(Date.now()/1000);
  const digest=createHmac('sha256',secret).update(Buffer.concat([Buffer.from(`${timestamp}.`),body])).digest('hex');
  return `t=${timestamp},v1=${digest}`;
};
function request(payload=body,headers={}){
  const stream=Readable.from([payload]);
  stream.method='POST';
  stream.headers={'content-type':'application/json','stripe-signature':signature(),...headers};
  return stream;
}
function reply(){return {status:0,ended:false,writeHead(status){this.status=status;return this;},end(){this.ended=true;}};}

test('webhook is opt-in and rejects incomplete configuration',()=>{
  assert.equal(stripeWebhookConfigFromEnvironment({}),undefined);
  assert.throws(()=>stripeWebhookConfigFromEnvironment({HOSTED_STRIPE_ACCOUNT_ID:account}),/billing_webhook_config_invalid/);
  assert.deepEqual(stripeWebhookConfigFromEnvironment({HOSTED_STRIPE_ACCOUNT_ID:account,
    HOSTED_STRIPE_LIVEMODE:'false',HOSTED_STRIPE_WEBHOOK_SECRETS:secret}),config);
});

test('verified webhook commits one durable receipt before acknowledging duplicates',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'recorder-stripe-webhook-'));
  try{
    const handler=createStripeWebhookHandler(dataDir,config);
    const url=new URL('https://recorder.example/webhooks/stripe');
    const first=reply();
    assert.equal(await handler(request(),first,url),true);
    assert.equal(first.status,200);
    const duplicate=reply();
    await handler(request(),duplicate,url);
    assert.equal(duplicate.status,200);
    const pending=await withRecorderStore(dataDir,db=>new BillingEventInbox(db,account,false).pending());
    assert.deepEqual(pending,[{eventId:event.id,type:event.type,objectId:event.data.object.id,created:event.created}]);
    const forged=reply();
    await handler(request(Buffer.from(`${body.toString()} `)),forged,url);
    assert.equal(forged.status,400);
    const oversized=reply();
    await handler(request(Buffer.alloc(256*1024+1)),oversized,url);
    assert.equal(oversized.status,413);
    await writeFile(join(dataDir,'not-a-directory'),'blocked');
    const unavailable=reply();
    await createStripeWebhookHandler(join(dataDir,'not-a-directory'),config)(request(),unavailable,url);
    assert.equal(unavailable.status,503);
    const unrelated=reply();
    assert.equal(await handler(request(),unrelated,new URL('https://recorder.example/healthz')),false);
    assert.equal(unrelated.ended,false);
    const after=await withRecorderStore(dataDir,db=>new BillingEventInbox(db,account,false).pending());
    assert.deepEqual(after,pending);
  }finally{await rm(dataDir,{recursive:true,force:true});}
});
