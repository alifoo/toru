import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {RecorderDatabase} from './database.js';
/** 'email' logins type only the e-mail; the product's code or magic link is entered by the user on Toru's secure page. */
export type DemoAccountKind='password'|'email';
export type DemoAccount={origin:string;username:string;kind:DemoAccountKind;createdAt:number;lastUsedAt:number|null};
const MAX_PER_OWNER=20;
export function demoOrigin(url:string):string {
 const parsed=new URL(url);
 if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('public_https_url_required');
 return parsed.origin;
}
/** Opt-in vault for saved logins. Passwords are AES-256-GCM sealed with the server key and never leave this process unencrypted. */
export class DemoAccountStore {
 constructor(private db:RecorderDatabase,private key:Buffer){if(key.length!==32)throw new Error('invalid_encryption_key');}
 private seal(secret:string,aad:string):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad));
  const body=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
 }
 private open(sealed:string,aad:string):string {
  const raw=Buffer.from(sealed,'base64'),decipher=createDecipheriv('aes-256-gcm',this.key,raw.subarray(0,12));
  decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(raw.subarray(12,28));
  return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8');
 }
 list(owner:string):DemoAccount[] {
  return this.db.connection.prepare('SELECT origin,username,kind,created_at,last_used_at FROM demo_accounts WHERE owner=? ORDER BY created_at DESC').all(owner)
   .map(row=>({origin:String(row.origin),username:String(row.username),kind:row.kind==='email'?'email' as const:'password' as const,createdAt:Number(row.created_at),lastUsedAt:row.last_used_at===null?null:Number(row.last_used_at)}));
 }
 save(owner:string,url:string,username:string,password:string|undefined,now=Date.now(),kind:DemoAccountKind=password===undefined?'email':'password'):DemoAccount {
  const origin=demoOrigin(url),name=username.trim();
  if(!name||name.length>500)throw new Error('invalid_credentials');
  if(kind==='password'&&password!==undefined&&(!password||password.length>10_000))throw new Error('invalid_credentials');
  if(kind==='email'&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name))throw new Error('invalid_email');
  return this.db.transaction(()=>{
   // Editing a password login without a new password keeps the stored one (fixing the e-mail must not require retyping it).
   if(kind==='password'&&password===undefined){
    const existing=this.db.connection.prepare('SELECT kind FROM demo_accounts WHERE owner=? AND origin=?').get(owner,origin);
    if(existing?.kind!=='password')throw new Error('invalid_credentials');
    this.db.connection.prepare('UPDATE demo_accounts SET username=? WHERE owner=? AND origin=?').run(name,owner,origin);
    const row=this.db.connection.prepare('SELECT created_at,last_used_at FROM demo_accounts WHERE owner=? AND origin=?').get(owner,origin)!;
    return {origin,username:name,kind,createdAt:Number(row.created_at),lastUsedAt:row.last_used_at===null?null:Number(row.last_used_at)};
   }
   // A user may save a demo account before their first recording; the account row is created on demand.
   this.db.connection.prepare('INSERT OR IGNORE INTO accounts(owner,created_at) VALUES (?,?)').run(owner,now);
   const count=Number(this.db.connection.prepare('SELECT count(*) n FROM demo_accounts WHERE owner=? AND origin<>?').get(owner,origin)!.n);
   if(count>=MAX_PER_OWNER)throw new Error('demo_account_limit');
   this.db.connection.prepare(`INSERT INTO demo_accounts(owner,origin,username,secret,kind,created_at,last_used_at) VALUES (?,?,?,?,?,?,NULL)
    ON CONFLICT(owner,origin) DO UPDATE SET username=excluded.username,secret=excluded.secret,kind=excluded.kind,created_at=excluded.created_at,last_used_at=NULL`)
    .run(owner,origin,name,this.seal(kind==='password'?password!:'',`${owner}:${origin}`),kind,now);
   return {origin,username:name,kind,createdAt:now,lastUsedAt:null};
  });
 }
 /** Returns the secret for one login attempt and records the use; callers must drop it right after typing it. */
 take(owner:string,url:string,now=Date.now()):{username:string;password:string|undefined}|undefined {
  const origin=demoOrigin(url);
  const row=this.db.connection.prepare('SELECT username,secret,kind FROM demo_accounts WHERE owner=? AND origin=?').get(owner,origin);
  if(!row)return undefined;
  this.db.connection.prepare('UPDATE demo_accounts SET last_used_at=? WHERE owner=? AND origin=?').run(now,owner,origin);
  if(row.kind==='email')return {username:String(row.username),password:undefined};
  return {username:String(row.username),password:this.open(String(row.secret),`${owner}:${origin}`)};
 }
 remove(owner:string,origin:string):boolean {
  return Number(this.db.connection.prepare('DELETE FROM demo_accounts WHERE owner=? AND origin=?').run(owner,origin).changes)===1;
 }
 removeAll(owner:string):void {this.db.connection.prepare('DELETE FROM demo_accounts WHERE owner=?').run(owner);}
}
