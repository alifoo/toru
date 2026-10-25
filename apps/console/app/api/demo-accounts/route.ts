import { auth } from '@clerk/nextjs/server';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
const headers={'Cache-Control':'private, no-store'};
/** Saved logins for the signed-in user (password or e-mail only): list without secrets, save, or remove. Saved only here, never through an agent. */
async function handle(request:Request) {
  if(request.method!=='GET' && request.headers.get('origin')!==new URL(request.url).origin)
    return Response.json({error:'origin_forbidden'},{status:403,headers});
  const {userId}=await auth();
  if(!userId)return Response.json({error:'authentication_required'},{status:401,headers});
  const base=process.env.RECORDER_URL,key=process.env.RECORDER_ADMIN_KEY;
  if(!base||!key)return Response.json({error:'recorder_not_configured'},{status:503,headers});
  try {
    const url=new URL('/admin/demo-accounts',base);url.searchParams.set('owner',recorderOwnerFor(userId));
    let body:string|undefined;
    if(request.method==='POST'){
      const input=await request.json().catch(()=>null) as {url?:unknown;username?:unknown;password?:unknown;kind?:unknown;keepPassword?:unknown;demoAccountConfirmed?:unknown}|null;
      const kind=input?.kind==='email'?'email':'password';
      const keep=kind==='password'&&input?.keepPassword===true&&input.password===undefined;
      // An e-mail login stores no secret; a new stored password must be a demo account the user vouched for; editing may keep the current one.
      if(!input||typeof input.url!=='string'||typeof input.username!=='string'||(kind==='password'&&!keep&&(typeof input.password!=='string'||input.demoAccountConfirmed!==true)))
        return Response.json({error:'invalid_demo_account'},{status:400,headers});
      body=JSON.stringify(kind==='email'?{url:input.url,username:input.username,kind}:keep?{url:input.url,username:input.username,kind,keepPassword:true}:{url:input.url,username:input.username,password:input.password,kind,demoAccountConfirmed:true});
    }
    if(request.method==='DELETE'){
      const origin=new URL(request.url).searchParams.get('origin');
      if(!origin)return Response.json({error:'origin_required'},{status:400,headers});
      url.searchParams.set('origin',origin);
    }
    const response=await fetch(url,{method:request.method,headers:{authorization:`Bearer ${key}`,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    const result=await response.json().catch(()=>({})) as Record<string,unknown>;
    if(!response.ok)return Response.json({error:typeof result.error==='string'?result.error:'demo_accounts_unavailable'},{status:response.status===400?400:503,headers});
    if(request.method==='GET')return Response.json({accounts:Array.isArray(result.accounts)?result.accounts:[]},{headers});
    if(request.method==='POST')return Response.json({account:result.account},{headers});
    return Response.json({removed:result.removed===true},{headers});
  }catch{return Response.json({error:'demo_accounts_unavailable'},{status:503,headers});}
}
export const GET=handle;
export const POST=handle;
export const DELETE=handle;
