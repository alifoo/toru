import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildExporterConfig } from "@content-layer/render-contract";
import { describe, expect, it } from "vitest";
import { createRenderHost } from "./index.js";

const run = promisify(execFile);

/**
 * The whole post-production path, end to end: an observation becomes a config, the config becomes a
 * render, and the render becomes a playable file.
 *
 * Gated because it needs a browser and takes seconds, and hermetic because the source is synthetic:
 * capturing a real site would make this a test of that site's availability. What it proves is the
 * part no unit test can — that their exporter accepts what our contract produces.
 *
 * Run with RUN_RENDER_E2E=true and RENDER_BROWSER_BINARY pointing at a Chromium with WebCodecs.
 */
describe.skipIf(process.env.RUN_RENDER_E2E !== "true")("render end to end", () => {
  it.each([false, true])("shortens client pauses while source frames and result zooms keep the same clock (directed=%s)", async (directed) => {
    const directory = mkdtempSync(join(tmpdir(), "render-pacing-"));
    try {
      const sourcePath = join(directory, "source.mp4");
      await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:size=640x360:rate=30:duration=18",
        "-vf", "drawbox=color=lime:t=fill:enable='gte(t,6)',drawbox=color=blue:t=fill:enable='gte(t,10)'",
        "-pix_fmt", "yuv420p", sourcePath]);
      const config = buildExporterConfig({ width: 640, height: 360, frameRate: 30, durationMs: 18_000, directed,
        pointerTrail: [], pointerTelemetry: Array.from({ length: 36 }, (_, i) => ({ atMs: i * 500, x: 0.5, y: 0.5, kind: "move" as const })),
        idleRanges: [{ startMs: 0, endMs: 6_000 }, { startMs: 10_000, endMs: 18_000 }],
        semanticTimeline: [{ atMs: 10_000, type: "result", ref: null, element: "Blue result",
          focus: { x: 0.2, y: 0.2, width: 0.5, height: 0.3 } }],
      }, { compressPauses: true, wallpaper: "#101014", padding: 0, borderRadius: 0, showShadow: false });
      const regions = config.speedRegions as Array<{ startMs: number; endMs: number; speed: number }>;
      const trims = config.trimRegions as Array<{ startMs: number; endMs: number }>;
      const outputTime = (sourceMs: number) => sourceMs - trims.reduce((sum, r) => sum + Math.max(0, Math.min(sourceMs, r.endMs) - r.startMs), 0) - regions.reduce((saved, r) =>
        saved + Math.max(0, Math.min(sourceMs, r.endMs) - r.startMs) * (1 - 1 / r.speed), 0);
      expect(outputTime(18_000)).toBeLessThan(14_000);
      expect(outputTime(10_000) - outputTime(6_000)).toBeCloseTo(4_000);
      expect(config.zoomRegions).toContainEqual(expect.objectContaining({ startMs: 10_000 }));
      const outcome = await createRenderHost({ browserBinary: process.env.RENDER_BROWSER_BINARY! }).render({ sourcePath, config, timeoutMs: 120_000 });
      if (outcome.status !== "rendered") throw new Error(outcome.reason);
      const path = join(directory, "rendered.mp4");
      writeFileSync(path, outcome.bytes);
      const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", path]);
      expect(Math.abs(Number(JSON.parse(probe.stdout).format.duration) * 1000 - outputTime(18_000))).toBeLessThan(150);
      for (const [sourceMs, channel] of [[3_000, 0], [8_000, 1], [12_000, 2]]) {
        const frame = await run("ffmpeg", ["-v", "error", "-ss", String(outputTime(sourceMs!) / 1000), "-i", path,
          "-frames:v", "1", "-vf", "crop=2:2:100:100,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
        expect(frame.stdout[channel!]).toBeGreaterThan(200);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 150_000);

  it("bounds startup and allows cancellation before the exporter is ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "render-startup-"));
    writeFileSync(join(directory, "index.html"), "<html>Never installs renderDemo</html>");
    const host = createRenderHost({ browserBinary: process.env.RENDER_BROWSER_BINARY!, bundleDirectory: directory });
    try {
      for (const cancel of [false, true]) {
        const controller = new AbortController();
        const timer = cancel ? setTimeout(() => controller.abort(), 300) : undefined;
        const start = Date.now();
        const result = await host.render({ sourcePath: join(directory, "index.html"), config: {}, timeoutMs: 1_000, signal: controller.signal });
        clearTimeout(timer);
        expect(result).toMatchObject({ status: "failed", reason: cancel ? "render_canceled" : "render_timeout" });
        expect(Date.now() - start).toBeLessThan(5_000);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);

  it("turns an observation into a playable recording", async () => {
    const browserBinary = process.env.RENDER_BROWSER_BINARY;
    expect(browserBinary, "RENDER_BROWSER_BINARY must point at a browser").toBeTruthy();

    const directory = mkdtempSync(join(tmpdir(), "render-e2e-"));
    const sourcePath = join(directory, "source.mp4");
    const width = 1280;
    const height = 720;
    const frameRate = 30;
    const frames = 90;

    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${width}x${height}:rate=${frameRate}:duration=3`,
      "-frames:v",
      String(frames),
      "-pix_fmt",
      "yuv420p",
      "-y",
      sourcePath,
    ]);

    const durationMs = Math.round((frames / frameRate) * 1000);
    const config = buildExporterConfig(
      {
        width,
        height,
        frameRate,
        durationMs,
        // Two clicks on differently sized targets, so the regions cannot come out identical.
        pointerTrail: [
          { atMs: 700, x: 0.3, y: 0.3, shape: "hand", width: 0.03, height: 0.02 },
          { atMs: 2_200, x: 0.7, y: 0.6, shape: "arrow", width: 0.5, height: 0.2 },
        ],
        pointerTelemetry: Array.from({ length: 90 }, (_unused, index) => ({
          atMs: index * 33,
          x: 0.3 + index * 0.004,
          y: 0.3 + index * 0.003,
          kind: index === 21 ? ("down" as const) : ("move" as const),
        })),
      },
      { wallpaper: "#101014", borderRadius: 12 },
    );

    // The contract is doing its job only if the two clicks produced different depths.
    const regions = config.zoomRegions as Array<{ depth: number }>;
    expect(regions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(regions.map((region) => region.depth)).size).toBeGreaterThan(1);

    const outcome = await createRenderHost({ browserBinary: browserBinary as string }).render({
      sourcePath,
      config,
      timeoutMs: 5 * 60_000,
    });
    if (outcome.status !== "rendered") throw new Error(`render failed: ${outcome.reason}`);
    expect(outcome.bytes.byteLength).toBeGreaterThan(10_000);

    const renderedPath = join(directory, "rendered.mp4");
    writeFileSync(renderedPath, outcome.bytes);

    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,nb_read_frames",
      "-of",
      "json",
      renderedPath,
    ]);
    const stream = JSON.parse(stdout).streams[0];
    expect(stream.codec_name).toBe("h264");
    expect(stream.width).toBe(width);
    expect(stream.height).toBe(height);
    // A render that stops early is the failure this pipeline has produced before.
    expect(Number(stream.nb_read_frames)).toBeGreaterThan(frames * 0.9);
  }, 300_000);
});
