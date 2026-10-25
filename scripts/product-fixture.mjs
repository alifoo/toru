// Synthetic product journey for local Recorder acceptance. Never connect real data or enrichment providers.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PRODUCT_FIXTURE_PORT ?? 42570);
const password = process.env.PRODUCT_FIXTURE_PASSWORD;
if (!password || password.length < 16 || !Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('product_fixture_configuration_invalid');
const session = randomBytes(32).toString('hex');
const sheets = new Map();
const people = [
  { id: 'camila', name: 'Camila Rocha', role: 'Head of RevOps', company: 'Nuvem SaaS', sector: 'SaaS', email: 'camila.rocha@example.test' },
  { id: 'ana', name: 'Ana Silva', role: 'VP Sales', company: 'Lago Software', sector: 'SaaS', email: 'ana.silva@example.test' },
  { id: 'bruno', name: 'Bruno Costa', role: 'VP Marketing', company: 'Rio Finance', sector: 'Fintech', email: 'bruno.costa@example.test' },
];
const html = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const layout = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)} · Demo fixture</title>
<style>body{font:17px system-ui,sans-serif;background:#f1f5f9;color:#142536;margin:0}.shell{max-width:1050px;margin:45px auto;padding:28px 38px;background:white;border-radius:20px;box-shadow:0 8px 30px #13263a16}.tag{color:#9b2c2c;font-weight:700;letter-spacing:.08em;font-size:13px;text-transform:uppercase}h1{font-size:35px;margin:12px 0 25px}h2{font-size:23px}p{line-height:1.5}a{color:#125d8d}label{display:block;margin:15px 0 6px;font-weight:600}input,select{font:inherit;padding:10px;border:1px solid #9aabba;border-radius:7px;min-width:260px}button{font:inherit;background:#13547b;color:white;border:0;border-radius:7px;padding:10px 17px;cursor:pointer}button.secondary{background:#e9eef2;color:#17334b}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{text-align:left;border-bottom:1px solid #d6e0e8;padding:12px}nav{display:flex;gap:20px;margin:10px 0 25px}.card{border:1px solid #d6e0e8;border-radius:12px;padding:18px;margin:12px 0}.success{background:#e8f7ea;border-left:4px solid #278549;padding:12px}</style>
<div class="shell"><p class="tag">Synthetic test fixture · no real people or provider charges</p><nav><a href="/sheets">Sheets</a></nav><h1>${html(title)}</h1>${body}</div></html>`;
const page = (response, title, body, status=200, extra={}) => {response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',...extra});response.end(layout(title,body));};
const redirect = (response, path, cookie) => {response.writeHead(303,{'location':path,'cache-control':'no-store',...(cookie?{'set-cookie':cookie}:{})});response.end();};
async function form(request) {
  if(request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded')throw new Error('form_required');
  let value='';for await(const chunk of request){value+=chunk;if(value.length>4096)throw new Error('form_too_large');}
  return new URLSearchParams(value);
}
const authorized = request => request.headers.cookie?.split(';').some(part => part.trim()===`fixture_session=${session}`);
const equal = (a,b) => {const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};

const server=createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://fixture.local');
  if(request.method==='GET'&&url.pathname==='/healthz'){response.writeHead(200,{'content-type':'text/plain'});response.end('ok');return;}
  if(request.method==='GET'&&url.pathname==='/login'){
    page(response,'Sign in',`<p>Use the one-time password supplied by the local test harness.</p><form method="post" action="/login"><label for="password">Demo password</label><input id="password" name="password" type="password" autocomplete="off" required><p><button type="submit">Sign in</button></p></form>`);return;
  }
  if(request.method==='POST'&&url.pathname==='/login'){
    const input=await form(request);
    if(!equal(input.get('password')??'',password)){page(response,'Sign in failed','<p>Invalid demo password.</p><a href="/login">Try again</a>',401);return;}
    redirect(response,'/sheets',`fixture_session=${session}; HttpOnly; Secure; SameSite=Lax; Path=/`);return;
  }
  if(!authorized(request)){redirect(response,'/login');return;}
  if(request.method==='GET'&&['/','/sheets'].includes(url.pathname)){
    const items=[...sheets].map(([id,sheet])=>`<li><a href="/sheets/${id}">${html(sheet.name)}</a> · ${sheet.people.length} people</li>`).join('');
    page(response,'People sheets',`<p>Create a sheet for a simple ICP.</p><form method="post" action="/sheets"><label for="name">New sheet name</label><input id="name" name="name" required maxlength="80"><p><button type="submit">Create sheet</button></p></form><h2>Your sheets</h2><ul>${items||'<li>No sheets yet</li>'}</ul>`);return;
  }
  if(request.method==='POST'&&url.pathname==='/sheets'){
    const input=await form(request),name=(input.get('name')??'').trim();
    if(!name||name.length>80){page(response,'Invalid sheet','<p>Enter a sheet name.</p>',400);return;}
    const id=String(sheets.size+1);sheets.set(id,{name,people:[],enrichment:false,ran:false});redirect(response,`/sheets/${id}`);return;
  }
  const sheetId=url.pathname.match(/^\/sheets\/(\d+)(?:\/(people|enrichment|run))?$/);
  if(request.method==='GET'&&url.pathname==='/people'){
    const id=url.searchParams.get('sheet'),sheet=sheets.get(id);
    if(!sheet){page(response,'Sheet missing','<p>Unknown sheet.</p>',404);return;}
    const query=(url.searchParams.get('q')??'').trim().toLowerCase();
    const matches=query ? people.filter(person=>query.split(/\s+/).every(word=>`${person.role} ${person.company} ${person.sector}`.toLowerCase().includes(word))) : [];
    const rows=matches.map(person=>`<div class="card"><strong>${html(person.name)}</strong> · ${html(person.role)} at ${html(person.company)}<form method="post" action="/sheets/${id}/people"><input type="hidden" name="person" value="${person.id}"><p><button type="submit">Add ${html(person.name)} to sheet</button></p></form></div>`).join('');
    page(response,'Find people',`<p>Target ICP: RevOps leaders at SaaS companies. All records are fictional.</p><form method="get" action="/people"><input type="hidden" name="sheet" value="${id}"><label for="q">Search ICP</label><input id="q" name="q" value="${html(url.searchParams.get('q')??'')}" placeholder="revops saas"><p><button type="submit">Search people</button></p></form>${query?`<h2>Search results</h2>${rows||'<p>No matches.</p>'}`:''}<p><a href="/sheets/${id}">Back to sheet</a></p>`);return;
  }
  if(sheetId){
    const [,id,action]=sheetId,sheet=sheets.get(id);
    if(!sheet){page(response,'Sheet missing','<p>Unknown sheet.</p>',404);return;}
    if(request.method==='POST'&&action==='people'){
      const input=await form(request),person=people.find(item=>item.id===input.get('person'));
      if(!person){page(response,'Person missing','<p>Unknown person.</p>',400);return;}
      if(!sheet.people.includes(person.id))sheet.people.push(person.id);
      redirect(response,`/sheets/${id}`);return;
    }
    if(request.method==='POST'&&action==='enrichment'){
      const input=await form(request);
      if(input.get('field')!=='work_email'){page(response,'Invalid enrichment','<p>Unknown enrichment.</p>',400);return;}
      sheet.enrichment=true;redirect(response,`/sheets/${id}`);return;
    }
    if(request.method==='POST'&&action==='run'){
      if(!sheet.enrichment||sheet.people.length===0){page(response,'Run unavailable','<p>Add people and enrichment first.</p>',409);return;}
      sheet.ran=true;redirect(response,`/sheets/${id}`);return;
    }
    if(request.method==='GET'&&!action){
      const rows=sheet.people.map(personId=>{const person=people.find(item=>item.id===personId);return `<tr><td>${html(person.name)}</td><td>${html(person.role)}</td><td>${html(person.company)}</td><td>${sheet.ran?html(person.email):'Pending'}</td></tr>`;}).join('');
      page(response,sheet.name,`<p><a href="/people?sheet=${id}">Find people for this sheet</a></p><table><thead><tr><th>Person</th><th>Role</th><th>Company</th><th>Work email (simulated)</th></tr></thead><tbody>${rows||'<tr><td colspan="4">No people added yet.</td></tr>'}</tbody></table><h2>Enrichment</h2>${sheet.enrichment?'<p>Work email enrichment added (simulated).</p>':`<form method="post" action="/sheets/${id}/enrichment"><input type="hidden" name="field" value="work_email"><button type="submit">Add work email enrichment</button></form>`}${sheet.enrichment?`<form method="post" action="/sheets/${id}/run"><p><button type="submit">Run enrichment</button></p></form>`:''}${sheet.ran?`<p class="success"><a href="/sheets/${id}">Run complete · ${html(people.find(item=>item.id===sheet.people[0]).email)} (synthetic)</a>. No provider was called.</p>`:''}`);return;
    }
  }
  page(response,'Not found','<p>Unknown route.</p>',404);
 }catch(error){page(response,'Request failed',`<p>${html(error instanceof Error?error.message:'request_failed')}</p>`,400);}
});
server.listen(port,'127.0.0.1',()=>console.log(`product_fixture_ready http://127.0.0.1:${port}`));
