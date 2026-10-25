import manifest from '../public/downloads/mac.json';
export type MacRelease={version:string;build:string;sha256:string;bytes:number;url:string;publishedAt:string;notes:string[];
 /** False while builds are not yet notarized by Apple: the page explains how to open them. */
 notarized?:boolean};
export type MacManifest={channel:string;minimumMacOS:string;latest:MacRelease|null;releases:MacRelease[]};
const pattern={version:/^[0-9]+(\.[0-9]+){1,3}$/,sha256:/^[a-f0-9]{64}$/,url:/^\/downloads\/mac\/Toru-[0-9][0-9.]*\.zip$/};
/** Only a well-formed, same-origin release is ever offered as "latest"; anything else reads as unavailable. */
export function macRelease(input:unknown=manifest):MacManifest {
  const value=(input??{}) as Partial<MacManifest>;
  const valid=(release:unknown):release is MacRelease=>{
    const r=release as Partial<MacRelease>|null;
    return Boolean(r&&typeof r.version==='string'&&pattern.version.test(r.version)&&typeof r.sha256==='string'&&pattern.sha256.test(r.sha256)
      &&typeof r.url==='string'&&pattern.url.test(r.url)&&Number.isInteger(r.bytes)&&(r.bytes as number)>0&&typeof r.publishedAt==='string'&&Array.isArray(r.notes));
  };
  const releases=Array.isArray(value.releases)?value.releases.filter(valid):[];
  return {channel:typeof value.channel==='string'?value.channel:'beta',minimumMacOS:typeof value.minimumMacOS==='string'?value.minimumMacOS:'15.0',
    latest:valid(value.latest)?value.latest:null,releases};
}
