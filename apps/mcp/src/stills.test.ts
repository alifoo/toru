import { describe, expect, it } from 'vitest';
import { parseFreezes } from './stills.js';

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
