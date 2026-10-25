#!/usr/bin/env node
// Stage a notarized Toru-<version>.zip (from apps/macos/notarize.sh) as a downloadable release.
// Usage: node scripts/publish-mac-release.mjs apps/macos/build/release/Toru-0.2.0.zip --build 7 [--not-notarized] --notes "First beta" --notes "Fixes"
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=process.env.TORU_RELEASE_ROOT??fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
const zip=args.find(a=>!a.startsWith('--'));
if(!zip)throw new Error('usage: publish-mac-release.mjs <Toru-<version>.zip> [--build N] [--notes "…"]…');
const version=basename(zip).match(/^Toru-([0-9][0-9.]*)\.zip$/)?.[1];
if(!version)throw new Error('archive must be named Toru-<version>.zip');
const option=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const notes=args.flatMap((a,i)=>a==='--notes'&&args[i+1]?[args[i+1]]:[]);
const bytes=await readFile(zip);
const sha256=createHash('sha256').update(bytes).digest('hex');
const expected=(await readFile(zip+'.sha256','utf8').catch(()=>'')).trim().split(/\s+/)[0];
if(expected&&expected!==sha256)throw new Error('checksum sidecar does not match the archive');
const out=resolve(root,'apps/console/public/downloads/mac');await mkdir(out,{recursive:true});
await copyFile(zip,resolve(out,`Toru-${version}.zip`));
const manifestPath=resolve(root,'apps/console/public/downloads/mac.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const edSignature=option('--ed-signature');
if(!edSignature)console.warn('No --ed-signature given: the appcast item carries no Sparkle EdDSA signature, so embedded updaters will refuse it (manual download still works).');
// --not-notarized: a beta signed without a Developer ID; the pages explain the one-time Open Anyway for zip downloads.
const release={version,build:option('--build')??'1',sha256,bytes:bytes.length,url:`/downloads/mac/Toru-${version}.zip`,publishedAt:new Date().toISOString(),...(args.includes('--not-notarized')?{notarized:false}:{}),notes,...(edSignature?{edSignature}:{})};
manifest.releases=[release,...(manifest.releases??[]).filter(r=>r.version!==version)];
manifest.latest=release;
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
// Sparkle appcast. --ed-signature comes from Sparkle's `sign_update Toru-<version>.zip` run with the private EdDSA key (never committed).
const escape=(s)=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const items=manifest.releases.map(r=>`  <item>
   <title>Toru ${escape(r.version)}</title>
   <pubDate>${new Date(r.publishedAt).toUTCString()}</pubDate>
   <sparkle:version>${escape(r.build)}</sparkle:version>
   <sparkle:shortVersionString>${escape(r.version)}</sparkle:shortVersionString>
   <sparkle:minimumSystemVersion>${escape(manifest.minimumMacOS??'15.0')}</sparkle:minimumSystemVersion>
${manifest.channel&&manifest.channel!=='stable'?`   <sparkle:channel>${escape(manifest.channel)}</sparkle:channel>\n`:''}   <description><![CDATA[<ul>${(r.notes??[]).map(n=>`<li>${escape(n)}</li>`).join('')}</ul>]]></description>
   <enclosure url="https://toru.tools${r.url}" length="${r.bytes}" type="application/octet-stream"${r.edSignature?` sparkle:edSignature="${escape(r.edSignature)}"`:''}/>
  </item>`).join('\n');
await writeFile(resolve(root,'apps/console/public/downloads/appcast.xml'),`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
 <channel>
  <title>Toru for Mac</title>
  <link>https://toru.tools/mac</link>
${items}
 </channel>
</rss>
`);
// Homebrew: the cask in github.com/alifoo/homebrew-toru pins version and checksum. With TORU_TAP_DIR set to a clone of
// that repo, it is rewritten here; commit and push it after the console is deployed (the cask downloads from toru.tools).
const tap=process.env.TORU_TAP_DIR;
if(tap){
 const caskPath=resolve(tap,'Casks/toru.rb');
 const cask=(await readFile(caskPath,'utf8')).replace(/version "[^"]*"/,`version "${version}"`).replace(/sha256 "[0-9a-f]{64}"/,`sha256 "${sha256}"`);
 await writeFile(caskPath,cask);
 console.log(`Updated ${caskPath} to ${version}.`);
}else console.warn('TORU_TAP_DIR not set: update version and sha256 in github.com/alifoo/homebrew-toru Casks/toru.rb by hand.');
console.log(`Staged Toru ${version} (${bytes.length} bytes, sha256 ${sha256}). Commit apps/console/public/downloads and deploy the console to publish.`);
