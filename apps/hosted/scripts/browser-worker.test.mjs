import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {FetchWebDriverTransport} from '@content-layer/browser';
import {createBrowserWorkerProxy} from '../dist/browser-worker.js';

const servers=[];
after(async()=>{for(const server of servers)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});});
async function listen(server){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
 return server.address().port;
}

test('worker proxy authenticates every WebDriver call and never returns VM loopback DevTools',async()=>{
 const requests=[];
 const cdpPort=await listen(createServer((_request,response)=>{
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify([{type:'page',webSocketDebuggerUrl:`ws://localhost:${cdpPort}/devtools/page/one`} ]));
 }));
 const driver=createServer(async(request,response)=>{
  let body='';for await(const chunk of request)body+=chunk;
  requests.push({method:request.method,path:request.url,body});
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({value:request.url==='/session'?{
   sessionId:'one',capabilities:{'goog:chromeOptions':{debuggerAddress:`localhost:${cdpPort}`}}
  }:{ready:true}}));
 });
 const driverPort=await listen(driver),token=randomBytes(32).toString('base64url');
 const proxyPort=await listen(createBrowserWorkerProxy(token,driverPort));
 const base=`http://127.0.0.1:${proxyPort}`;
 const unauthorized=await fetch(`${base}/status`);
 assert.equal(unauthorized.status,401);
 assert.equal(requests.length,0);
 assert.equal((await fetch(`${base}/cdp/json/list`)).status,401);
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 assert.equal((await fetch(`${base}/shutdown`,{headers})).status,404);
 assert.equal(requests.length,0);
 const transport=new FetchWebDriverTransport(base,fetch,30_000,{authorization:`Bearer ${token}`});
 assert.deepEqual(await transport.request('POST','/session',{}),{sessionId:'one',capabilities:{'goog:chromeOptions':{}}});
 assert.equal((await fetch(`${base}/session`,{method:'POST',headers,body:'{}'})).status,409);
 assert.deepEqual(await transport.request('GET','/session/one/url'),{ready:true});
 assert.deepEqual(await transport.request('POST','/session/one/element/f.ABC.d.DEF.e.6/clear',{}),{ready:true});
 const targets=await fetch(`${base}/cdp/json/list`,{headers});
 assert.equal(targets.status,200);
 assert.equal((await targets.json())[0].type,'page');
 assert.deepEqual(requests.map(({method,path})=>[method,path]),[['POST','/session'],['GET','/session/one/url'],['POST','/session/one/element/f.ABC.d.DEF.e.6/clear']]);
});
