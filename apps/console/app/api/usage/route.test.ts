import { afterEach, expect, it, vi } from 'vitest';
const {auth}=vi.hoisted(()=>({auth:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({auth}));
import { GET } from './route';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});

it('rejects anonymous requests without contacting the recorder',async()=>{
  auth.mockResolvedValue({userId:null});const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  expect((await GET()).status).toBe(401);expect(fetch).not.toHaveBeenCalled();
});
it('derives the owner from Clerk and keeps the admin credential on the server',async()=>{
  auth.mockResolvedValue({userId:'user_test_verified'});
  vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','synthetic-admin-secret');
  const fetch=vi.fn(async()=>Response.json({mode:'hosted',available:9,used:1,reserved:0}));vi.stubGlobal('fetch',fetch);
  const response=await GET();expect(response.status).toBe(200);
  const call=fetch.mock.calls[0] as unknown as [URL,RequestInit];
  expect(call[0].pathname).toBe('/admin/usage');expect(call[0].searchParams.get('owner')).toBe(recorderOwnerFor('user_test_verified'));
  expect(call[1].headers).toEqual({authorization:'Bearer synthetic-admin-secret'});
  expect(response.headers.get('cache-control')).toContain('no-store');expect(await response.text()).not.toContain('synthetic-admin-secret');
});
it('reports unavailable balance without exposing upstream errors or assuming zero',async()=>{
  auth.mockResolvedValue({userId:'user_test_verified'});
  vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','synthetic-admin-secret');
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('synthetic-admin-secret');}));
  const response=await GET();expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:'recorder_unavailable'});
});

it('passes a validated cursor without accepting a browser-supplied owner',async()=>{
  auth.mockResolvedValue({userId:'verified-user'});
  vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','synthetic-admin');
  const fetch=vi.fn(async()=>Response.json({history:[],historyNextCursor:null}));vi.stubGlobal('fetch',fetch);
  const cursor='11111111-1111-4111-8111-111111111111';
  expect((await GET(new Request(`https://console.example/api/usage?owner=another&historyCursor=${cursor}`))).status).toBe(200);
  const [url]=fetch.mock.calls[0] as unknown as [URL];
  expect(url.searchParams.get('owner')).toBe(recorderOwnerFor('verified-user'));
  expect(url.searchParams.get('historyCursor')).toBe(cursor);
  fetch.mockClear();
  expect((await GET(new Request('https://console.example/api/usage?historyCursor=invalid'))).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

it('redacts upstream failure bodies and disables caching on failures',async()=>{
  auth.mockResolvedValue({userId:'verified-user'});
  vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','synthetic-admin');
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'private-database-path',details:'synthetic-admin'},{status:500})));
  const response=await GET();expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({error:'recorder_unavailable'});
});
