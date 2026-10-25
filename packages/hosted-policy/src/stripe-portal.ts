import type {StripeStateConfig} from './stripe-state.js';

const customerId=/^cus_[A-Za-z0-9]{8,128}$/;

/** Creates a short-lived Stripe-hosted management link for a bound customer. */
export class StripePortalClient{
  private readonly origin:string;
  constructor(private readonly config:StripeStateConfig&{returnOrigin:string;portalConfigurationId?:string},private readonly request:typeof fetch=fetch){
    if(!/^acct_[A-Za-z0-9]{8,128}$/.test(config.account)||
      !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(config.secretKey)||
      !config.secretKey.startsWith(config.livemode?'sk_live_':'sk_test_')&&
      !config.secretKey.startsWith(config.livemode?'rk_live_':'rk_test_'))throw new Error('billing_portal_config_invalid');
    if(config.portalConfigurationId!==undefined&&!/^bpc_[A-Za-z0-9]{8,128}$/.test(config.portalConfigurationId))
      throw new Error('billing_portal_config_invalid');
    let url:URL;
    try{url=new URL(config.returnOrigin);}catch{throw new Error('billing_portal_config_invalid');}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
      throw new Error('billing_portal_config_invalid');
    this.origin=url.origin;
  }

  private async api(path:string,body?:URLSearchParams):Promise<Record<string,unknown>>{
    let response:Response;
    try{response=await this.request(`https://api.stripe.com/v1/${path}`,{
      method:body?'POST':'GET',headers:{authorization:`Bearer ${this.config.secretKey}`,
        ...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},
      ...(body?{body:body.toString()}:{}),signal:AbortSignal.timeout(10_000)
    });}catch{throw new Error('billing_portal_unavailable');}
    if(!response.ok)throw new Error('billing_portal_unavailable');
    let value:unknown;
    try{const raw=await response.text();if(Buffer.byteLength(raw)>1024*1024)throw new Error();value=JSON.parse(raw);}
    catch{throw new Error('billing_portal_response_invalid');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('billing_portal_response_invalid');
    return value as Record<string,unknown>;
  }

  async create(customer:string):Promise<string>{
    if(!customerId.test(customer))throw new Error('billing_portal_customer_invalid');
    const account=await this.api('account');
    if(account.id!==this.config.account)throw new Error('billing_portal_account_mismatch');
    const current=await this.api(`customers/${customer}`);
    if(current.id!==customer||current.object!=='customer'||current.livemode!==this.config.livemode||current.deleted===true)
      throw new Error('billing_portal_customer_mismatch');
    const session=await this.api('billing_portal/sessions',new URLSearchParams({
      customer,return_url:`${this.origin}/`,
      ...(this.config.portalConfigurationId?{configuration:this.config.portalConfigurationId}:{})
    }));
    let url:URL;
    try{url=new URL(String(session.url));}catch{throw new Error('billing_portal_response_invalid');}
    if(session.object!=='billing_portal.session'||session.customer!==customer||
      session.livemode!==this.config.livemode||url.protocol!=='https:'||
      url.hostname!=='billing.stripe.com'||!url.pathname.startsWith('/p/session/')||url.username||url.password)
      throw new Error('billing_portal_response_invalid');
    return url.toString();
  }
}
