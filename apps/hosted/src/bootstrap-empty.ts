import {openRecorderStore,readLegacySnapshot} from '@agent-recorder/mcp/store/open';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {activateOperationalPolicy,dailyLimitsFromEnvironment,
  deploymentIdentityFromEnvironment} from '@agent-recorder/mcp/policies';
import {createHostedLifecycle} from '@agent-recorder/hosted-policy/dist/adapter.js';
import {deletionBucketConfig,type DeletionBucketJournal} from '@agent-recorder/hosted-policy/dist/deletion-bucket.js';

/** Bind a fresh beta volume without opening or migrating the legacy service volume. */
export async function bootstrapEmptyHostedStore(dataDir:string,env:NodeJS.ProcessEnv,
  bucket:Pick<DeletionBucketJournal,'initialize'>):Promise<void>{
  const identity=deploymentIdentityFromEnvironment(env),config=deletionBucketConfig(env);
  if(identity.environment!=='production'||!config||env.HOSTED_BOOTSTRAP_LEGACY||env.HOSTED_LEGACY_SNAPSHOT_SHA256)
    throw new Error('empty_bootstrap_config_invalid');
  let initialized=false;
  try{initialized=(await stat(join(dataDir,'recorder.sqlite'))).isFile();}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!initialized){
    const legacy=await readLegacySnapshot(dataDir);
    if(legacy.sources.length)throw new Error('empty_bootstrap_legacy_data_present');
  }
  const store=await openRecorderStore(dataDir);
  try{
    const sql=store.connection;
    for(const table of ['accounts','grants','jobs','session_imports']){
      if(Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)!==0)
        throw new Error('empty_bootstrap_existing_data');
    }
    activateOperationalPolicy(store,dailyLimitsFromEnvironment(env),identity);
    createHostedLifecycle(store);
    sql.exec(`CREATE TABLE IF NOT EXISTS hosted_deletion_bucket_binding (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),bucket TEXT NOT NULL,bound_at INTEGER NOT NULL
    ) STRICT;`);
    const bound=sql.prepare('SELECT bucket FROM hosted_deletion_bucket_binding WHERE singleton=1').get();
    if(bound&&bound.bucket!==config.name)throw new Error('hosted_deletion_bucket_binding_mismatch');
    await bucket.initialize(dataDir);
    if(!bound)store.transaction(()=>sql.prepare('INSERT INTO hosted_deletion_bucket_binding VALUES (1,?,?)')
      .run(config.name,Date.now()));
  }finally{store.close();}
}
