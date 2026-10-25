import {spawn} from 'node:child_process';

// Keep the group leader alive until cleanup, even when pnpm's direct child exits.
// IPC disconnect also covers a crashed launcher. No secrets are printed here.
const supervisor=`
  const {spawn}=require('node:child_process');
  const [command,serialized,grace]=process.argv.slice(1);
  let closing=false;
  function stop(){
    if(closing)return;closing=true;
    process.kill(-process.pid,'SIGTERM');
    setTimeout(()=>process.kill(-process.pid,'SIGKILL'),Number(grace));
  }
  process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('disconnect',stop);
  const child=spawn(command,JSON.parse(serialized),{env:process.env,stdio:'inherit'});
  child.once('error',()=>{process.stderr.write('local_command_start_failed\\n');stop();});
  child.once('exit',stop);
  if(!process.connected)stop();
`;

export function spawnLocalCommand(command,args,env,{output='inherit',graceMs=1500}={}){
  if(process.platform==='win32')throw new Error('local_supervision_requires_posix');
  if(!Number.isSafeInteger(graceMs)||graceMs<1||graceMs>30000)throw new Error('invalid_shutdown_grace');
  return spawn(process.execPath,['-e',supervisor,command,JSON.stringify(args),String(graceMs)],{
    detached:true,env,stdio:['ignore',output,output,'ipc'],
  });
}

export async function stopLocalCommand(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
}
