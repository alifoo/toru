import { auth } from '@clerk/nextjs/server';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
const headers={'Cache-Control':'private, no-store'};
/** Brand settings per product domain for the signed-in account. */
async function handle(request:Request) {
  if(request.method!=='GET' && request.headers.get('origin')!==new URL(request.url).origin)
    return Response.json({error:'origin_forbidden'},{status:403,headers});
  const {userId}=await auth();
  if(!userId)return Response.json({error:'authentication_required'},{status:401,headers});
  const base=process.env.RECORDER_URL,key=process.env.RECORDER_ADMIN_KEY;
  if(!base||!key)return Response.json({error:'recorder_not_configured'},{status:503,headers});
  try {
    const url=new URL('/admin/brands',base);url.searchParams.set('owner',recorderOwnerFor(userId));
    let body:string|undefined;
    if(request.method==='POST'){
      const input=await request.json().catch(()=>null) as {origin?:unknown;brand?:unknown}|null;
      if(!input||typeof input.origin!=='string'||typeof input.brand!=='object'||input.brand===null)return Response.json({error:'invalid_brand'},{status:400,headers});
      body=JSON.stringify({origin:input.origin,brand:input.brand});
    }
    if(request.method==='DELETE'){
      const origin=new URL(request.url).searchParams.get('origin');
      if(!origin)return Response.json({error:'origin_required'},{status:400,headers});
      url.searchParams.set('origin',origin);
    }
    const response=await fetch(url,{method:request.method,headers:{authorization:`Bearer ${key}`,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    const result=await response.json().catch(()=>({})) as Record<string,unknown>;
    if(!response.ok)return Response.json({error:typeof result.error==='string'?result.error:'brands_unavailable'},{status:response.status===400?400:503,headers});
    if(request.method==='GET')return Response.json({brands:Array.isArray(result.brands)?result.brands:[]},{headers});
    if(request.method==='POST')return Response.json({brand:result.brand},{headers});
    return Response.json({removed:result.removed===true},{headers});
  }catch{return Response.json({error:'brands_unavailable'},{status:503,headers});}
}
export const GET=handle;
export const POST=handle;
export const DELETE=handle;
