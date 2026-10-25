import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createInvite, revokeInvites } from './invites.js';
import { authenticateBearer } from './auth.js';

it('revokes one token without erasing shared imports; last-token and owner revocation still purge them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-revoke-'));
  const owner = randomUUID(), otherOwner = randomUUID();
  try {
    await mkdir(join(dir, 'imports'));
    const path = join(dir, 'imports', `${randomUUID()}.json`);
    const otherPath = join(dir, 'imports', `${randomUUID()}.json`);
    const seed = () => writeFile(path, JSON.stringify({ owner, data: 'synthetic-encrypted-state' }));
    const primary = await createInvite(dir, owner);
    await seed();await writeFile(otherPath, JSON.stringify({ owner: otherOwner }));
    const temporary = await createInvite(dir, owner);
    await revokeInvites(dir, { token: temporary.token });
    expect(await authenticateBearer(`Bearer ${temporary.token}`, dir)).toBeUndefined();
    expect(await authenticateBearer(`Bearer ${primary.token}`, dir)).toMatchObject({ owner });
    expect(await readFile(path, 'utf8')).toContain('synthetic-encrypted-state');
    await createInvite(dir, owner, '0s'); // An expired grant must not preserve state.
    await revokeInvites(dir, { token: primary.token });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await seed();await createInvite(dir, owner);await createInvite(dir, owner);
    await revokeInvites(dir, { owner });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(otherPath, 'utf8')).owner).toBe(otherOwner);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('atomically bounds active grants and rolling issuance and denies suspended accounts',async()=>{
  const {withRecorderStore}=await import('./store/open.js');
  const dir=await mkdtemp(join(tmpdir(),'recorder-grants-'));const owner=randomUUID();
  try {
    const attempts=await Promise.allSettled(Array.from({length:8},()=>createInvite(dir,owner)));
    expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(5);
    expect(attempts.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.message)).toEqual(Array(3).fill('active_invite_limit'));
    for(let batch=0;batch<3;batch++){await revokeInvites(dir,{owner});for(let i=0;i<5;i++)await createInvite(dir,owner);}
    await revokeInvites(dir,{owner});
    await expect(createInvite(dir,owner)).rejects.toThrow('invite_issuance_limit');
    await withRecorderStore(dir,db=>db.connection.prepare("UPDATE accounts SET admission_status='suspended' WHERE owner=?").run(owner));
    await expect(createInvite(dir,owner)).rejects.toThrow('account_not_admitted');
    await createInvite(dir,randomUUID());
  }finally{await rm(dir,{recursive:true,force:true});}
});
