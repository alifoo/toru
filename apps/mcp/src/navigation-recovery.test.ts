import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RecorderDatabase } from './store/database.js';
import { NavigationController } from './navigation.js';

it('recovers interrupted navigation without replay, retains receipts and keeps typed data out of checkpoints', async () => {
  const dir=await mkdtemp(join(tmpdir(),'navigation-recovery-'));
  const path=join(dir,'recorder.sqlite'); const db=new RecorderDatabase(path);
  const owner=randomUUID(), id=randomUUID(), requestId=randomUUID();
  db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
  const call=vi.fn(async (who:string) => {
    if(who!==owner) throw new Error('recording_not_found');
    return {content:[],structuredContent:{id,status:'recording'}};
  });
  const run=vi.fn(async (input:any) => {
    input.onDecision({costUsd:0.012});
    await input.writeValue({field:{name:'Secret form label',role:'textbox'}});
    return {status:'done' as const,actions:0,decisions:1,costUsd:0.012};
  });
  const first=new NavigationController({call},()=>({run}),db);
  let reopened:RecorderDatabase|undefined, recovered:NavigationController|undefined;
  try {
    const args={id,requestId,goal:'Do this private goal',values:{Other:'private value'}};
    await first.call(owner,'navigation_start',args);
    await vi.waitFor(async()=>expect((await first.call(owner,'navigation_status',{id,waitMs:0})).structuredContent?.status).toBe('needs_input'));
    const checkpoint=String(db.connection.prepare('SELECT checkpoint FROM navigation_runs').get()!.checkpoint);
    expect(checkpoint).not.toMatch(/private|Secret form/);
    reopened=new RecorderDatabase(path);
    const factory=vi.fn(()=>({run}));
    recovered=new NavigationController({call},factory,reopened);
    const status=(await recovered.call(owner,'navigation_status',{id,waitMs:0})).structuredContent!;
    expect(status).toMatchObject({status:'interrupted',costUsd:0.012,requestId,reason:'server_restarted_no_actions_replayed'});
    expect((await recovered.call(owner,'navigation_start',args)).structuredContent?.status).toBe('interrupted');
    await expect(recovered.call(owner,'navigation_start',{...args,goal:'Different goal'})).rejects.toThrow('navigation_request_conflict');
    await expect(recovered.call(randomUUID(),'navigation_status',{id,waitMs:0})).rejects.toThrow('recording_not_found');
    await expect(recovered.call(owner,'navigation_start',{...args,requestId:randomUUID()})).rejects.toThrow('navigation_recovered_session_requires_new_session');
    expect(factory).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledOnce();
  } finally { await first.close(); await recovered?.close(); reopened?.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});
