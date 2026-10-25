// Native regression: run with a local ChromeDriver URL and Chromium binary.
// Synthetic credentials only. Never signs into a third-party account.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
const { connectionPageHtml } = await import(process.env.CONNECTION_PAGE_MODULE || '../apps/mcp/dist/connection-page.js');
let uiStatus='waiting';
const { WebDriverBrowserDriver, FetchWebDriverTransport } = await import(process.env.CONNECTION_BROWSER_MODULE || '../packages/browser/dist/index.js');
const page = (path) => `<!doctype html><html><body>${path.startsWith('/two') ? '<form id="form"><input name="email" type="email">'+(path==='/two-hidden'?'<div style="opacity:0;pointer-events:none"><input name="password" type="password"></div>':'')+'<button>Continue</button></form>' : '<form id="form"><input name="email" type="email"><input name="password" type="password"><button>Sign in</button></form>'}<div role="alert" id="error"></div><script>
const path=${JSON.stringify(path)};
function bind(){document.querySelector('form').onsubmit=e=>{e.preventDefault();const p=document.querySelector('[name=password]');if(!p||p.parentElement.style.opacity==='0'){document.querySelector('form').innerHTML='<input name="password" type="password"><button>Sign in</button>';return}if(path==='/reject'){document.querySelector('#error').textContent='Incorrect password';return}if(path==='/mfa'){document.body.innerHTML='<input name="code" autocomplete="one-time-code">';return}document.body.innerHTML='<h1>Dashboard</h1>'+ (path==='/unknown'?'':'<button>Sign out</button>');}}bind();</script></body></html>`;
const server=createServer(async(req,res)=>{
 if(req.url==='/restored'){res.setHeader('content-type','text/html');res.end('<h1 id=state></h1><script>document.querySelector("#state").textContent='+JSON.stringify((req.headers.cookie||'').includes('__Host-fixture=synthetic'))+'&&localStorage.getItem("workspace")==="fixture"?"Restored session":"Missing session"</script>');return}
 if(req.url==='/ui'){res.setHeader('content-type','text/html');res.end(connectionPageHtml('fixture'));return}
 if(req.url==='/connect/fixture/credentials'){for await(const chunk of req){};uiStatus='verifying';res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify({connectionStatus:uiStatus}));return}
 if(req.url==='/connect/fixture/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({connectionStatus:uiStatus}));return}
 res.setHeader('content-type','text/html');res.end(page(req.url));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=new WebDriverBrowserDriver(new FetchWebDriverTransport(process.env.CHROMEDRIVER_URL||'http://127.0.0.1:9516'),{chromeBinary:process.env.RENDER_BROWSER_BINARY,chromeArguments:['--headless=new',...(process.env.CHROME_NO_SANDBOX==='1'?['--no-sandbox']:[])]});
try {
 for(const [path,expected] of [['/single',null],['/two',null],['/two-hidden',null],['/reject','invalid_credentials'],['/mfa','additional_verification_required'],['/unknown','login_not_confirmed']]){
  const driver=await browser.createContext({viewport:{width:1280,height:720},allowedOrigins:[origin],sessionState:Buffer.from('{"cookies":[],"origins":[]}'),onNavigation:()=>{},allowPopup:false,allowDownload:false});
  try{await driver.goto(origin+path);const work=driver.connectWithCredentials('fixture@example.test','synthetic-password',AbortSignal.timeout(60000));if(expected)await assert.rejects(work,new RegExp(expected));else await work;console.log('PASS',path,expected||'verified');}finally{await driver.dispose();}
 }
 const restored=await browser.createContext({viewport:{width:1280,height:720},allowedOrigins:[origin],sessionState:Buffer.from(JSON.stringify({cookies:[{name:'__Host-fixture',value:'synthetic',domain:'127.0.0.1',path:'/',secure:true,httpOnly:true,sameSite:'Lax',expires:-1}],origins:[{origin,localStorage:[{name:'workspace',value:'fixture'}]}]})),onNavigation:()=>{},allowPopup:false,allowDownload:false});
 try {await restored.goto(origin+'/restored');assert.match(await restored.pageText(),/Restored session/);console.log('PASS host-only session cookie and localStorage restored before navigation');}finally{await restored.dispose()}
 const deferred=await browser.createContext({viewport:{width:1280,height:720},allowedOrigins:[origin],sessionState:Buffer.from('{"cookies":[],"origins":[]}'),onNavigation:url=>{if(new URL(url).pathname==='/protected')throw new Error('origin_not_allowed');},allowPopup:false,allowDownload:false});
 try {await deferred.connectWithCredentials('fixture@example.test','synthetic-password',AbortSignal.timeout(60000),origin+'/protected');assert.match(await deferred.pageText(),/Dashboard/);console.log('PASS deferred navigation and authorized login route fallback');}finally{await deferred.dispose();}
 const ui=await browser.createContext({viewport:{width:390,height:844},allowedOrigins:[origin],sessionState:Buffer.from('{"cookies":[],"origins":[]}'),onNavigation:()=>{},allowPopup:false,allowDownload:false});
 try {
  await ui.goto(origin+'/ui');
  const outline=await ui.readPage();
  const input=outline.match(/\[(ref_\d+)\] input:text/)[1], password=outline.match(/\[(ref_\d+)\] input:password/)[1], submit=outline.match(/\[(ref_\d+)\] button/)[1];
  await ui.formInput(input,'fixture@example.test');await ui.formInput(password,'synthetic-password');await ui.pointer('left_click',{type:'ref',ref:submit});
  for(let i=0;i<20&&uiStatus!=='verifying';i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(uiStatus,'verifying');
  assert.match(await ui.pageText(),/Credenciais recebidas/);
  assert.doesNotMatch(await ui.readPage(),/input:password/);
  await writeFile('/tmp/recorder-connection-received.png',(await ui.screenshot('ui',false)).body);
  await ui.goto(origin+'/ui'); // Closing/reopening the form preserves server-side progress.
  await new Promise(r=>setTimeout(r,500));assert.match(await ui.pageText(),/Credenciais recebidas/);
  uiStatus='ready';
  for(let i=0;i<30;i++){if((await ui.pageText()).includes('Produto conectado'))break;await new Promise(r=>setTimeout(r,100))}
  assert.match(await ui.pageText(),/Produto conectado/);
  await writeFile('/tmp/recorder-connection-ready.png',(await ui.screenshot('ui',false)).body);
  console.log('PASS secure form receipt, reload and verified success');
 }finally{await ui.dispose()}
}finally{server.close();}
