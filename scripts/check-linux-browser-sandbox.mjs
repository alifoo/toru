// Linux deployment preflight: synthetic page, temporary profile, no Recorder credentials.
// Invoke as the same non-root UID that runs Recorder. Never adds --no-sandbox.
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

if(process.platform!=='linux'||process.getuid()===0)throw new Error('run_on_linux_as_recorder_non_root_user');
const profile=mkdtempSync(join(tmpdir(),'recorder-sandbox-check-'));
try{
  const browser=process.env.RENDER_BROWSER_BINARY||'/usr/bin/chromium';
  const result=spawnSync('timeout',['20s',browser,'--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
    `--user-data-dir=${profile}`,'--dump-dom','data:text/html,<title>recorder-sandbox-check</title>'],
    {encoding:'utf8',maxBuffer:1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:profile,LANG:'C.UTF-8'}});
  const passed=result.status===0&&result.stdout.includes('<title>recorder-sandbox-check</title>');
  const limits={};for(const name of ['memory.max','cpu.max','pids.max']){
    try{limits[name]=readFileSync(`/sys/fs/cgroup/${name}`,'utf8').trim();}catch{}
  }
  console.log(JSON.stringify({passed,uid:process.getuid(),exitCode:result.status,signal:result.signal,
    sandboxDisabled:false,limits,error:passed?undefined:'sandboxed_browser_did_not_render',
    diagnostics:(result.stderr||'').split('\n').filter(line=>/sandbox|namespace|Permission denied|Operation not permitted|FATAL/i.test(line)).slice(0,5)}));
  if(!passed)process.exitCode=1;
}finally{rmSync(profile,{recursive:true,force:true});}
