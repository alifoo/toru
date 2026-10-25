import { spawn, type ChildProcess } from 'node:child_process';
import { browserProcessEnvironment } from './process-environment.js';

// The supervisor is the leader of its own POSIX process group. Its IPC connection
// closes even when the recorder is SIGKILLed; it then kills the whole browser group.
// No executable source or shell command is interpolated into this program.
const supervisor=`
  const {spawn}=require('node:child_process');
  const [executable,serialized]=process.argv.slice(1);
  let closing=false;
  function stop(){
    if(closing)return;closing=true;
    try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}
  }
  process.on('disconnect',stop);
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
  const child=spawn(executable,JSON.parse(serialized),{stdio:['ignore','ignore','ignore'],env:process.env});
  child.on('error',stop);
  child.on('exit',stop);
  if(!process.connected)stop();
`;

export function spawnBrowserProcess(executable:string,args:string[]):ChildProcess {
  if(process.platform==='win32') throw new Error('browser_process_supervision_requires_posix');
  return spawn(process.execPath,['-e',supervisor,executable,JSON.stringify(args)],{
    detached:true,stdio:['ignore','ignore','ignore','ipc'],env:browserProcessEnvironment(),
  });
}

/** Wait until the supervisor exits before releasing files/capacity. */
export async function stopBrowserProcess(child:ChildProcess):Promise<void> {
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(resolve=>{
    const exited=()=>{clearTimeout(timer);resolve();};
    child.once('exit',exited);
    const timer=setTimeout(()=>{
      if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}
    },2000);
    child.kill('SIGTERM');
  });
}
