import {headers} from 'next/headers';
import type {Metadata} from 'next';
import AccountConsole from './account-console';
import {PublicLanding} from './public-landing';
import {isAppHost,SITE_URL} from './site';
export async function generateMetadata():Promise<Metadata>{
 const app=isAppHost((await headers()).get('host'));
 return app?{title:'Demos · Toru',robots:{index:false,follow:false},alternates:{canonical:'https://app.toru.tools'}}:{
  title:'Let your agent record anything · Toru',
  description:'Your AI agent records any flow in your own Chrome or on your Mac: launch demos, bug repros, changelog GIFs and how-tos, in your brand. 10 free videos a month.',
  alternates:{canonical:SITE_URL},
 };
}
export default async function HomePage(){
 return isAppHost((await headers()).get('host'))?<AccountConsole/>:<PublicLanding/>;
}
