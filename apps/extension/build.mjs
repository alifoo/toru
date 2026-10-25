#!/usr/bin/env node
/**
 * Builds Toru for Chrome into dist/ (load it unpacked, or zip it for the Web Store).
 *
 *   node build.mjs                                   # production: https://mcp.toru.tools
 *   TORU_SERVER=http://127.0.0.1:3002 node build.mjs # local backend (loopback only)
 *
 * The recorder's browser driver is bundled as is. Its Node-only paths (ffmpeg, ChromeDriver, DNS, temp
 * profiles) are never taken in the extension, so those modules become small stubs.
 */
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, process.env.TORU_EXTENSION_OUT ?? 'dist');
const server = new URL(process.env.TORU_SERVER ?? 'https://mcp.toru.tools');
const loopback = ['127.0.0.1', 'localhost'].includes(server.hostname);
if (server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback)) throw new Error('TORU_SERVER must be https, or http on loopback');
if (server.pathname !== '/' || server.search || server.hash) throw new Error('TORU_SERVER must be an origin');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
/** Each build gets an id; an unpacked copy notices a rebuild on disk and reloads itself when idle. */
const buildId = randomUUID();

const nodeStubs = {
  name: 'node-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path.slice(5), namespace: 'node-stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({
      resolveDir: join(root, 'src'),
      contents: `export * from './node-stubs/${args.path.replace('/', '-')}.ts';`,
      loader: 'ts',
    }));
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const common = {
  bundle: true, platform: 'browser', target: 'chrome120', sourcemap: false, minify: false, legalComments: 'none', logLevel: 'warning',
  plugins: [nodeStubs],
  define: { __TORU_SERVER__: JSON.stringify(server.origin), __TORU_VERSION__: JSON.stringify(pkg.version), __TORU_BUILD__: JSON.stringify(buildId) },
  inject: [join(root, 'src/node-stubs/buffer-global.ts')],
};
await build({ ...common, entryPoints: { background: join(root, 'src/background.ts') }, outdir: out, format: 'esm' });
await build({ ...common, entryPoints: { offscreen: join(root, 'src/offscreen.ts'), popup: join(root, 'src/popup.ts'), connect: join(root, 'src/connect.ts') }, outdir: out, format: 'iife' });
await cp(join(root, 'static'), out, { recursive: true });

const hosts = loopback ? [`${server.protocol}//${server.hostname}/*`] : [`${server.origin}/*`];
const manifest = {
  manifest_version: 3,
  name: 'Toru for Chrome',
  short_name: 'Toru',
  version: pkg.version,
  description: 'Lets your Toru agent record product demos in your own signed-in Chrome, in a tab it opens for each recording.',
  minimum_chrome_version: '120',
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_title: 'Toru', default_popup: 'popup.html', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['debugger', 'offscreen', 'storage', 'alarms', 'system.display'],
  host_permissions: hosts,
  content_scripts: [{ matches: hosts.map((host) => host.replace(/\*$/, 'extension/connect*')), js: ['connect.js'], run_at: 'document_idle' }],
};
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(join(out, 'build-id.txt'), buildId);
console.log(`Toru for Chrome ${pkg.version} → ${out} (server ${server.origin})`);
