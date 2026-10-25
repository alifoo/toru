import {clerkMiddleware} from '@clerk/nextjs/server';
import {NextResponse} from 'next/server';
import {APP_HOST,APP_URL,SITE_HOST,SITE_URL} from './app/site';
export default clerkMiddleware(async(_auth,request)=>{
 const url=request.nextUrl,host=url.hostname;
 if(host==='www.'+SITE_HOST)return NextResponse.redirect(new URL(url.pathname+url.search,SITE_URL),308);
 if(host===SITE_HOST&&/^\/sign-(in|up)(\/|$)/.test(url.pathname))return NextResponse.redirect(new URL(url.pathname+url.search,APP_URL));
 if(host===SITE_HOST&&url.pathname==='/'&&url.searchParams.has('billing'))return NextResponse.redirect(new URL('/'+url.search+'#settings',APP_URL));
 if(host===APP_HOST&&['/docs','/companion','/legal','/llms.txt','/sitemap.xml'].includes(url.pathname))return NextResponse.redirect(new URL(url.pathname+url.search,SITE_URL),308);
 const response=NextResponse.next();
 if(host===APP_HOST)response.headers.set('X-Robots-Tag','noindex, nofollow');
 return response;
});
export const config={matcher:[
 '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|mjs|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
 '/(api|trpc)(.*)','/__clerk/(.*)',
]};
