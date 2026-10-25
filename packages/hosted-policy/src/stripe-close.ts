import type {StripeStateConfig} from './stripe-state.js';

type JsonObject=Record<string,unknown>;
const customerId=/^cus_[A-Za-z0-9]{8,128}$/;
const subscriptionId=/^sub_[A-Za-z0-9]{8,128}$/;

function object(value:unknown):JsonObject{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('billing_provider_response_invalid');
  return value as JsonObject;
}

/** Test-mode only provider closure. It does not delete financial records or issue a refund. */
export class StripeSubscriptionCloser{
  constructor(private readonly config:StripeStateConfig,private readonly request:typeof fetch=fetch){
    if(config.livemode!==false||!/^acct_[A-Za-z0-9]{8,128}$/.test(config.account)||
      !/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(config.secretKey))
      throw new Error('billing_close_test_config_required');
  }

  private async api(path:string,method:'GET'|'DELETE'='GET',body?:URLSearchParams):Promise<JsonObject>{
    let response:Response;
    try{
      response=await this.request(`https://api.stripe.com/v1/${path}`,{
        method,headers:{authorization:`Bearer ${this.config.secretKey}`,
          ...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},
        ...(body?{body:body.toString()}:{}),signal:AbortSignal.timeout(10_000)
      });
    }catch{throw new Error('billing_provider_unavailable');}
    if(!response.ok)throw new Error('billing_provider_unavailable');
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>1024*1024)throw new Error('billing_provider_response_invalid');
    let raw:string;
    try{raw=await response.text();}catch{throw new Error('billing_provider_unavailable');}
    if(Buffer.byteLength(raw)>1024*1024)throw new Error('billing_provider_response_invalid');
    try{return object(JSON.parse(raw));}catch{throw new Error('billing_provider_response_invalid');}
  }

  private verifySubscription(value:JsonObject,customer:string,subscription:string,intent:string):number|undefined{
    const metadata=object(value.metadata);
    if(value.id!==subscription||value.object!=='subscription'||value.livemode!==false||
      value.customer!==customer||metadata.product!=='agent-recorder'||metadata.intent_id!==intent)
      throw new Error('billing_subscription_mismatch');
    if(value.status==='canceled'){
      const ended=value.ended_at;
      if(typeof ended!=='number'||!Number.isSafeInteger(ended)||ended<0||
        !Number.isSafeInteger(ended*1000))throw new Error('billing_subscription_state_invalid');
      return ended*1000;
    }
    if(value.status!=='active'&&value.status!=='trialing')throw new Error('billing_subscription_review_required');
    return undefined;
  }

  private async assertNoOutstandingItems(customer:string):Promise<void>{
    for(const path of [
      `invoiceitems?customer=${customer}&pending=true&limit=1`,
      `invoices?customer=${customer}&status=open&limit=1`,
      `invoices?customer=${customer}&status=draft&limit=1`
    ]){
      const list=await this.api(path);
      if(list.object!=='list'||!Array.isArray(list.data)||list.has_more!==false)
        throw new Error('billing_outstanding_state_incomplete');
      if(list.data.length)throw new Error('billing_outstanding_items');
    }
  }

  async endForDeletion(customer:string,subscription:string,intent:string):Promise<number>{
    if(!customerId.test(customer)||!subscriptionId.test(subscription)||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intent))
      throw new Error('billing_close_reference_invalid');
    const account=await this.api('account');
    if(account.id!==this.config.account)throw new Error('billing_provider_account_mismatch');
    const current=await this.api(`subscriptions/${subscription}`);
    const alreadyEnded=this.verifySubscription(current,customer,subscription,intent);
    await this.assertNoOutstandingItems(customer);
    if(alreadyEnded!==undefined)return alreadyEnded;
    const body=new URLSearchParams({invoice_now:'false',prorate:'false'});
    const canceled=await this.api(`subscriptions/${subscription}`,'DELETE',body);
    this.verifySubscription(canceled,customer,subscription,intent);
    // A response to DELETE alone is not enough to release the local erasure hold.
    const reread=await this.api(`subscriptions/${subscription}`);
    const ended=this.verifySubscription(reread,customer,subscription,intent);
    if(ended===undefined)throw new Error('billing_subscription_state_invalid');
    await this.assertNoOutstandingItems(customer);
    return ended;
  }
}
