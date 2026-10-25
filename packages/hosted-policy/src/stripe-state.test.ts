import {expect,it} from 'vitest';
import {StripeStateReader} from './stripe-state.js';
import type {PendingBillingEvent} from './billing-events.js';

const config={account:'acct_123456789ABC',livemode:false,secretKey:'sk_test_123456789ABC'};
const receipt:PendingBillingEvent={eventId:'evt_123456789ABC',type:'invoice.paid',objectId:'in_123456789ABC',created:100};

function provider(overrides:Record<string,unknown>={}){
  const paths:string[]=[];
  const bodies:Record<string,unknown>={
    '/v1/account':{id:config.account,object:'account'},
    [`/v1/events/${receipt.eventId}`]:{
      id:receipt.eventId,object:'event',type:receipt.type,created:receipt.created,livemode:false,
      data:{object:{id:receipt.objectId,object:'invoice',status:'open'}}
    },
    [`/v1/invoices/${receipt.objectId}`]:{id:receipt.objectId,object:'invoice',livemode:false,status:'paid'},
    ...overrides
  };
  const request=(async(input:string|URL|Request,init?:RequestInit)=>{
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({authorization:`Bearer ${config.secretKey}`});
    const url=new URL(String(input));
    expect(url.origin).toBe('https://api.stripe.com');
    if(url.pathname==='/v1/invoice_payments'){
      expect(url.searchParams.get('invoice')).toBe(receipt.objectId);
      expect(url.searchParams.get('limit')).toBe('2');
    }
    if(url.pathname==='/v1/refunds'){
      expect(url.searchParams.get('charge')).toBe('ch_123456789ABC');
      expect(url.searchParams.get('limit')).toBe('100');
    }
    paths.push(url.pathname);
    return bodies[url.pathname]===undefined?new Response(null,{status:503}):Response.json(bodies[url.pathname]);
  }) as typeof fetch;
  return {request,paths};
}

it('matches account, event and current object, ignoring the stale event snapshot',async()=>{
  const {request,paths}=provider();
  const current=await new StripeStateReader(config,request).currentFor(receipt);
  expect(current.status).toBe('paid');
  expect(paths).toEqual(['/v1/account',`/v1/events/${receipt.eventId}`,`/v1/invoices/${receipt.objectId}`]);
});

it('stops before reading a payment object when the key belongs to another account',async()=>{
  const {request,paths}=provider({'/v1/account':{id:'acct_999999999XYZ',object:'account'}});
  await expect(new StripeStateReader(config,request).currentFor(receipt)).rejects.toThrow('billing_provider_account_mismatch');
  expect(paths).toEqual(['/v1/account']);
});

it('rejects mismatched events and provider outages without completing a receipt',async()=>{
  const mismatch=provider({[`/v1/events/${receipt.eventId}`]:{
    id:receipt.eventId,object:'event',type:receipt.type,created:receipt.created,livemode:false,
    data:{object:{id:'in_wrong12345678',object:'invoice'}}
  }});
  await expect(new StripeStateReader(config,mismatch.request).currentFor(receipt)).rejects.toThrow('billing_provider_event_mismatch');
  expect(mismatch.paths).toHaveLength(2);
  const outage=provider({[`/v1/invoices/${receipt.objectId}`]:undefined});
  await expect(new StripeStateReader(config,outage.request).currentFor(receipt)).rejects.toThrow('billing_provider_unavailable');
  expect(()=>new StripeStateReader({...config,secretKey:'sk_live_123456789ABC'},outage.request)).toThrow('billing_provider_config_invalid');
});

it('verifies the complete Checkout line-item list against the configured recurring price',async()=>{
  const sessionId='cs_test_123456789ABC',priceId='price_123456789ABC';
  const path=`/v1/checkout/sessions/${sessionId}/line_items`;
  const item={object:'item',quantity:1,price:{id:priceId,object:'price',livemode:false,type:'recurring'}};
  const valid=provider({[path]:{object:'list',data:[item],has_more:false}});
  await expect(new StripeStateReader(config,valid.request).verifyCreatorLineItem(sessionId,priceId)).resolves.toBeUndefined();
  expect(valid.paths).toEqual([path]);
  for(const list of [
    {object:'list',data:[item],has_more:true},
    {object:'list',data:[item,{...item}],has_more:false},
    {object:'list',data:[{...item,price:{...item.price,id:'price_other12345678'}}],has_more:false}
  ]){
    const invalid=provider({[path]:list});
    await expect(new StripeStateReader(config,invalid.request).verifyCreatorLineItem(sessionId,priceId))
      .rejects.toThrow('billing_checkout_line_items_invalid');
  }
});

it('verifies a paid Creator invoice, its complete line list and exact subscription period',async()=>{
  const priceId='price_123456789ABC',productId='prod_123456789ABC',subscriptionId='sub_123456789ABC';
  const path=`/v1/invoices/${receipt.objectId}/lines`,paymentsPath='/v1/invoice_payments',
    intentPath='/v1/payment_intents/pi_123456789ABC',chargePath='/v1/charges/ch_123456789ABC';
  const invoice={id:receipt.objectId,object:'invoice',livemode:false,status:'paid',billing_reason:'subscription_cycle',
    collection_method:'charge_automatically',amount_paid:1900,amount_remaining:0,currency:'usd',customer:'cus_123456789ABC'};
  const line={object:'line_item',invoice:receipt.objectId,livemode:false,quantity:1,
    parent:{type:'subscription_item_details',subscription_item_details:{subscription:subscriptionId,proration:false}},
    pricing:{type:'price_details',price_details:{price:priceId,product:productId}},
    period:{start:1791187200,end:1793865600}};
  const payment={id:'inpay_123456789ABC',object:'invoice_payment',invoice:receipt.objectId,livemode:false,
    status:'paid',currency:'usd',amount_paid:1900,
    payment:{type:'payment_intent',payment_intent:'pi_123456789ABC'}};
  const intent={id:'pi_123456789ABC',object:'payment_intent',livemode:false,status:'succeeded',
    customer:invoice.customer,currency:'usd',amount_received:1900,latest_charge:'ch_123456789ABC'};
  const charge={id:'ch_123456789ABC',object:'charge',livemode:false,status:'succeeded',paid:true,
    captured:true,customer:invoice.customer,payment_intent:intent.id,currency:'usd',
    amount_captured:1900,amount_refunded:0,disputed:false};
  const valid=provider({[path]:{object:'list',data:[line],has_more:false},
    [paymentsPath]:{object:'list',data:[payment],has_more:false},
    [intentPath]:intent,[chargePath]:charge});
  await expect(new StripeStateReader(config,valid.request).verifyCreatorInvoice(invoice,priceId,productId))
    .resolves.toEqual({invoiceId:receipt.objectId,customerId:invoice.customer,subscriptionId,
      periodStartMs:1791187200000,periodEndMs:1793865600000,
      paymentIntentId:'pi_123456789ABC',chargeId:'ch_123456789ABC',
      paidAmount:1900,amountRefunded:0,currency:'usd'});
  expect(valid.paths).toEqual([path,paymentsPath,intentPath,chargePath]);
  const studioPrice='price_studio123456',studioProduct='prod_studio123456';
  const studio=provider({[path]:{object:'list',data:[{...line,pricing:{type:'price_details',price_details:{price:studioPrice,product:studioProduct}}}],has_more:false},
    [paymentsPath]:{object:'list',data:[{...payment,amount_paid:4900}],has_more:false},
    [intentPath]:{...intent,amount_received:4900},[chargePath]:{...charge,amount_captured:4900}});
  const studioInvoice={...invoice,amount_paid:4900};
  await expect(new StripeStateReader(config,studio.request).verifyCreatorInvoice(studioInvoice,priceId,productId,
    [{priceId:studioPrice,productId:studioProduct,amountMinor:4900,policyVersion:'studio-v1'}]))
    .resolves.toMatchObject({policyVersion:'studio-v1',paidAmount:4900});
  await expect(new StripeStateReader(config,studio.request).verifyCreatorInvoice(studioInvoice,priceId,productId))
    .rejects.toThrow('billing_invoice_lines_invalid');

  for(const badInvoice of [{...invoice,status:'open'},{...invoice,amount_paid:0},
    {...invoice,billing_reason:'subscription_update'},
    {...invoice,paid_out_of_band:true},{...invoice,amount_paid_off_stripe:1900}]){
    const fixture=provider();
    await expect(new StripeStateReader(config,fixture.request).verifyCreatorInvoice(badInvoice,priceId,productId))
      .rejects.toThrow('billing_invoice_invalid');
    expect(fixture.paths).toEqual([]);
  }
  for(const list of [
    {object:'list',data:[line],has_more:true},
    {object:'list',data:[line,line],has_more:false},
    {object:'list',data:[{...line,parent:{...line.parent,subscription_item_details:{subscription:subscriptionId,proration:true}}}],has_more:false},
    {object:'list',data:[{...line,pricing:{type:'price_details',price_details:{price:'price_other12345678',product:productId}}}],has_more:false}
  ]){
    const fixture=provider({[path]:list});
    await expect(new StripeStateReader(config,fixture.request).verifyCreatorInvoice(invoice,priceId,productId))
      .rejects.toThrow('billing_invoice_lines_invalid');
  }
  for(const payments of [
    {object:'list',data:[],has_more:false},
    {object:'list',data:[payment],has_more:true},
    {object:'list',data:[payment,payment],has_more:false},
    {object:'list',data:[{...payment,payment:{type:'out_of_band'}}],has_more:false},
    {object:'list',data:[{...payment,amount_paid:1000}],has_more:false},
    {object:'list',data:[{...payment,invoice:'in_other12345678'}],has_more:false}
  ]){
    const fixture=provider({[path]:{object:'list',data:[line],has_more:false},[paymentsPath]:payments});
    await expect(new StripeStateReader(config,fixture.request).verifyCreatorInvoice(invoice,priceId,productId))
      .rejects.toThrow('billing_invoice_payment_invalid');
  }
  for(const badIntent of [{...intent,status:'processing'},{...intent,customer:'cus_other12345678'},
    {...intent,amount_received:1000},{...intent,latest_charge:null}]){
    const fixture=provider({[path]:{object:'list',data:[line],has_more:false},
      [paymentsPath]:{object:'list',data:[payment],has_more:false},[intentPath]:badIntent});
    await expect(new StripeStateReader(config,fixture.request).verifyCreatorInvoice(invoice,priceId,productId))
      .rejects.toThrow('billing_payment_intent_invalid');
  }
  for(const badCharge of [{...charge,amount_refunded:2000},{...charge,disputed:true},
    {...charge,payment_intent:'pi_other12345678'},{...charge,amount_captured:1000}]){
    const fixture=provider({[path]:{object:'list',data:[line],has_more:false},
      [paymentsPath]:{object:'list',data:[payment],has_more:false},
      [intentPath]:intent,[chargePath]:badCharge});
    await expect(new StripeStateReader(config,fixture.request).verifyCreatorInvoice(invoice,priceId,productId))
      .rejects.toThrow('billing_charge_invalid');
  }
  const refunded=provider({[path]:{object:'list',data:[line],has_more:false},
    [paymentsPath]:{object:'list',data:[payment],has_more:false},
    [intentPath]:intent,[chargePath]:{...charge,amount_refunded:1900,refunded:true},
    '/v1/refunds':{object:'list',data:[{id:'re_123456789ABC',object:'refund',charge:charge.id,
      payment_intent:intent.id,currency:'usd',amount:1900,status:'succeeded'}],has_more:false}});
  expect((await new StripeStateReader(config,refunded.request)
    .verifyCreatorInvoice(invoice,priceId,productId)).amountRefunded).toBe(1900);
  const pending=provider({[path]:{object:'list',data:[line],has_more:false},
    [paymentsPath]:{object:'list',data:[payment],has_more:false},
    [intentPath]:intent,[chargePath]:{...charge,amount_refunded:1900,refunded:true},
    '/v1/refunds':{object:'list',data:[{id:'re_123456789ABC',object:'refund',charge:charge.id,
      payment_intent:intent.id,currency:'usd',amount:1900,status:'pending'}],has_more:false}});
  await expect(new StripeStateReader(config,pending.request).verifyCreatorInvoice(invoice,priceId,productId))
    .rejects.toThrow('billing_refund_state_incomplete');
});
it('uses the actual subscription end, not the earlier cancellation request',()=>{
  const reader=new StripeStateReader(config);
  const subscription={id:'sub_123456789ABC',object:'subscription',livemode:false,status:'canceled',
    customer:'cus_123456789ABC',cancel_at_period_end:true,canceled_at:1791187200,ended_at:1793865600};
  expect(reader.verifyEndedSubscription(subscription)).toEqual({
    customerId:subscription.customer,subscriptionId:subscription.id,endedAtMs:1793865600000
  });
  expect(()=>reader.verifyEndedSubscription({...subscription,status:'active'}))
    .toThrow('billing_subscription_state_invalid');
  expect(()=>reader.verifyEndedSubscription({...subscription,ended_at:null}))
    .toThrow('billing_subscription_state_invalid');
});
it('verifies a current partial or full refunded charge with a payment intent',async()=>{
  const charge={id:'ch_123456789ABC',object:'charge',livemode:false,
    payment_intent:'pi_123456789ABC',customer:'cus_123456789ABC',status:'succeeded',paid:true,
    captured:true,amount_captured:1900,amount_refunded:950,currency:'usd',refunded:false};
  const refund={id:'re_123456789ABC',object:'refund',charge:charge.id,
    payment_intent:charge.payment_intent,currency:'usd',amount:950,status:'succeeded'};
  const fixture=provider({'/v1/refunds':{object:'list',data:[refund],has_more:false}});
  const reader=new StripeStateReader(config,fixture.request);
  expect(await reader.verifyRefundedCharge(charge)).toEqual({chargeId:charge.id,
    paymentIntentId:charge.payment_intent,customerId:charge.customer,
    amountCaptured:1900,amountRefunded:950,currency:'usd'});
  const full=provider({'/v1/refunds':{object:'list',data:[{...refund,amount:1900}],has_more:false}});
  expect((await new StripeStateReader(config,full.request)
    .verifyRefundedCharge({...charge,amount_refunded:1900,refunded:true})).amountRefunded).toBe(1900);
  for(const invalid of [{...charge,amount_refunded:0},{...charge,amount_refunded:2000},
    {...charge,payment_intent:null},{...charge,refunded:true},{...charge,customer:null}])
    await expect(reader.verifyRefundedCharge(invalid)).rejects.toThrow('billing_refunded_charge_invalid');
  const unfinished=provider({'/v1/refunds':{object:'list',data:[{...refund,status:'pending'}],has_more:false}});
  await expect(new StripeStateReader(config,unfinished.request).verifyRefundedCharge(charge))
    .rejects.toThrow('billing_refund_state_incomplete');
  const refundReceipt={eventId:'evt_999999999XYZ',type:'charge.refunded',objectId:charge.id,created:100};
  const event={id:refundReceipt.eventId,object:'event',type:refundReceipt.type,created:100,
    livemode:false,data:{object:{id:charge.id,object:'charge'}}};
  const eventFixture=provider({[`/v1/events/${refundReceipt.eventId}`]:event,
    [`/v1/charges/${charge.id}`]:charge});
  expect(await new StripeStateReader(config,eventFixture.request).currentFor(refundReceipt)).toEqual(charge);
});
