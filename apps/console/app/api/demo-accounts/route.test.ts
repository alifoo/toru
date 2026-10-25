import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const auth=vi.fn();
vi.mock('@clerk/nextjs/server',()=>({auth}));
const fetch=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetch);process.env.RECORDER_URL='https://recorder.example';process.env.RECORDER_ADMIN_KEY='admin-key';});
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();fetch.mockReset();auth.mockReset();});
describe('demo accounts API',()=>{
  it('requires a signed-in user',async()=>{
    auth.mockResolvedValue({userId:null});
    const {GET}=await import('./route');
    expect((await GET(new Request('https://console.example/api/demo-accounts'))).status).toBe(401);
  });
  it('lists accounts for the owner without ever returning secrets, and forwards saves with the demo confirmation',async()=>{
    auth.mockResolvedValue({userId:'user_1'});
    fetch.mockResolvedValueOnce(Response.json({accounts:[{origin:'https://app.example.com',username:'demo@example.com',createdAt:1,lastUsedAt:null}]}));
    const {GET,POST}=await import('./route');
    const listed=await GET(new Request('https://console.example/api/demo-accounts'));
    expect(await listed.json()).toEqual({accounts:[{origin:'https://app.example.com',username:'demo@example.com',createdAt:1,lastUsedAt:null}]});
    const listUrl=new URL(fetch.mock.calls[0]![0] as string);
    expect(listUrl.pathname).toBe('/admin/demo-accounts');expect(listUrl.searchParams.get('owner')).toMatch(/^[0-9a-f-]{36}$/);
    const unconfirmed=await POST(new Request('https://console.example/api/demo-accounts',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({url:'https://app.example.com',username:'u',password:'p'})}));
    expect(unconfirmed.status).toBe(400);
    fetch.mockResolvedValueOnce(Response.json({account:{origin:'https://app.example.com',username:'u',createdAt:2,lastUsedAt:null}}));
    const saved=await POST(new Request('https://console.example/api/demo-accounts',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({url:'https://app.example.com',username:'u',password:'p',demoAccountConfirmed:true})}));
    expect(await saved.json()).toEqual({account:{origin:'https://app.example.com',username:'u',createdAt:2,lastUsedAt:null}});
    const forwarded=fetch.mock.calls[1]![1] as RequestInit;
    expect(forwarded.method).toBe('POST');expect(String(forwarded.body)).toContain('"demoAccountConfirmed":true');
    expect((forwarded.headers as Record<string,string>).authorization).toBe('Bearer admin-key');
  });
  it('rejects cross-origin writes',async()=>{
    auth.mockResolvedValue({userId:'user_1'});
    const {DELETE}=await import('./route');
    expect((await DELETE(new Request('https://console.example/api/demo-accounts?origin=https://app.example.com',{method:'DELETE',headers:{origin:'https://evil.example'}}))).status).toBe(403);
  });
  it('saves an e-mail login without a password or confirmation',async()=>{
    auth.mockResolvedValue({userId:'user_1'});
    fetch.mockResolvedValueOnce(Response.json({account:{origin:'https://app.example.com',username:'me@example.com',kind:'email'}}));
    const {POST}=await import('./route');
    const saved=await POST(new Request('https://console.example/api/demo-accounts',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({url:'https://app.example.com',username:'me@example.com',kind:'email'})}));
    expect(saved.status).toBe(200);
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({url:'https://app.example.com',username:'me@example.com',kind:'email'});
  });
  it('lets an edit keep the stored password without a new confirmation',async()=>{
    auth.mockResolvedValue({userId:'user_1'});
    fetch.mockResolvedValueOnce(Response.json({account:{origin:'https://app.example.com',username:'fixed@example.com',kind:'password'}}));
    const {POST}=await import('./route');
    const saved=await POST(new Request('https://console.example/api/demo-accounts',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({url:'https://app.example.com',username:'fixed@example.com',kind:'password',keepPassword:true})}));
    expect(saved.status).toBe(200);
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({url:'https://app.example.com',username:'fixed@example.com',kind:'password',keepPassword:true});
  });
});
