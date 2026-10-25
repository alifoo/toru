import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyBackupMaintenanceServer} from '../dist/backup-legacy-http.js';

test('maintenance answers Railway health while refusing all product traffic',async()=>{
  let phase='copying';
  const server=createLegacyBackupMaintenanceServer(()=>phase);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const health=await fetch(`${origin}/healthz`);
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{ok:true,mode:'maintenance',backup:'copying'});
    const blocked=await fetch(`${origin}/mcp`,{method:'POST'});
    assert.equal(blocked.status,503);
    assert.equal(blocked.headers.get('retry-after'),'300');
    assert.deepEqual(await blocked.json(),{error:'maintenance'});
    assert.equal((await fetch(`${origin}/healthz`,{method:'POST'})).status,503);
    phase='verified';
    assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(),
      {ok:true,mode:'maintenance',backup:'verified'});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
