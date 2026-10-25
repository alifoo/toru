import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const auth=vi.fn();
vi.mock('@clerk/nextjs/server',()=>({auth}));
const fetch=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetch);process.env.RECORDER_URL='https://recorder.example';process.env.RECORDER_ADMIN_KEY='admin-key';});
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();fetch.mockReset();auth.mockReset();});
describe('brands API',()=>{
  it('requires a signed-in user and forwards saves for the owner',async()=>{
    auth.mockResolvedValueOnce({userId:null});
    const {GET,POST}=await import('./route');
    expect((await GET(new Request('https://console.example/api/brands'))).status).toBe(401);
    auth.mockResolvedValue({userId:'user_1'});
    fetch.mockResolvedValueOnce(Response.json({brand:{origin:'https://app.example.com',brand:{accent:'#ff8800'},updatedAt:1}}));
    const saved=await POST(new Request('https://console.example/api/brands',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({origin:'https://app.example.com',brand:{accent:'#ff8800'}})}));
    expect(await saved.json()).toEqual({brand:{origin:'https://app.example.com',brand:{accent:'#ff8800'},updatedAt:1}});
    const url=new URL(fetch.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/admin/brands');expect(url.searchParams.get('owner')).toMatch(/^[0-9a-f-]{36}$/);
    fetch.mockResolvedValueOnce(Response.json({error:'invalid_brand'},{status:400}));
    const rejected=await POST(new Request('https://console.example/api/brands',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({origin:'https://app.example.com',brand:{accent:'red'}})}));
    expect(rejected.status).toBe(400);
  });
});
