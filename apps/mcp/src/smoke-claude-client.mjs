// Real Claude Code transport health check. Does not run a model or change the user's client configuration.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createMcpServer} from '../dist/server.js';
import {revokeInvites} from '../dist/invites.js';
const exec=promisify(execFile),work=await mkdtemp(join(tmpdir(),'recorder-claude-client-'));
const data=join(work,'data'),config=join(work,'config'),project=join(work,'project');
for(const path of [data,config,project])await mkdir(path,{mode:0o700});
const owner=randomUUID(),token=randomBytes(32).toString('base64url');
await writeFile(join(data,'invites.json'),JSON.stringify({invites:[{owner,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+60000}]}),{mode:0o600});
let toolCalls=0;
const unexpected=async()=>{toolCalls++;throw new Error('no_browser_or_model_calls_in_health_check');};
const server=createMcpServer({dataDir:data,publicUrl:'http://127.0.0.1',recorder:{call:unexpected,artifact:unexpected,importSession:unexpected}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/mcp`;
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CLAUDE_CONFIG_DIR:config,RECORDER_TEST_TOKEN:token,DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'};
const run=args=>exec('claude',args,{cwd:project,env,timeout:20000,maxBuffer:1024*1024});
try{
 const version=(await run(['--version'])).stdout.trim();
 await run(['mcp','add','--scope','user','--transport','http','recorder-smoke',url,'--header','Authorization: Bearer ${RECORDER_TEST_TOKEN}']);
 const healthy=(await run(['mcp','list'])).stdout;
 assert.match(healthy,/recorder-smoke:.*[✓✔] Connected/);
 await revokeInvites(data,{owner});
 const revoked=(await run(['mcp','list'])).stdout;
 assert.ok(!/recorder-smoke:.*[✓✔] Connected/.test(revoked));
 assert.equal(toolCalls,0);
 console.log(JSON.stringify({client:version,connected:true,revokedGrantRejected:true,toolCalls,modelCalls:0,userConfigChanged:false}));
}finally{
 await new Promise(resolve=>server.close(resolve));await rm(work,{recursive:true,force:true});
}
