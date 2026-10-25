import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {DemoAccountStore} from './demo-accounts.js';
import {openRecorderStore} from './open.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const c of cleanups.splice(0))await c();});
async function db(){
 const dir=await mkdtemp(join(tmpdir(),'demo-accounts-'));const store=await openRecorderStore(dir);
 cleanups.push(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 return store;
}
it('seals the secret at rest, lists without it, and returns it only to the owner of that origin',async()=>{
 const store=await db(),key=randomBytes(32),owner=randomUUID(),other=randomUUID();
 for(const o of [owner,other])store.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(o,Date.now());
 const vault=new DemoAccountStore(store,key);
 const saved=vault.save(owner,'https://app.example.com/login?next=1','demo@example.com','hunter2-demo');
 expect(saved).toMatchObject({origin:'https://app.example.com',username:'demo@example.com',lastUsedAt:null});
 expect(vault.list(owner)).toEqual([saved]);
 expect(JSON.stringify(vault.list(owner))).not.toContain('hunter2');
 const row=store.connection.prepare('SELECT secret FROM demo_accounts').get()!;
 expect(String(row.secret)).not.toContain('hunter2');
 expect(vault.take(other,'https://app.example.com')).toBeUndefined();
 expect(vault.take(owner,'https://app.example.com/anything')).toEqual({username:'demo@example.com',password:'hunter2-demo'});
 expect(vault.list(owner)[0]!.lastUsedAt).toBeTypeOf('number');
 // Another server key cannot open the row.
 expect(()=>new DemoAccountStore(store,randomBytes(32)).take(owner,'https://app.example.com')).toThrow();
 expect(()=>vault.save(owner,'http://insecure.example.com','u','p')).toThrow('public_https_url_required');
 expect(vault.remove(owner,'https://app.example.com')).toBe(true);
 expect(vault.take(owner,'https://app.example.com')).toBeUndefined();
});

it('saves e-mail logins without a secret and hands them out without a password',async()=>{
 const store=await db(),owner=randomUUID();
 const vault=new DemoAccountStore(store,randomBytes(32));
 expect(()=>vault.save(owner,'https://app.example.com','not-an-email',undefined)).toThrow('invalid_email');
 const saved=vault.save(owner,'https://app.example.com/login','demo@example.com',undefined);
 expect(saved).toMatchObject({origin:'https://app.example.com',kind:'email'});
 expect(vault.list(owner)[0]!.kind).toBe('email');
 expect(vault.take(owner,'https://app.example.com')).toEqual({username:'demo@example.com',password:undefined});
 // Switching the same origin to a password login replaces it.
 vault.save(owner,'https://app.example.com','demo@example.com','pw-demo');
 expect(vault.take(owner,'https://app.example.com')).toEqual({username:'demo@example.com',password:'pw-demo'});
 expect(vault.list(owner)[0]!.kind).toBe('password');
});

it('edits a password login: new e-mail keeps the password, a new password replaces it',async()=>{
 const store=await db(),owner=randomUUID();
 const vault=new DemoAccountStore(store,randomBytes(32));
 vault.save(owner,'https://app.example.com','old@example.com','wrong-pass');
 vault.save(owner,'https://app.example.com','new@example.com',undefined,Date.now(),'password');
 expect(vault.take(owner,'https://app.example.com')).toEqual({username:'new@example.com',password:'wrong-pass'});
 vault.save(owner,'https://app.example.com','new@example.com','right-pass');
 expect(vault.take(owner,'https://app.example.com')).toEqual({username:'new@example.com',password:'right-pass'});
 expect(()=>vault.save(owner,'https://other.example.com','a@example.com',undefined,Date.now(),'password')).toThrow('invalid_credentials');
});
