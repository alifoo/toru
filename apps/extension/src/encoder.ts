import { BufferTarget, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSample, VideoSampleSource, WebMOutputFormat, type Quality } from 'mediabunny';
import type { StreamingVideoEncoder, StreamingVideoSink } from '../../../packages/browser/src/screencast.js';

type Size = { width: number; height: number };
/** One way to encode the recording: codec, frame size and target bitrate. */
export type Encoding = { codec: 'avc' | 'vp8'; width: number; height: number; bitrate: number | Quality; hardwareAcceleration?: 'prefer-hardware' };
type CanEncode = (codec: 'avc' | 'vp8', options: { width: number; height: number; bitrate: number | Quality; hardwareAcceleration?: 'prefer-hardware' }) => Promise<boolean>;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const fullHd = 1920 * 1080;

/**
 * Target bitrate for H.264 at a size, variable rate. A screen recording is text on flat colour that mostly holds
 * still, so the encoder spends far less than this on most seconds; the target is what a scroll or a page change
 * may use. Measured on a dense table scrolling nonstop at 1440p (VideoToolbox), 6 Mbps keeps 13px text as sharp as
 * 8 Mbps did, and a five-minute recording (the longest) of nothing but that stays under 230 MB, inside the 256 MB
 * upload limit. 1080p gets 4 Mbps; 720p mediabunny's own high quality (~2.8 Mbps), as before.
 */
export function avcBitrate(size: Size): number | Quality {
  const pixels = size.width * size.height;
  if (pixels > fullHd) return Math.round((6_000_000 * pixels) / (2560 * 1440) / 1000) * 1000;
  if (pixels > 1280 * 720) return Math.round((4_000_000 * pixels) / fullHd / 1000) * 1000;
  return QUALITY_HIGH;
}

/**
 * What to try, best first: the full capture size, then 3/4 and 1/2 of it, never larger than the frames themselves
 * (a screen that shows the tab at 1x sends 1x frames, and upscaling them only costs bytes), and never smaller than
 * half. Frames smaller than the capture but of its shape (a 1920x1080 viewport shown at 1x) are tried at their own
 * size first. Above 1080p only a hardware encoder is accepted: a software one at that size cannot keep up with 30fps
 * in the background, and 1080p with every frame beats 1440p with dropped ones. VP8 at the smallest size is the
 * last resort, for a Chrome without H.264 encoding. Every size is an even number of pixels, whatever the scale.
 */
export function encodingCandidates(capture: Size, frame: Size): Encoding[] {
  const sizes = [1, 0.75, 0.5].map((factor) => ({ width: even(capture.width * factor), height: even(capture.height * factor) }));
  const smallest = sizes.at(-1)!;
  const fits = (size: Size) => size.width <= frame.width + 2 && size.height <= frame.height + 2;
  const fitting = sizes.filter(fits);
  const own = { width: even(frame.width), height: even(frame.height) };
  const sameShape = Math.abs(frame.width / frame.height - capture.width / capture.height) < 0.01;
  if (sameShape && own.width < sizes[0]!.width && own.width > (fitting[0]?.width ?? 0) + 2 && own.width >= smallest.width) fitting.unshift(own);
  const ladder = fitting.length ? fitting : [smallest];
  return [
    ...ladder.map((size): Encoding => ({ codec: 'avc', ...size, bitrate: avcBitrate(size), ...(size.width * size.height > fullHd ? { hardwareAcceleration: 'prefer-hardware' as const } : {}) })),
    { codec: 'vp8', ...ladder.at(-1)!, bitrate: QUALITY_HIGH },
  ];
}

/** The first candidate this browser can encode. Throws when none can. */
export async function chooseEncoding(capture: Size, frame: Size, canEncode: CanEncode = canEncodeVideo as CanEncode): Promise<Encoding> {
  for (const candidate of encodingCandidates(capture, frame)) {
    const { codec, ...options } = candidate;
    if (await canEncode(codec, options).catch(() => false)) return candidate;
  }
  throw new Error('video_encoder_unavailable');
}

/**
 * Screencast JPEG frames to a video file inside the browser: H.264 in MP4 where Chrome can encode it
 * (hardware on most machines), VP8 in WebM otherwise. Frames keep their capture times, so pauses in the
 * page stay pauses in the video.
 *
 * The size is settled on the first frame: the capture size when the browser can encode it and the frames are that
 * large, otherwise the next step down (see encodingCandidates). `captureSize` reports what was used, so the render
 * knows how many video pixels there are per CSS pixel.
 */
export class WebCodecsStreamingEncoder implements StreamingVideoEncoder {
  /** The container of the last finished recording. */
  contentType: 'video/mp4' | 'video/webm' = 'video/webm';
  /** The frame size of the current or last recording, once its first frame is encoded. */
  captureSize: Size | undefined;
  /** Every frame is fitted into the chosen size, so a frame of another size (a resize mid-recording) never breaks the file. */
  constructor(private readonly size: Size, private readonly canEncode: CanEncode = canEncodeVideo as CanEncode) {}

  begin(framesPerSecond: number): StreamingVideoSink {
    const encoder = this;
    encoder.captureSize = undefined;
    let chain: Promise<void> = Promise.resolve();
    let failure: unknown;
    let output: Output | undefined, target: BufferTarget | undefined, source: VideoSampleSource | undefined;
    let canvas: OffscreenCanvas | undefined, context: OffscreenCanvasRenderingContext2D | undefined;
    let previous: { bitmap: ImageBitmap; atMs: number } | undefined;
    let lastAtMs = -1, finished = false, queued = 0;
    const capture = { width: even(encoder.size.width), height: even(encoder.size.height) };

    const setup = async (frame: Size) => {
      const chosen = await chooseEncoding(capture, frame, encoder.canEncode);
      const mp4 = chosen.codec === 'avc';
      canvas = new OffscreenCanvas(chosen.width, chosen.height);
      context = canvas.getContext('2d', { alpha: false })!;
      target = new BufferTarget();
      output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
      source = new VideoSampleSource({ codec: chosen.codec, bitrate: chosen.bitrate, keyFrameInterval: 2, sizeChangeBehavior: 'deny',
        ...(chosen.hardwareAcceleration ? { hardwareAcceleration: chosen.hardwareAcceleration } : {}) });
      output.addVideoTrack(source, { frameRate: framesPerSecond });
      await output.start();
      encoder.contentType = mp4 ? 'video/mp4' : 'video/webm';
      encoder.captureSize = { width: chosen.width, height: chosen.height };
    };
    const emit = async (frame: { bitmap: ImageBitmap; atMs: number }, durationMs: number) => {
      const { width, height } = canvas!;
      const scale = Math.min(width / frame.bitmap.width, height / frame.bitmap.height);
      const drawn = { width: Math.round(frame.bitmap.width * scale), height: Math.round(frame.bitmap.height * scale) };
      context!.fillStyle = '#000';
      if (drawn.width !== width || drawn.height !== height) context!.fillRect(0, 0, width, height);
      context!.imageSmoothingQuality = 'high';
      context!.drawImage(frame.bitmap, Math.round((width - drawn.width) / 2), Math.round((height - drawn.height) / 2), drawn.width, drawn.height);
      frame.bitmap.close();
      const sample = new VideoSample(canvas!, { timestamp: frame.atMs / 1000, duration: Math.max(1, durationMs) / 1000 });
      try { await source!.add(sample); } finally { sample.close(); }
    };

    return {
      write(frame: Uint8Array, atMs = 0) {
        if (finished || failure) return;
        // A frame that arrives with the same time as the last one replaces nothing: keep times increasing.
        const at = Math.max(atMs, lastAtMs + 1);
        lastAtMs = at;
        // Under pressure, drop frames rather than grow memory without bound.
        if (queued > 90) return;
        queued++;
        const bytes = frame.slice();
        chain = chain.then(async () => {
          try {
            if (failure) return;
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            if (!output) await setup({ width: bitmap.width, height: bitmap.height });
            if (previous) await emit(previous, at - previous.atMs);
            previous = { bitmap, atMs: at };
          } catch (error) { failure ??= error; } finally { queued--; }
        });
      },
      async finish(durationMs?: number) {
        finished = true;
        await chain;
        if (failure) throw failure instanceof Error ? failure : new Error('video_encoding_failed');
        if (!previous || !output || !target) throw new Error('video_has_no_frames');
        const end = Math.max(previous.atMs + 1000 / framesPerSecond, durationMs ?? 0);
        await emit(previous, end - previous.atMs);
        previous = undefined;
        await output.finalize();
        if (!target.buffer) throw new Error('video_encoding_failed');
        return new Uint8Array(target.buffer);
      },
    };
  }
}
