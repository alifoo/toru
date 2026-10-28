import { spawn } from 'node:child_process';
import { backgroundCatalog, type CaptureRedaction } from '@content-layer/render-contract';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Brand } from './store/brands.js';
/** Post-render branding with ffmpeg: logo overlay and optional intro/outro logo cards. The exporter stays untouched. */
export const backgroundPresets: Record<string, string> = {
  midnight: 'linear-gradient(135deg, #131725 0%, #344260 100%)',
  ocean: 'linear-gradient(135deg, #083344 0%, #0e7490 50%, #a5f3fc 100%)',
  sunset: 'linear-gradient(135deg, #312e81 0%, #be185d 55%, #fed7aa 100%)',
};
const presetCardColour: Record<string, string> = { midnight: '#1b2238', ocean: '#0a4c5c', sunset: '#4a2a6b' };
/** CSS wallpaper for the exporter: explicit background, else a gradient derived from the accent, else undefined. */
export function brandWallpaper(brand: Brand | undefined): string | undefined {
  if (!brand) return undefined;
  if (brand.background) return backgroundPresets[brand.background.toLowerCase()] ?? brand.background;
  if (brand.accent) return `linear-gradient(135deg, ${shade(brand.accent, -0.55)} 0%, ${brand.accent} 100%)`;
  return undefined;
}
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(Math.min(255, Math.max(0, ((n >> shift) & 255) * (1 + amount)))).toString(16).padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}
/** Solid colour for intro/outro cards: the explicit colour, the preset's dark tone, or the accent. */
export function cardColour(brand: Brand): string {
  if (brand.background && /^#[0-9a-f]{6}$/i.test(brand.background)) return brand.background;
  if (brand.background && presetCardColour[brand.background.toLowerCase()]) return presetCardColour[brand.background.toLowerCase()]!;
  const catalog = backgroundCatalog.find(entry => entry.id === brand.background);
  if (catalog) return catalog.tone;
  if (brand.accent) return shade(brand.accent, -0.55);
  return '#131725';
}
function run(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], ...(signal ? { signal } : {}) });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg_failed:${stderr.slice(0, 200)}`)));
  });
}
async function probe(path: string): Promise<{ width: number; height: number; fps: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('exit', () => {
      try {
        const parsed = JSON.parse(out) as { streams?: Array<{ width: number; height: number; r_frame_rate: string }>; format?: { duration?: string } };
        const stream = parsed.streams?.[0]; if (!stream) throw new Error('probe_failed');
        const [num, den] = stream.r_frame_rate.split('/').map(Number);
        resolve({ width: stream.width, height: stream.height, fps: num && den ? num / den : 30, durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000) });
      } catch (error) { reject(error); }
    });
  });
}
const logoPlacement: Record<NonNullable<Brand['logoPosition']>, string> = {
  'bottom-right': 'x=W-w-m:y=H-h-m', 'bottom-left': 'x=m:y=H-h-m', 'top-right': 'x=W-w-m:y=m', 'top-left': 'x=m:y=m',
};
export type BrandingResult = { bytes: Buffer; applied: string[] };
/** Returns the input untouched when the brand adds nothing that needs post-processing. */
export async function applyBrand(video: Buffer, brand: Brand | undefined, signal?: AbortSignal): Promise<BrandingResult> {
  if (!brand?.logo) return { bytes: video, applied: [] };
  const dir = await mkdtemp(join(tmpdir(), 'toru-brand-'));
  try {
    const input = join(dir, 'in.mp4'), logo = join(dir, 'logo.png'), output = join(dir, 'out.mp4');
    await writeFile(input, video); await writeFile(logo, Buffer.from(brand.logo.slice(brand.logo.indexOf(',') + 1), 'base64'));
    const info = await probe(input);
    const margin = Math.round(info.height * 0.03), logoHeight = Math.round(info.height * 0.06), cardLogoHeight = Math.round(info.height * 0.18);
    const place = logoPlacement[brand.logoPosition ?? 'bottom-right'].replaceAll('m', String(margin));
    const applied = ['logo'];
    if (brand.cards) {
      applied.push('cards');
      const colour = cardColour(brand), fps = Math.min(60, Math.max(1, Math.round(info.fps)));
      const filter = [
        `[1:v]scale=-1:${logoHeight}[logo]`, `[1:v]scale=-1:${cardLogoHeight}[cardlogo]`,
        `[0:v][logo]overlay=${place}:format=auto,fps=${fps},format=yuv420p[main]`,
        `color=c=${colour}:s=${info.width}x${info.height}:d=1.5:r=${fps},format=yuv420p[c1]`,
        `color=c=${colour}:s=${info.width}x${info.height}:d=1.5:r=${fps},format=yuv420p[c2]`,
        `[c1][cardlogo]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=1.2:d=0.3[intro]`,
        `[c2][cardlogo]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p,fade=t=in:st=0:d=0.3[outro]`,
        `[intro][main][outro]concat=n=3:v=1:a=0[v]`,
      ].join(';');
      await run(['-i', input, '-i', logo, '-filter_complex', filter, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], signal);
    } else {
      await run(['-i', input, '-i', logo, '-filter_complex', `[1:v]scale=-1:${logoHeight}[logo];[0:v][logo]overlay=${place}:format=auto,format=yuv420p[v]`, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], signal);
    }
    return { bytes: await readFile(output), applied };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
/** A shareable GIF: capped width, 12 fps, per-file palette. */
/**
 * Blurs the parts of a capture that show who the user is, in the source, before the renderer zooms or crops it.
 *
 * Blurring the finished video instead would have to chase the camera; in the source each box stays where the
 * window put it. Spans are fractions of the frame and milliseconds from the capture's start.
 */
export async function redactRegions(sourcePath: string, outputPath: string, regions: CaptureRedaction[], signal?: AbortSignal): Promise<void> {
  const { width, height } = await probe(sourcePath);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const boxes = regions.slice(0, 80).map(region => {
    // Even offsets too: yuv420p keeps one chroma sample per 2x2 block, and a box cropped or overlaid at an odd
    // pixel shifts the colour against the brightness, which shows as green stripes over the blur.
    const x = Math.min(width - 2, Math.max(0, Math.floor(region.x * width / 2) * 2));
    const y = Math.min(height - 2, Math.max(0, Math.floor(region.y * height / 2) * 2));
    return { x, y, w: Math.min(even(region.width * width), width - x), h: Math.min(even(region.height * height), height - y),
      from: (region.startMs / 1000).toFixed(3), to: (region.endMs / 1000).toFixed(3) };
  }).filter(box => box.w >= 2 && box.h >= 2);
  if (!boxes.length) throw new Error('redaction_regions_empty');
  const labels = boxes.map((_box, index) => `[c${index}]`).join('');
  const parts = [`[0:v]split=${boxes.length + 1}[s0]${labels}`];
  boxes.forEach((box, index) => {
    // Strong enough that a name cannot be read back: shrunk to a few pixels a line, grown back and softened.
    // Not gblur: on the x86 render hosts it left thin black and green bars over the text (28/10/2026), and a
    // box blur alone has a radius ceiling tied to the box size, so a small footer would stay readable.
    const small = `${Math.max(2, Math.round(box.w / 20))}:${Math.max(2, Math.round(box.h / 20))}`;
    const radius = Math.min(6, Math.floor(Math.min(box.w, box.h) / 4));
    parts.push(`[c${index}]crop=${box.w}:${box.h}:${box.x}:${box.y},scale=${small}:flags=area,scale=${box.w}:${box.h}:flags=bicubic${radius >= 1 ? `,boxblur=${radius}:1` : ''}[b${index}]`);
    parts.push(`[s${index}][b${index}]overlay=${box.x}:${box.y}:enable='between(t,${box.from},${box.to})'[s${index + 1}]`);
  });
  await run(['-i', sourcePath, '-filter_complex', parts.join(';'), '-map', `[s${boxes.length}]`, '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', outputPath], signal);
}
export async function makeGif(videoPath: string, gifPath: string, signal?: AbortSignal, width = 960): Promise<void> {
  await run(['-i', videoPath, '-vf', `fps=12,scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', gifPath], signal);
}
