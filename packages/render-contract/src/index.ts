import type {
  CapturePointer,
  CapturePointerSample,
  CapturePointerShape,
  CaptureSemanticAction,
} from "@content-layer/browser";

/**
 * Turns what the capture observed into the configuration OpenScreen's exporter consumes.
 *
 * This is the only place the two systems meet, and it is deliberately pure: no browser, no ffmpeg,
 * no filesystem. Everything visible in the finished video is decided by the exporter; everything
 * here decides only what it is told.
 *
 * Shapes mirror upstream's `VideoExporterConfig`, `ZoomRegion` and `CursorRecordingData` at the
 * pinned commit. They are restated rather than imported because the exporter is bundled for a
 * browser and this package is consumed by workers; the render end-to-end test is what keeps the two
 * honest.
 */

export type CaptureObservation = {
  /** One entry per click, carrying position, target size and the pointer shape the page reported. */
  pointerTrail: CapturePointer[];
  /** Dense pointer path sampled from page events. */
  pointerTelemetry: CapturePointerSample[];
  /** Page intent used to hold and frame the camera around the action, not just its coordinates. */
  semanticTimeline?: CaptureSemanticAction[];
  /** Confirmed gaps between client calls, never browser input or explicit waits. Source clock. */
  idleRanges?: Array<{ startMs: number; endMs: number }>;
  waitRanges?: Array<{ startMs: number; endMs: number }>;
  /**
   * Where the recorded picture did not change, measured on the video at render time. Not persisted: the pointer
   * is drawn by the renderer, so a still picture with a still pointer is a stretch a viewer sees nothing happen in.
   */
  stillRanges?: Array<{ startMs: number; endMs: number }>;
  /** New captures have interval-based typing and scene boundaries. */
  directed?: boolean;
  /** Parts of the recording that show who the user is, blurred in the source before anything else. */
  redactions?: CaptureRedaction[];
  /**
   * A Toru for Mac window capture: the shared window's size in points while recording, and whether Toru resized it
   * to the requested preset (it is put back afterwards). The video's pixels are `width`×`height`.
   */
  window?: { width: number; height: number; resized: boolean };
  /**
   * A Mac capture of the window with a margin around it: where the window and the app's menus were, over time.
   * Outside these rectangles the recording holds nothing of the app (black), so the render shows only them, on
   * the wallpaper, framed on the window and opening up when a menu reaches past it.
   */
  layers?: CaptureLayers;
  /**
   * The space the recording's coordinates are in: pointer telemetry, clicks, zoom focus and every other pixel
   * measure. For a browser capture this is its CSS viewport; otherwise it is the video's own frame size.
   */
  width: number;
  height: number;
  /**
   * The video's own frame size, when it differs from `width`×`height`: a browser capture recorded at a device
   * scale (a 1920x1080 viewport as 2560x1440), or smaller on a machine that could not encode that. Absent means the
   * video is `width`×`height`. Only the renderer's
   * pixel-sized artwork (the cursor) depends on it; fractions and coordinates do not change.
   */
  videoWidth?: number;
  videoHeight?: number;
  frameRate: number;
  durationMs: number;
};

/**
 * Video pixels per coordinate pixel of a capture: 2 for a 1280x720 viewport recorded at 2560x1440, 4/3 for 1920x1080
 * at 2560x1440, 2/3 for 1920x1080 an encoder could only record at 1280x720, otherwise 1.
 */
export function videoDensity(observation: Pick<CaptureObservation, 'width' | 'videoWidth'>): number {
  const density = observation.videoWidth && observation.width > 0 ? observation.videoWidth / observation.width : 1;
  return Number.isFinite(density) && density >= 0.6 && density <= 3 ? density : 1;
}

/** Fractions of the recording; `radius` is a fraction of its width. */
export type CaptureLayerRect = { x: number; y: number; width: number; height: number; radius: number; kind: 'window' | 'popup' };
export type CaptureLayers = { samples: Array<{ atMs: number; rects: CaptureLayerRect[] }> };

/** What the renderer needs to draw a layered capture: the rectangles to show and where to frame, over time. */
export type LayerTimeline = {
  samples: Array<{ atMs: number; rects: Array<{ x: number; y: number; width: number; height: number; radius: number }> }>;
  /** The crop to frame from `atMs` on; the renderer eases into each over `easeMs`. */
  crops: Array<{ atMs: number; crop: CropRegion }>;
  easeMs: number;
};

const layerEaseMs = 450;

function bounds(rects: Array<{ x: number; y: number; width: number; height: number }>): CropRegion | null {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.width)), y1 = Math.max(...rects.map(r => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Where to frame a layered capture over time: the window, and the window with a menu whenever one reaches past it
 * (with a little room, so the menu does not sit on the content's edge). Only changes are kept.
 */
export function layerTimeline(layers: CaptureLayers | undefined): LayerTimeline | null {
  const samples = (layers?.samples ?? []).filter(sample => sample.rects.some(rect => rect.kind === 'window'))
    .sort((a, b) => a.atMs - b.atMs);
  if (!samples.length) return null;
  const crops: LayerTimeline['crops'] = [];
  const clamp = (crop: CropRegion): CropRegion => {
    const x = Math.max(0, crop.x), y = Math.max(0, crop.y);
    return { x, y, width: Math.min(1, crop.x + crop.width) - x, height: Math.min(1, crop.y + crop.height) - y };
  };
  for (const sample of samples) {
    const window = bounds(sample.rects.filter(rect => rect.kind === 'window'))!;
    const all = bounds(sample.rects)!;
    const reaches = all.x < window.x - 0.002 || all.y < window.y - 0.002
      || all.x + all.width > window.x + window.width + 0.002 || all.y + all.height > window.y + window.height + 0.002;
    const room = 0.012;
    const crop = clamp(reaches ? { x: all.x - room, y: all.y - room, width: all.width + 2 * room, height: all.height + 2 * room } : window);
    const previous = crops.at(-1)?.crop;
    if (!previous || Math.abs(previous.x - crop.x) + Math.abs(previous.y - crop.y) + Math.abs(previous.width - crop.width) + Math.abs(previous.height - crop.height) > 0.002) {
      crops.push({ atMs: crops.length ? sample.atMs : 0, crop });
    }
  }
  return {
    samples: samples.map((sample, index) => ({ atMs: index === 0 ? 0 : sample.atMs,
      rects: sample.rects.map(({ x, y, width, height, radius }) => ({ x, y, width, height, radius })) })),
    crops, easeMs: layerEaseMs,
  };
}

/** The crop a layered capture is framed on at `atMs` (its target, ignoring the ease into it). */
export function layerCropAt(timeline: LayerTimeline, atMs: number): CropRegion {
  let crop = timeline.crops[0]!.crop;
  for (const entry of timeline.crops) if (entry.atMs <= atMs) crop = entry.crop;
  return crop;
}

/**
 * The stretches of an operated window where nothing moved: the navigator reading and deciding.
 *
 * On a Mac the navigator's reads and decisions happen while the window sits still, so they never show up as gaps
 * between client calls the way a web run's thinking does; the cursor path is what marks them. A stretch with no
 * pointer event for longer than `minimumMs` is a pause, starting a beat after the last event so a click's result
 * is seen, and ending where the next travel sets off. The time before the first event counts too.
 */
export function pointerIdleRanges(
  telemetry: CapturePointerSample[],
  durationMs: number,
  minimumMs = 1_500,
): Array<{ startMs: number; endMs: number }> {
  const times = telemetry.map((sample) => sample.atMs).filter((at) => at >= 0 && at <= durationMs).sort((a, b) => a - b);
  if (!times.length) return [];
  const afterEventMs = 600;
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  if (times[0]! > minimumMs) ranges.push({ startMs: 0, endMs: times[0]! });
  for (let index = 1; index < times.length; index++) {
    const from = times[index - 1]! + afterEventMs;
    const to = times[index]!;
    if (to - times[index - 1]! > minimumMs && to > from) ranges.push({ startMs: from, endMs: to });
  }
  return ranges;
}

/** A rectangle of the recording, as fractions of the frame, blurred from `startMs` to `endMs`. */
export type CaptureRedaction = {
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
/** Where a read of the recorded window found the user's identity (fractions of the window), and when. */
export type IdentitySighting = {
  atMs: number;
  rects: Array<{ x: number; y: number; width: number; height: number }>;
};

/**
 * Turns the reads of a Mac window into the spans to blur.
 *
 * The app reads the window at each step, not each frame, and a click is what changes the screen between reads.
 * So a name first seen at a read appeared after the click before it (or at the read before, without a click
 * in between), and a name not seen at the next read went away at the first click after it was last seen. A box
 * seen at consecutive reads in the same place stays blurred straight through. This keeps a blur from hanging
 * over the next screen or arriving before the name does.
 */
export function redactionIntervals(
  sightings: IdentitySighting[],
  durationMs: number,
  clicksMs: number[] = [],
  /**
   * End a blur at the read that no longer finds it, not just after the click before that read. A web page keeps
   * painting the old document until the next one loads, which after a click can take seconds (an OAuth redirect).
   */
  endAtRead = false,
): CaptureRedaction[] {
  const reads = [...sightings].sort((left, right) => left.atMs - right.atMs);
  const clicks = [...clicksMs].sort((left, right) => left - right);
  const pad = 0.004;
  const key = (rect: IdentitySighting["rects"][number]) =>
    [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 500)).join(":");
  const seen = reads.map((read) => new Set(read.rects.map(key)));
  const spans: CaptureRedaction[] = [];
  reads.forEach((read, index) => {
    for (const rect of read.rects) {
      if (!(rect.width > 0 && rect.height > 0)) continue;
      const id = key(rect);
      if (index > 0 && seen[index - 1]!.has(id)) continue; // already covered by the span that started earlier
      // Only a read that did not find the name proves it was not there yet, or no longer: the first read and the
      // last one reach back to the start and on to the end.
      const previousRead = index === 0 ? 0 : reads[index - 1]!.atMs;
      const clickBefore = index === 0 ? undefined : [...clicks].reverse().find((at) => at <= read.atMs && at >= previousRead);
      const startMs = index === 0 ? 0 : clickBefore ?? previousRead;
      let last = index;
      while (last + 1 < reads.length && seen[last + 1]!.has(id)) last += 1;
      const gone = last < reads.length - 1;
      const nextRead = gone ? reads[last + 1]!.atMs : durationMs;
      const clickAfter = gone && !endAtRead ? clicks.find((at) => at >= reads[last]!.atMs && at <= nextRead) : undefined;
      const endMs = Math.min(durationMs, clickAfter !== undefined ? clickAfter + 250 : nextRead);
      const x = Math.max(0, rect.x - pad);
      const y = Math.max(0, rect.y - pad);
      spans.push({
        startMs: Math.max(0, startMs),
        endMs,
        x,
        y,
        width: Math.min(1, rect.x + rect.width + pad) - x,
        height: Math.min(1, rect.y + rect.height + pad) - y,
      });
    }
  });
  // A scroll moves the name through every position between two reads, and neither read's box covers those frames.
  // Pair each box that left with a same-sized one that arrived in line with it, and blur the whole sweep between.
  const close = (left: number, right: number) => Math.abs(left - right) < 0.02;
  reads.slice(1).forEach((read, offset) => {
    const before = reads[offset]!;
    const left = before.rects.filter((rect) => !seen[offset + 1]!.has(key(rect)));
    const arrived = read.rects.filter((rect) => !seen[offset]!.has(key(rect)));
    for (const from of left) {
      const to = arrived.find((rect) =>
        close(rect.width, from.width) && close(rect.height, from.height) && (close(rect.x, from.x) || close(rect.y, from.y)));
      if (!to) continue;
      const x = Math.max(0, Math.min(from.x, to.x) - pad);
      const y = Math.max(0, Math.min(from.y, to.y) - pad);
      spans.push({
        startMs: before.atMs,
        endMs: Math.min(durationMs, read.atMs),
        x,
        y,
        width: Math.min(1, Math.max(from.x + from.width, to.x + to.width) + pad) - x,
        height: Math.min(1, Math.max(from.y + from.height, to.y + to.height) + pad) - y,
      });
    }
  });
  return spans.filter((span) => span.endMs > span.startMs && span.width > 0 && span.height > 0);
}

/** Cuts a span out of the finished video. */
export type TrimRegion = { id: string; startMs: number; endMs: number };

/** Plays a span faster or slower. */
export type SpeedRegion = { id: string; startMs: number; endMs: number; speed: number };

/**
 * Text, arrows, images or a blur placed over the recording. Passed through untouched: their renderer
 * owns what these mean, and restating the union here would only create something to drift.
 */
export type AnnotationRegion = Record<string, unknown>;

/** The visible area of the source, as fractions. Defaults to the whole frame. */
export type CropRegion = { x: number; y: number; width: number; height: number };

/**
 * Everything their exporter accepts that is meaningful for an agent-recorded product demo.
 *
 * Deliberately excluded: the webcam options. There is no camera in this pipeline, and offering
 * fields nobody can populate invites someone to try. Everything else is exposed, because widening
 * the contract is now the way features are added — the renderer already implements them.
 */
export type PresentationOptions = {
  /** CSS colour, gradient or image URL the recording is presented on. */
  wallpaper?: string;
  showShadow?: boolean;
  shadowIntensity?: number;
  showBlur?: boolean;
  motionBlurAmount?: number;
  borderRadius?: number;
  /** Space between the recording and the edge of the frame. */
  padding?: number;
  /** Space inside the recording's own rounded frame. */
  videoPadding?: number;
  cropRegion?: CropRegion;

  cursorScale?: number;
  cursorSmoothing?: number;
  /**
   * Eases the travels a directed capture's driver left stalled (the default). Off draws the pointer exactly as it was
   * recorded, which a brand can ask for when its product's own motion should read as-is.
   */
  smoothCursor?: boolean;
  cursorClickBounce?: number;
  cursorMotionBlur?: number;
  cursorClipToBounds?: boolean;
  /** Upstream theme id; omitted or "default" uses their own cursor artwork. */
  cursorTheme?: string;

  /** The camera's click zooms. Off renders the whole frame throughout; cuts still apply. */
  zoom?: boolean;
  /**
   * The deepest the camera goes, as a zoom factor (1.2–2.5). Directed captures otherwise stop at 1.6 so a demo
   * keeps its context; a brand can let the camera in closer or hold it wider.
   */
  zoomScale?: number;

  trimRegions?: TrimRegion[];
  speedRegions?: SpeedRegion[];
  /**
   * Plays known client idle intervals faster, with pointer-gap fallback for legacy callers.
   *
   * Off by default in this contract; the MCP enables it for captures with explicit idle metadata.
   * Ignored when `speedRegions` is given.
   */
  compressPauses?: boolean;
  annotationRegions?: AnnotationRegion[];

  /** Output geometry, when it should differ from the recording — social aspect ratios, for one. */
  width?: number;
  height?: number;
  bitrate?: number;
  codec?: string;
};

type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How a region decides where to point.
 *
 * `manual` holds the focus still, which is what a click wants: the camera settles on the thing that
 * was pressed and stays there. `auto` re-reads the cursor every frame, which is what reading and
 * hovering want, because the interest moves with the pointer.
 */
export type ZoomFocusMode = "manual" | "auto";

export type ProposedZoomRegion = {
  id: string;
  startMs: number;
  endMs: number;
  depth: ZoomDepth;
  /** The real zoom factor. Their renderer prefers this over the depth preset. */
  customScale: number;
  focus: { cx: number; cy: number };
  focusMode: ZoomFocusMode;
  source: "auto";
  /** Kept on the region so later annotation passes can label the same intent without re-matching. */
  intent?: CaptureSemanticAction["type"];
  element?: string;
};

/** Plays a span of the recording faster, leaving the timeline of everything else untouched. */
export type ProposedSpeedRegion = { id: string; startMs: number; endMs: number; speed: number };

export type ExporterConfig = Record<string, unknown>;

/**
 * Upstream's own defaults, at the pinned commit, recorded so any deviation of ours is visible
 * rather than accidental. Sources: `editorDefaults.ts` and `types.ts`.
 *
 * Note that their appearance defaults are *off*: a fresh project has no shadow, no blur and square
 * corners, and the user turns those on. `DEFAULT_ZOOM_MOTION_BLUR` is the value their slider starts
 * from once enabled, which is why it appears here as 0.35 rather than 0.
 */
export const openScreenDefaults = {
  shadowIntensity: 0,
  showBlur: false,
  motionBlurAmount: 0,
  borderRadius: 0,
  padding: 50,
  wallpaper: "/wallpapers/wallpaper1.jpg",
  cursorScale: 3.0,
  cursorSmoothing: 0.67,
  cursorMotionBlur: 0.35,
  cursorClickBounce: 2.5,
  cursorClipToBounds: false,
  zoomMotionBlurWhenEnabled: 0.35,
  /**
   * Padding is a 0–100 slider, not a pixel count: their renderer reads it as
   * `1 - (padding / 100) * 0.4`, so their 50 leaves the recording filling 80% of the frame. It is
   * already resolution-independent, and scaling it to the frame — as a pixel value would need —
   * silently changes how much wallpaper shows.
   */
  paddingSlider: { max: 100, contentShrink: 0.4 },
  /** Their depth presets, as zoom factors. Depth 3 is their default. */
  depthScales: { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 },
  defaultDepth: 3,
  /** The canvas their defaults are calibrated for. */
  referenceHeight: 1080,
} as const;

/**
 * What a demo looks like when nobody is going to adjust it.
 *
 * Their editor ships the effects off because a person is about to make choices. Nobody opens an
 * editor here, so the preset turns on a shadow and rounded corners to lift the recording off the
 * wallpaper. The cursor is slightly smaller, and redundant smoothing is removed.
 *
 * Our recorded path is already eased and sampled near display rate, so applying OpenScreen's
 * spring again makes the rendered cursor visibly trail the click. Blur stays opt-in too; callers
 * can still enable either effect explicitly through the presentation options.
 */
const preset = {
  ...openScreenDefaults,
  cursorScale: 2.4,
  shadowIntensity: 0.45,
  showBlur: false,
  motionBlurAmount: 0,
  cursorSmoothing: 0,
  borderRadius: 12,
} as const;

/** How long after a click the camera lingers. */
const dwellMs = 1_700;
/** A visible payoff deserves time to be read before the camera releases it. */
const resultDwellMs = 3_200;
/** How long before a click a region opens, so the camera travels with the approaching pointer. */
const leadInMs = 900;
/**
 * The latest a region may open before its first click. Their camera keeps easing for about half a second after a
 * region's start, so opening it this early leaves the frame settled some 300ms before the press: the viewer sees
 * the click land instead of a camera still arriving at it.
 */
const clickSettleMs = 800;
/**
 * Around every press nothing is cut or sped up: the pointer's approach, the camera arriving and the first moment
 * of the response are what a viewer follows.
 */
const clickReserveBeforeMs = 1_500;
const clickReserveAfterMs = 500;
/**
 * What keeps consecutive clicks inside one shot.
 *
 * The radius is the important one, and it is generous on purpose: a third of the frame apart is
 * still the same panel, the same form, the same run of filters, and a camera that reframes between
 * them pumps in and out for no reason a viewer can see. Once the pointer goes further than that it
 * really is somewhere else and deserves its own shot.
 *
 * The gap is the backstop for a long wait. Holding a zoom across ten idle seconds holds it over
 * nothing, so the shot ends and the camera comes back out.
 */
const sameShotRadius = 0.33;
const sameShotGapMs = 9_000;
/**
 * The widest a shot may grow before it stops being a zoom.
 *
 * Without it, clicks chain: each one lands within the radius of the one before, so a shot walks
 * across the window a step at a time and ends up framing everything at the minimum factor. On a real
 * capture that turned twenty clicks into two thirty-second shots at 1.4×, which is calmer than
 * pumping and just as useless. A shot that would grow past this starts a new one instead.
 */
const maximumShotSpan = 0.45;
/** A directed shot held for less than this is a twitch, not a shot. */
const minimumShotMs = 1_200;

/**
 * A stretch with no pointer event at all for this long is the agent waiting on a model, not a pause
 * anybody chose. Model calls run to several seconds, so the bar is set above ordinary hesitation.
 */
const thinkingGapMs = 1_500;
const thinkingMarginMs = 300;
const thinkingSpeed = 3;

/**
 * Their camera starts easing into a region this long before its start (their 1.5× transition window, less the
 * half second the zoom overlaps the region), and eases out over this long after its end.
 */
const cameraLeadMs = 1_023;
const cameraReleaseMs = 1_016;

/** A still picture keeps this long after the change that began it, so the change is seen, and this before the next. */
const stillBeatAfterMs = 500;
const stillBeatBeforeMs = 250;
/** Shorter than this, a cut saves nothing a viewer would notice and only risks a visible jump. */
const minimumCutMs = 400;

export type TimeRange = { startMs: number; endMs: number };

function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const range of [...ranges].filter(r => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

function subtractRanges(ranges: readonly TimeRange[], holds: readonly TimeRange[]): TimeRange[] {
  let spans = mergeRanges(ranges);
  for (const hold of mergeRanges(holds)) {
    spans = spans.flatMap(span => hold.endMs <= span.startMs || hold.startMs >= span.endMs ? [span] : [
      { startMs: span.startMs, endMs: Math.min(span.endMs, hold.startMs) },
      { startMs: Math.max(span.startMs, hold.endMs), endMs: span.endMs },
    ].filter(part => part.endMs > part.startMs));
  }
  return spans;
}

function overlapMs(ranges: readonly TimeRange[], startMs: number, endMs: number): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, Math.min(endMs, r.endMs) - Math.max(startMs, r.startMs)), 0);
}

/** Where the pointer is doing something a viewer watches: travelling, pressing, and the beat after a press. */
export function pointerActivity(telemetry: readonly CapturePointerSample[]): TimeRange[] {
  const sorted = [...telemetry].sort((a, b) => a.atMs - b.atMs);
  const spans: TimeRange[] = [];
  sorted.forEach((sample, index) => {
    const previous = sorted[index - 1];
    if (sample.kind === "down") spans.push({ startMs: sample.atMs - clickReserveBeforeMs, endMs: sample.atMs + 700 });
    else if (sample.kind === "up") spans.push({ startMs: sample.atMs - 250, endMs: sample.atMs + 700 });
    else if (previous && (previous.x !== sample.x || previous.y !== sample.y) && sample.atMs - previous.atMs < thinkingGapMs) {
      spans.push({ startMs: previous.atMs - 200, endMs: sample.atMs + 150 });
    }
  });
  return mergeRanges(spans);
}

/**
 * The stretches that can be cut: the picture is still and the pointer is not moving, so nothing a viewer could
 * follow happens. A beat is kept after each change and before the next, and the opening shot, typing, key presses
 * and the result are never touched.
 */
export function removableSpans(observation: CaptureObservation): TimeRange[] {
  const still = (observation.stillRanges ?? []).map(range => ({
    startMs: range.startMs + stillBeatAfterMs,
    endMs: Math.min(observation.durationMs, range.endMs) - stillBeatBeforeMs,
  }));
  const holds: TimeRange[] = [
    { startMs: 0, endMs: 1_200 },
    ...pointerActivity(observation.pointerTelemetry),
    ...(observation.semanticTimeline ?? []).flatMap((moment): TimeRange[] =>
      moment.type === "type" && moment.endMs !== undefined ? [{ startMs: moment.atMs - 400, endMs: moment.endMs + 700 }]
        : moment.type === "key" ? [{ startMs: moment.atMs - 200, endMs: moment.atMs + 700 }]
          : moment.type === "result" ? [{ startMs: moment.atMs - 300, endMs: moment.atMs + resultDwellMs }]
            : []),
  ];
  return subtractRanges(still, holds).filter(span => span.endMs - span.startMs >= minimumCutMs);
}

/** The stretch around each click that no cut or speed-up may touch. */
export function clickReserveRanges(pointers: readonly CapturePointer[]): TimeRange[] {
  return mergeRanges(pointers.map(pointer => ({
    startMs: Math.max(0, pointer.atMs - clickReserveBeforeMs),
    endMs: pointer.atMs + clickReserveAfterMs,
  })));
}

/**
 * When the pointer set off on the travel that ends at a click, from the driver's path: the moves leading up to it
 * without a pause between them. Undefined when there was no travel (the pointer was already there).
 */
function travelStartBefore(telemetry: readonly CapturePointerSample[], clickMs: number): number | undefined {
  const sorted = [...telemetry].sort((a, b) => a.atMs - b.atMs);
  let arrival = -1;
  for (let index = 0; index < sorted.length; index++) {
    if (sorted[index]!.atMs > clickMs + 50) break;
    if (sorted[index]!.kind === "move") arrival = index;
  }
  if (arrival < 0 || clickMs - sorted[arrival]!.atMs > 4_000) return undefined;
  let start = arrival;
  while (start > 0) {
    const previous = sorted[start - 1]!, current = sorted[start]!;
    if (previous.kind !== "move" || current.atMs - previous.atMs > 400 || (previous.x === current.x && previous.y === current.y)) break;
    start -= 1;
  }
  return start === arrival ? undefined : sorted[start]!.atMs;
}

/**
 * A 1×1 transparent PNG. Their renderer requires an asset per sample, but resolves its own artwork
 * from the sample's `cursorType`, so this placeholder is never drawn. Supplying a real bitmap here
 * would mean shipping cursor art of our own — which is exactly what using theirs avoids.
 */
const placeholderAsset =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Real system cursor bitmaps, read from the machine that renders.
 *
 * Supplying these is what makes the recording wear the operating system's own pointer instead of
 * OpenScreen's replacement artwork. They are deliberately not a build artefact: the bitmaps belong
 * to the OS vendor, so they are read at render time on the machine that already has them and never
 * enter this repository or anything it ships.
 */
export type SystemCursorAsset = {
  imageDataUrl: string;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
};
export type SystemCursorAssets = Partial<Record<CursorType, SystemCursorAsset>>;

/**
 * The pixel height OpenScreen's own cursor artwork declares, and therefore the height every cursor
 * scale in their presets is expressed against.
 */
const openScreenCursorHeight = 32;

/**
 * Rescales the cursor so a system bitmap draws the same size on screen as their artwork would.
 *
 * Their renderer rasterises the asset at its own pixel height times `cursorScale`, so a bitmap
 * extracted at a high reference height — which is what keeps it sharp when a zoom magnifies it —
 * would otherwise arrive some thirty times too large. Their artwork is left alone.
 */
function cursorScaleForAssets(
  scale: number,
  recording: { assets: readonly { id: string; height: number }[] },
): number {
  const systemAsset = recording.assets.find((asset) => asset.id !== "placeholder");
  if (!systemAsset || systemAsset.height <= 0) return scale;
  return Math.round((scale * openScreenCursorHeight * 1000) / systemAsset.height) / 1000;
}

type CursorType = "arrow" | "pointer" | "text";

const cursorTypes: Record<CapturePointerShape, CursorType> = {
  arrow: "arrow",
  hand: "pointer",
  text: "text",
};

/** The wallpapers upstream ships, served from the render page's own origin. */
export const wallpaperChoices: readonly string[] = Array.from(
  { length: 18 },
  (_unused, index) => `/wallpapers/wallpaper${index + 1}.jpg`,
);

/**
 * Toru's own backgrounds, served by the render page at `/wallpapers/<id>.jpg` (1920x1080 JPEGs): light and dark
 * gradients and solid colours with a fine grain, and a few of OpenScreen's MIT-licensed wallpapers (the ones that
 * imitate macOS wallpapers are left out). `tone` is the average colour, for the brand's intro and outro cards.
 */
export const backgroundCatalog = [
  { id: "toru-sky", label: "Sky", group: "gradient", tone: "#c9dff7" },
  { id: "toru-mist", label: "Mist", group: "gradient", tone: "#e6e9ef" },
  { id: "toru-sand", label: "Sand", group: "gradient", tone: "#efe2d1" },
  { id: "toru-mint", label: "Mint", group: "gradient", tone: "#d4eee2" },
  { id: "toru-lilac", label: "Lilac", group: "gradient", tone: "#e0d8f6" },
  { id: "toru-peach", label: "Peach", group: "gradient", tone: "#f9d7c9" },
  { id: "toru-aurora", label: "Aurora", group: "gradient", tone: "#c37bca" },
  { id: "toru-ocean", label: "Ocean", group: "gradient", tone: "#0e415f" },
  { id: "toru-midnight", label: "Midnight", group: "gradient", tone: "#20273f" },
  { id: "toru-graphite", label: "Graphite", group: "gradient", tone: "#2d2e33" },
  { id: "solid-white", label: "White", group: "solid", tone: "#fafafa" },
  { id: "solid-paper", label: "Paper", group: "solid", tone: "#f6f5f1" },
  { id: "solid-slate", label: "Slate", group: "solid", tone: "#5c6574" },
  { id: "solid-black", label: "Black", group: "solid", tone: "#131418" },
  { id: "openscreen-2", label: "Rays", group: "wallpaper", tone: "#6b7098" },
  { id: "openscreen-11", label: "Dawn rays", group: "wallpaper", tone: "#8a829b" },
  { id: "openscreen-12", label: "Northern rays", group: "wallpaper", tone: "#3966af" },
  { id: "openscreen-14", label: "Swirl", group: "wallpaper", tone: "#b5a2a6" },
  { id: "openscreen-15", label: "Clouds", group: "wallpaper", tone: "#9e95a0" },
  { id: "openscreen-17", label: "Brushstroke", group: "wallpaper", tone: "#8a7980" },
  { id: "openscreen-18", label: "Hills", group: "wallpaper", tone: "#8ea3a1" },
  { id: "openscreen-1", label: "Crimson", group: "wallpaper", tone: "#882436" },
] as const;

/** Where the render page serves a catalog background (their renderer loads images only from `/wallpapers/`). */
export function backgroundPath(value: string): string | undefined {
  const id = value.replace(/^\/wallpapers\//, "").replace(/\.jpg$/, "");
  return backgroundCatalog.some(entry => entry.id === id) ? `/wallpapers/${id}.jpg` : undefined;
}

const colourPattern = /^#[0-9a-f]{3,8}$/i;
const gradientPattern = /^(repeating-)?(linear|radial|conic)-gradient\([^;<>]{1,300}\)$/i;

/**
 * Accepts one of their wallpapers, a hex colour, or a CSS gradient — and nothing else.
 *
 * This value becomes a background in a page we render, so an unconstrained string is an injection
 * surface and a way to make the renderer fetch a URL of someone else's choosing.
 */
export function resolveWallpaper(requested?: string): string {
  if (!requested) return preset.wallpaper;
  const value = requested.trim();
  if (wallpaperChoices.includes(value)) return value;
  const background = backgroundPath(value);
  if (background) return background;
  // User uploads are rasterized to bounded JPEGs; no external URLs or SVG execution.
  if (value.length <= 450_000 && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(value))
    return value;
  if (colourPattern.test(value)) return value;
  if (gradientPattern.test(value)) return value;
  return preset.wallpaper;
}

/** Corner rounding, bounded so a value cannot swallow the frame. */
export function clampRadius(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return preset.borderRadius;
  return Math.round(Math.min(64, Math.max(0, requested)));
}

/** Encoders reject odd dimensions. */
function even(value: number): number {
  return value - (value % 2);
}

/** A point as a fraction of something — of the recording, or of the finished frame. */
export type FractionPoint = { cx: number; cy: number };

/**
 * Maps a point in the recording onto the finished frame, as a fraction of it.
 *
 * Two coordinate spaces meet here, and they are not the same one. A cursor sample is a fraction of
 * the *recording*, and their renderer projects it through the rect the recording is drawn into. A
 * zoom region's focus is a fraction of the *frame*, padding included, projected through the frame
 * itself. The recording does not fill the frame — that is what padding means — so the two differ by
 * however much wallpaper surrounds the picture.
 *
 * Handing a cursor position straight over as a focus therefore aims the camera short of what was
 * clicked, outwards into the padding. At rest it is invisible; zoomed in it drags the recording's own
 * edge into shot and fills that side of the frame with wallpaper. Upstream's own suggester has this
 * conflation, and it does not hurt them because a person then drags the focus in their editor. Nobody
 * opens an editor here.
 */
export function frameProjection(
  observation: CaptureObservation,
  presentation: PresentationOptions = {},
): (point: FractionPoint) => FractionPoint {
  const rect = contentRect(observation, presentation);
  const crop = presentation.cropRegion ?? fullFrameCrop;
  if (crop.width <= 0 || crop.height <= 0) return (point) => point;
  return (point) => ({
    cx: rect.x + ((point.cx - crop.x) / crop.width) * rect.width,
    cy: rect.y + ((point.cy - crop.y) / crop.height) * rect.height,
  });
}

/**
 * Where the recording is drawn within the finished frame, as fractions of it.
 *
 * Everything outside this rect is wallpaper. Their renderer fits the recording into a viewport
 * shrunk by the padding slider, preserving aspect, and centres it.
 */
export function contentRect(
  observation: CaptureObservation,
  presentation: PresentationOptions = {},
): CropRegion {
  const frameWidth = even(presentation.width ?? observation.width);
  const frameHeight = even(presentation.height ?? observation.height);
  const crop = presentation.cropRegion ?? fullFrameCrop;
  const contentWidth = observation.width * crop.width;
  const contentHeight = observation.height * crop.height;
  if (frameWidth <= 0 || frameHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return fullFrameCrop;
  }

  const { max, contentShrink } = openScreenDefaults.paddingSlider;
  const padding = Math.min(max, Math.max(0, resolvePadding(presentation)));
  const paddingScale = 1 - (padding / max) * contentShrink;
  const fit = Math.min(
    (frameWidth * paddingScale) / contentWidth,
    (frameHeight * paddingScale) / contentHeight,
  );
  const width = (contentWidth * fit) / frameWidth;
  const height = (contentHeight * fit) / frameHeight;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

/**
 * Pulls a focus far enough from the edge that the zoomed recording still covers the whole frame.
 *
 * Their camera has no bounds of its own: it centres the focus and scales, and if the focus is near an
 * edge the recording slides until its own border is in shot and wallpaper fills that side. In their
 * editor a person sees that and drags the focus. Nothing here can, so the focus is bounded instead.
 *
 * The recording covers the frame while the focus stays half a frame-width inside the content on each
 * side, which at scale `s` is `0.5 / s` in frame fractions. When the content is too small to cover it
 * at this scale — a shallow zoom on a heavily padded frame — no focus can, so it centres instead and
 * accepts the wallpaper, which is the one case where showing it is deliberate.
 */
export function focusWithinContent(
  point: FractionPoint,
  scale: number,
  rect: CropRegion,
  edgeInset = 0,
): FractionPoint {
  const bound = (value: number, start: number, size: number): number => {
    // The rounded corner and its shadow are not picture. Landing the content edge exactly on the
    // frame edge leaves them in shot as a sliver, so the inset keeps them just outside it.
    const margin = 0.5 / Math.max(scale, 0.0001) + Math.max(0, edgeInset);
    const low = start + margin;
    const high = start + size - margin;
    if (low > high) return start + size / 2;
    return Math.min(high, Math.max(low, value));
  };
  return {
    cx: bound(point.cx, rect.x, rect.width),
    cy: bound(point.cy, rect.y, rect.height),
  };
}

/** How far in a depth preset zooms. Their numbers, not ours. */
export function scaleForDepth(depth: number): number {
  const scales = openScreenDefaults.depthScales as Record<number, number>;
  return scales[depth] ?? scales[openScreenDefaults.defaultDepth] ?? 1;
}

const fullFrameCrop: CropRegion = { x: 0, y: 0, width: 1, height: 1 };

function resolvePadding(presentation: PresentationOptions): number {
  return presentation.padding ?? preset.padding;
}

/**
 * Chooses how far to zoom for a click, from the size of what was clicked.
 *
 * A small control needs a closer look than a large one; identical depth on every click is what makes
 * a demo feel mechanical. Target span, not area, decides size: multiplying width by height labels a
 * wide, short control as tiny and turns an ordinary click into a close-up. The range stays inside 2
 * to 4 — 1.5× to 2.2× — centred on their default of 3. Depths 5 and 6 remain available to callers.
 */
export function depthForTarget(widthFraction: number, heightFraction: number): ZoomDepth {
  const span = Math.max(0, widthFraction, heightFraction);
  if (span <= 0) return 3;
  if (span < 0.06) return 4;
  if (span < 0.5) return 3;
  return 2;
}

/** The range automatic zooms move within, and the step they land on. */
const minimumAutoScale = 1.4;
const maximumAutoScale = 2.4;
/**
 * Steps per unit of zoom, so the factor lands on a twentieth.
 *
 * Written as a divisor rather than a step of 0.05: multiplying by an inexact 0.05 lands on
 * 2.4000000000000004, which is outside a range whose upper bound is 2.4.
 */
const scaleStepsPerUnit = 20;
/**
 * The band of sizes the scale spreads itself across.
 *
 * The lower end is fitted to what agents click — on a real capture the targets ran from 0.027 of the
 * frame upwards, filter chips and nav items — because a curve spread over the full 0 to 1 squashed
 * every one of them into the top two steps, which is the identical-zoom complaint restated.
 *
 * The upper end is the widest a shot may grow, and the two are the same number on purpose. What gets
 * measured is the box around everything a shot covers, not a single control, so a band that stopped
 * short of the shot cap would hand the minimum factor to every shot that reached it — which it did,
 * and which made the calm version of the demo a barely-zoomed one.
 */
const smallestInterestingSpan = 0.03;
const largestInterestingSpan = maximumShotSpan;

/**
 * Chooses the zoom factor for a target, as a continuous value rather than one of six presets.
 *
 * Their depth presets jump 1.5, 1.8, 2.2, and a demo built from them lands on the same two or three
 * numbers all the way through — which is what makes every zoom look identical. Their `customScale`
 * accepts anything between 1 and 5, so the factor can instead track the size of what was clicked and
 * differ slightly on every region. Quantised to a twentieth so the numbers stay legible in a trace.
 */
export function scaleForTarget(widthFraction: number, heightFraction: number): number {
  const span = Math.max(0, widthFraction, heightFraction);
  if (span <= 0) return openScreenDefaults.depthScales[openScreenDefaults.defaultDepth];
  const range = largestInterestingSpan - smallestInterestingSpan || 1;
  const position = (span - smallestInterestingSpan) / range;
  const raw = maximumAutoScale - position * (maximumAutoScale - minimumAutoScale);
  const bounded = Math.min(maximumAutoScale, Math.max(minimumAutoScale, raw));
  return Math.round(bounded * scaleStepsPerUnit) / scaleStepsPerUnit;
}

/**
 * How far the pointer roamed over a span, as a fraction of the frame.
 *
 * Used to tell a camera that should hold still from one that should follow: after a click the
 * pointer either settles on what it pressed or sets off across the screen, and those want different
 * treatment.
 */
function pointerTravel(
  telemetry: readonly CapturePointerSample[],
  startMs: number,
  endMs: number,
): number {
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const sample of telemetry) {
    if (sample.atMs < startMs || sample.atMs > endMs) continue;
    minimumX = Math.min(minimumX, sample.x);
    maximumX = Math.max(maximumX, sample.x);
    minimumY = Math.min(minimumY, sample.y);
    maximumY = Math.max(maximumY, sample.y);
  }
  if (!Number.isFinite(minimumX)) return 0;
  return Math.hypot(maximumX - minimumX, maximumY - minimumY);
}

/**
 * Past this much roaming inside a region, holding the camera still leaves the action behind.
 *
 * Measured against real captures: with the lead-in included, a region's pointer travel runs from
 * about 0.07 for a short hop to 0.25 for a trip across the window, so this splits them roughly in
 * half and the finished demo alternates between a fixed camera and a following one.
 */
const followTravelThreshold = 0.15;

/**
 * Proposes one region per click, merging those close enough together that separate regions would
 * pull the camera out and back in for no reason.
 */
export function proposeZoomRegions(
  pointers: CapturePointer[],
  durationMs: number,
  telemetry: readonly CapturePointerSample[] = [],
  semanticTimeline: readonly CaptureSemanticAction[] = [],
  directed = false,
  removable: readonly TimeRange[] = [],
  directedCap = 1.6,
): ProposedZoomRegion[] {
  const ordered = [...pointers].sort((left, right) => left.atMs - right.atMs);
  const shots = groupIntoShots(ordered, removable);
  const regions: ProposedZoomRegion[] = [];

  for (const shot of shots) {
    const first = shot[0];
    const last = shot[shot.length - 1];
    if (!first || !last) continue;
    /**
     * Every region begins before its opening click, the first one included, so the camera has arrived when the
     * press lands — the approach a viewer follows. When the driver's path shows where the travel began, the region
     * is placed so their camera sets off with the pointer: a second-early ease reads as a zoom into a cursor that is
     * not moving. Either way it opens at least `clickSettleMs` before the click; on 27/10/2026 a travel-anchored
     * start landed after the press and every Nock demo showed the click before the zoom.
     */
    const travelStart = travelStartBefore(telemetry, first.atMs);
    const anchored = travelStart !== undefined
      ? Math.max(first.atMs - leadInMs, travelStart + cameraLeadMs + 80)
      : first.atMs - leadInMs;
    const startMs = Math.max(0, Math.min(first.atMs - clickSettleMs, anchored));
    const intent = semanticActionFor(shot, semanticTimeline);
    if (intent?.type === "setup" || (directed && first.shape === "text")) continue;
    const endMs = Math.min(
      durationMs,
      last.atMs + (intent?.type === "result" ? resultDwellMs : dwellMs),
    );
    if (endMs <= startMs) continue;

    // The shot frames everything it covers, not the last thing clicked: a run of clicks around one
    // panel wants that panel held in view, and pulling in on the final chip would lose the rest.
    const covered = boxAround(shot);
    const previous = regions[regions.length - 1];
    // Adjacent regions are clipped rather than overlapped, so the camera finishes one move before
    // beginning the next.
    if (previous && previous.endMs > startMs) previous.endMs = startMs;

    regions.push({
      id: `auto-${regions.length}`,
      startMs,
      endMs,
      depth: depthForTarget(covered.width, covered.height),
      customScale:
        directed ? Math.min(directedCap, scaleForTarget(covered.width, covered.height)) : intent?.type === "type" || intent?.type === "key"
          ? Math.max(2.2, scaleForTarget(covered.width, covered.height))
          : scaleForTarget(covered.width, covered.height),
      focus: { cx: covered.x + covered.width / 2, cy: covered.y + covered.height / 2 },
      focusMode:
        intent?.type === "type" || intent?.type === "key"
          ? "manual"
          : focusModeFor(telemetry, startMs, endMs),
      source: "auto",
      ...(intent ? { intent: intent.type, element: intent.element } : {}),
    });
  }
  if (directed) {
    for (const moment of semanticTimeline) {
      if (moment.type !== "type" || moment.endMs === undefined || !moment.focus) continue;
      const { x, y, width, height } = moment.focus;
      regions.push({ id: `typing-${regions.length}`, startMs: Math.max(0, moment.atMs - 300),
        endMs: Math.min(durationMs, moment.endMs + 700), depth: 2,
        customScale: Math.max(1, Math.min(1.8, 0.9 / Math.max(width, height, 0.01))),
        focus: { cx: x + width / 2, cy: y + height / 2 }, focusMode: "manual", source: "auto", intent: "type", element: moment.element });
    }
  }
  for (const moment of semanticTimeline) {
    if (moment.type !== "result" || !moment.focus || moment.atMs >= durationMs) continue;
    const { x, y, width, height } = moment.focus;
    regions.push({ id: `result-${regions.length}`, startMs: moment.atMs,
      endMs: Math.min(durationMs, moment.atMs + resultDwellMs),
      depth: depthForTarget(width, height),
      // Fit the entire evidence area with breathing room; no target means an honest wide shot.
      customScale: Math.max(1, Math.min(2.4, 0.9 / Math.max(width, height, 0.01))),
      focus: { cx: x + width / 2, cy: y + height / 2 }, focusMode: "manual", source: "auto",
      intent: "result", element: moment.element });
  }
  regions.sort((a, b) => a.startMs - b.startMs);
  if (directed) {
    const navigations = semanticTimeline.filter(moment => moment.type === "navigate");
    for (const region of regions) {
      const boundary = navigations.find(moment => moment.atMs > region.startMs && moment.atMs < region.endMs + 1_000);
      if (boundary) region.endMs = Math.min(region.endMs, Math.max(region.startMs, boundary.atMs - 1_000));
    }
    const last = [...semanticTimeline].sort((a, b) => a.atMs - b.atMs).at(-1);
    if (last?.type === "result") {
      const region = regions.find(r => r.intent === "result" && r.startMs === last.atMs);
      if (region) region.endMs = durationMs + 1_000; // Hold the payoff through the last exported frame.
    }
  }
  for (let i = 1; i < regions.length; i++) {
    regions[i - 1]!.endMs = Math.min(regions[i - 1]!.endMs, regions[i]!.startMs);
  }
  // A zoom cut down to a moment (a click that navigates at once) only twitches the camera in and straight back out.
  const shortest = directed ? minimumShotMs : 0;
  return regions.filter(region => region.endMs - region.startMs > shortest || region.intent === "result");
}

function semanticActionFor(
  shot: readonly CapturePointer[],
  timeline: readonly CaptureSemanticAction[],
): CaptureSemanticAction | undefined {
  let closest: CaptureSemanticAction | undefined;
  let distance = 1_001;
  let priority = -1;
  for (const action of timeline) {
    if ((action.type === "result" && action.focus) || action.endMs !== undefined) continue;
    for (const pointer of shot) {
      const candidate = Math.abs(action.atMs - pointer.atMs);
      const candidatePriority =
        action.type === "result"
          ? 3
          : action.type === "action"
            ? 2
            : action.type === "setup"
              ? 1
              : 0;
      if (
        candidate <= 1_000 &&
        (candidatePriority > priority || (candidatePriority === priority && candidate < distance))
      ) {
        closest = action;
        distance = candidate;
        priority = candidatePriority;
      }
    }
  }
  return closest;
}

/**
 * Groups clicks into the shots a camera should actually take.
 *
 * One region per click is what made the demo pump: an agent setting six filters in one panel
 * produced six zooms, in and out, in and out, for six controls a hand's width apart. A viewer reads
 * that run as a single act, and a camera should hold one frame across it.
 *
 * A shot ends when the next click is somewhere else — far enough away that keeping both in frame
 * would mean not being zoomed in at all — or when so much time has passed that holding the zoom
 * through the gap would be holding it over nothing.
 */
function groupIntoShots(ordered: readonly CapturePointer[], removable: readonly TimeRange[] = []): CapturePointer[][] {
  const shots: CapturePointer[][] = [];
  for (const pointer of ordered) {
    const current = shots[shots.length - 1];
    const previous = current?.[current.length - 1];
    const elsewhere =
      previous !== undefined &&
      Math.hypot(pointer.x - previous.x, pointer.y - previous.y) > sameShotRadius;
    // Measured as the viewer sees it: a wait that is cut from the video does not pull the camera back out.
    const longAfter = previous !== undefined
      && pointer.atMs - previous.atMs - overlapMs(removable, previous.atMs, pointer.atMs) > sameShotGapMs;
    const wouldSprawl = current !== undefined && spanOf([...current, pointer]) > maximumShotSpan;
    if (!current || elsewhere || longAfter || wouldSprawl) shots.push([pointer]);
    else current.push(pointer);
  }
  return shots;
}

/** The larger side of the box covering every target in a shot, as a fraction of the frame. */
function spanOf(shot: readonly CapturePointer[]): number {
  const box = boxAround(shot);
  return Math.max(box.width, box.height);
}

/**
 * How much of a clicked element a shot frames around the click. A full-width row or a card's summary is clicked at
 * one point; framing all of it made a single click sprawl past the widest shot, so the next click a few pixels below
 * opened a shot of its own and the camera pumped out and back in between them.
 */
const maximumTargetExtent = 0.25;

function boxAround(shot: readonly CapturePointer[]): CropRegion {
  const half = (size: number) => Math.min(size, maximumTargetExtent) / 2;
  const left = Math.min(...shot.map((pointer) => pointer.x - half(pointer.width)));
  const right = Math.max(...shot.map((pointer) => pointer.x + half(pointer.width)));
  const top = Math.min(...shot.map((pointer) => pointer.y - half(pointer.height)));
  const bottom = Math.max(...shot.map((pointer) => pointer.y + half(pointer.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function focusModeFor(
  telemetry: readonly CapturePointerSample[],
  startMs: number,
  endMs: number,
): ZoomFocusMode {
  return pointerTravel(telemetry, startMs, endMs) >= followTravelThreshold ? "auto" : "manual";
}

/**
 * The gaps where nothing happened, proposed as spans to play faster.
 *
 * An agent-driven recording has a shape a human one does not: between actions the agent is waiting
 * on a model, and the picture sits still for seconds at a time. Those pauses are most of the running
 * time and none of the interest.
 *
 * With explicit idle intervals, subtract protected camera/read spans. Legacy pointer-only callers
 * only qualify gaps *between* two samples. The quiet before the first move is the establishing shot,
 * and the quiet after the last one is where the result finally renders — speeding through either
 * would remove the two moments worth keeping. A margin at each end leaves the motion into and out of
 * the pause at normal speed, so the change of pace reads as editing rather than a glitch.
 */
export function proposeSpeedRegions(
  telemetry: readonly CapturePointerSample[],
  durationMs: number,
  idleRanges?: readonly { startMs: number; endMs: number }[],
  protectedRanges: readonly { startMs: number; endMs: number }[] = [],
): ProposedSpeedRegion[] {
  const ordered = [...telemetry].sort((left, right) => left.atMs - right.atMs);
  const regions: ProposedSpeedRegion[] = [];
  const gaps = idleRanges ?? ordered.slice(1).map((sample, index) => ({ startMs: ordered[index]!.atMs, endMs: sample.atMs }));
  for (const { startMs: from, endMs: to } of [...gaps].sort((a, b) => a.startMs - b.startMs)) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (to - from < thinkingGapMs) continue;
    const startMs = Math.max(0, from + thinkingMarginMs, regions.at(-1)?.endMs ?? 0);
    const endMs = Math.min(durationMs, to - thinkingMarginMs);
    let spans = [{ startMs, endMs }];
    for (const hold of protectedRanges) {
      spans = spans.flatMap(span => hold.endMs <= span.startMs || hold.startMs >= span.endMs ? [span] : [
        { startMs: span.startMs, endMs: Math.min(span.endMs, hold.startMs) },
        { startMs: Math.max(span.startMs, hold.endMs), endMs: span.endMs },
      ].filter(part => part.endMs > part.startMs));
    }
    for (const span of spans) {
      if (span.endMs - span.startMs < thinkingGapMs / 2) continue;
      regions.push({ id: `pause-${regions.length}`, ...span, speed: thinkingSpeed });
    }
  }
  return regions;
}

/** What the driver gives a pointer travel: 550ms plus half a millisecond per pixel, at most 1.2s. */
function plannedTravelMs(distancePx: number): number {
  return Math.min(1_200, 550 + distancePx * 0.5);
}
/** Page events further apart than a few frames mean the page stalled mid-travel, not that it slowed. */
const stalledTravelGapMs = 60;

/**
 * Redraws the travels a stalled page distorted.
 *
 * The driver eases every travel, but the path we keep is what the page reported, and a heavy page
 * (Notion re-rendering a board in a busy container) took 350–500ms over single moves: a travel came
 * back as five points, a creep and a long straight glide, lasting half again its length. Drawn as is,
 * the cursor drags toward its target. Where a travel is sparse or long, it is redrawn on the driver's
 * own curve and length, ending exactly where and when the page saw the pointer arrive, so hover and
 * click still line up with the video. Dense, timely travels are left untouched.
 */
export function smoothStalledTravels(
  telemetry: CapturePointerSample[],
  width: number,
  height: number,
): CapturePointerSample[] {
  const sorted = [...telemetry].sort((left, right) => left.atMs - right.atMs);
  // The first event after a pause can land a pixel off where the pointer rested (the driver rounds
  // its eased path); drawn as is, the resting cursor visibly twitches before it sets off.
  const samples = sorted.map((sample, index) => {
    const previous = sorted[index - 1];
    if (!previous || sample.kind !== "move" || sample.atMs - previous.atMs < 300) return sample;
    const nudge = Math.hypot((sample.x - previous.x) * width, (sample.y - previous.y) * height);
    return nudge > 0 && nudge < 3 ? { ...sample, x: previous.x, y: previous.y } : sample;
  });
  const output: CapturePointerSample[] = [];
  const moved = (from: CapturePointerSample, to: CapturePointerSample) =>
    from.x !== to.x || from.y !== to.y;
  let index = 0;
  while (index < samples.length) {
    const start = samples[index]!;
    output.push(start);
    // A travel: consecutive moves that each change position, with no thinking pause inside.
    let end = index;
    while (
      end + 1 < samples.length &&
      samples[end + 1]!.kind === "move" &&
      start.kind !== "down" &&
      moved(samples[end]!, samples[end + 1]!) &&
      samples[end + 1]!.atMs - samples[end]!.atMs < thinkingGapMs
    ) {
      end += 1;
    }
    if (end === index) {
      index += 1;
      continue;
    }
    const arrival = samples[end]!;
    const run = samples.slice(index, end + 1);
    const distance = Math.hypot((arrival.x - start.x) * width, (arrival.y - start.y) * height);
    const planned = plannedTravelMs(distance);
    const elapsed = arrival.atMs - start.atMs;
    const stalled = run.some(
      (sample, position) => position > 0 && sample.atMs - run[position - 1]!.atMs > stalledTravelGapMs,
    );
    if (distance < 4 || (!stalled && elapsed <= planned * 1.25)) {
      output.push(...run.slice(1));
      index = end + 1;
      continue;
    }
    const duration = Math.min(elapsed, planned);
    const leaves = arrival.atMs - duration;
    if (leaves > start.atMs) output.push({ ...start, atMs: leaves, kind: "move" });
    // How far along the path the page saw each reported shape. Shapes follow the place, not the
    // clock: the redrawn travel sets off later than the stalled one did, so the shape reported at the
    // same instant belongs further down the path and would swap the cursor before it has moved.
    const along = run.map(
      (sample) =>
        Math.hypot((sample.x - start.x) * width, (sample.y - start.y) * height) / distance,
    );
    for (let at = leaves + pointerFrameMs; at < arrival.atMs; at += pointerFrameMs) {
      const progress = (at - leaves) / duration;
      const eased = progress * progress * (3 - 2 * progress);
      let shaped = start;
      run.forEach((sample, position) => {
        if (along[position]! <= eased) shaped = sample;
      });
      output.push({
        atMs: Math.round(at),
        x: start.x + (arrival.x - start.x) * eased,
        y: start.y + (arrival.y - start.y) * eased,
        kind: "move",
        ...(shaped.shape ? { shape: shaped.shape } : {}),
      });
    }
    output.push(arrival);
    index = end + 1;
  }
  return output;
}
const pointerFrameMs = 16;

/**
 * Builds the cursor recording their renderer draws from.
 *
 * The dense telemetry supplies both the path and the shape: every sample carries the cursor the page
 * was showing under the pointer at that instant. Deriving the shape from the nearest click instead
 * makes the whole travel wear the hover art, so the pointer is a hand before it has reached anything.
 */
export function buildCursorRecording(
  observation: CaptureObservation,
  systemCursors?: SystemCursorAssets,
  smooth = true,
) {
  const telemetry =
    observation.pointerTelemetry.length > 0
      ? observation.directed && smooth
        ? smoothStalledTravels(observation.pointerTelemetry, observation.width, observation.height)
        : observation.pointerTelemetry
      : [...observation.pointerTrail]
          .sort((left, right) => left.atMs - right.atMs)
          .flatMap((pointer) => [
            {
              atMs: Math.max(0, pointer.atMs - 120),
              x: pointer.x,
              y: pointer.y,
              kind: "move" as const,
              shape: pointer.shape,
            },
            {
              atMs: pointer.atMs,
              x: pointer.x,
              y: pointer.y,
              kind: "down" as const,
              shape: pointer.shape,
            },
            {
              atMs: pointer.atMs + 90,
              x: pointer.x,
              y: pointer.y,
              kind: "up" as const,
              shape: pointer.shape,
            },
          ]);
  const samples = telemetry.map((sample) => {
    const cursorType = cursorTypes[sample.shape ?? "arrow"];
    /**
     * A typed sample never reaches the bitmap we supply: upstream resolves its own artwork from the
     * type first and only consults the asset when it cannot. Naming the asset and withholding the
     * type is what routes a sample to the real cursor — and the shape still changes per sample,
     * because the asset id changes with it.
     */
    const hasSystemAsset = Boolean(systemCursors?.[cursorType]);
    return {
      timeMs: sample.atMs,
      cx: sample.x,
      cy: sample.y,
      assetId: hasSystemAsset ? cursorType : "placeholder",
      visible: true,
      ...(hasSystemAsset ? {} : { cursorType }),
      interactionType:
        sample.kind === "down"
          ? ("click" as const)
          : sample.kind === "up"
            ? ("mouseup" as const)
            : ("move" as const),
    };
  });
  // OpenScreen interpolates every adjacent pair. Without a hold sample, a multi-second model pause
  // becomes one multi-second cursor drift toward the next target instead of an actual pause.
  for (let index = samples.length - 1; index > 0; index--) {
    const previous = samples[index - 1];
    const next = samples[index];
    if (!previous || !next || next.timeMs - previous.timeMs < thinkingGapMs) continue;
    samples.splice(index, 0, {
      ...previous,
      timeMs: next.timeMs - 16,
      interactionType: "move",
    });
  }
  const first = samples[0];
  // Upstream draws nothing before its first native sample. Hold the earliest known cursor at frame
  // zero so the recording starts complete, but never synthesize a click animation there.
  if (first && first.timeMs > 0) samples.unshift({ ...first, timeMs: 0, interactionType: "move" });

  return {
    version: 1,
    provider: "native" as const,
    assets: [
      {
        id: "placeholder",
        platform: "darwin" as const,
        imageDataUrl: placeholderAsset,
        width: 1,
        height: 1,
        hotspotX: 0,
        hotspotY: 0,
      },
      // Kept beside the placeholder rather than replacing it: a set that is missing a shape leaves
      // those samples typed, and they fall back to upstream's artwork instead of losing a cursor.
      ...Object.entries(systemCursors ?? {}).map(([id, asset]) => ({
        id,
        platform: "darwin" as const,
        imageDataUrl: asset.imageDataUrl,
        width: asset.width,
        height: asset.height,
        hotspotX: asset.hotspotX,
        hotspotY: asset.hotspotY,
      })),
    ],
    samples,
  };
}

/**
 * The complete exporter configuration, minus `videoUrl`, which only the render host knows because
 * it is the one serving the recording.
 */
export function buildExporterConfig(
  observation: CaptureObservation,
  presentation: PresentationOptions = {},
  systemCursors?: SystemCursorAssets,
): ExporterConfig {
  const cursorRecordingData = buildCursorRecording(observation, systemCursors, presentation.smoothCursor !== false);
  /**
   * Their cursor artwork is drawn at a fixed pixel size scaled by `cursorScale`, against a canvas
   * their defaults assume is 1080 high. On a shorter frame the same number is proportionally larger,
   * which on a real capture produced a pointer that dominated the picture. Scaling by frame height
   * keeps their apparent size. Padding is deliberately not scaled: it is a 0–100 slider, already
   * resolution-independent.
   */
  const scaleToFrame = observation.height / openScreenDefaults.referenceHeight;
  // A layered Mac capture is framed on its window, and on the window and a menu while one reaches past it: what is
  // in frame, and so where a point of the recording lands, depends on the moment.
  const layers = layerTimeline(observation.layers);
  if (layers && !presentation.cropRegion) presentation = { ...presentation, cropRegion: layers.crops[0]!.crop };
  const at = (atMs: number): PresentationOptions => layers ? { ...presentation, cropRegion: layerCropAt(layers, atMs) } : presentation;
  const toFrame = frameProjection(observation, presentation);
  const rect = contentRect(observation, presentation);
  const frameWidth = even(presentation.width ?? observation.width);
  const borderRadius = clampRadius(presentation.borderRadius);
  const edgeInset = frameWidth > 0 ? borderRadius / frameWidth : 0;
  const cutting = Boolean(presentation.compressPauses && observation.directed && presentation.speedRegions === undefined);
  // With the still picture measured, every still moment can go, not only the gaps between the agent's calls.
  const removable = cutting && observation.stillRanges ? removableSpans(observation) : [];
  const zoomScale = presentation.zoomScale === undefined ? undefined : Math.min(2.5, Math.max(1.2, presentation.zoomScale));
  const zoomRegions = presentation.zoom === false ? [] : proposeZoomRegions(observation.pointerTrail, observation.durationMs,
    observation.pointerTelemetry, observation.semanticTimeline, observation.directed, removable, zoomScale)
    .map(region => zoomScale === undefined ? region : { ...region, customScale: Math.min(region.customScale, zoomScale) });
  const clickReserves = clickReserveRanges(observation.pointerTrail);
  const protectedRanges = [
    { startMs: 0, endMs: 1_200 },
    ...zoomRegions.map(region => ({ startMs: region.startMs - 1_000, endMs: region.endMs + 1_000 })),
    ...clickReserves,
  ];
  const directedCuts: TrimRegion[] = [];
  if (cutting && observation.stillRanges) {
    // Only the camera's own moves are kept whole; a held zoom over a still picture is cut like anything else.
    const transitions = zoomRegions.flatMap(region => [
      { startMs: region.startMs - cameraLeadMs - 80, endMs: region.startMs + 550 },
      { startMs: region.endMs - 100, endMs: region.endMs + cameraReleaseMs + 50 },
    ]);
    for (const span of subtractRanges(removable, [...transitions, ...clickReserves])) {
      if (span.endMs - span.startMs >= minimumCutMs) directedCuts.push({ id: `still-${directedCuts.length}`, ...span });
    }
  } else if (cutting) {
    const pauses = proposeSpeedRegions([], observation.durationMs,
      [...(observation.idleRanges ?? []), ...(observation.waitRanges ?? [])], protectedRanges);
    for (const pause of pauses) {
      // Keep a short beat at each side; remove only the excess, with source timestamps intact.
      if (pause.endMs - pause.startMs > 1_200) directedCuts.push({ id: `idle-${directedCuts.length}`,
        startMs: pause.startMs + 350, endMs: pause.endMs - 350 });
    }
  }
  if (cutting) {
    const last = [...(observation.semanticTimeline ?? [])].sort((a, b) => a.atMs - b.atMs).at(-1);
    if (last?.type === "result" && last.atMs + 4_000 < observation.durationMs) {
      directedCuts.push({ id: 'final-hold', startMs: last.atMs + 4_000, endMs: observation.durationMs });
    }
  }
  // Cuts never overlap: a still near the end and the final hold would otherwise both claim the same frames.
  const cuts: TrimRegion[] = observation.stillRanges
    ? mergeRanges(directedCuts).map((span, index) => ({ id: `cut-${index}`, ...span }))
    : directedCuts;
  return {
    // Even output dimensions: encoders reject odd ones, and the captured frame is not always the
    // requested viewport.
    width: even(presentation.width ?? observation.width),
    height: even(presentation.height ?? observation.height),
    frameRate: observation.frameRate,
    bitrate: presentation.bitrate ?? 8_000_000,
    ...(presentation.codec ? { codec: presentation.codec } : {}),
    wallpaper: resolveWallpaper(presentation.wallpaper),
    cropRegion: presentation.cropRegion ?? fullFrameCrop,
    showShadow: presentation.showShadow ?? preset.shadowIntensity > 0,
    shadowIntensity: presentation.shadowIntensity ?? preset.shadowIntensity,
    showBlur: presentation.showBlur ?? preset.showBlur,
    motionBlurAmount: presentation.motionBlurAmount ?? preset.motionBlurAmount,
    borderRadius,
    padding: resolvePadding(presentation),
    videoPadding: presentation.videoPadding ?? 0,
    trimRegions: presentation.trimRegions ?? cuts,
    // Their decoder applies these while everything else stays on the source clock, so speeding a
    // pause up does not shift a single zoom region or cursor sample.
    speedRegions:
      presentation.speedRegions ??
      (presentation.compressPauses && !observation.directed
        ? proposeSpeedRegions(observation.pointerTelemetry, observation.durationMs, observation.idleRanges,
          observation.idleRanges ? [
            { startMs: 0, endMs: 1_500 },
            { startMs: observation.durationMs - 1_500, endMs: observation.durationMs },
            // Preserve the existing camera easing and result dwell at normal speed.
            ...zoomRegions.map(region => ({ startMs: region.startMs - 1_000, endMs: region.endMs + 1_000 })),
            ...clickReserves,
          ] : [])
        : []),
    annotationRegions: presentation.annotationRegions ?? [],
    // The renderer's own dwell suggester needs to know how long the recording runs.
    durationMs: observation.durationMs,
    suppressDwellZooms: observation.directed === true,
    // Not one of their fields, and ignored by their exporter. The render page runs their dwell
    // suggester, which returns focus points in recording space; this is what it projects them with.
    contentRect: rect,
    contentEdgeInset: edgeInset,
    // Focus is a fraction of the frame, so a region's recording-space focus is projected onto it and
    // then bounded so the zoom cannot pull the recording's own edge into shot.
    zoomRegions: zoomRegions.map((region) => ({
      ...region,
      focus: layers
        ? focusWithinContent(frameProjection(observation, at(region.startMs))(region.focus), region.customScale,
          contentRect(observation, at(region.startMs)), edgeInset)
        : focusWithinContent(toFrame(region.focus), region.customScale, rect, edgeInset),
    })),
    ...(layers ? { contentLayers: layers } : {}),
    cursorRecordingData,
    /**
     * The same path again, in the other coordinate space.
     *
     * This copy drives the camera, not the artwork: a region in `auto` focus mode re-reads it every
     * frame and uses the interpolated point as the focus, which is a fraction of the frame. The copy
     * inside `cursorRecordingData` stays in recording space because their renderer projects that one
     * through the rect the recording is drawn into. Two consumers, two spaces, one path.
     *
     * Bounded here as well, at the deepest scale any region uses, because their own clamp knows
     * nothing about the padding. A point already inside the safe area stays inside it after their
     * clamp and after interpolation, since a point between two safe points is itself safe.
     */
    cursorTelemetry: cursorRecordingData.samples.map((sample) => {
      const focus = focusWithinContent(
        (layers ? frameProjection(observation, at(sample.timeMs)) : toFrame)({ cx: sample.cx, cy: sample.cy }),
        maximumAutoScale,
        layers ? contentRect(observation, at(sample.timeMs)) : rect,
        edgeInset,
      );
      return { timeMs: sample.timeMs, cx: focus.cx, cy: focus.cy };
    }),
    cursorClickTimestamps: observation.pointerTrail.map((pointer) => pointer.atMs),
    /**
     * Their renderer sizes the cursor against the video's pixel width (maskRect / videoWidth), so a video twice as
     * dense as its coordinates would draw it at half size. The density brings it back to the size it has on a 1x
     * recording of the same viewport.
     */
    cursorScale: Math.round(cursorScaleForAssets(
      presentation.cursorScale ?? Math.round(preset.cursorScale * scaleToFrame * 100) / 100,
      cursorRecordingData,
    ) * videoDensity(observation) * 1000) / 1000,
    cursorSmoothing: presentation.cursorSmoothing ?? preset.cursorSmoothing,
    cursorClickBounce: presentation.cursorClickBounce ?? preset.cursorClickBounce,
    cursorMotionBlur: presentation.cursorMotionBlur ?? preset.cursorMotionBlur,
    cursorClipToBounds: presentation.cursorClipToBounds ?? preset.cursorClipToBounds,
    ...(presentation.cursorTheme ? { cursorTheme: presentation.cursorTheme } : {}),
  };
}

/** What the delivered video did to the capture's clock: what was cut, what played faster, and the card in front. */
export type EditTimeline = { cuts: readonly TimeRange[]; speeds?: ReadonlyArray<TimeRange & { speed: number }>; introMs?: number };

/**
 * Where a moment of the capture lands in the delivered video. Cut time is removed, sped-up time shrinks by its speed
 * and the intro card comes first; a moment inside a cut lands where the cut closes. Ranges are on the source clock.
 */
export function outputTimeMs(sourceMs: number, edit: EditTimeline): number {
  const at = Math.max(0, sourceMs);
  const overlap = (range: TimeRange) => Math.max(0, Math.min(at, range.endMs) - range.startMs);
  const cuts = mergeRanges([...edit.cuts].filter(range => range.endMs > range.startMs));
  const removed = cuts.reduce((total, range) => total + overlap(range), 0);
  const saved = (edit.speeds ?? []).reduce((total, range) => {
    if (!(range.speed > 0) || range.endMs <= range.startMs) return total;
    // Time already cut is not sped up a second time.
    const inside = overlap(range) - cuts.reduce((sum, cut) => sum + Math.max(0, Math.min(at, range.endMs, cut.endMs) - Math.max(range.startMs, cut.startMs)), 0);
    return total + Math.max(0, inside) * (1 - 1 / range.speed);
  }, 0);
  return Math.round((edit.introMs ?? 0) + at - removed - saved);
}
