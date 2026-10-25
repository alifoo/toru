import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateDailyLimits, type DailyLimits } from '../policies.js';
import type { RecorderDatabase } from './database.js';

type Kind = 'browserMs' | 'renderMs';
const columns = {browserMs:'browser_ms',renderMs:'render_ms'} as const;
function nonnegative(value:number) {
  if(!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_usage_amount');
  return value;
}
export class OperationalUsage {
  constructor(private readonly db:RecorderDatabase) {}

  /** countStart false: this browser continues a start already counted (the sign-in that unlocked it). */
  reserve(owner:string,kind:Kind,amount:number,limits:DailyLimits,now=Date.now(),jobId?:string,countStart=true):string {
    z.uuid().parse(owner); nonnegative(amount); nonnegative(now);
    if(jobId!==undefined)z.uuid().parse(jobId);
    const quota = validateDailyLimits(limits);
    const column = columns[kind];
    if(!column) throw new Error('invalid_usage_kind');
    const day = new Date(now).toISOString().slice(0,10);
    return this.db.transaction(() => {
      const sql = this.db.connection;
      if(jobId&&!sql.prepare('SELECT 1 FROM jobs WHERE id=? AND owner=?').get(jobId,owner))throw new Error('usage_job_not_found');
      sql.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?) ON CONFLICT(owner) DO NOTHING').run(owner,now);
      sql.prepare('INSERT INTO daily_usage(owner,day) VALUES (?,?) ON CONFLICT(owner,day) DO NOTHING').run(owner,day);
      const usage = sql.prepare('SELECT browser_ms,render_ms,browser_starts FROM daily_usage WHERE owner=? AND day=?').get(owner,day)!;
      const total = Number(usage[column]) + amount;
      if(!Number.isSafeInteger(total) || total > quota[kind]) throw new Error('daily_compute_limit');
      const counted = kind === 'browserMs' && countStart;
      if(counted) {
        if(Number(usage.browser_starts) >= quota.browserStarts) throw new Error('daily_session_limit');
        const starts = Number(sql.prepare('SELECT coalesce(sum(browser_starts),0) n FROM daily_usage WHERE day=?').get(day)!.n);
        if(!Number.isSafeInteger(starts) || starts >= quota.globalBrowserStarts) throw new Error('daily_service_limit');
      }
      sql.prepare(`UPDATE daily_usage SET ${column}=?,browser_starts=browser_starts+? WHERE owner=? AND day=?`)
        .run(total,counted ? 1 : 0,owner,day);
      const id = randomUUID();
      sql.prepare('INSERT INTO usage_reservations(id,owner,day,kind,amount,created_at,job_id) VALUES (?,?,?,?,?,?,?)').run(id,owner,day,column,amount,now,jobId??null);
      return id;
    });
  }

  /** A retry returns the original settlement; a crash leaves the conservative full reservation intact. */
  settle(id:string,elapsed:number,now=Date.now()):number {
    z.uuid().parse(id); nonnegative(elapsed); nonnegative(now);
    return this.db.transaction(() => {
      const sql = this.db.connection;
      const reservation = sql.prepare('SELECT * FROM usage_reservations WHERE id=?').get(id);
      if(!reservation) throw new Error('usage_reservation_not_found');
      if(reservation.settled_amount !== null) return Number(reservation.settled_amount);
      const amount = Number(reservation.amount);
      const actual = Math.min(amount,elapsed);
      const column = reservation.kind === 'browser_ms' ? 'browser_ms' : 'render_ms';
      sql.prepare(`UPDATE daily_usage SET ${column}=${column}-? WHERE owner=? AND day=?`)
        .run(amount-actual,String(reservation.owner),String(reservation.day));
      sql.prepare('UPDATE usage_reservations SET settled_amount=?,settled_at=? WHERE id=?').run(actual,now,id);
      return actual;
    });
  }
}
