import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const url = process.env.RECORDER_URL;
const adminKey = process.env.RECORDER_ADMIN_KEY;
if (!url || !adminKey) throw new Error('RECORDER_URL and RECORDER_ADMIN_KEY required');
const owner = randomUUID();
async function createInvite() {
  const response = await fetch(new URL('/admin/invites', url), { method: 'POST', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner, expiresIn: '1h' }) });
  if (!response.ok) throw new Error(`invite_creation_failed_${response.status}`);
  const body = await response.json();
  if (typeof body.token !== 'string' || !/^ar_[\w-]+$/.test(body.token)) throw new Error('invalid_invite_response');
  return body.token;
}
async function revokeInvite() {
  await fetch(new URL(`/admin/invites?owner=${owner}`, url), { method: 'DELETE', headers: { authorization: `Bearer ${adminKey}` } });
}
try {
  const token = await createInvite();
  const child = spawn(process.execPath, ['apps/mcp/src/smoke.mjs'], {
    stdio: 'inherit', env: { ...process.env, RECORDER_TOKEN: token, SMOKE_OUTPUT: '/tmp/agent-recorder-hosted.mp4' },
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error(`hosted_smoke_failed_${code}`);
} finally {
  await revokeInvite().catch(() => undefined);
}
