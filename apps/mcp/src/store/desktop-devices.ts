import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {RecorderDatabase} from './database.js';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const accessLifetime=15*60_000,refreshLifetime=30*24*60*60_000;
export type DesktopDevice={id:string;owner:string;name:string;createdAt:number;lastSeenAt:number;revoked:boolean};
export type DesktopCredentials={deviceId:string;accessToken:string;accessExpiresAt:number;refreshToken:string;refreshExpiresAt:number};
function credentials(deviceId:string,now:number):DesktopCredentials {
 return {deviceId,accessToken:randomBytes(32).toString('base64url'),accessExpiresAt:now+accessLifetime,
  refreshToken:randomBytes(32).toString('base64url'),refreshExpiresAt:now+refreshLifetime};
}
function device(row:Record<string,unknown>):DesktopDevice {
 return {id:String(row.id),owner:String(row.owner),name:String(row.name),createdAt:Number(row.created_at),lastSeenAt:Number(row.last_seen_at),revoked:row.revoked_at!==null};
}
/** Device identity only. Capture consent and the requesting MCP authorization are separate grants. */
export class DesktopDeviceStore {
 constructor(private db:RecorderDatabase){}
 private admitted(owner:string){return this.db.connection.prepare("SELECT 1 FROM accounts WHERE owner=? AND admission_status='admitted'").get(owner);}
 /** Call only after consuming an authenticated, single-use pairing challenge. */
 register(owner:string,name:string,now=Date.now(),id:string=randomUUID()):DesktopCredentials {
  const normalized=name.trim();
  if(!normalized||normalized.length>80||/[\x00-\x1f\x7f]/.test(normalized))throw new Error('invalid_device_name');
  return this.db.transaction(()=>{
   if(!this.admitted(owner))throw new Error('account_not_admitted');
   const count=Number(this.db.connection.prepare('SELECT count(*) AS n FROM desktop_devices WHERE owner=? AND revoked_at IS NULL AND refresh_expires_at>?').get(owner,now)?.n);
   if(count>=10)throw new Error('desktop_device_limit');
   const next=credentials(id,now);
   this.db.connection.prepare(`INSERT INTO desktop_devices(id,owner,name,created_at,last_seen_at,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(next.deviceId,owner,normalized,now,now,digest(next.accessToken),next.accessExpiresAt,digest(next.refreshToken),next.refreshExpiresAt);
   return next;
  });
 }
 authenticate(accessToken:string,now=Date.now()):DesktopDevice|undefined {
  if(!/^[A-Za-z0-9_-]{43}$/.test(accessToken))return;
  return this.db.transaction(()=>{
   const row=this.db.connection.prepare(`SELECT d.* FROM desktop_devices d JOIN accounts a ON a.owner=d.owner
    WHERE d.access_hash=? AND d.access_expires_at>? AND d.revoked_at IS NULL AND a.admission_status='admitted'`).get(digest(accessToken),now);
   if(!row)return;
   this.db.connection.prepare('UPDATE desktop_devices SET last_seen_at=? WHERE id=?').run(now,row.id!);
   return device({...row,last_seen_at:now});
  });
 }
 /** Atomic single-use rotation. A lost refresh response requires pairing again; old tokens never regain access. */
 refresh(refreshToken:string,now=Date.now()):DesktopCredentials|undefined {
  if(!/^[A-Za-z0-9_-]{43}$/.test(refreshToken))return;
  return this.db.transaction(()=>{
   const row=this.db.connection.prepare(`SELECT d.id FROM desktop_devices d JOIN accounts a ON a.owner=d.owner
    WHERE d.refresh_hash=? AND d.refresh_expires_at>? AND d.revoked_at IS NULL AND a.admission_status='admitted'`).get(digest(refreshToken),now);
   if(!row)return;
   const next=credentials(String(row.id),now);
   this.db.connection.prepare(`UPDATE desktop_devices SET access_hash=?,access_expires_at=?,refresh_hash=?,refresh_expires_at=?,last_seen_at=? WHERE id=?`)
    .run(digest(next.accessToken),next.accessExpiresAt,digest(next.refreshToken),next.refreshExpiresAt,now,next.deviceId);
   return next;
  });
 }
 list(owner:string):DesktopDevice[] {
  if(!this.admitted(owner))return [];
  return this.db.connection.prepare('SELECT * FROM desktop_devices WHERE owner=? ORDER BY created_at DESC').all(owner).map(device);
 }
 revoke(owner:string,id:string,now=Date.now()):boolean {
  return this.db.connection.prepare('UPDATE desktop_devices SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND owner=?').run(now,id,owner).changes>0;
 }
}
