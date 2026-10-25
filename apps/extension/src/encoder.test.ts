import { QUALITY_HIGH } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { avcBitrate, chooseEncoding, encodingCandidates } from './encoder.js';

const capture = { width: 2560, height: 1440 };

describe('Toru for Chrome encoder size', () => {
  it('tries 2560x1440 on a hardware encoder first, then 1920x1080 and 1280x720, then VP8', () => {
    expect(encodingCandidates(capture, capture).map(({ codec, width, height, hardwareAcceleration }) => [codec, width, height, hardwareAcceleration ?? 'any'])).toEqual([
      ['avc', 2560, 1440, 'prefer-hardware'], ['avc', 1920, 1080, 'any'], ['avc', 1280, 720, 'any'], ['vp8', 1280, 720, 'any'],
    ]);
  });

  it('never encodes larger than the frames: a screen showing the tab at 1x records 1280x720', () => {
    expect(encodingCandidates(capture, { width: 1280, height: 720 }).map(({ codec, width, height }) => [codec, width, height])).toEqual([
      ['avc', 1280, 720], ['vp8', 1280, 720],
    ]);
    // Smaller still (a cropped frame): the smallest step, fitted with bars, as before.
    expect(encodingCandidates(capture, { width: 900, height: 600 }).map(({ width }) => width)).toEqual([1280, 1280]);
  });

  it('targets bitrates that keep small text sharp at each size', () => {
    expect(avcBitrate({ width: 2560, height: 1440 })).toBe(6_000_000);
    expect(avcBitrate({ width: 1920, height: 1080 })).toBe(4_000_000);
    expect(avcBitrate({ width: 1280, height: 720 })).toBe(QUALITY_HIGH);
    // H.264 level 5.0 allows 135 Mbps and 2560x1440 at 30fps; level 4.x does not fit 1440p at all.
    expect(avcBitrate({ width: 2560, height: 1440 }) as number).toBeLessThan(135_000_000);
    // The longest recording (5 minutes) at the full target fits the 256 MB upload limit.
    expect((avcBitrate({ width: 2560, height: 1440 }) as number) * 300 / 8).toBeLessThan(256 * 1024 ** 2 * 0.9);
  });

  it('falls back to 1920x1080, then 1280x720, then VP8, when the browser cannot encode the larger size', async () => {
    const only = (allowed: string[]) => vi.fn(async (codec: string, options: { width: number; hardwareAcceleration?: string }) =>
      allowed.includes(`${codec}${options.width}${options.hardwareAcceleration ? 'hw' : ''}`));
    expect(await chooseEncoding(capture, capture, only(['avc2560hw', 'avc1920']))).toMatchObject({ codec: 'avc', width: 2560, height: 1440, bitrate: 6_000_000 });
    expect(await chooseEncoding(capture, capture, only(['avc1920', 'avc1280']))).toMatchObject({ codec: 'avc', width: 1920, height: 1080, bitrate: 4_000_000 });
    expect(await chooseEncoding(capture, capture, only(['avc1280']))).toMatchObject({ codec: 'avc', width: 1280, height: 720 });
    expect(await chooseEncoding(capture, capture, only(['vp81280']))).toMatchObject({ codec: 'vp8', width: 1280, height: 720 });
    const failing = vi.fn(async () => { throw new Error('VideoEncoder missing'); });
    await expect(chooseEncoding(capture, capture, failing)).rejects.toThrow('video_encoder_unavailable');
    expect(failing).toHaveBeenCalledTimes(4);
  });

  it('keeps the ladder in even sizes for 1440x900 captured at 16/9 (2560x1600)', () => {
    const tall = { width: 2560, height: 1600 };
    expect(encodingCandidates(tall, tall).map(({ codec, width, height }) => [codec, width, height])).toEqual([
      ['avc', 2560, 1600], ['avc', 1920, 1200], ['avc', 1280, 800], ['vp8', 1280, 800],
    ]);
    expect(avcBitrate(tall)).toBe(6_667_000);
  });

  it('encodes 1x frames of a wider viewport at their own size: 1920x1080 and 1440x900 shown on a 1x screen', () => {
    expect(encodingCandidates(capture, { width: 1920, height: 1080 }).map(({ codec, width, height }) => [codec, width, height])).toEqual([
      ['avc', 1920, 1080], ['avc', 1280, 720], ['vp8', 1280, 720],
    ]);
    expect(encodingCandidates({ width: 2560, height: 1600 }, { width: 1440, height: 900 }).map(({ codec, width, height }) => [codec, width, height])).toEqual([
      ['avc', 1440, 900], ['avc', 1280, 800], ['vp8', 1280, 800],
    ]);
  });
});
