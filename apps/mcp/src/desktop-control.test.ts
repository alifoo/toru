import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {LocalBrowserBridge} from './local-browser.js';
import {openRecorderStore} from './store/open.js';

async function post(bridge:LocalBrowserBridge,path:string,value:unknown={},token?:string,appVersion?:string){
 const req=Readable.from([Buffer.from(JSON.stringify(value))]) as IncomingMessage;
 req.method='POST';req.headers={...(token?{authorization:`Bearer ${token}`}:{}),...(appVersion?{'x-toru-app-version':appVersion}:{})};
 const res=new EventEmitter() as ServerResponse;
 let status=0,body='';
 res.writeHead=((code:number)=>{status=code;return res;}) as ServerResponse['writeHead'];
 res.end=((chunk:string)=>{body=chunk;return res;}) as ServerResponse['end'];
 await bridge.http(req,res,new URL('https://mcp.toru.tools/local-browser/'+path));
 return {status,value:JSON.parse(body)};
}
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
const options={viewport:{width:1280,height:720},allowedOrigins:['https://toru.tools'],sessionState:Buffer.from('{}'),onNavigation:vi.fn(),allowDownload:false as const,allowPopup:false as const};
async function connected(control:boolean){
 const dir=await mkdtemp(join(tmpdir(),'toru-desktop-control-'));
 const db=await openRecorderStore(dir);
 db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run('owner',Date.now());db.close();
 const bridge=new LocalBrowserBridge(dir);
 cleanups.push(async()=>{bridge.close();await rm(dir,{recursive:true,force:true});});
 const pair=bridge.pair('owner','https://toru.tools',async()=>true,'desktop');
 const {value:credentials}=await post(bridge,'pair',{code:pair.pairingCode,persistent:true,deviceName:'Mac'});
 expect((await post(bridge,'ready',{captureConsent:true,control},credentials.accessToken)).status).toBe(200);
 await bridge.bindDesktop('owner',pair.connectionId,async()=>true);
 return {bridge,id:pair.connectionId,token:credentials.accessToken as string};
}

it('lets a Mac that allowed control answer page methods, and reports it',async()=>{
 const {bridge,id,token}=await connected(true);
 expect(bridge.status('owner',id)).toMatchObject({mode:'desktop',control:true});
 expect((await bridge.desktopDevices('owner'))[0]).toMatchObject({control:true,nextAction:'desktop_recording_run'});
 const driver=await bridge.createContext('owner',id,{...options,captureId:'00000000-0000-4000-8000-000000000001'});
 const read=driver.readPage({filter:'interactive'});
 const {value:{command}}=await post(bridge,'poll',{},token);
 expect(command).toMatchObject({method:'readPage',args:[{filter:'interactive'}]});
 await post(bridge,'result/'+command.id,{value:'[ref_1] button "Save" — visible at (10,10) window points',meta:{pointerTelemetry:[{atMs:5,x:0.5,y:0.5,kind:'move'}],identitySightings:[{atMs:5,rects:[{x:0.02,y:0.92,width:0.12,height:0.05}]}]}},token);
 expect(await read).toContain('button "Save"');
 expect(driver.pointerTelemetry?.()).toEqual([{atMs:5,x:0.5,y:0.5,kind:'move'}]);
 // Where the window showed the user's name travels with the cursor path, so the render can blur it.
 expect((driver as unknown as {identitySightings():unknown[]}).identitySightings()).toEqual([{atMs:5,rects:[{x:0.02,y:0.92,width:0.12,height:0.05}]}]);
 const click=driver.pointer('left_click',{type:'ref',ref:'ref_1'});
 const next=(await post(bridge,'poll',{},token)).value.command;
 expect(next.method).toBe('pointer');
 await post(bridge,'result/'+next.id,{value:null},token);
 await click;
});

it('keeps a capture-only Mac capture-only',async()=>{
 const {bridge,id}=await connected(false);
 expect(bridge.status('owner',id)).toMatchObject({mode:'desktop',control:false});
 expect((await bridge.desktopDevices('owner'))[0]).toMatchObject({control:false,nextAction:'desktop_recording_open'});
 const driver=await bridge.createContext('owner',id,options);
 await expect(driver.readPage({filter:'interactive'})).rejects.toThrow('desktop_capture_only');
 await expect(driver.typeText('hello')).rejects.toThrow('desktop_capture_only');
});

it('sends gestures only to a Mac app that draws them; an older one is never asked',async()=>{
 const {bridge,id,token}=await connected(true);
 const driver=await bridge.createContext('owner',id,{...options,captureId:'00000000-0000-4000-8000-000000000002'});
 const gesture=(driver as unknown as {gesture(kind:string,target:unknown):Promise<unknown>}).gesture.bind(driver);
 await post(bridge,'ready',{captureConsent:true,control:true},token,'0.4.4');
 await expect(gesture('circle',{type:'ref',ref:'ref_1'})).rejects.toThrow('local_method_forbidden');
 await post(bridge,'ready',{captureConsent:true,control:true},token,'0.4.5');
 const circled=gesture('circle',{type:'ref',ref:'ref_1'});
 const {value:{command}}=await post(bridge,'poll',{},token,'0.4.5');
 expect(command).toMatchObject({method:'gesture',args:['circle',{type:'ref',ref:'ref_1'}]});
 await post(bridge,'result/'+command.id,{value:null},token,'0.4.5');
 await circled;
});
