import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { CtaTracking } from "./cta-tracking";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader, Noto_Serif_JP } from "next/font/google";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
 metadataBase:new URL('https://toru.tools'),title:'Let your agent record anything · Toru',description:'Your AI agent records any flow in your own Chrome or on your Mac. Ask Claude Code, Claude, Cursor or Codex for a demo; it is recorded in your own Chrome or on your Mac while you ship.',
 openGraph:{type:'website',siteName:'Toru',title:'Toru — Let your agent record anything',description:'Your agent records anything you can open: launch videos, bug repros, changelog clips, onboarding walkthroughs. Described once, done while you ship.',images:[{url:'/og.png',width:1200,height:630,alt:'Toru: your agent records your product demos, shown beside a Toru recording of Linear'}]},
 twitter:{card:'summary_large_image',title:'Toru — Let your agent record anything',description:'Demos, bug repros, changelog GIFs and how-tos, recorded by your agent in your own Chrome or on your Mac.',images:['/og.png']},
 robots:{index:true,follow:true,'max-image-preview':'large'},
};

const serif=Newsreader({subsets:["latin"],style:["normal","italic"],display:"swap",variable:"--font-newsreader"});
const sans=IBM_Plex_Sans({subsets:["latin"],weight:["400","500"],display:"swap",variable:"--font-plex"});
const mono=IBM_Plex_Mono({subsets:["latin"],weight:["400","500"],display:"swap",variable:"--font-plex-mono"});
const mincho=Noto_Serif_JP({subsets:["latin"],weight:["400"],display:"swap",preload:false,variable:"--font-mincho"});

export default function RootLayout({ children }: { children: ReactNode }) {
  // Vercel Web Analytics: cookieless page views, referrers and the CTA clicks tracked in cta-tracking.tsx.
  return <ClerkProvider><html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable} ${mincho.variable}`}><body>{children}<Analytics /><CtaTracking /></body></html></ClerkProvider>;
}
