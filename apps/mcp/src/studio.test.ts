import { expect, it } from 'vitest';
import { CARD_MS, renderTimeline, studioFor, type RenderTimeline } from './studio.js';
import type { RunPlan } from './run-plan.js';

const steps: RunPlan['steps'] = [
  { screen: 'Issues', action: 'click', target: 'row "CSV export times out"', expect: 'The issue opens' },
  { screen: 'Issue', action: 'select', target: 'menu "Done"', expect: 'Status reads Done' },
  { screen: 'Issue', action: 'wait', target: 'the toast', expect: 'A toast confirms' },
  { screen: 'Issues', action: 'type', target: 'field "Title"', value: 'Record the launch video', expect: 'The title is filled' },
];
const timeline = (over: Partial<RenderTimeline> = {}): RenderTimeline => ({
  version: 1, renderedAt: 0, sourceDurationMs: 20_000, outputDurationMs: 18_000 + 2 * CARD_MS, introMs: CARD_MS, outroMs: CARD_MS,
  cuts: [{ startMs: 6_000, endMs: 8_000 }], speeds: [],
  zoomRegions: [{ startMs: 1_000, endMs: 3_000, customScale: 1.55, focus: { cx: 0.3, cy: 0.2 }, focusMode: 'manual', element: 'row CSV export times out' }],
  semanticTimeline: [
    { type: 'setup', atMs: 100, ref: null, element: 'Focus' },
    { type: 'click', atMs: 2_000, ref: null, element: 'row CSV export times out on large workspaces' },
    { type: 'click', atMs: 5_000, ref: null, element: 'menuitem Done' },
    { type: 'type', atMs: 10_000, endMs: 12_000, ref: null, element: 'textbox Title' },
  ],
  cursor: { scale: 2.4, smooth: true },
  settings: { padding: 30, width: 1920, height: 1080, gif: true, logo: true, cards: true, zoom: { enabled: true }, compressPauses: true },
  ...over,
});

it('places matched steps on the delivered clock and leaves unlabelled ones unplaced', () => {
  const studio = studioFor(steps, timeline());
  expect(studio.steps.map(step => [step.matched, step.startMs, step.endMs])).toEqual([
    [true, 3_500, 6_500],
    [true, 6_500, 9_500],
    [false, undefined, undefined],
    // After the 2 s cut: 10 000 − 2 000 + 1 500.
    [true, 9_500, 19_500],
  ]);
  expect(studio.zooms).toEqual([{ startMs: 2_500, endMs: 4_500, scale: 1.55, element: 'row CSV export times out' }]);
  expect(studio.cuts).toEqual([{ atMs: 7_500, removedMs: 2_000 }]);
});

it('never matches a step to an action before the previous step', () => {
  const studio = studioFor([steps[1]!, steps[0]!], timeline());
  expect(studio.steps.map(step => step.matched)).toEqual([true, false]);
});

it('builds a timeline from the render, with the cards and without the logo bytes', () => {
  const built = renderTimeline({ width: 1280, height: 720, frameRate: 60, durationMs: 10_000, pointerTrail: [], pointerTelemetry: [], semanticTimeline: [] },
    { trimRegions: [{ id: 'cut-0', startMs: 2_000, endMs: 3_000 }], speedRegions: [], zoomRegions: [], cursorScale: 2.4, padding: 30, borderRadius: 12, width: 1920, height: 1080 },
    { brand: { logo: 'data:image/png;base64,iVBORxyz', cards: true }, applied: ['logo', 'cards'], gif: false, compressPauses: true }, 1);
  expect(built).toMatchObject({ introMs: CARD_MS, outroMs: CARD_MS, outputDurationMs: 10_000 - 1_000 + 2 * CARD_MS,
    settings: { logo: true, logoPosition: 'bottom-right', cards: true, radius: 12, zoom: { enabled: true } } });
  expect(JSON.stringify(built)).not.toContain('iVBOR');
});
