import { withRecorderStore } from './store/open.js';
import { randomBytes } from "node:crypto";
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hashInviteToken } from "./auth.js";

const defaultDataDir = process.env.DATA_DIR ?? "/data";
const pauseName = "paused";
const day = 24 * 60 * 60 * 1000;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing_${name.slice(2).replaceAll("-", "_")}`);
  return value;
}

function duration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error("invalid_duration");
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: day }[match[2] as "s" | "m" | "h" | "d"];
  return Number(match[1]) * multiplier;
}

async function removeOwnerImports(dataDir: string, owners: ReadonlySet<string>): Promise<void> {
  let names: string[];
  try { names = await readdir(join(dataDir, "imports")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).map(async (name) => {
    const path = join(dataDir, "imports", name);
    try {
      const imported = JSON.parse(await readFile(path, "utf8")) as { owner?: unknown };
      if (typeof imported.owner === "string" && owners.has(imported.owner)) await rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
}

export async function createInvite(dataDir: string, owner: string, expiresIn = "7d"): Promise<{ token: string; owner: string; expiresAt: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)) throw new Error("owner_must_be_uuid");
  const expiresAt = new Date(Date.now() + duration(expiresIn)).toISOString();
  const token = `ar_${randomBytes(32).toString("base64url")}`;
  await withRecorderStore(dataDir, db => db.transaction(() => {
    db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?) ON CONFLICT(owner) DO NOTHING').run(owner,Date.now());
    const now=Date.now();
    const account=db.connection.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner);
    if(account?.admission_status!=='admitted') throw new Error('account_not_admitted');
    const active=Number(db.connection.prepare("SELECT count(*) n FROM grants WHERE kind='manual' AND owner=? AND expires_at>? AND (revoked_at IS NULL OR revoked_at>?)").get(owner,now,now)!.n);
    if(active>=5) throw new Error('active_invite_limit');
    const issued=Number(db.connection.prepare("SELECT count(*) n FROM grants WHERE kind='manual' AND owner=? AND created_at>?").get(owner,now-day)!.n);
    if(issued>=20) throw new Error('invite_issuance_limit');
    db.connection.prepare('INSERT INTO grants(token_hash,owner,expires_at,created_at) VALUES (?,?,?,?)').run(hashInviteToken(token),owner,Date.parse(expiresAt),Date.now());
  }));
  return { token, owner, expiresAt };
}

export async function revokeInvites(dataDir: string, selector: { owner?: string; token?: string }): Promise<number> {
  if (!selector.owner && !selector.token) throw new Error("usage");
  const result = await withRecorderStore(dataDir, db => db.transaction(() => {
    const sql = db.connection;
    const tokenHash = selector.token ? hashInviteToken(selector.token) : null;
    const rows = sql.prepare("SELECT token_hash,owner FROM grants WHERE kind='manual' AND (token_hash=? OR owner=?)").all(tokenHash,selector.owner ?? null);
    if(!rows.length) throw new Error('invite_not_found');
    const now = Date.now();
    sql.prepare("UPDATE grants SET revoked_at=? WHERE kind='manual' AND (token_hash=? OR owner=?)").run(now,tokenHash,selector.owner ?? null);
    const owners = new Set(rows.map(row => String(row.owner)));
    for(const owner of owners) {
      if(sql.prepare('SELECT 1 FROM grants WHERE owner=? AND expires_at>? AND (revoked_at IS NULL OR revoked_at>?)').get(owner,now,now)) owners.delete(owner);
    }
    for(const owner of owners) sql.prepare('DELETE FROM session_imports WHERE owner=?').run(owner);
    return {changed:rows.length,owners};
  }));
  await removeOwnerImports(dataDir,result.owners);
  return result.changed;
}

function usage(): never {
  throw new Error("usage: invites <create|revoke|list|pause|resume> --data-dir DIR [--owner UUID] [--token TOKEN] [--expires-in 7d]");
}

async function run(args: string[]): Promise<void> {
  const command = args[0];
  const dataDir = option(args, "--data-dir") ?? defaultDataDir;
  if (!command || !["create", "revoke", "list", "pause", "resume"].includes(command)) usage();
  if (command === "create") {
    const invite = await createInvite(dataDir, required(args, "--owner"), option(args, "--expires-in") ?? "7d");
    process.stdout.write(`${invite.token}\n`);
    return;
  }
  if (command === "revoke") {
    const owner = option(args, "--owner"); const token = option(args, "--token");
    const changed = await revokeInvites(dataDir, { ...(owner ? { owner } : {}), ...(token ? { token } : {}) });
    process.stdout.write(`revoked ${changed}\n`);
    return;
  }
  await mkdir(dataDir,{recursive:true,mode:0o700});
  await withRecorderStore(dataDir, async db => {
    if (command === "pause") {
      await writeFile(join(dataDir, pauseName), `${new Date().toISOString()}\n`, { mode: 0o600 });
      process.stdout.write("paused\n");
      return;
    }
    if (command === "resume") {
      await rm(join(dataDir, pauseName), { force: true });
      process.stdout.write("resumed\n");
      return;
    }
    for (const invite of db.connection.prepare('SELECT owner,expires_at,revoked_at FROM grants').all()) process.stdout.write(`${invite.owner}\t${invite.expires_at}\t${invite.revoked_at ?? "active"}\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "invite_cli_failed"); process.exitCode = 1; });
}

export { run as runInviteCli };
