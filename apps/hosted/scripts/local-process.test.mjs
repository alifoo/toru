import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {spawnLocalCommand,stopLocalCommand} from './local-process.mjs';

const grandchild=`const server=require('node:net').createServer();process.on('SIGTERM',()=>{});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));`;
const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});`;
const reachable=port=>new Promise(resolve=>{const socket=connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});

for(const mode of ['stop','disconnect'])test(`removes a TERM-resistant grandchild on ${mode}`,{timeout:10000},async()=>{
  const child=spawnLocalCommand(process.execPath,['-e',parent],process.env,{output:'pipe',graceMs:200});
  try {
    const port=await new Promise((resolve,reject)=>{
      let output='';const timeout=setTimeout(()=>reject(new Error('fixture_not_ready')),5000);
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(output.split('\n')[0]).port);}});
      child.once('error',reject);
    });
    assert.equal(await reachable(port),true);
    if(mode==='stop')await stopLocalCommand(child);
    else {const exited=new Promise(resolve=>child.once('exit',resolve));child.disconnect();await exited;}
    // Group SIGKILL delivery/reaping can finish just after the leader's exit event.
    const deadline=Date.now()+1000;
    while(await reachable(port)){
      assert.ok(Date.now()<deadline,'grandchild_listener_survived_shutdown');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }finally{await stopLocalCommand(child);}
});
