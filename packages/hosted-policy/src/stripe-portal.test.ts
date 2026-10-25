import {it,expect} from 'vitest';
import {StripePortalClient} from './stripe-portal.js';

it('opens a portal only for the configured Stripe account and bound customer',async()=>{
  const calls:string[]=[];
  const request=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;calls.push(path);
    const value=path==='/v1/account'?{id:'acct_123456789ABC'}
      :path==='/v1/customers/cus_123456789ABC'?{id:'cus_123456789ABC',object:'customer',livemode:false}
      :{object:'billing_portal.session',customer:'cus_123456789ABC',livemode:false,
        url:'https://billing.stripe.com/p/session/test_123456789ABC'};
    if(path==='/v1/billing_portal/sessions'){
      const body=new URLSearchParams(String(init?.body));
      expect(body.get('customer')).toBe('cus_123456789ABC');
      expect(body.get('return_url')).toBe('https://recorder.example/');
      expect(body.get('configuration')).toBe('bpc_123456789ABC');
    }
    return new Response(JSON.stringify(value),{status:200});
  };
  const client=new StripePortalClient({account:'acct_123456789ABC',livemode:false,
    secretKey:'sk_test_123456789ABC',returnOrigin:'https://recorder.example/',
    portalConfigurationId:'bpc_123456789ABC'},request as typeof fetch);
  expect(await client.create('cus_123456789ABC'))
    .toBe('https://billing.stripe.com/p/session/test_123456789ABC');
  expect(calls).toEqual(['/v1/account','/v1/customers/cus_123456789ABC','/v1/billing_portal/sessions']);
  await expect(client.create('cus_invalid')).rejects.toThrow('billing_portal_customer_invalid');
  expect(()=>new StripePortalClient({account:'acct_123456789ABC',livemode:true,
    secretKey:'sk_test_123456789ABC',returnOrigin:'https://recorder.example/'}))
    .toThrow('billing_portal_config_invalid');
});
