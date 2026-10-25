import {afterEach,expect,it,vi} from 'vitest';
const {auth}=vi.hoisted(()=>({auth:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({auth}));
import {DELETE,GET,POST} from './route';
import {recorderOwnerFor} from '../../../lib/recorder-owner';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});
function setup(userId:string|null='verified-user'){
  auth.mockResolvedValue({userId});vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','private-admin');
  const fetch=vi.fn(async()=>Response.json({devices:[]}));vi.stubGlobal('fetch',fetch);return fetch;
}
const origin='https://app.toru.tools';
it('requires authentication, same-origin writes and a configured recorder',async()=>{
  const fetch=setup(null);
  expect((await GET(new Request(`${origin}/api/devices`))).status).toBe(401);
  auth.mockResolvedValue({userId:'verified-user'});
  expect((await POST(new Request(`${origin}/api/devices`,{method:'POST',headers:{origin:'https://evil.example'}}))).status).toBe(403);
  vi.stubEnv('RECORDER_ADMIN_KEY','');
  expect((await GET(new Request(`${origin}/api/devices`))).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});
it('lists devices for the verified identity and strips unknown upstream fields',async()=>{
  const fetch=setup();
  fetch.mockResolvedValueOnce(Response.json({devices:[{id:'d',name:'Mac',status:'ready'}],internal:'private'}));
  const response=await GET(new Request(`${origin}/api/devices`));
  expect(await response.json()).toEqual({devices:[{id:'d',name:'Mac',status:'ready'}]});
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const [url,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.pathname).toBe('/admin/desktop-devices');expect(url.searchParams.get('owner')).toBe(recorderOwnerFor('verified-user'));
  expect(options).toMatchObject({headers:{authorization:'Bearer private-admin'},cache:'no-store',redirect:'error'});
});
it('mints setup links and revokes a device by id without leaking the admin key',async()=>{
  const fetch=setup();
  fetch.mockResolvedValueOnce(Response.json({pairingCode:'code',expiresAt:'2026-10-06T00:00:00Z',serverUrl:'https://mcp.toru.tools',setupUrl:'https://toru.tools/mac/setup#server=https%3A%2F%2Fmcp.toru.tools&code=code',downloadUrl:'https://toru.tools/mac',adminKey:'leak'}));
  const minted=await POST(new Request(`${origin}/api/devices`,{method:'POST',headers:{origin}}));
  expect(await minted.json()).toEqual({pairingCode:'code',expiresAt:'2026-10-06T00:00:00Z',serverUrl:'https://mcp.toru.tools',setupUrl:'https://toru.tools/mac/setup#server=https%3A%2F%2Fmcp.toru.tools&code=code',downloadUrl:'https://toru.tools/mac'});
  expect((await DELETE(new Request(`${origin}/api/devices?id=bad`,{method:'DELETE',headers:{origin}}))).status).toBe(400);
  fetch.mockResolvedValueOnce(Response.json({revoked:true}));
  const id='2f1c2b8e-3c0e-4d7a-9a51-1a2b3c4d5e6f';
  const revoked=await DELETE(new Request(`${origin}/api/devices?id=${id}`,{method:'DELETE',headers:{origin}}));
  expect(await revoked.json()).toEqual({revoked:true});
  const [url]=fetch.mock.calls[1] as unknown as [URL];expect(url.searchParams.get('id')).toBe(id);
  fetch.mockResolvedValueOnce(Response.json({error:'x'},{status:500}));
  expect((await GET(new Request(`${origin}/api/devices`))).status).toBe(503);
});
