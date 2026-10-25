import {expect,it} from 'vitest';
import {StripeSubscriptionCloser} from './stripe-close.js';

const config={account:'acct_123456789ABC',livemode:false,secretKey:'sk_test_123456789ABC'};
const customer='cus_123456789ABC',subscription='sub_123456789ABC';
const intent='11111111-1111-4111-8111-111111111111';
const active={id:subscription,object:'subscription',livemode:false,customer,status:'active',
  ended_at:null,metadata:{product:'agent-recorder',intent_id:intent}};
const canceled={...active,status:'canceled',ended_at:1791187200};
const empty={object:'list',data:[],has_more:false};

function provider(options:{account?:string;before?:Record<string,unknown>;after?:Record<string,unknown>;
  initial?:Record<string,unknown>;cancelResult?:Record<string,unknown>;reread?:Record<string,unknown>}={}){
  const calls:{path:string;method:string;body?:string}[]=[];
  let canceledByRequest=false;
  const request=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input)),method=init?.method??'GET';
    expect(url.origin).toBe('https://api.stripe.com');
    expect(init?.headers).toMatchObject({authorization:`Bearer ${config.secretKey}`});
    calls.push({path:url.pathname+url.search,method,body:String(init?.body??'')});
    if(url.pathname==='/v1/account')return Response.json({id:options.account??config.account});
    if(url.pathname===`/v1/subscriptions/${subscription}`){
      if(method==='DELETE'){
        expect(new URLSearchParams(String(init?.body)).get('invoice_now')).toBe('false');
        expect(new URLSearchParams(String(init?.body)).get('prorate')).toBe('false');
        canceledByRequest=true;
        return Response.json(options.cancelResult??canceled);
      }
      return Response.json(canceledByRequest?options.reread??canceled:options.initial??active);
    }
    if(['/v1/invoiceitems','/v1/invoices'].includes(url.pathname)){
      expect(url.searchParams.get('customer')).toBe(customer);
      expect(url.searchParams.get('limit')).toBe('1');
      return Response.json((canceledByRequest?options.after:options.before)?.[url.pathname+url.search]??empty);
    }
    return new Response(null,{status:503});
  }) as typeof fetch;
  return {request,calls};
}

it('cancels only a bound test subscription with no outstanding items and rereads the terminal state',async()=>{
  const fixture=provider();
  expect(await new StripeSubscriptionCloser(config,fixture.request).endForDeletion(customer,subscription,intent))
    .toBe(1791187200000);
  expect(fixture.calls.filter(call=>call.method==='DELETE')).toHaveLength(1);
  expect(fixture.calls.at(-1)?.path).toContain('status=draft');
  expect(fixture.calls.filter(call=>call.path===`/v1/subscriptions/${subscription}`)).toHaveLength(3);
});

it('retries safely after the provider already canceled, without another mutation',async()=>{
  const fixture=provider({initial:canceled});
  expect(await new StripeSubscriptionCloser(config,fixture.request).endForDeletion(customer,subscription,intent))
    .toBe(1791187200000);
  expect(fixture.calls.some(call=>call.method==='DELETE')).toBe(false);
});

it('refuses wrong account, owner/customer or product before cancellation',async()=>{
  expect(()=>new StripeSubscriptionCloser({...config,livemode:true})).toThrow('billing_close_test_config_required');
  for(const options of [
    {account:'acct_other12345678'},
    {initial:{...active,customer:'cus_other12345678'}},
    {initial:{...active,metadata:{product:'contentlayer',intent_id:intent}}},
    {initial:{...active,metadata:{product:'agent-recorder',intent_id:'22222222-2222-4222-8222-222222222222'}}},
    {initial:{...active,status:'past_due'}}
  ]){
    const fixture=provider(options);
    await expect(new StripeSubscriptionCloser(config,fixture.request).endForDeletion(customer,subscription,intent))
      .rejects.toThrow();
    expect(fixture.calls.some(call=>call.method==='DELETE')).toBe(false);
  }
});

it('refuses pending invoice items or unpaid invoices before cancellation',async()=>{
  for(const path of [
    `/v1/invoiceitems?customer=${customer}&pending=true&limit=1`,
    `/v1/invoices?customer=${customer}&status=open&limit=1`,
    `/v1/invoices?customer=${customer}&status=draft&limit=1`
  ]){
    const fixture=provider({before:{[path]:{object:'list',data:[{id:'pending'}],has_more:false}}});
    await expect(new StripeSubscriptionCloser(config,fixture.request).endForDeletion(customer,subscription,intent))
      .rejects.toThrow('billing_outstanding_items');
    expect(fixture.calls.some(call=>call.method==='DELETE')).toBe(false);
  }
});

it('refuses to release an erasure hold when a post-cancel read or outstanding check is uncertain',async()=>{
  const stale=provider({reread:active});
  await expect(new StripeSubscriptionCloser(config,stale.request).endForDeletion(customer,subscription,intent))
    .rejects.toThrow('billing_subscription_state_invalid');
  expect(stale.calls.some(call=>call.method==='DELETE')).toBe(true);
  const path=`/v1/invoiceitems?customer=${customer}&pending=true&limit=1`;
  const pending=provider({after:{[path]:{object:'list',data:[{id:'pending'}],has_more:false}}});
  await expect(new StripeSubscriptionCloser(config,pending.request).endForDeletion(customer,subscription,intent))
    .rejects.toThrow('billing_outstanding_items');
  expect(pending.calls.some(call=>call.method==='DELETE')).toBe(true);
});
