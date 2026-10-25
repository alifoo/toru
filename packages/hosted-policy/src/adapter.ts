import { BetaAdmission } from './admission.js';
import {ProductEvents,type UsageCohort} from './events.js';
import {recordDeletion} from './deletion-journal.js';
import {deletionBucketFromEnvironment} from './deletion-bucket.js';
import {RecordingFeedback} from './feedback.js';
import {dirname} from 'node:path';
import type { LifecycleFactory } from '@agent-recorder/mcp/lifecycle';
import { CreditLedger, freePolicy } from './index.js';

export const createHostedLifecycle:LifecycleFactory=store=>{
  const renderBudgetRaw=process.env.HOSTED_DAILY_RENDER_MINUTES??'120';
  if(!/^\d+$/.test(renderBudgetRaw)||!Number.isSafeInteger(Number(renderBudgetRaw)*60_000))
    throw new Error('hosted_daily_render_limit_invalid');
  const dailyRenderBudgetMs=Number(renderBudgetRaw)*60_000;
  const ledger=new CreditLedger(store);
  const admission=new BetaAdmission(store,Number(process.env.HOSTED_BETA_CAPACITY ?? 25));
  const defaultCohort=(process.env.HOSTED_USAGE_COHORT ?? 'unclassified') as UsageCohort;
  const events=new ProductEvents(store,defaultCohort);
  const feedback=new RecordingFeedback(store,(process.env.HOSTED_USAGE_COHORT ?? 'unclassified') as UsageCohort);
  const deletionBucket=deletionBucketFromEnvironment(process.env);
  const renderUsedAndReserved=(day:string)=>{
    const amount=Number(store.connection.prepare(`SELECT coalesce(sum(render_ms),0) n
      FROM daily_usage WHERE day=?`).get(day)!.n);
    if(!Number.isSafeInteger(amount)||amount<0)throw new Error('hosted_render_usage_invalid');
    return amount;
  };
  const computeUsage=(now:number)=>{
    const start=now-30*86400000;
    const rows=store.connection.prepare(`SELECT CASE WHEN a.admission_status='deleted' THEN 'deleted' ELSE coalesce(c.cohort,?) END cohort,u.kind,
      count(*) reservations,
      coalesce(sum(CASE WHEN u.settled_at IS NOT NULL THEN u.settled_amount ELSE 0 END),0) settled_ms,
      coalesce(sum(CASE WHEN u.settled_at IS NULL THEN u.amount ELSE 0 END),0) unsettled_reserved_ms,
      sum(CASE WHEN u.settled_at IS NULL THEN 1 ELSE 0 END) unsettled_reservations
      FROM usage_reservations u JOIN accounts a ON a.owner=u.owner
      LEFT JOIN hosted_account_cohorts c ON c.owner=u.owner
      WHERE u.created_at>=? AND u.created_at<=? GROUP BY cohort,u.kind`).all(defaultCohort,start,now);
    return {windowStart:new Date(start).toISOString(),windowEnd:new Date(now).toISOString(),
      groups:rows.map(row=>({cohort:String(row.cohort),kind:String(row.kind),reservations:Number(row.reservations),
        settledMs:Number(row.settled_ms),unsettledReservedMs:Number(row.unsettled_reserved_ms),
        unsettledReservations:Number(row.unsettled_reservations)})),
      interpretation:'Settled milliseconds are capped at the reservation, including failed jobs. Unsettled milliseconds are full conservative reservations, not observed runtime. Cohort is the current classification; erased accounts are grouped as deleted. Neither is billed CPU time or provider cost.'};
  };
  const admissionOutcomes=(now:number)=>{
    const start=now-30*86400000;
    const rows=store.connection.prepare(`SELECT CASE WHEN a.admission_status='deleted' THEN 'deleted' ELSE coalesce(c.cohort,?) END cohort,b.source,
      count(*) admitted_jobs,count(DISTINCT r.owner) accounts,
      sum(CASE WHEN r.state='committed' THEN 1 ELSE 0 END) committed,
      sum(CASE WHEN r.state='released' THEN 1 ELSE 0 END) released,
      sum(CASE WHEN r.state='reserved' THEN 1 ELSE 0 END) reserved
      FROM credit_reservations r JOIN accounts a ON a.owner=r.owner
      JOIN credit_buckets b ON b.id=r.bucket_id
      LEFT JOIN hosted_account_cohorts c ON c.owner=r.owner
      WHERE r.created_at>=? AND r.created_at<=? GROUP BY cohort,b.source`).all(defaultCohort,start,now);
    return {windowStart:new Date(start).toISOString(),windowEnd:new Date(now).toISOString(),
      groups:rows.map(row=>({cohort:String(row.cohort),source:String(row.source),admittedJobs:Number(row.admitted_jobs),
        accounts:Number(row.accounts),committed:Number(row.committed),released:Number(row.released),reserved:Number(row.reserved)})),
      interpretation:'Jobs admitted in this window, grouped by current cohort and credit source. States are current, so they can change later. Committed means first MP4 publication; released includes abandonment, expiry and account deletion, not only technical failures. Attempts rejected before credit reservation are excluded. Deleted accounts are separate from active cohorts. This is not a same-window conversion rate.'};
  };
  const computeByOutcome=(now:number)=>{
    const start=now-30*86400000;
    const rows=store.connection.prepare(`SELECT coalesce(c.cohort,?) cohort,b.source,r.state,u.kind,
      count(DISTINCT r.job_id) jobs,count(*) reservations,
      coalesce(sum(CASE WHEN u.settled_at IS NOT NULL THEN u.settled_amount ELSE 0 END),0) settled_ms,
      coalesce(sum(CASE WHEN u.settled_at IS NULL THEN u.amount ELSE 0 END),0) unsettled_reserved_ms
      FROM usage_reservations u JOIN credit_reservations r ON r.job_id=u.job_id AND r.owner=u.owner
      JOIN accounts a ON a.owner=r.owner JOIN credit_buckets b ON b.id=r.bucket_id
      LEFT JOIN hosted_account_cohorts c ON c.owner=r.owner
      WHERE u.created_at>=? AND u.created_at<=? AND a.admission_status!='deleted'
      GROUP BY cohort,b.source,r.state,u.kind`).all(defaultCohort,start,now);
    return {windowStart:new Date(start).toISOString(),windowEnd:new Date(now).toISOString(),
      groups:rows.map(row=>({cohort:String(row.cohort),source:String(row.source),state:String(row.state),
        kind:String(row.kind),jobs:Number(row.jobs),reservations:Number(row.reservations),
        settledMs:Number(row.settled_ms),unsettledReservedMs:Number(row.unsettled_reserved_ms)})),
      interpretation:'Compute reservations created in this window and linked to a retained credit reservation, grouped by its current state. Multiple renders count as one job but several reservations. Older unlinked reservations and erased accounts are excluded; use computeUsage for their aggregate. Settled milliseconds are capped runtime, not billed CPU or provider cost. Released is not necessarily a technical failure.'};
  };
  const assertAccountEraseAllowed=(owner:string)=>{
    const sql=store.connection;
    const hasCheckout=Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_checkout_intents'").get());
    const hasCreated=Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_checkout_created_sessions'").get());
    if(hasCheckout&&!hasCreated)throw new Error('account_deletion_review_required');
    // An unbound Checkout may already have created a Stripe subscription while
    // its webhook is pending. Keep the account until every intent is resolved
    // and every bound subscription has a verified terminal receipt.
    const unresolved=hasCheckout&&sql.prepare(`SELECT 1 FROM hosted_checkout_intents i
      LEFT JOIN hosted_checkout_sessions s ON s.intent_id=i.intent_id
        AND s.account_id=i.account_id AND s.livemode=i.livemode
      LEFT JOIN hosted_checkout_created_sessions c ON c.intent_id=i.intent_id
        AND c.account_id=i.account_id AND c.livemode=i.livemode
      LEFT JOIN hosted_subscription_ends e ON e.subscription_id=s.subscription_id AND e.owner=i.owner
      WHERE i.owner=? AND ((s.session_id IS NULL AND c.expired_at IS NULL) OR
        (s.session_id IS NOT NULL AND e.subscription_id IS NULL)) LIMIT 1`).get(owner);
    const paidWithoutEnd=sql.prepare(`SELECT 1 FROM hosted_paid_invoices i
      LEFT JOIN hosted_subscription_ends e ON e.subscription_id=i.subscription_id AND e.owner=i.owner
      WHERE i.owner=? AND e.subscription_id IS NULL LIMIT 1`).get(owner);
    if(unresolved||paidWithoutEnd)throw new Error('account_deletion_review_required');
  };
  const recordAdmission=(owner:string)=>{
    const admittedAt=store.connection.prepare('SELECT admitted_at FROM hosted_admissions WHERE owner=?').get(owner)?.admitted_at;
    const now=Date.now();
    if(typeof admittedAt==='number'&&admittedAt>=now-30*86400000&&admittedAt<=now)
      events.record(owner,'admission_granted',owner,admittedAt);
  };
  return {
    async beforeAccountErase(owner){
      // Serialize the billing check with account revocation. Checkout.begin
      // requires an admitted account, so it cannot create a new intent while
      // the external deletion journal is being written.
      store.transaction(()=>{
        assertAccountEraseAllowed(owner);
        const sql=store.connection,now=Date.now();
        sql.prepare("UPDATE accounts SET admission_status='deleted',deleted_at=coalesce(deleted_at,?) WHERE owner=?")
          .run(now,owner);
        sql.prepare('UPDATE grants SET revoked_at=coalesce(revoked_at,?) WHERE owner=?').run(now,owner);
      });
      if(deletionBucket){await deletionBucket.record(dirname(store.path),owner);return;}
      const journal=process.env.HOSTED_DELETION_JOURNAL;
      if(!journal)throw new Error('account_deletion_unavailable');
      await recordDeletion(journal,dirname(store.path),owner);
    },
    assertAccountEraseAllowed,
    eraseAccountData(owner){
      for(const table of ['hosted_recording_feedback','hosted_product_events','hosted_account_cohorts','hosted_cohort_changes','hosted_admissions'])store.connection.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner);
    },
    accountEraseReceipt(){return {financialRecordsRetained:true};},
    recordingStarted(job){events.record(job.owner,'demo_started',job.id);},
    captureFinalized(job){events.record(job.owner,'capture_finalized',job.id);},
    artifactDownloaded(owner,id){events.record(owner,'download_completed',id);},
    mcpToolUsed(owner){events.record(owner,'mcp_connected',owner);},
    recordingFeedback(owner,id,input){return feedback.submit(owner,id,input);},
    maintenance(now){store.transaction(()=>{feedback.prune(now);events.prune(now);});},
    admit(job,requestId,inputHash) {
      if(admission.check(job.owner).state!=='admitted')throw new Error('beta_admission_required');
      recordAdmission(job.owner);
      ledger.reserve(job.owner,job.id,requestId,inputHash);
      const policy=ledger.policyForReservation(job.id);
      return {version:policy.version,sessionMs:policy.sessionMs,captureMs:policy.captureMs,
        rawRetentionMs:policy.rawRetentionMs,videoRetentionMs:policy.videoRetentionMs};
    },
    beforeRender(job) {
      const reservation=store.connection.prepare(`SELECT day FROM usage_reservations
        WHERE job_id=? AND kind='render_ms' AND settled_at IS NULL
        ORDER BY rowid DESC LIMIT 1`).get(job.id);
      if(!reservation)throw new Error('render_reservation_missing');
      if(renderUsedAndReserved(String(reservation.day))>dailyRenderBudgetMs)
        throw new Error('daily_service_limit');
      if(!job.policy) return;
      const delivered=Number(store.connection.prepare('SELECT count(*) n FROM hosted_exports WHERE job_id=?').get(job.id)!.n);
      if(delivered>=1+freePolicy.rerenders) throw new Error('rerender_limit');
      ledger.reserveRecovered(job.owner,job.id);
    },
    delivered(job,artifactId) {
      if(!job.policy) return;
      ledger.commit(job.owner,job.id,artifactId);
      events.record(job.owner,'render_completed',job.id);
      store.connection.prepare('INSERT INTO hosted_exports VALUES (?,?,?) ON CONFLICT(job_id,artifact_id) DO NOTHING').run(job.id,artifactId,Date.now());
    },
    abandon(job) {if(job.policy) ledger.release(job.owner,job.id);},
    usage(owner,historyCursor) {
      const status=admission.check(owner);
      if(status.state!=='admitted')return {mode:'hosted',commercialCredits:true,admission:status};
      recordAdmission(owner);
      return {...ledger.usage(owner,Date.now(),historyCursor),mode:'hosted',commercialCredits:true,admission:status};
    },
    metrics(){const now=Date.now(),dayUtc=new Date(now).toISOString().slice(0,10);
      const usedAndReservedMs=renderUsedAndReserved(dayUtc);
      return {...events.snapshot(now),feedback:feedback.snapshot(now),
        renderBudget:{dayUtc,limitMs:dailyRenderBudgetMs,usedAndReservedMs,
          remainingMs:Math.max(0,dailyRenderBudgetMs-usedAndReservedMs)},
        computeUsage:computeUsage(now),admissionOutcomes:admissionOutcomes(now),computeByOutcome:computeByOutcome(now)};},
  };
};
