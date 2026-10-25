import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {RecorderDatabase} from './database.js';
import {openRecorderStore} from './open.js';
import {pruneSessionImports} from './retention.js';
import {Recorder} from '../recorder.js';

it('retries expired rows with missing files and removes orphan import bytes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recorder-import-retention-'));
  const imports=join(dir,'imports');await mkdir(imports);
  const db=new RecorderDatabase(join(dir,'recorder.sqlite'));
  const owner=randomUUID(),expired=randomUUID(),missing=randomUUID(),active=randomUUID();
  const orphan=randomUUID(),temporary=randomUUID();
  const now=1_800_000_000_000;
  try{
    db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,now);
    const insert=db.connection.prepare('INSERT INTO session_imports(id,owner,expires_at,checksum,relative_path) VALUES (?,?,?,?,?)');
    for(const [id,expiresAt] of [[expired,now-1],[missing,now-1],[active,now+1]] as const)
      insert.run(id,owner,expiresAt,'a'.repeat(64),`imports/${id}.json`);
    for(const id of [expired,active,orphan])await writeFile(join(imports,`${id}.json`),'encrypted-fixture');
    const tempName=`${temporary}.json.${randomUUID()}.tmp`;
    await writeFile(join(imports,tempName),'incomplete-fixture');
    expect(await pruneSessionImports(db,dir,now,()=>true)).toEqual({expired:2,orphans:0});
    expect(db.connection.prepare('SELECT count(*) n FROM session_imports').get()!.n).toBe(1);
    await expect(stat(join(imports,`${expired}.json`))).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(join(imports,`${active}.json`),'utf8')).toBe('encrypted-fixture');
    expect(await pruneSessionImports(db,dir,now)).toEqual({expired:0,orphans:2});
    expect(await pruneSessionImports(db,dir,now)).toEqual({expired:0,orphans:0});
    expect(await readFile(join(imports,`${active}.json`),'utf8')).toBe('encrypted-fixture');
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

it('reports periodic cleanup failure and clears it after recovery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recorder-retention-health-'));
  const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),
    createContext:async()=>{throw new Error('unused')},render:async()=>{throw new Error('unused')}});
  const logged=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  try{
    await recorder.initialize();
    const imports=join(dir,'imports');
    await rm(imports,{recursive:true});
    await writeFile(imports,'not a directory');
    await vi.waitFor(async()=>{
      const status=(await recorder.operationalMetrics()).retention as {lastCleanupFailedAt:number|null};
      expect(status.lastCleanupFailedAt).toEqual(expect.any(Number));
    },{timeout:3000});
    expect(logged).toHaveBeenCalledWith('recorder_retention_cleanup_failed');
    await rm(imports);await mkdir(imports);
    await vi.waitFor(async()=>{
      const status=(await recorder.operationalMetrics()).retention as {lastCleanupFailedAt:number|null};
      expect(status.lastCleanupFailedAt).toBeNull();
    },{timeout:3000});
  }finally{logged.mockRestore();await recorder.close();await rm(dir,{recursive:true,force:true});}
});

it('runs import reconciliation when the Recorder starts after an interrupted write',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recorder-import-startup-'));
  const imports=join(dir,'imports');await mkdir(imports);
  const orphan=randomUUID();
  const db=await openRecorderStore(dir);
  db.close();
  await writeFile(join(imports,`${orphan}.json`),'orphaned encrypted bytes');
  const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),
    createContext:async()=>{throw new Error('unused')},render:async()=>{throw new Error('unused')}});
  try{
    await recorder.initialize();
    await expect(stat(join(imports,`${orphan}.json`))).rejects.toMatchObject({code:'ENOENT'});
    expect((await recorder.operationalMetrics()).retention).toMatchObject({
      lastCleanupSucceededAt:expect.any(Number),lastCleanupFailedAt:null
    });
  }finally{await recorder.close();await rm(dir,{recursive:true,force:true});}
});
