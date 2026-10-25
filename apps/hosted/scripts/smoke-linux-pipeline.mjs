// Run inside the disposable offline Linux container. Uses the real engine packages.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {WebDriverBrowserDriver,FetchWebDriverTransport} from '../../../packages/browser/dist/index.js';
import {buildExporterConfig} from '../../../packages/render-contract/dist/index.js';
import {createRenderHost} from '../../../packages/render-host/dist/index.js';

assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);
assert.notEqual(process.env.CHROME_NO_SANDBOX,'1');
const run=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const captureTargetMs=Number(process.env.PIPELINE_CAPTURE_MS??2000);
assert.ok(Number.isSafeInteger(captureTargetMs)&&captureTargetMs>=2000&&captureTargetMs<=120000);
async function memoryPeakBytes(){
  try{return Number((await readFile('/sys/fs/cgroup/memory.peak','utf8')).trim());}
  catch{return null;}
}
const browserBinary=process.env.RENDER_BROWSER_BINARY??'/usr/lib/chromium/chromium';
const bundleDirectory=process.env.RENDER_BUNDLE_DIRECTORY??fileURLToPath(new URL('../../../apps/render-worker/dist-web',import.meta.url));
const {stdout:encoders}=await run('ffmpeg',['-hide_banner','-encoders'],{timeout:10000});
assert.match(encoders,/\blibvpx-vp9\b/,'Linux image must provide the VP9 encoder used by Recorder capture');
const html=`<!doctype html><style>body{font:24px sans-serif;padding:30px;background:linear-gradient(120deg,#76b8ee,#edbbce);color:#102035}button{font:inherit;padding:18px}li{padding:5px}</style><h1>Recorder Linux pipeline fixture</h1><button data-testid="advance" onclick="document.querySelector('h1').textContent='Step '+(++window.step)">Advance demonstration</button><ul>${Array.from({length:24},(_,i)=>`<li>Example company ${i+1} — synthetic test data</li>`).join('')}</ul><script>window.step=0</script>`;
const site=createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(html);});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${site.address().port}`;
const driver=spawn('chromedriver',['--port=9515','--log-level=OFF'],{stdio:'ignore'});
let context;
try {
  let ready=false;
  for(let i=0;i<100;i++){
    if(driver.exitCode!==null)throw new Error('driver_exited');
    try{ready=(await fetch('http://127.0.0.1:9515/status',{signal:AbortSignal.timeout(500)})).ok;}catch{}
    if(ready)break;await sleep(100);
  }
  assert.ok(ready,'driver_timeout');
  const browser=new WebDriverBrowserDriver(new FetchWebDriverTransport('http://127.0.0.1:9515'),{
    chromeBinary:browserBinary,chromeArguments:['--headless=new'],recordingFrameRate:30});
  context=await browser.createContext({viewport:{width:1280,height:720},allowedOrigins:[origin],
    sessionState:new TextEncoder().encode(JSON.stringify({cookies:[],origins:[]})),
    onNavigation:target=>assert.equal(new URL(target).origin,origin),allowDownload:false,allowPopup:false});
  await context.goto(origin);
  await context.redactSensitiveText();
  await context.startRecording();const started=Date.now();
  for(let i=0;i<3;i++){await sleep(500);await context.click({strategy:'testId',value:'advance'});}
  await sleep(Math.max(500,captureTargetMs-(Date.now()-started)));
  const capture=await context.stopRecording(),durationMs=Date.now()-started;
  assert.ok(capture.body.length>10000);assert.equal(capture.redactionPassed,true);
  const config=buildExporterConfig({width:1280,height:720,frameRate:30,durationMs,
    pointerTrail:context.pointerTrail(),pointerTelemetry:context.pointerTelemetry()},
    {wallpaper:'#102035',padding:20,borderRadius:12});
  await context.dispose();context=undefined;
  await mkdir('/tmp/recorder-pipeline',{recursive:true});
  const sourcePath='/tmp/recorder-pipeline/capture.mp4';await writeFile(sourcePath,capture.body);
  console.log(JSON.stringify({phase:'captured',durationMs,bytes:capture.body.length,
    memoryPeakBytes:await memoryPeakBytes()}));
  const output=await createRenderHost({browserBinary,bundleDirectory}).render({sourcePath,config,timeoutMs:11*60_000});
  assert.equal(output.status,'rendered',output.status==='failed'?output.reason:'render_failed');assert.ok(output.bytes.length>10000);
  const outputPath='/tmp/recorder-pipeline/rendered.mp4';await writeFile(outputPath,output.bytes);
  await run('ffmpeg',['-v','error','-i',outputPath,'-f','null','-'],{timeout:30000});
  console.log(JSON.stringify({phase:'rendered_and_decoded',bytes:output.bytes.length,
    memoryPeakBytes:await memoryPeakBytes(),output:outputPath}));
}finally{
  await context?.dispose().catch(()=>{});
  driver.kill('SIGTERM');
  if(driver.exitCode===null&&driver.signalCode===null)await new Promise(resolve=>driver.once('exit',resolve));
  site.closeAllConnections();await new Promise(resolve=>site.close(resolve));
}
