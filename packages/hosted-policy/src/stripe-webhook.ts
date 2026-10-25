import {createHmac,timingSafeEqual} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {maximumBillingBodyBytes,type VerifiedBillingEvent} from './billing-events.js';

export type StripeWebhookConfig={account:string;livemode:boolean;secrets:readonly string[]};
const accountId=/^acct_[A-Za-z0-9]{8,128}$/;
const eventId=/^evt_[A-Za-z0-9]{8,128}$/;
const objectId=/^[a-z][a-z0-9]*_[A-Za-z0-9_]{8,160}$/;
const eventType=/^[a-z][a-z0-9_.]{2,100}$/;
const hexSignature=/^[a-f0-9]{64}$/i;

/** Verify Stripe's v1 signature over the unchanged bytes before parsing an event. */
export function verifyStripeSnapshotEvent(
  rawBody:Buffer,header:string,config:StripeWebhookConfig,now=Date.now()
):VerifiedBillingEvent {
  if(!accountId.test(config.account)||typeof config.livemode!=='boolean'||
    !Array.isArray(config.secrets)||config.secrets.length<1||config.secrets.length>2||
    config.secrets.some(secret=>typeof secret!=='string'||!/^whsec_[A-Za-z0-9_-]{8,}$/.test(secret)))
    throw new Error('billing_webhook_config_invalid');
  if(!Buffer.isBuffer(rawBody)||rawBody.length===0||rawBody.length>maximumBillingBodyBytes||
    typeof header!=='string'||header.length===0||header.length>8192||!Number.isSafeInteger(now)||now<0)
    throw new Error('billing_webhook_invalid');
  let timestamp:string|undefined;
  const signatures:Buffer[]=[];
  for(const part of header.split(',')){
    const equals=part.indexOf('=');
    if(equals<0)continue;
    const key=part.slice(0,equals).trim(),value=part.slice(equals+1).trim();
    if(key==='t'){
      if(timestamp!==undefined)throw new Error('billing_signature_invalid');
      timestamp=value;
    }else if(key==='v1'&&hexSignature.test(value))signatures.push(Buffer.from(value,'hex'));
  }
  if(!timestamp||!/^\d{1,16}$/.test(timestamp)||signatures.length===0||signatures.length>8)
    throw new Error('billing_signature_invalid');
  const signed=Buffer.concat([Buffer.from(`${timestamp}.`),rawBody]);
  let valid=false;
  for(const secret of config.secrets){
    const expected=createHmac('sha256',secret).update(signed).digest();
    for(const signature of signatures)valid=timingSafeEqual(expected,signature)||valid;
  }
  const seconds=Number(timestamp);
  if(!valid||!Number.isSafeInteger(seconds)||Math.abs(now/1000-seconds)>300)
    throw new Error('billing_signature_invalid');
  let parsed:unknown;
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody));}
  catch{throw new Error('billing_event_invalid');}
  if(!parsed||typeof parsed!=='object')throw new Error('billing_event_invalid');
  const event=parsed as Record<string,unknown>;
  const data=event.data&&typeof event.data==='object'?event.data as Record<string,unknown>:undefined;
  const object=data?.object&&typeof data.object==='object'?data.object as Record<string,unknown>:undefined;
  if(event.object!=='event'||typeof event.id!=='string'||!eventId.test(event.id)||
    typeof event.type!=='string'||!eventType.test(event.type)||
    typeof event.created!=='number'||!Number.isSafeInteger(event.created)||event.created<0||
    typeof event.livemode!=='boolean'||event.livemode!==config.livemode||
    (event.account!==undefined&&event.account!==null&&event.account!==config.account)||
    typeof object?.id!=='string'||!objectId.test(object.id))
    throw new Error('billing_event_invalid');
  return {id:event.id,account:config.account,livemode:event.livemode,type:event.type,
    objectId:object.id,created:event.created,rawBody};
}
