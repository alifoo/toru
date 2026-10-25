// Ten independent HTTP MCP clients; real browser sessions, no model calls or payments.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const tokens=JSON.parse(process.env.RECORDER_SMOKE_TOKENS ?? '[]');
assert.equal(tokens.length,10);
const clients=[];
const url='https://www.selenium.dev/selenium/web/web-form.html';
async function raw(index,name,args={}){return clients[index].callTool({name,arguments:args});}
async function call(index,name,args={}){const value=await raw(index,name,args);assert.ok(!value.isError,JSON.stringify(value.content));return value.structuredContent;}
try {
  for(const token of tokens){
    const client=new Client({name:'queue-load-smoke',version:'1'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',process.env.RECORDER_URL),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  }
  const balances=await Promise.all(clients.map((_,i)=>call(i,'account_usage')));
  assert.ok(balances.every(value=>value.mode==='hosted'&&value.available===10&&value.reserved===0));
  const blocker=await call(0,'session_open',{url,requestId:randomUUID()});
  const queued=[];
  for(let i=1;i<10;i++){
    const args={version:1,operation:'session_open',requestId:randomUUID(),arguments:{url}};
    const entry=await call(i,'queue_enqueue',args);assert.equal(entry.state,'queued');
    const repeated=await call(i,'queue_enqueue',args);assert.equal(repeated.jobId,entry.jobId);
    queued.push({index:i,jobId:entry.jobId});
  }
  assert.ok((await raw(1,'queue_status',{jobId:queued[1].jobId})).isError,'cross-owner queue visibility');
  const waiting=await Promise.all(queued.map(({index})=>call(index,'account_usage')));
  assert.ok(waiting.every(value=>value.reserved===0&&value.used===0&&value.available===10));
  const canceled=queued.pop();
  assert.equal((await call(canceled.index,'queue_cancel',{jobId:canceled.jobId})).state,'canceled');
  await call(0,'session_close',{id:blocker.id});
  const served=[];
  for(const expected of queued){
    const deadline=Date.now()+45000;let ready;
    while(Date.now()<deadline){
      const states=await Promise.all(queued.map(({index,jobId})=>call(index,'queue_status',{jobId})));
      const active=states.filter(value=>value.state==='running');assert.ok(active.length<=1,'multiple running queue slots');
      const current=states.find(value=>value.jobId===expected.jobId);
      assert.ok(!['failed','interrupted','expired'].includes(current.state),JSON.stringify(current));
      if(active.length)assert.equal(active[0].jobId,expected.jobId,'FIFO fairness violated');
      if(current.result?.status==='ready'){ready=current.result;break;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,'queued browser did not become ready');
    assert.equal((await call(expected.index,'account_usage')).reserved,1);
    await call(expected.index,'queue_cancel',{jobId:expected.jobId});
    for(let tries=0;;tries++){
      const state=await call(expected.index,'queue_status',{jobId:expected.jobId});
      if(state.state==='canceled')break;
      assert.ok(tries<150,'cancel did not tear down browser');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    served.push(expected.index);
  }
  const final=await Promise.all(clients.map((_,i)=>call(i,'account_usage')));
  assert.ok(final.every(value=>value.available===10&&value.used===0&&value.reserved===0));
  console.log(JSON.stringify({clients:10,served,waitingCanceled:1,realBrowserSessions:9,duplicateRequestsDeduplicated:true,ownerIsolation:true,creditsReleased:true}));
}finally{await Promise.allSettled(clients.map(client=>client.close()));}
