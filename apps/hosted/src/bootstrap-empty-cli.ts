import {createServer} from 'node:http';
import {deletionBucketFromEnvironment} from '@agent-recorder/hosted-policy/dist/deletion-bucket.js';
import {bootstrapEmptyHostedStore} from './bootstrap-empty.js';

async function main(){
  if(process.env.RECORDER_MODE!=='init-empty'||process.env.RECORDER_MAINTENANCE_LOCK!=='held')
    throw new Error('empty_bootstrap_maintenance_required');
  const bucket=deletionBucketFromEnvironment(process.env);
  if(!bucket)throw new Error('hosted_deletion_bucket_required');
  await bootstrapEmptyHostedStore(process.env.DATA_DIR??'/data',process.env,bucket);
  const port=Number(process.env.PORT??3002);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid_port');
  const server=createServer((request,response)=>{
    response.setHeader('cache-control','no-store');
    if(request.url==='/healthz'){
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({ok:true,phase:'empty_initialized'}));
    }else{response.writeHead(503);response.end();}
  });
  server.listen(port,'0.0.0.0');
  console.log('empty_volume_initialized');
}
main().catch((error:unknown)=>{
  console.error(error instanceof Error?error.message:'empty_bootstrap_failed');process.exitCode=1;
});
