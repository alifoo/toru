import {createHmac} from 'node:crypto';
import {expect,it} from 'vitest';
import {verifyStripeSnapshotEvent,type StripeWebhookConfig} from './stripe-webhook.js';

const secret='whsec_syntheticOnly123456789';
const oldSecret='whsec_oldSynthetic123456789';
const now=1_800_000_000_000;
const timestamp=String(now/1000);
const config:StripeWebhookConfig={account:'acct_123456789ABC',livemode:false,secrets:[secret]};
const event={id:'evt_123456789ABC',object:'event',created:1_799_999_900,livemode:false,
  type:'checkout.session.completed',data:{object:{id:'cs_test_123456789ABC'}}};
const body=Buffer.from(JSON.stringify(event));
const sign=(value:Buffer,key=secret,time=timestamp)=>
  createHmac('sha256',key).update(Buffer.concat([Buffer.from(`${time}.`),value])).digest('hex');

it('verifies unchanged bytes, mode and account before accepting a snapshot event',()=>{
  const header=`t=${timestamp},v1=${sign(body)}`;
  expect(verifyStripeSnapshotEvent(body,header,config,now)).toMatchObject({
    id:event.id,type:event.type,objectId:event.data.object.id,account:config.account,livemode:false,rawBody:body
  });
  expect(()=>verifyStripeSnapshotEvent(Buffer.from(`${body.toString()} `),header,config,now)).toThrow('billing_signature_invalid');
  expect(()=>verifyStripeSnapshotEvent(body,`t=${timestamp},v0=${sign(body)}`,config,now)).toThrow('billing_signature_invalid');
  expect(()=>verifyStripeSnapshotEvent(body,`t=${timestamp},v1=${sign(body)}`,config,now+301_000)).toThrow('billing_signature_invalid');
  expect(()=>verifyStripeSnapshotEvent(body,`t=${timestamp},v1=${sign(body)}`,config,now-301_000)).toThrow('billing_signature_invalid');
  expect(()=>verifyStripeSnapshotEvent(body,header,{...config,livemode:true},now)).toThrow('billing_event_invalid');
  const other=Buffer.from(JSON.stringify({...event,account:'acct_999999999XYZ'}));
  expect(()=>verifyStripeSnapshotEvent(other,`t=${timestamp},v1=${sign(other)}`,config,now)).toThrow('billing_event_invalid');
});

it('accepts either active secret during rotation and rejects malformed signed JSON',()=>{
  const header=`t=${timestamp},v1=${sign(body,oldSecret)},v1=${sign(body)}`;
  expect(verifyStripeSnapshotEvent(body,header,{...config,secrets:[oldSecret,secret]},now).id).toBe(event.id);
  expect(()=>verifyStripeSnapshotEvent(body,`t=${timestamp},v1=${sign(body,oldSecret)}`,config,now)).toThrow('billing_signature_invalid');
  const malformed=Buffer.from('{not-json');
  expect(()=>verifyStripeSnapshotEvent(malformed,`t=${timestamp},v1=${sign(malformed)}`,config,now)).toThrow('billing_event_invalid');
});
