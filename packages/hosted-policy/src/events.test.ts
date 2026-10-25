import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {ProductEvents} from './events.js';
import type {TransactionalStore} from './index.js';
it('migrates existing event receipts without losing classifications or allowing duplicates',()=>{
 const db=new DatabaseSync(':memory:'),owner=randomUUID(),job=randomUUID();
 const store:TransactionalStore={connection:db,transaction(work){db.exec('BEGIN');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 try{
  db.exec("CREATE TABLE accounts(owner TEXT PRIMARY KEY);CREATE TABLE hosted_product_events(event_key TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT CHECK(name IN ('admission_granted','render_completed')),cohort TEXT NOT NULL,occurred_at INTEGER NOT NULL) STRICT;");
  db.prepare('INSERT INTO accounts VALUES (?)').run(owner);
  db.prepare('INSERT INTO hosted_product_events VALUES (?,?,?,?,?)').run(`render_completed:${job}`,owner,'render_completed','fixture',1);
  const events=new ProductEvents(store,'external');
  events.record(owner,'render_completed',job,2);events.record(owner,'demo_started',job,2);events.record(owner,'capture_finalized',job,3);events.record(owner,'download_completed',job,4);events.record(owner,'download_completed',job,5);
  new ProductEvents(store); // Migration remains idempotent on restart.
  expect(db.prepare('SELECT count(*) n FROM hosted_product_events').get()!.n).toBe(4);
  expect(db.prepare('SELECT max(version) v FROM hosted_event_schema').get()!.v).toBe(4);
  expect(db.prepare("SELECT cohort,occurred_at FROM hosted_product_events WHERE name='render_completed'").get()).toMatchObject({cohort:'fixture',occurred_at:1});
 }finally{db.close();}
});
it('counts one MCP-active day per owner and retains distinct-account counts',()=>{
 const db=new DatabaseSync(':memory:'),owner=randomUUID(),now=40*86400000;
 const store:TransactionalStore={connection:db,transaction(work){db.exec('BEGIN');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 try{
  db.exec('CREATE TABLE accounts(owner TEXT PRIMARY KEY)');db.prepare('INSERT INTO accounts VALUES (?)').run(owner);
  const events=new ProductEvents(store,'external');
  events.record(owner,'mcp_connected',owner,now);events.record(owner,'mcp_connected',owner,now+1000);
  expect(events.snapshot(now+1000).groups).toContainEqual({cohort:'external',event:'mcp_connected',events:1,accounts:1});
  events.record(owner,'mcp_connected',owner,now+86400000);
  expect(events.snapshot(now+86400000).groups).toContainEqual({cohort:'external',event:'mcp_connected',events:2,accounts:1});
  expect(events.prune(now+30*86400000+1)).toBe(1);
  events.record(owner,'mcp_connected',owner,now+30*86400000+1);
  expect(events.snapshot(now+30*86400000+1).groups).toContainEqual({cohort:'external',event:'mcp_connected',events:2,accounts:1});
 }finally{db.close();}
});
it('classifies through the operator CLI on an existing hosted database and rejects unknown accounts',()=>{
 const directory=mkdtempSync(join(tmpdir(),'recorder-cohort-')),path=join(directory,'recorder.sqlite'),owner=randomUUID();
 const db=new DatabaseSync(path);
 try{
  db.exec('PRAGMA application_id=1095914051;CREATE TABLE accounts(owner TEXT PRIMARY KEY);');
  db.prepare('INSERT INTO accounts VALUES (?)').run(owner);
  new ProductEvents({connection:db,transaction(work){return work();}});
  const run=(id:string)=>spawnSync(process.execPath,[fileURLToPath(new URL('../dist/cohort-cli.js',import.meta.url)),'--database',path,'--owner',id,'--cohort','internal'],{encoding:'utf8'});
  const first=run(owner);expect(first.status,first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual({cohort:'internal',changed:true});
  expect(JSON.parse(run(owner).stdout)).toEqual({cohort:'internal',changed:false});
  expect(run(randomUUID()).status).not.toBe(0);
  expect(db.prepare('SELECT count(*) n FROM hosted_cohort_changes').get()!.n).toBe(1);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
it('deduplicates events, separates cohorts and windows, and rolls back with the business transaction',()=>{
 const db=new DatabaseSync(':memory:');
 const store:TransactionalStore={connection:db,transaction(work){db.exec('BEGIN');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 try{
  db.exec('CREATE TABLE accounts(owner TEXT PRIMARY KEY)');
  const a=randomUUID(),b=randomUUID(),job=randomUUID(),now=40*86400000;
  for(const owner of [a,b])db.prepare('INSERT INTO accounts VALUES (?)').run(owner);
  const fixture=new ProductEvents(store,'fixture'),external=new ProductEvents(store,'external');
  fixture.record(a,'admission_granted',a,now);fixture.record(a,'admission_granted',a,now);
  fixture.record(a,'render_completed',job,1); // Outside the reporting window.
  external.record(b,'admission_granted',b,now);external.record(b,'render_completed',randomUUID(),now);
  expect(()=>store.transaction(()=>{external.record(b,'render_completed',randomUUID(),now);throw new Error('rollback');})).toThrow('rollback');
  expect(fixture.snapshot(now).groups).toEqual(expect.arrayContaining([
   {cohort:'fixture',event:'admission_granted',events:1,accounts:1},
   {cohort:'external',event:'admission_granted',events:1,accounts:1},
   {cohort:'external',event:'render_completed',events:1,accounts:1},
  ]));
  expect(fixture.snapshot(now).groups).toHaveLength(3);
  expect(JSON.stringify(fixture.snapshot(now))).not.toContain(a);
  expect(()=>new ProductEvents(store,'invalid' as never)).toThrow('invalid_usage_cohort');
  expect(fixture.classify(a,'internal',now)).toEqual({cohort:'internal',changed:true});
  expect(fixture.classify(a,'internal',now)).toEqual({cohort:'internal',changed:false});
  fixture.record(a,'render_completed',randomUUID(),now);
  expect(fixture.snapshot(now).groups).toContainEqual({cohort:'internal',event:'render_completed',events:1,accounts:1});
  expect(fixture.snapshot(now).groups).toContainEqual({cohort:'fixture',event:'admission_granted',events:1,accounts:1});
  expect(db.prepare('SELECT count(*) n FROM hosted_cohort_changes').get()!.n).toBe(1);
  expect(()=>fixture.classify(randomUUID(),'external',now)).toThrow('account_not_found');
  expect(fixture.prune(now+30*86400000)).toBe(1); // The event on the window boundary stays.
  expect(fixture.prune(now+30*86400000+1)).toBe(4);
  expect(fixture.prune(now+30*86400000+1)).toBe(0);
  expect(fixture.snapshot(now+30*86400000+1).groups).toEqual([]);
 }finally{db.close();}
});
