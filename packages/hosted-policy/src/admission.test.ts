import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {expect,it} from 'vitest';
import {BetaAdmission} from './admission.js';
import type {TransactionalStore} from './index.js';
function store(connection:DatabaseSync):TransactionalStore{return {connection,transaction(work){connection.exec('BEGIN IMMEDIATE');try{const result=work();connection.exec('COMMIT');return result;}catch(error){connection.exec('ROLLBACK');throw error;}}};}
it('bounds admissions durably across connections and leaves suspended/deleted accounts denied',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admission-')),path=join(directory,'db.sqlite');
 const first=new DatabaseSync(path);first.exec("PRAGMA journal_mode=WAL;CREATE TABLE accounts(owner TEXT PRIMARY KEY,admission_status TEXT NOT NULL DEFAULT 'admitted');INSERT INTO accounts(owner) VALUES ('a'),('b'),('c');");
 const second=new DatabaseSync(path);
 try {
  const one=new BetaAdmission(store(first),1),two=new BetaAdmission(store(second),1);
  expect(one.check('a')).toEqual({state:'admitted'});expect(two.check('b')).toEqual({state:'waiting',position:1});
  expect(one.check('a')).toEqual({state:'admitted'});
  expect(second.prepare("SELECT count(*) n FROM hosted_admissions WHERE state='admitted'").get()!.n).toBe(1);
  const expanded=new BetaAdmission(store(second),2);expect(expanded.check('b')).toEqual({state:'admitted'});expect(expanded.check('c')).toEqual({state:'waiting',position:1});
  first.prepare("UPDATE accounts SET admission_status='suspended' WHERE owner='a'").run();
  expect(one.check('a')).toEqual({state:'suspended'});
  first.prepare("UPDATE accounts SET admission_status='deleted' WHERE owner='a'").run();expect(one.check('a')).toEqual({state:'deleted'});
  expect(expanded.check('c')).toEqual({state:'admitted'});
  expect(()=>new BetaAdmission(store(first),NaN)).toThrow('invalid_beta_capacity');
 }finally{second.close();first.close();await rm(directory,{recursive:true,force:true});}
});

it('promotes the oldest waiter before a newer visitor and keeps positions stable',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admission-order-')),path=join(directory,'db.sqlite');
 const db=new DatabaseSync(path);
 db.exec("CREATE TABLE accounts(owner TEXT PRIMARY KEY,admission_status TEXT NOT NULL DEFAULT 'admitted');INSERT INTO accounts(owner) VALUES ('a'),('b'),('c'),('d');");
 try{
  const admission=new BetaAdmission(store(db),1);
  expect(admission.check('a',100)).toEqual({state:'admitted'});
  expect(admission.check('b',101)).toEqual({state:'waiting',position:1});
  expect(admission.check('c',102)).toEqual({state:'waiting',position:2});
  expect(admission.check('c',105)).toEqual({state:'waiting',position:2});
  db.prepare("UPDATE accounts SET admission_status='suspended' WHERE owner='a'").run();
  expect(admission.check('d',106)).toEqual({state:'waiting',position:2});
  expect(admission.check('b',107)).toEqual({state:'admitted'});
  expect(admission.check('c',108)).toEqual({state:'waiting',position:1});
  db.prepare("UPDATE accounts SET admission_status='admitted' WHERE owner='a'").run();
  expect(admission.check('a',109)).toEqual({state:'waiting',position:3});
 }finally{db.close();await rm(directory,{recursive:true,force:true});}
});
