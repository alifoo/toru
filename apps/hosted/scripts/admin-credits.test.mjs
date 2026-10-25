import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {CreditLedger} from '@agent-recorder/hosted-policy';
import {createAdminCreditsHandler} from '../dist/admin-credits.js';

const owner='11111111-1111-4111-8111-111111111111';
const grantId='33333333-3333-4333-8333-333333333333';
const url=new URL('https://recorder.example/admin/credits/grant');
function request(body,authorization='Bearer admin-secret',method='POST'){
  const input=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);
  input.method=method;input.headers={authorization,'content-type':'application/json'};
  return input;
}
function reply(){return {status:0,body:'',writeHead(status){this.status=status;return this;},end(body=''){this.body=body;}};}

test('operator credit grants need the admin key, validate input and are idempotent',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recorder-admin-credits-'));
  try{
    await withRecorderStore(dir,db=>{new CreditLedger(db);db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());});
    const handler=createAdminCreditsHandler(dir,'admin-secret');
    assert.equal(await handler(request({owner,credits:5,grantId}),reply(),new URL('https://recorder.example/other')),false);
    const denied=reply();await handler(request({owner,credits:5,grantId},'Bearer wrong'),denied,url);
    assert.equal(denied.status,404);
    const get=reply();await handler(request({},'Bearer admin-secret','GET'),get,url);
    assert.equal(get.status,405);
    const invalid=reply();await handler(request({owner,credits:500,grantId}),invalid,url);
    assert.deepEqual([invalid.status,JSON.parse(invalid.body)],[400,{error:'admin_grant_invalid'}]);
    const garbage=reply();await handler(request('not json'),garbage,url);
    assert.equal(garbage.status,400);
    const unknown=reply();await handler(request({owner:'22222222-2222-4222-8222-222222222222',credits:1,grantId:'44444444-4444-4444-8444-444444444444'}),unknown,url);
    assert.equal(unknown.status,404);
    const granted=reply();await handler(request({owner,credits:5,grantId}),granted,url);
    assert.equal(granted.status,201);
    assert.equal(JSON.parse(granted.body).credits,5);
    const replay=reply();await handler(request({owner,credits:5,grantId}),replay,url);
    assert.deepEqual([replay.status,JSON.parse(replay.body).alreadyGranted],[200,true]);
    const conflict=reply();await handler(request({owner,credits:6,grantId}),conflict,url);
    assert.deepEqual([conflict.status,JSON.parse(conflict.body)],[400,{error:'admin_grant_conflict'}]);
    const total=await withRecorderStore(dir,db=>Number(db.connection.prepare("SELECT sum(granted) n FROM credit_buckets WHERE owner=? AND source='admin'").get(owner).n));
    assert.equal(total,5);
  }finally{await rm(dir,{recursive:true,force:true});}
});
