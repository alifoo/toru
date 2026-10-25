import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {StripePortalClient} from '@agent-recorder/hosted-policy/dist/stripe-portal.js';
import type {StripeCheckoutConfig} from '@agent-recorder/hosted-policy/dist/stripe-checkout.js';

const ownerId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function answer(res:ServerResponse,status:number,body:Record<string,unknown>){
  res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store'});
  res.end(JSON.stringify(body));
}

export function createStripePortalHandler(dataDir:string,adminKey:string,stripe:StripeCheckoutConfig,
  client:Pick<StripePortalClient,'create'>=new StripePortalClient(stripe)){
  return async(request:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(url.pathname!=='/admin/billing/portal')return false;
    if(request.method!=='POST'){answer(res,405,{error:'method_not_allowed'});return true;}
    const provided=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7).trim():'';
    const left=Buffer.from(provided),right=Buffer.from(adminKey);
    if(!provided||left.length!==right.length||!timingSafeEqual(left,right)){
      answer(res,404,{error:'not_found'});return true;
    }
    if(request.headers.origin!==undefined&&request.headers.origin!==url.origin){
      answer(res,403,{error:'origin_forbidden'});return true;
    }
    if(request.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){
      answer(res,415,{error:'json_required'});return true;
    }
    let raw='';
    try{for await(const chunk of request){raw+=chunk.toString();if(Buffer.byteLength(raw)>512)throw new Error();}}
    catch{answer(res,413,{error:'body_too_large'});return true;}
    let input:unknown;
    try{input=JSON.parse(raw);}catch{answer(res,400,{error:'invalid_body'});return true;}
    const owner=input&&typeof input==='object'&&!Array.isArray(input)?(input as Record<string,unknown>).owner:undefined;
    if(typeof owner!=='string'||!ownerId.test(owner)){
      answer(res,400,{error:'invalid_body'});return true;
    }
    try{
      const customer=await withRecorderStore(dataDir,db=>
        new BillingCustomers(db,stripe.account,stripe.livemode).customerForOwner(owner));
      if(!customer){answer(res,404,{error:'billing_customer_not_found'});return true;}
      const portalUrl=await client.create(customer);
      answer(res,201,{url:portalUrl});
    }catch{answer(res,503,{error:'billing_portal_unavailable'});}
    return true;
  };
}
