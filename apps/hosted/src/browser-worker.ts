import {timingSafeEqual} from 'node:crypto';
import {createServer,request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http';
import {connect,type Socket} from 'node:net';
import {pathToFileURL} from 'node:url';
import {spawnBrowserProcess,stopBrowserProcess} from '@content-layer/browser';

const maxRequestBytes=8*1024*1024;
const maxResponseBytes=32*1024*1024;
const route=/^\/(?:status|session(?:\/[A-Za-z0-9_.-]+)*)$/;

function authorized(value:string|undefined,token:string){
 if(!value?.startsWith('Bearer '))return false;
 const actual=Buffer.from(value.slice(7)),expected=Buffer.from(token);
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function reject(response:ServerResponse,status:number){
 response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
 response.end(JSON.stringify({value:{error:status===401?'unauthorized':'unknown error'}}));
}
async function bounded(input:IncomingMessage,max:number){
 const chunks:Buffer[]=[];let bytes=0;
 for await(const chunk of input){
  const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);
  bytes+=part.length;if(bytes>max)throw new Error('body_limit');chunks.push(part);
 }
 return Buffer.concat(chunks,bytes);
}

/** One VM exposes only token-authenticated WebDriver commands, never raw ChromeDriver. */
export function createBrowserWorkerProxy(token:string,driverPort=9515){
 if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw new Error('invalid_worker_token');
 if(!Number.isInteger(driverPort)||driverPort<1024||driverPort>65535)throw new Error('invalid_driver_port');
 let sessionId:string|undefined,debuggerPort:number|undefined,debuggerHost:string|undefined,creating=false;
 const server=createServer(async(request,response)=>{
  if(!authorized(request.headers.authorization,token)){request.resume();reject(response,401);return;}
  if(request.method==='GET'&&request.url==='/cdp/json/list'){
   request.resume();
   if(!sessionId||!debuggerPort||!debuggerHost){reject(response,404);return;}
   try{
    const result=await fetch(`http://${debuggerHost}:${debuggerPort}/json/list`,{signal:AbortSignal.timeout(5000)});
    const payload=Buffer.from(await result.arrayBuffer());
    if(!result.ok||payload.length>1024*1024){reject(response,502);return;}
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(payload);
   }catch{reject(response,502);}
   return;
  }
  if(!request.url||!route.test(request.url)||!['GET','POST','DELETE'].includes(request.method??'')){
   request.resume();reject(response,404);return;
  }
  if(Number(request.headers['content-length']??0)>maxRequestBytes){request.resume();reject(response,413);return;}
  let body:Buffer;
  try{body=await bounded(request,maxRequestBytes);}catch{reject(response,413);return;}
  const opening=request.method==='POST'&&request.url==='/session';
  const requestedSession=request.url.startsWith('/session/')?request.url.split('/')[2]:undefined;
  if(opening){
   if(sessionId||creating){reject(response,409);return;}
   creating=true;
  }else if(requestedSession!==undefined&&requestedSession!==sessionId){reject(response,404);return;}
  const upstream=httpRequest({host:'127.0.0.1',port:driverPort,path:request.url,method:request.method,
   headers:{'content-type':'application/json','content-length':body.length},timeout:35_000},async result=>{
    try{
     let payload=await bounded(result,maxResponseBytes);
     // ChromeDriver's loopback CDP address belongs to this VM. Until a guarded
     // DevTools tunnel exists, prevent the controller from connecting to its own loopback.
     if(opening&&result.statusCode===200){
      const parsed=JSON.parse(payload.toString()) as {value?:{sessionId?:string;capabilities?:{'goog:chromeOptions'?:{debuggerAddress?:string}}}};
      if(typeof parsed.value?.sessionId==='string')sessionId=parsed.value.sessionId;
      if(parsed.value?.capabilities?.['goog:chromeOptions']){
       const address=parsed.value.capabilities['goog:chromeOptions'].debuggerAddress;
       const match=typeof address==='string'?/^(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})$/.exec(address):null;
       debuggerHost=match?.[1];debuggerPort=match?Number(match[2]):undefined;
       delete parsed.value.capabilities['goog:chromeOptions'].debuggerAddress;
       payload=Buffer.from(JSON.stringify(parsed));
      }
     }
     if(request.method==='DELETE'&&request.url===`/session/${sessionId}`&&result.statusCode===200){sessionId=undefined;debuggerPort=undefined;debuggerHost=undefined;}
     if(opening)creating=false;
     response.writeHead(result.statusCode??502,{'content-type':'application/json','cache-control':'no-store'});
     response.end(payload);
    }catch{if(opening)creating=false;if(!response.headersSent)reject(response,502);else response.destroy();}
   });
  upstream.on('timeout',()=>upstream.destroy(new Error('webdriver_timeout')));
  upstream.on('error',()=>{if(opening)creating=false;if(!response.headersSent)reject(response,502);else response.destroy();});
  request.on('aborted',()=>upstream.destroy());
  response.on('close',()=>{if(!response.writableEnded)upstream.destroy();});
 upstream.end(body);
 });
 server.on('upgrade',async(request,socket,head)=>{
  const match=/^\/cdp(\/devtools\/page\/[A-Za-z0-9_-]+)$/.exec(request.url??'');
  if(!authorized(request.headers.authorization,token)||!match||!sessionId||!debuggerPort||!debuggerHost){socket.destroy();return;}
  const port=debuggerPort,host=debuggerHost,path=match[1];
  try{
   const result=await fetch(`http://${host}:${port}/json/list`,{signal:AbortSignal.timeout(5000)});
   const targets=await result.json() as Array<{type?:string;webSocketDebuggerUrl?:string}>;
   if(!result.ok||!targets.some(target=>target.type==='page'&&new URL(target.webSocketDebuggerUrl??'http://invalid').pathname===path)){
    socket.destroy();return;
   }
  }catch{socket.destroy();return;}
  const upstream=connect({host:host.replace(/^\[|\]$/g,''),port});
  upstream.once('connect',()=>{
   const headers=['GET '+path+' HTTP/1.1',`Host: ${host}:${port}`];
   for(const name of ['upgrade','connection','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol','origin']){
    const value=request.headers[name];if(typeof value==='string')headers.push(`${name}: ${value}`);
   }
   upstream.write(headers.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);
   socket.pipe(upstream);upstream.pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
 });
 return server;
}

async function start(){
 const token=process.env.RECORDER_WORKER_TOKEN??'';
 const port=Number(process.env.RECORDER_WORKER_PORT??37842);
 const driverPort=Number(process.env.CHROMEDRIVER_PORT??9515);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_worker_port');
 const server=createBrowserWorkerProxy(token,driverPort);
 const connections=new Set<Socket>();
 server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});
 const driver=spawnBrowserProcess(process.env.CHROMEDRIVER_BINARY??'chromedriver',[
  `--port=${driverPort}`,'--allowed-ips=127.0.0.1','--log-level=OFF',
 ]);
 try{
  let ready=false;
  for(let attempt=0;attempt<50;attempt++){
   if(driver.exitCode!==null||driver.signalCode!==null)break;
   try{ready=(await fetch(`http://127.0.0.1:${driverPort}/status`,{signal:AbortSignal.timeout(1000)})).ok;}catch{/* startup */}
   if(ready)break;
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(!ready)throw new Error('chromedriver_unavailable');
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'::',resolve);});
 }catch(error){server.close();await stopBrowserProcess(driver);throw error;}
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;for(const socket of connections)socket.destroy();server.close();await stopBrowserProcess(driver);};
 process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 start().catch(error=>{console.error(error instanceof Error?error.message:'browser_worker_start_failed');process.exitCode=1;});
