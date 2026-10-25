import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserWorkerProxy} from '../dist/browser-worker.js';
import {createWorkerBackedRuntime} from '../dist/remote-runtime.js';

const servers=[];
after(async()=>{for(const server of servers)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});});
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);return server.address().port;}

test('a browser context uses an authenticated private worker and releases its lease',async()=>{
 const calls=[];let createBody;
 const driverPort=await listen(createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  if(request.url==='/session')createBody=JSON.parse(Buffer.concat(chunks).toString());
  calls.push(`${request.method} ${request.url}`);
  let value=null;
  if(request.url==='/session')value={sessionId:'session-1',capabilities:{}};
  if(request.url?.endsWith('/window/rect'))value={width:1280,height:720};
  if(request.url?.endsWith('/execute/sync'))value={width:1280,height:720};
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({value}));
 }));
 const token=randomBytes(32).toString('base64url');
 const proxyPort=await listen(createBrowserWorkerProxy(token,driverPort));
 let released=0,renderClosed=0;
 const runtime=createWorkerBackedRuntime({
  allocateBrowser:async()=>({endpoint:'http://[fd12::1]:37842',token,close:async()=>{released++;}}),
  chromeBinary:'/usr/bin/chromium',
  resolveHostname:async()=>['93.184.216.34'],
  fetchImplementation:(input,init)=>fetch(`http://127.0.0.1:${proxyPort}${new URL(input).pathname}`,init),
  render:async()=>Buffer.alloc(0),closeRender:async()=>{renderClosed++;},
 });
 const context=await runtime.createContext({viewport:{width:1280,height:720},allowedOrigins:['https://demo.example.com'],
  sessionState:new TextEncoder().encode(JSON.stringify({cookies:[],origins:[]})),onNavigation:()=>undefined,
  allowDownload:false,allowPopup:false});
 await runtime.close();await context.dispose();await context.dispose();
 assert.equal(released,1);assert.equal(renderClosed,1);
 assert.deepEqual(calls,['POST /session','POST /session/session-1/window/rect',
  'POST /session/session-1/execute/sync','DELETE /session/session-1']);
 assert.ok(createBody.capabilities.alwaysMatch['goog:chromeOptions'].args.includes('--proxy-server=http://recorder-egress:37843'));
});

test('invalid worker endpoints release their lease before any browser command',async()=>{
 let released=0;
 const runtime=createWorkerBackedRuntime({allocateBrowser:async()=>({endpoint:'https://public.example.com',
  token:randomBytes(32).toString('base64url'),close:async()=>{released++;}}),chromeBinary:'/usr/bin/chromium',
  render:async()=>Buffer.alloc(0)});
 await assert.rejects(runtime.createContext({}),/invalid_browser_worker_endpoint/);
 assert.equal(released,1);
 await runtime.close();
});

test('runtime retries a failed VM close on shutdown',async()=>{
 let attempts=0;
 const runtime=createWorkerBackedRuntime({allocateBrowser:async()=>({endpoint:'https://public.example.com',
  token:randomBytes(32).toString('base64url'),close:async()=>{if(++attempts===1)throw new Error('provider_unavailable');}}),
  chromeBinary:'/usr/bin/chromium',render:async()=>Buffer.alloc(0)});
 await assert.rejects(runtime.createContext({}),/invalid_browser_worker_endpoint/);
 assert.equal(attempts,1);
 await runtime.close();
 assert.equal(attempts,2);
});

test('hosted browser refuses local and private origins before allocating a VM',async()=>{
 let allocated=0;
 const runtime=createWorkerBackedRuntime({allocateBrowser:async()=>{allocated++;throw new Error('unexpected_allocation');},
  chromeBinary:'/usr/bin/chromium',render:async()=>Buffer.alloc(0)});
 for(const origin of ['http://localhost:9515','http://169.254.169.254','http://10.0.0.1','http://service.internal','http://app.test:3000','https://app.localhost','http://[::1]:3000']){
  await assert.rejects(runtime.createContext({allowedOrigins:[origin]}),/hosted_private_navigation_forbidden/);
 }
 assert.equal(allocated,0);await runtime.close();
});
