import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdir,mkdtemp,rename,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveBrowserBinary} from '@content-layer/render-host';
const exec=promisify(execFile);
export async function companionDependencies(log:(message:string)=>void=console.log){
 if(!['darwin','linux'].includes(process.platform))throw new Error('Toru companion currently supports macOS and Linux.');
 if(Number(process.versions.node.split('.')[0])<24)throw new Error('Toru requires Node.js 24 or newer: https://nodejs.org');
 try{await exec('ffmpeg',['-version'],{timeout:10000});}catch{throw new Error('Install ffmpeg first (macOS: brew install ffmpeg; Ubuntu/Debian: sudo apt install ffmpeg). Then run Toru again.');}
 const chrome=await resolveBrowserBinary();
 if(process.env.CHROMEDRIVER_BINARY)return {chrome,driver:process.env.CHROMEDRIVER_BINARY};
 try{await exec('chromedriver',['--version'],{timeout:10000});return {chrome,driver:'chromedriver'};}catch{/* Download an official matching driver. */}
 const {stdout}=await exec(chrome,['--version'],{timeout:10000});
 const version=stdout.match(/\b(\d+\.\d+\.\d+)\.\d+\b/)?.[1];
 if(!version)throw new Error('Cannot detect Chrome version. Set CHROMEDRIVER_BINARY to a matching ChromeDriver.');
 const platform=process.platform==='darwin'?(process.arch==='arm64'?'mac-arm64':'mac-x64'):(process.arch==='arm64'?'linux-arm64':'linux64');
 if(!['arm64','x64'].includes(process.arch))throw new Error('Unsupported CPU architecture');
 const root=join(homedir(),'.cache','toru','chromedriver',version,platform);
 const driver=join(root,`chromedriver-${platform}`,'chromedriver');
 try{await access(driver,constants.X_OK);return {chrome,driver};}catch{/* First run */}
 log('Downloading the ChromeDriver matching your Chrome from Google…');
 const response=await fetch('https://googlechromelabs.github.io/chrome-for-testing/latest-patch-versions-per-build-with-downloads.json',{signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('ChromeDriver version lookup failed. Try again or set CHROMEDRIVER_BINARY.');
 const manifest=await response.json() as {builds:Record<string,{downloads?:{chromedriver?:Array<{platform:string;url:string}>}}>};
 const asset=manifest.builds[version]?.downloads?.chromedriver?.find(item=>item.platform===platform);
 if(!asset)throw new Error('No matching ChromeDriver available yet. Update Chrome or set CHROMEDRIVER_BINARY.');
 const url=new URL(asset.url);
 if(url.protocol!=='https:'||url.hostname!=='storage.googleapis.com'||!url.pathname.startsWith('/chrome-for-testing-public/'))throw new Error('Invalid ChromeDriver download origin');
 const temporary=await mkdtemp(join(tmpdir(),'toru-driver-'));
 try{
  const download=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!download.ok)throw new Error('ChromeDriver download failed');
  const data=Buffer.from(await download.arrayBuffer());if(data.length>50*1024*1024)throw new Error('ChromeDriver download too large');
  const zip=join(temporary,'driver.zip');await writeFile(zip,data);
  await exec('unzip',['-q',zip,'-d',temporary],{timeout:30000});
  await mkdir(root,{recursive:true,mode:0o700});
  await rename(join(temporary,`chromedriver-${platform}`),join(root,`chromedriver-${platform}`)).catch(async error=>{try{await access(driver,constants.X_OK);}catch{throw error;}});
  await access(driver,constants.X_OK);return {chrome,driver};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
