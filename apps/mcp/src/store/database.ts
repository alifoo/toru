import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { chmod, link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Keep schema changes append-only. A newer database must never be opened by an older binary.
const applicationId = 0x41525243;
const migrations = [
  `CREATE TABLE accounts (
    owner TEXT PRIMARY KEY,
    clerk_user_id TEXT UNIQUE,
    admission_status TEXT NOT NULL DEFAULT 'admitted' CHECK(admission_status IN ('admitted','waiting','suspended','deleted')),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    deleted_at INTEGER
  ) STRICT;
  CREATE TABLE grants (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
    owner TEXT NOT NULL REFERENCES accounts(owner),
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  ) STRICT;
  CREATE INDEX grants_owner ON grants(owner);
  CREATE TABLE daily_usage (
    owner TEXT NOT NULL REFERENCES accounts(owner), day TEXT NOT NULL,
    browser_ms INTEGER NOT NULL DEFAULT 0 CHECK(browser_ms >= 0),
    render_ms INTEGER NOT NULL DEFAULT 0 CHECK(render_ms >= 0),
    browser_starts INTEGER NOT NULL DEFAULT 0 CHECK(browser_starts >= 0),
    bandwidth_bytes INTEGER NOT NULL DEFAULT 0 CHECK(bandwidth_bytes >= 0),
    PRIMARY KEY(owner, day)
  ) STRICT;
  CREATE TABLE usage_reservations (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('browser_ms','render_ms')),
    amount INTEGER NOT NULL CHECK(amount >= 0),
    settled_amount INTEGER CHECK(settled_amount >= 0 AND settled_amount <= amount),
    created_at INTEGER NOT NULL, settled_at INTEGER,
    FOREIGN KEY(owner, day) REFERENCES daily_usage(owner, day),
    CHECK((settled_at IS NULL) = (settled_amount IS NULL))
  ) STRICT;
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner),
    status TEXT NOT NULL CHECK(status IN ('ready','recording','captured','rendering','completed','interrupted','closed')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    metadata TEXT NOT NULL CHECK(json_valid(metadata))
  ) STRICT;
  CREATE INDEX jobs_owner_created ON jobs(owner, created_at DESC);
  CREATE INDEX jobs_expiration ON jobs(expires_at);
  CREATE TABLE policy_revisions (
    version TEXT PRIMARY KEY, actor TEXT NOT NULL,
    created_at INTEGER NOT NULL, policy TEXT NOT NULL CHECK(json_valid(policy))
  ) STRICT;
  CREATE TRIGGER policy_revisions_immutable_update BEFORE UPDATE ON policy_revisions BEGIN SELECT RAISE(ABORT,'immutable_policy'); END;
  CREATE TRIGGER policy_revisions_immutable_delete BEFORE DELETE ON policy_revisions BEGIN SELECT RAISE(ABORT,'immutable_policy'); END;
  CREATE TABLE legacy_imports (
    source TEXT PRIMARY KEY, checksum TEXT NOT NULL,
    record_count INTEGER NOT NULL CHECK(record_count >= 0), imported_at INTEGER NOT NULL
  ) STRICT;`,
  `CREATE TABLE session_imports (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner),
    expires_at INTEGER NOT NULL, checksum TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE
  ) STRICT;`,
  `CREATE TABLE instance_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    environment TEXT NOT NULL CHECK(environment IN ('local','staging','production')),
    instance_id TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE policy_activations (
    id INTEGER PRIMARY KEY,
    version TEXT NOT NULL REFERENCES policy_revisions(version),
    previous_version TEXT REFERENCES policy_revisions(version),
    actor TEXT NOT NULL, deployment_id TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX policy_activations_deployment ON policy_activations(deployment_id);
  CREATE TRIGGER policy_activations_immutable_update BEFORE UPDATE ON policy_activations BEGIN SELECT RAISE(ABORT,'immutable_policy_activation'); END;
  CREATE TRIGGER policy_activations_immutable_delete BEFORE DELETE ON policy_activations BEGIN SELECT RAISE(ABORT,'immutable_policy_activation'); END;
  CREATE TRIGGER instance_identity_immutable_update BEFORE UPDATE ON instance_identity BEGIN SELECT RAISE(ABORT,'immutable_instance_identity'); END;
  CREATE TRIGGER instance_identity_immutable_delete BEFORE DELETE ON instance_identity BEGIN SELECT RAISE(ABORT,'immutable_instance_identity'); END;`,
  `CREATE TABLE operation_requests (
    owner TEXT NOT NULL REFERENCES accounts(owner), operation TEXT NOT NULL, request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL, job_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(owner,operation,request_id)
  ) STRICT;`,
  `ALTER TABLE operation_requests ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted','completed','failed'));
  ALTER TABLE operation_requests ADD COLUMN result TEXT CHECK(result IS NULL OR json_valid(result));`,
  `CREATE TABLE scheduler_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),turn INTEGER NOT NULL DEFAULT 0);
  INSERT INTO scheduler_state VALUES (1,0);
  CREATE TABLE queue_owner_turns (owner TEXT PRIMARY KEY REFERENCES accounts(owner),last_turn INTEGER NOT NULL);
  CREATE TABLE queue_entries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL REFERENCES accounts(owner),
    kind TEXT NOT NULL CHECK(kind IN ('session','render')),request_id TEXT NOT NULL,input_hash TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','canceled','expired','interrupted')),
    enqueued_at INTEGER NOT NULL,deadline INTEGER NOT NULL,admission_turn INTEGER NOT NULL,
    worker_id TEXT, fence INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    result TEXT CHECK(result IS NULL OR json_valid(result)),error_code TEXT,
    UNIQUE(owner,kind,request_id),
    CHECK((state='running')=(worker_id IS NOT NULL AND lease_until IS NOT NULL))
  ) STRICT;
  CREATE INDEX queue_ready ON queue_entries(state,sequence);
  CREATE UNIQUE INDEX queue_one_active_owner ON queue_entries(owner) WHERE state IN ('queued','running');`,
  `CREATE TABLE navigation_runs (
    owner TEXT NOT NULL REFERENCES accounts(owner), session_id TEXT NOT NULL,
    request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint)),
    PRIMARY KEY(owner,session_id,request_id)
  ) STRICT;
  CREATE INDEX navigation_expiration ON navigation_runs(expires_at);`,
  `CREATE TABLE preparation_notes (
    owner TEXT NOT NULL REFERENCES accounts(owner), id TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    input_hash TEXT NOT NULL, note TEXT NOT NULL CHECK(json_valid(note)),
    PRIMARY KEY(owner,id)
  ) STRICT;
  CREATE INDEX preparation_expiration ON preparation_notes(expires_at);`,
  `ALTER TABLE usage_reservations ADD COLUMN job_id TEXT;
  CREATE INDEX usage_reservations_job ON usage_reservations(job_id) WHERE job_id IS NOT NULL;`,
  `ALTER TABLE grants ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','oauth'));`,
  `CREATE TABLE IF NOT EXISTS desktop_devices (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner),
    name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    access_hash TEXT NOT NULL UNIQUE CHECK(length(access_hash)=64), access_expires_at INTEGER NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE CHECK(length(refresh_hash)=64), refresh_expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS desktop_devices_owner ON desktop_devices(owner);`,
  `CREATE TABLE IF NOT EXISTS desktop_uploads (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    owner TEXT NOT NULL REFERENCES accounts(owner),
    device_id TEXT NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
    bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=268435456),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64),
    received INTEGER NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=bytes),
    complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ) STRICT;`,
  `ALTER TABLE desktop_uploads ADD COLUMN media_metadata TEXT
    CHECK(media_metadata IS NULL OR json_valid(media_metadata));`,
  `CREATE TABLE IF NOT EXISTS demo_runs (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(owner),
    request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint)),
    UNIQUE(owner,request_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS demo_runs_expiration ON demo_runs(expires_at);`,
  `CREATE TABLE IF NOT EXISTS demo_accounts (
    owner TEXT NOT NULL REFERENCES accounts(owner), origin TEXT NOT NULL,
    username TEXT NOT NULL, secret TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER,
    PRIMARY KEY(owner,origin)
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS brands (
    owner TEXT NOT NULL REFERENCES accounts(owner), origin TEXT NOT NULL,
    settings TEXT NOT NULL CHECK(json_valid(settings)), updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner,origin)
  ) STRICT;`,
  `ALTER TABLE demo_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'password' CHECK(kind IN ('password','email'));`,
];

/** Small synchronous transactions only: never perform network/filesystem awaits inside a transaction. */
export class RecorderDatabase {
  readonly connection: DatabaseSync;
  readonly path: string;
  private closed = false;
  private inTransaction = false;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Create privately before SQLite opens the file (including its WAL sidecars).
    const fd = openSync(this.path, 'a', 0o600);
    closeSync(fd);
    chmodSync(this.path, 0o600);
    this.connection = new DatabaseSync(this.path);
    try {
      const sqliteVersion = String(this.connection.prepare('SELECT sqlite_version() version').get()!.version);
      const [major = 0, minor = 0, patch = 0] = sqliteVersion.split('.').map(Number);
      const fixedWal = major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7)));
      if (!fixedWal) throw new Error('sqlite_upgrade_required_for_safe_wal');
      this.connection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const app = Number(this.connection.prepare('PRAGMA application_id').get()!.application_id);
      const version = Number(this.connection.prepare('PRAGMA user_version').get()!.user_version);
      const tables = this.connection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if ((app !== 0 && app !== applicationId) || (app === 0 && (version !== 0 || tables.length > 0))) throw new Error('foreign_database');
      if (version > migrations.length) throw new Error('database_schema_newer_than_binary');
      this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        // Re-read under the write lock: another CLI process may have migrated while we waited.
        const current = Number(this.connection.prepare('PRAGMA user_version').get()!.user_version);
        if (current > migrations.length) throw new Error('database_schema_newer_than_binary');
        this.connection.exec(`PRAGMA application_id=${applicationId};`);
        for (let index = current; index < migrations.length; index += 1) {
          this.connection.exec(migrations[index]!);
          this.connection.exec(`PRAGMA user_version=${index + 1};`);
        }
      });
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  transaction<T>(work: () => T): T {
    if (this.inTransaction) throw new Error('nested_transaction');
    this.connection.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('async_transaction_not_supported');
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Online SQLite backup; publish only after integrity check and fsync. Destination must be new. */
  async snapshot(destination: string): Promise<void> {
    const target = resolve(destination);
    if (target === this.path || this.inTransaction) throw new Error('invalid_backup_destination');
    const directory = dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      await file.close();
      await backup(this.connection, temporary);
      await chmod(temporary, 0o600);
      const copy = new DatabaseSync(temporary);
      try {
        // Make the snapshot standalone: no live WAL/SHM sidecars may accompany publication.
        copy.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
        if (copy.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new Error('backup_integrity_failed');
      } finally { copy.close(); }
      const handle = await open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      // Hard-link publishes the complete file atomically and refuses to overwrite a backup.
      await link(temporary, target);
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await rm(temporary, { force: true }); }
  }

  close(): void {
    if (this.closed) return;
    if (this.inTransaction) throw new Error('transaction_active');
    this.connection.close();
    this.closed = true;
  }
}
