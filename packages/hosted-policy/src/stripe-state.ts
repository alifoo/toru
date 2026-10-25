import type {PaidStripePlan} from './stripe-checkout.js';
import type {PendingBillingEvent} from './billing-events.js';

export type StripeStateConfig={account:string;livemode:boolean;secretKey:string};
type JsonObject=Record<string,unknown>;
export type VerifiedCreatorInvoice={invoiceId:string;customerId:string;subscriptionId:string;periodStartMs:number;periodEndMs:number;
  paymentIntentId:string;chargeId:string;paidAmount:number;amountRefunded:number;currency:string;policyVersion?:string};
export type VerifiedEndedSubscription={customerId:string;subscriptionId:string;endedAtMs:number};
export type VerifiedRefundedCharge={chargeId:string;paymentIntentId:string;customerId:string;
  amountCaptured:number;amountRefunded:number;currency:string};

const routes:Record<string,{prefix:string;object:string;path:string}>={
  'invoice.paid':{prefix:'in_',object:'invoice',path:'invoices'},
  'invoice.payment_failed':{prefix:'in_',object:'invoice',path:'invoices'},
  'invoice.voided':{prefix:'in_',object:'invoice',path:'invoices'},
  'charge.refunded':{prefix:'ch_',object:'charge',path:'charges'},
  'customer.subscription.created':{prefix:'sub_',object:'subscription',path:'subscriptions'},
  'customer.subscription.updated':{prefix:'sub_',object:'subscription',path:'subscriptions'},
  'customer.subscription.deleted':{prefix:'sub_',object:'subscription',path:'subscriptions'},
  'checkout.session.completed':{prefix:'cs_',object:'checkout.session',path:'checkout/sessions'},
  'checkout.session.async_payment_succeeded':{prefix:'cs_',object:'checkout.session',path:'checkout/sessions'},
  'checkout.session.async_payment_failed':{prefix:'cs_',object:'checkout.session',path:'checkout/sessions'},
  'checkout.session.expired':{prefix:'cs_',object:'checkout.session',path:'checkout/sessions'}
};
const safeId=/^[A-Za-z0-9_]{8,160}$/;

function asObject(value:unknown):JsonObject {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('billing_provider_response_invalid');
  return value as JsonObject;
}

/** Read-only Stripe state lookup. It never applies credits or acknowledges inbox receipts. */
export class StripeStateReader {
  constructor(private readonly config:StripeStateConfig,private readonly request:typeof fetch=fetch){
    if(!/^acct_[A-Za-z0-9]{8,128}$/.test(config.account)||typeof config.livemode!=='boolean'||
      !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(config.secretKey)||
      !(config.secretKey.startsWith(config.livemode?'sk_live_':'sk_test_')||
        config.secretKey.startsWith(config.livemode?'rk_live_':'rk_test_')))
      throw new Error('billing_provider_config_invalid');
  }

  private async get(path:string):Promise<JsonObject>{
    let response:Response;
    try {
      response=await this.request(`https://api.stripe.com/v1/${path}`,{
        method:'GET',headers:{authorization:`Bearer ${this.config.secretKey}`},signal:AbortSignal.timeout(10_000)
      });
    }catch{throw new Error('billing_provider_unavailable');}
    if(!response.ok)throw new Error('billing_provider_unavailable');
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>1024*1024)throw new Error('billing_provider_response_invalid');
    let body:string;
    try{body=await response.text();}
    catch{throw new Error('billing_provider_unavailable');}
    if(Buffer.byteLength(body)>1024*1024)throw new Error('billing_provider_response_invalid');
    try{return asObject(JSON.parse(body));}
    catch{throw new Error('billing_provider_response_invalid');}
  }

  private async verifyRefundTotal(chargeId:string,intentId:string,currency:string,expected:number){
    if(expected===0)return;
    const page=await this.get(`refunds?charge=${chargeId}&limit=100`);
    if(page.object!=='list'||page.has_more!==false||!Array.isArray(page.data)||page.data.length>100)
      throw new Error('billing_refund_state_incomplete');
    let total=0;
    for(const value of page.data){
      const refund=asObject(value);
      if(refund.object!=='refund'||refund.charge!==chargeId||
        refund.payment_intent!==null&&refund.payment_intent!==intentId||
        refund.currency!==currency||
        typeof refund.amount!=='number'||!Number.isSafeInteger(refund.amount)||refund.amount<1||
        !['succeeded','pending','requires_action','failed','canceled'].includes(String(refund.status)))
        throw new Error('billing_refund_state_incomplete');
      if(refund.status==='succeeded')total+=refund.amount;
    }
    if(total!==expected)throw new Error('billing_refund_state_incomplete');
  }

  async currentFor(receipt:PendingBillingEvent):Promise<JsonObject>{
    const route=routes[receipt.type];
    if(!route||!/^evt_[A-Za-z0-9]{8,128}$/.test(receipt.eventId)||
      !receipt.objectId.startsWith(route.prefix)||!safeId.test(receipt.objectId)||
      !Number.isSafeInteger(receipt.created)||receipt.created<0)
      throw new Error('billing_event_unsupported');
    const account=await this.get('account');
    if(account.id!==this.config.account)throw new Error('billing_provider_account_mismatch');
    const event=await this.get(`events/${receipt.eventId}`);
    const data=asObject(event.data);
    const snapshot=asObject(data.object);
    if(event.id!==receipt.eventId||event.object!=='event'||event.type!==receipt.type||
      event.created!==receipt.created||event.livemode!==this.config.livemode||
      event.account!==undefined&&event.account!==null&&event.account!==this.config.account||
      snapshot.id!==receipt.objectId||snapshot.object!==route.object)
      throw new Error('billing_provider_event_mismatch');
    const current=await this.get(`${route.path}/${receipt.objectId}`);
    if(current.id!==receipt.objectId||current.object!==route.object||
      current.livemode!==this.config.livemode)
      throw new Error('billing_provider_state_mismatch');
    return current;
  }

  /** Verify the complete Checkout purchase before binding it to a Recorder owner. */
  async verifyCreatorLineItem(sessionId:string,priceId:string,plans:PaidStripePlan[]=[]):Promise<void>{
    if(!/^cs_(test|live)_[A-Za-z0-9_]{8,160}$/.test(sessionId)||
      !sessionId.startsWith(this.config.livemode?'cs_live_':'cs_test_')||
      !/^price_[A-Za-z0-9]{8,128}$/.test(priceId))throw new Error('billing_checkout_line_items_invalid');
    const page=await this.get(`checkout/sessions/${sessionId}/line_items?limit=2`);
    if(page.object!=='list'||page.has_more!==false||!Array.isArray(page.data)||page.data.length!==1)
      throw new Error('billing_checkout_line_items_invalid');
    const item=asObject(page.data[0]),price=asObject(item.price);
    if(item.object!=='item'||item.quantity!==1||price.object!=='price'||![priceId,...plans.map(plan=>plan.priceId)].includes(String(price.id))||
      price.livemode!==this.config.livemode||price.type!=='recurring')
      throw new Error('billing_checkout_line_items_invalid');
  }

  /** A completed pack session is only a receipt: the one-off Price, the succeeded PaymentIntent and its captured charge are all checked. */
  async verifyPackPayment(session:JsonObject,priceId:string,amountMinor:number):Promise<{paymentIntentId:string;chargeId:string;amount:number;currency:string}>{
    const sessionId=session.id,intentId=session.payment_intent;
    if(typeof sessionId!=='string'||!/^cs_(test|live)_[A-Za-z0-9_]{8,160}$/.test(sessionId)||!sessionId.startsWith(this.config.livemode?'cs_live_':'cs_test_')||
      session.object!=='checkout.session'||session.mode!=='payment'||session.status!=='complete'||session.payment_status!=='paid'||
      typeof intentId!=='string'||!/^pi_[A-Za-z0-9]{8,128}$/.test(intentId)||!/^price_[A-Za-z0-9]{8,128}$/.test(priceId)||
      !Number.isSafeInteger(amountMinor)||amountMinor<1)throw new Error('billing_pack_session_invalid');
    const page=await this.get(`checkout/sessions/${sessionId}/line_items?limit=2`);
    if(page.object!=='list'||page.has_more!==false||!Array.isArray(page.data)||page.data.length!==1)throw new Error('billing_checkout_line_items_invalid');
    const item=asObject(page.data[0]),price=asObject(item.price);
    if(item.object!=='item'||item.quantity!==1||price.object!=='price'||price.id!==priceId||price.livemode!==this.config.livemode||
      price.type!=='one_time'||price.unit_amount!==amountMinor)throw new Error('billing_checkout_line_items_invalid');
    const intent=await this.get(`payment_intents/${intentId}`);
    const chargeId=intent.latest_charge,currency=intent.currency;
    if(intent.id!==intentId||intent.object!=='payment_intent'||intent.livemode!==this.config.livemode||intent.status!=='succeeded'||
      intent.amount_received!==amountMinor||typeof currency!=='string'||!/^[a-z]{3}$/.test(currency)||price.currency!==currency||
      typeof chargeId!=='string'||!/^ch_[A-Za-z0-9]{8,128}$/.test(chargeId))throw new Error('billing_payment_intent_invalid');
    const charge=await this.get(`charges/${chargeId}`);
    if(charge.id!==chargeId||charge.object!=='charge'||charge.livemode!==this.config.livemode||charge.status!=='succeeded'||charge.paid!==true||
      charge.captured!==true||charge.payment_intent!==intentId||charge.currency!==currency||charge.amount_captured!==amountMinor||
      charge.amount_refunded!==0||charge.refunded===true||charge.disputed!==false)throw new Error('billing_charge_invalid');
    return {paymentIntentId:intentId,chargeId,amount:amountMinor,currency};
  }

  /** A paid invoice alone is insufficient: verify the entire one-price subscription period. */
  async verifyCreatorInvoice(invoice:JsonObject,priceId:string,productId:string,plans:PaidStripePlan[]=[]):Promise<VerifiedCreatorInvoice>{
    const invoiceId=invoice.id,customerId=invoice.customer;
    if(typeof invoiceId!=='string'||!/^in_[A-Za-z0-9]{8,160}$/.test(invoiceId)||
      typeof customerId!=='string'||!/^cus_[A-Za-z0-9]{8,128}$/.test(customerId)||
      !/^price_[A-Za-z0-9]{8,128}$/.test(priceId)||!/^prod_[A-Za-z0-9]{8,128}$/.test(productId)||
      invoice.object!=='invoice'||invoice.livemode!==this.config.livemode||invoice.status!=='paid'||
      !['subscription_create','subscription_cycle'].includes(String(invoice.billing_reason))||
      invoice.collection_method!=='charge_automatically'||!Number.isSafeInteger(invoice.amount_paid)||
      Number(invoice.amount_paid)<=0||invoice.amount_remaining!==0||invoice.paid_out_of_band===true||
      typeof invoice.amount_paid_off_stripe==='number'&&invoice.amount_paid_off_stripe!==0)
      throw new Error('billing_invoice_invalid');
    const page=await this.get(`invoices/${invoiceId}/lines?limit=2`);
    if(page.object!=='list'||page.has_more!==false||!Array.isArray(page.data)||page.data.length!==1)
      throw new Error('billing_invoice_lines_invalid');
    const line=asObject(page.data[0]),parent=asObject(line.parent),details=asObject(parent.subscription_item_details),
      pricing=asObject(line.pricing),price=asObject(pricing.price_details),period=asObject(line.period);
    const subscriptionId=details.subscription,start=period.start,end=period.end;
    const plan=plans.find(plan=>plan.priceId===price.price && plan.productId===price.product);
    const knownPrice=(price.price===priceId && price.product===productId)||Boolean(plan);
    if(line.object!=='line_item'||line.livemode!==this.config.livemode||
      line.invoice!==undefined&&line.invoice!==invoiceId||line.quantity!==1||
      parent.type!=='subscription_item_details'||details.proration!==false||
      typeof subscriptionId!=='string'||!/^sub_[A-Za-z0-9]{8,128}$/.test(subscriptionId)||
      pricing.type!=='price_details'||!knownPrice||
      typeof start!=='number'||typeof end!=='number'||
      !Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||
      !Number.isSafeInteger(start*1000)||!Number.isSafeInteger(end*1000))
      throw new Error('billing_invoice_lines_invalid');
    // invoice.paid also fires when an operator marks an invoice paid outside Stripe.
    // A paid InvoicePayment backed by a PaymentIntent is required for this offer.
    const payments=await this.get(`invoice_payments?invoice=${invoiceId}&limit=2`);
    if(payments.object!=='list'||payments.has_more!==false||!Array.isArray(payments.data)||
      payments.data.length!==1||typeof invoice.currency!=='string'||
      !/^[a-z]{3}$/.test(invoice.currency))throw new Error('billing_invoice_payment_invalid');
    const payment=asObject(payments.data[0]),method=asObject(payment.payment);
    if(payment.object!=='invoice_payment'||payment.invoice!==invoiceId||
      payment.livemode!==this.config.livemode||payment.status!=='paid'||
      payment.currency!==invoice.currency||payment.amount_paid!==invoice.amount_paid||
      method.type!=='payment_intent'||typeof method.payment_intent!=='string'||
      !/^pi_[A-Za-z0-9]{8,128}$/.test(method.payment_intent))
      throw new Error('billing_invoice_payment_invalid');
    const intentId=method.payment_intent as string;
    const intent=await this.get(`payment_intents/${intentId}`);
    const chargeId=intent.latest_charge;
    if(intent.id!==intentId||intent.object!=='payment_intent'||
      intent.livemode!==this.config.livemode||intent.status!=='succeeded'||
      intent.customer!==customerId||intent.currency!==invoice.currency||
      intent.amount_received!==payment.amount_paid||typeof chargeId!=='string'||
      !/^ch_[A-Za-z0-9]{8,128}$/.test(chargeId))
      throw new Error('billing_payment_intent_invalid');
    const charge=await this.get(`charges/${chargeId}`);
    if(charge.id!==chargeId||charge.object!=='charge'||charge.livemode!==this.config.livemode||
      charge.status!=='succeeded'||charge.paid!==true||charge.captured!==true||
      charge.customer!==customerId||charge.payment_intent!==intentId||
      charge.currency!==invoice.currency||charge.amount_captured!==payment.amount_paid||
      typeof charge.amount_refunded!=='number'||!Number.isSafeInteger(charge.amount_refunded)||
      charge.amount_refunded<0||charge.amount_refunded>Number(payment.amount_paid)||
      charge.refunded!==undefined&&charge.refunded!==(charge.amount_refunded===Number(payment.amount_paid))||
      charge.disputed!==false)
      throw new Error('billing_charge_invalid');
    await this.verifyRefundTotal(chargeId,intentId,invoice.currency,charge.amount_refunded);
    return {invoiceId,customerId,subscriptionId,periodStartMs:start*1000,periodEndMs:end*1000,
      paymentIntentId:intentId,chargeId,paidAmount:Number(payment.amount_paid),
      amountRefunded:charge.amount_refunded,currency:invoice.currency,...(plan?{policyVersion:plan.policyVersion}:{})};
  }

  /** `canceled_at` can be the request time for end-of-period cancellation; use `ended_at`. */
  verifyEndedSubscription(subscription:JsonObject):VerifiedEndedSubscription{
    const subscriptionId=subscription.id,customerId=subscription.customer,endedAt=subscription.ended_at;
    if(subscription.object!=='subscription'||subscription.livemode!==this.config.livemode||
      subscription.status!=='canceled'||typeof subscriptionId!=='string'||
      !/^sub_[A-Za-z0-9]{8,128}$/.test(subscriptionId)||typeof customerId!=='string'||
      !/^cus_[A-Za-z0-9]{8,128}$/.test(customerId)||typeof endedAt!=='number'||
      !Number.isSafeInteger(endedAt)||endedAt<0||!Number.isSafeInteger(endedAt*1000))
      throw new Error('billing_subscription_state_invalid');
    return {customerId,subscriptionId,endedAtMs:endedAt*1000};
  }

  async verifyRefundedCharge(charge:JsonObject):Promise<VerifiedRefundedCharge>{
    const chargeId=charge.id,paymentIntentId=charge.payment_intent,customerId=charge.customer,
      amountCaptured=charge.amount_captured,amountRefunded=charge.amount_refunded,currency=charge.currency;
    if(charge.object!=='charge'||charge.livemode!==this.config.livemode||
      typeof chargeId!=='string'||!/^ch_[A-Za-z0-9]{8,128}$/.test(chargeId)||
      typeof paymentIntentId!=='string'||!/^pi_[A-Za-z0-9]{8,128}$/.test(paymentIntentId)||
      typeof customerId!=='string'||!/^cus_[A-Za-z0-9]{8,128}$/.test(customerId)||
      charge.status!=='succeeded'||charge.paid!==true||charge.captured!==true||
      typeof amountCaptured!=='number'||!Number.isSafeInteger(amountCaptured)||amountCaptured<1||
      typeof amountRefunded!=='number'||!Number.isSafeInteger(amountRefunded)||
      amountRefunded<1||amountRefunded>amountCaptured||
      typeof currency!=='string'||!/^[a-z]{3}$/.test(currency)||
      charge.refunded!==undefined&&charge.refunded!==(amountRefunded===amountCaptured))
      throw new Error('billing_refunded_charge_invalid');
    await this.verifyRefundTotal(chargeId,paymentIntentId,currency,amountRefunded);
    return {chargeId,paymentIntentId,customerId,amountCaptured,amountRefunded,currency};
  }
}
