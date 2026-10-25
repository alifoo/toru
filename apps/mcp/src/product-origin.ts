import { getDomain } from 'tldts';

/** Product subdomains share a site; hosted tenants (foo.vercel.app) do not. */
export function sameProductSite(target:string,product:string):boolean {
  const to=new URL(target),from=new URL(product);
  if(to.protocol!=='https:' || from.protocol!=='https:' || to.username || to.password || to.port || from.port)return false;
  const domain=getDomain(from.hostname,{allowPrivateDomains:true});
  return Boolean(domain && domain===getDomain(to.hostname,{allowPrivateDomains:true}));
}
