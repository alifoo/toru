import type {TransactionalStore} from './index.js';
const cohorts=['unclassified','internal','fixture','bot','external'] as const;
export type UsageCohort=typeof cohorts[number];
type EventName='admission_granted'|'mcp_connected'|'demo_started'|'capture_finalized'|'render_completed'|'download_completed';
/** Private hosted telemetry: fixed event fields only, never URLs, prompts or credentials. */
export class ProductEvents {
  constructor(private readonly store:TransactionalStore,private readonly cohort:UsageCohort='unclassified'){
    if(!cohorts.includes(cohort))throw new Error('invalid_usage_cohort');
    store.transaction(()=>store.connection.exec(`CREATE TABLE IF NOT EXISTS hosted_product_events (
      event_key TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner),
      name TEXT NOT NULL CHECK(name IN ('admission_granted','render_completed')),
      cohort TEXT NOT NULL CHECK(cohort IN ('unclassified','internal','fixture','bot','external')),
      occurred_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS hosted_product_events_window ON hosted_product_events(occurred_at,cohort,name);
    CREATE TABLE IF NOT EXISTS hosted_account_cohorts (
      owner TEXT PRIMARY KEY REFERENCES accounts(owner),cohort TEXT NOT NULL,updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS hosted_cohort_changes (
      sequence INTEGER PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(owner),previous_cohort TEXT,
      cohort TEXT NOT NULL,changed_at INTEGER NOT NULL
    ) STRICT;`));
    store.transaction(()=>{
      const sql=store.connection;
      sql.exec('CREATE TABLE IF NOT EXISTS hosted_event_schema(version INTEGER PRIMARY KEY);INSERT OR IGNORE INTO hosted_event_schema VALUES (1);');
      const version=Number(sql.prepare('SELECT max(version) version FROM hosted_event_schema').get()!.version);
      if(version>4)throw new Error('hosted_event_schema_newer_than_binary');
      if(version===1){
        sql.exec(`ALTER TABLE hosted_product_events RENAME TO hosted_product_events_v1;
          CREATE TABLE hosted_product_events (
            event_key TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(owner),
            name TEXT NOT NULL CHECK(name IN ('admission_granted','demo_started','capture_finalized','render_completed')),
            cohort TEXT NOT NULL CHECK(cohort IN ('unclassified','internal','fixture','bot','external')),occurred_at INTEGER NOT NULL
          ) STRICT;
          INSERT INTO hosted_product_events SELECT * FROM hosted_product_events_v1;
          DROP TABLE hosted_product_events_v1;
          CREATE INDEX hosted_product_events_window ON hosted_product_events(occurred_at,cohort,name);
          INSERT INTO hosted_event_schema VALUES (2);`);
      }
      if(version<3){
        sql.exec(`ALTER TABLE hosted_product_events RENAME TO hosted_product_events_v2;
          CREATE TABLE hosted_product_events (
            event_key TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(owner),
            name TEXT NOT NULL CHECK(name IN ('admission_granted','demo_started','capture_finalized','render_completed','download_completed')),
            cohort TEXT NOT NULL CHECK(cohort IN ('unclassified','internal','fixture','bot','external')),occurred_at INTEGER NOT NULL
          ) STRICT;
          INSERT INTO hosted_product_events SELECT * FROM hosted_product_events_v2;
          DROP TABLE hosted_product_events_v2;
          CREATE INDEX hosted_product_events_window ON hosted_product_events(occurred_at,cohort,name);
          INSERT INTO hosted_event_schema VALUES (3);`);
      }
      if(version<4){
        sql.exec(`ALTER TABLE hosted_product_events RENAME TO hosted_product_events_v3;
          CREATE TABLE hosted_product_events (
            event_key TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(owner),
            name TEXT NOT NULL CHECK(name IN ('admission_granted','mcp_connected','demo_started','capture_finalized','render_completed','download_completed')),
            cohort TEXT NOT NULL CHECK(cohort IN ('unclassified','internal','fixture','bot','external')),occurred_at INTEGER NOT NULL
          ) STRICT;
          INSERT INTO hosted_product_events SELECT * FROM hosted_product_events_v3;
          DROP TABLE hosted_product_events_v3;
          CREATE INDEX hosted_product_events_window ON hosted_product_events(occurred_at,cohort,name);
          INSERT INTO hosted_event_schema VALUES (4);`);
      }
    });
  }
  classify(owner:string,cohort:UsageCohort,now=Date.now()){
    if(!cohorts.includes(cohort)||!Number.isSafeInteger(now)||now<0)throw new Error('invalid_usage_cohort');
    return this.store.transaction(()=>{
      const sql=this.store.connection;
      if(!sql.prepare('SELECT 1 FROM accounts WHERE owner=?').get(owner))throw new Error('account_not_found');
      const previous=sql.prepare('SELECT cohort FROM hosted_account_cohorts WHERE owner=?').get(owner)?.cohort;
      if(previous===cohort)return {cohort,changed:false};
      sql.prepare('INSERT INTO hosted_account_cohorts VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET cohort=excluded.cohort,updated_at=excluded.updated_at').run(owner,cohort,now);
      sql.prepare('INSERT INTO hosted_cohort_changes(owner,previous_cohort,cohort,changed_at) VALUES (?,?,?,?)').run(owner,previous??null,cohort,now);
      return {cohort,changed:true};
    });
  }
  record(owner:string,name:EventName,entityId:string,now=Date.now()){
    if(!['admission_granted','mcp_connected','demo_started','capture_finalized','render_completed','download_completed'].includes(name)||!Number.isSafeInteger(now)||now<0)throw new Error('invalid_product_event');
    if(!/^[0-9a-f-]{36}$/i.test(entityId))throw new Error('invalid_event_entity');
    // MCP activity is one event per owner per UTC day; distinct accounts remain available in the snapshot.
    const key=name==='mcp_connected'?`${name}:${entityId}:${new Date(now).toISOString().slice(0,10)}`:`${name}:${entityId}`;
    // Classification and insert use one statement, including with a concurrent operator update.
    this.store.connection.prepare('INSERT INTO hosted_product_events SELECT ?,?,?,coalesce((SELECT cohort FROM hosted_account_cohorts WHERE owner=?),?),? ON CONFLICT(event_key) DO NOTHING')
      .run(key,owner,name,owner,this.cohort,now);
  }
  snapshot(now=Date.now()){
    const start=now-30*86400000;
    const rows=this.store.connection.prepare(`SELECT cohort,name,count(*) events,count(DISTINCT owner) accounts
      FROM hosted_product_events WHERE occurred_at>=? AND occurred_at<=? GROUP BY cohort,name`).all(start,now);
    return {windowStart:new Date(start).toISOString(),windowEnd:new Date(now).toISOString(),
      groups:rows.map(row=>({cohort:String(row.cohort),event:String(row.name),events:Number(row.events),accounts:Number(row.accounts)})),
      interpretation:'Admission, first successful authenticated MCP tool use per owner per UTC day, capture start/finalization and first MP4 publication events, deduplicated. MCP event count is active account-days; its accounts count is distinct owners in this window. The MCP connection probe only lists tools and is excluded. Download counts only complete attachment responses emitted by the server, once per recording; excludes previews, HEAD, partial ranges and detected disconnects. It does not prove the user saved or watched the file. Publication is not download or satisfaction. Counts in this window are not same-cohort conversion rates. Unclassified/internal/fixture/bot are not external adoption. No full signup-to-payment funnel yet.'};
  }
  prune(now=Date.now()){
    if(!Number.isSafeInteger(now)||now<0)throw new Error('invalid_product_event_time');
    return this.store.connection.prepare('DELETE FROM hosted_product_events WHERE occurred_at<?')
      .run(now-30*86400000).changes;
  }
}
