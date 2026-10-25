import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRailwayBrowserAllocator} from '../dist/railway-browser.js';
import {createWorkerRelay} from '../dist/worker-relay.js';

const image=`sha256:${'a'.repeat(64)}`;
const address='fd12afd8fa3b0001d000003fefe118b1 05 40 00 80 eth0\n';

test('per-session VM allocation requires a pinned image, private address and teardown',async()=>{
 const commands=[],journalEvents=[];let destroyed=0,issuedToken,seenUrl,seenAuthorization;
 const sandbox={
  id:'123e4567-e89b-12d3-a456-426614174004',
 exec(command){
   commands.push(command);
   if(command.startsWith('cat '))return Promise.resolve({exitCode:0,timedOut:false,truncated:false,stdout:address});
   if(command.startsWith('docker inspect ')){
    const network=commands.find(item=>item.startsWith('docker network create ')).split(' ').at(-1);
    return Promise.resolve({exitCode:0,timedOut:false,truncated:false,stdout:JSON.stringify({[network]:{IPAddress:'172.18.0.3'}})});
   }
   return Promise.resolve({exitCode:0,timedOut:false,truncated:false,stdout:''});
  },
  async destroy(){destroyed++;},
 };
 const allocate=createRailwayBrowserAllocator({checkpoint:'recorder-worker-rc1',image,
  createSandbox:async token=>{issuedToken=token;return sandbox;},
  journal:{track:async id=>{journalEvents.push(`track:${id}`);},
   untrack:async id=>{journalEvents.push(`untrack:${id}`);},recover:async()=>{}},
  fetchImplementation:async(input,init)=>{
   seenUrl=String(input);seenAuthorization=init.headers.authorization;
   return new Response('{"value":{"ready":true}}',{status:200});
  },
 });
 const lease=await allocate();
 assert.equal(lease.token,issuedToken);
 assert.equal(seenAuthorization,`Bearer ${issuedToken}`);
 assert.equal(seenUrl,`${lease.endpoint}/status`);
 assert.equal(new URL(lease.endpoint).origin,'http://[fd12:afd8:fa3b:1:d000:3f:efe1:18b1]:37842');
 assert.match(commands[1],/^docker network create --internal --driver bridge recorder-internal-/);
 const browser=commands.find(command=>command.includes('browser-worker.js'));
 const egress=commands.find(command=>command.includes('egress-worker.js'));
 const relay=commands.find(command=>command.includes('worker-relay.js'));
 assert.match(browser,/--network recorder-internal-[a-f0-9]+ --network-alias recorder-browser/);
 assert.match(browser,/--cap-drop ALL --cap-add SYS_CHROOT/);
 assert.match(browser,/--security-opt seccomp=\/opt\/recorder\/seccomp.json/);
 for(const command of [browser,egress,relay])assert.match(command,/--entrypoint node sha256:[a-f0-9]{64} \/app\/apps\/hosted\/dist\/[a-z-]+\.js$/);
 assert.doesNotMatch(browser,/--network bridge|--publish|--no-sandbox|--privileged|--volume|--mount/);
 assert.match(egress,/--network bridge/);
 assert.match(relay,/--network host/);
 assert.match(relay,/--env RECORDER_RELAY_HOST=172\.18\.0\.3 --env RECORDER_RELAY_PORT=37842/);
 assert.doesNotMatch(relay,/--publish/);
 assert.ok(commands.some(command=>command.includes('docker network connect --alias recorder-egress')));
 assert.ok(commands.some(command=>command.startsWith('docker inspect recorder-browser-')));
 assert.ok(commands.every(command=>!command.includes(issuedToken)));
 await lease.close();await lease.close();assert.equal(destroyed,1);
 assert.deepEqual(journalEvents,[`track:${sandbox.id}`,`untrack:${sandbox.id}`]);
});

test('relay accepts only the fixed browser name or a private Docker IPv4 target',()=>{
 createWorkerRelay('recorder-browser');createWorkerRelay('172.18.0.3');
 for(const host of ['127.0.0.1','169.254.169.254','8.8.8.8','example.com','[::1]'])
  assert.throws(()=>createWorkerRelay(host),/invalid_worker_relay_target/);
});

test('transient VM destruction and journal failures can be retried without losing cleanup',async()=>{
 let destroys=0,untracks=0,network;
 const sandbox={id:'123e4567-e89b-12d3-a456-426614174005',
  exec:async command=>{
   if(command.startsWith('docker network create '))network=command.split(' ').at(-1);
   return {exitCode:0,timedOut:false,truncated:false,
    stdout:command.startsWith('cat ')?address:command.startsWith('docker inspect ')?
     JSON.stringify({[network]:{IPAddress:'172.18.0.3'}}):''};
  },
  async destroy(){if(++destroys===1)throw new Error('provider_unavailable');},
 };
 const allocate=createRailwayBrowserAllocator({checkpoint:'recorder-worker-rc1',image,
  createSandbox:async()=>sandbox,
  journal:{track:async()=>{},untrack:async()=>{if(++untracks===1)throw new Error('journal_unavailable');},recover:async()=>{}},
  fetchImplementation:async()=>new Response('{}',{status:200}),
 });
 const lease=await allocate();
 await assert.rejects(lease.close(),/provider_unavailable/);
 await assert.rejects(lease.close(),/journal_unavailable/);
 await Promise.all([lease.close(),lease.close()]);
 assert.equal(destroys,2);assert.equal(untracks,2);
});

test('an unusable private VM is destroyed before a browser session starts',async()=>{
 let destroyed=0;
 const allocate=createRailwayBrowserAllocator({checkpoint:'recorder-worker-rc1',image,
  createSandbox:async()=>({exec:async()=>({exitCode:0,timedOut:false,truncated:false,stdout:'::1'}),
   destroy:async()=>{destroyed++;}}),
 });
 await assert.rejects(allocate(),/browser_worker_private_address_unavailable/);
 assert.equal(destroyed,1);
});

test('mutable image references are refused before VM creation',()=>{
 assert.throws(()=>createRailwayBrowserAllocator({checkpoint:'recorder-worker-rc1',image:'worker:latest'}),
  /browser_worker_image_must_be_pinned/);
});
