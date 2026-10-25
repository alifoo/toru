import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {RecorderDatabase} from './database.js';
import {DesktopDeviceStore} from './desktop-devices.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'toru-device-')),path=join(dir,'recorder.sqlite');
 let db=new RecorderDatabase(path);
 cleanups.push(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run('owner',0);
 return {get db(){return db;},store:()=>new DesktopDeviceStore(db),restart:()=>{db.close();db=new RecorderDatabase(path);}};
}
it('retains hashed device identity across restart, rotates once and revokes only for the owner',async()=>{
 const f=await fixture(),issued=f.store().register('owner','My Mac',100);
 const persisted=JSON.stringify(f.db.connection.prepare('SELECT * FROM desktop_devices').get());
 expect(persisted).not.toContain(issued.accessToken);expect(persisted).not.toContain(issued.refreshToken);
 f.restart();
 expect(f.store().authenticate(issued.accessToken,200)?.id).toBe(issued.deviceId);
 expect(f.store().list('other')).toEqual([]);
 const refreshed=f.store().refresh(issued.refreshToken,300)!;
 expect(refreshed.deviceId).toBe(issued.deviceId);
 expect(f.store().refresh(issued.refreshToken,400)).toBeUndefined();
 expect(f.store().authenticate(issued.accessToken,400)).toBeUndefined();
 expect(f.store().revoke('other',issued.deviceId,500)).toBe(false);
 expect(f.store().authenticate(refreshed.accessToken,500)?.owner).toBe('owner');
 expect(f.store().revoke('owner',issued.deviceId,600)).toBe(true);
 expect(f.store().authenticate(refreshed.accessToken,700)).toBeUndefined();
 expect(f.store().refresh(refreshed.refreshToken,700)).toBeUndefined();
});
it('expires access, rejects expired refresh and suspended accounts without creating capture consent',async()=>{
 const f=await fixture(),issued=f.store().register('owner','Mac',100);
 expect(f.store().authenticate(issued.accessToken,issued.accessExpiresAt)).toBeUndefined();
 expect(f.store().refresh(issued.refreshToken,issued.refreshExpiresAt)).toBeUndefined();
 expect(f.store().authenticate(issued.accessToken,200)).not.toHaveProperty('captureConsent');
 f.db.connection.prepare("UPDATE accounts SET admission_status='suspended' WHERE owner='owner'").run();
 expect(f.store().authenticate(issued.accessToken,200)).toBeUndefined();
 expect(f.store().refresh(issued.refreshToken,200)).toBeUndefined();
 expect(()=>f.store().register('owner','Another',200)).toThrow('account_not_admitted');
});
