import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {startRecorder} from './index.js';

afterEach(()=>vi.unstubAllEnvs());
async function unusedPort(){
 const server=createServer();
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 if(!address||typeof address==='string')throw new Error('port_unavailable');
 await new Promise<void>(resolve=>server.close(()=>resolve()));
 return address.port;
}

it('starts the control service with an injected runtime and closes it on shutdown',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'recorder-runtime-'));
 const port=await unusedPort();
 vi.stubEnv('DATA_DIR',dir);vi.stubEnv('PORT',String(port));
 vi.stubEnv('PUBLIC_URL',`http://127.0.0.1:${port}`);
 vi.stubEnv('SESSION_ENCRYPTION_KEY',randomBytes(32).toString('base64'));
 vi.stubEnv('RECORDER_ENVIRONMENT','local');
 const runtime={createContext:vi.fn(async()=>{throw new Error('unused_context');}),
  render:vi.fn(async()=>Buffer.alloc(0)),close:vi.fn(async()=>undefined)};
 try{
  const service=await startRecorder({runtime});
  try{
   expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
   const {createInvite}=await import('./invites.js');const {randomUUID}=await import('node:crypto');
   const invite=await createInvite(dir,randomUUID());
   const response=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${invite.token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recording_guide',arguments:{}}})});
   const guide=await response.json();expect(guide.result.content[0].text).toContain('Toru records in exactly two places');
   expect(guide.result.content[0].text).toContain('TORU FOR CHROME');
   expect(guide.result.content[0].text).toContain('TORU FOR MAC');
   expect(guide.result.content[0].text).not.toContain('demo_accounts_list');
   // Only the user's Chrome and Mac: Toru's own browser, its sign-in tools and the local companion are not offered.
   const listed=await (await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${invite.token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})})).json() as {result:{tools:Array<{name:string;inputSchema:{required?:string[];properties:Record<string,unknown>}}>}};
   const names=listed.result.tools.map(tool=>tool.name);
   for(const name of ['session_connect','connection_status','demo_accounts_list','local_browser_pair','queue_enqueue'])expect(names).not.toContain(name);
   expect(names).toEqual(expect.arrayContaining(['recording_run','session_open','desktop_devices']));
   for(const name of ['recording_run','session_open']){
    const tool=listed.result.tools.find(entry=>entry.name===name)!;
    expect(tool.inputSchema.required).toContain('localConnectionId');
    expect(tool.inputSchema.properties).not.toHaveProperty('useDemoAccount');
    expect(tool.inputSchema.properties).not.toHaveProperty('loginEmail');
   }
  }
  finally{await service.stop();}
  expect(runtime.createContext).not.toHaveBeenCalled();
  expect(runtime.close).toHaveBeenCalledOnce();
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('wires secure-page retry through the real service entry point',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'recorder-runtime-retry-'));
 const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
 vi.stubEnv('DATA_DIR',dir);vi.stubEnv('PORT',String(port));vi.stubEnv('PUBLIC_URL',base);
 vi.stubEnv('SESSION_ENCRYPTION_KEY',randomBytes(32).toString('base64'));vi.stubEnv('RECORDER_ENVIRONMENT','local');
 vi.stubEnv('HOSTED_BROWSER_ENABLED','1');
 const driver={goto:vi.fn(),dispose:vi.fn(async()=>undefined),connectWithCredentials:vi.fn(async()=>{throw new Error('invalid_credentials');})};
 const runtime={createContext:vi.fn(async()=>driver),render:vi.fn(async()=>Buffer.alloc(0)),close:vi.fn(async()=>undefined)};
 const {createInvite}=await import('./invites.js');
 const {randomUUID}=await import('node:crypto');
 try {
  const service=await startRecorder({runtime:runtime as unknown as NonNullable<NonNullable<Parameters<typeof startRecorder>[0]>['runtime']>});
  try {
   const invite=await createInvite(dir,randomUUID());
   const response=await fetch(base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${invite.token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'session_connect',arguments:{url:'https://product.example.com'}}})});
   const result=await response.json() as {result:{structuredContent:{setupUrl:string}}};
   const url=result.result.structuredContent.setupUrl;
   expect((await fetch(url+'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'test-user',password:'incorrect'})})).status).toBe(202);
   await vi.waitFor(async()=>expect((await (await fetch(url+'/status')).json()).connectionStatus).toBe('failed'));
   const retry=await fetch(url+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({targetUrl:'https://product.example.com/login'})});
   expect(retry.status).toBe(200);
   expect(await retry.json()).toMatchObject({connectionStatus:'waiting',credentialsReceived:false,setupUrl:expect.any(String)});
   expect(runtime.createContext).toHaveBeenCalledTimes(2);
  }finally{await service.stop();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
