import type {MetadataRoute} from 'next';
import chromeJson from '../public/downloads/chrome.json';
import macJson from '../public/downloads/mac.json';
import {SITE_URL} from './site';
// lastModified only where the page shows a date the repository holds: the release dates in public/downloads and the effective date of the legal pages.
const LAST_MODIFIED:Record<string,string>={
  '/mac':macJson.latest.publishedAt.slice(0,10),
  '/chrome':chromeJson.publishedAt.slice(0,10),
  '/terms':'2026-10-11',
  '/privacy':'2026-10-11',
};
export default function sitemap():MetadataRoute.Sitemap{return ['','/pricing','/docs','/mac','/chrome','/terms','/privacy'].map(path=>({
  url:`${SITE_URL}${path}`,
  ...(LAST_MODIFIED[path]?{lastModified:LAST_MODIFIED[path]}:{}),
  changeFrequency:'monthly',
  priority:path===''?1:0.7,
}));}
