import { auth } from "@clerk/nextjs/server";
import { recorderOwnerFor } from "../../../lib/recorder-owner";
const headers={"cache-control":"private, no-store"};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});

export async function POST(request: Request) {
  if(request.headers.get('origin')!==new URL(request.url).origin) return fail('origin_forbidden',403);
  const { userId } = await auth();
  if (!userId) return fail("authentication_required",401);
  const recorderUrl = process.env.RECORDER_URL, adminKey = process.env.RECORDER_ADMIN_KEY;
  if (!recorderUrl || !adminKey) return fail("recorder_not_configured",503);
  if(!request.headers.get('content-type')?.startsWith('application/json')) return fail('json_required',415);
  let input:{expiresIn?:unknown};
  try {
    const reader=request.body?.getReader();if(!reader)return fail('invalid_body',400);
    const chunks:Uint8Array[]=[];let size=0;
    try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();return fail('body_too_large',413);}chunks.push(value);} }
    finally {reader.releaseLock();}
    input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))return fail('invalid_body',400);
  } catch {return fail('invalid_body',400);}
  const expiresIn=input.expiresIn ?? '1d';
  if(typeof expiresIn!=='string'||!/^(1h|1d|7d)$/.test(expiresIn))return fail('invalid_expiry',400);
  try {
    const response = await fetch(new URL("/admin/invites", recorderUrl), {
      method:"POST",headers:{authorization:`Bearer ${adminKey}`,"content-type":"application/json"},
      body:JSON.stringify({owner:recorderOwnerFor(userId),expiresIn}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10_000),
    });
    const body=await response.json();
    if(response.status!==201) {
      const safe=['active_invite_limit','invite_issuance_limit','account_not_admitted','beta_admission_required'];
      return safe.includes(body?.error) ? fail(body.error,['account_not_admitted','beta_admission_required'].includes(body.error)?403:429) : fail('invite_creation_status_unknown',503);
    }
    if(typeof body?.token!=='string'||!/^ar_[A-Za-z0-9_-]+$/.test(body.token)||typeof body.expiresAt!=='string'||!Number.isFinite(Date.parse(body.expiresAt)))return fail('invite_creation_status_unknown',503);
    return Response.json({token:body.token,owner:recorderOwnerFor(userId),expiresAt:body.expiresAt},{status:201,headers});
  } catch {return fail('invite_creation_status_unknown',503);}
}

export async function DELETE(request:Request) {
  if(request.headers.get('origin')!==new URL(request.url).origin)return fail('origin_forbidden',403);
  const {userId}=await auth();if(!userId)return fail('authentication_required',401);
  const recorderUrl=process.env.RECORDER_URL,adminKey=process.env.RECORDER_ADMIN_KEY;
  if(!recorderUrl||!adminKey)return fail('recorder_not_configured',503);
  try {
    const url=new URL('/admin/invites',recorderUrl);url.searchParams.set('owner',recorderOwnerFor(userId));
    const response=await fetch(url,{method:'DELETE',headers:{authorization:`Bearer ${adminKey}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10_000)});
    const body=await response.json();
    if(response.status===404&&body?.error==='invite_not_found')return Response.json({revoked:0},{headers});
    if(!response.ok||!Number.isSafeInteger(body?.revoked)||body.revoked<0)return fail('credential_revocation_status_unknown',503);
    return Response.json({revoked:body.revoked},{headers});
  }catch{return fail('credential_revocation_status_unknown',503);}
}
