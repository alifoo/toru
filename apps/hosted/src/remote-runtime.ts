import {isIP} from 'node:net';
import type {Socket} from 'node:net';
import {FetchWebDriverTransport,WebDriverBrowserDriver,isPublicNetworkAddress} from '@content-layer/browser';
import type {WebDriverTransport} from '@content-layer/browser';
import type {RecorderRuntime} from '@agent-recorder/mcp';
import {createCdpBridge} from './cdp-bridge.js';

export type BrowserWorkerLease={endpoint:string;token:string;close():Promise<void>};
type RuntimeOptions={
 allocateBrowser():Promise<BrowserWorkerLease>;
 render:RecorderRuntime['render'];
 closeRender?():Promise<void>;
 chromeBinary:string;
 fetchImplementation?:typeof fetch;
 connectWorker?:(endpoint:URL)=>Socket;
 resolveHostname?:(hostname:string)=>Promise<string[]>;
};

function privateEndpoint(raw:string){
 let url:URL;try{url=new URL(raw);}catch{throw new Error('invalid_browser_worker_endpoint');}
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
  !url.port||isIP(host)!==6||!/^f[cd]/i.test(host))throw new Error('invalid_browser_worker_endpoint');
 return url.origin;
}

/** One disposable VM lease per browser context; its owner closes it on every exit path. */
export function createWorkerBackedRuntime(options:RuntimeOptions):RecorderRuntime{
 const active=new Set<BrowserWorkerLease>();
 const bridges=new Map<BrowserWorkerLease,Awaited<ReturnType<typeof createCdpBridge>>>();
 const releasing=new Map<BrowserWorkerLease,Promise<void>>();
 let closed=false;
 async function release(lease:BrowserWorkerLease){
  if(!active.has(lease))return;
  const pending=releasing.get(lease);
  if(pending)return pending;
  const work=(async()=>{
   const bridge=bridges.get(lease);bridges.delete(lease);
   let bridgeError:unknown;
   try{await bridge?.close();}catch(error){bridgeError=error;}
   await lease.close();
   active.delete(lease);
   if(bridgeError)throw bridgeError;
  })();
  releasing.set(lease,work);
  try{await work;}finally{releasing.delete(lease);}
 }
 return {
  async createContext(contextOptions){
   if(closed)throw new Error('browser_runtime_closed');
   for(const origin of contextOptions.allowedOrigins??[]){
    const host=new URL(origin).hostname.replace(/^\[|\]$/g,'').toLowerCase();
    // `.test` names are development servers on a user's machine (Toru for Chrome only); here they would be ours.
    if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.test')||
     host.endsWith('.internal')||host.endsWith('.lan')||(isIP(host)!==0&&!isPublicNetworkAddress(host)))
     throw new Error('hosted_private_navigation_forbidden');
   }
   const lease=await options.allocateBrowser();
   active.add(lease);
   try{
    if(closed)throw new Error('browser_runtime_closed');
    const endpoint=privateEndpoint(lease.endpoint);
    if(!/^[A-Za-z0-9_-]{43,128}$/.test(lease.token))throw new Error('invalid_worker_token');
    const bridge=await createCdpBridge({endpoint,token:lease.token,
     fetchImplementation:options.fetchImplementation??fetch,
     ...(options.connectWorker?{connectWorker:options.connectWorker}:{})});
    bridges.set(lease,bridge);
    const webdriver=new FetchWebDriverTransport(endpoint,options.fetchImplementation??fetch,30_000,
     {authorization:`Bearer ${lease.token}`});
    const transport:WebDriverTransport={request:async(method,path,body)=>{
     const value=await webdriver.request(method,path,body);
     if(method==='POST'&&path==='/session'&&value&&typeof value==='object'){
      const capabilities=(value as {capabilities?:Record<string,unknown>}).capabilities;
      if(capabilities)capabilities['goog:chromeOptions']={
       ...(typeof capabilities['goog:chromeOptions']==='object'?capabilities['goog:chromeOptions']:{}),
       debuggerAddress:bridge.address,
      };
     }
     return value;
    }};
    const driver=new WebDriverBrowserDriver(transport,{
     chromeBinary:options.chromeBinary,recordingFrameRate:60,
     chromeArguments:['--headless=new','--proxy-server=http://recorder-egress:37843',
      '--proxy-bypass-list=<-loopback>','--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-features=WebRtcHideLocalIpsWithMdns,DnsOverHttps'],
     ...(options.resolveHostname?{resolveHostname:options.resolveHostname}:{}),
    });
    const context=await driver.createContext(contextOptions);
    const dispose=context.dispose.bind(context);
    context.dispose=async()=>{try{await dispose();}finally{await release(lease);}};
    return context;
   }catch(error){await release(lease).catch(()=>undefined);throw error;}
  },
  render:options.render,
  async close(){
   closed=true;
   const results=await Promise.allSettled([...active].map(release));
   await options.closeRender?.();
   const failure=results.find(result=>result.status==='rejected');
   if(failure?.status==='rejected')throw failure.reason;
  },
 };
}
