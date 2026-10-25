import {afterEach,expect,it,vi} from 'vitest';
const {auth}=vi.hoisted(()=>({auth:vi.fn()}));vi.mock('@clerk/nextjs/server',()=>({auth}));
import {POST,DELETE} from './route';
import {recorderOwnerFor} from '../../../lib/recorder-owner';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});
function setup(){auth.mockResolvedValue({userId:'verified'});vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','secret-admin');const fetch=vi.fn(async()=>Response.json({token:'ar_synthetic',expiresAt:'2026-10-01'},{status:201}));vi.stubGlobal('fetch',fetch);return fetch;}
const request=(body:unknown={},origin='https://console.example',method='POST')=>new Request('https://console.example/api/invites?owner=attacker',{method,headers:{origin,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
it('requires same origin and login, and limits payload size',async()=>{
 const fetch=setup();expect((await POST(request({},'https://attacker.example'))).status).toBe(403);
 auth.mockResolvedValueOnce({userId:null});expect((await POST(request())).status).toBe(401);
 expect((await POST(request({data:'x'.repeat(1025)}))).status).toBe(413);expect(fetch).not.toHaveBeenCalled();
});
it('derives owner from auth and returns only the new secret with no-store',async()=>{
 const fetch=setup();const response=await POST(request({owner:'attacker',expiresIn:'1d'}));
 expect(response.status).toBe(201);expect(response.headers.get('cache-control')).toBe('private, no-store');
 const options=(fetch.mock.calls[0] as unknown as [URL,RequestInit])[1];expect(JSON.parse(String(options.body)).owner).toBe(recorderOwnerFor('verified'));
 expect(await response.text()).not.toContain('secret-admin');
});
it('handles limits and upstream errors without leaking details',async()=>{
 const fetch=setup();fetch.mockResolvedValueOnce(Response.json({error:'active_invite_limit'},{status:429}));expect((await POST(request())).status).toBe(429);
 fetch.mockRejectedValueOnce(new Error('secret-admin'));const response=await POST(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret-admin');
});
it('revokes only the authenticated owner and rejects cross-origin revocation',async()=>{
 const fetch=setup();expect((await DELETE(request({},'https://attacker.example','DELETE'))).status).toBe(403);
 fetch.mockResolvedValueOnce(Response.json({revoked:2}));expect((await DELETE(request({},'https://console.example','DELETE'))).status).toBe(200);
 const url=(fetch.mock.calls[0] as unknown as [URL])[0];expect(url.searchParams.get('owner')).toBe(recorderOwnerFor('verified'));
});

it('reports uncertain creation after transport failure or malformed success without exposing secrets',async()=>{
 const fetch=setup();fetch.mockRejectedValueOnce(new Error('secret-admin'));
 expect(await (await POST(request())).json()).toEqual({error:'invite_creation_status_unknown'});
 fetch.mockResolvedValueOnce(Response.json({token:'ar_synthetic',expiresAt:'not-a-date'},{status:201}));
 expect(await (await POST(request())).json()).toEqual({error:'invite_creation_status_unknown'});
 const options=(fetch.mock.calls[0] as unknown as [URL,RequestInit])[1];expect(options.redirect).toBe('error');
});
it('does not claim revocation succeeded after a timeout or malformed response',async()=>{
 const fetch=setup();
 for(const upstream of [new Response('not-json'),Response.json({revoked:-1})]){
  fetch.mockResolvedValueOnce(upstream);const response=await DELETE(request({},'https://console.example','DELETE'));
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'credential_revocation_status_unknown'});
  expect(response.headers.get('cache-control')).toBe('private, no-store');
 }
 fetch.mockRejectedValueOnce(new Error('secret-admin'));
 expect(await (await DELETE(request({},'https://console.example','DELETE'))).json()).toEqual({error:'credential_revocation_status_unknown'});
});
