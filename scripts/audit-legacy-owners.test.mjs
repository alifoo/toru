import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {auditLegacyOwners,recorderOwnerFor} from './audit-legacy-owners.mjs';

test('compares unique legacy owners with a complete Clerk ID export without inferring erasure',()=>{
 const active=recorderOwnerFor('user_Active123'),unknown='00000000-0000-4000-8000-000000000001';
 const report=auditLegacyOwners(JSON.stringify({invites:[{owner:active,tokenHash:'secret'},{owner:active},{owner:unknown}]}),
  'user_Active123\nuser_Other456\n',2);
 assert.equal(report.legacyGrantCount,3);
 assert.equal(report.legacyOwnerCount,2);
 assert.equal(report.matchedOwnerCount,1);
 assert.deepEqual(report.unmatchedOwners,[unknown]);
 assert.equal(JSON.stringify(report).includes('secret'),false);
 assert.match(report.interpretation,/does not prove deletion/);
});

test('rejects incomplete, duplicate and malformed identity exports',()=>{
 const invites=JSON.stringify({invites:[{owner:recorderOwnerFor('user_Active123')}]});
 assert.throws(()=>auditLegacyOwners(invites,'user_Active123\n',2),/incomplete_clerk_export/);
 assert.throws(()=>auditLegacyOwners(invites,'user_Active123\nuser_Active123\n',2),/invalid_clerk_ids/);
 assert.throws(()=>auditLegacyOwners(invites,'not-a-user\n',1),/invalid_clerk_ids/);
 assert.throws(()=>auditLegacyOwners(JSON.stringify({invites:[{owner:'bad'}]}),'',0),/invalid_legacy_owner/);
});

test('CLI writes only a new private report and refuses to overwrite it',()=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-owner-audit-'));
 try{
  const invites=join(dir,'invites.json'),ids=join(dir,'ids.txt'),report=join(dir,'report.json');
  writeFileSync(invites,JSON.stringify({invites:[{owner:recorderOwnerFor('user_Active123'),tokenHash:'private-token-hash'}]}));
  writeFileSync(ids,'user_Active123\n');
  const args=[fileURLToPath(new URL('./audit-legacy-owners.mjs',import.meta.url)),
   '--invites',invites,'--clerk-ids',ids,'--expected-clerk-count','1','--report',report];
  const first=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);
  assert.equal(statSync(report).mode&0o777,0o600);
  assert.equal(readFileSync(report,'utf8').includes('private-token-hash'),false);
  const second=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(second.status,1);
  assert.match(second.stderr,/EEXIST/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
