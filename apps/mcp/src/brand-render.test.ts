import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {Recorder,type RecorderOptions} from './recorder.js';
import {openRecorderStore} from './store/open.js';
import {DesktopDeviceStore} from './store/desktop-devices.js';
import {DesktopUploadStore} from './store/desktop-uploads.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
/** Two captured sessions on two domains, rendered by the same recorder; the exporter config is what is under test. */
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'brand-render-')),owner=randomUUID();
 const db=await openRecorderStore(dir);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
 const device=new DesktopDeviceStore(db).register(owner,'Mac');
 const uploads=new DesktopUploadStore(db,dir);
 const ids:string[]=[];
 for(const origin of ['https://acme.example.com','https://globex.example.com']){
  const id=randomUUID();ids.push(id);
  const job={id,owner,status:'recording',createdAt:Date.now(),expiresAt:Date.now()+3600000,allowedOrigins:[origin],desktopDeviceId:device.deviceId,privacyMode:'user-approved-unredacted',rawFile:'raw.mp4'};
  db.connection.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(id,owner,job.status,job.createdAt,job.expiresAt,JSON.stringify(job));
  const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisomsynthetic capture '+origin)]);
  await uploads.begin(owner,device.deviceId,id,bytes.length,createHash('sha256').update(bytes).digest('hex'),{width:1280,height:720,durationMs:2500});
  await uploads.append(owner,device.deviceId,id,0,bytes);await uploads.complete(owner,device.deviceId,id);
 }
 db.close();
 const configs:Record<string,unknown>[]=[];
 const applyBrand=vi.fn(async(bytes:Buffer,brand:unknown)=>({bytes,applied:brand&&(brand as {logo?:string}).logo?['logo']:[]}));
 const makeGif=vi.fn(async(_video:string,gifPath:string)=>{await writeFile(gifPath,'GIF89a-fake');});
 const options:RecorderOptions={dataDir:dir,encryptionKey:randomBytes(32),createContext:vi.fn(),render:vi.fn(async(_p:string,config:Record<string,unknown>)=>{configs.push(config);return Buffer.from('rendered');}),
  assessQuality:async()=>({passed:true,reasons:[],metrics:{}}),applyBrand,makeGif,
  lifecycle:()=>({admit:vi.fn(),usage:()=>({}),delivered:vi.fn(),abandon:vi.fn(),beforeRender:vi.fn(),beforeAccountErase:async()=>{}})};
 const recorder=new Recorder(options);await recorder.initialize();
 cleanups.push(async()=>{await recorder.close();await rm(dir,{recursive:true,force:true});});
 for(const id of ids)await recorder.recoverDesktopUpload(owner,device.deviceId,id);
 return {dir,owner,ids,recorder,configs,applyBrand,makeGif};
}
const rendered=async(f:Awaited<ReturnType<typeof fixture>>,id:string,args:Record<string,unknown>={})=>{
 await f.recorder.call(f.owner,'recording_render',{id,requestId:randomUUID(),...args});
 let status:Record<string,unknown>={};
 await vi.waitFor(async()=>{status=(await f.recorder.call(f.owner,'recording_status',{id})).structuredContent as Record<string,unknown>;expect(status.status).toBe('completed');},{timeout:5000});
 return status;
};
it('renders two domains with their own brands from the same recorder, and only the branded one gets a logo and a GIF',async()=>{
 const f=await fixture();
 const logo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
 f.recorder.saveBrand(f.owner,'https://acme.example.com',{accent:'#ff8800',padding:30,logo,cards:true,gif:true,width:1920});
 f.recorder.saveBrand(f.owner,'*',{background:'ocean'});
 const acme=await rendered(f,f.ids[0]!),globex=await rendered(f,f.ids[1]!);
 const [acmeConfig,globexConfig]=f.configs.map(c=>JSON.stringify(c));
 expect(acmeConfig).toContain('#ff8800');expect(acmeConfig).not.toContain('#083344');
 expect(globexConfig).toContain('#083344');expect(globexConfig).not.toContain('#ff8800');
 expect(acme.branding).toEqual({applied:['logo'],brand:true,gif:true});
 expect(globex.branding).toEqual({applied:[],brand:true,gif:false});
 expect(f.makeGif).toHaveBeenCalledTimes(1);
 expect(await readFile(join(f.dir,'jobs',f.ids[0]!,'demo.gif'),'utf8')).toBe('GIF89a-fake');
 await expect(f.recorder.artifact(f.owner,f.ids[0]!,'gif')).resolves.toMatchObject({contentType:'image/gif'});
 await expect(f.recorder.artifact(f.owner,f.ids[1]!,'gif')).rejects.toThrow();
 // Explicit arguments still win over the saved brand.
 const override=await rendered(f,f.ids[1]!,{background:'sunset',gif:true});
 expect(JSON.stringify(f.configs[2])).toContain('#312e81');
 expect(override.branding).toMatchObject({gif:true});
});
it('honours the brand camera and pointer, and keeps a timeline of the delivered render without the logo',async()=>{
 const f=await fixture();
 const logo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
 f.recorder.saveBrand(f.owner,'https://acme.example.com',{logo,zoom:{enabled:false},cursor:{smooth:false}});
 await rendered(f,f.ids[0]!);
 expect(f.configs[0]!.zoomRegions).toEqual([]);
 const timeline=JSON.parse(await readFile(join(f.dir,'jobs',f.ids[0]!,'timeline.json'),'utf8'));
 expect(timeline).toMatchObject({version:1,introMs:0,outroMs:0,zoomRegions:[],cursor:{smooth:false},settings:{logo:true,zoom:{enabled:false}}});
 expect(JSON.stringify(timeline)).not.toContain('base64');
 await expect(f.recorder.artifact(f.owner,f.ids[0]!,'timeline')).resolves.toMatchObject({contentType:'application/json'});
 expect(()=>f.recorder.saveBrand(f.owner,'*',{zoom:{enabled:true,scale:4}})).toThrow();
});
