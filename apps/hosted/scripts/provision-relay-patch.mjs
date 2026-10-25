// Patch only the relay in a verified, disposable worker checkpoint. No service deploy.
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {Sandbox,SandboxTimeoutError} from 'railway';

const [baseCheckpoint,baseImage,nextCheckpoint]=process.argv.slice(2);
if(!process.env.RAILWAY_TOKEN||!process.env.RAILWAY_ENVIRONMENT_ID)
  throw new Error('railway_project_token_and_environment_required');
if(!/^[A-Za-z0-9_.-]{1,80}$/.test(baseCheckpoint??'')||
  !/^sha256:[a-f0-9]{64}$/.test(baseImage??'')||
  !/^[A-Za-z0-9_.-]{1,80}$/.test(nextCheckpoint??''))
  throw new Error('usage: provision-relay-patch BASE_CHECKPOINT BASE_IMAGE NEW_CHECKPOINT');
if((await Sandbox.checkpoints()).some(entry=>entry.key===nextCheckpoint))
  throw new Error('worker_checkpoint_name_exists');

const relayPath=new URL('../dist/worker-relay.js',import.meta.url);
const relayHash=createHash('sha256').update(await readFile(relayPath)).digest('hex');
async function checked(sandbox,command,timeoutSec,code){
  const result=await sandbox.exec(command,{timeoutSec});
  if(result.exitCode!==0||result.timedOut||result.truncated)
    throw new Error(`${code}:${result.exitCode}:${result.stderr.slice(-600)}`);
  return result.stdout.trim();
}
async function create(source,options){
  try{return await Sandbox.create(source,options);}
  catch(error){
    if(error instanceof SandboxTimeoutError&&error.resource==='sandbox')
      await Sandbox.connect(error.id).then(vm=>vm.destroy()).catch(()=>undefined);
    throw error;
  }
}
const base=await create(baseCheckpoint,{networkIsolation:'ISOLATED',idleTimeoutMinutes:15});
let fork;
try{
  console.log(JSON.stringify({phase:'patch_vm_created',id:base.id}));
  const old=await checked(base,"docker image inspect agent-recorder:amd64-candidate --format '{{.Id}} {{.Architecture}}'",20,'base_image_missing');
  if(old!==`${baseImage} amd64`)throw new Error('base_image_mismatch');
  await checked(base,'install -d -m 0755 /tmp/recorder-relay-patch',10,'patch_directory_failed');
  await base.files.write('/tmp/recorder-relay-patch/worker-relay.js',()=>createReadStream(relayPath));
  const remoteHash=(await checked(base,'sha256sum /tmp/recorder-relay-patch/worker-relay.js',10,'relay_upload_failed')).split(/\s+/)[0];
  if(remoteHash!==relayHash)throw new Error('relay_upload_checksum_mismatch');
  const dockerfile=`FROM ${baseImage}\nCOPY worker-relay.js /app/apps/hosted/dist/worker-relay.js\n`;
  await base.files.write('/tmp/recorder-relay-patch/Dockerfile',()=>Readable.from([Buffer.from(dockerfile)]));
  await checked(base,'docker build --pull=false -t agent-recorder:relay-fix /tmp/recorder-relay-patch',120,'relay_image_build_failed');
  const inspected=await checked(base,"docker image inspect agent-recorder:relay-fix --format '{{.Id}} {{.Architecture}}'",20,'relay_image_missing');
  const [image,architecture]=inspected.split(/\s+/);
  if(!/^sha256:[a-f0-9]{64}$/.test(image??'')||architecture!=='amd64')
    throw new Error('relay_image_invalid');
  const installed=(await checked(base,`docker run --rm --pull=never --network none --entrypoint sha256sum ${image} /app/apps/hosted/dist/worker-relay.js`,20,'relay_image_probe_failed')).split(/\s+/)[0];
  if(installed!==relayHash)throw new Error('relay_image_checksum_mismatch');
  const checkpoint=await base.checkpoint(nextCheckpoint);
  fork=await create(nextCheckpoint,{networkIsolation:'ISOLATED',idleTimeoutMinutes:5});
  const forkImage=await checked(fork,"docker image inspect agent-recorder:relay-fix --format '{{.Id}} {{.Architecture}}'",20,'relay_checkpoint_image_missing');
  if(forkImage!==inspected)throw new Error('relay_checkpoint_image_mismatch');
  console.log(JSON.stringify({phase:'relay_checkpoint_verified',checkpointId:checkpoint.id,
    checkpointName:nextCheckpoint,image,relayHash}));
}finally{
  try{await fork?.destroy();}finally{await base.destroy();}
}
