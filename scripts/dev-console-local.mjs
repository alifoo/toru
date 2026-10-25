// Isolated local console + hosted backend. Uses Clerk development credentials only.
import {spawnLocalCommand,stopLocalCommand} from '../apps/hosted/scripts/local-process.mjs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseEnv} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
const config=parseEnv(await readFile(process.env.LOCAL_CONSOLE_CLERK_ENV_FILE??'apps/console/.env.local','utf8'));
const clerkSecret=config.CLERK_SECRET_KEY;
const clerkPublishable=config.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY??config.CLERK_PUBLISHABLE_KEY;
if(!clerkSecret?.startsWith('sk_test_')||!clerkPublishable?.startsWith('pk_test_'))throw new Error('local_console_requires_clerk_development_keys');
if(!process.env.CHROMEDRIVER_BINARY||!process.env.RENDER_BROWSER_BINARY)throw new Error('browser_and_driver_paths_required');
const directory=await mkdtemp(join(tmpdir(),'recorder-console-'));
const deletionJournal=await mkdtemp(join(tmpdir(),'recorder-console-deletions-'));
const url='http://127.0.0.1:43172',admin=randomBytes(32).toString('base64url');
const children=[];
function launch(command,args,env){const child=spawnLocalCommand(command,args,env,{graceMs:command===process.execPath?30000:2000});children.push(child);return child;}
let closing;
function stop(){return closing??=Promise.all(children.map(stopLocalCommand));}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
try {
 const backend=launch(process.execPath,['apps/hosted/dist/index.js'],{...process.env,RECORDER_ENVIRONMENT:'local',PUBLIC_URL:url,PORT:'43172',DATA_DIR:directory,HOSTED_DELETION_JOURNAL:deletionJournal,INVITE_ADMIN_KEY:admin,SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),HOSTED_BETA_CAPACITY:'25',HOSTED_USAGE_COHORT:'internal'});
 let ready=false;
 for(let i=0;i<100;i++){if(closing)throw new Error('local_shutdown_requested');if(backend.exitCode!==null||backend.signalCode!==null)throw new Error('local_backend_exited');try{if((await fetch(`${url}/healthz`,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
 if(!ready)throw new Error('local_backend_timeout');
 if(closing)throw new Error('local_shutdown_requested');
 const console=launch('pnpm',['--filter','@agent-recorder/console','dev','--port','3033'],{...process.env,CLERK_SECRET_KEY:clerkSecret,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:clerkPublishable,RECORDER_URL:url,NEXT_PUBLIC_RECORDER_URL:url,RECORDER_ADMIN_KEY:admin});
 process.stdout.write(`Local console: http://localhost:3033\nIsolated data: ${directory}\n`);
 if(process.env.LOCAL_CONSOLE_RECORDING_SMOKE==='1')void (async()=>{
   // Only the fresh isolated store: never accepts an owner/token from a browser URL.
   let owner;
   for(let attempt=0;attempt<120&&!closing;attempt++){
     const db=new DatabaseSync(join(directory,'recorder.sqlite'),{readOnly:true});
     try{const rows=db.prepare("SELECT owner FROM accounts WHERE admission_status='admitted'").all();
       if(rows.length>1)throw new Error('ambiguous_local_test_account');
       owner=rows[0]?.owner;
     }finally{db.close();}
     if(owner)break;await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(closing)return;if(!owner)throw new Error('local_login_required');
   const response=await fetch(`${url}/admin/invites`,{method:'POST',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},
     body:JSON.stringify({owner,expiresIn:'1h'}),signal:AbortSignal.timeout(10000),redirect:'error'});
   const invite=await response.json();if(response.status!==201||typeof invite.token!=='string')throw new Error('local_invite_failed');
   if(closing)return;
   launch(process.execPath,['apps/mcp/src/smoke.mjs'],{...process.env,RECORDER_MODE:'hosted',RECORDER_URL:url,RECORDER_TOKEN:invite.token,
     NAVIGATION_SMOKE:'0',QUEUE_SMOKE:'0',RECOVERY_SMOKE:'0',SMOKE_OUTPUT:join(directory,'console-smoke.mp4')});
 })().catch(()=>process.stderr.write('Local recording smoke could not start; check login in the isolated console.\n'));
 await new Promise(resolve=>console.once('exit',resolve));
}finally{await stop();}
