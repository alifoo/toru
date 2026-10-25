import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
for (const path of ['.env', 'data/invites.json', '.local-mcp.json']) {
  try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Configuration already exists; refusing to replace ' + path);
}
const token = `ar_${randomBytes(32).toString('base64url')}`;
await mkdir('data', { recursive: true, mode: 0o700 });
// Never overwrite existing credentials/configuration.
await writeFile('.env', `PUBLIC_URL=http://localhost:3002\nPORT=3002\nDATA_DIR=./data\nSESSION_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n# Set your installed browser/driver paths below.\n# CHROMEDRIVER_BINARY=/path/to/chromedriver\n# RENDER_BROWSER_BINARY=/path/to/chrome\n`, { mode: 0o600, flag: 'wx' });
await writeFile('data/invites.json', JSON.stringify({ invites: [{ owner: randomUUID(), tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 7 * 86400_000 }] }, null, 2), { mode: 0o600, flag: 'wx' });
await writeFile('.local-mcp.json', JSON.stringify({ mcpServers: { recorder: { type: 'http', url: 'http://localhost:3002/mcp', headers: { Authorization: `Bearer ${token}` } } } }, null, 2), { mode: 0o600, flag: 'wx' });
console.log('Created private .env, data/invites.json and .local-mcp.json. Configure browser paths in .env, then follow README.md.');
