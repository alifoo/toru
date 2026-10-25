import {access,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Vercel deploys this app directory by itself. Local workspace builds regenerate
// the artifact; the isolated deployment verifies the checked-in standalone file.
const sourceBuild=new URL('../../../scripts/build-companion.mjs',import.meta.url);
let sourceAvailable=false;try{await access(sourceBuild);sourceAvailable=true;}catch{}
if(sourceAvailable)await import(sourceBuild.href);
const base=new URL('../public/downloads/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('companion.json',base),'utf8'));
const code=await readFile(new URL('toru-companion.mjs',base));
if(createHash('sha256').update(code).digest('hex')!==manifest.sha256)throw new Error('Companion bundle checksum mismatch. Run scripts/build-companion.mjs before deployment.');
console.log('Verified companion download artifact.');
