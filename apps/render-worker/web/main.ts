// Imported from its own module rather than the package barrel: the barrel also re-exports the GIF
// exporter, which pulls in gif.js for a format this pipeline does not produce.

// The dwell regions this page adds need the same focus handling as the click regions the contract
// builds, and having one implementation of it is the point of it living there.
import { type CropRegion, focusWithinContent } from "@content-layer/render-contract";
import { buildAutoZoomSuggestions } from "@/components/video-editor/timeline/zoomSuggestionUtils";
import { VideoExporter } from "@/lib/exporter/videoExporter";

/**
 * Render host page.
 *
 * Serves one purpose: hand OpenScreen's exporter a config and return the MP4 it produces. No
 * rendering decision is made here — camera, motion blur, cursor and background all belong to the
 * vendored code, which is the entire point of running it rather than reimplementing it.
 *
 * This page must be served from http://127.0.0.1. WebCodecs is gated on a secure context, and on an
 * opaque origin the exporter fails by reporting its own API as absent.
 */
declare global {
  interface Window {
    renderDemo: (
      config: unknown,
    ) => Promise<
      | { ok: true; bytes: number; backend: "portable" | "gpu" | null }
      | { ok: false; error: string }
    >;
    renderProgress: { currentFrame: number; totalFrames: number } | null;
    renderBackend: "portable" | "gpu" | null;
  }
}

window.renderProgress = null;
window.renderBackend = null;

/**
 * Adds the zoom regions their own suggester finds, alongside the ones derived from clicks.
 *
 * The two see different things. We know exactly where every click landed, which upstream can only
 * infer; upstream detects dwell — the pointer lingering while someone reads or hovers — which we
 * have no other way to notice. Click regions are passed as reserved spans so a suggestion never
 * lands on top of one.
 */
function withDwellSuggestions(config: Record<string, unknown>): Record<string, unknown> {
  if (config.suppressDwellZooms === true) return config;
  const telemetry = (config.cursorTelemetry ?? []) as Array<{
    timeMs: number;
    cx: number;
    cy: number;
  }>;
  const clickRegions = (config.zoomRegions ?? []) as Array<{
    startMs: number;
    endMs: number;
    depth: number;
  }>;
  const totalMs = Number(config.durationMs ?? 0);
  if (totalMs <= 0 || telemetry.length < 2) return config;

  const suggestions = buildAutoZoomSuggestions({
    cursorTelemetry: telemetry,
    totalMs,
    existingRegions: clickRegions,
    defaultDurationMs: 2_200,
  });
  const speedRegions = (config.speedRegions ?? []) as Array<{ startMs: number; endMs: number; speed: number }>;

  // Their suggester averages the cursor telemetry it is given, and the contract already hands that
  // over projected into frame space — so a suggestion's focus arrives in the space a region wants and
  // must not be projected a second time. It is still bounded, because an average of safe points is
  // safe only for the scale they were bounded at, and this region has its own.
  const rect = (config.contentRect ?? { x: 0, y: 0, width: 1, height: 1 }) as CropRegion;
  const edgeInset = Number(config.contentEdgeInset ?? 0);
  // Shallower than a click, and following the pointer rather than fixed: nobody acted here, they
  // were reading, and what holds the interest is wherever the cursor drifts.
  const dwellScale = 1.5;

  return {
    ...config,
    zoomRegions: [
      ...clickRegions,
      // Idle cursor dwell is not an action; don't invent a zoom that gets accelerated mid-ease.
      ...suggestions.filter(suggestion => !speedRegions.some(region => region.speed !== 1 &&
        suggestion.span.start - 1_000 < region.endMs && suggestion.span.end + 1_000 > region.startMs))
        .map((suggestion, index) => ({
        id: `dwell-${index}`,
        startMs: suggestion.span.start,
        endMs: suggestion.span.end,
        depth: 2,
        customScale: dwellScale,
        focus: focusWithinContent(suggestion.focus, dwellScale, rect, edgeInset),
        focusMode: "auto" as const,
        source: "auto" as const,
      })),
    ],
  };
}

window.renderDemo = async (rawConfig) => {
  try {
    const config = withDwellSuggestions(rawConfig as Record<string, unknown>);
    const exporter = new VideoExporter({
      ...config,
      onProgress: (progress: { currentFrame: number; totalFrames: number }) => {
        window.renderProgress = {
          currentFrame: progress.currentFrame,
          totalFrames: progress.totalFrames,
        };
      },
      onRendererReady: (backend: "portable" | "gpu") => {
        window.renderBackend = backend;
      },
    } as unknown as ConstructorParameters<typeof VideoExporter>[0]);

    const result = await exporter.export();
    if (!result.success || !result.blob) {
      return { ok: false, error: result.error ?? "export produced no output" };
    }
    // Posted back to the host rather than returned through the debugging protocol: the finished file
    // is megabytes, and base64 over CDP is both slower and bounded by message size limits.
    const response = await fetch("/result", { method: "POST", body: result.blob });
    if (!response.ok) return { ok: false, error: `host rejected the result: ${response.status}` };
    return { ok: true, bytes: result.blob.size, backend: window.renderBackend };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
