import {expect,it} from 'vitest';
import {StripeCheckoutRecovery} from './stripe-checkout-recovery.js';

const config={account:'acct_123456789ABC',livemode:false,secretKey:'sk_test_123456789ABC'};
const intent={intentId:'11111111-1111-4111-8111-111111111111',
  createdAt:1_800_000_000_000,expiresAt:1_800_086_400_000};
const matching={id:'cs_test_123456789ABC',object:'checkout.session',created:1_800_000_001,
  livemode:false,mode:'subscription',client_reference_id:intent.intentId,
  metadata:{product:'agent-recorder',intent_id:intent.intentId}};
const unrelated={...matching,id:'cs_test_999999999XYZ',client_reference_id:'other',metadata:null};

function provider(pages:Record<string,unknown>[],account=config.account){
  const calls:URL[]=[];
  const request=(async(input:string|URL|Request)=>{
    const url=new URL(String(input));calls.push(url);
    if(url.pathname==='/v1/account')return Response.json({id:account});
    if(url.pathname==='/v1/checkout/sessions')return Response.json(pages[calls.length-2]);
    return new Response(null,{status:503});
  }) as typeof fetch;
  return {request,calls};
}

it('finds exactly one Session across complete paginated account-scoped results',async()=>{
  const fixture=provider([
    {object:'list',data:[unrelated],has_more:true},
    {object:'list',data:[matching],has_more:false}
  ]);
  expect(await new StripeCheckoutRecovery(config,fixture.request).findUnique(intent))
    .toBe(matching.id);
  expect(fixture.calls[1]?.searchParams.get('created[gte]')).toBe('1799999940');
  expect(fixture.calls[2]?.searchParams.get('starting_after')).toBe(unrelated.id);
});

it('fails closed for no match, duplicates, partial pages, wrong metadata or account',async()=>{
  for(const [pages,error] of [
    [[{object:'list',data:[unrelated],has_more:false}],'checkout_recovery_session_missing'],
    [[{object:'list',data:[matching,{...matching,id:'cs_test_222222222XYZ'}],has_more:false}],
      'checkout_recovery_ambiguous'],
    [[{object:'list',data:[matching],has_more:true},
      {object:'list',data:[],has_more:true}],'checkout_recovery_response_invalid'],
    [[{object:'list',data:[{...matching,metadata:{product:'other',intent_id:intent.intentId}}],
      has_more:false}],'checkout_recovery_session_mismatch']
  ] as const){
    const fixture=provider([...pages]);
    await expect(new StripeCheckoutRecovery(config,fixture.request).findUnique(intent))
      .rejects.toThrow(error);
  }
  const wrong=provider([{object:'list',data:[matching],has_more:false}],'acct_other12345678');
  await expect(new StripeCheckoutRecovery(config,wrong.request).findUnique(intent))
    .rejects.toThrow('checkout_account_mismatch');
  expect(wrong.calls).toHaveLength(1);
  expect(()=>new StripeCheckoutRecovery({...config,livemode:true}))
    .toThrow('checkout_recovery_test_config_required');
});
