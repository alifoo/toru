import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RecorderDatabase } from './database.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.union([integer, z.string().transform(value => Date.parse(value))]).pipe(integer);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
});
const inviteSchema = z.object({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), owner: z.uuid(), expiresAt: timestamp,
  revokedAt: timestamp.optional(), bandwidthDay: day.optional(), bandwidthBytes: integer.optional(),
}).refine(value => value.bandwidthBytes === undefined || value.bandwidthDay !== undefined);
const usageSchema = z.object({browserMs: integer, renderMs: integer, browserStarts: integer.optional()});
const jobSchema = z.object({
  id: z.uuid(), owner: z.uuid(),
  status: z.enum(['ready','recording','captured','rendering','completed','interrupted','closed']),
  createdAt: integer, expiresAt: integer, allowedOrigins: z.array(z.string()),
  durationMs: integer.optional(), errorCode: z.string().optional(),
  connection: z.object({status:z.enum(['waiting','verifying','ready','failed']), importId:z.uuid().optional(),
    errorCode:z.string().optional(), submittedAt:integer.optional(), targetUrl:z.string().optional(), blockedOrigin:z.string().optional()}).optional(),
});
const importSchema = z.object({owner:z.uuid(), origins:z.array(z.string()), expiresAt:integer,
  iv:z.string().base64().refine(value => Buffer.from(value,'base64').length === 12),
  tag:z.string().base64().refine(value => Buffer.from(value,'base64').length === 16), data:z.string().base64()});
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
type Source = { path:string; checksum:string; contents:string };
export type LegacySnapshot = Awaited<ReturnType<typeof readLegacySnapshot>>;

/** Call only on a drained, exclusively locked volume. Reading does not modify or decrypt legacy data. */
export async function readLegacySnapshot(dataDir:string) {
  const sources:Source[] = [];
  async function read(path:string, optional=false) {
    const absolute = join(dataDir,path);
    let info;
    try { info = await lstat(absolute); }
    catch(error) { if(optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if(!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('invalid_legacy_file');
    const contents = await readFile(absolute,'utf8');
    sources.push({path,contents,checksum:hash(contents)});
    return JSON.parse(contents) as unknown;
  }
  async function entries(directory:string) {
    const absolute = join(dataDir,directory);
    try {
      if(!(await lstat(absolute)).isDirectory()) throw new Error('invalid_legacy_directory');
      return (await readdir(absolute)).sort();
    } catch(error) { if((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  const invites = z.object({invites:z.array(inviteSchema)}).parse(await read('invites.json',true) ?? {invites:[]}).invites;
  const seen = new Set<string>();
  for(const invite of invites) {
    if(seen.has(invite.tokenHash)) throw new Error('duplicate_legacy_token');
    seen.add(invite.tokenHash);
  }
  const usage = Object.entries(z.record(z.string(),usageSchema).parse(await read('usage.json',true) ?? {})).map(([key,value]) => {
    const owner = z.uuid().parse(key.slice(0,36));
    if(key[36] !== ':') throw new Error('invalid_legacy_usage_key');
    return {owner,day:day.parse(key.slice(37)),...value};
  });
  const jobs:z.infer<typeof jobSchema>[] = [];
  for(const id of await entries('jobs')) {
    if(!z.uuid().safeParse(id).success) continue;
    if(!(await lstat(join(dataDir,'jobs',id))).isDirectory()) throw new Error('invalid_legacy_directory');
    const job = jobSchema.parse(await read(`jobs/${id}/job.json`));
    if(job.id !== id) throw new Error('legacy_job_id_mismatch');
    jobs.push(job);
  }
  const imports:{id:string;owner:string;expiresAt:number;path:string;checksum:string}[] = [];
  for(const name of await entries('imports')) {
    if(!name.endsWith('.json') || !z.uuid().safeParse(name.slice(0,-5)).success) continue;
    const path = `imports/${name}`;
    const value = importSchema.parse(await read(path));
    imports.push({id:name.slice(0,-5),owner:value.owner,expiresAt:value.expiresAt,path,checksum:sources.at(-1)!.checksum});
  }
  sources.sort((left,right) => left.path.localeCompare(right.path));
  const checksum = hash(JSON.stringify(sources.map(({path,checksum}) => ({path,checksum}))));
  return {invites,usage,jobs,imports,sources,checksum};
}

/** All rows and the import receipt commit together. No JSON/SQL dual writes. */
export function importLegacySnapshot(db:RecorderDatabase, snapshot:LegacySnapshot, now=Date.now()) {
  return db.transaction(() => {
    const sql = db.connection;
    const receipt = sql.prepare("SELECT checksum,record_count FROM legacy_imports WHERE source='legacy-v1'").get();
    if(receipt) {
      if(receipt.checksum !== snapshot.checksum) throw new Error('legacy_data_changed_after_import');
      return {imported:false,records:Number(receipt.record_count),checksum:snapshot.checksum};
    }
    for(const table of ['accounts','grants','daily_usage','jobs','session_imports']) {
      if(Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n) !== 0) throw new Error('legacy_import_requires_empty_store');
    }
    const owners = new Set([...snapshot.invites,...snapshot.usage,...snapshot.jobs,...snapshot.imports].map(value => value.owner));
    const account = sql.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)');
    for(const owner of owners) account.run(owner,now);
    const grant = sql.prepare('INSERT INTO grants(token_hash,owner,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?)');
    for(const invite of snapshot.invites) grant.run(invite.tokenHash,invite.owner,invite.expiresAt,invite.revokedAt ?? null,now);
    const usage = sql.prepare('INSERT INTO daily_usage(owner,day,browser_ms,render_ms,browser_starts) VALUES (?,?,?,?,?)');
    for(const row of snapshot.usage) usage.run(row.owner,row.day,row.browserMs,row.renderMs,row.browserStarts ?? 0);
    const bandwidth = sql.prepare(`INSERT INTO daily_usage(owner,day,bandwidth_bytes) VALUES (?,?,?)
      ON CONFLICT(owner,day) DO UPDATE SET bandwidth_bytes=bandwidth_bytes+excluded.bandwidth_bytes`);
    for(const invite of snapshot.invites) if(invite.bandwidthDay && invite.bandwidthBytes !== undefined) {
      bandwidth.run(invite.owner,invite.bandwidthDay,invite.bandwidthBytes);
      const count = sql.prepare('SELECT bandwidth_bytes FROM daily_usage WHERE owner=? AND day=?').get(invite.owner,invite.bandwidthDay)!;
      if(!Number.isSafeInteger(count.bandwidth_bytes)) throw new Error('legacy_bandwidth_overflow');
    }
    const job = sql.prepare('INSERT INTO jobs(id,owner,status,created_at,expires_at,metadata) VALUES (?,?,?,?,?,?)');
    for(const value of snapshot.jobs) job.run(value.id,value.owner,value.status,value.createdAt,value.expiresAt,JSON.stringify(value));
    const imported = sql.prepare('INSERT INTO session_imports(id,owner,expires_at,checksum,relative_path) VALUES (?,?,?,?,?)');
    for(const value of snapshot.imports) imported.run(value.id,value.owner,value.expiresAt,value.checksum,value.path);
    const records = snapshot.invites.length + snapshot.usage.length + snapshot.jobs.length + snapshot.imports.length;
    sql.prepare('INSERT INTO legacy_imports VALUES (?,?,?,?)').run('legacy-v1',snapshot.checksum,records,now);
    return {imported:true,records,checksum:snapshot.checksum};
  });
}
