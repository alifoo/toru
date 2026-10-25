import { auth } from '@clerk/nextjs/server';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
const headers={'Cache-Control':'private, no-store'};
async function handle(request:Request) {
  if(request.method!=='GET' && request.headers.get('origin')!==new URL(request.url).origin)
    return Response.json({error:'origin_forbidden'},{status:403,headers});
  const {userId}=await auth();
  if(!userId)return Response.json({error:'authentication_required'},{status:401,headers});
  const base=process.env.RECORDER_URL,key=process.env.RECORDER_ADMIN_KEY;
  if(!base||!key)return Response.json({error:'recorder_not_configured'},{status:503,headers});
  try {
    const url=new URL('/admin/connections',base);url.searchParams.set('owner',recorderOwnerFor(userId));
    const response=await fetch(url,{method:request.method,headers:{authorization:`Bearer ${key}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('unavailable');
    return Response.json(await response.json(),{headers});
  }catch{return Response.json({error:'connections_unavailable'},{status:503,headers});}
}
export const GET=handle;
export const POST=handle;
export const DELETE=handle;
