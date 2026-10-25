import {readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {RecorderDatabase} from './database.js';

const uuid=z.uuid();

/** Remove bytes before their SQL reference; interruption between steps is safe to retry. */
export async function pruneSessionImports(store:RecorderDatabase,dataDir:string,now:number,
  importInProgress:()=>boolean=()=>false){
  const sql=store.connection;
  const directory=join(dataDir,'imports');
  const expired=sql.prepare('SELECT id FROM session_imports WHERE expires_at<=?').all(now);
  let removed=0;
  for(const row of expired){
    const id=uuid.parse(row.id);
    await rm(join(directory,`${id}.json`),{force:true});
    removed+=Number(sql.prepare('DELETE FROM session_imports WHERE id=? AND expires_at<=?').run(id,now).changes);
  }
  if(importInProgress())return {expired:removed,orphans:0};
  const hasReference=sql.prepare('SELECT 1 FROM session_imports WHERE id=?');
  let orphans=0;
  for(const name of await readdir(directory)){
    const normal=name.match(/^([0-9a-f-]{36})\.json$/i);
    const temporary=name.match(/^([0-9a-f-]{36})\.json\.([0-9a-f-]{36})\.tmp$/i);
    const id=normal?.[1]??temporary?.[1];
    if(!id||!uuid.safeParse(id).success||
      (temporary&&!uuid.safeParse(temporary[2]).success)||
      (normal&&hasReference.get(id)))continue;
    if(importInProgress())break;
    await rm(join(directory,name),{force:true});
    orphans++;
  }
  return {expired:removed,orphans};
}
