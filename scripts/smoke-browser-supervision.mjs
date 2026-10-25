// POSIX process-tree crash test. Build @content-layer/browser first. No paid calls.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
const directory=await mkdtemp(join(tmpdir(),'browser-supervision-'));
const marker=join(directory,'grandchild.pid');
const moduleUrl=new URL('../packages/browser/dist/browser-process.js',import.meta.url).href;
const grandchild=`require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
const browser=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000);`;
let parent,pid;
try {
 parent=spawn(process.execPath,['--input-type=module','-e',`
   import {spawnBrowserProcess} from ${JSON.stringify(moduleUrl)};
   spawnBrowserProcess(process.execPath,['-e',${JSON.stringify(browser)},process.argv[1]]);
   setInterval(()=>{},1000);
 `,marker],{stdio:'ignore'});
 for(let attempt=0;attempt<100;attempt++){
  const value=await readFile(marker,'utf8').catch(()=>undefined);
  if(value){pid=Number(value);break;}await delay(50);
 }
 assert.ok(pid,'grandchild did not start');
 process.kill(pid,0);
 const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
 let stopped=false;
 for(let attempt=0;attempt<100;attempt++){
  try {
   const state=execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
   if(!state||state.startsWith('Z')){stopped=true;break;}
  }catch(error){if(error.status===1){stopped=true;break;}throw error;}
  await delay(50);
 }
 assert.ok(stopped,'browser grandchild survived recorder SIGKILL');
 console.log(JSON.stringify({recorderSignal:parent.signalCode,browserGrandchildStopped:stopped}));
} finally {
 if(parent&&parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');
 if(pid)try{process.kill(pid,'SIGKILL');}catch{}
 await rm(directory,{recursive:true,force:true});
}
