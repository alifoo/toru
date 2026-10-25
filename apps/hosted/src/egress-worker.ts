import {pathToFileURL} from 'node:url';
import {startEgressProxy} from '@agent-recorder/mcp/egress';

/** A dual-homed proxy: only this container can resolve and contact public sites. */
export async function startEgressWorker(){
 const proxy=await startEgressProxy({bindAddress:'0.0.0.0',port:37843});
 let stopping=false;
 const stop=()=>{if(stopping)return;stopping=true;void proxy.close();};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 return proxy;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 startEgressWorker().catch(error=>{console.error(error instanceof Error?error.message:'egress_worker_start_failed');process.exitCode=1;});
