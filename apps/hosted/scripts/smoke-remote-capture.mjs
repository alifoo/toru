// Synthetic public-page capture through the authenticated isolated worker.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {WebDriverBrowserDriver,FetchWebDriverTransport} from '../../../packages/browser/dist/index.js';

const endpoint=process.env.RECORDER_TEST_WORKER_URL;
const token=process.env.RECORDER_WORKER_TOKEN;
assert.ok(endpoint&&token,'worker endpoint and token required');
const transport=new FetchWebDriverTransport(endpoint,fetch,30_000,{authorization:`Bearer ${token}`});
const browser=new WebDriverBrowserDriver(transport,{
 chromeBinary:'/usr/bin/chromium',recordingFrameRate:60,
 chromeArguments:['--headless=new','--proxy-server=http://recorder-egress:37843',
  '--proxy-bypass-list=<-loopback>','--disable-quic'],
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let context;
try{
 context=await browser.createContext({viewport:{width:1280,height:720},
  allowedOrigins:['https://example.com','https://www.iana.org'],
  sessionState:new TextEncoder().encode(JSON.stringify({cookies:[],origins:[]})),
  onNavigation:()=>undefined,allowDownload:false,allowPopup:false});
 await context.goto('https://example.com');
 await context.redactSensitiveText();
 await context.startRecording();
 await sleep(700);
 await context.goto('https://www.iana.org/help/example-domains');
 await sleep(700);
 const capture=await context.stopRecording();
 assert.equal(capture.redactionPassed,true);
 assert.ok(capture.body.length>10_000);
 const decoded=spawnSync('ffmpeg',['-v','error','-i','pipe:0','-f','null','-'],{
  input:Buffer.from(capture.body),timeout:30_000,maxBuffer:1024*1024,
 });
 assert.equal(decoded.status,0,decoded.stderr?.toString().slice(0,300));
 console.log(JSON.stringify({phase:'remote_capture_decoded',bytes:capture.body.length}));
}finally{await context?.dispose().catch(()=>undefined);}
