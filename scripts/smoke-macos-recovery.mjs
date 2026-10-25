// Actual Swift retry against HTTP/SQLite, with a resumed MP4 and one lost publication response.
// No ScreenCaptureKit permission, installed app replacement, production endpoint or paid service.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {Recorder} from '../apps/mcp/dist/recorder.js';
import {LocalBrowserBridge} from '../apps/mcp/dist/local-browser.js';
import {openRecorderStore} from '../apps/mcp/dist/store/open.js';
import {DesktopDeviceStore} from '../apps/mcp/dist/store/desktop-devices.js';
import {DesktopUploadStore} from '../apps/mcp/dist/store/desktop-uploads.js';
import {createHostedLifecycle} from '../packages/hosted-policy/dist/adapter.js';
import {createRenderHost,resolveBrowserBinary} from '../packages/render-host/dist/index.js';
const run=(cmd,args)=>new Promise((resolve,reject)=>{
 const child=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(Error(`${cmd} failed (${code}): ${output}`)));
});
const root=await mkdtemp(join(tmpdir(),'toru-native-recovery-')),dataDir=join(root,'backend');
let recorder,bridge,server;
try {
 const id=randomUUID(),owner=randomUUID(),now=Date.now(),db=await openRecorderStore(dataDir);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,now);
 const identity=new DesktopDeviceStore(db).register(owner,'Recovery test Mac');
 const lifecycle=createHostedLifecycle(db);
 const job={id,owner,status:'recording',createdAt:now,expiresAt:now+3600000,allowedOrigins:[],desktopDeviceId:identity.deviceId,privacyMode:'user-approved-unredacted',rawFile:'raw.mp4'};
 db.transaction(()=>{
  job.policy=lifecycle.admit(job,randomUUID(),'a'.repeat(64));
  db.connection.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(id,owner,job.status,job.createdAt,job.expiresAt,JSON.stringify(job));
 });
 const captures=join(root,'captures');await mkdir(captures);
 const file=join(captures,`Toru-${id.toUpperCase()}.mp4`);
 await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=60','-t','2','-c:v','libx264','-pix_fmt','yuv420p',file]);
 const bytes=await readFile(file),uploads=new DesktopUploadStore(db,dataDir);
 await uploads.begin(owner,identity.deviceId,id,bytes.length,createHash('sha256').update(bytes).digest('hex'),{width:1280,height:720,durationMs:2000});
 await uploads.append(owner,identity.deviceId,id,0,bytes.subarray(0,Math.floor(bytes.length/2)));db.close();
 const host=createRenderHost({browserBinary:await resolveBrowserBinary()});
 recorder=new Recorder({dataDir,encryptionKey:randomBytes(32),lifecycle:createHostedLifecycle,
  createContext:async()=>{throw Error('capture_must_not_restart');},
  render:async(sourcePath,config,signal,onProgress)=>{
   const result=await host.render({sourcePath,config,signal,onProgress});if(result.status!=='rendered')throw Error(result.reason);return result.bytes;
  }});
 await recorder.initialize();
 assert.equal((await recorder.call(owner,'recording_status',{id})).structuredContent.status,'interrupted');
 assert.equal((await recorder.call(owner,'account_usage',{})).structuredContent.reserved,0);
 let publications=0,requests=[];
 bridge=new LocalBrowserBridge(dataDir,(...args)=>recorder.recoverDesktopUpload(...args));
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push(url.pathname);
  try {
   if(url.pathname.endsWith('/publish')&&++publications===1){
    // Commit first, then lose the HTTP response. Swift must retry this same capture.
    const original=res.end.bind(res);res.end=()=>{res.destroy();return res;};
    await bridge.http(req,res,url);res.end=original;return;
   }
   if(!await bridge.http(req,res,url)){res.writeHead(404);res.end();}
  }catch{res.writeHead(500);res.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 await writeFile(join(root,'identity.json'),JSON.stringify(identity),{mode:0o600});
 await writeFile(join(captures,`${id.toUpperCase()}.json`),JSON.stringify({id:id.toUpperCase(),createdAt:now/1000-978307200,stage:'uploading',durationMs:2000,width:1280,height:720,serverOrigin:origin,deviceId:identity.deviceId}),{mode:0o600});
 const binary=join(root,'retry-test'),sources=(await readdir('apps/macos/Sources')).filter(x=>x.endsWith('.swift')).map(x=>resolve('apps/macos/Sources',x));
 await run('swiftc',['-D','TORU_TESTING','-parse-as-library','-swift-version','5',...sources,resolve('apps/macos/Tests/CaptureRetryTests.swift'),'-o',binary,'-framework','SwiftUI','-framework','ScreenCaptureKit','-framework','AVFoundation','-framework','AppKit','-framework','Security']);
 console.log((await run(binary,['--server',origin,'--fixture',root])).trim());
 assert.equal(publications,2);assert.ok(!requests.some(x=>/\/(ready|device\/resume|poll)$/.test(x)));
 assert.deepEqual(await readFile(join(dataDir,'jobs',id,'raw.mp4')),bytes);
 await recorder.call(owner,'recording_render',{id,requestId:randomUUID()});
 let status;
 for(let i=0;i<24;i++){status=(await recorder.call(owner,'recording_status',{id,waitMs:25000})).structuredContent;if(status.status==='completed')break;if(status.errorCode)throw Error(status.errorCode);}
 assert.equal(status.status,'completed');
 await run('ffmpeg',['-v','error','-i',(await recorder.artifact(owner,id,'video')).path,'-f','null','-']);
 const usage=(await recorder.call(owner,'account_usage',{})).structuredContent;
 assert.equal(usage.used,1);assert.equal(usage.reserved,0);assert.equal(usage.available,9);
 console.log('PASS: native resumed upload, lost response, real MP4 render/decode, one credit, preserved local source');
} finally {
 bridge?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await recorder?.close();await rm(root,{recursive:true,force:true});
}
