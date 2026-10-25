/** The public site and the console. A self-hosted console sets both; the defaults are the hosted service's. The site
 * address must match the recorder's `TORU_SITE_URL`: it also names "the Mac" as a recording's target. */
const origin=(value:string|undefined,fallback:string)=>(value?.trim()||fallback).replace(/\/+$/,'');
export const SITE_URL=origin(process.env.NEXT_PUBLIC_SITE_URL,'https://toru.tools');
export const APP_URL=origin(process.env.NEXT_PUBLIC_APP_URL,'https://app.toru.tools');
export const SITE_HOST=new URL(SITE_URL).hostname;
export const APP_HOST=new URL(APP_URL).hostname;
export function isAppHost(host:string|null){
 const hostname=(host??'').split(':')[0]?.toLowerCase();
 return hostname===APP_HOST||hostname==='localhost'||hostname==='127.0.0.1';
}
