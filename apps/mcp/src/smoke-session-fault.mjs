// External MCP client fault test: only the isolated launcher may kill/restart the server.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const phase=process.env.FAULT_PHASE;
assert.ok(['connection','capture'].includes(phase));assert.ok(process.send);
const url=new URL('/mcp',process.env.RECORDER_URL),token=process.env.RECORDER_TOKEN;
let client;
async function connect(){client=new Client({name:'session-fault-smoke',version:'1'});await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));}
async function call(name,args={}){const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result.content));return result.structuredContent;}
await connect();
try {
 const before=await call('account_usage');assert.equal(before.mode,'hosted');
 const requestId=randomUUID(),args={url:'https://www.selenium.dev/selenium/web/web-form.html',requestId};
 const opened=await call(phase==='connection'?'session_connect':'session_open',args),id=opened.id;
 if(phase==='capture') {
  await call('recording_start',{id});await call('browser_wait',{id,until:'duration',ms:1000});
  assert.equal((await call('recording_status',{id,waitMs:0})).status,'recording');
 }else{
  assert.equal((await call('connection_status',{id,waitMs:0})).connectionStatus,'waiting');
 }
 assert.equal((await call('account_usage')).reserved,before.reserved+1);
 await client.close();
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('restart_timeout')),45000);
  process.once('message',message=>{clearTimeout(timer);message?.type==='restarted'?resolve():reject(new Error('restart_failed'));});
  process.send({type:'restart'});
 });
 await connect();
 const recovered=await call('recording_status',{id,waitMs:0});
 assert.equal(recovered.status,'interrupted');assert.equal(recovered.errorCode,'server_restarted');
 const usage=await call('account_usage');
 assert.equal(usage.available,before.available);assert.equal(usage.reserved,before.reserved);assert.equal(usage.used,before.used);
 const repeated=await call(phase==='connection'?'session_connect':'session_open',args);
 assert.equal(repeated.id,id);assert.equal(repeated.status,'interrupted');
 const fresh=await call('session_open',{...args,requestId:randomUUID()});assert.notEqual(fresh.id,id);
 await call('session_close',{id:fresh.id});
 const final=await call('account_usage');assert.equal(final.available,before.available);assert.equal(final.reserved,0);
 console.log(JSON.stringify({phase,recovered:recovered.status,retryIdPreserved:true,freshSessionOpened:true,available:final.available,used:final.used,reserved:final.reserved}));
}finally{await client.close();}
