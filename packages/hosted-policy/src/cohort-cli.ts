import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {ProductEvents,type UsageCohort} from './events.js';
import type {TransactionalStore} from './index.js';
const {values}=parseArgs({options:{database:{type:'string'},owner:{type:'string'},cohort:{type:'string'}},strict:true});
if(!values.database||!values.owner||!values.cohort)throw new Error('Required: --database /path/recorder.sqlite --owner UUID --cohort internal|fixture|bot|external|unclassified');
if(!lstatSync(values.database).isFile())throw new Error('existing_database_file_required');
const db=new DatabaseSync(values.database);
try{
  if(Number(db.prepare('PRAGMA application_id').get()!.application_id)!==0x41525243)throw new Error('not_a_recorder_database');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='hosted_product_events'").get())throw new Error('start_hosted_service_before_classifying');
  db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;');
  const store:TransactionalStore={connection:db,transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
  console.log(JSON.stringify(new ProductEvents(store).classify(values.owner,values.cohort as UsageCohort)));
}finally{db.close();}
