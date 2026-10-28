import type { CaptureSemanticAction } from '@content-layer/browser';
import { outputTimeMs, type CaptureObservation, type ExporterConfig, type TimeRange } from '@content-layer/render-contract';
import { label, type RunPlan } from './run-plan.js';
import type { Brand } from './store/brands.js';

/** The length of each intro and outro card `applyBrand` adds around a branded video. */
export const CARD_MS = 1_500;

/**
 * What one delivered render did, kept beside the video as `timeline.json`: the edit (cuts, faster spans, cards), the
 * camera's shots and the page actions on the source clock, and the settings it used. The brand's logo is left out.
 * Written only for a delivered video, so it always describes the `video.mp4` next to it.
 */
export type RenderTimeline = {
  version: 1;
  renderedAt: number;
  sourceDurationMs: number;
  outputDurationMs: number;
  introMs: number;
  outroMs: number;
  cuts: TimeRange[];
  speeds: Array<TimeRange & { speed: number }>;
  zoomRegions: Array<TimeRange & { customScale: number; focus: { cx: number; cy: number }; focusMode: string; intent?: string; element?: string }>;
  semanticTimeline: CaptureSemanticAction[];
  cursor: { scale: number; smooth: boolean };
  settings: {
    background?: string; padding: number; radius?: number; width: number; height: number; gif: boolean;
    logo: boolean; logoPosition?: string; cards: boolean; zoom: { enabled: boolean; scale?: number }; compressPauses: boolean;
  };
};

const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const rangesOf = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is Record<string, unknown> =>
  Boolean(item) && typeof item === 'object' && Number.isFinite((item as TimeRange).startMs) && Number.isFinite((item as TimeRange).endMs));

/** The timeline of a render, from the observation it rendered and the exporter configuration it used. */
export function renderTimeline(observation: CaptureObservation, config: ExporterConfig,
  used: { brand?: Brand | undefined; applied: string[]; gif: boolean; compressPauses: boolean }, renderedAt = Date.now()): RenderTimeline {
  const cards = used.applied.includes('cards');
  const introMs = cards ? CARD_MS : 0, outroMs = cards ? CARD_MS : 0;
  const cuts = rangesOf(config.trimRegions).map(range => ({ startMs: finite(range.startMs), endMs: finite(range.endMs) }));
  const speeds = rangesOf(config.speedRegions).filter(range => finite(range.speed) > 0)
    .map(range => ({ startMs: finite(range.startMs), endMs: finite(range.endMs), speed: finite(range.speed, 1) }));
  const zoomRegions = rangesOf(config.zoomRegions).map(region => {
    const focus = region.focus as { cx?: unknown; cy?: unknown } | undefined;
    return { startMs: finite(region.startMs), endMs: finite(region.endMs), customScale: finite(region.customScale, 1),
      focus: { cx: finite(focus?.cx, 0.5), cy: finite(focus?.cy, 0.5) }, focusMode: String(region.focusMode ?? 'manual'),
      ...(typeof region.intent === 'string' ? { intent: region.intent } : {}), ...(typeof region.element === 'string' ? { element: region.element.slice(0, 200) } : {}) };
  });
  const brand = used.brand;
  return {
    version: 1, renderedAt, sourceDurationMs: observation.durationMs,
    outputDurationMs: outputTimeMs(observation.durationMs, { cuts, speeds, introMs }) + outroMs,
    introMs, outroMs, cuts, speeds, zoomRegions,
    semanticTimeline: (observation.semanticTimeline ?? []).map(moment => ({ ...moment, element: moment.element.slice(0, 200) })),
    cursor: { scale: finite(config.cursorScale, 1), smooth: brand?.cursor?.smooth !== false },
    settings: {
      ...(brand?.background ? { background: brand.background } : {}),
      padding: finite(config.padding), ...(typeof config.borderRadius === 'number' ? { radius: config.borderRadius } : {}),
      width: finite(config.width), height: finite(config.height), gif: used.gif,
      logo: Boolean(brand?.logo), ...(brand?.logo ? { logoPosition: brand.logoPosition ?? 'bottom-right' } : {}), cards,
      zoom: { enabled: brand?.zoom?.enabled !== false, ...(brand?.zoom?.scale !== undefined ? { scale: brand.zoom.scale } : {}) },
      compressPauses: used.compressPauses,
    },
  };
}

/** A plan step placed on the delivered video's clock. Unmatched steps have no times: the navigator's actions are not
 * numbered by step, so a step is placed only when an action on the page carries its label. */
export type StudioStep = Pick<RunPlan['steps'][number], 'screen' | 'action' | 'target' | 'value' | 'expect'> & {
  index: number; matched: boolean; startMs?: number; endMs?: number;
};
/** What the console's run screen draws: steps, shots and cuts on the delivered video's clock, and the settings used. */
export type RunStudio = {
  outputDurationMs: number; introMs: number; outroMs: number;
  steps: StudioStep[];
  zooms: Array<TimeRange & { scale: number; element?: string; intent?: string }>;
  cuts: Array<{ atMs: number; removedMs: number }>;
  cursor: RenderTimeline['cursor'];
  settings: RenderTimeline['settings'];
};

/** Which page actions can carry out a plan action. */
const carries: Record<RunPlan['steps'][number]['action'], ReadonlyArray<CaptureSemanticAction['type']>> = {
  click: ['click', 'double_click', 'right_click', 'action'], type: ['type'], select: ['click', 'type', 'action'], press: ['key'],
  scroll: ['scroll'], navigate: ['navigate', 'click'], wait: [],
  point: ['emphasis'], trace: ['emphasis'], sweep: ['emphasis'], highlight: ['emphasis'], read: ['scroll'],
};
const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Matches the plan's steps, in order, to the page actions the capture recorded, then moves everything onto the delivered
 * video's clock. A step's start is its action; it runs until the next placed step, the last one until the outro.
 */
export function studioFor(steps: RunPlan['steps'], timeline: RenderTimeline): RunStudio {
  const moments = [...timeline.semanticTimeline].filter(moment => moment.type !== 'setup').sort((a, b) => a.atMs - b.atMs);
  const edit = { cuts: timeline.cuts, speeds: timeline.speeds, introMs: timeline.introMs };
  const end = Math.max(timeline.introMs, timeline.outputDurationMs - timeline.outroMs);
  let from = 0;
  const starts = steps.map(step => {
    const want = words(label(step.target));
    if (!want) return undefined;
    const index = moments.findIndex((moment, at) => at >= from && carries[step.action].includes(moment.type)
      && words(moment.element).includes(want));
    if (index < 0) return undefined;
    from = index + 1;
    return Math.min(end, outputTimeMs(moments[index]!.atMs, edit));
  });
  return {
    outputDurationMs: timeline.outputDurationMs, introMs: timeline.introMs, outroMs: timeline.outroMs,
    steps: steps.map((step, index) => {
      const startMs = starts[index];
      const next = starts.slice(index + 1).find(value => value !== undefined);
      return { index, screen: step.screen, action: step.action, target: step.target, expect: step.expect,
        ...(step.value !== undefined ? { value: step.value } : {}), matched: startMs !== undefined,
        ...(startMs !== undefined ? { startMs, endMs: Math.max(startMs, next ?? end) } : {}) };
    }),
    zooms: timeline.zoomRegions.map(region => ({ startMs: outputTimeMs(region.startMs, edit), endMs: outputTimeMs(region.endMs, edit),
      scale: Math.round(region.customScale * 100) / 100, ...(region.element ? { element: region.element } : {}), ...(region.intent ? { intent: region.intent } : {}) }))
      .filter(zoom => zoom.endMs > zoom.startMs),
    cuts: timeline.cuts.filter(cut => cut.endMs > cut.startMs)
      .map(cut => ({ atMs: outputTimeMs(cut.startMs, edit), removedMs: cut.endMs - cut.startMs })),
    cursor: timeline.cursor,
    settings: timeline.settings,
  };
}
