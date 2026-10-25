import type {IncomingMessage,ServerResponse} from 'node:http';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingEventInbox,maximumBillingBodyBytes} from '@agent-recorder/hosted-policy/dist/billing-events.js';
import {verifyStripeSnapshotEvent,type StripeWebhookConfig} from '@agent-recorder/hosted-policy/dist/stripe-webhook.js';

function response(res:ServerResponse,status:number){
  res.writeHead(status,{'cache-control':'private, no-store'});
  res.end();
}

export function stripeWebhookConfigFromEnvironment(env:NodeJS.ProcessEnv):StripeWebhookConfig|undefined {
  const account=env.HOSTED_STRIPE_ACCOUNT_ID;
  const mode=env.HOSTED_STRIPE_LIVEMODE;
  const secrets=env.HOSTED_STRIPE_WEBHOOK_SECRETS;
  if(account===undefined&&mode===undefined&&secrets===undefined)return undefined;
  if(!account||!/^acct_[A-Za-z0-9]{8,128}$/.test(account)||!['true','false'].includes(mode??'')||!secrets)
    throw new Error('billing_webhook_config_invalid');
  const configured=secrets.split(',').map(value=>value.trim());
  if(configured.length<1||configured.length>2||configured.some(value=>!/^whsec_[A-Za-z0-9_-]{8,}$/.test(value)))
    throw new Error('billing_webhook_config_invalid');
  return {account,livemode:mode==='true',secrets:configured};
}

async function readRawBody(request:IncomingMessage):Promise<Buffer>{
  const chunks:Buffer[]=[];
  let length=0;
  for await(const chunk of request){
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    length+=buffer.length;
    if(length>maximumBillingBodyBytes)throw new Error('billing_request_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks,length);
}

/** Disabled unless all Stripe settings are present. Persists receipts, never entitlements. */
export function createStripeWebhookHandler(dataDir:string,config:StripeWebhookConfig){
  return async(request:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(url.pathname!=='/webhooks/stripe')return false;
    if(request.method!=='POST'){response(res,405);return true;}
    if(request.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){
      response(res,415);return true;
    }
    const signature=request.headers['stripe-signature'];
    if(typeof signature!=='string'){response(res,400);return true;}
    let body:Buffer;
    try{body=await readRawBody(request);}
    catch(error){response(res,error instanceof Error&&error.message==='billing_request_too_large'?413:503);return true;}
    let event;
    try{event=verifyStripeSnapshotEvent(body,signature,config);}
    catch{response(res,400);return true;}
    try{
      await withRecorderStore(dataDir,db=>new BillingEventInbox(db,config.account,config.livemode).acceptVerified(event));
      response(res,200);
    }catch{
      // Do not acknowledge a receipt that SQLite failed to commit; Stripe retries.
      response(res,503);
    }
    return true;
  };
}
