import type {CheckoutIntent} from './billing-customers.js';

export type PaidStripePlan={priceId:string;productId:string;amountMinor:number;policyVersion:"studio-v1"};
export type StripePack={id:string;priceId:string;productId:string;amountMinor:number;credits:number};
export type StripeCheckoutConfig={
  account:string;livemode:boolean;secretKey:string;priceId:string;productId:string;
  amountMinor:number;currency:string;returnOrigin:string;portalConfigurationId?:string;additionalPlans?:PaidStripePlan[];packs?:StripePack[];
};
type JsonObject=Record<string,unknown>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value:unknown):JsonObject{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('checkout_provider_response_invalid');
  return value as JsonObject;
}

/** Server-only Stripe Checkout client; creation is never inferred from a browser redirect. */
export class StripeCheckoutClient{
  private readonly origin:string;
  constructor(private readonly config:StripeCheckoutConfig,private readonly request:typeof fetch=fetch){
    if(!/^acct_[A-Za-z0-9]{8,128}$/.test(config.account)||typeof config.livemode!=='boolean'||
      !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(config.secretKey)||
      !(config.secretKey.startsWith(config.livemode?'sk_live_':'sk_test_')||
        config.secretKey.startsWith(config.livemode?'rk_live_':'rk_test_'))||
      !/^price_[A-Za-z0-9]{8,128}$/.test(config.priceId)||
      !/^prod_[A-Za-z0-9]{8,128}$/.test(config.productId)||
      !Number.isSafeInteger(config.amountMinor)||config.amountMinor<1||
      !/^[a-z]{3}$/.test(config.currency))throw new Error('checkout_config_invalid');
    let url:URL;
    try{url=new URL(config.returnOrigin);}catch{throw new Error('checkout_config_invalid');}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
      throw new Error('checkout_config_invalid');
    this.origin=url.origin;
  }

  private async api(path:string,method:'GET'|'POST',body?:URLSearchParams,key?:string):Promise<JsonObject>{
    let response:Response;
    try{
      response=await this.request(`https://api.stripe.com/v1/${path}`,{
        method,headers:{authorization:`Bearer ${this.config.secretKey}`,
          ...(body?{'content-type':'application/x-www-form-urlencoded'}:{}),
          ...(key?{'idempotency-key':key}:{})},
        ...(body?{body:body.toString()}:{}),signal:AbortSignal.timeout(10_000)
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

  async createCreatorSession(intent:CheckoutIntent,now=Date.now(),customerId?:string):Promise<{id:string;url:string}>{
    if(!uuid.test(intent.id)||!intent.owner||intent.owner.length>128||
      !Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(intent.expiresAt)||intent.expiresAt<=now||
      customerId!==undefined&&!/^cus_[A-Za-z0-9]{8,128}$/.test(customerId))
      throw new Error('checkout_intent_invalid');
    // Stripe requires at least 30 minutes; leave one minute for the three preflight reads.
    if(intent.expiresAt-now<31*60_000)throw new Error('checkout_intent_expiring');
    const expiresAt=Math.floor(intent.expiresAt/1000);
    const account=await this.api('account','GET');
    if(account.id!==this.config.account)throw new Error('checkout_account_mismatch');
    const price=await this.api(`prices/${this.config.priceId}`,'GET');
    const recurring=object(price.recurring);
    if(price.id!==this.config.priceId||price.object!=='price'||price.active!==true||
      price.livemode!==this.config.livemode||price.product!==this.config.productId||
      price.currency!==this.config.currency||price.unit_amount!==this.config.amountMinor||
      price.type!=='recurring'||price.billing_scheme!=='per_unit'||
      recurring.interval!=='month'||recurring.interval_count!==1||recurring.usage_type!=='licensed')
      throw new Error('checkout_price_mismatch');
    const product=await this.api(`products/${this.config.productId}`,'GET');
    const metadata=object(product.metadata);
    if(product.id!==this.config.productId||product.object!=='product'||product.active!==true||
      product.livemode!==this.config.livemode||metadata.product!=='agent-recorder')
      throw new Error('checkout_product_mismatch');
    const body=new URLSearchParams({
      mode:'subscription',client_reference_id:intent.id,
      expires_at:String(expiresAt),
      'line_items[0][price]':this.config.priceId,'line_items[0][quantity]':'1',
      'metadata[product]':'agent-recorder','metadata[intent_id]':intent.id,
      'subscription_data[metadata][product]':'agent-recorder',
      'subscription_data[metadata][intent_id]':intent.id,
      success_url:`${this.origin}/?billing=success`,cancel_url:`${this.origin}/?billing=cancelled`,
      ...(customerId?{customer:customerId}:{})
    });
    const result=await this.api('checkout/sessions','POST',body,`agent-recorder-checkout-${intent.id}`);
    const sessionId=result.id,checkoutUrl=result.url;
    let url:URL;
    try{url=new URL(String(checkoutUrl));}catch{throw new Error('checkout_provider_response_invalid');}
    const returnedMetadata=object(result.metadata);
    if(typeof sessionId!=='string'||!/^cs_(test|live)_[A-Za-z0-9_]{8,160}$/.test(sessionId)||
      !sessionId.startsWith(this.config.livemode?'cs_live_':'cs_test_')||
      result.object!=='checkout.session'||result.livemode!==this.config.livemode||
      result.mode!=='subscription'||result.client_reference_id!==intent.id||
      returnedMetadata.product!=='agent-recorder'||returnedMetadata.intent_id!==intent.id||
      result.expires_at!==expiresAt||
      customerId!==undefined&&result.customer!==customerId||
      result.status!=='open'||url.protocol!=='https:'||url.hostname!=='checkout.stripe.com'||
      url.username||url.password||!url.pathname.startsWith('/c/pay/'))
      throw new Error('checkout_provider_response_invalid');
    return {id:sessionId,url:url.toString()};
  }

  /** One-time payment for a credit pack; the Price must be a one-off price of the catalogue amount. */
  async createPackSession(intent:CheckoutIntent,pack:StripePack,now=Date.now(),customerId?:string):Promise<{id:string;url:string}>{
    if(!uuid.test(intent.id)||!intent.owner||intent.owner.length>128||!/^pack-[0-9]{1,3}$/.test(pack.id)||
      !/^price_[A-Za-z0-9]{8,128}$/.test(pack.priceId)||!/^prod_[A-Za-z0-9]{8,128}$/.test(pack.productId)||
      !Number.isSafeInteger(pack.amountMinor)||pack.amountMinor<1||!Number.isSafeInteger(pack.credits)||pack.credits<1||
      !Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(intent.expiresAt)||intent.expiresAt<=now||
      customerId!==undefined&&!/^cus_[A-Za-z0-9]{8,128}$/.test(customerId))
      throw new Error('checkout_intent_invalid');
    if(intent.expiresAt-now<31*60_000)throw new Error('checkout_intent_expiring');
    const expiresAt=Math.floor(intent.expiresAt/1000);
    const account=await this.api('account','GET');
    if(account.id!==this.config.account)throw new Error('checkout_account_mismatch');
    const price=await this.api(`prices/${pack.priceId}`,'GET');
    if(price.id!==pack.priceId||price.object!=='price'||price.active!==true||price.livemode!==this.config.livemode||
      price.product!==pack.productId||price.currency!==this.config.currency||price.unit_amount!==pack.amountMinor||
      price.type!=='one_time'||price.billing_scheme!=='per_unit')throw new Error('checkout_price_mismatch');
    const product=await this.api(`products/${pack.productId}`,'GET');
    const metadata=object(product.metadata);
    if(product.id!==pack.productId||product.object!=='product'||product.active!==true||
      product.livemode!==this.config.livemode||metadata.product!=='agent-recorder')throw new Error('checkout_product_mismatch');
    const body=new URLSearchParams({
      mode:'payment',client_reference_id:intent.id,expires_at:String(expiresAt),
      'line_items[0][price]':pack.priceId,'line_items[0][quantity]':'1',
      'metadata[product]':'agent-recorder','metadata[intent_id]':intent.id,'metadata[pack]':pack.id,
      'payment_intent_data[metadata][product]':'agent-recorder','payment_intent_data[metadata][intent_id]':intent.id,'payment_intent_data[metadata][pack]':pack.id,
      success_url:`${this.origin}/?billing=pack`,cancel_url:`${this.origin}/?billing=cancelled`,
      ...(customerId?{customer:customerId}:{customer_creation:'always'})
    });
    const result=await this.api('checkout/sessions','POST',body,`agent-recorder-pack-${intent.id}`);
    const sessionId=result.id,checkoutUrl=result.url;
    let url:URL;
    try{url=new URL(String(checkoutUrl));}catch{throw new Error('checkout_provider_response_invalid');}
    const returnedMetadata=object(result.metadata);
    if(typeof sessionId!=='string'||!/^cs_(test|live)_[A-Za-z0-9_]{8,160}$/.test(sessionId)||
      !sessionId.startsWith(this.config.livemode?'cs_live_':'cs_test_')||
      result.object!=='checkout.session'||result.livemode!==this.config.livemode||
      result.mode!=='payment'||result.client_reference_id!==intent.id||
      returnedMetadata.product!=='agent-recorder'||returnedMetadata.intent_id!==intent.id||returnedMetadata.pack!==pack.id||
      result.expires_at!==expiresAt||customerId!==undefined&&result.customer!==customerId||
      result.status!=='open'||url.protocol!=='https:'||url.hostname!=='checkout.stripe.com'||
      url.username||url.password||!url.pathname.startsWith('/c/pay/'))
      throw new Error('checkout_provider_response_invalid');
    return {id:sessionId,url:url.toString()};
  }
}
