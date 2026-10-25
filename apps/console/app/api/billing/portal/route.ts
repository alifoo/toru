import {auth} from '@clerk/nextjs/server';
import {recorderOwnerFor} from '../../../../lib/recorder-owner';

const headers={'cache-control':'private, no-store'};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});

export async function POST(request:Request){
  if(request.headers.get('origin')!==new URL(request.url).origin)return fail('origin_forbidden',403);
  const {userId}=await auth();
  if(!userId)return fail('authentication_required',401);
  const recorderUrl=process.env.RECORDER_URL,adminKey=process.env.RECORDER_ADMIN_KEY;
  if(!recorderUrl||!adminKey)return fail('billing_portal_unavailable',503);
  try{
    const response=await fetch(new URL('/admin/billing/portal',recorderUrl),{
      method:'POST',headers:{authorization:`Bearer ${adminKey}`,'content-type':'application/json'},
      body:JSON.stringify({owner:recorderOwnerFor(userId)}),cache:'no-store',redirect:'error',
      signal:AbortSignal.timeout(20_000)
    });
    const body=await response.json().catch(()=>null);
    if(response.status===404)return fail('billing_customer_not_found',404);
    if(response.status!==201||typeof body?.url!=='string')return fail('billing_portal_unavailable',503);
    const url=new URL(body.url);
    if(url.protocol!=='https:'||url.hostname!=='billing.stripe.com'||!url.pathname.startsWith('/p/session/'))
      return fail('billing_portal_unavailable',503);
    return Response.json({url:url.toString()},{status:201,headers});
  }catch{return fail('billing_portal_unavailable',503);}
}
