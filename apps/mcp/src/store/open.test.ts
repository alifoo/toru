import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openRecorderStore, readLegacySnapshot, withRecorderStore } from './open.js';
import { pruneLegacyMigrationBackup } from './backup.js';
import { exclusiveProcessLock } from './lock.js';
import { authenticateBearer, hashInviteToken, reserveBandwidth } from '../auth.js';
import { createInvite } from '../invites.js';
const dirs:string[]=[];
afterEach(async () => {await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function directory() {const dir=await mkdtemp(join(tmpdir(),'recorder-cutover-'));dirs.push(dir);return dir;}

describe('store cutover',()=>{
  it('backs up metadata and media, retires JSON, and keeps SQL authoritative on reopen',async()=>{
    const dir=await directory(),owner=randomUUID(),id=randomUUID();
    const token='synthetic-token';
    await writeFile(join(dir,'invites.json'),JSON.stringify({invites:[{owner,tokenHash:hashInviteToken(token),expiresAt:Date.now()+60000}]}));
    await mkdir(join(dir,'jobs',id),{recursive:true});
    await writeFile(join(dir,'jobs',id,'job.json'),JSON.stringify({owner,id,status:'completed',createdAt:1,expiresAt:Date.now()+60000,allowedOrigins:[]}));
    await writeFile(join(dir,'jobs',id,'video.mp4'),'retained-video');
    const db=await openRecorderStore(dir);db.close();
    const reference=JSON.parse(await readFile(join(dir,'legacy-backup.json'),'utf8'));
    expect(await readFile(join(reference.path,'jobs',id,'video.mp4'),'utf8')).toBe('retained-video');
    const manifest=JSON.parse(await readFile(join(reference.path,'manifest.json'),'utf8'));
    expect(manifest.files.find((file:{path:string})=>file.path===`jobs/${id}/video.mp4`).sha256).toHaveLength(64);
    const retired = await readFile(join(dir,'usage.json'),'utf8');
    expect(()=>JSON.parse(retired)).toThrow();
    expect(retired).toContain('Legacy JSON storage retired');
    await withRecorderStore(dir,store=>store.connection.prepare('UPDATE grants SET revoked_at=?').run(Date.now()));
    // Reintroducing stale JSON cannot restore a revoked credential or trigger another backup/import.
    await writeFile(join(dir,'invites.json'),JSON.stringify({invites:[{owner,tokenHash:hashInviteToken(token),expiresAt:Date.now()+60000}]}));
    expect(await authenticateBearer(`Bearer ${token}`,dir)).toBeUndefined();
    expect(await readdir(join(dir,'migration-backups'))).toHaveLength(1);
    expect(await readFile(join(dir,'jobs',id,'video.mp4'),'utf8')).toBe('retained-video');
    const future=Date.now()+31*86400000;
    expect(await pruneLegacyMigrationBackup(dir,30,false,future)).toMatchObject({state:'expired'});
    expect(await readdir(join(dir,'migration-backups'))).toHaveLength(1);
    expect(await pruneLegacyMigrationBackup(dir,30,true,future)).toMatchObject({state:'deleted'});
    expect(await readdir(join(dir,'migration-backups'))).toHaveLength(0);
    expect(await pruneLegacyMigrationBackup(dir,30,true,future)).toEqual({state:'already_pruned'});
    expect(await readFile(join(dir,'jobs',id,'video.mp4'),'utf8')).toBe('retained-video');
  });
  it('serializes simultaneous initialization and enforces owner bandwidth across rotated grants',async()=>{
    const dir=await directory(),owner=randomUUID();
    const grants=await Promise.all([createInvite(dir,owner),createInvite(dir,owner)]);
    const accepted=await Promise.all(Array.from({length:8},(_,index)=>reserveBandwidth(owner,hashInviteToken(grants[index%2]!.token),dir,1,'invites.json',Date.now(),3)));
    expect(accepted.filter(Boolean)).toHaveLength(3);
    expect(await withRecorderStore(dir,db=>db.connection.prepare('SELECT count(*) n FROM accounts').get()!.n)).toBe(1);
  });
  it('leaves source data intact if validation fails, allowing an explicit repair and retry',async()=>{
    const dir=await directory();await writeFile(join(dir,'usage.json'),'not-json');
    await expect(openRecorderStore(dir)).rejects.toThrow();
    expect(await readFile(join(dir,'usage.json'),'utf8')).toBe('not-json');
    await writeFile(join(dir,'usage.json'),'{}');
    const db=await openRecorderStore(dir);db.close();
  });
  it('requires an exact reviewed legacy snapshot before import and on bootstrap retry',async()=>{
    const dir=await directory(),owner=randomUUID();
    await writeFile(join(dir,'invites.json'),JSON.stringify({invites:[{owner,tokenHash:hashInviteToken('fixture'),expiresAt:Date.now()+60000}]}));
    const expected=(await readLegacySnapshot(dir)).checksum;
    await expect(openRecorderStore(dir,{expectedLegacyChecksum:'0'.repeat(64)})).rejects.toThrow('legacy_snapshot_mismatch');
    expect(await readFile(join(dir,'invites.json'),'utf8')).toContain(owner);
    const db=await openRecorderStore(dir,{expectedLegacyChecksum:expected});db.close();
    const reopened=await openRecorderStore(dir,{expectedLegacyChecksum:expected});reopened.close();
    await expect(openRecorderStore(dir,{expectedLegacyChecksum:'f'.repeat(64)})).rejects.toThrow('legacy_snapshot_mismatch');
  });
  it('refuses a second process and releases the lock automatically after SIGKILL',async()=>{
    const dir=await directory(),path=join(dir,'.runtime-lock.sqlite');
    const release=exclusiveProcessLock(path);release();
    const child=spawn(process.execPath,['--input-type=module','-e',`
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('locked');setInterval(()=>{},1000);
    `,path],{stdio:['ignore','pipe','pipe']});
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('lock_timeout')),5000);
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('lock_child_exited'));});
        child.stdout.once('data',()=>{clearTimeout(timer);resolve();});
      });
      expect(()=>exclusiveProcessLock(path)).toThrow('recorder_store_busy');
      const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      child.kill('SIGKILL');await exited;
      const afterCrash=exclusiveProcessLock(path);afterCrash();
    } finally {if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');}
  });
});
