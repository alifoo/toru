import type {RecorderDatabase} from './store/database.js';

/** Operational snapshot of authoritative state, not a product conversion funnel. */
export function operationalSnapshot(store:RecorderDatabase,now=Date.now()) {
 const day=new Date(now).toISOString().slice(0,10);
 return store.transaction(()=>{
  const sql=store.connection;
  const counts=(query:string)=>Object.fromEntries(sql.prepare(query).all().map(row=>[String(row.state),Number(row.count)]));
  const queue=counts('SELECT state,count(*) count FROM queue_entries GROUP BY state');
  const jobs=counts('SELECT status state,count(*) count FROM jobs GROUP BY status');
  const usage=sql.prepare(`SELECT count(*) owners,coalesce(sum(browser_ms),0) browser_ms,coalesce(sum(render_ms),0) render_ms,
    coalesce(sum(browser_starts),0) browser_starts,coalesce(sum(bandwidth_bytes),0) bandwidth_bytes FROM daily_usage WHERE day=?`).get(day)!;
  const oldest=sql.prepare("SELECT min(enqueued_at) oldest FROM queue_entries WHERE state='queued'").get()?.oldest;
  const stale=Number(sql.prepare("SELECT count(*) n FROM queue_entries WHERE state='running' AND lease_until<=?").get(now)!.n);
  const failures=sql.prepare("SELECT json_extract(metadata,'$.errorCode') code,count(*) count FROM jobs WHERE json_extract(metadata,'$.errorCode') IS NOT NULL GROUP BY code").all();
  const safeFailures:Record<string,number>={};
  for(const row of failures){const raw=String(row.code),code=/^[a-z][a-z0-9_]{2,70}$/.test(raw)?raw:'unclassified';safeFailures[code]=(safeFailures[code]??0)+Number(row.count);}
  return {version:1,observedAt:new Date(now).toISOString(),
    queue:{states:queue,oldestWaitMs:oldest==null?0:Math.max(0,now-Number(oldest)),expiredRunningLeases:stale},
    retainedJobs:{states:jobs,errorCodes:safeFailures},
    todayUtc:{day,activeOwners:Number(usage.owners),browserMs:Number(usage.browser_ms),renderMs:Number(usage.render_ms),
      browserStarts:Number(usage.browser_starts),downloadBytesReserved:Number(usage.bandwidth_bytes)},
    interpretation:{jobs:'Retained job states only; cleanup removes expired jobs. Not lifetime completions or a conversion rate.',
      usage:'Operational reservations include conservative unsettled crash usage. Download bytes are reserved before transfer, not confirmed delivered.',
      accounts:'Includes internal, synthetic and external accounts; do not interpret as customer adoption.'}};
 });
}
