import {clerkMiddleware} from '@clerk/nextjs/server';
import {NextResponse} from 'next/server';
import {APP_HOST,APP_URL,SITE_HOST,SITE_URL} from './app/site';
export default clerkMiddleware(async(_auth,request)=>{
 const url=request.nextUrl,host=url.hostname;
 if(host==='www.'+SITE_HOST)return NextResponse.redirect(new URL(url.pathname+url.search,SITE_URL),308);
 if(host===SITE_HOST&&/^\/sign-(in|up)(\/|$)/.test(url.pathname))return NextResponse.redirect(new URL(url.pathname+url.search,APP_URL));
 if(host===SITE_HOST&&url.pathname==='/'&&url.searchParams.has('billing'))return NextResponse.redirect(new URL('/'+url.search+'#settings',APP_URL));
 if(host===APP_HOST&&['/docs','/companion','/legal','/llms.txt','/sitemap.xml'].includes(url.pathname))return NextResponse.redirect(new URL(url.pathname+url.search,SITE_URL),308);
 if(url.pathname==='/.well-known/mcp/server-card.json')return NextResponse.json(SERVER_CARD,{headers:{'Access-Control-Allow-Origin':'*'}});
 if(url.pathname==='/.well-known/ard.json')return NextResponse.json({mcpServers:[{name:SERVER_CARD.name,url:MCP_URL,transport:'streamable-http',serverCard:SITE_URL+'/.well-known/mcp/server-card.json'}]},{headers:{'Access-Control-Allow-Origin':'*'}});
 if(request.headers.get('accept')?.includes('text/markdown')&&isMissingPage(url.pathname))return new NextResponse(
  `# Page not found\n\nThere is no page at \`${url.pathname}\` on Toru.\n\n- [Home](${SITE_URL}/)\n- [Docs](${SITE_URL}/docs)\n- [Sitemap](${SITE_URL}/sitemap.xml)\n- [llms.txt](${SITE_URL}/llms.txt)\n`,
  {status:404,headers:{'Content-Type':'text/markdown; charset=utf-8'}});
 const response=NextResponse.next();
 if(host===APP_HOST)response.headers.set('X-Robots-Tag','noindex, nofollow');
 return response;
});
/** The hosted MCP server, declared where agents look for it. Name and version match the recorder's `McpServer`. */
const MCP_URL=new URL('/mcp',process.env.NEXT_PUBLIC_RECORDER_URL??'https://mcp.toru.tools').href;
const SERVER_CARD={name:'toru',title:'Toru',version:'0.1.0',description:'Recording infrastructure for agents: records product flows in your own Chrome or on your Mac and returns an MP4 and a GIF.',websiteUrl:SITE_URL,remotes:[{type:'streamable-http',url:MCP_URL}]};
/** Routes the app serves; files (a dot in the last segment), APIs and auth pages fall through to Next. */
const PAGES=['/','/chrome','/companion','/docs','/legal','/mac','/mac/setup','/onboarding','/pricing','/privacy','/terms','/studio-preview','/studio-preview/landing','/studio-preview/onboarding'];
function isMissingPage(pathname:string){
 const path=pathname.replace(/(.)\/+$/,'$1');
 return !PAGES.includes(path)&&!/\.[^/]*$/.test(path)&&!/^\/(api|trpc|__clerk|downloads|sign-in|sign-up)(\/|$)/.test(path);
}
export const config={matcher:[
 '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|mjs|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
 '/(api|trpc)(.*)','/__clerk/(.*)',
]};
