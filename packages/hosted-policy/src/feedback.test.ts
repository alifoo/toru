import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {RecordingFeedback} from './feedback.js';
import {ProductEvents} from './events.js';
import {CreditLedger,type TransactionalStore} from './index.js';

it('scopes feedback to published owner recordings, deduplicates and leaves credits unchanged',()=>{
  const db=new DatabaseSync(':memory:');
  const store:TransactionalStore={connection:db,transaction(work){db.exec('BEGIN');try{const value=work();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
  try{
    db.exec("CREATE TABLE accounts(owner TEXT PRIMARY KEY,admission_status TEXT NOT NULL DEFAULT 'admitted');");
    const owner=randomUUID(),other=randomUUID(),job=randomUUID(),pending=randomUUID(),now=40*86400000;
    for(const id of [owner,other])db.prepare('INSERT INTO accounts(owner) VALUES (?)').run(id);
    new ProductEvents(store,'fixture');const ledger=new CreditLedger(store);
    ledger.reserve(owner,job,randomUUID(),'a'.repeat(64));ledger.commit(owner,job,randomUUID());
    db.prepare('INSERT INTO hosted_exports VALUES (?,?,?)').run(job,randomUUID(),now);
    ledger.reserve(owner,pending,randomUUID(),'b'.repeat(64));
    const before=JSON.stringify(ledger.usage(owner));const feedback=new RecordingFeedback(store,'fixture');
    expect(()=>feedback.submit(other,job,{useful:true},now)).toThrow('recording_not_found');
    expect(()=>feedback.submit(owner,pending,{useful:true},now)).toThrow('recording_not_found');
    for(const input of [null,{useful:'yes'},{useful:true,reason:'quality'},{useful:false,reason:'secret text'}])
      expect(()=>feedback.submit(owner,job,input,now)).toThrow('invalid_feedback');
    feedback.submit(owner,job,{useful:false,reason:'quality'},now);
    feedback.submit(owner,job,{useful:false,reason:'quality'},now+1000);
    expect(db.prepare('SELECT count(*) n,min(updated_at) t FROM hosted_recording_feedback').get()).toMatchObject({n:1,t:now});
    feedback.submit(owner,job,{useful:true},now+2000);
    expect(feedback.snapshot(now+2000).groups).toEqual([{cohort:'fixture',useful:true,reason:null,recordings:1,accounts:1}]);
    expect(JSON.stringify(feedback.snapshot(now+2000))).not.toContain(owner);
    expect(JSON.stringify(ledger.usage(owner))).toBe(before);
    expect(feedback.prune(now+2000+30*86400000)).toBe(0);
    expect(feedback.prune(now+2001+30*86400000)).toBe(1);
    expect(feedback.prune(now+2001+30*86400000)).toBe(0);
    expect(feedback.snapshot(now+2001+30*86400000).groups).toEqual([]);
    expect(JSON.stringify(ledger.usage(owner))).toBe(before);
    db.prepare("UPDATE accounts SET admission_status='deleted' WHERE owner=?").run(owner);
    expect(()=>feedback.submit(owner,job,{useful:false},now)).toThrow('recording_not_found');
  }finally{db.close();}
});
