import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SandboxTimeoutError} from 'railway';
import {createSandboxJournal,createTrackedSandbox} from '../dist/sandbox-journal.js';

test('VM IDs survive a controller restart and are removed only after destroy',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-vm-journal-'));
 const path=join(directory,'workers.json');
 const first='123e4567-e89b-12d3-a456-426614174000';
 const second='123e4567-e89b-12d3-a456-426614174001';
 const destroyed=[];
 try{
  const journal=createSandboxJournal(path,async id=>({destroy:async()=>{destroyed.push(id);}}));
  await Promise.all([journal.track(first),journal.track(second)]);
  assert.deepEqual(new Set(JSON.parse(await readFile(path,'utf8'))),new Set([first,second]));
  const restarted=createSandboxJournal(path,async id=>({destroy:async()=>{destroyed.push(id);}}));
  await restarted.recover();
  assert.deepEqual(new Set(destroyed),new Set([first,second]));
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),[]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('failed VM destruction stays in the journal for the next recovery',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-vm-journal-'));
 const path=join(directory,'workers.json');
 const id='123e4567-e89b-12d3-a456-426614174002';
 try{
  const journal=createSandboxJournal(path,async()=>({destroy:async()=>{throw new Error('provider_unavailable');}}));
  await journal.track(id);
  await assert.rejects(journal.recover(),/provider_unavailable/);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),[id]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a VM creation timeout is journaled and destroyed by its returned ID',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-vm-journal-'));
 const path=join(directory,'workers.json');
 const id='123e4567-e89b-12d3-a456-426614174003';let destroyed=0;
 const timeout=new SandboxTimeoutError({resource:'sandbox',id,lastStatus:'CREATING',timeoutMs:1000});
 try{
  const journal=createSandboxJournal(path);
  await assert.rejects(createTrackedSandbox(async()=>{throw timeout;},journal,
   async()=>({destroy:async()=>{destroyed++;}})),error=>error===timeout);
  assert.equal(destroyed,1);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),[]);
  await assert.rejects(createTrackedSandbox(async()=>{throw timeout;},journal,
   async()=>{throw new Error('provider_unavailable');}),error=>error===timeout);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),[id]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
