import { describe, expect, it } from 'vitest';
import { scrollAmount } from './recorder.js';

describe('scrollAmount', () => {
  it('hands Toru for Chrome 100px wheel ticks and a Mac its pixels', () => {
    expect(scrollAmount({}, 450)).toBe(5);
    expect(scrollAmount({}, 300)).toBe(3);
    expect(scrollAmount({}, 3000)).toBe(10);
    expect(scrollAmount({}, 20)).toBe(1);
    expect(scrollAmount({ capturePrivacy: 'user-approved-desktop' }, 450)).toBe(450);
  });
});
