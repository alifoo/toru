// Synthetic media fixture, real hosted entrypoint/HTTP/SQLite restore enforcement. No model/payment calls.
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {Recorder} from '@agent-recorder/mcp/recorder';
import {createHostedLifecycle} from '@agent-recorder/hosted-policy/dist/adapter.js';
import {recordDeletion} from '@agent-recorder/hosted-policy/dist/deletion-journal.js';
assert.ok(process.env.CHROMEDRIVER_BINARY&&process.env.RENDER_BROWSER_BINARY,'Set browser binary paths');
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
const work=await mkdtemp(join(tmpdir(),'recorder-erasure-startup-')),source=join(work,'source'),restored=join(work,'restored'),journal=join(work,'journal');
const onlineOwner=randomUUID(),untouchedOwner=randomUUID(),admin=randomBytes(32).toString('base64url');
const owner=randomUUID(),token=randomBytes(32).toString('base64url'),key=randomBytes(32);
const driver={goto:async()=>{},dispose:async()=>{},startRecording:async()=>{},recordingMode:'screencast',redactSensitiveText:async()=>{},stopRecording:async()=>({body:Buffer.from('synthetic raw'),redactionPassed:true}),screenshot:async()=>({body:Buffer.from('synthetic preview'),redactionPassed:true})};
const recorder=new Recorder({dataDir:source,encryptionKey:key,lifecycle:createHostedLifecycle,createContext:async()=>driver,render:async()=>Buffer.from('synthetic MP4')});
let child;
async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await done;}
try{
 await recorder.initialize();
 const id=(await recorder.call(owner,'session_open',{url:'https://example.com',requestId:randomUUID()})).structuredContent.id;
 await recorder.call(owner,'recording_start',{id});await recorder.call(owner,'recording_stop',{id});
 const fixtures=new Map();
 for(const account of [onlineOwner,untouchedOwner]){
  const job=(await recorder.call(account,'session_open',{url:'https://example.com',requestId:randomUUID()})).structuredContent.id;
  await recorder.call(account,'recording_start',{id:job});await recorder.call(account,'recording_stop',{id:job});fixtures.set(account,job);
 }
 await recorder.close();
 const db=new DatabaseSync(join(source,'recorder.sqlite'));
 try{db.prepare('INSERT INTO grants(token_hash,owner,expires_at,created_at) VALUES (?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),owner,Date.now()+60000,Date.now());}finally{db.close();}
 await cp(source,restored,{recursive:true});await recordDeletion(journal,source,owner);
 const port=await freePort(),driverPort=await freePort(),url=`http://127.0.0.1:${port}`;
 const env={...process.env,INVITE_ADMIN_KEY:admin,DATA_DIR:restored,HOSTED_DELETION_JOURNAL:journal,HOSTED_USAGE_COHORT:'fixture',RECORDER_ENVIRONMENT:'local',RECORDER_INSTANCE_ID:'local',PUBLIC_URL:url,PORT:String(port),CHROMEDRIVER_PORT:String(driverPort),SESSION_ENCRYPTION_KEY:key.toString('base64')};
 child=spawn(process.execPath,['apps/hosted/dist/index.js'],{env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',part=>{logs+=part;});child.stderr.on('data',part=>{logs+=part;});
 let ready=false;
 for(let i=0;i<100;i++){
  assert.equal(child.exitCode,null,'hosted startup failed');
  try{ready=(await fetch(`${url}/healthz`,{signal:AbortSignal.timeout(500)})).ok;}catch{}
  if(ready)break;await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'hosted startup timed out');
 assert.equal((await fetch(`${url}/mcp`,{headers:{authorization:`Bearer ${token}`}})).status,401);
 await assert.rejects(readFile(join(restored,'jobs',id,'raw.webm')),{code:'ENOENT'});
 const restoredDb=new DatabaseSync(join(restored,'recorder.sqlite'));
 try{assert.equal(restoredDb.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner).admission_status,'deleted');}finally{restoredDb.close();}
 // Exercise the actual private adapter -> journal -> runtime coordinator over HTTP.
 const remove=confirmation=>fetch(`${url}/admin/account-data`,{method:'DELETE',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},body:JSON.stringify({owner:onlineOwner,confirmOwner:confirmation}),signal:AbortSignal.timeout(45000)});
 assert.equal((await fetch(`${url}/admin/account-data`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({owner:onlineOwner,confirmOwner:onlineOwner})})).status,404);
 assert.equal((await remove(owner)).status,400);
 assert.ok((await readFile(join(restored,'jobs',fixtures.get(onlineOwner),'raw.webm'))).length);
 const removed=await remove(onlineOwner);assert.equal(removed.status,200);assert.equal(removed.headers.get('cache-control'),'private, no-store');
 assert.equal((await removed.json()).state,'data_removed');
 assert.equal((await (await remove(onlineOwner)).json()).state,'data_removed');
 await assert.rejects(readFile(join(restored,'jobs',fixtures.get(onlineOwner),'raw.webm')),{code:'ENOENT'});
 assert.ok((await readFile(join(restored,'jobs',fixtures.get(untouchedOwner),'raw.webm'))).length);
 assert.equal(JSON.parse(await readFile(join(journal,`${onlineOwner}.json`),'utf8')).owner,onlineOwner);
 const checked=new DatabaseSync(join(restored,'recorder.sqlite'));
 try{
  assert.equal(checked.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(onlineOwner).admission_status,'deleted');
  assert.notEqual(checked.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(untouchedOwner).admission_status,'deleted');
  assert.equal(checked.prepare('SELECT count(*) n FROM jobs WHERE owner=?').get(onlineOwner).n,0);
 }finally{checked.close();}
 assert.equal((await fetch(`${url}/healthz`)).status,200);
 await stop();
 await writeFile(join(journal,`${owner}.json`),'incomplete journal entry');
 logs='';child=spawn(process.execPath,['apps/hosted/dist/index.js'],{env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',part=>{logs+=part;});child.stderr.on('data',part=>{logs+=part;});
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('corrupt_journal_startup_hung')),10000);child.once('exit',value=>{clearTimeout(timer);resolve(value);});});
 assert.notEqual(code,0);assert.ok(!logs.includes('Agent recorder listening'));
 console.log(JSON.stringify({onlineDeletionCompleted:true,onlineDeletionRetrySafe:true,otherAccountPreserved:true,restoredOwnerDenied:true,restoredMediaRemoved:true,corruptJournalBlocksStartup:true,diagnostics:work}));
}finally{await stop();await recorder.close();}
