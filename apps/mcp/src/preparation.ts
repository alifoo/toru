import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RecorderDatabase } from './store/database.js';

const route=z.string().min(1).max(300).regex(/^\/(?!\/)[^?#\s]*$/, 'Use route paths without query parameters or fragments');
export const preparationScope=z.object({
  project:z.string().trim().min(1).max(120),
  revision:z.string().trim().min(1).max(128),
  routes:z.array(route).min(1).max(20).transform(items=>[...new Set(items)].sort()),
});
export const preparationSave=z.object({
  requestId:z.uuid(), scope:preparationScope,
  summary:z.string().trim().min(1).max(4000),
  files:z.array(z.string().min(1).max(300)).max(20).default([]),
});
export const preparationRead=z.object({preparationId:z.uuid(),scope:preparationScope});

/** Explicitly supplied preparation only; never a repository dump or browser observation log. */
export class PreparationStore {
  constructor(private readonly store:RecorderDatabase,private readonly now=Date.now) {}
  save(owner:string,raw:unknown) {
    const input=preparationSave.parse(raw), now=this.now();
    const note=JSON.stringify({scope:input.scope,summary:input.summary,files:input.files});
    const hash=createHash('sha256').update(note).digest('hex');
    return this.store.transaction(()=>{
      this.expire(now);
      const prior=this.store.connection.prepare('SELECT * FROM preparation_notes WHERE owner=? AND id=?').get(owner,input.requestId);
      if(prior) {
        if(prior.input_hash!==hash) throw new Error('preparation_request_conflict');
        return {preparationId:input.requestId,expiresAt:Number(prior.expires_at)};
      }
      const count=Number(this.store.connection.prepare('SELECT count(*) n FROM preparation_notes WHERE owner=?').get(owner)!.n);
      if(count>=20) throw new Error('preparation_capacity_reached');
      const expiresAt=now+24*60*60_000;
      this.store.connection.prepare('INSERT INTO preparation_notes(owner,id,created_at,expires_at,input_hash,note) VALUES (?,?,?,?,?,?)')
        .run(owner,input.requestId,now,expiresAt,hash,note);
      return {preparationId:input.requestId,expiresAt};
    });
  }
  read(owner:string,raw:unknown) {
    const input=preparationRead.parse(raw); this.expire(this.now());
    const row=this.store.connection.prepare('SELECT * FROM preparation_notes WHERE owner=? AND id=?').get(owner,input.preparationId);
    if(!row) throw new Error('preparation_not_found_or_expired');
    const note=JSON.parse(String(row.note)) as z.infer<typeof preparationSave>;
    const changed=(['project','revision','routes'] as const).filter(key=>JSON.stringify(note.scope[key])!==JSON.stringify(input.scope[key]));
    if(changed.length) return {preparationId:input.preparationId,status:'invalidated',changed,
      instruction:'Review the changed scope and save a new compact preparation with a new requestId. Do not reuse the old assumptions.'};
    return {preparationId:input.preparationId,status:'available',expiresAt:Number(row.expires_at),...note,
      instruction:'Reuse this preparation only within the supplied scope. Read additional code only when needed; there is no minimum file count. Scope is client-reported, not independently verified.'};
  }
  private expire(now:number) {this.store.connection.prepare('DELETE FROM preparation_notes WHERE expires_at<=?').run(now);}
}
