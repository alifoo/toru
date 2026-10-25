// Private release operation. Requires a project-scoped RAILWAY_TOKEN and RAILWAY_ENVIRONMENT_ID.
// Never run against the Recorder service or its volume; only disposable Sandboxes are used.
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {Sandbox,SandboxTimeoutError} from 'railway';

const [archive,archiveSha,profile,profileSha,checkpointName]=process.argv.slice(2);
const digest=/^[a-f0-9]{64}$/;
if(!archive||!profile||!digest.test(archiveSha??'')||!digest.test(profileSha??'')||
 !/^[A-Za-z0-9_.-]{1,80}$/.test(checkpointName??''))
 throw new Error('usage: provision-worker-checkpoint ARCHIVE ARCHIVE_SHA256 SECCOMP SECCOMP_SHA256 CHECKPOINT');
if(!process.env.RAILWAY_TOKEN||!process.env.RAILWAY_ENVIRONMENT_ID)
 throw new Error('railway_project_token_and_environment_required');

async function digestFile(path){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('hex');
}
async function checked(sandbox,command,timeoutSec,code){
 const result=await sandbox.exec(command,{timeoutSec});
 if(result.exitCode!==0||result.timedOut||result.truncated)throw new Error(code);
 return result.stdout.trim();
}
async function createSandbox(source,options){
 try{return await Sandbox.create(source,options);}
 catch(error){
  if(error instanceof SandboxTimeoutError&&error.resource==='sandbox'){
   try{await(await Sandbox.connect(error.id)).destroy();}catch{/* report original timeout */}
  }
  throw error;
 }
}

if(await digestFile(archive)!==archiveSha||await digestFile(profile)!==profileSha)
 throw new Error('worker_release_checksum_mismatch');
if((await Sandbox.checkpoints()).some(entry=>entry.key===checkpointName))
 throw new Error('worker_checkpoint_name_exists');

const base=await createSandbox({networkIsolation:'ISOLATED',idleTimeoutMinutes:20});
let fork;
try{
 console.log(JSON.stringify({phase:'sandbox_created',id:base.id}));
 await checked(base,'install -d -m 0755 /opt/recorder',20,'worker_profile_directory_failed');
 await base.files.write('/opt/recorder/seccomp.json',()=>createReadStream(profile));
 await base.files.write('/tmp/recorder-worker-image.tar.gz',()=>createReadStream(archive));
 const remoteArchive=await checked(base,'sha256sum /tmp/recorder-worker-image.tar.gz',120,'worker_archive_checksum_failed');
 const remoteProfile=await checked(base,'sha256sum /opt/recorder/seccomp.json',20,'worker_profile_checksum_failed');
 if(remoteArchive.split(/\s+/)[0]!==archiveSha||remoteProfile.split(/\s+/)[0]!==profileSha)
  throw new Error('worker_remote_checksum_mismatch');
 await checked(base,'bash -o pipefail -c "gzip -dc /tmp/recorder-worker-image.tar.gz | docker load"',300,'worker_image_load_failed');
 const inspected=await checked(base,"docker image inspect agent-recorder:amd64-candidate --format '{{.Id}} {{.Architecture}}'",20,'worker_image_inspection_failed');
 const [image,architecture]=inspected.split(/\s+/);
 if(!/^sha256:[a-f0-9]{64}$/.test(image??'')||architecture!=='amd64')
  throw new Error('worker_image_architecture_invalid');
 const smoke=`docker run --rm --pull=never --network none --user 1000:1000 `+
  '--cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges '+
  '--security-opt seccomp=/opt/recorder/seccomp.json --pids-limit 256 --memory 3g --cpus 2 '+
  '--shm-size 256m --tmpfs /tmp:rw,size=1g,mode=1777 --entrypoint node '+
 `${image} /app/apps/hosted/scripts/smoke-linux-pipeline.mjs`;
 await checked(base,smoke,180,'worker_linux_pipeline_failed');
 await base.files.remove('/tmp/recorder-worker-image.tar.gz');
 const checkpoint=await base.checkpoint(checkpointName);
 fork=await createSandbox(checkpointName,{networkIsolation:'ISOLATED',idleTimeoutMinutes:5});
 const forkImage=await checked(fork,"docker image inspect agent-recorder:amd64-candidate --format '{{.Id}} {{.Architecture}}'",20,'worker_checkpoint_image_missing');
 const forkProfile=await checked(fork,'sha256sum /opt/recorder/seccomp.json',20,'worker_checkpoint_profile_missing');
 if(forkImage!==inspected||forkProfile.split(/\s+/)[0]!==profileSha)
  throw new Error('worker_checkpoint_verification_failed');
 console.log(JSON.stringify({phase:'checkpoint_verified',checkpointId:checkpoint.id,checkpointName,image,profileSha}));
}finally{
 try{await fork?.destroy();}finally{await base.destroy();}
}
