import {clerkMiddleware} from '@clerk/nextjs/server';
import {NextResponse} from 'next/server';
import {APP_HOST,APP_URL,SITE_HOST,SITE_URL} from './app/site';
import {plans} from './app/pricing/plans';
export default clerkMiddleware(async(_auth,request)=>{
 const url=request.nextUrl,host=url.hostname;
 if(host==='www.'+SITE_HOST)return NextResponse.redirect(new URL(url.pathname+url.search,SITE_URL),308);
 if(host===SITE_HOST&&/^\/sign-(in|up)(\/|$)/.test(url.pathname))return NextResponse.redirect(new URL(url.pathname+url.search,APP_URL));
 if(host===SITE_HOST&&url.pathname==='/'&&url.searchParams.has('billing'))return NextResponse.redirect(new URL('/'+url.search+'#settings',APP_URL));
 if(host===APP_HOST&&['/docs','/companion','/legal','/llms.txt','/sitemap.xml'].includes(url.pathname))return NextResponse.redirect(new URL(url.pathname+url.search,SITE_URL),308);
 if(url.pathname==='/.well-known/mcp/server-card.json')return NextResponse.json(SERVER_CARD,{headers:{'Access-Control-Allow-Origin':'*'}});
 if(url.pathname==='/.well-known/ard.json')return NextResponse.json({entries:[ARD_ENTRY],mcpServers:[{name:SERVER_CARD.name,url:MCP_URL,transport:'streamable-http',serverCard:SITE_URL+'/.well-known/mcp/server-card.json'}]},{headers:{'Access-Control-Allow-Origin':'*'}});
 if(host!==APP_HOST&&url.pathname==='/index.md')return new NextResponse(HOME_MARKDOWN,{headers:{'Content-Type':'text/markdown; charset=utf-8'}});
 if(url.pathname==='/pricing.md')return new NextResponse(PRICING_MARKDOWN,{headers:{'Content-Type':'text/markdown; charset=utf-8'}});
 if(request.headers.get('accept')?.includes('text/markdown')&&isMissingPage(url.pathname))return new NextResponse(
  `# Page not found\n\nThere is no page at \`${url.pathname}\` on Toru.\n\n- [Home](${SITE_URL}/)\n- [Docs](${SITE_URL}/docs)\n- [Sitemap](${SITE_URL}/sitemap.xml)\n- [llms.txt](${SITE_URL}/llms.txt)\n`,
  {status:404,headers:{'Content-Type':'text/markdown; charset=utf-8'}});
 const home=host!==APP_HOST&&url.pathname==='/';
 if(home&&request.headers.get('accept')?.includes('text/markdown'))return new NextResponse(HOME_MARKDOWN,{headers:{'Content-Type':'text/markdown; charset=utf-8','Vary':'Accept'}});
 const response=NextResponse.next();
 if(host===APP_HOST)response.headers.set('X-Robots-Tag','noindex, nofollow');
 if(home)response.headers.set('Vary',[response.headers.get('Vary'),'Accept'].filter(Boolean).join(', '));
 return response;
});
/** The homepage for agents that ask for Markdown, in the landing page's own words. */
const HOME_MARKDOWN=`# Recording infrastructure for your agent.

Your coding agent records your product demos itself: launch clips, changelog GIFs, help-center guides and bug repros. Toru is its camera, editor and brand kit, and checks every take.

10 free demos a month · No card required · Open source, MIT

## What your agent can record for you

- **Launch videos**: a polished walkthrough for Product Hunt, your landing page or the announcement post.
- **Changelog clips**: a short clip or GIF for every feature you merge, in the release notes the same day.
- **Help-center guides**: docs that show the real screen and stay current: run the same prompt again when the UI changes.
- **Sales and onboarding demos**: the exact flow a prospect asked about, without booking a screen share.
- **Bug reports**: a video of the bug on the issue, so whoever picks it up sees it before reading a line.
- **Social posts**: short clips for X and LinkedIn, cut tight and in your brand.

## Connected in five minutes

Works inside the agent you already use: Claude Code, Claude, Cursor, Codex and any MCP client. Pick your agent and paste the commands. Then pair [Toru for Chrome](${SITE_URL}/chrome) or [Toru for Mac](${SITE_URL}/mac) from the one link your agent sends you.

## Pay only for demos that pass

Free includes 10 credits each month. Creator costs US$19 per month for 50 credits and Studio US$49 per month for 150. A credit is used only when a video passes the check. [Compare the plans](${SITE_URL}/pricing).

## More

- [Start free](${APP_URL})
- [Docs](${SITE_URL}/docs)
- [llms.txt](${SITE_URL}/llms.txt)
`;
/** The pricing page for agents, built from the same plans as /pricing. */
const PRICING_MARKDOWN=`# Toru pricing

Recording infrastructure for your agent. Start free, upgrade when you need more. Prices in USD, billed monthly. 1 credit = 1 delivered video that passed the check.

${plans.map(plan=>`## ${plan.name}

- Price: US$${plan.price} per month (USD, billed monthly)
- ${plan.use}
- ${plan.credits} credits per month
- Up to ${plan.minutes} minutes per capture
- ${plan.days} days of MP4 storage
`).join('\n')}
## Included in every plan

- One-prompt demos
- Delivery check before charging
- Brand per product
- MP4 and GIF
- Sign-in without sharing passwords
- Claude, Cursor, Codex via MCP

Cancel renewal anytime. Paid plans include a [14-day refund policy](${SITE_URL}/terms#refunds). [Compare the plans](${SITE_URL}/pricing).
`;
/** The hosted MCP server, declared where agents look for it. Name and version match the recorder's `McpServer`. */
const MCP_URL=new URL('/mcp',process.env.NEXT_PUBLIC_RECORDER_URL??'https://mcp.toru.tools').href;
const SERVER_CARD={name:'toru',title:'Toru',version:'0.1.0',description:'Recording infrastructure for agents: records product flows in your own Chrome or on your Mac and returns an MP4 and a GIF.',websiteUrl:SITE_URL,remotes:[{type:'streamable-http',url:MCP_URL}]};
/** The same server as an agent catalog entry, with queries an agent would bring to it. */
const ARD_ENTRY={id:'urn:air:'+SITE_HOST+':mcp:toru',displayName:SERVER_CARD.title,type:'mcp',url:MCP_URL,description:SERVER_CARD.description,serverCard:SITE_URL+'/.well-known/mcp/server-card.json',representativeQueries:[
 'Record a demo video of this product flow',
 'Make a changelog GIF of the feature I just merged',
 'Record a bug repro video for this issue',
 'Record a walkthrough of my Mac app',
]};
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
