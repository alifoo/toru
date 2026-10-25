import {timingSafeEqual} from 'node:crypto';
import {stat} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {join} from 'node:path';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {StripeCheckoutClient,type StripeCheckoutConfig,type StripePack} from '@agent-recorder/hosted-policy/dist/stripe-checkout.js';
import {creditPacks,isPackId} from '@agent-recorder/hosted-policy/dist/packs.js';

type CheckoutConfig={adminKey:string;stripe:StripeCheckoutConfig};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function answer(res:ServerResponse,status:number,body:Record<string,unknown>){
  res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store'});
  res.end(JSON.stringify(body));
}

export function stripeCheckoutConfigFromEnvironment(env:NodeJS.ProcessEnv):CheckoutConfig|undefined{
  if(env.HOSTED_CHECKOUT_MODE===undefined)return undefined;
  const live=env.HOSTED_CHECKOUT_MODE==='live';
  if(!['test','live'].includes(env.HOSTED_CHECKOUT_MODE)||
    (live?env.RECORDER_ENVIRONMENT!=='production':!['local','staging'].includes(env.RECORDER_ENVIRONMENT??''))||
    env.HOSTED_STRIPE_LIVEMODE!==String(live)||!env.INVITE_ADMIN_KEY||
    !env.HOSTED_STRIPE_ACCOUNT_ID||!env.HOSTED_STRIPE_SECRET_KEY||
    !env.HOSTED_STRIPE_CREATOR_PRICE_ID||!env.HOSTED_STRIPE_CREATOR_PRODUCT_ID||
    !env.HOSTED_STRIPE_CREATOR_AMOUNT_MINOR||!env.HOSTED_CHECKOUT_RETURN_ORIGIN||
    (live&&!env.HOSTED_STRIPE_PORTAL_CONFIGURATION_ID))
    throw new Error('checkout_config_invalid');
  const stripe:StripeCheckoutConfig={
    account:env.HOSTED_STRIPE_ACCOUNT_ID,livemode:live,secretKey:env.HOSTED_STRIPE_SECRET_KEY,
    priceId:env.HOSTED_STRIPE_CREATOR_PRICE_ID,productId:env.HOSTED_STRIPE_CREATOR_PRODUCT_ID,
    amountMinor:Number(env.HOSTED_STRIPE_CREATOR_AMOUNT_MINOR),currency:'usd',
    returnOrigin:env.HOSTED_CHECKOUT_RETURN_ORIGIN,
    ...(env.HOSTED_STRIPE_PORTAL_CONFIGURATION_ID
      ?{portalConfigurationId:env.HOSTED_STRIPE_PORTAL_CONFIGURATION_ID}:{})
  };
  if(env.HOSTED_STRIPE_STUDIO_PRICE_ID){
    stripe.additionalPlans=[{priceId:env.HOSTED_STRIPE_STUDIO_PRICE_ID,productId:env.HOSTED_STRIPE_STUDIO_PRODUCT_ID??'',amountMinor:4900,policyVersion:'studio-v1'}];
    new StripeCheckoutClient({...stripe,...stripe.additionalPlans[0]});
  }
  if(env.HOSTED_STRIPE_PACKS){
    // Feature flag for credit packs: a JSON list of {id, priceId, productId}; credits and amounts come from the catalogue.
    let listed:unknown;
    try{listed=JSON.parse(env.HOSTED_STRIPE_PACKS);}catch{throw new Error('checkout_config_invalid');}
    if(!Array.isArray(listed))throw new Error('checkout_config_invalid');
    stripe.packs=listed.map((entry):StripePack=>{
      const value=entry as Record<string,unknown>;
      const pack=creditPacks.find(p=>p.id===value.id);
      if(!pack||typeof value.priceId!=='string'||typeof value.productId!=='string')throw new Error('checkout_config_invalid');
      return {id:pack.id,priceId:value.priceId,productId:value.productId,amountMinor:pack.amountMinor,credits:pack.credits};
    });
  }
  // Constructor validates all provider identifiers and the HTTPS return origin at startup.
  new StripeCheckoutClient(stripe);
  return {adminKey:env.INVITE_ADMIN_KEY,stripe};
}

async function body(request:IncomingMessage):Promise<unknown>{
  const length=Number(request.headers['content-length']??0);
  if(Number.isFinite(length)&&length>1024)throw new Error('checkout_request_too_large');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of request){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;if(size>1024)throw new Error('checkout_request_too_large');
    chunks.push(bytes);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new Error('checkout_request_invalid');}
}

/** Creates a Stripe Session; only verified paid invoices can grant an entitlement. */
export function createStripeCheckoutHandler(
  dataDir:string,config:CheckoutConfig,
  client:Pick<StripeCheckoutClient,'createCreatorSession'|'createPackSession'>=new StripeCheckoutClient(config.stripe)
){
  return async(request:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(url.pathname!=='/admin/billing/checkout')return false;
    if(request.method!=='POST'){answer(res,405,{error:'method_not_allowed'});return true;}
    const provided=request.headers.authorization?.startsWith('Bearer ')
      ?request.headers.authorization.slice(7).trim():'';
    const left=Buffer.from(provided),right=Buffer.from(config.adminKey);
    if(!provided||left.length!==right.length||!timingSafeEqual(left,right)){
      answer(res,404,{error:'not_found'});return true;
    }
    if(request.headers.origin!==undefined&&request.headers.origin!==url.origin){
      answer(res,403,{error:'origin_forbidden'});return true;
    }
    if(request.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){
      answer(res,415,{error:'json_required'});return true;
    }
    let input:unknown;
    try{input=await body(request);}
    catch(error){const code=error instanceof Error?error.message:'';
      answer(res,code==='checkout_request_too_large'?413:400,{error:code==='checkout_request_too_large'?code:'checkout_request_invalid'});
      return true;
    }
    if(!input||typeof input!=='object'||Array.isArray(input)){
      answer(res,400,{error:'checkout_request_invalid'});return true;
    }
    const {owner,requestId,plan='creator'}=input as Record<string,unknown>;
    if(!['creator','studio'].includes(String(plan))&&!isPackId(plan)){answer(res,400,{error:'checkout_plan_invalid'});return true;}
    const pack=isPackId(plan)?config.stripe.packs?.find(p=>p.id===plan):undefined;
    if(isPackId(plan)&&!pack){answer(res,503,{error:'packs_unavailable'});return true;}
    const selected=plan==='studio'?config.stripe.additionalPlans?.find(p=>p.policyVersion==='studio-v1'):undefined;
    if(plan==='studio'&&!selected){answer(res,503,{error:'checkout_unavailable'});return true;}
    if(typeof owner!=='string'||!uuid.test(owner)||typeof requestId!=='string'||!uuid.test(requestId)){
      answer(res,400,{error:'checkout_request_invalid'});return true;
    }
    try{
      if(process.env.HOSTED_BETA_CAPACITY==='0')throw new Error('admissions_paused');
      try{await stat(join(dataDir,'paused'));throw new Error('admissions_paused');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const intent=await withRecorderStore(dataDir,db=>new BillingCustomers(db,config.stripe.account,config.stripe.livemode)
        .begin(owner,requestId,Date.now(),String(plan)));
      const session=pack
        ?await client.createPackSession(intent,pack,Date.now(),await withRecorderStore(dataDir,db=>new BillingCustomers(db,config.stripe.account,config.stripe.livemode).customerForOwner(owner)))
        :await (selected?new StripeCheckoutClient({...config.stripe,...selected}):client).createCreatorSession(intent);
      await withRecorderStore(dataDir,db=>new BillingCustomers(db,config.stripe.account,config.stripe.livemode)
        .recordCreated(intent,session.id));
      answer(res,201,session);
    }catch(error){
      const code=error instanceof Error?error.message:'';
      if(['checkout_owner_not_admitted','checkout_existing_customer','checkout_intent_active','checkout_intent_expired','checkout_intent_expiring','checkout_plan_conflict'].includes(code))
        answer(res,code==='checkout_owner_not_admitted'?403:409,{error:code});
      else if(code==='admissions_paused')answer(res,503,{error:code});
      else answer(res,503,{error:'checkout_unavailable'});
    }
    return true;
  };
}
