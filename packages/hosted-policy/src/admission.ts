import type {TransactionalStore} from './index.js';

/** Private hosted beta admission. Issuing a token is not sufficient to bypass this gate. */
export class BetaAdmission {
  constructor(private readonly store:TransactionalStore,private readonly capacity=25) {
    if(!Number.isSafeInteger(capacity)||capacity<0||capacity>10000)throw new Error('invalid_beta_capacity');
    store.transaction(()=>store.connection.exec(`CREATE TABLE IF NOT EXISTS hosted_admissions (
      owner TEXT PRIMARY KEY REFERENCES accounts(owner), state TEXT NOT NULL CHECK(state IN ('waiting','admitted')),
      requested_at INTEGER NOT NULL, admitted_at INTEGER
    ) STRICT;`));
  }
  check(owner:string,now=Date.now()):{state:string;position?:number} {
    const work=()=>{
      const sql=this.store.connection;
      // A suspended account loses its seat. If restored, it joins again at the end.
      sql.prepare(`DELETE FROM hosted_admissions WHERE owner IN (
        SELECT owner FROM accounts WHERE admission_status IN ('suspended','deleted'))`).run();
      const account=sql.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner);
      if(!account)throw new Error('account_not_found');
      if(['suspended','deleted'].includes(String(account.admission_status)))return {state:String(account.admission_status)};
      const existing=sql.prepare('SELECT state FROM hosted_admissions WHERE owner=?').get(owner);
      if(existing?.state==='admitted')return {state:'admitted'};
      sql.prepare("INSERT INTO hosted_admissions VALUES (?,'waiting',?,NULL) ON CONFLICT(owner) DO NOTHING").run(owner,now);
      const count=Number(sql.prepare("SELECT count(*) n FROM hosted_admissions h JOIN accounts a ON a.owner=h.owner WHERE h.state='admitted' AND a.admission_status='admitted'").get()!.n);
      const vacancies=Math.max(0,this.capacity-count);
      if(vacancies){
        const next=sql.prepare(`SELECT h.owner FROM hosted_admissions h JOIN accounts a ON a.owner=h.owner
          WHERE h.state='waiting' AND a.admission_status NOT IN ('suspended','deleted')
          ORDER BY h.requested_at,h.owner LIMIT ?`).all(vacancies);
        const admit=sql.prepare("UPDATE hosted_admissions SET state='admitted',admitted_at=? WHERE owner=?");
        const accountAdmit=sql.prepare("UPDATE accounts SET admission_status='admitted' WHERE owner=?");
        for(const row of next){const nextOwner=String(row.owner);admit.run(now,nextOwner);accountAdmit.run(nextOwner);}
      }
      const current=sql.prepare('SELECT state,requested_at FROM hosted_admissions WHERE owner=?').get(owner)!;
      if(current.state==='admitted')return {state:'admitted'};
      const position=Number(sql.prepare(`SELECT count(*) n FROM hosted_admissions h
        WHERE h.state='waiting' AND (h.requested_at<? OR (h.requested_at=? AND h.owner<=?))`)
        .get(Number(current.requested_at),Number(current.requested_at),owner)!.n);
      return {state:'waiting',position};
    };
    // Recorder admission may already be in a transaction; no asynchronous work here.
    return this.store.connection.isTransaction?work():this.store.transaction(work);
  }
}
