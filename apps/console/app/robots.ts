import type {MetadataRoute} from 'next';
import {headers} from 'next/headers';
import {isAppHost,SITE_URL} from './site';
export default async function robots():Promise<MetadataRoute.Robots>{
 if(isAppHost((await headers()).get('host')))return {rules:{userAgent:'*',disallow:'/'}};
 return {rules:{userAgent:'*',allow:'/',disallow:['/api/','/__clerk/']},sitemap:`${SITE_URL}/sitemap.xml`,host:SITE_URL};
}
