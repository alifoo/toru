import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(root,'apps/console/public/downloads');await mkdir(out,{recursive:true});
const result=await build({entryPoints:[resolve(root,'apps/mcp/src/companion.ts')],bundle:true,write:false,metafile:true,absWorkingDir:root,platform:'node',format:'esm',target:'node24',minify:true,legalComments:'eof',
 alias:{'@content-layer/browser':resolve(root,'packages/browser/src/index.ts'),'@content-layer/render-host':resolve(root,'packages/render-host/src/index.ts')},
 banner:{js:'// Toru companion. MIT license: https://toru.tools/downloads/LICENSE.txt'}});
const licenses=[await readFile(resolve(root,'apps/mcp/LICENSE'),'utf8')];
const dependencies=new Set(Object.keys(result.metafile.inputs).map(path=>path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1]).filter(Boolean));
for(const directory of [...dependencies].sort()){
 const pkg=JSON.parse(await readFile(resolve(root,directory,'package.json'),'utf8'));
 let license;
 for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','license']){try{license=await readFile(resolve(root,directory,file),'utf8');break;}catch{}}
 if(!license)throw new Error(`Missing bundled license for ${pkg.name}`);
 licenses.push(`${pkg.name} ${pkg.version}\n${license}`);
}
const notices=licenses.join('\n\n');
const code=Buffer.concat([Buffer.from(result.outputFiles[0].contents),Buffer.from('\n/*\n'+notices.replaceAll('*/','* /')+'\n*/\n')]);const sha256=createHash('sha256').update(code).digest('hex');
await writeFile(resolve(out,'toru-companion.mjs'),code);
await writeFile(resolve(out,'companion.json'),JSON.stringify({version:'0.1.0',sha256,bytes:code.length,url:'/downloads/toru-companion.mjs'})+'\n');
await writeFile(resolve(out,'LICENSE.txt'),notices);
console.log(`Companion bundle: ${code.length} bytes, sha256 ${sha256}`);
