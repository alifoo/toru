import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reviewCamera, type CaptureObservation, type ExporterConfig } from '@content-layer/render-contract';
const run = promisify(execFile);

export type QualityVerdict = {
  passed: boolean;
  skipped?: boolean;
  reasons: string[];
  metrics: { durationMs?: number; frames?: number; maxTemporalDiff?: number; maxLumaRange?: number; actions?: number; pointerSamples?: number };
};
export type QualityAssessor = (
  videoPath: string, observation: Partial<CaptureObservation> | undefined, config?: ExporterConfig,
) => Promise<QualityVerdict>;

/**
 * Decides whether a rendered demo is worth delivering (and charging for): long enough, visibly changing, not a blank
 * frame. A video ffmpeg cannot read is not judged (`skipped`), so unit fixtures and odd encoders are never blocked.
 * With the render's config, a directed demo's camera is judged too: late on a click, or pumping (`reviewCamera`).
 */
export const assessDemo: QualityAssessor = async (videoPath, observation, config) => {
  const camera = config && observation?.pointerTrail ? reviewCamera(config, observation as CaptureObservation) : [];
  const metrics: QualityVerdict['metrics'] = {
    actions: observation?.semanticTimeline?.length ?? 0, pointerSamples: observation?.pointerTrail?.length ?? 0,
  };
  let durationMs: number;
  try {
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', videoPath], { timeout: 20_000 });
    durationMs = Math.round(Number(JSON.parse(probe.stdout).format?.duration) * 1000);
    if (!Number.isFinite(durationMs)) throw new Error('duration');
  } catch { return { passed: camera.length === 0, skipped: true, reasons: ['unassessable', ...camera], metrics }; }
  metrics.durationMs = durationMs;
  const reasons: string[] = [...camera];
  if (durationMs < 1500) reasons.push('too_short');
  try {
    // Two samples per second: YDIF is the mean absolute difference to the previous frame, YMIN/YMAX the luma range.
    const stats = await run('ffmpeg', ['-v', 'error', '-i', videoPath, '-vf', 'fps=2,signalstats,metadata=print:file=-', '-f', 'null', '-'], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    let frames = 0, maxDiff = 0, maxRange = 0, min = 255, max = 0;
    for (const line of stats.stdout.split('\n')) {
      const m = /lavfi\.signalstats\.(YDIF|YMIN|YMAX)=([0-9.]+)/.exec(line);
      if (!m) continue;
      const value = Number(m[2]);
      if (m[1] === 'YDIF') { frames++; maxDiff = Math.max(maxDiff, value); }
      if (m[1] === 'YMIN') min = value;
      if (m[1] === 'YMAX') { max = value; maxRange = Math.max(maxRange, max - min); }
    }
    Object.assign(metrics, { frames, maxTemporalDiff: maxDiff, maxLumaRange: maxRange });
    if (frames > 0) {
      if (maxRange < 24) reasons.push('blank_frames');
      else if (maxDiff < 0.3) reasons.push('static_video');
    }
  } catch { return { passed: reasons.length === 0, skipped: true, reasons: [...reasons, 'frames_unassessable'], metrics }; }
  return { passed: reasons.length === 0, reasons, metrics };
};
