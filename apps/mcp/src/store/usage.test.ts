import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecorderDatabase } from './database.js';
import { OperationalUsage } from './usage.js';
const cleanups:(() => Promise<void>)[] = [];
afterEach(async () => {for(const cleanup of cleanups.splice(0)) await cleanup();});
const quota = {browserMs:100,renderMs:100,browserStarts:2,globalBrowserStarts:3};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'recorder-usage-'));
  const db = new RecorderDatabase(join(dir,'store.sqlite'));
  cleanups.push(async () => {db.close();await rm(dir,{recursive:true,force:true});});
  return {db,usage:new OperationalUsage(db),owner:randomUUID()};
}
describe('operational usage reservations', () => {
  it('shares quota across independent connections and survives a restart',async () => {
    const {db,usage,owner} = await fixture();
    const second = new RecorderDatabase(db.path);
    try {
      const other = new OperationalUsage(second);
      const reservation = usage.reserve(owner,'browserMs',70,quota);
      expect(() => other.reserve(owner,'browserMs',40,quota)).toThrow('daily_compute_limit');
      db.close();
      expect(other.settle(reservation,20)).toBe(20);
      other.reserve(owner,'browserMs',80,quota);
      expect(second.connection.prepare('SELECT browser_ms,browser_starts FROM daily_usage').get()).toEqual({browser_ms:100,browser_starts:2});
    } finally {second.close();}
  });
  it('settles exactly once into the original UTC day, without refunding browser starts',async () => {
    const {db,usage,owner} = await fixture();
    const before = Date.parse('2026-09-27T23:59:59Z'), after = before+2000;
    const id = usage.reserve(owner,'browserMs',100,quota,before);
    expect(usage.settle(id,20,after)).toBe(20);
    expect(usage.settle(id,0,after)).toBe(20);
    expect(db.connection.prepare('SELECT day,browser_ms,browser_starts FROM daily_usage').get()).toEqual({day:'2026-09-27',browser_ms:20,browser_starts:1});
    usage.reserve(owner,'browserMs',100,quota,after);
    expect(db.connection.prepare('SELECT count(*) n FROM daily_usage').get()!.n).toBe(2);
  });
  it('enforces owner and service start caps while render does not consume browser starts',async () => {
    const {db,usage,owner} = await fixture();
    usage.reserve(owner,'browserMs',0,quota); usage.reserve(owner,'browserMs',0,quota);
    expect(() => usage.reserve(owner,'browserMs',0,quota)).toThrow('daily_session_limit');
    usage.reserve(randomUUID(),'browserMs',0,quota);
    expect(() => usage.reserve(randomUUID(),'browserMs',0,quota)).toThrow('daily_service_limit');
    usage.reserve(owner,'renderMs',100,quota);
    expect(db.connection.prepare('SELECT count(*) n FROM accounts').get()!.n).toBe(2);
    expect(db.connection.prepare('SELECT sum(browser_starts) n FROM daily_usage').get()!.n).toBe(3);
  });
  it('rolls back counters if reservation insertion fails',async () => {
    const {db,usage,owner} = await fixture();
    db.connection.exec("CREATE TRIGGER fail_reservation BEFORE INSERT ON usage_reservations BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => usage.reserve(owner,'browserMs',100,quota)).toThrow('injected');
    expect(db.connection.prepare('SELECT count(*) n FROM daily_usage').get()!.n).toBe(0);
    expect(db.connection.prepare('SELECT count(*) n FROM accounts').get()!.n).toBe(0);
  });
  it('rejects invalid values and caps the settled amount at the reservation',async () => {
    const {usage,owner} = await fixture();
    expect(() => usage.reserve(owner,'renderMs',NaN,quota)).toThrow('invalid_usage_amount');
    const id = usage.reserve(owner,'renderMs',50,quota);
    expect(() => usage.settle(id,-1)).toThrow('invalid_usage_amount');
    expect(usage.settle(id,500)).toBe(50);
  });
  it('attributes settled and unsettled compute to the owning job without crossing accounts',async()=>{
    const {db,usage,owner}=await fixture(),jobId=randomUUID(),other=randomUUID();
    db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,1);
    db.connection.prepare('INSERT INTO jobs(id,owner,status,created_at,expires_at,metadata) VALUES (?,?,?,?,?,?)')
      .run(jobId,owner,'ready',1,1000,'{}');
    expect(()=>usage.reserve(other,'renderMs',50,quota,2,jobId)).toThrow('usage_job_not_found');
    const id=usage.reserve(owner,'renderMs',50,quota,2,jobId);
    expect(db.connection.prepare('SELECT job_id,amount,settled_amount FROM usage_reservations WHERE id=?').get(id))
      .toEqual({job_id:jobId,amount:50,settled_amount:null});
    expect(usage.settle(id,12,3)).toBe(12);
    expect(db.connection.prepare('SELECT job_id,settled_amount FROM usage_reservations WHERE id=?').get(id))
      .toEqual({job_id:jobId,settled_amount:12});
    expect(db.connection.prepare('SELECT count(*) n FROM daily_usage WHERE owner=?').get(other)!.n).toBe(0);
  });
});
