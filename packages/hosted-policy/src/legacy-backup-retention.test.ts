import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {exportLegacyBackup,restoreLegacyBackup} from './legacy-backup.js';
import {legacyBackupRoot,pruneLegacyBackupObjects,type LegacyBackupRetentionObjects} from './legacy-backup-retention.js';

const old='11111111-1111-4111-8111-111111111111',recent='22222222-2222-4222-8222-222222222222';
const incomplete='33333333-3333-4333-8333-333333333333',now=2_000_000_000_000,day=86_400_000;
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'recorder-backup-retention-'));
  await writeFile(join(dir,'invites.json'),JSON.stringify({invites:[{owner:old,tokenHash:'a'.repeat(64),expiresAt:now}]}));
  await writeFile(join(dir,'usage.json'),'{}');
  const values=new Map<string,{body:Uint8Array;modifiedAt:number}>();let timestamp=now-20*day,writes=0,deletes=0;
  const objects:LegacyBackupRetentionObjects={
    async put(key,body){values.set(key,{body:Uint8Array.from(body),modifiedAt:timestamp});writes++;},
    async get(key){const value=values.get(key);return value&&Uint8Array.from(value.body);},
    async list(){return [...values].map(([key,value])=>({key,modifiedAt:value.modifiedAt,
      etag:createHash('sha256').update(value.body).digest('hex')}));},
    async remove(key){values.delete(key);deletes++;}
  };
  const backup=await exportLegacyBackup(dir,objects,old,timestamp);
  const baseline=writes;
  return {dir,objects,values,backup,setTime:(time:number)=>{timestamp=time;},
    writes:()=>writes-baseline,deletes:()=>deletes,close:()=>rm(dir,{recursive:true,force:true})};
}

it('previews without mutation, expires old complete/incomplete copies and preserves a recently modified copy',async()=>{
  const f=await fixture();
  try{
    await f.objects.put(legacyBackupRoot+incomplete+'/imports/partial.json',Buffer.from('partial'));
    f.setTime(now-1*day);await exportLegacyBackup(f.dir,f.objects,recent,now-20*day);
    const writes=f.writes(),before=f.values.size;
    const preview=await pruneLegacyBackupObjects(f.objects,7,false,now);
    expect(preview).toMatchObject({mode:'dry-run',expiredBackups:2,plannedObjects:4,incompleteBackups:1,removedObjects:0});
    expect(f.values.size).toBe(before);expect(f.writes()).toBe(writes);expect(f.deletes()).toBe(0);
    const applied=await pruneLegacyBackupObjects(f.objects,7,true,now);
    expect(applied.removedObjects).toBe(4);
    expect(f.values.has(legacyBackupRoot+old+'/expired.json')).toBe(true);
    expect(f.values.has(legacyBackupRoot+incomplete+'/expired.json')).toBe(true);
    expect(f.values.has(legacyBackupRoot+recent+'/manifest.json')).toBe(true);
    expect((await pruneLegacyBackupObjects(f.objects,7,true,now)).expiredBackups).toBe(0);
  }finally{await f.close();}
});

it('fences restoration and ID reuse before deleting bytes; an interrupted sweep resumes',async()=>{
  const f=await fixture();
  try{
    const remove=f.objects.remove;let calls=0;
    f.objects.remove=async key=>{if(++calls===2)throw new Error('temporary_delete_failure');await remove(key);};
    await expect(pruneLegacyBackupObjects(f.objects,7,true,now)).rejects.toThrow('temporary_delete_failure');
    expect(f.values.has(legacyBackupRoot+old+'/expired.json')).toBe(true);
    await expect(restoreLegacyBackup(f.objects,old,join(f.dir,'restored'),f.backup.manifestSha256))
      .rejects.toThrow('legacy_backup_expired');
    await expect(exportLegacyBackup(f.dir,f.objects,old,now)).rejects.toThrow('legacy_backup_expired');
    f.objects.remove=remove;
    expect((await pruneLegacyBackupObjects(f.objects,7,true,now)).removedObjects).toBe(2);
    expect([...f.values.keys()]).toEqual([legacyBackupRoot+old+'/expired.json']);
  }finally{await f.close();}
});

it('refuses malformed or changed inventories before writing expiry markers',async()=>{
  const f=await fixture();
  try{
    await expect(pruneLegacyBackupObjects(f.objects,0,true,now)).rejects.toThrow('legacy_backup_retention_invalid');
    const list=f.objects.list;
    f.objects.list=async()=>[...(await list()),{key:legacyBackupRoot+old+'/../private',modifiedAt:0,etag:'x'}];
    await expect(pruneLegacyBackupObjects(f.objects,7,true,now)).rejects.toThrow('legacy_backup_inventory_invalid');
    expect(f.writes()).toBe(0);expect(f.deletes()).toBe(0);
    let calls=0;f.objects.list=async()=>{const entries=await list();if(++calls===2)entries[0]!.etag='changed';return entries;};
    await expect(pruneLegacyBackupObjects(f.objects,7,true,now)).rejects.toThrow('legacy_backup_inventory_changed');
    expect(f.writes()).toBe(0);expect(f.deletes()).toBe(0);
  }finally{await f.close();}
});

it('detects a delayed upload after deletion and removes its bytes on retry without reviving the backup',async()=>{
  const f=await fixture();
  try{
    const remove=f.objects.remove;
    f.objects.remove=async key=>{
      await remove(key);
      if(key.endsWith('/manifest.json')){
        f.setTime(now);await f.objects.put(legacyBackupRoot+old+'/jobs/late/raw.webm',Buffer.from('late bytes'));
      }
    };
    await expect(pruneLegacyBackupObjects(f.objects,7,true,now)).rejects.toThrow('legacy_backup_expiry_incomplete');
    f.objects.remove=remove;
    expect((await pruneLegacyBackupObjects(f.objects,7,true,now)).removedObjects).toBe(1);
    expect([...f.values.keys()]).toEqual([legacyBackupRoot+old+'/expired.json']);
  }finally{await f.close();}
});

it('does not publish a restore if expiration begins while its media is being read',async()=>{
  const f=await fixture();
  try{
    const get=f.objects.get;
    f.objects.get=async key=>{
      const result=await get(key);
      if(key.endsWith('/usage.json'))await f.objects.put(legacyBackupRoot+old+'/expired.json',
        Buffer.from(JSON.stringify({version:1,backupId:old,expiredAt:now})));
      return result;
    };
    const destination=join(f.dir,'restored');
    await expect(restoreLegacyBackup(f.objects,old,destination,f.backup.manifestSha256)).rejects.toThrow('legacy_backup_expired');
    await expect(readFile(join(destination,'invites.json'))).rejects.toMatchObject({code:'ENOENT'});
  }finally{await f.close();}
});
