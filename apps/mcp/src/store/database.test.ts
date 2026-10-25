import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { RecorderDatabase } from './database.js';
import { defaultDailyLimits, recordOperationalPolicy } from '../policies.js';

const directories: string[] = [];
const handles: RecorderDatabase[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-db-'));
  directories.push(dir);
  const db = new RecorderDatabase(join(dir, 'recorder.sqlite'));
  handles.push(db);
  return { db, dir };
}
afterEach(async () => {
  handles.splice(0).forEach(db => db.close());
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const account = (db: RecorderDatabase, owner = 'owner') => db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner, 1);

describe('transactional recorder database', () => {
  it('opens privately with WAL, full sync, foreign keys and idempotent schema migration', async () => {
    const { db } = await fixture();
    expect((await stat(db.path)).mode & 0o777).toBe(0o600);
    expect(db.connection.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
    expect(db.connection.prepare('PRAGMA synchronous').get()!.synchronous).toBe(2);
    expect(db.connection.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
    account(db);
    db.close();
    const reopened = new RecorderDatabase(db.path); handles.push(reopened);
    expect(reopened.connection.prepare('SELECT count(*) n FROM accounts').get()!.n).toBe(1);
    expect(reopened.connection.prepare('PRAGMA user_version').get()!.user_version).toBe(17);
  });

  it('rolls back the whole operation and accepts work after a failed transaction', async () => {
    const { db } = await fixture();
    expect(() => db.transaction(() => {
      account(db);
      db.connection.prepare("INSERT INTO daily_usage(owner,day,browser_ms) VALUES ('owner','2026-09-27',-1)").run();
    })).toThrow();
    expect(db.connection.prepare('SELECT count(*) n FROM accounts').get()!.n).toBe(0);
    db.transaction(() => account(db));
    expect(() => db.transaction(() => db.transaction(() => 0))).toThrow('nested_transaction');
    expect(() => db.transaction(() => Promise.resolve())).toThrow('async_transaction_not_supported');
    expect(() => db.connection.prepare("INSERT INTO daily_usage(owner,day) VALUES ('missing','2026-09-27')").run()).toThrow();
  });

  it('migrates a version 8 compute reservation without changing its amount or settlement',async()=>{
    const {db}=await fixture();account(db);
    db.connection.prepare('INSERT INTO daily_usage(owner,day,render_ms) VALUES (?,?,?)').run('owner','2026-10-05',50);
    db.connection.prepare('INSERT INTO usage_reservations(id,owner,day,kind,amount,settled_amount,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('legacy-reservation','owner','2026-10-05','render_ms',50,12,1,2);
    db.close();
    const old=new DatabaseSync(db.path);
    old.exec('DROP TABLE demo_accounts; DROP TABLE desktop_uploads; DROP TABLE desktop_devices; ALTER TABLE grants DROP COLUMN kind; DROP INDEX usage_reservations_job; ALTER TABLE usage_reservations DROP COLUMN job_id; PRAGMA user_version=8;');
    old.close();
    const migrated=new RecorderDatabase(db.path);handles.push(migrated);
    expect(migrated.connection.prepare('PRAGMA user_version').get()!.user_version).toBe(17);
    expect(migrated.connection.prepare('SELECT amount,settled_amount,job_id FROM usage_reservations WHERE id=?').get('legacy-reservation'))
      .toEqual({amount:50,settled_amount:12,job_id:null});
  });

  it('rejects foreign databases and future schemas without changing their schema version', async () => {
    const { db, dir } = await fixture();
    db.connection.exec('PRAGMA user_version=999'); db.close();
    expect(() => new RecorderDatabase(db.path)).toThrow('database_schema_newer_than_binary');
    const future = new DatabaseSync(db.path);
    expect(future.prepare('PRAGMA user_version').get()!.user_version).toBe(999); future.close();
    const other = join(dir, 'other.sqlite');
    const foreign = new DatabaseSync(other); foreign.exec('CREATE TABLE unrelated(id)'); foreign.close();
    expect(() => new RecorderDatabase(other)).toThrow('foreign_database');
  });

  it('keeps policy revisions immutable', async () => {
    const { db } = await fixture();
    const version = recordOperationalPolicy(db, defaultDailyLimits, 'operator', 1);
    expect(recordOperationalPolicy(db, defaultDailyLimits, 'another-operator', 2)).toBe(version);
    expect(db.connection.prepare('SELECT actor,created_at FROM policy_revisions').all()).toEqual([{actor:'operator',created_at:1}]);
    expect(recordOperationalPolicy(db, {...defaultDailyLimits, browserStarts:11}, 'operator', 3)).not.toBe(version);
    expect(() => db.connection.exec("UPDATE policy_revisions SET policy='{}'")).toThrow('immutable_policy');
    expect(() => db.connection.exec('DELETE FROM policy_revisions')).toThrow('immutable_policy');
  });

  it('restores a consistent backup with WAL writes and never overwrites a previous backup', async () => {
    const { db, dir } = await fixture(); account(db);
    const target = join(dir, 'backup.sqlite');
    await db.snapshot(target);
    db.transaction(() => account(db, 'later'));
    await expect(db.snapshot(target)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    const restored = new RecorderDatabase(target); handles.push(restored);
    expect(restored.connection.prepare('SELECT owner FROM accounts').all()).toEqual([{owner:'owner'}]);
  });

  it('recovers after SIGKILL during a transaction without retaining partial writes', async () => {
    const { db } = await fixture(); account(db);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE; INSERT INTO accounts(owner,created_at) VALUES ('uncommitted',2)");
      process.stdout.write('transaction-open\\n');
      setInterval(() => {}, 1000);
    `, db.path], { stdio: ['ignore','pipe','pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child_transaction_timeout')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('child_exited_before_transaction')); });
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
      db.close();
      const reopened = new RecorderDatabase(db.path); handles.push(reopened);
      expect(reopened.connection.prepare('SELECT owner FROM accounts').all()).toEqual([{ owner: 'owner' }]);
      reopened.transaction(() => account(reopened, 'after-crash'));
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});
