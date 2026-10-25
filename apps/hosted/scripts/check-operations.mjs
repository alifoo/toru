import {pathToFileURL} from 'node:url';

const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
export function assessMetrics(body,now=Date.now()) {
  const q=body?.queue,s=body?.storage,errors=body?.retainedJobs?.errorCodes,r=body?.retention;
  const budget=body?.product?.renderBudget;
  const observed=Date.parse(body?.observedAt);
  if(body?.version!==1||!Number.isFinite(observed)||!nonnegative(q?.oldestWaitMs)||
    !nonnegative(q?.expiredRunningLeases)||!nonnegative(s?.availableBytes)||
    !nonnegative(r?.lastCleanupSucceededAt)||
    (r.lastCleanupFailedAt!==null&&!nonnegative(r.lastCleanupFailedAt))||
    !errors||typeof errors!=='object'||Array.isArray(errors)||
    (body?.product!==undefined&&(!budget||!/^\d{4}-\d{2}-\d{2}$/.test(budget.dayUtc)||
      !nonnegative(budget.limitMs)||!nonnegative(budget.usedAndReservedMs)||
      !nonnegative(budget.remainingMs)||
      budget.remainingMs!==Math.max(0,budget.limitMs-budget.usedAndReservedMs)))||
    Object.values(errors).some(value=>!nonnegative(value)))return ['metrics_invalid'];
  const alerts=[];
  if(observed<now-60_000||observed>now+30_000)alerts.push('metrics_clock_or_freshness');
  if(q.oldestWaitMs>=480_000)alerts.push('queue_wait_near_deadline');
  if(q.expiredRunningLeases>0)alerts.push('expired_running_leases');
  if(s.availableBytes<768*1024**2)alerts.push('disk_below_admission_reserve');
  // Retained jobs, not a rate: cleanup and repeated polling must not imply new incidents.
  if((errors.server_restarted??0)>=3)alerts.push('retained_restart_failures');
  if(r.lastCleanupFailedAt!==null&&r.lastCleanupFailedAt>=r.lastCleanupSucceededAt)alerts.push('retention_cleanup_failed');
  if(r.lastCleanupSucceededAt<now-300_000)alerts.push('retention_cleanup_stale');
  if(budget){
    if(budget.limitMs===0||budget.usedAndReservedMs>=budget.limitMs)alerts.push('render_budget_exhausted');
    else if(budget.usedAndReservedMs/budget.limitMs>=0.8)alerts.push('render_budget_near_limit');
  }
  return alerts;
}

async function readJson(response){
  if(!response.ok)throw new Error('unavailable');
  const reader=response.body?.getReader();
  if(!reader)throw new Error('unavailable');
  const chunks=[];let size=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>262144)throw new Error('oversized');chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** One observation. Fixed codes only; never emit endpoint, auth, bodies or raw errors. */
export async function checkOperations({url,key,timeoutMs=10_000}) {
  let base;
  try {
    base=new URL(url);
    const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
    if(!key||base.username||base.password||base.search||base.hash||base.pathname!=='/'||
      !(base.protocol==='https:'||(base.protocol==='http:'&&local))||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw new Error();
  }catch{return {ok:false,alerts:['monitor_configuration_invalid']};}
  const signal=AbortSignal.timeout(timeoutMs);
  const results=await Promise.all([
    (async()=>{try {
      const body=await readJson(await fetch(new URL('/healthz',base),{signal,redirect:'error'}));
      return body?.ok===true?[]:['health_invalid'];
    }catch{return ['health_unavailable'];}})(),
    (async()=>{try {
      const body=await readJson(await fetch(new URL('/admin/metrics',base),{
        headers:{Authorization:`Bearer ${key}`},signal,redirect:'error'}));
      return assessMetrics(body);
    }catch{return ['metrics_unavailable'];}})(),
  ]);
  const alerts=results.flat();
  return {ok:alerts.length===0,observedAt:new Date().toISOString(),alerts};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await checkOperations({url:process.env.RECORDER_MONITOR_URL,key:process.env.INVITE_ADMIN_KEY});
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode=result.ok?0:1;
}
