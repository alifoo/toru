#!/usr/bin/env node
/**
 * Packages Toru for Chrome for release: a production build, zipped. The same zip is uploaded to the Chrome
 * Web Store and served for the unpacked beta at https://toru.tools/downloads/toru-chrome-latest.zip, with its
 * version and SHA-256 in downloads/chrome.json for the install page.
 *
 *   node package.mjs [--web-store-url https://chromewebstore.google.com/detail/…]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const downloads = join(root, '../console/public/downloads');
const at = process.argv.indexOf('--web-store-url');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const previous = JSON.parse(await readFile(join(downloads, 'chrome.json'), 'utf8').catch(() => '{}'));
const webStoreUrl = at >= 0 ? process.argv[at + 1] : previous.webStoreUrl ?? null;
if (webStoreUrl && !/^https:\/\/chromewebstore\.google\.com\/detail\//.test(webStoreUrl)) throw new Error('--web-store-url must be a Chrome Web Store listing');

const out = join(root, 'release');
await rm(out, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'build.mjs')], { env: { ...process.env, TORU_SERVER: 'https://mcp.toru.tools', TORU_EXTENSION_OUT: join(out, 'toru-chrome') }, stdio: 'inherit' });
const zip = join(out, `toru-chrome-${pkg.version}.zip`);
execFileSync('zip', ['-qrX', zip, '.'], { cwd: join(out, 'toru-chrome') });
const bytes = await readFile(zip);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await mkdir(downloads, { recursive: true });
await copyFile(zip, join(downloads, `toru-chrome-${pkg.version}.zip`));
await copyFile(zip, join(downloads, 'toru-chrome-latest.zip'));
await writeFile(join(downloads, 'chrome.json'), `${JSON.stringify({ channel: 'beta', version: pkg.version, bytes: bytes.length, sha256, publishedAt: new Date().toISOString(), webStoreUrl }, null, 2)}\n`);
console.log(`toru-chrome-${pkg.version}.zip ${bytes.length} bytes sha256 ${sha256}`);
