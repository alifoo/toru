import type {MissingCheckoutSession} from './billing-customers.js';
import type {StripeStateConfig} from './stripe-state.js';

type JsonObject=Record<string,unknown>;
const sessionId=/^cs_test_[A-Za-z0-9_]{8,160}$/;
const intentId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value:unknown):JsonObject{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('checkout_recovery_response_invalid');
  return value as JsonObject;
}

/** Test-only, read-only scan for a Session lost between provider creation and local persistence. */
export class StripeCheckoutRecovery{
  constructor(private readonly config:StripeStateConfig,private readonly request:typeof fetch=fetch){
    if(config.livemode!==false||!/^acct_[A-Za-z0-9]{8,128}$/.test(config.account)||
      !/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(config.secretKey))
      throw new Error('checkout_recovery_test_config_required');
  }

  private async api(path:string):Promise<JsonObject>{
    let response:Response;
    try{response=await this.request(`https://api.stripe.com/v1/${path}`,{
      headers:{authorization:`Bearer ${this.config.secretKey}`},signal:AbortSignal.timeout(10_000)
    });}catch{throw new Error('checkout_provider_unavailable');}
    if(!response.ok)throw new Error('checkout_provider_unavailable');
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>4*1024*1024)throw new Error('checkout_recovery_response_invalid');
    let raw:string;
    try{raw=await response.text();}catch{throw new Error('checkout_provider_unavailable');}
    if(Buffer.byteLength(raw)>4*1024*1024)throw new Error('checkout_recovery_response_invalid');
    try{return object(JSON.parse(raw));}catch{throw new Error('checkout_recovery_response_invalid');}
  }

  async findUnique(intent:MissingCheckoutSession):Promise<string>{
    if(!intentId.test(intent.intentId)||!Number.isSafeInteger(intent.createdAt)||
      !Number.isSafeInteger(intent.expiresAt)||intent.createdAt<0||
      intent.expiresAt<=intent.createdAt)throw new Error('checkout_recovery_reference_invalid');
    const account=await this.api('account');
    if(account.id!==this.config.account)throw new Error('checkout_account_mismatch');
    const gte=Math.max(0,Math.floor(intent.createdAt/1000)-60);
    const lte=Math.ceil(intent.expiresAt/1000)+60;
    let cursor:string|undefined,found:string|undefined;
    for(let page=0;page<20;page++){
      const params=new URLSearchParams({'created[gte]':String(gte),'created[lte]':String(lte),limit:'50'});
      if(cursor)params.set('starting_after',cursor);
      const list=await this.api(`checkout/sessions?${params}`);
      if(list.object!=='list'||!Array.isArray(list.data)||typeof list.has_more!=='boolean'||
        list.data.length>50||list.data.length===0&&list.has_more)
        throw new Error('checkout_recovery_response_invalid');
      for(const value of list.data){
        const row=object(value);
        if(typeof row.id!=='string'||!sessionId.test(row.id)||
          !Number.isSafeInteger(row.created)||Number(row.created)<gte||Number(row.created)>lte)
          throw new Error('checkout_recovery_response_invalid');
        if(row.client_reference_id!==intent.intentId)continue;
        const metadata=object(row.metadata);
        if(row.object!=='checkout.session'||row.livemode!==false||row.mode!=='subscription'||
          metadata.product!=='agent-recorder'||metadata.intent_id!==intent.intentId)
          throw new Error('checkout_recovery_session_mismatch');
        if(found)throw new Error('checkout_recovery_ambiguous');
        found=row.id;
      }
      if(!list.has_more){
        if(!found)throw new Error('checkout_recovery_session_missing');
        return found;
      }
      const last=object(list.data.at(-1));
      if(typeof last.id!=='string'||last.id===cursor)throw new Error('checkout_recovery_response_invalid');
      cursor=last.id;
    }
    throw new Error('checkout_recovery_incomplete');
  }
}
