import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createRenderHost} from '@content-layer/render-host';

/** Runs only inside the disposable, network-disabled render container. */
export async function renderWorker(sourcePath:string,configPath:string,outputPath:string){
 const config=JSON.parse(await readFile(configPath,'utf8')) as Record<string,unknown>;
 const outcome=await createRenderHost({browserBinary:process.env.RENDER_BROWSER_BINARY??'/usr/bin/chromium',
  bundleDirectory:process.env.RENDER_BUNDLE_DIRECTORY??'/app/apps/render-worker/dist-web'}).render({
   sourcePath,config,timeoutMs:10*60_000,
  });
 if(outcome.status!=='rendered'){
  // The page's own reason goes to stderr, which the service logs as the failure's cause; no media or page text in it.
  if(!['render_timeout','render_canceled'].includes(outcome.reason))console.error(`render_failed: ${String(outcome.reason).replace(/\s+/g,' ').slice(0,300)}`);
  throw new Error(['render_timeout','render_canceled'].includes(outcome.reason)?outcome.reason:'render_failed');
 }
 if(!outcome.bytes.length||outcome.bytes.length>256*1024*1024)throw new Error('render_size_invalid');
 await writeFile(outputPath,outcome.bytes,{mode:0o600});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [source,config,output]=process.argv.slice(2);
 if(!source||!config||!output)throw new Error('render_worker_paths_required');
 renderWorker(source,config,output).catch(error=>{
  console.error(error instanceof Error?error.message:'render_failed');process.exitCode=1;
 });
}
