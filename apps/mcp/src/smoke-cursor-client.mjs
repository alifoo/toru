// Real Cursor CLI transport check. Uses an isolated home/project and makes no model call.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createMcpServer} from '../dist/server.js';
import {revokeInvites} from '../dist/invites.js';

const exec=promisify(execFile),work=await mkdtemp(join(tmpdir(),'recorder-cursor-client-'));
const data=join(work,'data'),home=join(work,'home'),project=join(work,'project');
for(const path of [data,home,project,join(project,'.cursor')])await mkdir(path,{mode:0o700});
const owner=randomUUID(),token=randomBytes(32).toString('base64url');
await writeFile(join(data,'invites.json'),JSON.stringify({invites:[{
  owner,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+300_000
}]}),{mode:0o600});
let toolCalls=0;
const unexpected=async()=>{toolCalls++;throw new Error('no_browser_or_model_calls_in_health_check');};
const server=createMcpServer({dataDir:data,publicUrl:'http://127.0.0.1',
  recorder:{call:unexpected,artifact:unexpected,importSession:unexpected}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/mcp`;
await writeFile(join(project,'.cursor','mcp.json'),JSON.stringify({mcpServers:{'recorder-smoke':{
  url,headers:{Authorization:`Bearer ${token}`}
}}}),{mode:0o600});
const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config'),DISABLE_TELEMETRY:'1'};
const run=args=>exec('cursor',['agent',...args],{cwd:project,env,timeout:30_000,maxBuffer:1024*1024});
try{
  const version=(await run(['--version'])).stdout.match(/\d{4}\.\d{2}\.\d{2}-[a-f0-9]+/)?.[0];
  assert.ok(version);
  await run(['mcp','enable','recorder-smoke']);
  const listed=(await run(['mcp','list'])).stdout;
  assert.match(listed,/recorder-smoke:\s*ready/);
  const tools=(await run(['mcp','list-tools','recorder-smoke'])).stdout;
  assert.match(tools,/account_usage/);
  assert.match(tools,/session_open/);
  await revokeInvites(data,{owner});
  const revoked=(await run(['mcp','list'])).stdout;
  assert.ok(!/recorder-smoke:\s*ready/.test(revoked));
  assert.equal(toolCalls,0);
  console.log(JSON.stringify({client:version,connected:true,toolsDiscovered:true,
    revokedGrantRejected:true,toolCalls,modelCalls:0,userConfigChanged:false}));
}finally{
  await new Promise(resolve=>server.close(resolve));
  await rm(work,{recursive:true,force:true});
}
