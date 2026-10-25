import type {MetadataRoute} from 'next';
import {SITE_URL} from './site';
export default function sitemap():MetadataRoute.Sitemap{return ['','/pricing','/docs','/mac','/chrome','/terms','/privacy'].map(path=>({url:`${SITE_URL}${path}`,changeFrequency:'monthly',priority:path?0.7:1}));}
