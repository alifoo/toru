import {auth} from '@clerk/nextjs/server';
import {recorderOwnerFor} from '../../../../lib/recorder-owner';

const headers={'cache-control':'private, no-store'};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request:Request){
  if(request.headers.get('origin')!==new URL(request.url).origin)return fail('origin_forbidden',403);
  const {userId}=await auth();
  if(!userId)return fail('authentication_required',401);
  if(process.env.RECORDER_CREATOR_CHECKOUT_ENABLED!=='true')return fail('checkout_unavailable',503);
  const recorderUrl=process.env.RECORDER_URL,adminKey=process.env.RECORDER_ADMIN_KEY;
  if(!recorderUrl||!adminKey)return fail('checkout_unavailable',503);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return fail('json_required',415);
  let input:unknown;
  try{
    const raw=await request.text();
    if(Buffer.byteLength(raw)>512)return fail('body_too_large',413);
    input=JSON.parse(raw);
  }catch{return fail('invalid_body',400);}
  const requestId=input&&typeof input==='object'&&!Array.isArray(input)
    ?(input as Record<string,unknown>).requestId:undefined;
  const plan=(input as Record<string,unknown>)?.plan??'creator';
  const pack=typeof plan==='string'&&/^pack-(1|15|30)$/.test(plan);
  if(pack&&process.env.RECORDER_CREDIT_PACKS_ENABLED!=='true')return fail('packs_unavailable',503);
  if(plan!=='creator'&&plan!=='studio'&&!pack)return fail('invalid_plan',400);
  if(typeof requestId!=='string'||!uuid.test(requestId))return fail('invalid_request_id',400);
  try{
    const response=await fetch(new URL('/admin/billing/checkout',recorderUrl),{
      method:'POST',headers:{authorization:`Bearer ${adminKey}`,'content-type':'application/json'},
      body:JSON.stringify({owner:recorderOwnerFor(userId),requestId,plan}),cache:'no-store',redirect:'error',
      signal:AbortSignal.timeout(20_000)
    });
    const body=await response.json().catch(()=>null);
    if(response.status===403&&body?.error==='checkout_owner_not_admitted')return fail('checkout_owner_not_admitted',403);
    if(response.status===409&&typeof body?.error==='string')return fail(body.error,409);
    if(response.status===503&&body?.error==='packs_unavailable')return fail('packs_unavailable',503);
    if(response.status!==201||typeof body?.url!=='string')return fail('checkout_unavailable',503);
    const url=new URL(body.url);
    if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com'||!url.pathname.startsWith('/c/pay/'))
      return fail('checkout_unavailable',503);
    return Response.json({url:url.toString()},{status:201,headers});
  }catch{return fail('checkout_unavailable',503);}
}
