import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {createServer} from 'node:net';

async function freePort(){
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}

if (!process.env.CHROMEDRIVER_BINARY || !process.env.RENDER_BROWSER_BINARY) throw new Error('Set ChromeDriver and Chrome paths');
const directory = await mkdtemp(join(tmpdir(), 'agent-recorder-smoke-'));
const tokens = Array.from({length:process.env.QUEUE_LOAD_SMOKE==='1'?10:1},()=>randomBytes(32).toString('base64url'));
const token=tokens[0];
const owners=tokens.map(()=>randomUUID());
await writeFile(join(directory, 'invites.json'), JSON.stringify({ invites: tokens.map((value,index)=>({
  owner: owners[index], tokenHash: createHash('sha256').update(value).digest('hex'), expiresAt: Date.now() + 3600_000,
})) }), { mode: 0o600 });
const port=Number(process.env.SMOKE_PORT ?? await freePort());
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_smoke_port');
const url = `http://127.0.0.1:${port}`;
const serverEnv = { ...process.env, DATA_DIR: directory, PUBLIC_URL: url, PORT: String(port),CHROMEDRIVER_PORT:String(await freePort()), SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),HOSTED_USAGE_COHORT:'fixture' };
let server;
async function stopServer(signal = 'SIGTERM') {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill(signal);
  await exited;
}
async function startServer() {
  server = spawn(process.execPath, [process.env.RECORDER_MODE === 'hosted' ? 'apps/hosted/dist/index.js' : 'apps/mcp/dist/index.js'], { env: serverEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    try { if ((await fetch(`${url}/healthz`)).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('server_not_ready');
}
try {
  await startServer();
  const smoke = spawn(process.execPath, [process.env.RECORDER_SMOKE_CLIENT ?? (process.env.QUEUE_LOAD_SMOKE==='1' ? 'apps/mcp/src/smoke-queue-load.mjs' : process.env.FAULT_PHASE ? 'apps/mcp/src/smoke-session-fault.mjs' : 'apps/mcp/src/smoke.mjs')], {
    env: { ...process.env, RECORDER_URL: url, RECORDER_TOKEN: token, RECORDER_OWNER: owners[0], ...(process.env.INVITE_ADMIN_KEY?{RECORDER_ADMIN_KEY:process.env.INVITE_ADMIN_KEY}:{}), ...(process.env.QUEUE_LOAD_SMOKE==='1'?{RECORDER_SMOKE_TOKENS:JSON.stringify(tokens)}:{}) }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  smoke.on('message', async message => {
    if (message?.type !== 'restart' || process.env.RECOVERY_SMOKE !== '1') return;
    try { await stopServer(process.env.RECOVERY_SIGNAL === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'); await startServer();
      if(process.env.FAULT_PHASE && (await readdir(join(directory,'.scratch'))).length!==0)throw new Error('crashed_scratch_not_cleared');
      smoke.send({ type: 'restarted' }); }
    catch { smoke.send({ type: 'restart_failed' }); }
  });
  const code = await new Promise(resolve => smoke.on('exit', resolve));
  if (code !== 0) throw new Error(`Smoke exited ${code}`);
} finally {
  await stopServer();
  console.log(`Diagnostic artifacts retained at ${directory}`);
}
