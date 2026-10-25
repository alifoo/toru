import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const auth=vi.fn();
vi.mock('@clerk/nextjs/server',()=>({auth}));
const fetch=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetch);process.env.RECORDER_URL='https://recorder.example';process.env.RECORDER_ADMIN_KEY='admin-key';});
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();fetch.mockReset();auth.mockReset();});
describe('runs API',()=>{
  it('requires sign-in, lists runs for the owner and fetches one run by id',async()=>{
    auth.mockResolvedValueOnce({userId:null});
    const {GET}=await import('./route');
    expect((await GET(new Request('https://console.example/api/runs'))).status).toBe(401);
    auth.mockResolvedValue({userId:'user_1'});
    fetch.mockResolvedValueOnce(Response.json({runs:[{runId:'r1',status:'done'}],nextBefore:42}));
    expect(await (await GET(new Request('https://console.example/api/runs?before=99'))).json()).toEqual({runs:[{runId:'r1',status:'done'}],nextBefore:42});
    const listUrl=new URL(fetch.mock.calls[0]![0] as string);
    expect(listUrl.pathname).toBe('/admin/runs');expect(listUrl.searchParams.get('before')).toBe('99');expect(listUrl.searchParams.get('owner')).toMatch(/^[0-9a-f-]{36}$/);
    const id='22222222-2222-4222-8222-222222222222';
    fetch.mockResolvedValueOnce(Response.json({run:{runId:id,events:[]}}));
    expect(await (await GET(new Request(`https://console.example/api/runs?id=${id}`))).json()).toEqual({run:{runId:id,events:[]}});
    expect(new URL(fetch.mock.calls[1]![0] as string).pathname).toBe(`/admin/runs/${id}`);
    expect((await GET(new Request('https://console.example/api/runs?id=../x'))).status).toBe(400);
    fetch.mockResolvedValueOnce(new Response('{}',{status:404}));
    expect((await GET(new Request(`https://console.example/api/runs?id=${id}`))).status).toBe(404);
  });
});
describe('accept review API',()=>{
  it('rejects cross-origin and forwards a same-origin acceptance',async()=>{
    auth.mockResolvedValue({userId:'user_1'});
    const {POST}=await import('../recordings/accept/route');
    const id='11111111-1111-4111-8111-111111111111';
    expect((await POST(new Request('https://console.example/api/recordings/accept',{method:'POST',headers:{origin:'https://evil.example'},body:JSON.stringify({id})}))).status).toBe(403);
    fetch.mockResolvedValueOnce(Response.json({status:'rendering'},{status:202}));
    const accepted=await POST(new Request('https://console.example/api/recordings/accept',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({id})}));
    expect(accepted.status).toBe(202);
    expect(new URL(fetch.mock.calls[0]![0] as string).pathname).toBe(`/admin/recordings/${id}/accept-review`);
    fetch.mockResolvedValueOnce(Response.json({error:'review_not_pending'},{status:409}));
    const stale=await POST(new Request('https://console.example/api/recordings/accept',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({id})}));
    expect(stale.status).toBe(409);expect((await stale.json()).error).toBe('review_not_pending');
  });
});
describe('render again API',()=>{
  it('forwards a same-origin re-render and passes the recorder refusal through',async()=>{
    auth.mockResolvedValue({userId:'user_1'});
    const {POST}=await import('../recordings/render/route');
    const id='11111111-1111-4111-8111-111111111111';
    const ask=()=>POST(new Request('https://console.example/api/recordings/render',{method:'POST',headers:{origin:'https://console.example','content-type':'application/json'},body:JSON.stringify({id})}));
    expect((await POST(new Request('https://console.example/api/recordings/render',{method:'POST',headers:{origin:'https://evil.example'},body:JSON.stringify({id})}))).status).toBe(403);
    fetch.mockResolvedValueOnce(Response.json({status:'rendering'},{status:202}));
    expect((await ask()).status).toBe(202);
    expect(new URL(fetch.mock.calls[0]![0] as string).pathname).toBe(`/admin/recordings/${id}/render`);
    fetch.mockResolvedValueOnce(Response.json({error:'rerender_limit'},{status:409}));
    const refused=await ask();
    expect(refused.status).toBe(409);expect((await refused.json()).error).toBe('rerender_limit');
  });
});
