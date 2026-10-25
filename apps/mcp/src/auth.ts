import { createHash } from 'node:crypto';
import { withRecorderStore } from './store/open.js';

export type InviteRecord = { tokenHash:string;owner:string;expiresAt:string|number;revokedAt?:string|number;bandwidthDay?:string;bandwidthBytes?:number };
export type InviteConfig = {invites:InviteRecord[]};
export function hashInviteToken(token:string):string {return createHash('sha256').update(token,'utf8').digest('hex');}
function assertConfig(fileName:string) {if(fileName !== 'invites.json') throw new Error('custom_auth_file_not_supported_after_migration');}

export async function authenticateBearer(authorization:string|undefined,dataDir:string,fileName='invites.json',now=Date.now()):Promise<InviteRecord|undefined> {
  assertConfig(fileName);
  if(!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice(7).trim(); if(!token) return undefined;
  return withRecorderStore(dataDir,db => {
    const row = db.connection.prepare(`SELECT g.* FROM grants g JOIN accounts a ON a.owner=g.owner WHERE g.kind='manual' AND token_hash=? AND expires_at>?
      AND (revoked_at IS NULL OR revoked_at>?) AND a.admission_status='admitted'`).get(hashInviteToken(token),now,now);
    if(!row) return undefined;
    return {owner:String(row.owner),tokenHash:String(row.token_hash),expiresAt:Number(row.expires_at),...(row.revoked_at === null ? {} : {revokedAt:Number(row.revoked_at)})};
  });
}
export async function activeInviteForOwner(owner:string,tokenHash:string,dataDir:string,fileName='invites.json',now=Date.now()):Promise<boolean> {
  assertConfig(fileName);
  return withRecorderStore(dataDir,db => Boolean(db.connection.prepare(`SELECT 1 FROM grants g JOIN accounts a ON a.owner=g.owner
    WHERE g.owner=? AND token_hash=? AND expires_at>? AND (revoked_at IS NULL OR revoked_at>?) AND a.admission_status='admitted'`).get(owner,tokenHash,now,now)));
}
export async function reserveBandwidth(owner:string,tokenHash:string,dataDir:string,bytes:number,fileName='invites.json',now=Date.now(),limitBytes=1_000_000_000):Promise<boolean> {
  assertConfig(fileName);
  if(!Number.isSafeInteger(bytes) || bytes<0 || !Number.isSafeInteger(limitBytes) || limitBytes<0 || bytes>limitBytes) return false;
  const day = new Date(now).toISOString().slice(0,10);
  return withRecorderStore(dataDir,db => db.transaction(() => {
    const sql = db.connection;
    if(!sql.prepare(`SELECT 1 FROM grants g JOIN accounts a ON a.owner=g.owner WHERE g.owner=? AND token_hash=? AND expires_at>?
      AND (revoked_at IS NULL OR revoked_at>?) AND a.admission_status='admitted'`).get(owner,tokenHash,now,now)) return false;
    const used = Number(sql.prepare('SELECT bandwidth_bytes FROM daily_usage WHERE owner=? AND day=?').get(owner,day)?.bandwidth_bytes ?? 0);
    const total = used+bytes;
    if(!Number.isSafeInteger(total) || total>limitBytes) return false;
    sql.prepare(`INSERT INTO daily_usage(owner,day,bandwidth_bytes) VALUES (?,?,?)
      ON CONFLICT(owner,day) DO UPDATE SET bandwidth_bytes=excluded.bandwidth_bytes`).run(owner,day,total);
    return true;
  }));
}

/** Dashboard links inherit an active grant so revocation applies to already-issued URLs. */
export async function artifactGrantForOwner(owner:string,dataDir:string,fileName='invites.json',now=Date.now()):Promise<string|undefined> {
  assertConfig(fileName);
  return withRecorderStore(dataDir,db => {
    const row=db.connection.prepare(`SELECT token_hash FROM grants g JOIN accounts a ON a.owner=g.owner
      WHERE g.owner=? AND expires_at>? AND (revoked_at IS NULL OR revoked_at>?) AND a.admission_status='admitted'
      ORDER BY expires_at DESC, token_hash LIMIT 1`).get(owner,now,now);
    return row ? String(row.token_hash) : undefined;
  });
}
