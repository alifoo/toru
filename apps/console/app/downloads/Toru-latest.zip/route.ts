import {macRelease} from '../../../lib/mac-release';
/** Stable URL for the newest published Mac build; 404 until a release is published. */
export function GET(request:Request) {
  const latest=macRelease().latest;
  if(!latest)return Response.json({error:'mac_release_unavailable'},{status:404,headers:{'Cache-Control':'no-store'}});
  return Response.redirect(new URL(latest.url,request.url),302);
}
