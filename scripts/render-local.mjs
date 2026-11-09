#!/usr/bin/env node
/**
 * Renders a captured session on this machine, the way recorder-beta does, to iterate on post-production without a
 * deploy or a new recording.
 *
 *   node scripts/render-local.mjs <session dir> [out.mp4] [--zoom 2] [--background toru-mist] [--padding 8]
 *
 * The session dir holds the server's raw.mp4 and observation.json (from /data/jobs/<id> on recorder-beta). Build the
 * packages first: pnpm --filter ./packages/render-contract --filter ./packages/browser --filter ./packages/render-host
 * --filter ./apps/mcp build. Renders in headless Chrome (no window), prints the camera plan and writes the MP4 plus
 * plan.json next to it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildExporterConfig, reviewCamera, reviewCapture } from '../packages/render-contract/dist/index.js';
import { createRenderHost } from '../packages/render-host/dist/index.js';
import { detectStillRanges, detectCaptureGaps } from '../apps/mcp/dist/stills.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args.splice(at, 2)[1] : fallback; };
const zoom = flag('zoom');
const background = flag('background', 'toru-mist');
const padding = Number(flag('padding', '8'));
const [dir, outArg] = args;
if (!dir) { console.error('usage: render-local.mjs <session dir> [out.mp4] [--zoom 2] [--background toru-mist] [--padding 8]'); process.exit(2); }
const session = resolve(dir);
const raw = join(session, 'raw.mp4');
const out = resolve(outArg ?? join(session, 'local.mp4'));
const observation = JSON.parse(await readFile(join(session, 'observation.json'), 'utf8'));

const stills = await detectStillRanges(raw, observation.durationMs);
if (stills) observation.stillRanges = stills;
const gaps = await detectCaptureGaps(raw, observation.durationMs);
if (gaps) observation.captureGaps = gaps;
const seconds = Math.max(1, observation.durationMs / 1000);
const config = buildExporterConfig(observation, {
  wallpaper: background, padding,
  bitrate: Math.min(8_000_000, Math.round(450 * 1024 ** 2 * 8 / seconds / 100_000) * 100_000),
  compressPauses: observation.idleRanges !== undefined,
  ...(zoom ? { zoomScale: Number(zoom) } : {}),
});
const plan = { zoomRegions: config.zoomRegions, trimRegions: config.trimRegions, review: [...reviewCapture(observation), ...reviewCamera(config, observation)] };
await writeFile(out.replace(/\.mp4$/, '.plan.json'), JSON.stringify(plan, null, 2));
for (const z of config.zoomRegions) console.log('zoom', (z.intent ?? 'click').padEnd(8), z.startMs, '→', z.endMs, `${z.customScale}×`, z.element ?? '');
console.log('cuts', (config.trimRegions ?? []).map(t => `${t.startMs}-${t.endMs}`).join(' '));
console.log('delivery check', plan.review.length ? plan.review.join(', ') : 'passes');

const browserBinary = process.env.RENDER_BROWSER_BINARY
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync);
const host = createRenderHost({ browserBinary });
const started = Date.now();
let last = 0;
const outcome = await host.render({ sourcePath: raw, config, timeoutMs: 30 * 60_000, onProgress: progress => {
  const now = Date.now();
  if (now - last > 5_000) { last = now; console.log('frame', progress.currentFrame, '/', progress.totalFrames ?? '?'); }
} });
if (outcome.status !== 'rendered') { console.error('render failed:', outcome.reason); process.exit(1); }
await writeFile(out, outcome.bytes);
console.log(`rendered ${out} in ${Math.round((Date.now() - started) / 1000)} s`);
