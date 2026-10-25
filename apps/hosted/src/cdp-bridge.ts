import {createServer} from 'node:http';
import {connect,type Socket} from 'node:net';
import type {Duplex} from 'node:stream';

type BridgeOptions={
 endpoint:string;token:string;fetchImplementation:typeof fetch;
 connectWorker?:(endpoint:URL)=>Socket;
};

/** Loopback-only CDP bridge for one worker lease. The worker validates the page target. */
export async function createCdpBridge(options:BridgeOptions){
 const endpoint=new URL(options.endpoint);
 const sockets=new Set<Duplex>();
 let port=0;
 const server=createServer(async(request,response)=>{
  if(request.method!=='GET'||request.url!=='/json/list'){
   response.writeHead(404);response.end();return;
  }
  try{
   const result=await options.fetchImplementation(new URL('/cdp/json/list',endpoint),{
    headers:{authorization:`Bearer ${options.token}`},signal:AbortSignal.timeout(5000),
   });
   if(!result.ok)throw new Error('cdp_target_lookup_failed');
   const targets=await result.json() as Array<{webSocketDebuggerUrl?:string}>;
   const mapped=targets.map(target=>({...target,...(target.webSocketDebuggerUrl?{
    webSocketDebuggerUrl:`ws://127.0.0.1:${port}${new URL(target.webSocketDebuggerUrl).pathname}`,
   }:{})}));
   response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
   response.end(JSON.stringify(mapped));
  }catch{response.writeHead(502);response.end();}
 });
 server.on('upgrade',(request,socket,head)=>{
  if(!/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(request.url??'')){socket.destroy();return;}
  const upstream=options.connectWorker?.(endpoint)??connect({host:endpoint.hostname.replace(/^\[|\]$/g,''),port:Number(endpoint.port)});
  sockets.add(socket);sockets.add(upstream);
  upstream.once('connect',()=>{
   const headers=[`GET /cdp${request.url} HTTP/1.1`,`Host: ${endpoint.host}`,
    `Authorization: Bearer ${options.token}`];
   for(const name of ['upgrade','connection','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol','origin']){
    const value=request.headers[name];if(typeof value==='string')headers.push(`${name}: ${value}`);
   }
   upstream.write(headers.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);
   socket.pipe(upstream);upstream.pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  socket.on('close',()=>{sockets.delete(socket);upstream.destroy();});
  upstream.on('close',()=>{sockets.delete(upstream);socket.destroy();});
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw new Error('cdp_bridge_unavailable');
 port=address.port;
 return {address:`127.0.0.1:${port}`,async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
