import {auth} from '@clerk/nextjs/server';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport,StreamableHTTPError} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';

const headers={'cache-control':'private, no-store'};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});
const requiredTools=['session_open','recording_start','recording_render','recording_links'];

/** Checks the user's actual bearer against the configured Recorder without opening a browser or using a credit. */
export async function POST(request:Request){
  if(request.headers.get('origin')!==new URL(request.url).origin)return fail('origin_forbidden',403);
  const {userId}=await auth();
  if(!userId)return fail('authentication_required',401);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return fail('json_required',415);
  const recorderUrl=process.env.RECORDER_URL;
  if(!recorderUrl)return fail('recorder_not_configured',503);
  let input:unknown;
  try{
    const reader=request.body?.getReader();if(!reader)return fail('invalid_body',400);
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>256){await reader.cancel();return fail('body_too_large',413);}chunks.push(value);}}
    finally{reader.releaseLock();}
    input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{return fail('invalid_body',400);}
  if(!input||typeof input!=='object'||Array.isArray(input))return fail('invalid_body',400);
  const token=(input as Record<string,unknown>).token;
  if(typeof token!=='string'||!/^ar_[A-Za-z0-9_-]{32,128}$/.test(token))return fail('invalid_credential',400);
  let endpoint:URL;
  try{endpoint=new URL('/mcp',recorderUrl);if(!['http:','https:'].includes(endpoint.protocol))throw new Error();}
  catch{return fail('recorder_not_configured',503);}
  const client=new Client({name:'agent-recorder-console-check',version:'0.1.0'});
  try{
    await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{
      headers:{Authorization:`Bearer ${token}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10_000),
    }}));
    const listed=await client.listTools({}, {timeout:8_000});
    if(!requiredTools.every(name=>listed.tools.some(tool=>tool.name===name)))return fail('recorder_tools_unavailable',503);
    return Response.json({connected:true},{headers});
  }catch(error){
    const rejected=error instanceof UnauthorizedError||error instanceof StreamableHTTPError&&error.code===401;
    return fail(rejected?'credential_rejected':'recorder_unavailable',rejected?401:503);
  }finally{await client.close().catch(()=>undefined);}
}
