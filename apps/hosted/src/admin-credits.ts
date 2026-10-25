import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {CreditLedger} from '@agent-recorder/hosted-policy';

const ownerId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function answer(res:ServerResponse,status:number,body:Record<string,unknown>){
  res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store'});
  res.end(JSON.stringify(body));
}

/** Operator credit grants (support, testing). Same admin key as the other /admin routes; idempotent per grantId. */
export function createAdminCreditsHandler(dataDir:string,adminKey:string){
  return async(request:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(url.pathname!=='/admin/credits/grant')return false;
    const provided=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7).trim():'';
    const left=Buffer.from(provided),right=Buffer.from(adminKey);
    if(!provided||left.length!==right.length||!timingSafeEqual(left,right)){answer(res,404,{error:'not_found'});return true;}
    if(request.method!=='POST'){answer(res,405,{error:'method_not_allowed'});return true;}
    if(request.headers.origin!==undefined&&request.headers.origin!==url.origin){answer(res,403,{error:'origin_forbidden'});return true;}
    if(request.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){answer(res,415,{error:'json_required'});return true;}
    let raw='';
    try{for await(const chunk of request){raw+=chunk.toString();if(Buffer.byteLength(raw)>512)throw new Error();}}
    catch{answer(res,413,{error:'body_too_large'});return true;}
    let input:Record<string,unknown>;
    try{const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();input=parsed;}
    catch{answer(res,400,{error:'invalid_body'});return true;}
    const {owner,credits,grantId}=input;
    if(typeof owner!=='string'||!ownerId.test(owner)||typeof credits!=='number'||typeof grantId!=='string'){answer(res,400,{error:'invalid_body'});return true;}
    try{
      const grant=await withRecorderStore(dataDir,db=>new CreditLedger(db).grantAdmin(owner,credits,grantId));
      answer(res,grant.alreadyGranted?200:201,grant);
    }catch(error){
      const code=error instanceof Error&&['admin_grant_invalid','admin_grant_conflict','account_not_found'].includes(error.message)?error.message:'admin_grant_failed';
      answer(res,code==='account_not_found'?404:code==='admin_grant_failed'?500:400,{error:code});
    }
    return true;
  };
}
