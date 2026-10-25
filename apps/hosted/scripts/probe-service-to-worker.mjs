// Synthetic connectivity from the published Railway service to a disposable worker VM.
// The running Recorder deployment, its data volume and variables are untouched.
import {randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Sandbox,SandboxTimeoutError} from 'railway';

const [checkpoint,image]=process.argv.slice(2);
if(!process.env.RAILWAY_TOKEN||!process.env.RAILWAY_ENVIRONMENT_ID)
  throw new Error('railway_project_token_and_environment_required');
if(!/^[A-Za-z0-9_.-]{1,80}$/.test(checkpoint??'')||
  !/^sha256:[a-f0-9]{64}$/.test(image??''))
  throw new Error('usage: probe-service-to-worker CHECKPOINT IMAGE_SHA256');

async function checked(vm,command,code){
  const result=await vm.exec(command,{timeoutSec:30});
  if(result.exitCode!==0||result.timedOut||result.truncated)
    throw new Error(`${code}:${result.exitCode}:${result.stderr.slice(-500)}`);
  return result.stdout.trim();
}
async function fromService(endpoint,token){
  const env={...process.env};delete env.RAILWAY_TOKEN;delete env.RAILWAY_API_TOKEN;
  delete env.RAILWAY_ENVIRONMENT_ID;
  const child=spawn('railway',['ssh','-s','recorder','node','--input-type=module','-',endpoint,token],
    {env,stdio:['pipe','pipe','pipe']});
  createReadStream(fileURLToPath(new URL('./probe-service-worker.mjs',import.meta.url))).pipe(child.stdin);
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);
  child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)throw new Error(`service_worker_probe_failed:${code}:${stderr.slice(-1000)}`);
  const report=JSON.parse(stdout.trim().split('\n').at(-1));
  if(report.phase!=='service_to_worker_cdp_ready'||report.title!=='Web form'||
    report.screenshotBytes<10000||report.screencastFrameBytes<10000)
    throw new Error('service_worker_probe_invalid_result');
  console.log(JSON.stringify(report));
}

const token=randomBytes(32).toString('base64url');
let vm;
try{
  try{vm=await Sandbox.create(checkpoint,{networkIsolation:'PRIVATE',idleTimeoutMinutes:10,
    env:{RECORDER_WORKER_TOKEN:token}});}
  catch(error){
    if(error instanceof SandboxTimeoutError&&error.resource==='sandbox')
      await Sandbox.connect(error.id).then(sandbox=>sandbox.destroy()).catch(()=>undefined);
    throw error;
  }
  console.log(JSON.stringify({phase:'worker_vm_created',id:vm.id}));
  const inspected=await checked(vm,"docker image inspect agent-recorder:relay-fix --format '{{.Id}} {{.Architecture}}'",'worker_image_missing');
  if(inspected!==`${image} amd64`)throw new Error('worker_image_mismatch');
  const addresses=await checked(vm,'cat /proc/net/if_inet6','worker_private_address_missing');
  const address=addresses.split('\n').map(line=>line.trim().split(/\s+/))
    .find(parts=>parts.length===6&&parts[5]==='eth0'&&/^[fd][0-9a-f]{31}$/i.test(parts[0]??''))?.[0];
  if(!address)throw new Error('worker_private_address_invalid');
  const endpoint=`http://[${address.match(/.{4}/g).join(':')}]:37842`;
  const suffix=randomBytes(6).toString('hex');
  const network=`recorder-internal-${suffix}`;
  const browser=`recorder-browser-${suffix}`;
  const egress=`recorder-egress-${suffix}`;
  const relay=`recorder-relay-${suffix}`;
  const small='--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges '+
    '--security-opt seccomp=/opt/recorder/seccomp.json --read-only --tmpfs /tmp:rw,size=64m,mode=1777 ';
  await checked(vm,`docker network create --internal --driver bridge ${network}`,'worker_network_failed');
  await checked(vm,`docker run -d --rm --pull=never --name ${egress} --network bridge `+
    `${small}--pids-limit 64 --memory 256m --cpus 0.5 --entrypoint node ${image} `+
    '/app/apps/hosted/dist/egress-worker.js','worker_egress_failed');
  await checked(vm,`docker network connect --alias recorder-egress ${network} ${egress}`,'worker_egress_attach_failed');
  await checked(vm,`docker run -d --rm --pull=never --name ${browser} --network ${network} `+
    '--network-alias recorder-browser --user 1000:1000 --cap-drop ALL --cap-add SYS_CHROOT '+
    '--security-opt no-new-privileges --security-opt seccomp=/opt/recorder/seccomp.json '+
    '--pids-limit 256 --memory 2g --cpus 2 --shm-size 256m --tmpfs /tmp:rw,size=1g,mode=1777 '+
    `--env RECORDER_WORKER_TOKEN --env RECORDER_WORKER_PORT=37842 --env CHROMEDRIVER_PORT=9515 `+
    `--entrypoint node ${image} /app/apps/hosted/dist/browser-worker.js`,'worker_browser_failed');
  const networks=JSON.parse(await checked(vm,`docker inspect ${browser} --format '{{json .NetworkSettings.Networks}}'`,'worker_browser_address_missing'));
  const browserAddress=networks[network]?.IPAddress;
  if(!/^172\.(1[6-9]|2\d|3[01])\./.test(browserAddress??''))throw new Error('worker_browser_address_invalid');
  await checked(vm,`docker run -d --rm --pull=never --name ${relay} --network host `+
    `${small}--pids-limit 64 --memory 128m --cpus 0.5 `+
    `--env RECORDER_RELAY_HOST=${browserAddress} --env RECORDER_RELAY_PORT=37842 `+
    `--entrypoint node ${image} /app/apps/hosted/dist/worker-relay.js`,'worker_relay_failed');
  await fromService(endpoint,token);
}finally{await vm?.destroy();}
