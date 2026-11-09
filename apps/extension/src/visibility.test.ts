import { describe, expect, it } from 'vitest';
import { HiddenRanges, probeVisibility, typingPainted, visibilityScript, watched, type PageVisibility } from './visibility.js';

/** Runs the page check against a fake page: its visibility, and whether it draws an animation frame. */
function page(visibilityState: 'visible' | 'hidden', draws: boolean, busyMs = 0) {
  const run = new Function('document', 'requestAnimationFrame', 'performance', `return ${visibilityScript}`);
  const started = performance.now();
  // A busy main thread: every timer reads the clock that much later.
  const clock = { now: () => performance.now() + (performance.now() - started > 1 ? busyMs : 0) };
  return run({ visibilityState }, (callback: () => void) => { if (draws) setTimeout(callback, 16); }, clock) as string | Promise<string>;
}

describe('page visibility check', () => {
  it('reads a hidden page at once, a drawn one by its next frame, and a free page with no frame as stalled', async () => {
    expect(await page('hidden', false)).toBe('hidden');
    expect(await page('visible', true)).toBe('visible');
    expect(await page('visible', false)).toBe('stalled');
    // A main thread busy past the wait is not a window Chrome stopped drawing.
    expect(await page('visible', false, 1_000)).toBe('busy');
  });

  it('asks the page over the debugger, checks a stall twice, and gives no verdict when the page cannot answer', async () => {
    const answers: unknown[] = [];
    const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    const channel = { send: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { result: { value: next } };
    } };
    answers.push('hidden');
    expect(await probeVisibility(channel)).toBe('hidden');
    expect(calls[0]).toMatchObject({ method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true } });
    answers.push('stalled', 'visible');
    expect(await probeVisibility(channel)).toBe('visible');
    answers.push('stalled', 'stalled');
    expect(await probeVisibility(channel)).toBe('stalled');
    answers.push('busy');
    expect(await probeVisibility(channel)).toBe('visible');
    answers.push(new Error('Cannot find context with specified id'));
    expect(await probeVisibility(channel)).toBeUndefined();
  });
});

describe('hidden ranges', () => {
  it('runs each range from the last check that found the page drawn to the next one that does', () => {
    const ranges = new HiddenRanges();
    ranges.saw('visible', 1_000);
    ranges.saw('visible', 5_000);
    // An action ran after the check at 5 s; the check after it found the window hidden.
    ranges.saw('hidden', 9_000);
    // Refused actions while the user brings the window back.
    ranges.saw('hidden', 20_000);
    ranges.saw('visible', 31_000);
    ranges.saw('visible', 40_000);
    ranges.saw('stalled', 42_000);
    expect(ranges.list()).toEqual([{ startMs: 5_000, endMs: 31_000 }, { startMs: 40_000, endMs: 42_000 }]);
  });

  it('starts at the recording when the first check finds the window hidden', () => {
    const ranges = new HiddenRanges();
    ranges.saw('hidden', 3_000);
    expect(ranges.list()).toEqual([{ startMs: 0, endMs: 3_000 }]);
  });
});

describe('typing painted', () => {
  it('waits briefly for a late frame, and fails typing that brought none', async () => {
    let frames = 10;
    setTimeout(() => { frames = 11; }, 100);
    expect(await typingPainted(10, () => frames, 500)).toBe(true);
    expect(await typingPainted(11, () => frames, 150)).toBe(false);
    // No recording socket: nothing to judge by.
    expect(await typingPainted(3, () => undefined)).toBe(true);
  });
});

describe('commands while recording', () => {
  function harness(states: Array<PageVisibility | undefined>, options: { painted?: boolean; recording?: boolean } = {}) {
    const log: string[] = [];
    let frames = 0, now = 10_000;
    const hidden = new HiddenRanges();
    const seen: PageVisibility[] = [];
    const run = (method: string, args: unknown[] = []) => watched({
      method, args, clock: options.recording === false ? undefined : () => (now += 100), hidden, graceMs: 60,
      probe: async () => { log.push('probe'); return states.shift(); },
      frames: () => frames,
      bringToFront: async () => { log.push('front'); },
      seen: (state) => seen.push(state),
      act: async () => { log.push(method); if (options.painted !== false) frames++; return 'done'; },
    });
    return { run, log, hidden, seen };
  }

  it('runs a page action on a drawn window and checks it again after', async () => {
    const page = harness(['visible', 'visible']);
    expect(await page.run('pointer')).toBe('done');
    expect(page.log).toEqual(['probe', 'pointer', 'probe']);
    expect(page.hidden.list()).toEqual([]);
  });

  it('refuses a page action while the window is hidden, without performing it', async () => {
    const page = harness(['hidden']);
    await expect(page.run('typeText', [' video'])).rejects.toThrow('recording_window_hidden');
    expect(page.log).toEqual(['probe']);
    expect(page.seen).toEqual(['hidden']);
  });

  it('brings a covered window to the front for an observation, and refuses it when that does not help', async () => {
    const rescued = harness(['hidden', 'visible', 'visible']);
    expect(await rescued.run('screenshot')).toBe('done');
    expect(rescued.log).toEqual(['probe', 'front', 'probe', 'screenshot', 'probe']);
    const lost = harness(['hidden', 'hidden']);
    await expect(lost.run('screenshot')).rejects.toThrow('recording_window_hidden');
    expect(lost.log).toEqual(['probe', 'front', 'probe']);
  });

  it('marks an action the window was hidden during, from the check before it', async () => {
    const page = harness(['visible', 'hidden']);
    await page.run('gesture', ['underline']);
    expect(page.seen).toEqual(['visible', 'hidden']);
    expect(page.hidden.list()).toEqual([{ startMs: 10_100, endMs: 10_200 }]);
  });

  it('counts typing that brought no new frame as not drawn, whatever the page says', async () => {
    const page = harness(['visible', 'visible'], { painted: false });
    await page.run('typeText', [' video']);
    expect(page.seen.at(-1)).toBe('stalled');
    expect(page.hidden.list()).toHaveLength(1);
    const typed = harness(['visible', 'visible']);
    await typed.run('typeText', [' video']);
    expect(typed.seen.at(-1)).toBe('visible');
  });

  it('only checks while recording, and lets reads run unchecked before them', async () => {
    const idle = harness([], { recording: false });
    expect(await idle.run('pointer')).toBe('done');
    expect(idle.log).toEqual(['pointer']);
    const reading = harness(['hidden']);
    expect(await reading.run('readPage')).toBe('done');
    expect(reading.log).toEqual(['readPage', 'probe']);
  });

  it('gives no verdict when the page cannot answer', async () => {
    const page = harness([undefined, undefined]);
    expect(await page.run('pressKey', ['Enter'])).toBe('done');
    expect(page.seen).toEqual([]);
  });
});
