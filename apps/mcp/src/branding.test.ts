import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyBrand, brandWallpaper, cardColour, makeGif, redactRegions } from './branding.js';
const exec = promisify(execFile);
let dir: string, video: Buffer, logo: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'branding-'));
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'in.mp4')]);
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=120x40', '-frames:v', '1', join(dir, 'logo.png')]);
  video = await readFile(join(dir, 'in.mp4'));
  logo = 'data:image/png;base64,' + (await readFile(join(dir, 'logo.png'))).toString('base64');
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const duration = async (path: string) => Number((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])).stdout);
it('derives the wallpaper and card colour from the brand', () => {
  expect(brandWallpaper(undefined)).toBeUndefined();
  expect(brandWallpaper({ background: 'ocean' })).toContain('#083344');
  expect(brandWallpaper({ background: '#112233' })).toBe('#112233');
  expect(brandWallpaper({ accent: '#ff8800' })).toMatch(/^linear-gradient\(135deg, #[0-9a-f]{6} 0%, #ff8800 100%\)$/);
  expect(cardColour({ accent: '#ff8800' })).toMatch(/^#[0-9a-f]{6}$/);
  expect(cardColour({ background: 'sunset' })).toBe('#4a2a6b');
});
it('leaves the video untouched without a logo, overlays a logo, and adds intro/outro cards', async () => {
  expect((await applyBrand(video, { accent: '#ff8800' })).bytes).toBe(video);
  const overlaid = await applyBrand(video, { logo, logoPosition: 'top-left' });
  expect(overlaid.applied).toEqual(['logo']);
  await writeFile(join(dir, 'logo-only.mp4'), overlaid.bytes);
  expect(await duration(join(dir, 'logo-only.mp4'))).toBeCloseTo(2, 0);
  const carded = await applyBrand(video, { logo, cards: true, accent: '#ff8800' });
  expect(carded.applied).toEqual(['logo', 'cards']);
  await writeFile(join(dir, 'cards.mp4'), carded.bytes);
  const total = await duration(join(dir, 'cards.mp4')); expect(total).toBeGreaterThan(4.5); expect(total).toBeLessThan(6);
}, 60000);
it('produces a looping GIF from the MP4', async () => {
  await makeGif(join(dir, 'in.mp4'), join(dir, 'demo.gif'), undefined, 320);
  const gif = await readFile(join(dir, 'demo.gif'));
  expect(gif.subarray(0, 6).toString()).toBe('GIF89a');
  expect(gif.length).toBeGreaterThan(1000);
}, 60000);
it('blurs odd-placed and tiny regions without changing the frame', async () => {
  const out = join(dir, 'redacted.mp4');
  await redactRegions(join(dir, 'in.mp4'), out, [
    { x: 0.1013, y: 0.2207, width: 0.31, height: 0.07, startMs: 0, endMs: 1500 },
    { x: 0.5, y: 0.5, width: 0.004, height: 0.006, startMs: 0, endMs: 2000 },
  ]);
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]);
  expect(stdout.trim()).toBe('640,360');
  expect(await duration(out)).toBeCloseTo(2, 0);
}, 60000);
