import type {StripeStateConfig} from './stripe-state.js';

type JsonObject=Record<string,unknown>;
const sessionId=/^cs_test_[A-Za-z0-9_]{8,160}$/;
const intentId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value:unknown):JsonObject{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('checkout_provider_response_invalid');
  return value as JsonObject;
}

/** Test-mode only: expire a known, uncompleted Checkout Session. */
export class StripeCheckoutCloser{
  constructor(private readonly config:StripeStateConfig,private readonly request:typeof fetch=fetch){
    if(config.livemode!==false||!/^acct_[A-Za-z0-9]{8,128}$/.test(config.account)||
      !/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(config.secretKey))
      throw new Error('checkout_close_test_config_required');
  }

  private async api(path:string,method:'GET'|'POST'='GET'):Promise<JsonObject>{
    let response:Response;
    try{
      response=await this.request(`https://api.stripe.com/v1/${path}`,{
        method,headers:{authorization:`Bearer ${this.config.secretKey}`},signal:AbortSignal.timeout(10_000)
      });
    }catch{throw new Error('checkout_provider_unavailable');}
    if(!response.ok)throw new Error('checkout_provider_unavailable');
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>1024*1024)throw new Error('checkout_provider_response_invalid');
    let raw:string;
    try{raw=await response.text();}catch{throw new Error('checkout_provider_unavailable');}
    if(Buffer.byteLength(raw)>1024*1024)throw new Error('checkout_provider_response_invalid');
    try{return object(JSON.parse(raw));}catch{throw new Error('checkout_provider_response_invalid');}
  }

  private status(value:JsonObject,session:string,intent:string):'open'|'expired'{
    const metadata=object(value.metadata);
    if(value.id!==session||value.object!=='checkout.session'||value.livemode!==false||
      value.mode!=='subscription'||value.client_reference_id!==intent||
      metadata.product!=='agent-recorder'||metadata.intent_id!==intent)
      throw new Error('checkout_session_mismatch');
    if(value.status==='complete')throw new Error('checkout_session_completed_requires_review');
    if(value.status!=='open'&&value.status!=='expired')throw new Error('checkout_session_state_invalid');
    if(value.status==='expired'&&(value.subscription!==null||value.payment_status!=='unpaid'))
      throw new Error('checkout_session_state_invalid');
    return value.status;
  }

  async expireForDeletion(session:string,intent:string):Promise<void>{
    if(!sessionId.test(session)||!intentId.test(intent))throw new Error('checkout_close_reference_invalid');
    const account=await this.api('account');
    if(account.id!==this.config.account)throw new Error('checkout_account_mismatch');
    const current=this.status(await this.api(`checkout/sessions/${session}`),session,intent);
    if(current==='open'){
      this.status(await this.api(`checkout/sessions/${session}/expire`,'POST'),session,intent);
    }
    const reread=this.status(await this.api(`checkout/sessions/${session}`),session,intent);
    if(reread!=='expired')throw new Error('checkout_session_state_invalid');
  }
}
