import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {captureSize,ExtensionBridge} from './extension-bridge.js';
import {withRecorderStore} from './store/open.js';
import {ExtensionDeviceStore} from './store/extension-devices.js';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
const extensionOrigin='chrome-extension://abcdefghijklmnopabcdefghijklmnop';
async function fixture(owners:string[]=[]){
 const dataDir=await mkdtemp(join(tmpdir(),'toru-extension-'));
 await withRecorderStore(dataDir,db=>{for(const owner of ['owner','other'])db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,0);});
 const bridge=new ExtensionBridge(dataDir,owners);
 const server=createServer((req,res)=>void bridge.http(req,res,new URL(req.url!,'http://localhost')));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const addr=server.address();if(!addr||typeof addr==='string')throw Error();
 const base=`http://127.0.0.1:${addr.port}`;
 closes.push(async()=>{bridge.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});});
 const post=(path:string,value:unknown={},token?:string,origin=extensionOrigin)=>fetch(base+'/extension/'+path,{method:'POST',
  headers:{'content-type':'application/json',origin,...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(value)});
 const context={viewport:{width:1920,height:1080},allowedOrigins:['https://app.example.com'],sessionState:Buffer.from('{}'),onNavigation:vi.fn(),allowDownload:false as const,allowPopup:false as const};
 const paired=async(owner='owner')=>{
  const {pairingCode}=bridge.pair(owner,async()=>true);
  return await (await post('pair',{code:pairingCode,deviceName:'Chrome on Mac'})).json() as {connectionId:string;accessToken:string;refreshToken:string};
 };
 return {bridge,base,post,context,paired,dataDir};
}

it('serves a connect page without scripts and pairs once, only from the extension',async()=>{
 const {bridge,base,post}=await fixture();
 const page=await fetch(base+'/extension/connect');
 expect(page.status).toBe(200);
 expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
 expect(await page.text()).toContain('toru-extension-status');
 const {pairingCode}=bridge.pair('owner',async()=>true);
 expect((await post('pair',{code:pairingCode},undefined,'https://evil.example')).status).toBe(403);
 const response=await post('pair',{code:pairingCode,deviceName:'Chrome'});
 expect(response.status).toBe(200);
 const credentials=await response.json();
 expect(credentials.connectionId).toBe(credentials.deviceId);
 expect((await post('pair',{code:pairingCode})).status).toBe(401);
 expect(await bridge.devices('owner')).toEqual([expect.objectContaining({connectionId:credentials.connectionId,name:'Chrome',status:'ready'})]);
 expect(await bridge.devices('other')).toEqual([]);
});

it('refuses pairing when MCP authorization was revoked or the account is outside the beta',async()=>{
 const {bridge,post}=await fixture(['owner']);
 const revoked=bridge.pair('owner',async()=>false);
 expect((await post('pair',{code:revoked.pairingCode})).status).toBe(401);
 const outside=bridge.pair('other',async()=>true);
 expect((await post('pair',{code:outside.pairingCode})).status).toBe(401);
 expect(bridge.allows('owner')).toBe(true);expect(bridge.allows('other')).toBe(false);
});

it('reads driver features the extension does not offer as absent instead of rejecting unobserved',async()=>{
 const {bridge,context,paired}=await fixture();
 const {connectionId}=await paired();
 const driver=await bridge.createContext('owner',connectionId,{...context,captureId:'job'}) as unknown as Record<string,unknown>;
 // Email sightings come from the extension's own reads; before any command they are simply empty.
 expect((driver.identitySightings as ()=>unknown[])()).toEqual([]);
 expect(driver.contentLayers).toBeUndefined();
 expect(driver.exportCookies).toBeUndefined();
 expect(typeof driver.pressKey).toBe('function');
 await (driver.dispose as ()=>Promise<void>)();
});

it('opens the product in a tab, relays commands once, uploads the video and frees the browser on dispose',async()=>{
 const {bridge,base,post,context,paired}=await fixture();
 const {connectionId,accessToken}=await paired();
 expect(bridge.owns(connectionId)).toBe(true);
 await expect(bridge.createContext('other',connectionId,context)).rejects.toThrow('local_browser_not_found');
 const driver=await bridge.createContext('owner',connectionId,{...context,captureId:'job'});
 await expect(bridge.createContext('owner',connectionId,context)).rejects.toThrow('local_browser_in_use');
 expect((await bridge.devices('owner'))[0]?.status).toBe('in_use');
 await expect(driver.exportStorageState()).rejects.toThrow('local_credentials_stay_local');

 const go=driver.goto('https://app.example.com/sheets');
 const open=await (await post('poll',{},accessToken)).json();
 // The page layout to record goes with it; an extension before 0.1.8 ignores it and reports the 1280x720 it used.
 expect(open.command).toEqual({id:expect.any(String),method:'open',args:[{url:'https://app.example.com/sheets',allowedOrigins:['https://app.example.com'],viewport:{width:context.viewport.width,height:context.viewport.height}}]});
 expect(await (await post('poll',{},accessToken)).json()).toEqual({command:null});
 await post('result/'+open.command.id,{value:'https://app.example.com/sheets',meta:{captureViewport:{width:1280,height:720}}},accessToken);
 await go;
 expect(context.onNavigation).toHaveBeenCalledWith('https://app.example.com/sheets',0);
 expect(driver.captureViewport).toEqual({width:1280,height:720});

 const typed=driver.typeText('Pipeline Q4');
 const {command}=await (await post('poll',{},accessToken)).json();
 expect(command).toMatchObject({method:'typeText',args:['Pipeline Q4']});
 await post('result/'+command.id,{value:null,meta:{recordingMode:'screencast',recordingElapsedMs:900}},accessToken);
 await typed;
 expect(driver.recordingMode).toBe('screencast');
 expect((await post('result/'+command.id,{value:null},accessToken)).status).toBe(409);

 const stop=driver.stopRecording();
 const capture=await (await post('poll',{},accessToken)).json();
 const bytes=Buffer.from('webm bytes');
 expect((await fetch(`${base}/extension/result/${capture.command.id}/video`,{method:'POST',headers:{authorization:`Bearer ${accessToken}`,origin:extensionOrigin},body:bytes})).status).toBe(200);
 await post('result/'+capture.command.id,{value:{kind:'video',body:'local_video_upload',contentType:'video/webm',redactionPassed:true},meta:{recordingElapsedMs:4200,captureViewport:{width:1280,height:720},captureSize:{width:2560,height:1440},pointerTrail:[{x:1,y:2}],identitySightings:[{atMs:10,rects:[{x:0.5,y:0.3,width:0.2,height:0.02}]}]}},accessToken);
 const video=await stop;
 expect(video.body).toEqual(bytes);
 expect(driver.recordingDurationMs).toBe(4200);
 // The 1280x720 viewport recorded at 2x: coordinates stay CSS pixels, the video is twice as dense.
 expect(driver.captureViewport).toEqual({width:1280,height:720});
 expect((driver as unknown as {captureSize:unknown}).captureSize).toEqual({width:2560,height:1440});
 expect(driver.pointerTrail?.()).toEqual([{x:1,y:2}]);
 expect(driver.identitySightings?.()).toEqual([{atMs:10,rects:[{x:0.5,y:0.3,width:0.2,height:0.02}]}]);

 const failed=expect(driver.pageText()).rejects.toThrow('local_sign_in_required');
 const pageCommand=await (await post('poll',{},accessToken)).json();
 await post('result/'+pageCommand.command.id,{error:'local_sign_in_required'},accessToken);
 await failed;

 const disposed=driver.dispose();
 const disposal=await (await post('poll',{},accessToken)).json();
 expect(disposal.command.method).toBe('dispose');
 await post('result/'+disposal.command.id,{value:null},accessToken);
 await disposed;
 expect((await bridge.devices('owner'))[0]?.status).toBe('ready');
 // The same Chrome records again without pairing.
 const next=await bridge.createContext('owner',connectionId,context);
 await next.dispose();
});

it('refuses a different product on open, unknown methods and stale tokens',async()=>{
 const {bridge,post,context,paired}=await fixture();
 const {connectionId,accessToken,refreshToken}=await paired();
 const driver=await bridge.createContext('owner',connectionId,context);
 await expect(driver.goto('https://other.example.org/')).rejects.toThrow('local_browser_product_mismatch');
 await expect((driver as unknown as {listSources():Promise<unknown>}).listSources()).rejects.toThrow('local_method_forbidden');
 const renewed=await (await post('refresh',{refreshToken})).json();
 expect(renewed.deviceId).toBe(connectionId);
 // A second refresh with the replaced token, as two calls renewing at once do, still renews during its short grace.
 const again=await (await post('refresh',{refreshToken})).json();
 expect(again.deviceId).toBe(connectionId);
 expect((await post('poll',{},accessToken)).status).toBe(401);
 expect((await post('status',{},renewed.accessToken)).status).toBe(401);
 expect((await post('status',{},again.accessToken)).status).toBe(200);
});

it('opens a development server on the user\'s machine only on the product\'s exact origin',async()=>{
 const {bridge,post,context,paired}=await fixture();
 const {connectionId,accessToken}=await paired();
 const local={...context,allowedOrigins:['http://localhost:3000'],onNavigation:vi.fn()};
 for(const url of ['http://localhost:3001/','http://127.0.0.1:3000/','http://app.localhost:3000/','https://app.example.com/']){
  const driver=await bridge.createContext('owner',connectionId,local);
  await expect(driver.goto(url),url).rejects.toThrow('local_browser_product_mismatch');
  await driver.dispose();
 }
 const driver=await bridge.createContext('owner',connectionId,local);
 const go=driver.goto('http://localhost:3000/dashboard');
 const open=await (await post('poll',{},accessToken)).json();
 expect(open.command).toMatchObject({method:'open',args:[{url:'http://localhost:3000/dashboard',allowedOrigins:['http://localhost:3000']}]});
 await post('result/'+open.command.id,{value:'http://localhost:3000/dashboard'},accessToken);
 await go;
 expect(local.onNavigation).toHaveBeenLastCalledWith('http://localhost:3000/dashboard',0);
 const disposed=driver.dispose();
 const disposal=await (await post('poll',{},accessToken)).json();
 await post('result/'+disposal.command.id,{value:null},accessToken);
 await disposed;
});

it('revoking a paired Chrome ends its recording and its credentials',async()=>{
 const {bridge,post,context,paired,dataDir}=await fixture();
 const {connectionId,accessToken}=await paired();
 const driver=await bridge.createContext('owner',connectionId,context);
 const onDisconnect=vi.fn();
 (driver as unknown as {onDisconnect(callback:()=>void):void}).onDisconnect(onDisconnect);
 const pending=driver.pageText();
 const rejected=expect(pending).rejects.toThrow('extension_disconnected');
 expect(await bridge.revoke('other',connectionId)).toBe(false);
 expect(await bridge.revoke('owner',connectionId)).toBe(true);
 await rejected;
 expect(onDisconnect).toHaveBeenCalledOnce();
 expect((await post('poll',{},accessToken)).status).toBe(401);
 expect(await withRecorderStore(dataDir,db=>new ExtensionDeviceStore(db).list('owner'))).toEqual([]);
});

it('marks an extension offline when it stops polling',async()=>{
 const {bridge,context,paired}=await fixture();
 const {connectionId}=await paired();
 const now=Date.now();
 const clock=vi.spyOn(Date,'now').mockReturnValue(now+60_000);
 try{
  expect((await bridge.devices('owner'))[0]?.status).toBe('offline');
  await expect(bridge.createContext('owner',connectionId,context)).rejects.toThrow('extension_offline');
 }finally{clock.mockRestore();}
});

it('accepts only an even, encodable video size from the extension',()=>{
 expect(captureSize({width:2560,height:1440})).toEqual({width:2560,height:1440});
 expect(captureSize({width:1920,height:1080})).toEqual({width:1920,height:1080});
 for(const bad of [undefined,null,'2560x1440',{width:2561,height:1440},{width:2560.5,height:1440},{width:7680,height:4320},{width:320,height:180},{width:'2560',height:1440}])expect(captureSize(bad)).toBeUndefined();
});
