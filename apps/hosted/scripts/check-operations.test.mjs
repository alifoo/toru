import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {assessMetrics,checkOperations} from './check-operations.mjs';

const snapshot=()=>({version:1,observedAt:new Date().toISOString(),queue:{oldestWaitMs:0,expiredRunningLeases:0},
  storage:{availableBytes:768*1024**2},retainedJobs:{errorCodes:{}},
  retention:{lastCleanupSucceededAt:Date.now(),lastCleanupFailedAt:null}});
async function serve(handler,run){
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await run(`http://127.0.0.1:${server.address().port}`);}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('thresholds, freshness and malformed data fail closed',()=>{
  const body=snapshot();assert.deepEqual(assessMetrics(body),[]);
  body.queue={oldestWaitMs:480000,expiredRunningLeases:1};body.storage.availableBytes--;
  body.retainedJobs.errorCodes.server_restarted=3;
  assert.deepEqual(assessMetrics(body),['queue_wait_near_deadline','expired_running_leases','disk_below_admission_reserve','retained_restart_failures']);
  assert.ok(assessMetrics(body,Date.now()+120000).includes('metrics_clock_or_freshness'));
  for(const invalid of [null,{}, {...body,version:2},{...body,storage:{availableBytes:-1}}])assert.deepEqual(assessMetrics(invalid),['metrics_invalid']);
  assert.deepEqual(assessMetrics({...snapshot(),retention:{lastCleanupSucceededAt:Date.now()-301000,lastCleanupFailedAt:null}}),['retention_cleanup_stale']);
  assert.deepEqual(assessMetrics({...snapshot(),retention:{lastCleanupSucceededAt:Date.now()-1000,lastCleanupFailedAt:Date.now()}}),['retention_cleanup_failed']);
  assert.deepEqual(assessMetrics({...snapshot(),retention:undefined}),['metrics_invalid']);
});
test('alerts before the hosted daily render budget is exhausted',()=>{
  const body=snapshot();
  body.product={renderBudget:{dayUtc:new Date().toISOString().slice(0,10),
    limitMs:600000,usedAndReservedMs:479999,remainingMs:120001}};
  assert.deepEqual(assessMetrics(body),[]);
  body.product.renderBudget.usedAndReservedMs=480000;
  body.product.renderBudget.remainingMs=120000;
  assert.deepEqual(assessMetrics(body),['render_budget_near_limit']);
  body.product.renderBudget.usedAndReservedMs=600000;
  body.product.renderBudget.remainingMs=0;
  assert.deepEqual(assessMetrics(body),['render_budget_exhausted']);
  body.product.renderBudget.remainingMs=1;
  assert.deepEqual(assessMetrics(body),['metrics_invalid']);
  assert.deepEqual(assessMetrics({...snapshot(),product:{}}),['metrics_invalid']);
});
test('real HTTP checks authenticate metrics only and return no secret data',async()=>{
  await serve((req,res)=>{
    assert.equal(req.headers.authorization,req.url==='/admin/metrics'?'Bearer private-test-key':undefined);
    res.end(JSON.stringify(req.url==='/healthz'?{ok:true}:snapshot()));
  },async url=>assert.equal((await checkOperations({url,key:'private-test-key'})).ok,true));
});
test('does not follow credential-bearing redirects and reports safe failures',async()=>{
  let redirected=0;
  await serve((req,res)=>{if(req.url==='/leak'){redirected++;res.end('{}');return;}
    res.writeHead(302,{Location:'/leak'});res.end('private-test-key');
  },async url=>{
    const result=await checkOperations({url,key:'private-test-key'});
    assert.deepEqual(result.alerts,['health_unavailable','metrics_unavailable']);
    assert.doesNotMatch(JSON.stringify(result),/private-test-key|127\.0\.0\.1/);
  });assert.equal(redirected,0);
});
test('bounded responses and timeouts cannot hang monitoring',async()=>{
  await serve((_req,res)=>res.end('x'.repeat(262145)),async url=>{
    assert.equal((await checkOperations({url,key:'test'})).ok,false);
  });
  await serve(()=>{},async url=>{
    assert.deepEqual((await checkOperations({url,key:'test',timeoutMs:30})).alerts,['health_unavailable','metrics_unavailable']);
  });
});
test('rejects unsafe transport and URL credentials before network access',async()=>{
  for(const url of ['http://example.com','https://user:pass@example.com','https://example.com/?key=secret'])
    assert.deepEqual((await checkOperations({url,key:'test'})).alerts,['monitor_configuration_invalid']);
});
