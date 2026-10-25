import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';

const mocks=vi.hoisted(()=>({auth:vi.fn(),connect:vi.fn(),listTools:vi.fn(),close:vi.fn(),transport:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({auth:mocks.auth}));
vi.mock('@modelcontextprotocol/sdk/client/index.js',()=>({Client:class {
  connect=mocks.connect;listTools=mocks.listTools;close=mocks.close;
}}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js',async(importOriginal)=>({...(await importOriginal<object>()),StreamableHTTPClientTransport:class {
  constructor(url:URL,options:unknown){mocks.transport(url,options);}
}}));
import {POST} from './route';

const token='ar_'+'a'.repeat(43);
const requiredTools=['session_open','recording_start','recording_render','recording_links'];
const request=(body:unknown={token},origin='https://console.example')=>new Request('https://console.example/api/connection-check',{
  method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body),
});
beforeEach(()=>{
  mocks.auth.mockResolvedValue({userId:'verified-user'});
  mocks.connect.mockResolvedValue(undefined);mocks.close.mockResolvedValue(undefined);
  mocks.listTools.mockResolvedValue({tools:requiredTools.map(name=>({name}))});
  mocks.transport.mockImplementation(()=>({}));
  vi.stubEnv('RECORDER_URL','https://trusted-recorder.example');
});
afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();});

it('requires same-origin login and a bounded credential before contacting Recorder',async()=>{
  expect((await POST(request({token},'https://attacker.example'))).status).toBe(403);
  mocks.auth.mockResolvedValueOnce({userId:null});expect((await POST(request())).status).toBe(401);
  expect((await POST(request({token:'invalid'}))).status).toBe(400);
  expect((await POST(request({token,extra:'x'.repeat(300)}))).status).toBe(413);
  expect(mocks.connect).not.toHaveBeenCalled();
});

it('handshakes and lists required tools only at the configured Recorder URL without echoing the bearer',async()=>{
  const response=await POST(request({token,recorderUrl:'http://169.254.169.254'}));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({connected:true});
  expect(mocks.transport).toHaveBeenCalledOnce();
  const [url,options]=mocks.transport.mock.calls[0] as [URL,{requestInit:RequestInit}];
  expect(url.href).toBe('https://trusted-recorder.example/mcp');
  expect(options.requestInit.headers).toEqual({Authorization:`Bearer ${token}`});
  expect(options.requestInit).toMatchObject({cache:'no-store',redirect:'error'});
  expect(mocks.listTools).toHaveBeenCalledOnce();expect(mocks.close).toHaveBeenCalledOnce();
});

it('redacts provider failures and does not claim readiness when tools are missing',async()=>{
  mocks.listTools.mockResolvedValueOnce({tools:[{name:'session_open'}]});
  expect(await (await POST(request())).json()).toEqual({error:'recorder_tools_unavailable'});
  mocks.connect.mockRejectedValueOnce(new UnauthorizedError());
  const denied=await POST(request());expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({error:'credential_rejected'});
  mocks.connect.mockRejectedValueOnce(new Error(`secret ${token}`));
  const unavailable=await POST(request());expect(unavailable.status).toBe(503);
  expect(await unavailable.text()).not.toContain(token);
  expect(mocks.close).toHaveBeenCalledTimes(3);
});
