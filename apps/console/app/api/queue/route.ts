import { auth } from '@clerk/nextjs/server';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
const headers={'Cache-Control':'private, no-store'};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});

async function forward(method:'GET'|'DELETE',jobId?:string) {
  const {userId}=await auth();
  if(!userId) return fail('authentication_required',401);
  const host=process.env.RECORDER_URL,key=process.env.RECORDER_ADMIN_KEY;
  if(!host || !key) return fail('recorder_not_configured',503);
  try {
    const url=new URL('/admin/queue',host);
    url.searchParams.set('owner',recorderOwnerFor(userId));
    if(jobId) url.searchParams.set('jobId',jobId);
    const response=await fetch(url,{method,headers:{authorization:`Bearer ${key}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    const body=await response.json();
    if(!response.ok){
      if(method==='DELETE'&&response.status===404&&body?.error==='queued_job_not_found')return fail('queued_job_not_found',404);
      return fail('recorder_unavailable',503);
    }
    if(method==='GET'&&!Array.isArray(body?.jobs))return fail('recorder_unavailable',503);
    return Response.json(method==='GET'?{jobs:body.jobs}:body,{headers});
  } catch {return fail('recorder_unavailable',503);}
}
export async function GET() {return forward('GET');}
export async function DELETE(request:Request) {
  if(request.headers.get('origin')!==new URL(request.url).origin) return fail('origin_not_allowed',403);
  const jobId=new URL(request.url).searchParams.get('jobId');
  if(!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return fail('invalid_job_id',400);
  return forward('DELETE',jobId);
}
