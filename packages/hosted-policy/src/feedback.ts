import type {TransactionalStore} from './index.js';
import type {UsageCohort} from './events.js';

/** Latest optional response per recording. Never stores free text or changes credit. */
export class RecordingFeedback {
  constructor(private readonly store:TransactionalStore,private readonly cohort:UsageCohort){
    store.connection.exec(`CREATE TABLE IF NOT EXISTS hosted_recording_feedback (
      job_id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(owner),
      useful INTEGER NOT NULL CHECK(useful IN (0,1)),
      reason TEXT CHECK(reason IN ('quality','wrong_flow','slow','other')),
      cohort TEXT NOT NULL CHECK(cohort IN ('unclassified','internal','fixture','bot','external')),
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      CHECK(useful=0 OR reason IS NULL)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS hosted_feedback_window ON hosted_recording_feedback(updated_at,cohort);`);
  }
  submit(owner:string,id:string,input:unknown,now=Date.now()){
    const value=input as {useful?:unknown;reason?:unknown}|null;
    if(!value||typeof value.useful!=='boolean'||!Number.isSafeInteger(now)||now<0||
      (value.reason!==undefined&&(typeof value.reason!=='string'||!['quality','wrong_flow','slow','other'].includes(value.reason)))||
      (value.useful&&value.reason!==undefined))throw new Error('invalid_feedback');
    const useful=value.useful,reason=typeof value.reason==='string'?value.reason:null;
    return this.store.transaction(()=>{
      const sql=this.store.connection;
      // Media may expire, but only an account's actual published recording can be rated.
      const published=sql.prepare(`SELECT 1 FROM credit_reservations r JOIN accounts a ON a.owner=r.owner
        WHERE r.job_id=? AND r.owner=? AND a.admission_status!='deleted'
        AND EXISTS (SELECT 1 FROM hosted_exports e WHERE e.job_id=r.job_id)`).get(id,owner);
      if(!published)throw new Error('recording_not_found');
      sql.prepare(`INSERT INTO hosted_recording_feedback VALUES (?,?,?,?,
        coalesce((SELECT cohort FROM hosted_account_cohorts WHERE owner=?),?),?,?)
        ON CONFLICT(job_id) DO UPDATE SET useful=excluded.useful,reason=excluded.reason,updated_at=excluded.updated_at
        WHERE hosted_recording_feedback.useful!=excluded.useful OR hosted_recording_feedback.reason IS NOT excluded.reason`)
        .run(id,owner,useful?1:0,reason,owner,this.cohort,now,now);
      return {state:'saved',useful,...(reason===null?{}:{reason})};
    });
  }
  snapshot(now=Date.now()){
    const start=now-30*86400000;
    const rows=this.store.connection.prepare(`SELECT cohort,useful,reason,count(*) recordings,count(DISTINCT owner) accounts
      FROM hosted_recording_feedback WHERE updated_at>=? AND updated_at<=? GROUP BY cohort,useful,reason`).all(start,now);
    return {windowStart:new Date(start).toISOString(),windowEnd:new Date(now).toISOString(),
      groups:rows.map(row=>({cohort:String(row.cohort),useful:row.useful===1,reason:row.reason,
        recordings:Number(row.recordings),accounts:Number(row.accounts)})),
      interpretation:'Latest voluntary response per published recording, updated in this window. Duplicate submissions do not add votes or refresh timestamps. Cohort is recorded at first response. Not a satisfaction rate across all deliveries; nonrespondents are excluded. No text, contact details or automatic credit adjustments.'};
  }
  /** Remove responses once they can no longer appear in the thirty-day report. */
  prune(now=Date.now()){
    if(!Number.isSafeInteger(now)||now<0)throw new Error('invalid_feedback_time');
    return this.store.connection.prepare('DELETE FROM hosted_recording_feedback WHERE updated_at<?')
      .run(now-30*86400000).changes;
  }
}
