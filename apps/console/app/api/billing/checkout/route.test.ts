import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const auth=vi.fn();
vi.mock('@clerk/nextjs/server',()=>({auth}));
const fetch=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetch);process.env.RECORDER_URL='https://recorder.example';process.env.RECORDER_ADMIN_KEY='admin-key';process.env.RECORDER_CREATOR_CHECKOUT_ENABLED='true';});
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();fetch.mockReset();auth.mockReset();delete process.env.RECORDER_CREDIT_PACKS_ENABLED;});
const post=(body:unknown)=>new Request('https://console.example/api/billing/checkout',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify(body)});
describe('checkout API credit packs',()=>{
  it('keeps packs unavailable until the feature flag is on, then forwards the pack id',async()=>{
    auth.mockResolvedValue({userId:'user_1'});
    const {POST}=await import('./route');
    const off=await POST(post({requestId:'33333333-3333-4333-8333-333333333333',plan:'pack-15'}));
    expect(off.status).toBe(503);expect((await off.json()).error).toBe('packs_unavailable');
    expect(fetch).not.toHaveBeenCalled();
    process.env.RECORDER_CREDIT_PACKS_ENABLED='true';
    fetch.mockResolvedValueOnce(Response.json({error:'packs_unavailable'},{status:503}));
    const notOnSale=await POST(post({requestId:'33333333-3333-4333-8333-333333333333',plan:'pack-15'}));
    expect(notOnSale.status).toBe(503);expect((await notOnSale.json()).error).toBe('packs_unavailable');
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toMatchObject({plan:'pack-15'});
    expect((await POST(post({requestId:'33333333-3333-4333-8333-333333333333',plan:'pack-99'}))).status).toBe(400);
  });
});
