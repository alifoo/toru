import {afterEach,expect,it,vi} from 'vitest';
const {auth}=vi.hoisted(()=>({auth:vi.fn()}));vi.mock('@clerk/nextjs/server',()=>({auth}));
import {POST} from './route';
import {recorderOwnerFor} from '../../../lib/recorder-owner';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});
const id='11111111-1111-4111-8111-111111111111';
const request=(body:unknown,origin='https://console.example')=>new Request('https://console.example/api/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
function setup(){auth.mockResolvedValue({userId:'verified'});vi.stubEnv('RECORDER_URL','https://recorder.example');vi.stubEnv('RECORDER_ADMIN_KEY','secret-admin');const fetch=vi.fn(async()=>Response.json({state:'saved',useful:true}));vi.stubGlobal('fetch',fetch);return fetch;}
it('requires same origin, identity and bounded categorical payload',async()=>{
 const fetch=setup();expect((await POST(request({id,useful:true},'https://attacker.example'))).status).toBe(403);
 auth.mockResolvedValueOnce({userId:null});expect((await POST(request({id,useful:true}))).status).toBe(401);
 expect((await POST(request({id,useful:false,reason:'x'.repeat(1100)}))).status).toBe(413);
 expect((await POST(request({id,useful:true,reason:'quality'}))).status).toBe(400);expect(fetch).not.toHaveBeenCalled();
});
it('derives owner and forwards only allowed fields with no-store and no redirects',async()=>{
 const fetch=setup();const response=await POST(request({id,useful:true,owner:'attacker',text:'private notes'}));
 expect(await response.json()).toEqual({state:'saved'});expect(response.headers.get('cache-control')).toBe('private, no-store');
 const [,options]=fetch.mock.calls[0] as unknown as [URL,RequestInit];
 expect(JSON.parse(String(options.body))).toEqual({id,useful:true,owner:recorderOwnerFor('verified')});expect(options.redirect).toBe('error');
});
it('does not claim success for missing recordings or unknown backend outcomes',async()=>{
 const fetch=setup();fetch.mockResolvedValueOnce(Response.json({error:'recording_not_found'},{status:404}));
 expect((await POST(request({id,useful:true}))).status).toBe(404);
 fetch.mockRejectedValueOnce(new Error('secret-admin'));
 expect(await (await POST(request({id,useful:true}))).json()).toEqual({error:'feedback_unconfirmed'});
 fetch.mockResolvedValueOnce(Response.json({state:'saved',useful:false}));expect((await POST(request({id,useful:true}))).status).toBe(503);
});
