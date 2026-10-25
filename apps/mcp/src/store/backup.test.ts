import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Recorder, type RecorderOptions } from '../recorder.js';
import { backupRecorderVolume, pruneRecorderBackups, restoreRecorderBackup, verifyRecorderBackup } from './backup.js';
import { createInvite } from '../invites.js';
import { authenticateBearer } from '../auth.js';
import { openRecorderStore, withRecorderStore } from './open.js';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

it('rotates only expired verified backups and requires an explicit apply',async()=>{
  const root=await mkdtemp(join(tmpdir(),'recorder-backup-prune-'));dirs.push(root);
  const dir=join(root,'source'),backupRoot=join(root,'backups');
  await mkdir(dir);await mkdir(backupRoot);
  (await openRecorderStore(dir)).close();
  const old=join(backupRoot,'old'),recent=join(backupRoot,'recent');
  await backupRecorderVolume(dir,old);await backupRecorderVolume(dir,recent);
  const now=Date.now(),manifest=JSON.parse(await readFile(join(old,'manifest.json'),'utf8'));
  await writeFile(join(old,'manifest.json'),JSON.stringify({...manifest,createdAt:now-31*86400000}));
  const planned=await pruneRecorderBackups(dir,backupRoot,30,false,now);
  expect(planned).toMatchObject({expired:['old'],deleted:[]});
  expect(await readdir(backupRoot)).toEqual(['old','recent']);
  expect(await pruneRecorderBackups(dir,backupRoot,30,true,now)).toMatchObject({expired:['old'],deleted:['old']});
  expect(await readdir(backupRoot)).toEqual(['recent']);
  await expect(pruneRecorderBackups(dir,root,30,true,now)).rejects.toThrow('backup_root_overlaps_data_directory');
});

it('rejects backup and restore destinations redirected through a symlinked parent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'recorder-backup-alias-'));dirs.push(root);
  const source=join(root,'source'),backup=join(root,'backup');
  await mkdir(source);
  (await openRecorderStore(source)).close();
  await symlink(source,join(root,'source-alias'),'dir');
  await expect(backupRecorderVolume(source,join(root,'source-alias','nested'))).rejects.toThrow('backup_must_be_outside_data_directory');
  expect(await readdir(source)).not.toContain('nested');
  await backupRecorderVolume(source,backup);
  await symlink(backup,join(root,'backup-alias'),'dir');
  await expect(restoreRecorderBackup(backup,join(root,'backup-alias','nested'))).rejects.toThrow('restore_destination_overlaps_backup');
  expect(await readdir(backup)).not.toContain('nested');
  await mkdir(join(source,'backups'));
  await expect(pruneRecorderBackups(source,join(root,'source-alias','backups'),30,true)).rejects.toThrow('backup_root_overlaps_data_directory');
});

it('restores grant, encrypted login, owner-scoped video and usage into a fresh volume',async()=>{
  const root=await mkdtemp(join(tmpdir(),'recorder-backup-'));dirs.push(root);
  const dir=join(root,'source'),owner=randomUUID(),key=randomBytes(32),id=randomUUID();
  let restoredCookie:string|undefined;
  const options:RecorderOptions={dataDir:dir,encryptionKey:key,
    createContext:vi.fn(async(context:Parameters<RecorderOptions['createContext']>[0])=>{restoredCookie=JSON.parse(Buffer.from(context.sessionState).toString()).cookies[0]?.value;return {dispose:async()=>undefined,goto:async()=>undefined};}) as unknown as RecorderOptions['createContext'],render:vi.fn()};
  const recorder=new Recorder(options);
  await recorder.initialize();
  let imported:{id:string},invite:Awaited<ReturnType<typeof createInvite>>;
  const target=join(root,'backup');
  try {
    await expect(backupRecorderVolume(dir,target)).rejects.toThrow('recorder_store_busy');
    invite=await createInvite(dir,owner);
    imported=await recorder.importSession(owner,{cookies:[{name:'session',value:'synthetic-private-cookie',domain:'example.com'}],origins:[]},['https://example.com']);
    await mkdir(join(dir,'jobs',id),{recursive:true});
    await writeFile(join(dir,'jobs',id,'video.mp4'),'synthetic-retained-video');
    const job={id,owner,status:'completed',createdAt:Date.now(),expiresAt:Date.now()+60000,allowedOrigins:['https://example.com'],durationMs:2000};
    await withRecorderStore(dir,db=>{
      db.connection.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(id,owner,job.status,job.createdAt,job.expiresAt,JSON.stringify(job));
      db.connection.prepare('INSERT INTO daily_usage(owner,day,browser_ms) VALUES (?,?,?)').run(owner,'2026-09-27',500);
    });
  } finally {await recorder.close();}
  const manifest=await backupRecorderVolume(dir,target);
  expect(manifest.files.map(file=>file.path)).toContain(`jobs/${id}/video.mp4`);
  await expect(backupRecorderVolume(dir,target)).rejects.toThrow('backup_destination_exists');
  expect(await verifyRecorderBackup(target)).toEqual(manifest);
  const restoredDir=join(root,'restored');
  expect(await restoreRecorderBackup(target,restoredDir)).toEqual(manifest);
  await expect(restoreRecorderBackup(target,restoredDir)).rejects.toThrow('restore_destination_exists');
  await expect(restoreRecorderBackup(target,join(target,'nested'))).rejects.toThrow('restore_destination_overlaps_backup');
  const restored=new Recorder({...options,dataDir:restoredDir});
  await restored.initialize();
  try {
    expect((await authenticateBearer(`Bearer ${invite!.token}`,restoredDir))?.owner).toBe(owner);
    const artifact=await restored.artifact(owner,id,'video');
    expect(await readFile(artifact.path,'utf8')).toBe('synthetic-retained-video');
    await expect(restored.artifact(randomUUID(),id,'video')).rejects.toThrow('recording_not_found');
    await restored.call(owner,'session_open',{url:'https://example.com',importId:imported!.id});
    expect(restoredCookie).toBe('synthetic-private-cookie');
    expect(await withRecorderStore(restoredDir,db=>db.connection.prepare('SELECT browser_ms FROM daily_usage WHERE owner=? AND day=?').get(owner,'2026-09-27')!.browser_ms)).toBeGreaterThanOrEqual(500);
  } finally {await restored.close();}
  await writeFile(join(target,'jobs',id,'video.mp4'),'tampered');
  await expect(verifyRecorderBackup(target)).rejects.toThrow('backup_checksum_mismatch');
  await expect(restoreRecorderBackup(target,join(root,'rejected'))).rejects.toThrow('backup_checksum_mismatch');
  expect(await readdir(root)).not.toContain('rejected');
});
