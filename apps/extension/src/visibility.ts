import type { DebuggerChannel } from '../../../packages/browser/src/cdp-webdriver.js';

/**
 * Whether Chrome is drawing the recorded page.
 *
 * Chrome stops compositing a window that is hidden, minimized, fully covered by another app or on another desktop
 * (a window manager such as AeroSpace parks the windows of other workspaces off screen): Page.startScreencast sends no
 * frames, requestAnimationFrame and CSS animations pause and pointer events are throttled. Nothing done to the page
 * then reaches the video, and Toru cannot make Chrome draw it; it can only notice and say so.
 *
 * `hidden`: the page says so (document.visibilityState). `stalled`: it says it is visible, its main thread is free,
 * yet no animation frame comes (a window Chrome stopped drawing without telling the page). `visible` otherwise,
 * including a page too busy to answer in time, which is drawing as soon as it is free.
 */
export type PageVisibility = 'visible' | 'hidden' | 'stalled';

/** How long a free page may go without an animation frame before it counts as not drawn. */
const frameWaitMs = 400;
/** A timer that fires this late means the main thread was busy, not that the window is not drawn. */
const lateTimerMs = 650;

export const visibilityScript = `(()=>{if(document.visibilityState==='hidden')return 'hidden';
return new Promise(done=>{const start=performance.now();
const timer=setTimeout(()=>done(performance.now()-start<${lateTimerMs}?'stalled':'busy'),${frameWaitMs});
requestAnimationFrame(()=>{clearTimeout(timer);done('visible');});});})()`;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One check, bounded: undefined when the page cannot answer (a navigation in progress), which is not a verdict. */
async function check(channel: Pick<DebuggerChannel, 'send'>): Promise<PageVisibility | undefined> {
  try {
    const answer = await Promise.race([
      channel.send('Runtime.evaluate', { expression: visibilityScript, awaitPromise: true, returnByValue: true }),
      pause(3_000).then(() => undefined),
    ]) as { result?: { value?: unknown } } | undefined;
    const value = answer?.result?.value;
    if (value === 'busy') return 'visible';
    return value === 'visible' || value === 'hidden' || value === 'stalled' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the page is drawing; a page that seems not to is checked a second time before it counts as stalled. */
export async function probeVisibility(channel: Pick<DebuggerChannel, 'send'>): Promise<PageVisibility | undefined> {
  const first = await check(channel);
  if (first !== 'stalled') return first;
  return await check(channel);
}

/**
 * Where the page was not drawn, on the recording clock. A range runs from the last check that found the page drawing
 * to the first that found it drawing again, so an action that ran between a good check and a bad one lies inside it,
 * while the agent waiting for the user to bring the window back (no action) only makes a range nothing touches.
 */
export class HiddenRanges {
  private readonly ranges: Array<{ startMs: number; endMs: number }> = [];
  private current: { startMs: number; endMs: number } | undefined;
  private lastDrawnAt = 0;
  /** A check at `atMs` on the recording clock found the page `state`. */
  saw(state: PageVisibility, atMs: number) {
    const at = Math.max(0, Math.round(atMs));
    if (state === 'visible') {
      if (this.current) { this.current.endMs = Math.max(this.current.endMs, at); this.current = undefined; }
      this.lastDrawnAt = at;
      return;
    }
    if (this.current) { this.current.endMs = Math.max(this.current.endMs, at); return; }
    if (this.ranges.length >= 500) return;
    this.current = { startMs: Math.min(this.lastDrawnAt, at), endMs: at };
    this.ranges.push(this.current);
  }
  list() { return this.ranges.map((range) => ({ ...range })); }
}

/**
 * Typing paints every character at once. When typing ends with no new frame since it started (waiting `graceMs` for
 * a late one), Chrome was not drawing the page, whatever the page reports.
 */
export async function typingPainted(framesBefore: number, frames: () => number | undefined, graceMs = 500): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const now = frames();
    if (now === undefined || now > framesBefore) return true;
    if (Date.now() >= deadline) return false;
    await pause(50);
  }
}

/** What changes the page: while recording, each is refused when Chrome is not drawing the window. */
export const PAGE_ACTIONS = ['goto', 'pointer', 'gesture', 'formInput', 'typeText', 'pressKey', 'scrollBy'];
const drawn = (state: PageVisibility | undefined) => state !== 'hidden' && state !== 'stalled';

/**
 * Runs one command of a recording session with the window's state checked around it. Outside a recording (`clock`
 * undefined) it just runs.
 *
 * While recording, a page action is refused (recording_window_hidden) when Chrome is not drawing the window, rather
 * than performed unseen: a step that ran and is missing from the video breaks the take (typed text that never
 * appears, a dialog frozen mid-fade), while a refused one is simply done again once the user brings the window back.
 * An observation first tries bringing the window to the front, which paints a window another one covers; one on
 * another desktop or minimized stays unseen, and the observation is refused too instead of waiting on a screenshot
 * Chrome will not take. After every command the page is checked again, and typing that brought no new frame counts
 * as not drawn whatever the page says. `seen` hears the command's last verdict.
 */
export async function watched<T>(input: {
  method: string; args: unknown[]; clock: (() => number) | undefined; hidden: HiddenRanges;
  probe: () => Promise<PageVisibility | undefined>; frames: () => number | undefined; bringToFront: () => Promise<void>;
  seen: (state: PageVisibility) => void; act: () => T | Promise<T>; graceMs?: number;
}): Promise<T> {
  const { clock } = input;
  if (!clock) return await input.act();
  const look = async () => {
    const state = await input.probe();
    if (state) { input.hidden.saw(state, clock()); input.seen(state); }
    return state;
  };
  if (PAGE_ACTIONS.includes(input.method) || input.method === 'screenshot') {
    let state = await look();
    if (!drawn(state) && input.method === 'screenshot') {
      await input.bringToFront();
      await pause(300);
      state = await look();
    }
    if (!drawn(state)) throw new Error('recording_window_hidden');
  }
  const text = input.method === 'typeText' ? input.args[0] : input.method === 'formInput' ? input.args[1] : undefined;
  const framesBefore = typeof text === 'string' && text.length > 0 ? input.frames() : undefined;
  const value = await input.act();
  const unpainted = framesBefore !== undefined && !await typingPainted(framesBefore, input.frames, input.graceMs);
  if (unpainted) input.hidden.saw('stalled', clock());
  await look();
  if (unpainted) input.seen('stalled');
  return value;
}
