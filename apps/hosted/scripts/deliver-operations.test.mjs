import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deliverOperationalAlerts} from './deliver-operations.mjs';

const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const snapshot=waitMs=>({version:1,observedAt:new Date().toISOString(),
  queue:{oldestWaitMs:waitMs,expiredRunningLeases:0},storage:{availableBytes:1024**3},
  retention:{lastCleanupSucceededAt:Date.now(),lastCleanupFailedAt:null},
  retainedJobs:{errorCodes:{}}});
const input=statePath=>({recorderUrl:'http://127.0.0.1:43100',key:'monitor-secret',
  webhookUrl:'http://127.0.0.1:43101/notify',deployment:'staging',statePath});

test('delivers one incident per changed code set and one recovery, without leaking monitor credentials',async()=>{
  let waitMs=0;const received=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith('/healthz'))return json({ok:true});
    if(String(url).endsWith('/admin/metrics')){
      assert.equal(options.headers.Authorization,'Bearer monitor-secret');return json(snapshot(waitMs));
    }
    received.push(JSON.parse(options.body));return new Response('ok');
  };
  const directory=await mkdtemp(join(tmpdir(),'recorder-alert-delivery-'));
  try {
    const config=input(join(directory,'state.json'));
    assert.deepEqual(await deliverOperationalAlerts(config),{state:'unchanged',alerts:[]});
    waitMs=480_000;
    assert.deepEqual(await deliverOperationalAlerts(config),{state:'delivered',alerts:['queue_wait_near_deadline'],resolved:[]});
    assert.deepEqual(await deliverOperationalAlerts(config),{state:'unchanged',alerts:['queue_wait_near_deadline']});
    waitMs=0;
    assert.deepEqual(await deliverOperationalAlerts(config),{state:'delivered',alerts:[],resolved:['queue_wait_near_deadline']});
    assert.equal(received.length,2);
    assert.deepEqual(received.map(value=>value.active),[['queue_wait_near_deadline'],[]]);
    assert.deepEqual(received[1].resolved,['queue_wait_near_deadline']);
    assert.doesNotMatch(JSON.stringify(received),/monitor-secret|127\.0\.0\.1/);
    assert.deepEqual(JSON.parse(await readFile(config.statePath,'utf8')).alerts,[]);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('failed delivery retains the incident for retry',async()=>{
  let attempts=0;const original=globalThis.fetch;
  globalThis.fetch=async(url)=>{
    if(String(url).endsWith('/healthz'))return json({ok:true});
    if(String(url).endsWith('/admin/metrics'))return json({ok:true});
    attempts++;return new Response('',{status:attempts===1?503:200});
  };
  const directory=await mkdtemp(join(tmpdir(),'recorder-alert-retry-'));
  try {
    const config=input(join(directory,'state.json'));
    await assert.rejects(deliverOperationalAlerts(config),/alert_delivery_failed/);
    assert.deepEqual((await deliverOperationalAlerts(config)).alerts,['metrics_invalid']);
    assert.equal(attempts,2);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('rejects unsafe webhook transport and corrupt state',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'recorder-alert-state-'));
  try {
    const statePath=join(directory,'state.json'),config=input(statePath);
    await assert.rejects(deliverOperationalAlerts({...config,webhookUrl:'http://example.com/hook'}),/alert_configuration_invalid/);
    await assert.rejects(deliverOperationalAlerts({...config,webhookUrl:'https://user:pass@example.com/hook'}),/alert_configuration_invalid/);
    await assert.rejects(deliverOperationalAlerts({...config,deployment:'bad label'}),/alert_configuration_invalid/);
    await writeFile(statePath,'{');
    await assert.rejects(deliverOperationalAlerts(config),/alert_state_invalid/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
