import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {Sandbox} from 'railway';
import type {BrowserWorkerLease} from './remote-runtime.js';
import {createTrackedSandbox,type SandboxJournal} from './sandbox-journal.js';

type ManagedSandbox=Pick<Sandbox,'id'|'exec'|'destroy'>;
type AllocatorOptions={
 checkpoint:string;
 image:string;
 createSandbox?:(token:string)=>Promise<ManagedSandbox>;
 fetchImplementation?:typeof fetch;
 heartbeatMs?:number;
 journal?:SandboxJournal;
};
const workerPort=37842;
const privateAddress=/^[0-9a-f]{32}$/i;

function eth0Address(output:string){
 const addresses=output.trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/))
  .filter(parts=>parts.length===6&&parts[5]==='eth0'&&privateAddress.test(parts[0]??'')&&/^f[cd]/i.test(parts[0]??''));
 if(addresses.length!==1)throw new Error('browser_worker_private_address_unavailable');
 return addresses[0]![0]!.match(/.{4}/g)!.join(':');
}

function browserDockerAddress(output:string,network:string){
 let parsed:Record<string,{IPAddress?:string}>;
 try{parsed=JSON.parse(output);}catch{throw new Error('browser_worker_docker_address_unavailable');}
 if(!parsed||Object.keys(parsed).length!==1||!parsed[network])throw new Error('browser_worker_docker_address_unavailable');
 const address=parsed[network].IPAddress??'';
 if(isIP(address)!==4||!(/^10\./.test(address)||/^192\.168\./.test(address)||/^172\.(1[6-9]|2\d|3[01])\./.test(address)))
  throw new Error('browser_worker_docker_address_unavailable');
 return address;
}

/** Provision one disposable VM from a release checkpoint; no customer volume or controller keys. */
export function createRailwayBrowserAllocator(options:AllocatorOptions){
 if(!/^[A-Za-z0-9_.-]{1,80}$/.test(options.checkpoint))throw new Error('invalid_browser_checkpoint');
 if(!/^sha256:[a-f0-9]{64}$/.test(options.image))throw new Error('browser_worker_image_must_be_pinned');
 const heartbeatMs=options.heartbeatMs??60_000;
 if(!Number.isInteger(heartbeatMs)||heartbeatMs<1000||heartbeatMs>120_000)throw new Error('invalid_browser_worker_heartbeat');
 return async():Promise<BrowserWorkerLease>=>{
  const token=randomBytes(32).toString('base64url');
  const sandbox=await createTrackedSandbox(()=>options.createSandbox?.(token)??Sandbox.create(options.checkpoint,{
   networkIsolation:'PRIVATE',idleTimeoutMinutes:5,env:{RECORDER_WORKER_TOKEN:token},
  }),options.journal);
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  try{
   const addressResult=await sandbox.exec('cat /proc/net/if_inet6',{timeoutSec:10});
   if(addressResult.exitCode!==0||addressResult.timedOut||addressResult.truncated)
    throw new Error('browser_worker_private_address_unavailable');
   const endpoint=`http://[${eth0Address(addressResult.stdout)}]:${workerPort}`;
   const suffix=randomBytes(6).toString('hex');
   const network=`recorder-internal-${suffix}`;
   const browser=`recorder-browser-${suffix}`;
   const egress=`recorder-egress-${suffix}`;
   const relay=`recorder-relay-${suffix}`;
   async function checked(command:string){
    const result=await sandbox.exec(command,{timeoutSec:30});
    if(result.exitCode!==0||result.timedOut||result.truncated)throw new Error('browser_worker_network_setup_failed');
   }
   const smallContainer='--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges '+
    '--security-opt seccomp=/opt/recorder/seccomp.json --read-only --tmpfs /tmp:rw,size=64m,mode=1777 ';
   await checked(`docker network create --internal --driver bridge ${network}`);
   await checked(`docker run -d --rm --pull=never --name ${egress} --network bridge `+
    `${smallContainer}--pids-limit 64 --memory 256m --cpus 0.5 --entrypoint node ${options.image} `+
    '/app/apps/hosted/dist/egress-worker.js');
   await checked(`docker network connect --alias recorder-egress ${network} ${egress}`);
   await checked(`docker run -d --rm --pull=never --name ${browser} --network ${network} `+
    '--network-alias recorder-browser --user 1000:1000 --cap-drop ALL --cap-add SYS_CHROOT '+
    '--security-opt no-new-privileges --security-opt seccomp=/opt/recorder/seccomp.json '+
    '--pids-limit 256 --memory 2g --cpus 2 --shm-size 256m --tmpfs /tmp:rw,size=1g,mode=1777 '+
    `--env RECORDER_WORKER_TOKEN --env RECORDER_WORKER_PORT=${workerPort} `+
    `--env CHROMEDRIVER_PORT=9515 --entrypoint node ${options.image} /app/apps/hosted/dist/browser-worker.js`);
   const inspected=await sandbox.exec(`docker inspect ${browser} --format '{{json .NetworkSettings.Networks}}'`,{timeoutSec:10});
   if(inspected.exitCode!==0||inspected.timedOut||inspected.truncated)
    throw new Error('browser_worker_docker_address_unavailable');
   const browserAddress=browserDockerAddress(inspected.stdout,network);
   await checked(`docker run -d --rm --pull=never --name ${relay} --network host `+
    `${smallContainer}--pids-limit 64 --memory 128m --cpus 0.5 `+
    `--env RECORDER_RELAY_HOST=${browserAddress} --env RECORDER_RELAY_PORT=${workerPort} `+
    `--entrypoint node ${options.image} /app/apps/hosted/dist/worker-relay.js`);
   let ready=false;
   const fetcher=options.fetchImplementation??fetch;
   for(let attempt=0;attempt<30;attempt++){
    try{
     const response=await fetcher(`${endpoint}/status`,{
      headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1000),
     });
     if(response.ok){ready=true;break;}
    }catch{/* worker startup */}
    await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(!ready)throw new Error('browser_worker_unavailable');
   let pinging=false;
   heartbeat=setInterval(()=>{
    if(pinging)return;pinging=true;
    void sandbox.exec('true',{timeoutSec:5}).then(()=>undefined,()=>undefined).finally(()=>{pinging=false;});
   },heartbeatMs);
   heartbeat.unref();
   let closed=false,destroyed=false,cleanup:Promise<void>|undefined;
   return {endpoint,token,close(){
    if(closed)return Promise.resolve();
    return cleanup??=(async()=>{
     if(heartbeat)clearInterval(heartbeat);
     if(!destroyed){await sandbox.destroy();destroyed=true;}
     await options.journal?.untrack(sandbox.id);
     closed=true;
    })().catch(error=>{cleanup=undefined;throw error;});
   }};
  }catch(error){
   if(heartbeat)clearInterval(heartbeat);
   try{await sandbox.destroy();await options.journal?.untrack(sandbox.id);}catch{/* preserve journal for recovery */}
   throw error;
  }
 };
}
