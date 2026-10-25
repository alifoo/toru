import {afterEach,expect,it,vi} from 'vitest';
const {auth}=vi.hoisted(()=>({auth:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({auth}));
import {GET} from './route';
import {recorderOwnerFor} from '../../../lib/recorder-owner';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});
function setup(userId:string|null='verified-user'){
  auth.mockResolvedValue({userId});vi.stubEnv('RECORDER_URL','https://recorder.example');
  vi.stubEnv('RECORDER_ADMIN_KEY','private-admin');
  const fetch=vi.fn(async()=>Response.json({recordings:[]}));vi.stubGlobal('fetch',fetch);return fetch;
}
it('requires authentication and configured server without exposing cached account data',async()=>{
  const fetch=setup(null);const denied=await GET();expect(denied.status).toBe(401);
  expect(denied.headers.get('cache-control')).toBe('private, no-store');expect(fetch).not.toHaveBeenCalled();
  auth.mockResolvedValue({userId:'verified-user'});vi.stubEnv('RECORDER_ADMIN_KEY','');
  expect((await GET()).status).toBe(503);expect(fetch).not.toHaveBeenCalled();
});
it('scopes signed links to the verified identity and bounds the private upstream request',async()=>{
  const fetch=setup();const recordings=[{id:'test-job',downloadUrl:'https://recorder.example/artifact/synthetic-link'}];
  fetch.mockResolvedValueOnce(Response.json({recordings,internal:'not-for-browser'}));
  const response=await GET();expect(await response.json()).toEqual({recordings});
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const [url,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.pathname).toBe('/admin/recordings');expect(url.searchParams.get('owner')).toBe(recorderOwnerFor('verified-user'));
  expect(options).toMatchObject({headers:{authorization:'Bearer private-admin'},cache:'no-store',redirect:'error'});
  expect(options.signal).toBeInstanceOf(AbortSignal);
});
it('does not turn upstream errors or malformed JSON into an empty successful library',async()=>{
  const fetch=setup();
  for(const upstream of [Response.json({error:'private-admin',path:'/private/db'},{status:500}),
    new Response('not-json'),Response.json({error:'private-admin'})]){
    fetch.mockResolvedValueOnce(upstream);const response=await GET();
    expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'recorder_unavailable'});
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }
});
it('redacts network and configuration failures',async()=>{
  const fetch=setup();fetch.mockRejectedValueOnce(new Error('private-admin'));
  expect(await (await GET()).json()).toEqual({error:'recorder_unavailable'});
  vi.stubEnv('RECORDER_URL','invalid-url');expect((await GET()).status).toBe(503);
});
