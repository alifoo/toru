import {expect,it} from 'vitest';
import {StripeCheckoutClient} from './stripe-checkout.js';

const config={account:'acct_123456789ABC',livemode:false,secretKey:'sk_test_123456789ABC',
  priceId:'price_123456789ABC',productId:'prod_123456789ABC',amountMinor:1900,currency:'usd',
  returnOrigin:'https://recorder.example.com/'};
const intent={id:'33333333-3333-4333-8333-333333333333',owner:'11111111-1111-4111-8111-111111111111',
  expiresAt:1_800_000_000_000+86_400_000};

function provider(overrides:Record<string,unknown>={}){
  const calls:Array<{path:string;method:string;headers:Headers;body:URLSearchParams}>=[];
  const responses:Record<string,unknown>={
    '/v1/account':{id:config.account,object:'account'},
    [`/v1/prices/${config.priceId}`]:{id:config.priceId,object:'price',active:true,livemode:false,
      product:config.productId,currency:'usd',unit_amount:1900,type:'recurring',billing_scheme:'per_unit',
      recurring:{interval:'month',interval_count:1,usage_type:'licensed'}},
    [`/v1/products/${config.productId}`]:{id:config.productId,object:'product',active:true,livemode:false,
      metadata:{product:'agent-recorder'}},
    '/v1/checkout/sessions':{id:'cs_test_123456789ABC',object:'checkout.session',livemode:false,
      mode:'subscription',client_reference_id:intent.id,status:'open',
      expires_at:Math.floor(intent.expiresAt/1000),
      metadata:{product:'agent-recorder',intent_id:intent.id},
      url:'https://checkout.stripe.com/c/pay/cs_test_123456789ABC'},
    ...overrides
  };
  const request=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input));expect(url.origin).toBe('https://api.stripe.com');
    const headers=new Headers(init?.headers),body=new URLSearchParams(String(init?.body??''));
    calls.push({path:url.pathname,method:init?.method??'',headers,body});
    return responses[url.pathname]===undefined?new Response(null,{status:503}):Response.json(responses[url.pathname]);
  }) as typeof fetch;
  return {request,calls};
}

it('checks account, monthly Price and Product before creating one server-defined Checkout Session',async()=>{
  const {request,calls}=provider();
  const created=await new StripeCheckoutClient(config,request).createCreatorSession(intent,1_800_000_000_000);
  expect(created).toEqual({id:'cs_test_123456789ABC',url:'https://checkout.stripe.com/c/pay/cs_test_123456789ABC'});
  expect(calls.map(call=>[call.method,call.path])).toEqual([
    ['GET','/v1/account'],['GET',`/v1/prices/${config.priceId}`],
    ['GET',`/v1/products/${config.productId}`],['POST','/v1/checkout/sessions']
  ]);
  const post=calls[3]!;
  expect(post.headers.get('idempotency-key')).toBe(`agent-recorder-checkout-${intent.id}`);
  expect(post.headers.get('authorization')).toBe(`Bearer ${config.secretKey}`);
  expect(post.body.get('mode')).toBe('subscription');
  expect(post.body.get('client_reference_id')).toBe(intent.id);
  expect(post.body.get('expires_at')).toBe(String(Math.floor(intent.expiresAt/1000)));
  expect(post.body.get('line_items[0][price]')).toBe(config.priceId);
  expect(post.body.get('line_items[0][quantity]')).toBe('1');
  expect(post.body.get('metadata[product]')).toBe('agent-recorder');
  expect(post.body.get('metadata[intent_id]')).toBe(intent.id);
  expect(post.body.get('subscription_data[metadata][product]')).toBe('agent-recorder');
  expect(post.body.get('success_url')).toBe('https://recorder.example.com/?billing=success');
  expect(post.body.get('cancel_url')).toBe('https://recorder.example.com/?billing=cancelled');
});

it('does not create Checkout for another account, Product or amount',async()=>{
  const wrongAccount=provider({'/v1/account':{id:'acct_999999999XYZ'}});
  await expect(new StripeCheckoutClient(config,wrongAccount.request).createCreatorSession(intent,1_800_000_000_000))
    .rejects.toThrow('checkout_account_mismatch');
  expect(wrongAccount.calls).toHaveLength(1);
  const wrongPrice=provider({[`/v1/prices/${config.priceId}`]:{
    id:config.priceId,object:'price',active:true,livemode:false,product:config.productId,
    currency:'usd',unit_amount:2900,type:'recurring',billing_scheme:'per_unit',
    recurring:{interval:'month',interval_count:1,usage_type:'licensed'}
  }});
  await expect(new StripeCheckoutClient(config,wrongPrice.request).createCreatorSession(intent,1_800_000_000_000))
    .rejects.toThrow('checkout_price_mismatch');
  expect(wrongPrice.calls).toHaveLength(2);
  const wrongProduct=provider({[`/v1/products/${config.productId}`]:{
    id:config.productId,object:'product',active:true,livemode:false,metadata:{product:'contentlayer'}
  }});
  await expect(new StripeCheckoutClient(config,wrongProduct.request).createCreatorSession(intent,1_800_000_000_000))
    .rejects.toThrow('checkout_product_mismatch');
  expect(wrongProduct.calls).toHaveLength(3);
});

it('refuses expired intents, live/test key mismatch and an unsafe checkout redirect',async()=>{
  const {request,calls}=provider({'/v1/checkout/sessions':{
    id:'cs_test_123456789ABC',object:'checkout.session',livemode:false,mode:'subscription',
    client_reference_id:intent.id,status:'open',expires_at:Math.floor(intent.expiresAt/1000),
    metadata:{product:'agent-recorder',intent_id:intent.id},
    url:'https://example.com/steal'
  }});
  const client=new StripeCheckoutClient(config,request);
  await expect(client.createCreatorSession(intent,intent.expiresAt)).rejects.toThrow('checkout_intent_invalid');
  expect(calls).toHaveLength(0);
  await expect(client.createCreatorSession(intent,intent.expiresAt-30*60_000))
    .rejects.toThrow('checkout_intent_expiring');
  expect(calls).toHaveLength(0);
  await expect(client.createCreatorSession(intent,1_800_000_000_000)).rejects.toThrow('checkout_provider_response_invalid');
  expect(()=>new StripeCheckoutClient({...config,secretKey:'sk_live_123456789ABC'},request))
    .toThrow('checkout_config_invalid');
});

it('rejects a provider session that would outlive its local checkout intent',async()=>{
  const wrong=provider({'/v1/checkout/sessions':{
    id:'cs_test_123456789ABC',object:'checkout.session',livemode:false,mode:'subscription',
    client_reference_id:intent.id,status:'open',expires_at:Math.floor(intent.expiresAt/1000)+3600,
    metadata:{product:'agent-recorder',intent_id:intent.id},
    url:'https://checkout.stripe.com/c/pay/cs_test_123456789ABC'
  }});
  await expect(new StripeCheckoutClient(config,wrong.request).createCreatorSession(intent,1_800_000_000_000))
    .rejects.toThrow('checkout_provider_response_invalid');
});

it('creates a one-time payment Session for a credit pack against a one_time Price',async()=>{
  const pack={id:'pack-15',priceId:'price_PACK123456',productId:'prod_PACK1234567',amountMinor:1350,credits:15};
  const {request,calls}=provider({
    [`/v1/prices/${pack.priceId}`]:{id:pack.priceId,object:'price',active:true,livemode:false,product:pack.productId,currency:'usd',unit_amount:1350,type:'one_time',billing_scheme:'per_unit'},
    [`/v1/products/${pack.productId}`]:{id:pack.productId,object:'product',active:true,livemode:false,metadata:{product:'agent-recorder'}},
    '/v1/checkout/sessions':{id:'cs_test_PACK123456',object:'checkout.session',livemode:false,mode:'payment',client_reference_id:intent.id,status:'open',
      expires_at:Math.floor(intent.expiresAt/1000),customer:'cus_123456789ABC',metadata:{product:'agent-recorder',intent_id:intent.id,pack:'pack-15'},url:'https://checkout.stripe.com/c/pay/cs_test_PACK123456'},
  });
  const created=await new StripeCheckoutClient(config,request).createPackSession(intent,pack,1_800_000_000_000,'cus_123456789ABC');
  expect(created).toEqual({id:'cs_test_PACK123456',url:'https://checkout.stripe.com/c/pay/cs_test_PACK123456'});
  const session=calls.find(call=>call.path==='/v1/checkout/sessions')!;
  expect(session.body.get('mode')).toBe('payment');expect(session.body.get('customer')).toBe('cus_123456789ABC');
  expect(session.body.get('line_items[0][price]')).toBe(pack.priceId);expect(session.body.get('metadata[pack]')).toBe('pack-15');
  const recurring=provider({[`/v1/prices/${pack.priceId}`]:{id:pack.priceId,object:'price',active:true,livemode:false,product:pack.productId,currency:'usd',unit_amount:1350,type:'recurring',billing_scheme:'per_unit'}});
  await expect(new StripeCheckoutClient(config,recurring.request).createPackSession(intent,pack,1_800_000_000_000)).rejects.toThrow('checkout_price_mismatch');
});
