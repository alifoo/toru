import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRailwayRenderer,inlineWallpaper} from '../dist/railway-render.js';

const image=`sha256:${'a'.repeat(64)}`;

test('render media crosses the VM file API and the renderer has no network',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 const commands=[];const writes=[];let destroyed=0;
 const sandbox={
  exec:async command=>{commands.push(command);return {exitCode:0,timedOut:false};},
  files:{
   write:async(path,data)=>{writes.push({path,data});},
   stat:async()=>({isDir:false,size:9}),
   read:async()=>new Uint8Array(Buffer.from('video.mp4')),
  },
  destroy:async()=>{destroyed++;},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox});
  const output=await render(source,{background:'midnight'},new AbortController().signal,()=>{});
  assert.equal(output.toString(),'video.mp4');
  assert.equal(writes.length,2);
  assert.match(writes[0].path,/\/raw\.webm$/);
  assert.match(writes[1].path,/\/config\.json$/);
  assert.equal(writes[1].data,'{"background":"midnight"}');
  assert.match(commands[1],/--network none --read-only/);
  assert.match(commands[1],/--security-opt seccomp=\/opt\/recorder\/seccomp.json/);
  assert.match(commands[1],/--memory 3g --cpus 2/);
  assert.match(commands[1],/--entrypoint node sha256:[a-f0-9]{64} \/app\/apps\/hosted\/dist\/render-worker\.js/);
  assert.doesNotMatch(commands[1],/--no-sandbox|--privileged|--publish/);
  assert.equal(destroyed,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a failed remote render destroys its VM',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 let destroyed=0;
 const sandbox={
  exec:async command=>({exitCode:command.startsWith('docker')?1:0,timedOut:false}),
  files:{write:async()=>{}},
  destroy:async()=>{destroyed++;},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox});
  await assert.rejects(render(source,{},new AbortController().signal,()=>{}),/render_failed/);
  assert.equal(destroyed,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a transient destroy failure is retried before removing the VM journal entry',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 let destroys=0,untracks=0;
 const sandbox={id:'123e4567-e89b-12d3-a456-426614174006',
  exec:async()=>({exitCode:0,timedOut:false,truncated:false}),
  files:{write:async()=>{},stat:async()=>({isDir:false,size:9}),read:async()=>new Uint8Array(Buffer.from('video.mp4'))},
  destroy:async()=>{if(++destroys===1)throw new Error('provider_unavailable');},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox,
   journal:{track:async()=>{},untrack:async()=>{untracks++;},recover:async()=>{}}});
  assert.equal((await render(source,{},new AbortController().signal,()=>{})).toString(),'video.mp4');
  assert.equal(destroys,2);assert.equal(untracks,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('repeated destroy failures retain the VM ID for startup recovery',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 let destroys=0,tracked=0,untracked=0;
 const sandbox={id:'123e4567-e89b-12d3-a456-426614174007',
  exec:async()=>({exitCode:0,timedOut:false,truncated:false}),
  files:{write:async()=>{},stat:async()=>({isDir:false,size:9}),read:async()=>new Uint8Array(Buffer.from('video.mp4'))},
  destroy:async()=>{destroys++;throw new Error('provider_unavailable');},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox,
   journal:{track:async()=>{tracked++;},untrack:async()=>{untracked++;},recover:async()=>{}}});
  await assert.rejects(render(source,{},new AbortController().signal,()=>{}),/provider_unavailable/);
  assert.equal(destroys,2);assert.equal(tracked,1);assert.equal(untracked,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a newly started VM may fail its first idempotent media directory command',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 let preparations=0,destroyed=0;
 const sandbox={
  exec:async command=>{
   if(command.startsWith('install '))return {exitCode:++preparations===1?1:0,timedOut:false,truncated:false};
   return {exitCode:0,timedOut:false,truncated:false};
  },
  files:{write:async()=>{},stat:async()=>({isDir:false,size:9}),read:async()=>new Uint8Array(Buffer.from('video.mp4'))},
  destroy:async()=>{destroyed++;},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox});
  const result=await render(source,{},new AbortController().signal,()=>{});
  assert.equal(result.toString(),'video.mp4');
  assert.equal(preparations,2);
  assert.equal(destroyed,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('canceling a remote render kills the command and destroys its VM',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 const controller=new AbortController();let destroyed=0,killed=0,started;
 const launched=new Promise(resolve=>{started=resolve;});
 let complete;
 const commandResult=new Promise(resolve=>{complete=resolve;});
 commandResult.kill=async()=>{killed++;complete({exitCode:-1,timedOut:false});return true;};
 const sandbox={
  exec:command=>command.startsWith('docker')?(started(),commandResult):Promise.resolve({exitCode:0,timedOut:false}),
  files:{write:async()=>{}},
  destroy:async()=>{destroyed++;},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox});
  const work=render(source,{},controller.signal,()=>{});
  await launched;controller.abort(new Error('render_canceled'));
  await assert.rejects(work,/render_canceled/);
  assert.equal(killed,1);assert.equal(destroyed,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('mutable render images are rejected before allocation',()=>{
 assert.throws(()=>createRailwayRenderer({checkpoint:'recorder-render-rc1',image:'render:latest'}),
  /render_worker_image_must_be_pinned/);
});

test('a catalog wallpaper is inlined from the service bundle, so the worker image need not carry it',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 const bundle=join(directory,'bundle');await mkdir(join(bundle,'wallpapers'),{recursive:true});
 await writeFile(join(bundle,'wallpapers','toru-mist.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]));
 const writes=[];
 const sandbox={
  exec:async()=>({exitCode:0,timedOut:false}),
  files:{write:async(path,data)=>{writes.push({path,data});},stat:async()=>({isDir:false,size:9}),read:async()=>new Uint8Array(Buffer.from('video.mp4'))},
  destroy:async()=>{},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox,bundleDirectory:bundle});
  await render(source,{wallpaper:'/wallpapers/toru-mist.jpg',padding:8},new AbortController().signal,()=>{});
  const config=JSON.parse(writes.find(w=>w.path.endsWith('/config.json')).data);
  assert.equal(config.wallpaper,`data:image/jpeg;base64,${Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64')}`);
  assert.equal(config.padding,8);
  // A wallpaper the bundle does not have, a colour, and a traversal attempt all pass through untouched.
  assert.equal((await inlineWallpaper({wallpaper:'/wallpapers/missing.jpg'},bundle)).wallpaper,'/wallpapers/missing.jpg');
  assert.equal((await inlineWallpaper({wallpaper:'#101014'},bundle)).wallpaper,'#101014');
  assert.equal((await inlineWallpaper({wallpaper:'/wallpapers/../raw.webm'},bundle)).wallpaper,'/wallpapers/../raw.webm');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a failed remote render carries the worker stderr as its cause',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-render-test-'));
 const source=join(directory,'raw.webm');await writeFile(source,'synthetic raw');
 const sandbox={
  exec:async command=>({exitCode:command.startsWith('docker')?1:0,timedOut:false,stderr:'BackgroundLoadError: /wallpapers/toru-mist.jpg\n'}),
  files:{write:async()=>{}},
  destroy:async()=>{},
 };
 try{
  const render=createRailwayRenderer({checkpoint:'recorder-render-rc1',image,createSandbox:async()=>sandbox});
  await assert.rejects(render(source,{},new AbortController().signal,()=>{}),error=>error.message==='render_failed'&&error.cause==='BackgroundLoadError: /wallpapers/toru-mist.jpg');
 }finally{await rm(directory,{recursive:true,force:true});}
});
