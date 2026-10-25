import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type StillRange = { startMs: number; endMs: number };

/**
 * Where the recorded picture holds still for half a second or more: the page waiting on a server, a navigation, the
 * driver checking a target. Measured small and at a low frame rate, which finds the same stretches in a fraction of
 * the time; the tolerance lets a loading bar or spinner count as still. Undefined when ffmpeg cannot read the video,
 * so the render falls back to cutting only the gaps between calls.
 */
export async function detectStillRanges(videoPath: string, durationMs: number, signal?: AbortSignal): Promise<StillRange[] | undefined> {
  try {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', videoPath, '-map', '0:v:0',
      '-vf', 'fps=15,scale=480:-2,freezedetect=n=0.003:d=0.5', '-f', 'null', '-'],
    { timeout: 90_000, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) });
    return parseFreezes(stderr, durationMs);
  } catch {
    return undefined;
  }
}

/** ffmpeg's freezedetect log as ranges; a still that runs to the end has no end line. */
export function parseFreezes(log: string, durationMs: number): StillRange[] {
  const ranges: StillRange[] = [];
  let start: number | undefined;
  for (const match of log.matchAll(/freeze_(start|end): ([0-9.]+)/g)) {
    const at = Math.round(Number(match[2]) * 1000);
    if (match[1] === 'start') start = at;
    else if (start !== undefined) { ranges.push({ startMs: start, endMs: at }); start = undefined; }
  }
  if (start !== undefined && durationMs > start) ranges.push({ startMs: start, endMs: durationMs });
  return ranges;
}
