import { expect, it } from 'vitest';
import { MAX_CAPTURE_MS } from './local-protocol.js';
import { renderBitrate, renderDeadlineMs } from './recorder.js';

it('gives a long Studio take a render deadline and bitrate that fit, and leaves short ones as they were', () => {
  expect(renderDeadlineMs(undefined)).toBe(10 * 60_000);
  expect(renderDeadlineMs(300_000)).toBe(10 * 60_000);
  expect(renderDeadlineMs(1_200_000)).toBe(40 * 60_000);
  expect(renderBitrate(300_000)).toBe(8_000_000);
  // Twenty minutes at the lowered bitrate stays under 450 MB.
  expect(renderBitrate(1_200_000) * 1_200_000 / 1000 / 8).toBeLessThanOrEqual(450 * 1024 ** 2);
  expect(renderBitrate(1_200_000)).toBeGreaterThanOrEqual(3_000_000);
  // Studio's 20 minutes (hosted-policy) plus the stop is the longest a device may report.
  expect(MAX_CAPTURE_MS).toBe(1_205_000);
});
