import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RecorderDatabase } from './database.js';
import { importLegacySnapshot, readLegacySnapshot } from './legacy.js';
const cleanup:(() => Promise<void>)[] = [];
afterEach(async () => { for(const work of cleanup.splice(0)) await work(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'recorder-legacy-'));
  const db = new RecorderDatabase(join(dir,'recorder.sqlite'));
  cleanup.push(async () => {db.close(); await rm(dir,{recursive:true,force:true});});
  const owner = randomUUID(), id = randomUUID(), importId = randomUUID();
  const invites = [0,1].map(index => ({owner,tokenHash:String(index).repeat(64),expiresAt:'2027-01-01T00:00:00Z',bandwidthDay:'2026-09-27',bandwidthBytes:10}));
  await writeFile(join(dir,'invites.json'),JSON.stringify({invites}));
  await writeFile(join(dir,'usage.json'),JSON.stringify({[`${owner}:2026-09-27`]:{browserMs:250,renderMs:500,browserStarts:2}}));
  await mkdir(join(dir,'jobs',id),{recursive:true});
  const job = {owner,id,status:'captured',createdAt:1,expiresAt:9999999999999,allowedOrigins:['https://example.com'],durationMs:300};
  await writeFile(join(dir,'jobs',id,'job.json'),JSON.stringify(job));
  await writeFile(join(dir,'jobs',id,'raw.webm'),'unchanged-media');
  await mkdir(join(dir,'imports'));
  const encrypted = {owner,origins:['https://example.com'],expiresAt:9999999999999,iv:Buffer.alloc(12).toString('base64'),tag:Buffer.alloc(16).toString('base64'),data:Buffer.from('encrypted').toString('base64')};
  await writeFile(join(dir,'imports',`${importId}.json`),JSON.stringify(encrypted));
  return {db,dir,owner,id,invites,job,importId,encrypted};
}
describe('legacy JSON migration', () => {
  it('imports exactly once, preserves owners/media/encrypted state, and aggregates rotated-token bandwidth', async () => {
    const {db,dir,owner,id,encrypted,importId} = await fixture();
    const first = await readLegacySnapshot(dir);
    expect(importLegacySnapshot(db,first)).toMatchObject({imported:true,records:5});
    expect(importLegacySnapshot(db,await readLegacySnapshot(dir))).toMatchObject({imported:false,records:5});
    expect(db.connection.prepare('SELECT owner FROM accounts').all()).toEqual([{owner}]);
    expect(db.connection.prepare('SELECT count(*) n FROM grants WHERE owner=?').get(owner)!.n).toBe(2);
    expect(db.connection.prepare('SELECT browser_ms,render_ms,browser_starts,bandwidth_bytes FROM daily_usage').get()).toEqual({browser_ms:250,render_ms:500,browser_starts:2,bandwidth_bytes:20});
    expect(await readFile(join(dir,'jobs',id,'raw.webm'),'utf8')).toBe('unchanged-media');
    expect(JSON.parse(await readFile(join(dir,'imports',`${importId}.json`),'utf8'))).toEqual(encrypted);
    expect(db.connection.prepare('SELECT relative_path FROM session_imports').get()!.relative_path).toBe(`imports/${importId}.json`);
    const backup = join(dir,'snapshot.sqlite'); await db.snapshot(backup);
    const restored = new RecorderDatabase(backup);
    try { expect(restored.connection.prepare('SELECT owner FROM jobs WHERE id=?').get(id)!.owner).toBe(owner); }
    finally { restored.close(); }
  });
  it('rejects changed input after import instead of overwriting newer SQL state', async () => {
    const {db,dir,invites} = await fixture();
    importLegacySnapshot(db,await readLegacySnapshot(dir));
    await writeFile(join(dir,'invites.json'),JSON.stringify({invites:invites.slice(0,1)}));
    const changed = await readLegacySnapshot(dir);
    expect(() => importLegacySnapshot(db,changed)).toThrow('legacy_data_changed_after_import');
    expect(db.connection.prepare('SELECT count(*) n FROM grants').get()!.n).toBe(2);
  });
  it('rolls back every row if a late constraint fails', async () => {
    const {db,dir} = await fixture(); const snapshot = await readLegacySnapshot(dir);
    db.connection.exec("CREATE TRIGGER reject_import BEFORE INSERT ON session_imports BEGIN SELECT RAISE(ABORT,'injected_failure'); END");
    expect(() => importLegacySnapshot(db,snapshot)).toThrow('injected_failure');
    for(const table of ['accounts','grants','daily_usage','jobs','legacy_imports']) expect(db.connection.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    db.connection.exec('DROP TRIGGER reject_import');
    expect(importLegacySnapshot(db,snapshot).imported).toBe(true);
  });
  it('rejects corrupt counters, duplicate tokens and mismatched job IDs before any writes', async () => {
    const {db,dir,owner,invites,id,job} = await fixture();
    await writeFile(join(dir,'usage.json'),JSON.stringify({[`${owner}:2026-09-27`]:{browserMs:-1,renderMs:0}}));
    await expect(readLegacySnapshot(dir)).rejects.toThrow();
    await writeFile(join(dir,'usage.json'),'{}');
    await writeFile(join(dir,'invites.json'),JSON.stringify({invites:[invites[0],invites[0]]}));
    await expect(readLegacySnapshot(dir)).rejects.toThrow('duplicate_legacy_token');
    await writeFile(join(dir,'invites.json'),JSON.stringify({invites}));
    await writeFile(join(dir,'jobs',id,'job.json'),JSON.stringify({...job,id:randomUUID()}));
    await expect(readLegacySnapshot(dir)).rejects.toThrow('legacy_job_id_mismatch');
    expect(db.connection.prepare('SELECT count(*) n FROM accounts').get()!.n).toBe(0);
  });
  it('refuses symlinks and importing over an existing SQL account', async () => {
    const {db,dir,owner} = await fixture();
    const snapshot = await readLegacySnapshot(dir);
    db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,1);
    expect(() => importLegacySnapshot(db,snapshot)).toThrow('legacy_import_requires_empty_store');
    await rm(join(dir,'usage.json'));
    await symlink(join(dir,'invites.json'),join(dir,'usage.json'));
    await expect(readLegacySnapshot(dir)).rejects.toThrow('invalid_legacy_file');
  });
});
