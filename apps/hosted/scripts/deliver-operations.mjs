import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkOperations} from './check-operations.mjs';

function validateWebhook(value){
  let url;
  try {url=new URL(value);}catch{throw new Error('alert_configuration_invalid');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&local)))
    throw new Error('alert_configuration_invalid');
  return url;
}

async function readState(path,deployment){
  let raw;
  try {raw=await readFile(path,'utf8');}
  catch(error){if(error?.code==='ENOENT')return [];throw new Error('alert_state_unavailable');}
  if(raw.length>8192)throw new Error('alert_state_invalid');
  let value;
  try {value=JSON.parse(raw);}catch{throw new Error('alert_state_invalid');}
  if(value?.version!==1||value.deployment!==deployment||!Array.isArray(value.alerts)||
    value.alerts.some(code=>typeof code!=='string'||!(/^[a-z][a-z0-9_]{1,70}$/).test(code)))
    throw new Error('alert_state_invalid');
  return [...new Set(value.alerts)].sort();
}

async function saveState(path,deployment,alerts){
  const temporary=`${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary,JSON.stringify({version:1,deployment,alerts}),{flag:'wx',mode:0o600});
    await rename(temporary,path);
  }catch{throw new Error('alert_state_unavailable');}
  finally{await rm(temporary,{force:true}).catch(()=>{});}
}

/** One poll and one at-least-once notification on a state change. Caller runs a single instance. */
export async function deliverOperationalAlerts({recorderUrl,key,webhookUrl,deployment,statePath,timeoutMs=10_000}){
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(deployment??'')||
    typeof statePath!=='string'||!statePath.startsWith('/')||dirname(statePath)==='/')
    throw new Error('alert_configuration_invalid');
  const webhook=validateWebhook(webhookUrl);
  const previous=await readState(statePath,deployment);
  const result=await checkOperations({url:recorderUrl,key,timeoutMs});
  const alerts=[...new Set(result.alerts)].sort();
  if(JSON.stringify(alerts)===JSON.stringify(previous))return {state:'unchanged',alerts};
  const resolved=previous.filter(code=>!alerts.includes(code));
  const message=alerts.length
    ? `Agent Recorder ${deployment}: active ${alerts.join(', ')}${resolved.length?`; resolved ${resolved.join(', ')}`:''}`
    : `Agent Recorder ${deployment}: recovered; resolved ${resolved.join(', ')}`;
  try {
    const response=await fetch(webhook,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:message,deployment,active:alerts,resolved})});
    if(!response.ok)throw new Error();
  }catch{throw new Error('alert_delivery_failed');}
  await saveState(statePath,deployment,alerts);
  return {state:'delivered',alerts,resolved};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    const result=await deliverOperationalAlerts({
      recorderUrl:process.env.RECORDER_MONITOR_URL,key:process.env.INVITE_ADMIN_KEY,
      webhookUrl:process.env.RECORDER_ALERT_WEBHOOK_URL,
      deployment:process.env.RECORDER_ALERT_DEPLOYMENT,statePath:process.env.RECORDER_ALERT_STATE_PATH,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode=result.alerts.length?1:0;
  }catch(error){
    const allowed=['alert_configuration_invalid','alert_state_unavailable','alert_state_invalid','alert_delivery_failed'];
    const code=error instanceof Error&&allowed.includes(error.message)?error.message:'alert_delivery_failed';
    process.stderr.write(`${code}\n`);process.exitCode=2;
  }
}
