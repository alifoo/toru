import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {RecorderDatabase} from './database.js';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const accessLifetime=15*60_000,refreshLifetime=60*24*60*60_000;
/** How long the refresh token a rotation replaced still renews. Calls that refresh at the same moment (poll and upload
 * near the access token's expiry) or a reply lost to a restart used to fail with 401, and the extension then dropped its
 * pairing for good: Chrome showed offline until it was paired again. */
const refreshGrace=2*60_000;
export type ExtensionDevice={id:string;owner:string;name:string;createdAt:number;lastSeenAt:number;revoked:boolean};
export type ExtensionCredentials={deviceId:string;accessToken:string;accessExpiresAt:number;refreshToken:string;refreshExpiresAt:number};
function credentials(deviceId:string,now:number):ExtensionCredentials {
 return {deviceId,accessToken:randomBytes(32).toString('base64url'),accessExpiresAt:now+accessLifetime,
  refreshToken:randomBytes(32).toString('base64url'),refreshExpiresAt:now+refreshLifetime};
}
function device(row:Record<string,unknown>):ExtensionDevice {
 return {id:String(row.id),owner:String(row.owner),name:String(row.name),createdAt:Number(row.created_at),lastSeenAt:Number(row.last_seen_at),revoked:row.revoked_at!==null};
}
/**
 * Chrome extensions paired to an account. Same rotating-token scheme as paired Macs, in its own table so the
 * Mac tools never list a browser. Identity only: each recording still needs an MCP-authorized request.
 */
export class ExtensionDeviceStore {
 constructor(private db:RecorderDatabase){
  db.connection.exec(`CREATE TABLE IF NOT EXISTS extension_devices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
   last_seen_at INTEGER NOT NULL, access_hash TEXT NOT NULL, access_expires_at INTEGER NOT NULL, refresh_hash TEXT NOT NULL, refresh_expires_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE INDEX IF NOT EXISTS extension_devices_owner ON extension_devices(owner);`);
  const columns=db.connection.prepare('PRAGMA table_info(extension_devices)').all().map(column=>String(column.name));
  if(!columns.includes('previous_refresh_hash'))db.connection.exec('ALTER TABLE extension_devices ADD COLUMN previous_refresh_hash TEXT; ALTER TABLE extension_devices ADD COLUMN previous_refresh_until INTEGER;');
 }
 private admitted(owner:string){return this.db.connection.prepare("SELECT 1 FROM accounts WHERE owner=? AND admission_status='admitted'").get(owner);}
 /** Call only after consuming an authenticated, single-use pairing code. */
 register(owner:string,name:string,now=Date.now(),id:string=randomUUID()):ExtensionCredentials {
  const normalized=name.trim().slice(0,80)||'Chrome';
  if(/[\x00-\x1f\x7f]/.test(normalized))throw new Error('invalid_device_name');
  return this.db.transaction(()=>{
   if(!this.admitted(owner))throw new Error('account_not_admitted');
   const count=Number(this.db.connection.prepare('SELECT count(*) AS n FROM extension_devices WHERE owner=? AND revoked_at IS NULL AND refresh_expires_at>?').get(owner,now)?.n);
   if(count>=10)throw new Error('extension_device_limit');
   const next=credentials(id,now);
   this.db.connection.prepare(`INSERT INTO extension_devices(id,owner,name,created_at,last_seen_at,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(next.deviceId,owner,normalized,now,now,digest(next.accessToken),next.accessExpiresAt,digest(next.refreshToken),next.refreshExpiresAt);
   return next;
  });
 }
 authenticate(accessToken:string,now=Date.now()):ExtensionDevice|undefined {
  if(!/^[A-Za-z0-9_-]{43}$/.test(accessToken))return;
  return this.db.transaction(()=>{
   const row=this.db.connection.prepare(`SELECT d.* FROM extension_devices d JOIN accounts a ON a.owner=d.owner
    WHERE d.access_hash=? AND d.access_expires_at>? AND d.revoked_at IS NULL AND a.admission_status='admitted'`).get(digest(accessToken),now);
   if(!row)return;
   this.db.connection.prepare('UPDATE extension_devices SET last_seen_at=? WHERE id=?').run(now,row.id!);
   return device({...row,last_seen_at:now});
  });
 }
 /** Atomic rotation. The token it replaces renews once more within refreshGrace, then never again. */
 refresh(refreshToken:string,now=Date.now()):ExtensionCredentials|undefined {
  if(!/^[A-Za-z0-9_-]{43}$/.test(refreshToken))return;
  const hash=digest(refreshToken);
  return this.db.transaction(()=>{
   const row=this.db.connection.prepare(`SELECT d.id,d.refresh_hash FROM extension_devices d JOIN accounts a ON a.owner=d.owner
    WHERE ((d.refresh_hash=? AND d.refresh_expires_at>?) OR (d.previous_refresh_hash=? AND d.previous_refresh_until>?)) AND d.revoked_at IS NULL AND a.admission_status='admitted'`)
    .get(hash,now,hash,now);
   if(!row)return;
   const next=credentials(String(row.id),now);
   // The token this rotation replaces is the one that renews in the grace: when two calls race, the one that got the
   // replaced credentials can still renew; a reply lost in transit is renewed with the token sent again.
   this.db.connection.prepare(`UPDATE extension_devices SET access_hash=?,access_expires_at=?,refresh_hash=?,refresh_expires_at=?,last_seen_at=?,
    previous_refresh_hash=?,previous_refresh_until=? WHERE id=?`)
    .run(digest(next.accessToken),next.accessExpiresAt,digest(next.refreshToken),next.refreshExpiresAt,now,
     String(row.refresh_hash),now+refreshGrace,next.deviceId);
   return next;
  });
 }
 list(owner:string):ExtensionDevice[] {
  if(!this.admitted(owner))return [];
  return this.db.connection.prepare('SELECT * FROM extension_devices WHERE owner=? AND revoked_at IS NULL ORDER BY created_at DESC').all(owner).map(device);
 }
 revoke(owner:string,id:string,now=Date.now()):boolean {
  return this.db.connection.prepare('UPDATE extension_devices SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND owner=?').run(now,id,owner).changes>0;
 }
 eraseOwner(owner:string){this.db.connection.prepare('DELETE FROM extension_devices WHERE owner=?').run(owner);}
}
