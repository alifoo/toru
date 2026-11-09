import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureGapsFrom, detectCaptureGaps, parseFreezes } from './stills.js';
const run = promisify(execFile);

describe('parseFreezes', () => {
  it('reads freezedetect ranges, closing one that runs to the end', () => {
    const log = [
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 0',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 9.266667',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 9.266667',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 86.7',
    ].join('\n');
    expect(parseFreezes(log, 111_300)).toEqual([
      { startMs: 0, endMs: 9_267 },
      { startMs: 86_700, endMs: 111_300 },
    ]);
  });

  it('returns nothing for a video that never holds still', () => {
    expect(parseFreezes('frame= 100 fps=0.0', 10_000)).toEqual([]);
  });
});

describe('capture gaps', () => {
  it('finds the stretches without a new frame, in any packet order, the end included', () => {
    // The Linear take: frames stopped while its window sat on another workspace.
    expect(captureGapsFrom([108_800, 0, 30, 5_400, 103_000, 104_500, 106_000, 107_500, 127_000, 127_100, 162_400], 175_000)).toEqual([
      { startMs: 30, endMs: 5_400 }, { startMs: 5_400, endMs: 103_000 }, { startMs: 108_800, endMs: 127_000 },
      { startMs: 127_100, endMs: 162_400 }, { startMs: 162_400, endMs: 175_000 },
    ]);
    expect(captureGapsFrom([0, 500, 1_000, 2_900], 3_000)).toEqual([]);
    expect(captureGapsFrom([], 3_000)).toEqual([]);
  });

  it('reads them from a variable frame rate video, and nothing from a file ffprobe cannot read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toru-gaps-'));
    try {
      // Ten frames a second with none between 1 s and 4 s, as Chrome sends while it does not draw the window.
      await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=160x90:d=6:r=10', '-vf', "select='not(between(t,1,4))'",
        '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', join(dir, 'vfr.mp4')]);
      expect(await detectCaptureGaps(join(dir, 'vfr.mp4'), 6_000)).toEqual([{ startMs: 900, endMs: 4_100 }]);
      await writeFile(join(dir, 'garbage.mp4'), 'not a video');
      expect(await detectCaptureGaps(join(dir, 'garbage.mp4'), 6_000)).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
