import { auth } from '@clerk/nextjs/server';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
const headers={'Cache-Control':'private, no-store'};
/** Paired Macs for the signed-in account: list, mint a setup link, or disconnect one. */
async function handle(request:Request) {
  if(request.method!=='GET' && request.headers.get('origin')!==new URL(request.url).origin)
    return Response.json({error:'origin_forbidden'},{status:403,headers});
  const {userId}=await auth();
  if(!userId)return Response.json({error:'authentication_required'},{status:401,headers});
  const base=process.env.RECORDER_URL,key=process.env.RECORDER_ADMIN_KEY;
  if(!base||!key)return Response.json({error:'recorder_not_configured'},{status:503,headers});
  try {
    const url=new URL('/admin/desktop-devices',base);url.searchParams.set('owner',recorderOwnerFor(userId));
    if(request.method==='DELETE'){
      const id=new URL(request.url).searchParams.get('id');
      if(!id||!/^[0-9a-f-]{36}$/i.test(id))return Response.json({error:'id_required'},{status:400,headers});
      url.searchParams.set('id',id);
    }
    const response=await fetch(url,{method:request.method,headers:{authorization:`Bearer ${key}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('unavailable');
    const body=await response.json() as Record<string,unknown>;
    if(request.method==='GET')return Response.json({devices:Array.isArray(body.devices)?body.devices:[]},{headers});
    if(request.method==='POST')return Response.json({pairingCode:body.pairingCode,expiresAt:body.expiresAt,serverUrl:body.serverUrl,setupUrl:body.setupUrl,downloadUrl:body.downloadUrl},{headers});
    return Response.json({revoked:body.revoked===true},{headers});
  }catch{return Response.json({error:'devices_unavailable'},{status:503,headers});}
}
export const GET=handle;
export const POST=handle;
export const DELETE=handle;
