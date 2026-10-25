import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { RecorderDatabase } from './store/database.js';
import { PreparationStore } from './preparation.js';
import { NavigationController } from './navigation.js';

it('reuses preparation across restart, isolates accounts, invalidates changed scope and expires it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'preparation-')); const path=join(dir,'recorder.sqlite');
  let db=new RecorderDatabase(path), now=1000;
  const owner=randomUUID(), other=randomUUID(), requestId=randomUUID();
  for(const id of [owner,other]) db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(id,now);
  const input={requestId,scope:{project:'demo',revision:'abc123',routes:['/people','/sheets']},summary:'Create a list, search, enrich one row.',files:['src/people.tsx']};
  try {
    let store=new PreparationStore(db,()=>now);
    const saved=store.save(owner,input); expect(store.save(owner,input)).toEqual(saved);
    expect(()=>store.save(owner,{...input,summary:'different'})).toThrow('preparation_request_conflict');
    db.close(); db=new RecorderDatabase(path); store=new PreparationStore(db,()=>now);
    expect(store.read(owner,{preparationId:requestId,scope:{...input.scope,routes:['/sheets','/people']}})).toMatchObject({status:'available',summary:input.summary});
    expect(()=>store.read(other,{preparationId:requestId,scope:input.scope})).toThrow('preparation_not_found_or_expired');
    for(const scope of [{...input.scope,revision:'new'},{...input.scope,routes:['/changed']},{...input.scope,project:'other'}]) {
      const invalid=store.read(owner,{preparationId:requestId,scope});
      expect(invalid.status).toBe('invalidated'); expect(invalid).not.toHaveProperty('summary');
    }
    now=saved.expiresAt;
    expect(()=>store.read(owner,{preparationId:requestId,scope:input.scope})).toThrow('preparation_not_found_or_expired');
    expect(db.connection.prepare('SELECT count(*) n FROM preparation_notes').get()!.n).toBe(0);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

it('routes preparation without a browser session, rejects revoked authorization and bounds storage',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'preparation-'));const db=new RecorderDatabase(join(dir,'recorder.sqlite'));
  const owner=randomUUID();db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
  const controller=new NavigationController({call:async()=>{throw new Error('browser_must_not_be_called');}},()=>{throw new Error('model_must_not_be_called');},db);
  const input={requestId:randomUUID(),scope:{project:'demo',revision:'1',routes:['/']},summary:'Short script'};
  try {
    await expect(controller.call(owner,'preparation_save',input,async()=>false)).rejects.toThrow('navigation_authorization_expired');
    const result=await controller.call(owner,'preparation_save',input);
    expect(result.structuredContent?.preparationId).toBe(input.requestId);
    const store=new PreparationStore(db);
    expect(()=>store.save(owner,{...input,summary:'x'.repeat(4001)})).toThrow();
    expect(()=>store.save(owner,{...input,scope:{...input.scope,routes:['/?token=secret']}})).toThrow();
    for(let i=1;i<20;i++) store.save(owner,{...input,requestId:randomUUID()});
    expect(()=>store.save(owner,{...input,requestId:randomUUID()})).toThrow('preparation_capacity_reached');
  } finally {await controller.close();db.close();await rm(dir,{recursive:true,force:true});}
});
