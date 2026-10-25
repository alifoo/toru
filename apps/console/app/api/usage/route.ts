import { auth } from '@clerk/nextjs/server';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
const headers={'Cache-Control':'private, no-store'};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});

export async function GET(request?:Request) {
  const { userId }=await auth();
  if(!userId) return fail('authentication_required',401);
  const recorderUrl=process.env.RECORDER_URL,adminKey=process.env.RECORDER_ADMIN_KEY;
  if(!recorderUrl || !adminKey) return fail('recorder_not_configured',503);
  const url=new URL('/admin/usage',recorderUrl);
  // Owner comes only from verified Clerk identity, never query parameters or browser input.
  url.searchParams.set('owner',recorderOwnerFor(userId));
  const cursor=request?new URL(request.url).searchParams.get('historyCursor'):null;
  if(cursor!==null){
    if(!/^[0-9a-f-]{36}$/i.test(cursor))return fail('invalid_history_cursor',400);
    url.searchParams.set('historyCursor',cursor);
  }
  try {
    const response=await fetch(url,{headers:{authorization:`Bearer ${adminKey}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
    const body=await response.json().catch(()=>({error:'recorder_unavailable'}));
    if(!response.ok){
      if(response.status===400&&body?.error==='invalid_history_cursor')return fail('invalid_history_cursor',400);
      return fail('recorder_unavailable',503);
    }
    return Response.json(body,{status:response.status,headers:{'Cache-Control':'private, no-store'}});
  } catch {return fail('recorder_unavailable',503);}
}
