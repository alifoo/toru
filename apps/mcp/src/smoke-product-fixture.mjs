// External MCP client: login -> sheet -> ICP search -> add person -> simulated enrichment -> MP4.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base=process.env.PRODUCT_FIXTURE_URL?.replace(/\/$/,'');
const password=process.env.PRODUCT_FIXTURE_PASSWORD;
const recorder=process.env.RECORDER_URL,token=process.env.RECORDER_TOKEN;
if(!base||new URL(base).protocol!=='https:'||!password||!recorder||!token)
  throw new Error('product_fixture_smoke_configuration_missing');
const client=new Client({name:'product-fixture-smoke',version:'1.0'});
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',recorder),{
  requestInit:{headers:{Authorization:`Bearer ${token}`}},
}));
let id;
async function call(name,args){
  const result=await client.callTool({name,arguments:args});
  if(result.isError)throw new Error(`mcp_${name}_failed:${JSON.stringify(result.content)}`);
  return result.structuredContent??result;
}
function ref(page,role,name){
  const line=page.split('\n').find(value=>value.includes(role)&&value.includes(`"${name}"`));
  const match=line?.match(/\[(ref_\d+)\]/);
  if(!match)throw new Error(`fixture_control_missing:${role}:${name}`);
  return match[1];
}
async function observeUntil(text){
  let last;
  for(let attempt=0;attempt<40;attempt++){
    const observed=await call('browser_observe',{id,mode:'outline'});
    last=observed;
    if(observed.page.includes(text))return observed;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  console.log(JSON.stringify({phase:'fixture_state_diagnostic',wanted:text,url:last?.url,
    page:last?.page?.replaceAll(password,'[REDACTED]').slice(0,1500)}));
  throw new Error(`fixture_state_missing:${text}`);
}
async function typeAndClick(inputName,buttonName,value){
  const page=(await observeUntil(`"${inputName}"`)).page;
  await call('browser_type',{id,ref:ref(page,'input:',inputName),text:value});
  await call('browser_click',{id,ref:ref(page,'button',buttonName)});
}
async function click(role,name){
  const page=(await observeUntil(`"${name}"`)).page;
  await call('browser_click',{id,ref:ref(page,role,name)});
}
try{
  const before=await call('account_usage',{});
  const opened=await call('session_open',{url:`${base}/login`,allowedOrigins:[base],requestId:randomUUID()});
  id=opened.id;
  const loginPage=await call('browser_observe',{id,mode:'outline'});
  if(loginPage.page.includes('button "Visit Site"'))
    await call('browser_click',{id,ref:ref(loginPage.page,'button','Visit Site')});
  await typeAndClick('Demo password','Sign in',password);
  await observeUntil('"New sheet name"');
  await call('recording_start',{id});
  await typeAndClick('New sheet name','Create sheet','RevOps SaaS Brazil');
  await click('link','Find people for this sheet');
  await typeAndClick('Search ICP','Search people','revops saas');
  await click('button','Add Camila Rocha to sheet');
  await click('button','Add work email enrichment');
  await click('button','Run enrichment');
  const result=await observeUntil('camila.rocha@example.test');
  assert.match(result.page,/Run complete/);
  await call('mark_demo_moment',{id,kind:'result',note:'Synthetic work email appears after Run',observationId:result.observationId});
  await call('browser_wait',{id,until:'duration',ms:2000});
  await call('recording_stop',{id});
  await call('recording_render',{id,requestId:randomUUID(),padding:40,background:'ocean'});
  let status;
  // Hosted renders have a ten-minute deadline; leave room for delivery after it.
  for(let attempt=0;attempt<720;attempt++){
    status=await call('recording_status',{id,waitMs:1000});
    if(status.status==='completed')break;
    if(status.status!=='rendering')throw new Error(`fixture_render_${status.status}`);
  }
  assert.equal(status.status,'completed');
  const links=await call('recording_links',{id});
  const video=await fetch(links.videoUrl);
  assert.equal(video.status,200);
  const bytes=Buffer.from(await video.arrayBuffer());
  assert.ok(bytes.length>10000);
  const output=process.env.SMOKE_OUTPUT??'/tmp/agent-recorder-product-fixture.mp4';
  await writeFile(output,bytes);
  const after=await call('account_usage',{});
  assert.equal(after.used,before.used+1);assert.equal(after.reserved,0);assert.equal(after.available,before.available-1);
  console.log(JSON.stringify({phase:'product_fixture_mcp_video_delivered',id,durationMs:status.durationMs,bytes:bytes.length,
    credits:{available:after.available,used:after.used,reserved:after.reserved},output}));
}finally{
  if(id)await call('session_close',{id}).catch(()=>undefined);
  await client.close();
}
