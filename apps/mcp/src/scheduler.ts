import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RecorderDatabase } from './store/database.js';
export type QueueState='queued'|'running'|'completed'|'failed'|'canceled'|'expired'|'interrupted';
export type QueueEntry={id:string;owner:string;kind:'session'|'render';state:QueueState;payload:Record<string,unknown>;enqueuedAt:number;deadline:number;fence:number;workerId:string|null;leaseUntil:number|null;cancelRequested:boolean;result:Record<string,unknown>|null;errorCode:string|null};
export type QueueLease={id:string;workerId:string;fence:number};
const uuid=z.uuid();
const clock=(now:number)=>{if(!Number.isSafeInteger(now)||now<0) throw new Error('invalid_queue_time');};
const duration=(ms:number,max:number)=>{if(!Number.isSafeInteger(ms)||ms<=0||ms>max) throw new Error('invalid_queue_duration');};
function body(value:Record<string,unknown>) {const result=JSON.stringify(value);if(result.length>16000) throw new Error('queue_payload_too_large');return result;}
/** Durable coordination only. Execution must stop its resources before acknowledging cancel/lost lease. */
export class DurableScheduler {
  constructor(private readonly db:RecorderDatabase,private readonly capacity=1) {
    if(capacity!==1) throw new Error('single_worker_capacity_required');
  }
  private read(id:string):QueueEntry {
    const row=this.db.connection.prepare('SELECT * FROM queue_entries WHERE id=?').get(id);
    if(!row) throw new Error('queued_job_not_found');
    return {id:String(row.id),owner:String(row.owner),kind:row.kind as QueueEntry['kind'],state:row.state as QueueState,
      payload:JSON.parse(String(row.payload)),enqueuedAt:Number(row.enqueued_at),deadline:Number(row.deadline),fence:Number(row.fence),
      workerId:row.worker_id===null?null:String(row.worker_id),leaseUntil:row.lease_until===null?null:Number(row.lease_until),
      cancelRequested:row.cancel_requested===1,result:row.result===null?null:JSON.parse(String(row.result)),errorCode:row.error_code===null?null:String(row.error_code)};
  }
  status(owner:string,id:string):QueueEntry {
    uuid.parse(owner);uuid.parse(id);const entry=this.read(id);
    if(entry.owner!==owner) throw new Error('queued_job_not_found');return entry;
  }
  enqueue(owner:string,kind:QueueEntry['kind'],requestId:string,inputHash:string,payload:Record<string,unknown>,now=Date.now(),waitMs=600000,onAdmit?:(entry:QueueEntry)=>void):QueueEntry {
    uuid.parse(owner);uuid.parse(requestId);clock(now);duration(waitMs,600000);
    if(!['session','render'].includes(kind)|| !/^[a-f0-9]{64}$/.test(inputHash)) throw new Error('invalid_queue_request');
    const serialized=body(payload);
    return this.db.transaction(()=>{
      const sql=this.db.connection;
      const previous=sql.prepare('SELECT id,input_hash FROM queue_entries WHERE owner=? AND kind=? AND request_id=?').get(owner,kind,requestId);
      if(previous) {if(previous.input_hash!==inputHash) throw new Error('request_id_conflict');return this.read(String(previous.id));}
      if(sql.prepare("SELECT 1 FROM queue_entries WHERE owner=? AND state IN ('queued','running')").get(owner)) throw new Error('owner_queue_limit');
      const id=randomUUID();
      sql.prepare("INSERT INTO queue_entries(id,owner,kind,request_id,input_hash,payload,state,enqueued_at,deadline,admission_turn) VALUES (?,?,?,?,?,?,'queued',?,?,(SELECT turn FROM scheduler_state WHERE singleton=1))")
        .run(id,owner,kind,requestId,inputHash,serialized,now,now+waitMs);
      const entry=this.read(id);onAdmit?.(entry);return entry;
    });
  }
  claim(workerId:string,now=Date.now(),leaseMs=30000):QueueEntry|undefined {
    uuid.parse(workerId);clock(now);duration(leaseMs,60000);
    return this.db.transaction(()=>{
      const sql=this.db.connection;
      // Even an expired running lease occupies capacity until explicit reconciliation confirms teardown.
      if(Number(sql.prepare("SELECT count(*) n FROM queue_entries WHERE state='running'").get()!.n)>=this.capacity) return undefined;
      const candidate=sql.prepare(`SELECT q.id,q.owner FROM queue_entries q LEFT JOIN queue_owner_turns t ON q.owner=t.owner
        WHERE q.state='queued' AND q.deadline>? ORDER BY max(coalesce(t.last_turn,0),q.admission_turn),q.sequence LIMIT 1`).get(now);
      if(!candidate) return undefined;
      sql.prepare('UPDATE scheduler_state SET turn=turn+1 WHERE singleton=1').run();
      const turn=Number(sql.prepare('SELECT turn FROM scheduler_state WHERE singleton=1').get()!.turn);
      sql.prepare('INSERT INTO queue_owner_turns VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET last_turn=excluded.last_turn').run(String(candidate.owner),turn);
      sql.prepare("UPDATE queue_entries SET state='running',worker_id=?,fence=fence+1,lease_until=? WHERE id=?").run(workerId,now+leaseMs,String(candidate.id));
      return this.read(String(candidate.id));
    });
  }
  heartbeat(lease:QueueLease,now=Date.now(),leaseMs=30000):boolean {
    clock(now);duration(leaseMs,60000);
    return Number(this.db.connection.prepare("UPDATE queue_entries SET lease_until=? WHERE id=? AND worker_id=? AND fence=? AND state='running' AND lease_until>?")
      .run(now+leaseMs,lease.id,lease.workerId,lease.fence,now).changes)===1;
  }
  progress(lease:QueueLease,result:Record<string,unknown>,now=Date.now()):void {
    clock(now);
    const changed=this.db.connection.prepare("UPDATE queue_entries SET result=? WHERE id=? AND worker_id=? AND fence=? AND state='running' AND lease_until>?")
      .run(body(result),lease.id,lease.workerId,lease.fence,now).changes;
    if(Number(changed)!==1) throw new Error('queue_lease_lost');
  }
  cancel(owner:string,id:string,onCanceled?:(entry:QueueEntry)=>void):QueueEntry {
    return this.db.transaction(()=>{
      const entry=this.status(owner,id),sql=this.db.connection;
      if(entry.state==='queued') {
        sql.prepare("UPDATE queue_entries SET state='canceled',cancel_requested=1,error_code='queue_canceled',payload='{}' WHERE id=?").run(id);
        onCanceled?.(this.read(id));
      } else if(entry.state==='running') sql.prepare('UPDATE queue_entries SET cancel_requested=1 WHERE id=?').run(id);
      return this.read(id);
    });
  }
  finish(lease:QueueLease,state:'completed'|'failed'|'canceled',result:Record<string,unknown>,now=Date.now(),onFinish?:(entry:QueueEntry)=>void):QueueEntry {
    clock(now);const serialized=body(result);
    if(!['completed','failed','canceled'].includes(state)) throw new Error('invalid_queue_state');
    return this.db.transaction(()=>{
      const entry=this.read(lease.id);
      if(entry.state!=='running'||entry.workerId!==lease.workerId||entry.fence!==lease.fence||(entry.leaseUntil ?? 0)<=now) throw new Error('queue_lease_lost');
      if(entry.cancelRequested && state!=='canceled') throw new Error('queue_cancel_pending');
      this.db.connection.prepare("UPDATE queue_entries SET state=?,result=?,payload='{}',worker_id=NULL,lease_until=NULL WHERE id=?").run(state,serialized,entry.id);
      const terminal=this.read(entry.id);onFinish?.(terminal);return terminal;
    });
  }
  /** Only after worker teardown/process exit is verified. Never re-enqueue browser actions. */
  reconcile(now=Date.now(),workerStopped?:(entry:QueueEntry)=>boolean,onTerminal?:(entry:QueueEntry)=>void):QueueEntry[] {
    clock(now);
    return this.db.transaction(()=>{
      const sql=this.db.connection;
      // Also retire execution inputs from terminal rows written by older versions.
      // Keep request/hash/result receipts so transport retries cannot replay browser work.
      sql.prepare("UPDATE queue_entries SET payload='{}' WHERE state NOT IN ('queued','running') AND payload!='{}'").run();
      const rows=sql.prepare("SELECT id FROM queue_entries WHERE (state='queued' AND deadline<=?) OR (state='running' AND lease_until<=?) ORDER BY sequence").all(now,now);
      const terminal:QueueEntry[]=[];
      for(const row of rows) {
        const entry=this.read(String(row.id));
        if(entry.state==='running' && !workerStopped?.(entry)) continue;
        const state=entry.state==='queued'?'expired':'interrupted';
        sql.prepare("UPDATE queue_entries SET state=?,error_code=?,payload='{}',worker_id=NULL,lease_until=NULL WHERE id=?").run(state,state==='expired'?'queue_wait_expired':'worker_interrupted',entry.id);
        const result=this.read(entry.id);onTerminal?.(result);terminal.push(result);
      }
      return terminal;
    });
  }
}
