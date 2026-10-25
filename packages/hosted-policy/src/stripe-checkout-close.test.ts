import {expect,it} from 'vitest';
import {StripeCheckoutCloser} from './stripe-checkout-close.js';

const config={account:'acct_123456789ABC',livemode:false,secretKey:'sk_test_123456789ABC'};
const session='cs_test_123456789ABC',intent='11111111-1111-4111-8111-111111111111';
const open={id:session,object:'checkout.session',livemode:false,mode:'subscription',
  status:'open',client_reference_id:intent,metadata:{product:'agent-recorder',intent_id:intent},
  subscription:null,payment_status:'unpaid'};
const expired={...open,status:'expired'};

function provider(options:{initial?:Record<string,unknown>;expire?:Record<string,unknown>;
  reread?:Record<string,unknown>;account?:string}={}){
  const calls:string[]=[];
  let posted=false;
  const request=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input)),method=init?.method??'GET';
    expect(url.origin).toBe('https://api.stripe.com');
    expect(init?.headers).toMatchObject({authorization:`Bearer ${config.secretKey}`});
    calls.push(`${method} ${url.pathname}`);
    if(url.pathname==='/v1/account')return Response.json({id:options.account??config.account});
    if(url.pathname===`/v1/checkout/sessions/${session}/expire`&&method==='POST'){
      posted=true;return Response.json(options.expire??expired);
    }
    if(url.pathname===`/v1/checkout/sessions/${session}`&&method==='GET')
      return Response.json(posted?options.reread??expired:options.initial??open);
    return new Response(null,{status:503});
  }) as typeof fetch;
  return {request,calls};
}

it('expires a known open test Checkout Session and rereads its terminal state',async()=>{
  const fixture=provider();
  await new StripeCheckoutCloser(config,fixture.request).expireForDeletion(session,intent);
  expect(fixture.calls).toEqual(['GET /v1/account',`GET /v1/checkout/sessions/${session}`,
    `POST /v1/checkout/sessions/${session}/expire`,`GET /v1/checkout/sessions/${session}`]);
});

it('retries an already expired Session without another POST',async()=>{
  const fixture=provider({initial:expired});
  await new StripeCheckoutCloser(config,fixture.request).expireForDeletion(session,intent);
  expect(fixture.calls.some(call=>call.startsWith('POST'))).toBe(false);
});

it('refuses a completed, unrelated or uncertain Session before recording expiry',async()=>{
  expect(()=>new StripeCheckoutCloser({...config,livemode:true})).toThrow('checkout_close_test_config_required');
  for(const options of [
    {account:'acct_other12345678'},
    {initial:{...open,status:'complete',subscription:'sub_123456789ABC'}},
    {initial:{...open,metadata:{product:'contentlayer',intent_id:intent}}},
    {initial:{...open,client_reference_id:'22222222-2222-4222-8222-222222222222'}},
    {initial:{...expired,subscription:'sub_123456789ABC'}}
  ]){
    const fixture=provider(options);
    await expect(new StripeCheckoutCloser(config,fixture.request).expireForDeletion(session,intent))
      .rejects.toThrow();
    expect(fixture.calls.some(call=>call.startsWith('POST'))).toBe(false);
  }
  const stale=provider({reread:open});
  await expect(new StripeCheckoutCloser(config,stale.request).expireForDeletion(session,intent))
    .rejects.toThrow('checkout_session_state_invalid');
  expect(stale.calls.some(call=>call.startsWith('POST'))).toBe(true);
});
