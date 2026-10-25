// Run after the MCP build, with Node >=24.21.0. No browser or paid model calls.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { RecorderDatabase } from '../apps/mcp/dist/store/database.js';
import { NavigationController } from '../apps/mcp/dist/navigation.js';
const directory=await mkdtemp(join(tmpdir(),'navigation-kill-'));
const path=join(directory,'recorder.sqlite'),owner=randomUUID(),id=randomUUID(),requestId=randomUUID();
const databaseModule=new URL('../apps/mcp/dist/store/database.js',import.meta.url).href;
const navigationModule=new URL('../apps/mcp/dist/navigation.js',import.meta.url).href;
const jevModule=new URL('../apps/mcp/dist/jev.js',import.meta.url).href;
let child,db,controller;
try {
  child=spawn(process.execPath,['--input-type=module','-e',`
    import { RecorderDatabase } from ${JSON.stringify(databaseModule)};
    import { NavigationController } from ${JSON.stringify(navigationModule)};
    import { JevClient } from ${JSON.stringify(jevModule)};
    const [path,owner,id,requestId]=process.argv.slice(1);
    const db=new RecorderDatabase(path);
    db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
    const controller=new NavigationController({call:async()=>({content:[],structuredContent:{id,status:'recording'}})},checkpoint=>{
      const client=new JevClient({apiKey:'synthetic',onCostCheckpoint:checkpoint,fetch:async()=>{
        process.stdout.write('model-request-in-flight\\n');
        return new Promise(()=>{});
      }});
      return {get spentUsd(){return client.spentUsd;},run:async()=>{
        await client.ask({page:'synthetic'}, {q:{type:'noul',instructions:'Ready?',criteria:{true:'yes',false:'no'}}},new AbortController().signal);
      }};
    },db);
    await controller.call(owner,'navigation_start',{id,requestId,goal:'Synthetic crash test'});
    setInterval(()=>{},1000);
  `,path,owner,id,requestId],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    let output='',errors='';const timer=setTimeout(()=>reject(new Error('child_start_timeout')),10000);
    child.stderr.on('data',chunk=>{errors+=chunk;});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(`child_exited_early:${errors}`));});
    child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('model-request-in-flight')){clearTimeout(timer);resolve();}});
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  assert.equal(child.signalCode,'SIGKILL');
  db=new RecorderDatabase(path);
  let launches=0;
  controller=new NavigationController({call:async who=>{
    if(who!==owner)throw new Error('recording_not_found');
    return {content:[],structuredContent:{id,status:'interrupted'}};
  }},()=>{launches++;throw new Error('must_not_replay');},db);
  const args={id,requestId,goal:'Synthetic crash test'};
  const result=(await controller.call(owner,'navigation_start',args)).structuredContent;
  assert.equal(result.status,'interrupted');assert.ok(result.costUsd>0);assert.equal(launches,0);
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  console.log(JSON.stringify({signal:child.signalCode,state:result.status,reservedCostUsd:result.costUsd,replayedActions:launches,integrity:'ok'}));
} finally {
  if(child && child.exitCode===null && child.signalCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;}
  await controller?.close();db?.close();await rm(directory,{recursive:true,force:true});
}
