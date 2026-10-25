import {createServer} from 'node:http';

/** A cutover window is deliberately unavailable to product traffic. */
export function createLegacyBackupMaintenanceServer(phase:()=> 'copying'|'verified'){
  return createServer((request,response)=>{
    const health=request.method==='GET'&&request.url==='/healthz';
    response.writeHead(health?200:503,{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store',
      'Connection':'close',
      ...(!health?{'Retry-After':'300'}:{}),
    });
    response.end(JSON.stringify(health?{ok:true,mode:'maintenance',backup:phase()}:{error:'maintenance'}));
  });
}
