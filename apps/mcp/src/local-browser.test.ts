import {createServer} from 'node:http';
import {afterEach,expect,it,vi} from 'vitest';
import {LocalBrowserBridge} from './local-browser.js';
import {companionServer} from './companion.js';
import {encodeLocal,decodeLocal,assertLocalCommand} from './local-protocol.js';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.useRealTimers();for(const close of closes.splice(0))await close();});
async function fixture(){
 const bridge=new LocalBrowserBridge();
 const server=createServer((req,res)=>void bridge.http(req,res,new URL(req.url!,'http://localhost')));
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});}).catch(error=>{bridge.close();throw error;});const addr=server.address();if(!addr||typeof addr==='string')throw Error();
 const base=`http://127.0.0.1:${addr.port}`;
 closes.push(async()=>{bridge.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const post=async(path:string,value:unknown={},token?:string,headers:Record<string,string>={})=>fetch(base+'/local-browser/'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} :{}),...headers},body:JSON.stringify(value)});
 const context={viewport:{width:1920,height:1080},allowedOrigins:['https://app.example.com'],sessionState:Buffer.from('{}'),onNavigation:vi.fn(),allowDownload:false as const,allowPopup:false as const};
 return {bridge,post,base,context};
}
it('binds one-use pairing to its owner and requires explicit local consent',async()=>{
 const {bridge,post,context}=await fixture();const pair=bridge.pair('owner','https://app.example.com',async()=>true);
 expect(()=>bridge.status('other',pair.connectionId)).toThrow('local_browser_not_found');
 expect((await post('pair',{code:pair.pairingCode},undefined,{origin:'https://evil.example'})).status).toBe(403);
 const paired=await (await post('pair',{code:pair.pairingCode})).json();
 expect((await post('pair',{code:pair.pairingCode})).status).toBe(401);
 expect((await post('poll',{},paired.token)).status).toBe(409);
 await expect(bridge.createContext('owner',pair.connectionId,context)).rejects.toThrow('local_browser_sign_in_pending');
 await post('ready',{},paired.token);
 expect(bridge.status('owner',pair.connectionId).status).toBe('ready');
 await expect(bridge.createContext('owner',pair.connectionId,{...context,allowedOrigins:['https://another.com']})).rejects.toThrow('local_browser_product_mismatch');
 await bridge.createContext('owner',pair.connectionId,context);
 await expect(bridge.createContext('owner',pair.connectionId,context)).rejects.toThrow('local_browser_in_use');
});
it('passes observations and binary capture, forbids secrets and never replays an action',async()=>{
 const {bridge,post,base,context}=await fixture();const pair=bridge.pair('owner','https://app.example.com',async()=>true);
 const {token}=await (await post('pair',{code:pair.pairingCode})).json();await post('ready',{},token);
 const driver=await bridge.createContext('owner',pair.connectionId,context);
 await expect(driver.exportStorageState()).rejects.toThrow('local_credentials_stay_local');
 // Opening preserves the locally authenticated route instead of reloading login.
 const go=driver.goto('https://app.example.com');
 const first=await (await post('poll',{},token)).json();expect(first.command.method).toBe('currentUrl');
 await post('result/'+first.command.id,{value:'https://app.example.com/dashboard'},token);await go;
 const action=driver.typeText('Demo item');const {command}=await (await post('poll',{},token)).json();
 expect(command.method).toBe('typeText');expect(command.args).toEqual(['Demo item']);
 expect(await (await post('poll',{},token)).json()).toEqual({command:null});
 await post('result/'+command.id,{value:null,meta:{recordingMode:'screencast',recordingElapsedMs:1000}},token);await action;
 expect(driver.recordingMode).toBe('screencast');
 expect((await post('result/'+command.id,{},token)).status).toBe(409);
 const stop=driver.stopRecording();const capture=await (await post('poll',{},token)).json();
 const bytes=Buffer.from('video data');
 expect((await fetch(base+'/local-browser/result/'+capture.command.id+'/video',{method:'POST',headers:{authorization:`Bearer ${token}`},body:bytes})).status).toBe(200);
 await post('result/'+capture.command.id,{value:{body:'local_video_upload',contentType:'video/webm'},meta:{pointerTrail:[{x:1,y:2}]}},token);
 expect((await stop).body).toEqual(bytes);expect(driver.pointerTrail?.()).toEqual([{x:1,y:2}]);
 const read=driver.pageText();const failure=expect(read).rejects.toThrow('local_browser_disconnected');
 await post('disconnect',{},token);await failure;
 expect((await post('poll',{},token)).status).toBe(401);
});
it('expires pairing and revokes active sessions when MCP authorization is removed',async()=>{
 const {bridge,post,context}=await fixture();let allowed=true;const pair=bridge.pair('owner','https://app.example.com',async()=>allowed);
 const {token}=await (await post('pair',{code:pair.pairingCode})).json();await post('ready',{},token);
 const driver=await bridge.createContext('owner',pair.connectionId,context);
 const pending=driver.pageText();const rejected=expect(pending).rejects.toThrow('local_browser_disconnected');
 allowed=false;expect((await post('poll',{},token)).status).toBe(401);await rejected;
 const expires=bridge.pair('owner','https://app.example.com',async()=>true);vi.spyOn(Date,'now').mockReturnValue(Date.now()+6*60000);
 expect((await post('pair',{code:expires.pairingCode})).status).toBe(401);vi.restoreAllMocks();
});
it('bounds the companion endpoint and encodes binary without exporting other capabilities',()=>{
 expect(companionServer('https://mcp.toru.tools').origin).toBe('https://mcp.toru.tools');
 expect(companionServer('http://127.0.0.1:3002').hostname).toBe('127.0.0.1');
 for(const url of ['http://example.com','https://user:pass@example.com','file:///tmp/a','https://example.com/evil'])expect(()=>companionServer(url)).toThrow();
 expect(decodeLocal(encodeLocal({image:new Uint8Array([1,2,3])}))).toEqual({image:Buffer.from([1,2,3])});
});

it('blocks clipboard, browser shortcuts and WebDriver key injection locally',()=>{
 for(const key of ['CTRL+V','META+V','CTRL+L','CMD+ALT+J','F12','SHIFT+INSERT','SHIFT+DELETE'])expect(()=>assertLocalCommand({id:'x',method:'pressKey',args:[key]})).toThrow('local_method_forbidden');
 for(const key of ['ENTER','TAB','SHIFT+TAB','CTRL+A','META+Z','ARROWDOWN'])expect(()=>assertLocalCommand({id:'x',method:'pressKey',args:[key]})).not.toThrow();
 expect(()=>assertLocalCommand({id:'x',method:'typeText',args:['\uE009v']})).toThrow();
 expect(()=>assertLocalCommand({id:'x',method:'formInput',args:['ref_1','\uE03Dv']})).toThrow();
});

it('requires desktop consent and exposes capture without browser control or a false redaction claim',async()=>{
 const {bridge,post,context}=await fixture();
 const pair=bridge.pair('owner','https://app.example.com',async()=>true,'desktop');
 const redeemed=await (await post('pair',{code:pair.pairingCode})).json();
 expect(redeemed.mode).toBe('desktop');
 expect((await post('ready',{},redeemed.token)).status).toBe(409);
 expect((await post('ready',{captureConsent:true},redeemed.token)).status).toBe(200);
 const driver=await bridge.createContext('owner',pair.connectionId,context);
 expect(driver.capturePrivacy).toBe('user-approved-desktop');
 await expect(driver.typeText('secret')).rejects.toThrow('desktop_capture_only');
 await expect(driver.exportStorageState()).rejects.toThrow('local_credentials_stay_local');
 const capture=driver.stopRecording();
 const {command}=await (await post('poll',{},redeemed.token)).json();
 await post('result/'+command.id,{value:{body:{$bytes:Buffer.from('test').toString('base64')},redactionPassed:false},meta:{recordingElapsedMs:15050}},redeemed.token);
 expect((await capture).redactionPassed).toBe(false);
 expect(driver.recordingDurationMs).toBe(15050);
});
