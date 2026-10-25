import {auth} from '@clerk/nextjs/server';
import {recorderOwnerFor} from '../../../lib/recorder-owner';
const headers={'Cache-Control':'private, no-store'};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});
export async function POST(request:Request){
  if(request.headers.get('origin')!==new URL(request.url).origin)return fail('origin_forbidden',403);
  const {userId}=await auth();if(!userId)return fail('authentication_required',401);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return fail('json_required',415);
  let input:{id?:unknown;useful?:unknown;reason?:unknown};
  try{
    const reader=request.body?.getReader();if(!reader)return fail('invalid_feedback',400);
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024){await reader.cancel();return fail('body_too_large',413);}chunks.push(value);}}
    finally{reader.releaseLock();}
    input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!input||typeof input.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)||typeof input.useful!=='boolean'||
      (input.reason!==undefined&&(typeof input.reason!=='string'||!['quality','wrong_flow','slow','other'].includes(input.reason)))||
      (input.useful&&input.reason!==undefined))return fail('invalid_feedback',400);
  }catch{return fail('invalid_feedback',400);}
  const host=process.env.RECORDER_URL,key=process.env.RECORDER_ADMIN_KEY;
  if(!host||!key)return fail('feedback_unavailable',503);
  try{
    const response=await fetch(new URL('/admin/feedback',host),{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
      body:JSON.stringify({owner:recorderOwnerFor(userId),id:input.id,useful:input.useful,...(input.reason===undefined?{}:{reason:input.reason})}),
      cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    const body=await response.json();
    if(response.status===404&&body?.error==='recording_not_found')return fail('recording_not_found',404);
    if(!response.ok||body?.state!=='saved'||body.useful!==input.useful)return fail('feedback_unconfirmed',503);
    return Response.json({state:'saved'},{headers});
  }catch{return fail('feedback_unconfirmed',503);}
}
