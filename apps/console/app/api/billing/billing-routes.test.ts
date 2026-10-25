import {afterEach,expect,it,vi} from 'vitest';
const {auth}=vi.hoisted(()=>({auth:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({auth}));
import {POST as checkout} from './checkout/route';
import {POST as portal} from './portal/route';
import {recorderOwnerFor} from '../../../lib/recorder-owner';

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});
function setup(){
  auth.mockResolvedValue({userId:'verified-user'});
  vi.stubEnv('RECORDER_URL','https://recorder.example');
  vi.stubEnv('RECORDER_ADMIN_KEY','private-admin');
  vi.stubEnv('RECORDER_CREATOR_CHECKOUT_ENABLED','true');
  const fetch=vi.fn(async(input:URL)=>Response.json(input.pathname.endsWith('/portal')
    ?{url:'https://billing.stripe.com/p/session/test_123456789ABC'}
    :{url:'https://checkout.stripe.com/c/pay/cs_test_123456789ABC'},{status:201}));
  vi.stubGlobal('fetch',fetch);return fetch;
}
const request=(path:string,origin='https://console.example')=>new Request(`https://console.example/api/billing/${path}`,
  {method:'POST',headers:{origin,'content-type':'application/json'},
    ...(path==='checkout'?{body:JSON.stringify({requestId:'11111111-1111-4111-8111-111111111111',owner:'attacker'})}:{})});

it('keeps Checkout off until enabled and derives its owner from Clerk',async()=>{
  const fetch=setup();vi.stubEnv('RECORDER_CREATOR_CHECKOUT_ENABLED','false');
  expect((await checkout(request('checkout'))).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv('RECORDER_CREATOR_CHECKOUT_ENABLED','true');
  expect((await checkout(request('checkout','https://attacker.example'))).status).toBe(403);
  expect((await checkout(request('checkout'))).status).toBe(201);
  const [,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];
  expect(JSON.parse(String(options.body)).owner).toBe(recorderOwnerFor('verified-user'));
});

it('opens the portal only for a signed-in owner and rejects non-Stripe redirects',async()=>{
  const fetch=setup();auth.mockResolvedValueOnce({userId:null});
  expect((await portal(request('portal'))).status).toBe(401);
  expect((await portal(request('portal'))).status).toBe(201);
  const [,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];
  expect(JSON.parse(String(options.body)).owner).toBe(recorderOwnerFor('verified-user'));
  fetch.mockResolvedValueOnce(Response.json({url:'https://attacker.example/p/session/fake'},{status:201}));
  expect((await portal(request('portal'))).status).toBe(503);
});
