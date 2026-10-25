import { afterEach, expect, it, vi } from 'vitest';
const {auth}=vi.hoisted(()=>({auth:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({auth}));
import { GET, DELETE } from './route';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
const job='11111111-1111-4111-8111-111111111111';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});
function setup(userId:string|null='verified-user') {
  auth.mockResolvedValue({userId});vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','synthetic-admin');
  const fetch=vi.fn(async()=>Response.json({jobs:[]}));vi.stubGlobal('fetch',fetch);return fetch;
}
it('requires login to list work',async()=>{const fetch=setup(null);expect((await GET()).status).toBe(401);expect(fetch).not.toHaveBeenCalled();});
it('rejects cross-origin cancellation before contacting the recorder',async()=>{
  const fetch=setup();
  expect((await DELETE(new Request(`https://console.example/api/queue?jobId=${job}`,{method:'DELETE',headers:{origin:'https://attacker.example'}}))).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it('ignores a browser-supplied owner and sends only the authenticated account identity',async()=>{
  const fetch=setup();
  const response=await DELETE(new Request(`https://console.example/api/queue?jobId=${job}&owner=attacker-chosen`,{method:'DELETE',headers:{origin:'https://console.example'}}));
  expect(response.status).toBe(200);
  const [url,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.searchParams.get('owner')).toBe(recorderOwnerFor('verified-user'));expect(url.searchParams.get('jobId')).toBe(job);
  expect(options.method).toBe('DELETE');expect(await response.text()).not.toContain('synthetic-admin');
});
it('does not turn invalid IDs or upstream failures into a successful cancellation',async()=>{
  const fetch=setup();
  expect((await DELETE(new Request('https://console.example/api/queue?jobId=invalid',{method:'DELETE',headers:{origin:'https://console.example'}}))).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();fetch.mockRejectedValueOnce(new Error('sensitive detail'));
  const response=await GET();expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'recorder_unavailable'});
});
it('rejects malformed queue responses and redacts private upstream failures',async()=>{
  const fetch=setup();
  for(const body of [Response.json({error:'synthetic-admin'},{status:500}),new Response('invalid-json'),Response.json({})]){
    fetch.mockResolvedValueOnce(body);const response=await GET();
    expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'recorder_unavailable'});
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }
  const [,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];expect(options.redirect).toBe('error');
});
it('preserves the known missing-job outcome without forwarding extra error details',async()=>{
  const fetch=setup();fetch.mockResolvedValueOnce(Response.json({error:'queued_job_not_found',private:'synthetic-admin'},{status:404}));
  const response=await DELETE(new Request(`https://console.example/api/queue?jobId=${job}`,{method:'DELETE',headers:{origin:'https://console.example'}}));
  expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'queued_job_not_found'});
});
