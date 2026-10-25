import {LocalBrowserBridge} from './local-browser.js';
import {ExtensionBridge} from './extension-bridge.js';
import {openRecorderStore} from './store/open.js';
import {dailyLimitsFromEnvironment,deploymentIdentityFromEnvironment} from './policies.js';
import {createNavigationController} from './navigation.js';
import {RunController} from './runs.js';
import {mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnBrowserProcess,stopBrowserProcess,WebDriverBrowserDriver,FetchWebDriverTransport} from '@content-layer/browser';
import {createRenderHost,resolveBrowserBinary} from '@content-layer/render-host';
import {createMcpServer,type CreateMcpServerOptions} from './server.js';
import {startEgressProxy} from './egress.js';
import {Recorder,type RecorderOptions} from './recorder.js';
import {pathToFileURL} from 'node:url';

/** The public engine's resource boundary; private hosted code can supply isolated workers. */
export type RecorderRuntime=Pick<RecorderOptions,'createContext'|'render'> & {close():Promise<void>};
type RecorderOverrides=Pick<RecorderOptions,'lifecycle'> & {runtime?:RecorderRuntime;oauth?:CreateMcpServerOptions['oauth'];httpExtension?:CreateMcpServerOptions['httpExtension']};

async function localRuntime():Promise<RecorderRuntime>{
 const browserBinary=await resolveBrowserBinary();
 const egress=await startEgressProxy();
 const driverPort=Number(process.env.CHROMEDRIVER_PORT??9516);
 if(!Number.isInteger(driverPort)||driverPort<1024||driverPort>65535){await egress.close();throw new Error('invalid_driver_port');}
 const driverUrl=`http://127.0.0.1:${driverPort}`;
 const chromeDriver=spawnBrowserProcess(process.env.CHROMEDRIVER_BINARY??'chromedriver',[
  `--port=${driverPort}`,'--log-level=OFF',
 ]);
 chromeDriver.on('error',()=>{console.error('chromedriver_start_failed');process.exitCode=1;});
 try{
  let ready=false;
  for(let attempt=0;attempt<50;attempt++){
   if(chromeDriver.exitCode!==null||chromeDriver.signalCode!==null)break;
   try{ready=(await fetch(`${driverUrl}/status`,{signal:AbortSignal.timeout(1000)})).ok;}catch{/* startup */}
   if(ready)break;
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(!ready)throw new Error('chromedriver_unavailable');
 }catch(error){await stopBrowserProcess(chromeDriver);await egress.close();throw error;}
 const browser=new WebDriverBrowserDriver(new FetchWebDriverTransport(driverUrl),{
  chromeBinary:browserBinary,recordingFrameRate:60,
  chromeArguments:[
   '--headless=new',`--proxy-server=http://127.0.0.1:${egress.port}`,'--proxy-bypass-list=<-loopback>',
   '--disable-quic','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
   '--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-features=WebRtcHideLocalIpsWithMdns,DnsOverHttps',
   ...(process.env.CHROME_NO_SANDBOX==='1'?['--no-sandbox']:[]),
  ],
 });
 const gpuRendering=process.env.RENDER_BACKEND==='gpu';
 const renderHost=createRenderHost({
  browserBinary,
  browserArguments:[
   ...(process.env.CHROME_NO_SANDBOX==='1'?['--no-sandbox']:[]),
   ...(gpuRendering?['--enable-gpu','--ignore-gpu-blocklist']:[]),
  ],
 });
 return {
  createContext:options=>browser.createContext(options),
  render:async(sourcePath,config,signal,onProgress)=>{
   const outcome=await renderHost.render({sourcePath,
    config:gpuRendering?{...config,renderBackend:'gpu'}:config,signal,onProgress,timeoutMs:10*60_000});
   // The message stays a fixed code for status classification; the host's reason travels as the cause for the service log.
   if(outcome.status!=='rendered')throw new Error(['render_timeout','render_canceled'].includes(outcome.reason)?outcome.reason:'render_failed',{cause:outcome.reason});
   return outcome.bytes;
  },
  close:async()=>{await stopBrowserProcess(chromeDriver);await egress.close();},
 };
}

export async function startRecorder(overrides:RecorderOverrides={}){
 const dailyLimits=dailyLimitsFromEnvironment(process.env);
 const deployment=deploymentIdentityFromEnvironment(process.env);
 const publicUrl=process.env.PUBLIC_URL;
 const key=Buffer.from(process.env.SESSION_ENCRYPTION_KEY??'','base64');
 if(!publicUrl||key.length!==32)throw new Error('PUBLIC_URL and a 32-byte base64 SESSION_ENCRYPTION_KEY are required');
 const port=Number(process.env.PORT??3002);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid_port');
 const dataDir=process.env.DATA_DIR??'/data';
 const adminKey=process.env.INVITE_ADMIN_KEY;
 await mkdir(dataDir,{recursive:true,mode:0o700});
 let runtime=overrides.runtime;
 const localBrowser:LocalBrowserBridge|undefined=process.env.LOCAL_BROWSER_ENABLED!=='0'?new LocalBrowserBridge(dataDir,(owner,deviceId,id)=>recorder.recoverDesktopUpload(owner,deviceId,id),(owner,deviceId,requestId)=>recorder.beginManualDesktopCapture(owner,deviceId,requestId)):undefined;
 if(localBrowser){
  localBrowser.desktopEnabled=process.env.DESKTOP_SESSIONS_ENABLED!=='0';
  localBrowser.minimumAppVersion=process.env.DESKTOP_MIN_APP_VERSION||undefined;
  localBrowser.latestAppVersion=process.env.DESKTOP_LATEST_APP_VERSION||undefined;
 }
 // Toru for Chrome stays off unless enabled; EXTENSION_OWNERS optionally limits it to listed accounts.
 const extension=process.env.EXTENSION_ENABLED==='1'?new ExtensionBridge(dataDir,(process.env.EXTENSION_OWNERS??'').split(',').map(owner=>owner.trim()).filter(Boolean)):undefined;
 const localContext=extension
  ?(owner:string,id:string,options:Parameters<ExtensionBridge['createContext']>[2])=>extension.owns(id)||!localBrowser?extension.createContext(owner,id,options):localBrowser.createContext(owner,id,options)
  :localBrowser?localBrowser.createContext.bind(localBrowser):undefined;
 const recorder=new Recorder({dataDir,encryptionKey:key,dailyLimits,deployment,
  ...(localContext?{createLocalContext:localContext}:{}),
  ...(overrides.lifecycle?{lifecycle:overrides.lifecycle}:{}),
  createContext:options=>{if(!runtime)throw new Error('recorder_runtime_unavailable');return runtime.createContext(options);},
  render:(sourcePath,config,signal,onProgress)=>{
   if(!runtime)throw new Error('recorder_runtime_unavailable');
   return runtime.render(sourcePath,config,signal,onProgress);
  },
 });
 try{await recorder.initialize({deferQueue:true});}
 catch(error){localBrowser?.close();extension?.close();await runtime?.close().catch(()=>undefined);throw error;}
 let navigationStore:Awaited<ReturnType<typeof openRecorderStore>>|undefined;
 let navigation:ReturnType<typeof createNavigationController>|undefined;
 let server:ReturnType<typeof createMcpServer>|undefined;
 try{
  // The volume lock is held before removing media left by a previous process.
  const scratchDirectory=resolve(dataDir,'.scratch');
  await rm(scratchDirectory,{recursive:true,force:true});
  if(!runtime){
   await mkdir(scratchDirectory,{recursive:true,mode:0o700});
   process.env.RECORDER_SCRATCH_DIR=scratchDirectory;
   runtime=await localRuntime();
  }else delete process.env.RECORDER_SCRATCH_DIR;
  navigationStore=await openRecorderStore(dataDir);
  navigation=createNavigationController(recorder,navigationStore);
  const runs=new RunController(navigation,{artifactDir:recorder.artifactDir.bind(recorder)},navigationStore);
  // The agent that calls recording_run drives the flow (docs/plans/agent-first.md). The Toru navigator only by request,
  // or by default when the server opts in with DEFAULT_NAVIGATOR=toru and has its model key.
  runs.defaultNavigator=process.env.DEFAULT_NAVIGATOR==='toru'&&process.env.TYPESAFE_API_KEY?'toru':'agent';
  const api={
   call:runs.call.bind(runs),
   recordings:recorder.recordings.bind(recorder),
   accountUsage:recorder.accountUsage.bind(recorder),
   operationalMetrics:async()=>({...await recorder.operationalMetrics(),...(localBrowser?{desktopSessionsEnabled:localBrowser.desktopEnabled,desktopDiagnostics:localBrowser.diagnostics()}:{})}),
   deleteAccountData:recorder.deleteAccountData.bind(recorder),
   artifactDownloaded:recorder.artifactDownloaded.bind(recorder),
   mcpToolUsed:recorder.mcpToolUsed.bind(recorder),
   recordingFeedback:recorder.recordingFeedback.bind(recorder),
   accountQueue:recorder.accountQueue.bind(recorder),
   cancelQueuedJob:recorder.cancelQueuedJob.bind(recorder),
   artifact:recorder.artifact.bind(recorder),
   importSession:recorder.importSession.bind(recorder),
   completeConnection:recorder.completeConnection.bind(recorder),
   retryConnection:recorder.retryConnection.bind(recorder),
   submitConnectionCredentials:recorder.submitConnectionCredentials.bind(recorder),
   submitConnectionVerification:recorder.submitConnectionVerification.bind(recorder),
   listDemoAccounts:recorder.listDemoAccounts.bind(recorder),
   saveDemoAccount:recorder.saveDemoAccount.bind(recorder),
   deleteDemoAccount:recorder.deleteDemoAccount.bind(recorder),
   listBrands:recorder.listBrands.bind(recorder),
   saveBrand:recorder.saveBrand.bind(recorder),
   deleteBrand:recorder.deleteBrand.bind(recorder),
   listRuns:runs.list.bind(runs),
   getRun:runs.get.bind(runs),
  };
  // Agents record in the user's Chrome (Toru for Chrome) or on their Mac; Toru's own browser is opt-in (HOSTED_BROWSER_ENABLED=1).
  server=createMcpServer({hostedBrowser:process.env.HOSTED_BROWSER_ENABLED==='1',...(localBrowser?{localBrowser}:{}),...(extension?{extension}:{}),recorder:api,dataDir,publicUrl,...(overrides.oauth?{oauth:overrides.oauth}:{}),...(adminKey?{adminKey}:{}),...(overrides.httpExtension?{httpExtension:overrides.httpExtension}:{}),downloadSecret:key.toString('base64url')});
  // A Toru for Chrome recording uploads in one request: up to 256 MB (five minutes at 1440p), so 6 Mbps of upload
  // finishes in time. Headers still have 10 s and an idle socket 30 s.
  server.requestTimeout=300_000;
  server.headersTimeout=10_000;
  await new Promise<void>((done,fail)=>{
   const onError=(error:Error)=>fail(error);
   server!.once('error',onError);
   server!.listen(port,'0.0.0.0',()=>{server!.removeListener('error',onError);done();});
  });
  console.log(`Agent recorder listening on ${port}`);
  recorder.activateQueue();
 }catch(error){
  localBrowser?.close();extension?.close();
  server?.closeAllConnections();server?.close();
  await navigation?.close().catch(()=>undefined);navigationStore?.close();
  await recorder.close().catch(()=>undefined);await runtime?.close().catch(()=>undefined);
  throw error;
 }
 const activeRuntime=runtime;
 const activeNavigation=navigation;
 const activeNavigationStore=navigationStore;
 const activeServer=server;
 let stopping=false;
 const onTerm=()=>void stop();
 const onInterrupt=()=>void stop();
 async function stop(){
  if(stopping)return;
  stopping=true;activeServer.close();
  const deadline=setTimeout(()=>process.exit(1),30_000);deadline.unref();
  try{
   localBrowser?.close();extension?.close();
   await activeNavigation.close();activeNavigationStore.close();
   await recorder.close();await activeRuntime.close();
   activeServer.closeAllConnections();
  }finally{
   clearTimeout(deadline);
   process.removeListener('SIGTERM',onTerm);process.removeListener('SIGINT',onInterrupt);
  }
 }
 process.once('SIGTERM',onTerm);process.once('SIGINT',onInterrupt);
 return {server:activeServer,stop};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 startRecorder().catch(error=>{console.error(error instanceof Error?error.message:'recorder_start_failed');process.exitCode=1;});
