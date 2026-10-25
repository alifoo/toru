import {createServer,connect,type Socket} from 'node:net';
import {isIP} from 'node:net';
import {pathToFileURL} from 'node:url';

/** Fixed-destination relay: the browser container is never attached to an egress network. */
export function createWorkerRelay(host='recorder-browser',port=37842){
 const dockerAddress=isIP(host)===4&&(/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host));
 if((host!=='recorder-browser'&&!dockerAddress)||!Number.isInteger(port)||port<1024||port>65535)
  throw new Error('invalid_worker_relay_target');
 const clients=new Set<Socket>();
 const server=createServer(client=>{
  clients.add(client);client.on('close',()=>clients.delete(client));
  const upstream=connect({host,port});
  client.setTimeout(40_000,()=>client.destroy());
  upstream.setTimeout(40_000,()=>upstream.destroy());
  client.on('error',()=>upstream.destroy());
  upstream.on('error',()=>client.destroy());
  client.on('close',()=>upstream.destroy());
  // A normal upstream close can arrive before piped response bytes have drained
  // to the private-network client. Let pipe() end the client after that drain.
  upstream.on('close',()=>{if(!upstream.readableEnded)client.destroy();});
  client.pipe(upstream);upstream.pipe(client);
 });
 server.maxConnections=16;
 return {server,close(){for(const client of clients)client.destroy();server.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.RECORDER_RELAY_PORT??37842);
 const relay=createWorkerRelay(process.env.RECORDER_RELAY_HOST??'recorder-browser',port);const {server}=relay;
 server.listen(port,'::');
 process.once('SIGTERM',()=>relay.close());
 process.once('SIGINT',()=>relay.close());
}
