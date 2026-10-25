import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Sandbox} from 'railway';
import type {RecorderRuntime} from '@agent-recorder/mcp';
import {createTrackedSandbox,type SandboxJournal} from './sandbox-journal.js';

type ManagedSandbox=Pick<Sandbox,'id'|'files'|'exec'|'destroy'>;
type RenderOptions={
 checkpoint:string;
 image:string;
 createSandbox?:()=>Promise<ManagedSandbox>;
 journal?:SandboxJournal;
 /** The service's own render bundle, where catalog wallpapers are read from. Defaults to RENDER_BUNDLE_DIRECTORY. */
 bundleDirectory?:string;
};
const maximumMediaBytes=256*1024*1024;

/**
 * The worker image carries its own copy of the render bundle, pinned at provisioning time, so a wallpaper added to the
 * catalog since then is missing there and the exporter fails to load it. Inline the image from the service's bundle;
 * the exporter accepts a data URL as a wallpaper, and the VM then needs nothing it does not already have.
 */
export async function inlineWallpaper<T extends object>(config:T,bundleDirectory:string|undefined):Promise<T>{
 const wallpaper=(config as {wallpaper?:unknown}).wallpaper;
 if(typeof wallpaper!=='string'||!wallpaper.startsWith('/wallpapers/')||!bundleDirectory)return config;
 const name=wallpaper.slice('/wallpapers/'.length);
 if(!/^[a-z0-9-]{1,64}\.jpg$/.test(name))return config;
 try{
  const bytes=await readFile(join(bundleDirectory,'wallpapers',name));
  return {...config,wallpaper:`data:image/jpeg;base64,${bytes.toString('base64')}`};
 }catch{return config;}
}

/** Media moves through a disposable VM's file API; Chromium has no network interface. */
export function createRailwayRenderer(options:RenderOptions):RecorderRuntime['render']{
 if(!/^[A-Za-z0-9_.-]{1,80}$/.test(options.checkpoint))throw new Error('invalid_render_checkpoint');
 if(!/^sha256:[a-f0-9]{64}$/.test(options.image))throw new Error('render_worker_image_must_be_pinned');
 return async(sourcePath,config,signal)=>{
  signal.throwIfAborted();
  const source=await stat(sourcePath);
  if(!source.isFile()||!source.size||source.size>maximumMediaBytes)throw new Error('render_source_size_invalid');
  const sandbox=await createTrackedSandbox(()=>options.createSandbox?.()??Sandbox.create(options.checkpoint,{
   networkIsolation:'ISOLATED',idleTimeoutMinutes:15,
  }),options.journal);
  let executionHandle:ReturnType<ManagedSandbox['exec']>|undefined;
  let destroying:Promise<void>|undefined,destroyed=false;
  const destroy=()=>{
   if(destroyed)return Promise.resolve();
   return destroying??=sandbox.destroy().then(()=>{destroyed=true;},error=>{destroying=undefined;throw error;});
  };
  const abort=()=>{
   void executionHandle?.kill().catch(()=>undefined);
   void destroy().catch(()=>undefined);
  };
  signal.addEventListener('abort',abort,{once:true});
  const directory=`/tmp/recorder-render-${randomBytes(12).toString('hex')}`;
  try{
   signal.throwIfAborted();
   // A fresh Railway VM can accept create/connect before its first exec is
   // ready. This command is idempotent, so retry once before giving up.
   let prepared=false;
   for(let attempt=0;attempt<2;attempt++){
    signal.throwIfAborted();
    try{
     const result=await sandbox.exec(`install -d -m 0700 -o 1000 -g 1000 ${directory}`,{timeoutSec:20});
     if(result.exitCode===0&&!result.timedOut&&!result.truncated){prepared=true;break;}
    }catch{/* one startup retry */}
    if(attempt===0)await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(!prepared)throw new Error('render_vm_prepare_failed');
   await sandbox.files.write(`${directory}/raw.webm`,()=>createReadStream(sourcePath));
   await sandbox.files.write(`${directory}/config.json`,JSON.stringify(await inlineWallpaper(config,options.bundleDirectory??process.env.RENDER_BUNDLE_DIRECTORY)));
   signal.throwIfAborted();
   const command=`docker run --rm --pull=never --network none --read-only `+
    '--user 1000:1000 --cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges '+
    '--security-opt seccomp=/opt/recorder/seccomp.json --pids-limit 256 --memory 3g --cpus 2 '+
    '--shm-size 256m --tmpfs /tmp:rw,size=1g,mode=1777 --env HOME=/tmp '+
    `--mount type=bind,src=${directory},dst=/media --entrypoint node ${options.image} `+
    '/app/apps/hosted/dist/render-worker.js /media/raw.webm /media/config.json /media/video.mp4';
   executionHandle=sandbox.exec(command,{timeoutSec:11*60});
   const execution=await executionHandle;
   signal.throwIfAborted();
   if(execution.timedOut)throw new Error('render_timeout');
   // The worker prints its reason on stderr; carry its tail as the cause so the service log can show it.
   if(execution.exitCode!==0){
    const stderr=(execution as {stderr?:unknown}).stderr;
    throw new Error('render_failed',typeof stderr==='string'&&stderr.trim()?{cause:stderr.trim().slice(-500)}:undefined);
   }
   const artifact=await sandbox.files.stat(`${directory}/video.mp4`);
   if(artifact.isDir||!artifact.size||artifact.size>maximumMediaBytes)throw new Error('render_size_invalid');
   const bytes=await sandbox.files.read(`${directory}/video.mp4`,{format:'bytes'});
   signal.throwIfAborted();
   if(bytes.length!==artifact.size)throw new Error('render_size_invalid');
   return Buffer.from(bytes);
  }finally{
   signal.removeEventListener('abort',abort);
   try{await destroy();}catch{await destroy();}
   await options.journal?.untrack(sandbox.id);
  }
 };
}
