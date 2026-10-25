import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {RecorderDatabase} from './store/database.js';
import {operationalSnapshot} from './metrics.js';

it('reports authoritative UTC aggregates and queue pressure without returning account or job contents',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'metrics-'));const db=new RecorderDatabase(join(directory,'db.sqlite'));
 const now=Date.parse('2026-09-28T02:00:00Z');
 try {
  for(const owner of ['private-owner-a','private-owner-b'])db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,now);
  db.connection.prepare('INSERT INTO daily_usage(owner,day,browser_ms,render_ms,browser_starts,bandwidth_bytes) VALUES (?,?,?,?,?,?)').run('private-owner-a','2026-09-28',1000,2000,1,3000);
  db.connection.prepare('INSERT INTO daily_usage(owner,day,browser_ms) VALUES (?,?,?)').run('private-owner-b','2026-09-27',99999);
  db.connection.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run('private-job','private-owner-a','interrupted',now,now+1000,JSON.stringify({errorCode:'server_restarted',url:'https://secret.example',goal:'private prompt'}));
  db.connection.prepare("INSERT INTO queue_entries(id,owner,kind,request_id,input_hash,payload,state,enqueued_at,deadline,admission_turn) VALUES ('q','private-owner-a','session','req','hash','{}','queued',?,?,0)").run(now-5000,now+1000);
  const snapshot=operationalSnapshot(db,now);
  expect(snapshot.todayUtc).toEqual({day:'2026-09-28',activeOwners:1,browserMs:1000,renderMs:2000,browserStarts:1,downloadBytesReserved:3000});
  expect(snapshot.queue).toMatchObject({states:{queued:1},oldestWaitMs:5000,expiredRunningLeases:0});
  expect(snapshot.retainedJobs).toEqual({states:{interrupted:1},errorCodes:{server_restarted:1}});
  expect(JSON.stringify(snapshot)).not.toMatch(/private-owner|private-job|secret.example|private prompt/);
  db.connection.prepare("UPDATE queue_entries SET state='running',worker_id='worker',lease_until=? WHERE id='q'").run(now-1);
  expect(operationalSnapshot(db,now).queue).toMatchObject({oldestWaitMs:0,expiredRunningLeases:1});
 }finally{db.close();await rm(directory,{recursive:true,force:true});}
});
