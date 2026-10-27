import type { CapturePointer, CapturePointerSample } from "@content-layer/browser";
import { describe, expect, it } from "vitest";
import {
  buildCursorRecording,
  buildExporterConfig,
  clickReserveRanges,
  clampRadius,
  contentRect,
  depthForTarget,
  focusWithinContent,
  frameProjection,
  openScreenDefaults,
  proposeSpeedRegions,
  pointerIdleRanges,
  proposeZoomRegions,
  redactionIntervals,
  resolveWallpaper,
  scaleForDepth,
  scaleForTarget,
  smoothStalledTravels,
  wallpaperChoices,
  layerTimeline,
  layerCropAt,
  backgroundCatalog,
  pointerActivity,
  removableSpans,
  videoDensity,
  outputTimeMs,
  reviewCamera,
  type CaptureLayers,
} from "./index.js";

function click(atMs: number, overrides: Partial<CapturePointer> = {}): CapturePointer {
  return { atMs, x: 0.5, y: 0.5, shape: "hand", width: 0.08, height: 0.03, ...overrides };
}

function path(count: number, from = 0, step = 16): CapturePointerSample[] {
  return Array.from({ length: count }, (_unused, index) => ({
    atMs: from + index * step,
    x: 0.2 + index * 0.001,
    y: 0.4,
    kind: "move" as const,
  }));
}

const observation = {
  width: 1440,
  height: 760,
  frameRate: 30,
  durationMs: 12_000,
  pointerTrail: [click(1_000), click(5_000, { x: 0.2, y: 0.8 }), click(9_000)],
  pointerTelemetry: path(120),
};

describe("zoom depth", () => {
  it("looks closer at small targets than large ones", () => {
    const icon = depthForTarget(0.02, 0.02);
    const wideControl = depthForTarget(0.128, 0.053);
    const card = depthForTarget(0.3, 0.15);
    const banner = depthForTarget(0.9, 0.4);

    expect(wideControl).toBe(3);
    expect(icon).toBeGreaterThan(card);
    expect(card).toBeGreaterThan(banner);
  });

  it("never chooses a depth that loses the context around the target", () => {
    // Depth 5 and 6 are 3.5x and 5x. On a real capture those produced a close-up with nothing
    // recognisable around what was clicked.
    for (const [width, height] of [
      [0.001, 0.001],
      [0.02, 0.02],
      [0.3, 0.2],
      [1, 1],
    ]) {
      const depth = depthForTarget(width as number, height as number);
      expect(depth).toBeGreaterThanOrEqual(2);
      expect(depth).toBeLessThanOrEqual(4);
    }
  });

  it("falls back to a middling depth when the target had no size", () => {
    expect(depthForTarget(0, 0)).toBe(3);
  });
});

describe("zoom regions", () => {
  it("directs typing, releases navigation framing and ends on the verified payoff", () => {
    const config = buildExporterConfig({ ...observation, durationMs: 30_000, directed: true,
      pointerTrail: [click(2_000, { shape: 'text' }), click(13_000)], pointerTelemetry: [],
      idleRanges: [{ startMs: 0, endMs: 2_000 }, { startMs: 8_000, endMs: 12_000 }, { startMs: 21_000, endMs: 30_000 }],
      waitRanges: [{ startMs: 14_000, endMs: 20_000 }],
      semanticTimeline: [
        { type: 'setup', atMs: 2_000, ref: null, element: 'Focus' },
        { type: 'type', atMs: 4_000, endMs: 8_000, ref: null, element: 'Input', focus: { x: 0.2, y: 0.2, width: 0.5, height: 0.3 } },
        { type: 'click', atMs: 13_000, ref: null, element: 'Submit' },
        { type: 'navigate', atMs: 13_300, ref: null, element: 'New page' },
        { type: 'result', atMs: 20_000, ref: null, element: 'Results', focus: { x: 0.4, y: 0.1, width: 0.5, height: 0.2 } },
      ],
    }, { compressPauses: true });
    const zooms = config.zoomRegions as Array<{ intent?: string; startMs: number; endMs: number }>;
    expect(zooms.find(z => z.intent === 'setup')).toBeUndefined();
    expect(zooms.find(z => z.intent === 'type')).toMatchObject({ startMs: 3_700, endMs: 8_700 });
    expect(zooms.filter(z => z.startMs < 13_300).every(z => z.endMs <= 12_300)).toBe(true);
    expect(zooms.at(-1)?.endMs).toBeGreaterThan(30_000);
    expect(config.suppressDwellZooms).toBe(true);
    expect(config.trimRegions).toContainEqual({ id: 'final-hold', startMs: 24_000, endMs: 30_000 });
    for (const trim of config.trimRegions as Array<{ startMs: number; endMs: number }>) {
      expect(trim.endMs <= 3_000 || trim.startMs >= 9_700).toBe(true);
    }
  });

  it("holds one shot across a run of clicks in the same place", () => {
    // The defect this replaces: a filter panel set six times produced six zooms, in and out for
    // controls a hand's width apart, which reads as the camera pumping.
    const panel = [0, 1, 2, 3, 4, 5].map((step) =>
      click(2_000 + step * 1_500, { x: 0.3 + step * 0.02, y: 0.4 + step * 0.03 }),
    );
    const regions = proposeZoomRegions(panel, 20_000);

    expect(regions).toHaveLength(1);
    // Opened before the first click, so the camera has arrived when it lands.
    expect(regions[0]?.startMs).toBe(1_100);
    expect(regions[0]?.endMs).toBeGreaterThan(9_500);
  });

  it("takes a new shot once the pointer is somewhere else", () => {
    const regions = proposeZoomRegions(
      [click(2_000, { x: 0.15, y: 0.2 }), click(4_000, { x: 0.85, y: 0.8 })],
      12_000,
    );
    expect(regions).toHaveLength(2);
  });

  it("frames everything the shot covers, not the last thing clicked", () => {
    const regions = proposeZoomRegions(
      [click(2_000, { x: 0.3, y: 0.3 }), click(4_000, { x: 0.5, y: 0.5 })],
      12_000,
    );
    expect(regions).toHaveLength(1);
    // Centred between the two, and wide enough to keep both.
    expect(regions[0]?.focus.cx).toBeCloseTo(0.4, 2);
    expect(regions[0]?.focus.cy).toBeCloseTo(0.4, 2);
    expect(regions[0]?.customScale).toBeLessThan(scaleForTarget(0.08, 0.03));
  });

  it("ends a shot when the wait is long enough that the zoom would sit over nothing", () => {
    const regions = proposeZoomRegions([click(1_000), click(20_000)], 30_000);
    expect(regions).toHaveLength(2);
  });

  it("gives shots different zoom factors, because they cover different things", () => {
    const regions = proposeZoomRegions(
      [
        click(2_000, { x: 0.2, y: 0.2, width: 0.02, height: 0.02 }),
        click(6_000, { x: 0.8, y: 0.8, width: 0.3, height: 0.2 }),
      ],
      12_000,
    );
    expect(regions[0]?.customScale).not.toBe(regions[1]?.customScale);
    // The first region opens before its click like every other one: a camera still arriving when the
    // press lands showed the click before the zoom (27/10/2026).
    expect(regions[0]?.startMs).toBe(1_100);
  });

  it("never overlaps adjacent regions", () => {
    const regions = proposeZoomRegions(
      [
        click(700, { x: 0.1, y: 0.1 }),
        click(2_200, { x: 0.9, y: 0.5 }),
        click(4_000, { x: 0.1, y: 0.9 }),
      ],
      6_000,
    );
    expect(regions.length).toBeGreaterThan(1);
    for (let index = 1; index < regions.length; index++) {
      expect(regions[index]?.startMs).toBeGreaterThanOrEqual(regions[index - 1]?.endMs ?? 0);
    }
  });

  it("never proposes a region running past the recording", () => {
    const regions = proposeZoomRegions([click(11_800)], 12_000);
    expect(regions[0]?.endMs).toBeLessThanOrEqual(12_000);
  });

  it("proposes nothing when nothing was clicked", () => {
    expect(proposeZoomRegions([], 12_000)).toEqual([]);
  });

  it("uses agent emphasis to skip setup zooms and hold visible results", () => {
    const pointer = click(2_000);
    const setup = proposeZoomRegions(
      [pointer],
      10_000,
      [],
      [{ atMs: 2_000, type: "setup", ref: "ref_1", element: "Open filters" }],
    );
    const result = proposeZoomRegions(
      [pointer],
      10_000,
      [],
      [{ atMs: 2_000, type: "result", ref: "ref_1", element: "Qualified leads" }],
    )[0];

    expect(setup).toEqual([]);
    expect(result).toMatchObject({ intent: "result", element: "Qualified leads", endMs: 5_200 });
  });
});

describe("zoom variety", () => {
  it("gives a different factor to targets of different size, not one of six presets", () => {
    // The sizes an agent actually clicks, measured off a real capture: chips, nav items, buttons.
    const scales = [0.033, 0.077, 0.112, 0.135].map((span) => scaleForTarget(span, span / 3));
    // The defect this replaces: every zoom in a demo landing on the same two numbers.
    expect(new Set(scales).size).toBe(scales.length);
    for (const scale of scales) {
      expect(scale).toBeGreaterThanOrEqual(1.4);
      expect(scale).toBeLessThanOrEqual(2.4);
    }
  });

  it("saturates outside the band rather than running away", () => {
    expect(scaleForTarget(0.9, 0.9)).toBe(1.4);
    expect(scaleForTarget(0.005, 0.005)).toBe(2.4);
  });

  it("still zooms for a shot that covers a whole panel", () => {
    // The band runs to the widest a shot may grow. Stopping short of it handed the minimum factor to
    // every shot that reached the cap, which is a demo that never really zooms.
    expect(scaleForTarget(0.2, 0.1)).toBeGreaterThan(1.9);
    expect(scaleForTarget(0.3, 0.2)).toBeGreaterThan(1.4);
    // A shot at the cap still gets the least zoom, which is what the bottom of the range is for.
    expect(scaleForTarget(0.45, 0.3)).toBe(1.4);
  });

  it("looks closer at smaller targets", () => {
    expect(scaleForTarget(0.02, 0.02)).toBeGreaterThan(scaleForTarget(0.4, 0.2));
  });

  it("lands on clean steps", () => {
    for (const span of [0.02, 0.07, 0.19, 0.33, 0.48]) {
      const scale = scaleForTarget(span, span / 3);
      expect(Math.round(scale * 20)).toBeCloseTo(scale * 20, 6);
    }
  });

  it("carries the factor onto the region, where their renderer prefers it to the preset", () => {
    const regions = proposeZoomRegions(
      [click(2_000, { width: 0.02, height: 0.02 }), click(6_000, { width: 0.7, height: 0.2 })],
      12_000,
    );
    expect(regions[0]?.customScale).not.toBe(regions[1]?.customScale);
  });
});

describe("cursor-following zoom", () => {
  it("follows the pointer when it roams, and holds still when it does not", () => {
    const settled = proposeZoomRegions([click(1_000)], 12_000, [
      { atMs: 1_000, x: 0.5, y: 0.5, kind: "move" },
      { atMs: 2_000, x: 0.51, y: 0.5, kind: "move" },
    ]);
    expect(settled[0]?.focusMode).toBe("manual");

    const roaming = proposeZoomRegions([click(1_000)], 12_000, [
      { atMs: 1_000, x: 0.2, y: 0.2, kind: "move" },
      { atMs: 2_000, x: 0.8, y: 0.7, kind: "move" },
    ]);
    expect(roaming[0]?.focusMode).toBe("auto");
  });

  it("holds still when nothing was observed, rather than following a path it does not have", () => {
    expect(proposeZoomRegions([click(1_000)], 12_000)[0]?.focusMode).toBe("manual");
  });

  it("uses semantic typing intent to hold a close frame and keeps the element label", () => {
    const region = proposeZoomRegions(
      [click(1_000, { width: 0.5, height: 0.1 })],
      12_000,
      [
        { atMs: 1_000, x: 0.2, y: 0.2, kind: "move" },
        { atMs: 2_000, x: 0.8, y: 0.7, kind: "move" },
      ],
      [{ atMs: 1_100, type: "type", ref: "ref_4", element: "input Company domain" }],
    )[0];

    expect(region).toMatchObject({
      focusMode: "manual",
      intent: "type",
      element: "input Company domain",
    });
    expect(region?.customScale).toBeGreaterThanOrEqual(2.2);
  });

  it("hands the camera a path in frame space, bounded so following cannot expose the edge", () => {
    // A following camera reads this every frame and uses it directly as the focus, and their own
    // clamp knows nothing about the padding.
    const config = buildExporterConfig({
      ...observation,
      pointerTelemetry: [
        { atMs: 0, x: 0, y: 0, kind: "move" },
        { atMs: 100, x: 1, y: 1, kind: "move" },
      ],
    });
    const rect = contentRect(observation);
    for (const point of config.cursorTelemetry as Array<{ cx: number; cy: number }>) {
      expect(point.cx).toBeGreaterThan(rect.x);
      expect(point.cx).toBeLessThan(rect.x + rect.width);
      expect(point.cy).toBeGreaterThan(rect.y);
      expect(point.cy).toBeLessThan(rect.y + rect.height);
    }
    // The artwork's copy is untouched: their renderer projects that one itself.
    const drawn = config.cursorRecordingData as { samples: Array<{ cx: number }> };
    expect(drawn.samples[0]?.cx).toBe(0);
  });
});

describe("thinking pauses", () => {
  it("preserves typing and result camera easing when using explicit client idle intervals", () => {
    const config = buildExporterConfig({ ...observation, durationMs: 30_000,
      pointerTrail: [], pointerTelemetry: [],
      idleRanges: [{ startMs: 0, endMs: 6_000 }, { startMs: 12_000, endMs: 30_000 }],
      semanticTimeline: [{ atMs: 18_000, type: "result", ref: null, element: "Two results",
        focus: { x: 0.2, y: 0.2, width: 0.5, height: 0.3 } }],
    }, { compressPauses: true });
    const regions = config.speedRegions as Array<{ startMs: number; endMs: number; speed: number }>;
    expect(regions.length).toBeGreaterThan(1);
    for (const span of regions) {
      expect(span.startMs).toBeGreaterThanOrEqual(1_500);
      expect(span.endMs).toBeLessThanOrEqual(28_500);
      expect(span.endMs <= 6_000 || span.startMs >= 12_000).toBe(true);
      expect(span.endMs <= 17_000 || span.startMs >= 22_200).toBe(true);
    }
    expect(config.zoomRegions).toContainEqual(expect.objectContaining({ startMs: 18_000, endMs: 21_200 }));
    const savedMs = regions.reduce((sum, span) => sum + (span.endMs - span.startMs) * (1 - 1 / span.speed), 0);
    expect(savedMs).toBeGreaterThan(9_000);
    // Explicitly empty metadata must not fall back to guessing from cursor stillness.
    expect(buildExporterConfig({ ...observation, idleRanges: [] }, { compressPauses: true }).speedRegions).toEqual([]);
  });

  it("speeds up the gaps where the agent was waiting on a model", () => {
    const regions = proposeSpeedRegions(
      [
        { atMs: 0, x: 0.1, y: 0.1, kind: "move" },
        { atMs: 200, x: 0.2, y: 0.1, kind: "move" },
        // Six seconds of nothing: a model call, not a pause anybody chose.
        { atMs: 6_200, x: 0.3, y: 0.1, kind: "move" },
      ],
      12_000,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]?.speed).toBeGreaterThan(1);
    // A margin at each end keeps the motion into and out of the pause at normal speed.
    expect(regions[0]?.startMs).toBeGreaterThan(200);
    expect(regions[0]?.endMs).toBeLessThan(6_200);
  });

  it("leaves ordinary hesitation alone", () => {
    expect(
      proposeSpeedRegions(
        [
          { atMs: 0, x: 0.1, y: 0.1, kind: "move" },
          { atMs: 800, x: 0.2, y: 0.1, kind: "move" },
        ],
        12_000,
      ),
    ).toEqual([]);
  });

  it("never compresses the opening shot or the payoff", () => {
    // Nothing moves before the first sample or after the last: one is the establishing shot, the
    // other is where the result finally renders. Both are the reason the demo exists.
    const regions = proposeSpeedRegions(
      [
        { atMs: 8_000, x: 0.1, y: 0.1, kind: "move" },
        { atMs: 8_200, x: 0.2, y: 0.1, kind: "move" },
      ],
      20_000,
    );
    expect(regions).toEqual([]);
  });

  it("stays out of the finished video unless it is asked for", () => {
    // A change of pace is an editorial choice, and one nobody asked for is a surprise.
    const telemetry: CapturePointerSample[] = [
      { atMs: 0, x: 0.1, y: 0.1, kind: "move" },
      { atMs: 5_000, x: 0.2, y: 0.1, kind: "move" },
    ];
    expect(
      buildExporterConfig({ ...observation, pointerTelemetry: telemetry }).speedRegions,
    ).toEqual([]);
    expect(
      (
        buildExporterConfig(
          { ...observation, pointerTelemetry: telemetry },
          {
            compressPauses: true,
          },
        ).speedRegions as unknown[]
      ).length,
    ).toBe(1);
  });
});

describe("focus projection", () => {
  it("places the recording inside the frame, leaving wallpaper around it", () => {
    const rect = contentRect(observation);
    expect(rect.width).toBeLessThan(1);
    expect(rect.height).toBeLessThan(1);
    // Centred, so the margins match.
    expect(rect.x).toBeCloseTo((1 - rect.width) / 2, 6);
  });

  it("gives the whole frame to the recording when there is no padding", () => {
    expect(contentRect(observation, { padding: 0 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("pulls a focus in from the edge, because the edge of the frame is not the edge of the picture", () => {
    // The defect this replaces: a click near the left edge aimed the camera at the padding, so
    // zooming in dragged the recording's own edge into shot and filled the side with wallpaper.
    const project = frameProjection(observation);
    const nearEdge = project({ cx: 0.05, cy: 0.5 });
    expect(nearEdge.cx).toBeGreaterThan(0.05);
    expect(nearEdge.cx).toBeLessThan(0.5);
    // The centre is the centre in both spaces.
    expect(project({ cx: 0.5, cy: 0.5 })).toEqual({ cx: 0.5, cy: 0.5 });
  });

  it("keeps the zoomed recording covering the frame, whatever was clicked", () => {
    // Their camera has no bounds: it centres the focus and scales, so a focus near an edge slides the
    // recording until its own border is in shot and wallpaper fills that side of the picture.
    const rect = contentRect(observation);
    for (const depth of [2, 3, 4]) {
      const scale = scaleForDepth(depth);
      for (const corner of [
        { cx: 0, cy: 0 },
        { cx: 1, cy: 1 },
        { cx: 0.02, cy: 0.98 },
      ]) {
        const focus = focusWithinContent(corner, scale, rect);
        // Each edge of the scaled content must still be outside the frame.
        expect((focus.cx - rect.x) * scale).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect((rect.x + rect.width - focus.cx) * scale).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect((focus.cy - rect.y) * scale).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect((rect.y + rect.height - focus.cy) * scale).toBeGreaterThanOrEqual(0.5 - 1e-9);
      }
    }
  });

  it("leaves a focus that was already safe exactly where it was", () => {
    const rect = contentRect(observation);
    expect(focusWithinContent({ cx: 0.5, cy: 0.5 }, scaleForDepth(4), rect)).toEqual({
      cx: 0.5,
      cy: 0.5,
    });
  });

  it("centres instead when no focus could cover the frame", () => {
    // Too shallow a zoom on a padded frame: something has to show, so it is the wallpaper, evenly.
    const rect = contentRect(observation);
    const focus = focusWithinContent({ cx: 0, cy: 0 }, 1.05, rect);
    expect(focus.cx).toBeCloseTo(0.5, 6);
    expect(focus.cy).toBeCloseTo(0.5, 6);
  });

  it("projects every zoom region it proposes", () => {
    const config = buildExporterConfig({
      ...observation,
      pointerTrail: [click(1_000, { x: 0.1, y: 0.9 })],
    });
    const [region] = config.zoomRegions as Array<{ focus: { cx: number; cy: number } }>;
    expect(region?.focus.cx).toBeGreaterThan(0.1);
    expect(region?.focus.cy).toBeLessThan(0.9);
  });

  it("publishes the rect so the page can project the dwell regions the same way", () => {
    expect(buildExporterConfig(observation).contentRect).toEqual(contentRect(observation));
  });
});

/** Shaped like the extractor's output; the pixels are irrelevant to what these tests assert. */
const systemCursor = {
  imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  width: 675,
  height: 1024,
  hotspotX: 124.8,
  hotspotY: 99.5,
};

describe("cursor recording", () => {
  it("holds the earliest known cursor at frame zero", () => {
    const recording = buildCursorRecording({
      ...observation,
      pointerTelemetry: [{ atMs: 600, x: 0.5, y: 0.4, kind: "down", shape: "hand" }],
    });
    expect(recording.samples).toHaveLength(2);
    expect(recording.samples[0]).toMatchObject({
      timeMs: 0,
      cx: 0.5,
      cy: 0.4,
      cursorType: "pointer",
      interactionType: "move",
    });
    expect(recording.samples[1]?.interactionType).toBe("click");
  });

  it("carries each sample's own shape, not the shape of the next thing clicked", () => {
    // The defect this replaces: the shape came from the upcoming click, so the pointer wore the hover
    // hand for the whole journey, before it had reached anything.
    const recording = buildCursorRecording({
      ...observation,
      pointerTrail: [click(1_000, { shape: "hand" })],
      pointerTelemetry: [
        { atMs: 0, x: 0.1, y: 0.1, kind: "move" },
        { atMs: 500, x: 0.4, y: 0.4, kind: "move", shape: "hand" },
        { atMs: 900, x: 0.5, y: 0.5, kind: "move", shape: "text" },
      ],
    });
    expect(recording.samples.map((sample) => sample.cursorType)).toEqual([
      "arrow",
      "pointer",
      "text",
    ]);
  });

  it("holds the cursor still while the model is thinking", () => {
    const recording = buildCursorRecording({
      ...observation,
      pointerTelemetry: [
        { atMs: 0, x: 0.1, y: 0.2, kind: "move" },
        { atMs: 4_000, x: 0.8, y: 0.7, kind: "move", shape: "hand" },
      ],
    });

    expect(recording.samples).toEqual([
      expect.objectContaining({ timeMs: 0, cx: 0.1, cy: 0.2 }),
      expect.objectContaining({ timeMs: 3_984, cx: 0.1, cy: 0.2 }),
      expect.objectContaining({ timeMs: 4_000, cx: 0.8, cy: 0.7 }),
    ]);
  });

  it("falls back to the arrow when the page reported no cursor", () => {
    const recording = buildCursorRecording({ ...observation, pointerTelemetry: path(3) });
    expect(recording.samples.every((sample) => sample.cursorType === "arrow")).toBe(true);
  });

  it("marks presses and releases so the click effects fire", () => {
    const recording = buildCursorRecording({
      ...observation,
      pointerTelemetry: [
        { atMs: 0, x: 0.1, y: 0.1, kind: "move" },
        { atMs: 100, x: 0.1, y: 0.1, kind: "down" },
        { atMs: 180, x: 0.1, y: 0.1, kind: "up" },
      ],
    });
    expect(recording.samples.map((sample) => sample.interactionType)).toEqual([
      "move",
      "click",
      "mouseup",
    ]);
  });

  it("reconstructs a visible Mac cursor from clicks when dense telemetry is missing", () => {
    const recording = buildCursorRecording({ ...observation, pointerTelemetry: [] });
    expect(recording.samples).not.toHaveLength(0);
    expect(recording.samples.map((sample) => sample.interactionType)).toContain("click");
    expect(recording.assets[0]?.platform).toBe("darwin");
  });

  it("wears the machine's own cursor when its bitmaps are supplied", () => {
    const recording = buildCursorRecording(
      { ...observation, pointerTelemetry: [{ atMs: 0, x: 0.2, y: 0.3, kind: "move" }] },
      { arrow: systemCursor },
    );
    const sample = recording.samples[0];
    // Naming the asset and withholding the type is the whole mechanism: upstream prefers its own
    // artwork for any typed sample, so a type here would silently discard the real bitmap.
    expect(sample?.assetId).toBe("arrow");
    expect(sample).not.toHaveProperty("cursorType");
    expect(recording.assets.find((asset) => asset.id === "arrow")).toMatchObject({
      width: 675,
      height: 1024,
    });
  });

  it("keeps a shape the supplied set is missing on upstream's artwork", () => {
    const recording = buildCursorRecording(
      {
        ...observation,
        pointerTelemetry: [
          { atMs: 0, x: 0.2, y: 0.3, kind: "move" },
          { atMs: 100, x: 0.4, y: 0.4, kind: "move", shape: "text" },
        ],
      },
      { arrow: systemCursor },
    );
    expect(recording.samples[0]).toMatchObject({ assetId: "arrow" });
    // A partial set must not cost a cursor: the unsupplied shape stays typed and upstream draws it.
    expect(recording.samples[1]).toMatchObject({ assetId: "placeholder", cursorType: "text" });
    expect(recording.assets.some((asset) => asset.id === "placeholder")).toBe(true);
  });

  it("redraws a travel a stalled page left sparse, arriving where and when the page saw it", () => {
    // From a real Notion capture: after the board re-rendered, single moves took 350–500ms.
    const stalled: CapturePointerSample[] = [
      { atMs: 4_177, x: 0.142, y: 0.357, kind: "move", shape: "hand" },
      { atMs: 4_260, x: 0.148, y: 0.361, kind: "move", shape: "hand" },
      { atMs: 4_295, x: 0.158, y: 0.368, kind: "move", shape: "text" },
      { atMs: 4_310, x: 0.166, y: 0.374, kind: "move", shape: "text" },
      { atMs: 4_661, x: 0.174, y: 0.381, kind: "move", shape: "text" },
      { atMs: 5_147, x: 0.276, y: 0.457, kind: "move", shape: "hand" },
      { atMs: 5_638, x: 0.276, y: 0.457, kind: "down", shape: "hand" },
    ];
    const smoothed = smoothStalledTravels(stalled, 1920, 1080);
    const travel = smoothed.filter((sample) => sample.atMs > 4_177 && sample.atMs < 5_147);
    // 550ms plus half of the ~304px distance: the length the driver gave it, not the 970ms it took.
    const leaves = travel[0]!;
    expect(leaves).toMatchObject({ x: 0.142, y: 0.357 });
    expect(5_147 - leaves.atMs).toBeGreaterThan(650);
    expect(5_147 - leaves.atMs).toBeLessThan(750);
    // Every frame of it, eased: no gap a renderer would fill with a straight glide.
    const gaps = travel.slice(1).map((sample, index) => sample.atMs - travel[index]!.atMs);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(16);
    expect(smoothed.at(-2)).toEqual(stalled.at(-2));
    expect(smoothed.at(-1)).toEqual(stalled.at(-1));
  });

  it("keeps the cursor still and in its own shape until the redrawn travel really moves", () => {
    // From the same capture: the click on a tab, a long pause, then a travel the page stalled over.
    const telemetry: CapturePointerSample[] = [
      { atMs: 1_763, x: 0.1417, y: 0.3565, kind: "down", shape: "hand" },
      { atMs: 1_863, x: 0.1417, y: 0.3565, kind: "up", shape: "hand" },
      { atMs: 4_177, x: 0.1422, y: 0.3574, kind: "move", shape: "hand" },
      { atMs: 4_260, x: 0.1479, y: 0.3611, kind: "move", shape: "hand" },
      { atMs: 4_295, x: 0.1583, y: 0.3685, kind: "move", shape: "hand" },
      { atMs: 4_310, x: 0.1656, y: 0.3741, kind: "move", shape: "text" },
      { atMs: 4_661, x: 0.174, y: 0.381, kind: "move", shape: "text" },
      { atMs: 5_147, x: 0.276, y: 0.457, kind: "move", shape: "hand" },
    ];
    const smoothed = smoothStalledTravels(telemetry, 1920, 1080);
    // The pixel the first event after the pause landed off the resting point is not a movement.
    const rest = smoothed.filter((sample) => sample.atMs <= 4_177);
    expect(rest.every((sample) => sample.x === 0.1417 && sample.y === 0.3565)).toBe(true);
    // The hand stays a hand until the pointer has actually travelled to where the page showed text.
    const textAt = Math.hypot((0.1656 - 0.1417) * 1920, (0.3741 - 0.3565) * 1080);
    const total = Math.hypot((0.276 - 0.1417) * 1920, (0.457 - 0.3565) * 1080);
    for (const sample of smoothed.filter((item) => item.atMs > 4_177 && item.atMs < 5_147)) {
      const along = Math.hypot((sample.x - 0.1417) * 1920, (sample.y - 0.3565) * 1080) / total;
      if (along < textAt / total - 0.01) expect(sample.shape).toBe("hand");
    }
  });

  it("leaves a dense, timely travel exactly as the page reported it", () => {
    const timely: CapturePointerSample[] = Array.from({ length: 40 }, (_unused, index) => ({
      atMs: 1_000 + index * 17,
      x: 0.2 + index * 0.005,
      y: 0.3 + index * 0.002,
      kind: "move" as const,
    }));
    expect(smoothStalledTravels(timely, 1440, 900)).toEqual(timely);
  });

  it("only redraws travels in directed captures, never a person's own mouse path", () => {
    const sparse: CapturePointerSample[] = [
      { atMs: 0, x: 0.1, y: 0.1, kind: "move" },
      { atMs: 400, x: 0.3, y: 0.3, kind: "move" },
      { atMs: 900, x: 0.6, y: 0.5, kind: "move" },
    ];
    expect(buildCursorRecording({ ...observation, pointerTelemetry: sparse }).samples).toHaveLength(3);
    expect(
      buildCursorRecording({ ...observation, directed: true, pointerTelemetry: sparse }).samples.length,
    ).toBeGreaterThan(20);
  });

  it("ships no cursor artwork of its own", () => {
    const recording = buildCursorRecording(observation);
    // The asset is a 1x1 placeholder: their renderer resolves real artwork from cursorType, and
    // shipping a bitmap here would put cursor art back in our hands.
    expect(recording.assets).toHaveLength(1);
    expect(recording.assets[0]?.width).toBe(1);
    expect(recording.assets[0]?.height).toBe(1);
  });
});

describe("exporter config", () => {
  it("produces every field their exporter reads, without a videoUrl", () => {
    const config = buildExporterConfig(observation);
    for (const key of [
      "width",
      "height",
      "frameRate",
      "bitrate",
      "wallpaper",
      "cropRegion",
      "zoomRegions",
      "cursorRecordingData",
      "cursorTelemetry",
      "cursorClickTimestamps",
    ]) {
      expect(config).toHaveProperty(key);
    }
    // The render host owns this, because it is the one serving the recording.
    expect(config).not.toHaveProperty("videoUrl");
  });

  it("passes telemetry for the camera follow as well as the cursor", () => {
    const config = buildExporterConfig(observation);
    expect((config.cursorTelemetry as unknown[]).length).toBe(observation.pointerTelemetry.length);
    expect(config.cursorClickTimestamps).toEqual([1_000, 5_000, 9_000]);
  });

  it("lets presentation be overridden without touching what was observed", () => {
    const config = buildExporterConfig(observation, { wallpaper: "#fff", borderRadius: 0 });
    expect(config.wallpaper).toBe("#fff");
    expect(config.borderRadius).toBe(0);
    expect((config.zoomRegions as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("full exporter surface", () => {
  it("passes trims, speed ramps and annotations straight through", () => {
    const config = buildExporterConfig(observation, {
      trimRegions: [{ id: "t", startMs: 0, endMs: 500 }],
      speedRegions: [{ id: "s", startMs: 1_000, endMs: 2_000, speed: 2 }],
      annotationRegions: [{ id: "a", type: "text", text: "hello" }],
    });
    expect(config.trimRegions).toHaveLength(1);
    expect(config.speedRegions).toHaveLength(1);
    expect(config.annotationRegions).toHaveLength(1);
  });

  it("defaults every optional region to empty rather than absent", () => {
    const config = buildExporterConfig(observation);
    expect(config.trimRegions).toEqual([]);
    expect(config.speedRegions).toEqual([]);
    expect(config.annotationRegions).toEqual([]);
  });

  it("forces even output dimensions, which encoders require", () => {
    const odd = buildExporterConfig({ ...observation, width: 1441, height: 761 });
    expect(odd.width).toBe(1440);
    expect(odd.height).toBe(760);

    const resized = buildExporterConfig(observation, { width: 1081, height: 1081 });
    expect(resized.width).toBe(1080);
    expect(resized.height).toBe(1080);
  });

  it("reports the duration the renderer's own dwell suggester needs", () => {
    expect(buildExporterConfig(observation).durationMs).toBe(observation.durationMs);
  });

  it("exposes the cursor controls their renderer reads", () => {
    const config = buildExporterConfig(observation, {
      cursorMotionBlur: 0.9,
      cursorScale: 2,
      cursorSmoothing: 0.4,
    });
    expect(config.cursorMotionBlur).toBe(0.9);
    expect(config.cursorScale).toBe(2);
    expect(config.cursorSmoothing).toBe(0.4);
  });

  it("does not make the rendered cursor trail its already-smoothed recording", () => {
    const config = buildExporterConfig(observation);
    expect(config.cursorSmoothing).toBe(0);
    expect(config.cursorClickBounce).toBe(openScreenDefaults.cursorClickBounce);
    expect(config.cursorClipToBounds).toBe(openScreenDefaults.cursorClipToBounds);
  });

  it("scales the cursor to the frame it is drawn on", () => {
    // Their 3.0 is calibrated for a 1080-high canvas. Applied unchanged to a shorter frame the
    // pointer dominated the picture.
    const reference = buildExporterConfig({ ...observation, height: 1080 });
    expect(reference.cursorScale).toBe(2.4);

    const shorter = buildExporterConfig({ ...observation, height: 540 });
    expect(shorter.cursorScale as number).toBeCloseTo(1.2, 1);
  });

  it("keeps the cursor its size on a capture recorded at a device scale", () => {
    // Their renderer sizes the cursor against the video's pixel width; a 1280x720 viewport recorded as 2560x1440
    // would otherwise draw it at half size. Coordinates, zooms and the frame stay those of the viewport.
    const viewport = { ...observation, width: 1280, height: 720 };
    const oneX = buildExporterConfig(viewport, { cursorScale: 1, width: 1920, height: 1080 });
    const twoX = buildExporterConfig({ ...viewport, videoWidth: 2560, videoHeight: 1440 }, { cursorScale: 1, width: 1920, height: 1080 });
    expect(twoX.cursorScale).toBe((oneX.cursorScale as number) * 2);
    expect(twoX.width).toBe(oneX.width);
    expect(twoX.zoomRegions).toEqual(oneX.zoomRegions);
    expect(twoX.cursorTelemetry).toEqual(oneX.cursorTelemetry);
    // An encoder that settled for 1920x1080 is 1.5 video pixels per CSS pixel.
    expect(buildExporterConfig({ ...viewport, videoWidth: 1920, videoHeight: 1080 }, { cursorScale: 1 }).cursorScale).toBe((oneX.cursorScale as number) * 1.5);
  });

  it("reads video density only from a plausible video size", () => {
    expect(videoDensity({ width: 1280 })).toBe(1);
    expect(videoDensity({ width: 1280, videoWidth: 2560 })).toBe(2);
    expect(videoDensity({ width: 1280, videoWidth: 640 })).toBe(1);
    expect(videoDensity({ width: 1280, videoWidth: 12_800 })).toBe(1);
    expect(videoDensity({ width: 1920, videoWidth: 2560 })).toBeCloseTo(4 / 3);
    expect(videoDensity({ width: 1920, videoWidth: 1280 })).toBeCloseTo(2 / 3);
    expect(videoDensity({ width: 0, videoWidth: 2560 })).toBe(1);
  });

  it("leaves padding alone, because it is a slider and not a pixel count", () => {
    // Scaling it by frame height silently changes how much wallpaper shows.
    for (const height of [1080, 760, 540]) {
      expect(buildExporterConfig({ ...observation, height }).padding).toBe(
        openScreenDefaults.padding,
      );
    }
  });

  it("keeps blur off by default", () => {
    expect(buildExporterConfig(observation).showBlur).toBe(false);
    expect(buildExporterConfig(observation).motionBlurAmount).toBe(0);

    // The exporter surface remains available when a caller deliberately wants the effect.
    expect(buildExporterConfig(observation, { showBlur: true }).showBlur).toBe(true);
    expect(buildExporterConfig(observation, { motionBlurAmount: 0.2 }).motionBlurAmount).toBe(0.2);
  });
});

describe("wallpaper and radius", () => {
  it("accepts bounded JPEG uploads and rejects oversized or executable images", () => {
    const jpeg = "data:image/jpeg;base64,/9j/AAAA";
    expect(resolveWallpaper(jpeg)).toBe(jpeg);
    expect(resolveWallpaper(`${jpeg}${"A".repeat(450_000)}`)).toBe(resolveWallpaper());
    expect(resolveWallpaper("data:image/svg+xml,<svg onload='alert(1)'/>")).toBe(
      resolveWallpaper(),
    );
  });

  it("accepts their wallpapers, hex colours and gradients", () => {
    expect(resolveWallpaper(wallpaperChoices[3] as string)).toBe(wallpaperChoices[3]);
    expect(resolveWallpaper("#101014")).toBe("#101014");
    expect(resolveWallpaper("linear-gradient(180deg, #111 0%, #222 100%)")).toContain("gradient");
  });

  it("refuses anything else, because it becomes a background in a page we render", () => {
    // An unconstrained string is both an injection surface and a way to make the renderer fetch a
    // URL somebody else chose.
    for (const hostile of [
      "https://example.test/pixel.png",
      "url(https://example.test/x.png)",
      "/wallpapers/../../etc/passwd",
      "red; background-image: url(https://example.test/x)",
      "",
    ]) {
      expect(resolveWallpaper(hostile)).toBe(
        openScreenDefaults.wallpaper === resolveWallpaper(hostile)
          ? openScreenDefaults.wallpaper
          : resolveWallpaper(hostile),
      );
      expect(
        wallpaperChoices.includes(resolveWallpaper(hostile)) ||
          resolveWallpaper(hostile).startsWith("/wallpapers/"),
      ).toBe(true);
    }
  });

  it("bounds the radius so it cannot swallow the frame", () => {
    expect(clampRadius(24)).toBe(24);
    expect(clampRadius(-5)).toBe(0);
    expect(clampRadius(9_999)).toBe(64);
    expect(clampRadius(Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it("carries a chosen wallpaper and radius into the config", () => {
    const chosen = wallpaperChoices[5] as string;
    const config = buildExporterConfig(observation, { wallpaper: chosen, borderRadius: 28 });
    expect(config.wallpaper).toBe(chosen);
    expect(config.borderRadius).toBe(28);
  });
});

it("frames a delayed result at its own time and bounds, without inventing a click", () => {
  const regions = proposeZoomRegions([click(1000, { x: 0.8, y: 0.2 })], 20000, [], [
    { atMs: 1000, type: "action", ref: "ref_1", element: "Send" },
    { atMs: 15000, type: "result", ref: null, element: "Table ready", focus: { x: 0.1, y: 0.4, width: 0.6, height: 0.3 } },
  ]);
  expect(regions).toHaveLength(2);
  expect(regions[0]).toMatchObject({ startMs: 100, intent: "action" });
  expect(regions[1]).toMatchObject({ startMs: 15000, endMs: 18200, focus: { cx: 0.4, cy: 0.55 }, intent: "result", focusMode: "manual" });
  const wide = proposeZoomRegions([], 20000, [], [{ atMs: 15000, type: "result", ref: null, element: "Done", focus: { x: 0, y: 0, width: 1, height: 1 } }]);
  expect(wide[0]?.customScale).toBe(1);
});

describe("identity redaction", () => {
  const footer = { x: 0.02, y: 0.92, width: 0.12, height: 0.05 };

  it("blurs the account footer from the start to the end when every read finds it", () => {
    const spans = redactionIntervals(
      [
        { atMs: 800, rects: [footer] },
        { atMs: 2_400, rects: [footer] },
        { atMs: 4_100, rects: [footer] },
      ],
      4_700,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ startMs: 0, endMs: 4_700 });
    // Padded, so a layout that shifted a little between reads stays covered.
    expect(spans[0]!.x).toBeLessThan(footer.x);
    expect(spans[0]!.x + spans[0]!.width).toBeGreaterThan(footer.x + footer.width);
  });

  it("covers the stretch around a read that found the name, until a read proves it gone", () => {
    const spans = redactionIntervals(
      [
        { atMs: 1_000, rects: [] },
        { atMs: 2_000, rects: [footer] },
        { atMs: 3_000, rects: [] },
      ],
      5_000,
    );
    expect(spans).toEqual([expect.objectContaining({ startMs: 1_000, endMs: 3_000 })]);
  });

  it("follows the name when the window's layout moves it", () => {
    const moved = { ...footer, y: 0.85 };
    const spans = redactionIntervals(
      [
        { atMs: 500, rects: [footer] },
        { atMs: 2_000, rects: [moved] },
      ],
      3_000,
    );
    expect(spans.map((span) => [span.startMs, span.endMs])).toEqual([
      [0, 2_000],
      [500, 3_000],
      [500, 2_000],
    ]);
  });

  it("blurs every position a scroll moves the name through between two reads", () => {
    const scrolled = { ...footer, y: 0.3 };
    const spans = redactionIntervals(
      [
        { atMs: 500, rects: [footer] },
        { atMs: 2_000, rects: [scrolled] },
      ],
      3_000,
    );
    const sweep = spans.find((span) => span.startMs === 500 && span.endMs === 2_000 && span.height > 0.5);
    expect(sweep).toBeDefined();
    expect(sweep!.y).toBeLessThan(scrolled.y);
    expect(sweep!.y + sweep!.height).toBeGreaterThan(footer.y + footer.height);
  });

  it("does not sweep between two different names", () => {
    const other = { x: 0.6, y: 0.1, width: 0.3, height: 0.02 };
    const spans = redactionIntervals(
      [
        { atMs: 500, rects: [footer] },
        { atMs: 2_000, rects: [other] },
      ],
      3_000,
    );
    expect(spans).toHaveLength(2);
  });

  it("starts with the click that brought the name on screen and ends with the click that took it away", () => {
    const spans = redactionIntervals(
      [
        { atMs: 500, rects: [] },
        { atMs: 1_000, rects: [footer] },
        { atMs: 3_000, rects: [] },
      ],
      5_000,
      [800, 1_500],
    );
    // Not hanging over the next screen until the next read, nor arriving before the page that shows it.
    expect(spans).toEqual([expect.objectContaining({ startMs: 800, endMs: 1_750 })]);
  });

  it("keeps a name the last read still saw blurred to the end, whatever was clicked after", () => {
    const spans = redactionIntervals(
      [
        { atMs: 300, rects: [footer] },
        { atMs: 2_600, rects: [footer] },
      ],
      8_200,
      [1_800, 4_500],
    );
    expect(spans).toEqual([expect.objectContaining({ startMs: 0, endMs: 8_200 })]);
  });

  it("asks for nothing when no read found the user's identity", () => {
    expect(redactionIntervals([{ atMs: 100, rects: [] }], 2_000)).toEqual([]);
    expect(redactionIntervals([], 2_000)).toEqual([]);
  });
});

describe("operated pauses", () => {
  it("finds where the window sat still between the navigator's steps, keeping a beat after each click", () => {
    const telemetry = [
      { atMs: 9_000, x: 0.1, y: 0.1, kind: "move" as const },
      { atMs: 9_300, x: 0.2, y: 0.2, kind: "down" as const },
      { atMs: 14_000, x: 0.3, y: 0.3, kind: "move" as const },
      { atMs: 14_400, x: 0.4, y: 0.4, kind: "down" as const },
    ];
    expect(pointerIdleRanges(telemetry, 20_000)).toEqual([
      { startMs: 0, endMs: 9_000 },
      { startMs: 9_900, endMs: 14_000 },
    ]);
  });

  it("leaves a run of steady motion alone", () => {
    const steady = Array.from({ length: 30 }, (_unused, index) => ({ atMs: 200 + index * 16, x: 0.5, y: 0.5, kind: "move" as const }));
    expect(pointerIdleRanges(steady, 2_000)).toEqual([]);
    expect(pointerIdleRanges([], 2_000)).toEqual([]);
  });
});

describe("layered Mac captures", () => {
  const window = { x: 0.1, y: 0.1, width: 0.78, height: 0.8, radius: 0.014, kind: "window" as const };
  const menu = { x: 0.82, y: 0.15, width: 0.13, height: 0.6, radius: 0.006, kind: "popup" as const };
  const inside = { x: 0.5, y: 0.2, width: 0.1, height: 0.2, radius: 0.006, kind: "popup" as const };
  const layers: CaptureLayers = { samples: [
    { atMs: 120, rects: [window] },
    { atMs: 2_000, rects: [window, inside] },
    { atMs: 3_000, rects: [window, menu] },
    { atMs: 4_500, rects: [window] },
  ] };

  it("frames the window, and the window with a menu while one reaches past it", () => {
    const timeline = layerTimeline(layers)!;
    expect(timeline.crops.map(entry => entry.atMs)).toEqual([0, 3_000, 4_500]);
    expect(timeline.crops[0]!.crop).toEqual({ x: 0.1, y: 0.1, width: 0.78, height: 0.8 });
    const wide = timeline.crops[1]!.crop;
    expect(wide.x + wide.width).toBeGreaterThan(menu.x + menu.width);
    expect(wide.x).toBeLessThan(window.x);
    expect(layerCropAt(timeline, 3_500)).toEqual(wide);
    expect(layerCropAt(timeline, 5_000)).toEqual(timeline.crops[0]!.crop);
    // The first sample is drawn from the very first frame.
    expect(timeline.samples[0]!.atMs).toBe(0);
  });

  it("is absent without a window to frame", () => {
    expect(layerTimeline(undefined)).toBeNull();
    expect(layerTimeline({ samples: [{ atMs: 0, rects: [menu] }] })).toBeNull();
  });

  it("hands the renderer the timeline and frames the window from the start", () => {
    const config = buildExporterConfig({ ...observation, layers }, { padding: 8 });
    expect(config.contentLayers).toBeTruthy();
    expect(config.cropRegion).toEqual({ x: 0.1, y: 0.1, width: 0.78, height: 0.8 });
    expect(buildExporterConfig(observation, {}).contentLayers).toBeUndefined();
  });
});

describe("backgrounds", () => {
  it("serves catalog backgrounds by id or path, and nothing else from that folder", () => {
    expect(resolveWallpaper("toru-sky")).toBe("/wallpapers/toru-sky.jpg");
    expect(resolveWallpaper("/wallpapers/openscreen-14.jpg")).toBe("/wallpapers/openscreen-14.jpg");
    expect(resolveWallpaper("/wallpapers/../secret.jpg")).not.toContain("secret");
    expect(new Set(backgroundCatalog.map(entry => entry.id)).size).toBe(backgroundCatalog.length);
  });
});

describe("still moments", () => {
  // A travel of 1s ending at 9s, then a press at 9.2s.
  const travel = (fromMs: number, toMs: number, fromX: number, toX: number): CapturePointerSample[] =>
    Array.from({ length: 11 }, (_unused, index) => ({ atMs: fromMs + (index * (toMs - fromMs)) / 10,
      x: fromX + (index * (toX - fromX)) / 10, y: 0.4, kind: "move" as const }));
  const press = (atMs: number, x: number): CapturePointerSample[] => [
    { atMs, x, y: 0.4, kind: "down" }, { atMs: atMs + 90, x, y: 0.4, kind: "up" }];
  const base = { width: 1280, height: 880, frameRate: 60, directed: true, idleRanges: [], waitRanges: [] };

  it("marks travels and presses as activity, never the rest", () => {
    const activity = pointerActivity([...travel(8_000, 9_000, 0.2, 0.5), ...press(9_200, 0.5)]);
    // A press reserves the 1.5s before it: the approach and the camera arriving.
    expect(activity).toEqual([{ startMs: 7_700, endMs: 9_990 }]);
  });

  it("cuts a still picture with a still pointer, keeping a beat after the change and before the next", () => {
    const spans = removableSpans({ ...base, durationMs: 20_000, pointerTrail: [],
      pointerTelemetry: [...travel(8_000, 9_000, 0.2, 0.5), ...press(9_200, 0.5)],
      stillRanges: [{ startMs: 2_000, endMs: 8_000 }, { startMs: 10_000, endMs: 20_000 }],
      semanticTimeline: [{ type: "result", atMs: 15_000, ref: null, element: "Done", focus: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 } }] });
    expect(spans).toEqual([
      { startMs: 2_500, endMs: 7_700 },
      { startMs: 10_500, endMs: 14_700 },
      { startMs: 18_200, endMs: 19_750 },
    ]);
  });

  it("settles the camera before the press even when the travel is short", () => {
    const regions = proposeZoomRegions([click(9_200, { x: 0.5, y: 0.4 })], 20_000,
      [...travel(8_000, 9_000, 0.2, 0.5), ...press(9_200, 0.5)], [], true);
    // Anchored on the travel the region would open at 9,103 and the camera would still be easing at the
    // press; it opens 800ms before the click instead.
    expect(regions[0]!.startMs).toBe(8_400);
  });

  it("starts the camera with the pointer when the travel leaves room", () => {
    const regions = proposeZoomRegions([click(8_500, { x: 0.5, y: 0.4 })], 20_000,
      [...travel(6_000, 7_000, 0.2, 0.5), ...press(8_500, 0.5)], [], true);
    // Their camera starts easing about 1,023ms before a region: here, 677ms after the pointer leaves at 6s,
    // and it has settled long before the press at 8.5s.
    expect(regions[0]!.startMs).toBe(7_600);
  });

  it("never cuts or speeds up the approach to a click", () => {
    const reserves = clickReserveRanges([click(5_000), click(5_800), click(12_000)]);
    expect(reserves).toEqual([{ startMs: 3_500, endMs: 6_300 }, { startMs: 10_500, endMs: 12_500 }]);
    const config = buildExporterConfig({ ...base, durationMs: 20_000, pointerTrail: [click(12_000, { x: 0.5, y: 0.4 })],
      pointerTelemetry: [], stillRanges: [{ startMs: 2_000, endMs: 19_000 }] }, { compressPauses: true, zoom: false });
    for (const trim of config.trimRegions as Array<{ startMs: number; endMs: number }>) {
      expect(trim.endMs <= 10_500 || trim.startMs >= 12_500).toBe(true);
    }
  });

  it("holds one shot over two nearby clicks when the wait between them is cut", () => {
    const pointers = [click(5_000, { x: 0.3, y: 0.3 }), click(17_000, { x: 0.3, y: 0.45 })];
    expect(proposeZoomRegions(pointers, 30_000, [], [], true)).toHaveLength(2);
    expect(proposeZoomRegions(pointers, 30_000, [], [], true, [{ startMs: 6_000, endMs: 15_000 }])).toHaveLength(1);
  });

  it("keeps a click on a wide row and the button under it in one shot", () => {
    // Opening a settings row by its title (the summary spans most of the width), then its button just below.
    const pointers = [click(1_515, { x: 0.264, y: 0.432, width: 0.623, height: 0.027 }),
      click(7_979, { x: 0.276, y: 0.525, width: 0.088, height: 0.05 })];
    expect(proposeZoomRegions(pointers, 20_000, [], [], true)).toHaveLength(1);
  });

  it("trims still moments when the still picture is measured, and never overlaps cuts", () => {
    const config = buildExporterConfig({ ...base, durationMs: 30_000,
      pointerTrail: [click(9_200, { x: 0.5, y: 0.4 })],
      pointerTelemetry: [...travel(8_000, 9_000, 0.2, 0.5), ...press(9_200, 0.5)],
      stillRanges: [{ startMs: 0, endMs: 8_000 }, { startMs: 10_000, endMs: 30_000 }],
      semanticTimeline: [{ type: "result", atMs: 20_000, ref: null, element: "Done", focus: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 } }],
    }, { compressPauses: true });
    const cuts = config.trimRegions as Array<{ startMs: number; endMs: number }>;
    expect(cuts.length).toBeGreaterThan(0);
    // The camera's ease into the click and the result itself stay whole.
    expect(cuts.every(cut => cut.endMs <= 8_000 || cut.startMs >= 9_653)).toBe(true);
    expect(cuts.every(cut => cut.endMs <= 19_700 || cut.startMs >= 23_200)).toBe(true);
    cuts.slice(1).forEach((cut, index) => expect(cut.startMs).toBeGreaterThan(cuts[index]!.endMs));
    const kept = 30_000 - cuts.reduce((sum, cut) => sum + cut.endMs - cut.startMs, 0);
    expect(kept).toBeLessThan(15_000);
  });
});

describe("web email redactions", () => {
  it("keeps blurring until a read no longer finds the address, not just past the click", () => {
    const rect = { x: 0.5, y: 0.3, width: 0.2, height: 0.02 };
    const reads = [{ atMs: 1_000, rects: [] }, { atMs: 9_000, rects: [rect] }, { atMs: 19_000, rects: [] }];
    // The account was clicked at 16.3s; the next page only loaded at 18.9s.
    const mac = redactionIntervals(reads, 30_000, [8_000, 16_300]);
    const web = redactionIntervals(reads, 30_000, [8_000, 16_300], true);
    expect(mac[0]).toMatchObject({ startMs: 8_000, endMs: 16_550 });
    expect(web[0]).toMatchObject({ startMs: 8_000, endMs: 19_000 });
  });
});

describe("brand camera and cursor", () => {
  const directed = { ...observation, directed: true, pointerTrail: [click(1_000, { width: 0.01, height: 0.01 }), click(5_000, { x: 0.2, y: 0.8, width: 0.01, height: 0.01 })] };
  const scales = (config: Record<string, unknown>) => (config.zoomRegions as Array<{ customScale: number }>).map(region => region.customScale);

  it("renders the whole frame when the brand turns zoom off", () => {
    expect(buildExporterConfig(directed, { zoom: false }).zoomRegions).toEqual([]);
  });

  it("caps every shot at the brand's zoom and can let a directed camera in past its usual 1.6", () => {
    expect(Math.max(...scales(buildExporterConfig(directed)))).toBeLessThanOrEqual(1.6);
    expect(Math.max(...scales(buildExporterConfig(directed, { zoomScale: 1.3 })))).toBeLessThanOrEqual(1.3);
    expect(Math.max(...scales(buildExporterConfig(directed, { zoomScale: 2.4 })))).toBeGreaterThan(1.6);
  });

  it("keeps the recorded cursor path when smoothing is off", () => {
    const stalled = [...path(4, 0, 16), { atMs: 900, x: 0.8, y: 0.4, kind: "move" as const }];
    const smooth = buildExporterConfig({ ...directed, pointerTelemetry: stalled });
    const raw = buildExporterConfig({ ...directed, pointerTelemetry: stalled }, { smoothCursor: false });
    expect((raw.cursorTelemetry as unknown[]).length).toBeLessThanOrEqual((smooth.cursorTelemetry as unknown[]).length);
  });
});

describe("output time", () => {
  it("shifts a moment by the intro and every cut before it", () => {
    const edit = { introMs: 1_500, cuts: [{ startMs: 2_000, endMs: 3_000 }, { startMs: 6_000, endMs: 8_000 }] };
    expect(outputTimeMs(1_000, edit)).toBe(2_500);
    expect(outputTimeMs(5_000, edit)).toBe(5_500);
    expect(outputTimeMs(10_000, edit)).toBe(8_500);
  });

  it("lands a moment inside a cut where the cut closes", () => {
    const edit = { cuts: [{ startMs: 2_000, endMs: 4_000 }] };
    expect(outputTimeMs(3_000, edit)).toBe(2_000);
    expect(outputTimeMs(4_000, edit)).toBe(2_000);
  });

  it("shrinks sped-up time without counting a cut twice", () => {
    expect(outputTimeMs(4_000, { cuts: [], speeds: [{ startMs: 0, endMs: 4_000, speed: 2 }] })).toBe(2_000);
    expect(outputTimeMs(4_000, { cuts: [{ startMs: 0, endMs: 2_000 }], speeds: [{ startMs: 0, endMs: 4_000, speed: 2 }] })).toBe(1_000);
  });
});

describe("directed pacing", () => {
  const next = (atMs: number) => ({ type: "click" as const, atMs, ref: null, element: "button Próximo" });

  it("never zooms on a click that only moves the flow on", () => {
    const step = click(3_000, { x: 0.8, y: 0.9 });
    expect(proposeZoomRegions([step], 20_000, [], [], true)).toHaveLength(1);
    expect(proposeZoomRegions([step], 20_000, [], [next(3_000)], true)).toHaveLength(0);
    expect(proposeZoomRegions([step], 20_000, [], [{ type: "navigate", atMs: 3_900, ref: null, element: "Page changed" }], true))
      .toHaveLength(0);
    // Only in a directed demo; the legacy camera is unchanged.
    expect(proposeZoomRegions([step], 20_000, [], [next(3_000)], false)).toHaveLength(1);
  });

  it("starts a new shot after the flow moves on and is wide when the step button is pressed", () => {
    const pointers = [click(2_000, { x: 0.5, y: 0.5 }), click(5_000, { x: 0.52, y: 0.56 }), click(9_000, { x: 0.5, y: 0.5 })];
    const regions = proposeZoomRegions(pointers, 20_000, [], [next(5_000)], true);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.endMs).toBeLessThanOrEqual(5_000 - 1_016 - 400);
    expect(regions[1]!.startMs).toBeGreaterThan(5_000);
  });

  it("holds one shot across clicks inside the same panel", () => {
    const panel = { x: 0.18, y: 0.2, width: 0.44, height: 0.3 };
    const apart = [click(2_000, { x: 0.2, y: 0.3 }), click(4_000, { x: 0.6, y: 0.3 })];
    expect(proposeZoomRegions(apart, 20_000, [], [], true)).toHaveLength(2);
    const inPanel = apart.map(pointer => ({ ...pointer, container: panel }));
    const regions = proposeZoomRegions(inPanel, 20_000, [], [], true);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.focus.cx).toBeCloseTo(0.4);
    expect(regions[0]!.focus.cy).toBeCloseTo(0.35);
  });

  it("keeps at most four zooms a minute, and never drops typing or the result", () => {
    const pointers = Array.from({ length: 7 }, (_unused, index) =>
      click(2_000 + index * 8_000, { x: index % 2 ? 0.8 : 0.2, y: index % 2 ? 0.8 : 0.2 }));
    const timeline = [{ type: "result" as const, atMs: 55_000, ref: null, element: "Done", focus: { x: 0.3, y: 0.3, width: 0.3, height: 0.3 } }];
    expect(proposeZoomRegions(pointers, 62_000, [], [], true)).toHaveLength(4);
    const regions = proposeZoomRegions(pointers, 62_000, [], timeline, true);
    expect(regions.filter(region => region.intent !== "result").length).toBeLessThanOrEqual(4);
    expect(regions.some(region => region.intent === "result")).toBe(true);
    for (const region of regions) {
      expect(regions.filter(other => other.startMs <= region.startMs && other.startMs > region.startMs - 60_000).length)
        .toBeLessThanOrEqual(5);
    }
  });

  it("does not pull out for less than two seconds between two zooms", () => {
    const pointers = [click(2_000, { x: 0.2, y: 0.2 }), click(5_500, { x: 0.8, y: 0.8 })];
    const regions = proposeZoomRegions(pointers, 20_000, [], [], true);
    for (let index = 1; index < regions.length; index++) {
      const gap = regions[index]!.startMs - regions[index - 1]!.endMs;
      expect(gap === 0 || gap >= 2_000).toBe(true);
    }
    expect(regions).toHaveLength(1);
  });
});

describe("camera review", () => {
  const directed = { pointerTrail: [click(5_000)], directed: true };

  it("passes the camera this package proposes for a directed demo", () => {
    const pointers = Array.from({ length: 7 }, (_unused, index) =>
      click(2_000 + index * 3_000, { x: index % 2 ? 0.8 : 0.2, y: index % 3 ? 0.7 : 0.2 }));
    const capture = { width: 1440, height: 900, frameRate: 30, durationMs: 30_000, pointerTrail: pointers,
      pointerTelemetry: [], directed: true,
      semanticTimeline: [{ type: "click" as const, atMs: 8_000, ref: null, element: "button Próximo" }] };
    expect(reviewCamera(buildExporterConfig(capture), capture)).toEqual([]);
  });

  it("flags a camera still moving when the click lands", () => {
    expect(reviewCamera({ zoomRegions: [{ startMs: 4_800, endMs: 9_000 }] }, directed)).toEqual(["camera_late"]);
    expect(reviewCamera({ zoomRegions: [{ startMs: 1_000, endMs: 4_500 }] }, directed)).toEqual(["camera_late"]);
    expect(reviewCamera({ zoomRegions: [{ startMs: 4_000, endMs: 9_000 }] }, directed)).toEqual([]);
  });

  it("flags zooms that pump out and back in or crowd a minute", () => {
    const quiet = { pointerTrail: [], directed: true };
    expect(reviewCamera({ zoomRegions: [{ startMs: 1_000, endMs: 4_000 }, { startMs: 5_000, endMs: 8_000 }] }, quiet))
      .toEqual(["zoom_pumping"]);
    expect(reviewCamera({ zoomRegions: [{ startMs: 1_000, endMs: 4_000 }, { startMs: 4_000, endMs: 8_000 }] }, quiet)).toEqual([]);
    const five = Array.from({ length: 5 }, (_unused, index) => ({ startMs: index * 10_000, endMs: index * 10_000 + 3_000 }));
    expect(reviewCamera({ zoomRegions: five }, quiet)).toEqual(["zoom_pumping"]);
    expect(reviewCamera({ zoomRegions: [...five.slice(0, 4), { ...five[4]!, intent: "result" }] }, quiet)).toEqual([]);
  });

  it("only reviews directed demos", () => {
    expect(reviewCamera({ zoomRegions: [{ startMs: 4_800, endMs: 9_000 }] }, { ...directed, directed: false })).toEqual([]);
  });
});

describe("gesture camera", () => {
  const gesture = (atMs: number, focus: { x: number; y: number; width: number; height: number }) =>
    ({ type: "emphasis" as const, atMs, endMs: atMs + 1_500, ref: null, element: "circle Total", focus });

  it("frames a gesture subtly from its start to a second after it ends", () => {
    const regions = proposeZoomRegions([], 20_000, [], [gesture(5_000, { x: 0.4, y: 0.4, width: 0.2, height: 0.1 })], true);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ intent: "emphasis", startMs: 5_000, endMs: 7_500 });
    expect(regions[0]!.customScale).toBeLessThanOrEqual(1.6);
    expect(regions[0]!.focus).toEqual({ cx: 0.5, cy: 0.45 });
  });

  it("leaves a gesture over a quarter of the screen in the wide shot", () => {
    expect(proposeZoomRegions([], 20_000, [], [gesture(5_000, { x: 0, y: 0, width: 0.6, height: 0.5 })], true)).toHaveLength(0);
  });

  it("keeps a gesture whatever the pace, and the review agrees", () => {
    const pointers = Array.from({ length: 4 }, (_unused, index) =>
      click(2_000 + index * 8_000, { x: index % 2 ? 0.8 : 0.2, y: index % 2 ? 0.8 : 0.2 }));
    const timeline = [gesture(36_000, { x: 0.4, y: 0.4, width: 0.1, height: 0.1 })];
    const regions = proposeZoomRegions(pointers, 50_000, [], timeline, true);
    expect(regions.some(region => region.intent === "emphasis")).toBe(true);
    expect(reviewCamera({ zoomRegions: regions }, { pointerTrail: pointers, directed: true })).toEqual([]);
  });
});
