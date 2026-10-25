import {mkdir,realpath,lstat,open,readdir,readFile} from 'node:fs/promises';
import {join,relative,isAbsolute,resolve,dirname,sep} from 'node:path';
import {eraseAccountData} from '@agent-recorder/mcp/erasure';
import {createHostedLifecycle} from './adapter.js';
import {DatabaseSync} from 'node:sqlite';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function directory(path:string,dataDir:string,create:boolean){
 if(create){
  // The independently provisioned parent must already exist; persist the new directory entry too.
  try{await mkdir(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const parent=await open(dirname(path),'r');try{await parent.sync();}finally{await parent.close();}
 }
 if(!(await lstat(path)).isDirectory())throw new Error('deletion_journal_directory_required');
 const journal=await realpath(path),data=await realpath(dataDir),rel=relative(data,journal);
 if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw new Error('deletion_journal_must_be_outside_data');
 return journal;
}
async function read(path:string,owner:string){
 if(!(await lstat(path)).isFile())throw new Error('invalid_deletion_journal_entry');
 const entry=JSON.parse(await readFile(path,'utf8'));
 if(entry.version!==1||entry.owner!==owner||!Number.isSafeInteger(entry.requestedAt)||entry.requestedAt<0)throw new Error('invalid_deletion_journal_entry');
 return entry;
}
export function deletionJournalIdentity(dataDir:string){
 const db=new DatabaseSync(join(dataDir,'recorder.sqlite'),{readOnly:true});
 let identity;
 try{
  if(Number(db.prepare('PRAGMA application_id').get()!.application_id)!==0x41525243)throw new Error('not_a_recorder_database');
  identity=db.prepare('SELECT environment,instance_id FROM instance_identity WHERE singleton=1').get();
 }finally{db.close();}
 if(!identity)throw new Error('deletion_journal_volume_identity_required');
 return {version:1,environment:String(identity.environment),instanceId:String(identity.instance_id)};
}
async function bind(root:string,dataDir:string,create:boolean){
 const expected=deletionJournalIdentity(dataDir),path=join(root,'manifest.json');
 if(create){
  const names=await readdir(root);
  if(!names.includes('manifest.json')){
   if(names.length)throw new Error('unbound_deletion_journal_requires_migration');
   let file;
   try{file=await open(path,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   if(file){try{await file.writeFile(JSON.stringify(expected));await file.sync();}finally{await file.close();}}
   const parent=await open(root,'r');try{await parent.sync();}finally{await parent.close();}
  }
 }
 if(!(await lstat(path)).isFile())throw new Error('invalid_deletion_journal_manifest');
 const actual=JSON.parse(await readFile(path,'utf8'));
 if(actual.version!==1||actual.environment!==expected.environment||actual.instanceId!==expected.instanceId)throw new Error('deletion_journal_volume_identity_mismatch');
}
/** Durable deletion intent outside the restorable volume; stores pseudonymous owner IDs, not names/emails. */
export async function recordDeletion(journalDir:string,dataDir:string,owner:string){
 if(!uuid.test(owner))throw new Error('invalid_deletion_owner');
 const root=await directory(resolve(journalDir),dataDir,true),path=join(root,`${owner}.json`);
 await bind(root,dataDir,true);
 let file;
 try{file=await open(path,'wx',0o600);}catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  return read(path,owner);
 }
 const entry={version:1,owner,requestedAt:Date.now()};
 try{await file.writeFile(JSON.stringify(entry));await file.sync();}finally{await file.close();}
 const parent=await open(root,'r');try{await parent.sync();}finally{await parent.close();}
 return entry;
}
export async function replayDeletions(journalDir:string,dataDir:string){
 const root=await directory(resolve(journalDir),dataDir,false),owners:string[]=[];
 const names=(await readdir(root)).sort();
 if(names.length)await bind(root,dataDir,false);
 // Validate the whole journal before applying anything. Missing/malformed journals fail closed.
 for(const name of names){
  if(name==='manifest.json')continue;
  const owner=name.slice(0,-5);
  if(!name.endsWith('.json')||!uuid.test(owner))throw new Error('invalid_deletion_journal_entry');
  await read(join(root,name),owner);owners.push(owner);
 }
 for(const owner of owners)await eraseAccountData(dataDir,owner,createHostedLifecycle,{tombstoneMissingAccount:true});
 return {reapplied:owners.length};
}
