import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecorderDatabase } from './store/database.js';
import { DurableScheduler, type QueueEntry } from './scheduler.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const work of cleanup.splice(0)) await work();});
const hash='a'.repeat(64);
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'recorder-queue-')),db=new RecorderDatabase(join(dir,'recorder.sqlite'));
  cleanup.push(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  const owners=Array.from({length:10},()=>randomUUID());
  owners.forEach(owner=>db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,1));
  return {db,owners,queue:new DurableScheduler(db)};
}
const lease=(entry:QueueEntry)=>({id:entry.id,workerId:entry.workerId!,fence:entry.fence});
it('removes terminal execution inputs while retaining idempotency receipts and pending work',async()=>{
  const {queue,owners,db}=await fixture(),request=randomUUID();
  const payload={args:{url:'https://example.com/private?secret=value'},tokenHash:'sensitive-grant-reference'};
  const first=queue.enqueue(owners[0]!,'session',request,hash,payload,1);
  const pending=queue.enqueue(owners[1]!,'session',randomUUID(),hash,payload,1);
  const running=queue.claim(randomUUID(),2)!;
  expect(queue.status(owners[0]!,first.id).payload).toEqual(payload);
  queue.finish(lease(running),'completed',{id:'receipt',status:'closed'},3);
  expect(queue.status(owners[0]!,first.id).payload).toEqual({});
  expect(queue.enqueue(owners[0]!,'session',request,hash,payload,4)).toMatchObject({id:first.id,state:'completed',result:{id:'receipt'}});
  expect(queue.status(owners[1]!,pending.id).payload).toEqual(payload);
  expect(queue.cancel(owners[1]!,pending.id).payload).toEqual({});
  const expired=queue.enqueue(owners[2]!,'session',randomUUID(),hash,payload,5,1);
  queue.reconcile(6);expect(queue.status(owners[2]!,expired.id).payload).toEqual({});
  queue.enqueue(owners[3]!,'session',randomUUID(),hash,payload,7);
  const interrupted=queue.claim(randomUUID(),8,1)!;
  queue.reconcile(9,()=>true);expect(queue.status(owners[3]!,interrupted.id).payload).toEqual({});
  // Upgrade cleanup preserves terminal outcome but erases inputs from preexisting rows.
  db.connection.prepare('UPDATE queue_entries SET payload=? WHERE id=?').run(JSON.stringify(payload),first.id);
  queue.reconcile(10);expect(queue.status(owners[0]!,first.id)).toMatchObject({payload:{},result:{id:'receipt'}});
});
it('serves ten accounts fairly at capacity one and does not let the first monopolize the next turn',async()=>{
  const {owners,queue}=await fixture(),worker=randomUUID();
  owners.forEach(owner=>queue.enqueue(owner,'session',randomUUID(),hash,{},1));
  const served:string[]=[];
  for(let i=0;i<10;i++) {
    const entry=queue.claim(worker,2)!;served.push(entry.owner);
    expect(queue.claim(randomUUID(),2)).toBeUndefined();
    queue.finish(lease(entry),'completed',{},3);
    if(i===0) queue.enqueue(entry.owner,'session',randomUUID(),hash,{},4);
  }
  expect(served).toEqual(owners);
  expect(queue.claim(worker,5)!.owner).toBe(owners[0]);
});
it('deduplicates admission, limits one pending job per owner, and atomically rolls back admission effects',async()=>{
  const {queue,db,owners}=await fixture(),owner=owners[0]!,request=randomUUID();
  const first=queue.enqueue(owner,'session',request,hash,{},1);
  expect(queue.enqueue(owner,'session',request,hash,{},2).id).toBe(first.id);
  expect(()=>queue.enqueue(owner,'session',request,'b'.repeat(64),{},2)).toThrow('request_id_conflict');
  expect(()=>queue.enqueue(owner,'render',randomUUID(),hash,{},2)).toThrow('owner_queue_limit');
  expect(()=>queue.status(owners[1]!,first.id)).toThrow('queued_job_not_found');
  expect(()=>queue.enqueue(owners[1]!,'session',randomUUID(),hash,{},2,600000,()=>{throw new Error('no_credit');})).toThrow('no_credit');
  expect(db.connection.prepare('SELECT count(*) n FROM queue_entries').get()!.n).toBe(1);
});
it('keeps expired workers occupying capacity until confirmed stopped, then interrupts without replay',async()=>{
  const {queue,db,owners}=await fixture();
  queue.enqueue(owners[0]!,'session',randomUUID(),hash,{},1);
  queue.enqueue(owners[1]!,'session',randomUUID(),hash,{},1);
  const entry=queue.claim(randomUUID(),2,10)!;
  expect(queue.heartbeat(lease(entry),5,10)).toBe(true);
  expect(queue.heartbeat({...lease(entry),fence:entry.fence+1},6)).toBe(false);
  const other=new RecorderDatabase(db.path);
  try {
    const restarted=new DurableScheduler(other);
    expect(restarted.claim(randomUUID(),16)).toBeUndefined();
    expect(restarted.reconcile(16)).toEqual([]);
    expect(()=>restarted.finish(lease(entry),'completed',{},16)).toThrow('queue_lease_lost');
    expect(restarted.reconcile(16,()=>true)[0]!.state).toBe('interrupted');
    expect(restarted.heartbeat(lease(entry),17)).toBe(false);
    expect(restarted.claim(randomUUID(),17)!.owner).toBe(owners[1]);
    expect(restarted.status(owners[0]!,entry.id).state).toBe('interrupted');
  } finally {other.close();}
});
it('expires waiting jobs and requests running cancellation without prematurely freeing capacity',async()=>{
  const {queue,owners}=await fixture();
  const expired=queue.enqueue(owners[0]!,'session',randomUUID(),hash,{},1,10);
  expect(queue.reconcile(11)[0]!.id).toBe(expired.id);
  const pending=queue.enqueue(owners[1]!,'session',randomUUID(),hash,{},12);
  expect(queue.cancel(owners[1]!,pending.id).state).toBe('canceled');
  queue.enqueue(owners[2]!,'session',randomUUID(),hash,{},12);
  const running=queue.claim(randomUUID(),13)!;
  expect(queue.cancel(owners[2]!,running.id)).toMatchObject({state:'running',cancelRequested:true});
  expect(()=>queue.finish(lease(running),'completed',{},14)).toThrow('queue_cancel_pending');
  expect(queue.finish(lease(running),'canceled',{},14).state).toBe('canceled');
});

it('does not let newly arriving accounts indefinitely overtake an already waiting account',async()=>{
  const {queue,owners}=await fixture(),worker=randomUUID();
  queue.enqueue(owners[0]!,'session',randomUUID(),hash,{},1);
  const first=queue.claim(worker,2)!;queue.finish(lease(first),'completed',{},3);
  queue.enqueue(owners[0]!,'session',randomUUID(),hash,{},4);
  queue.enqueue(owners[1]!,'session',randomUUID(),hash,{},5);
  expect(queue.claim(worker,6)!.owner).toBe(owners[0]);
});
