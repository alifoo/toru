import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assessDemo } from './quality.js';
const run = promisify(execFile);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'toru-quality-'));
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=3', '-pix_fmt', 'yuv420p', join(dir, 'blank.mp4')]);
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=3', '-pix_fmt', 'yuv420p', join(dir, 'moving.mp4')]);
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=0.5', '-pix_fmt', 'yuv420p', join(dir, 'short.mp4')]);
  await writeFile(join(dir, 'garbage.mp4'), 'rendered');
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

it('rejects a blank white video and accepts a moving one', async () => {
  const blank = await assessDemo(join(dir, 'blank.mp4'), { semanticTimeline: [], pointerTrail: [] });
  expect(blank.passed).toBe(false); expect(blank.reasons).toContain('blank_frames'); expect(blank.metrics.durationMs).toBeGreaterThan(2000);
  const moving = await assessDemo(join(dir, 'moving.mp4'), { semanticTimeline: [], pointerTrail: [] });
  expect(moving.passed).toBe(true); expect(moving.reasons).toEqual([]); expect(moving.metrics.maxTemporalDiff).toBeGreaterThan(0.3);
});
it('rejects videos that are too short and skips files ffmpeg cannot read', async () => {
  expect((await assessDemo(join(dir, 'short.mp4'), undefined)).reasons).toContain('too_short');
  const garbage = await assessDemo(join(dir, 'garbage.mp4'), undefined);
  expect(garbage).toMatchObject({ passed: true, skipped: true, reasons: ['unassessable'] });
});
