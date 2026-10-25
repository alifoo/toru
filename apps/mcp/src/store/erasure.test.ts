import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {eraseAccountData} from './erasure.js';
import {DesktopDeviceStore} from './desktop-devices.js';
import {openRecorderStore} from './open.js';

const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});

it('requires an erasure lifecycle for a registered extension even when the owner has no jobs',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'recorder-extension-erasure-')),owner=randomUUID();
  directories.push(directory);
  const db=await openRecorderStore(directory);
  db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
  db.connection.exec(`CREATE TABLE recorder_extension_requirements(operation TEXT PRIMARY KEY) STRICT;
    INSERT INTO recorder_extension_requirements VALUES ('account_erasure');`);
  db.close();
  await expect(eraseAccountData(directory,owner)).rejects.toThrow('extension_deletion_adapter_required');
  const unchanged=await openRecorderStore(directory);
  expect(unchanged.connection.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner)?.admission_status).toBe('admitted');
  unchanged.close();
  await expect(eraseAccountData(directory,owner,()=>({
    admit(){throw new Error('not_used');},delivered(){},abandon(){},usage(){return {};},
    assertAccountEraseAllowed(){},eraseAccountData(){},
  }))).resolves.toMatchObject({state:'data_removed',accountTombstoneRetained:true});
});

it('erases durable Mac credentials with account data',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recorder-device-erasure-')),owner=randomUUID();
 directories.push(directory);
 const db=await openRecorderStore(directory);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
 new DesktopDeviceStore(db).register(owner,'Mac');
 db.close();
 await eraseAccountData(directory,owner);
 const after=await openRecorderStore(directory);
 try{expect(after.connection.prepare('SELECT count(*) AS n FROM desktop_devices WHERE owner=?').get(owner)?.n).toBe(0);}
 finally{after.close();}
});
