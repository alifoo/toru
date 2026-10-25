// pnpm --filter @content-layer/render-worker build && pnpm --filter @content-layer/render-host build
// node scripts/benchmark-render-gpu.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createRenderHost, resolveBrowserBinary } from "../packages/render-host/dist/index.js";

const run = promisify(execFile);
const keptDirectory = process.argv[2] ? resolve(process.argv[2]) : null;
const directory = keptDirectory ?? await mkdtemp(join(tmpdir(), "recorder-gpu-benchmark-"));
if (keptDirectory) await mkdir(keptDirectory, { recursive: true });
const sourcePath = join(directory, "source.mp4");
const outputs = {};

try {
  await run("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=4",
    "-pix_fmt", "yuv420p", "-y", sourcePath,
  ]);

  const host = createRenderHost({
    browserBinary: await resolveBrowserBinary(),
    browserArguments: ["--enable-gpu", "--ignore-gpu-blocklist"],
  });
  const baseConfig = {
    width: 1920,
    height: 1080,
    frameRate: 60,
    bitrate: 8_000_000,
    durationMs: 4_000,
    wallpaper: "linear-gradient(135deg, #101426 0%, #43225d 100%)",
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    zoomRegions: [{
      id: "benchmark",
      startMs: 500,
      endMs: 3_300,
      depth: 2,
      customScale: 1.6,
      focus: { cx: 0.62, cy: 0.42 },
      focusMode: "manual",
    }],
    trimRegions: [],
    speedRegions: [],
    annotationRegions: [],
    showShadow: true,
    shadowIntensity: 0.45,
    showBlur: false,
    motionBlurAmount: 0,
    borderRadius: 24,
    padding: 50,
    videoPadding: 0,
    cursorScale: 0,
  };

  for (const renderBackend of ["portable", "gpu"]) {
    const result = await host.render({
      sourcePath,
      config: { ...baseConfig, renderBackend },
      timeoutMs: 5 * 60_000,
    });
    assert.equal(result.status, "rendered", result.reason);
    assert.equal(result.rendererBackend, renderBackend, `${renderBackend} backend was not selected`);
    const outputPath = join(directory, `${renderBackend}.mp4`);
    await writeFile(outputPath, result.bytes);
    outputs[renderBackend] = { durationMs: result.durationMs, outputPath };
  }

  const comparison = await run("ffmpeg", [
    "-v", "info", "-i", outputs.portable.outputPath, "-i", outputs.gpu.outputPath,
    "-lavfi", "[0:v][1:v]ssim;[0:v][1:v]psnr", "-f", "null", "-",
  ]);
  const ssim = comparison.stderr.match(/SSIM[^\n]*All:([0-9.]+)/)?.[1];
  const psnr = comparison.stderr.match(/PSNR[^\n]*average:([0-9.]+)/)?.[1];
  console.log(JSON.stringify({
    portableMs: outputs.portable.durationMs,
    gpuMs: outputs.gpu.durationMs,
    speedup: Number((outputs.portable.durationMs / outputs.gpu.durationMs).toFixed(2)),
    ssim: ssim ? Number(ssim) : null,
    psnrDb: psnr ? Number(psnr) : null,
  }, null, 2));
} finally {
  if (!keptDirectory) await rm(directory, { recursive: true, force: true });
}
