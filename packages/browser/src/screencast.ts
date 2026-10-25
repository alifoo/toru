import { browserProcessEnvironment } from './process-environment.js';
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real screen recording for the capture browser.
 *
 * Chromium pushes a frame over the DevTools Protocol every time the page changes, carrying its own
 * timestamp. Frames are spooled with explicit capture times: FFmpeg input buffering must never
 * become the video clock. Encoding happens after capture, without retaining JPEGs in memory.
 */

const maximumVideoBytes = 50 * 1024 * 1024;
/** Chromium's first screencast JPEGs are often a white compositor flash, not the page. */
const minimumPaintedJpegBytes = 8_000;
const maximumLeadSkips = 45;

/** CDP JPEG that is too small to be a painted UI — used to drop the opening flash. */
export function isLeadingBlankScreencastFrame(frame: Uint8Array): boolean {
  return frame.byteLength >= 2 && frame[0] === 0xff && frame[1] === 0xd8
    ? frame.byteLength < minimumPaintedJpegBytes
    : false;
}

/** Exact frame identity used to reject recordings whose visible pixels never changed. */
export function frameHash(frame: Uint8Array): string {
  return createHash("sha256").update(frame).digest("hex");
}

export interface StreamingVideoSink {
  write(frame: Uint8Array, atMs?: number): void;
  finish(durationMs?: number): Promise<Uint8Array>;
}

export interface StreamingVideoEncoder {
  begin(framesPerSecond: number): StreamingVideoSink;
}

export class FfmpegStreamingEncoder implements StreamingVideoEncoder {
  constructor(
    readonly executable = "ffmpeg",
    readonly timeoutMs = 120_000,
  ) {}

  begin(framesPerSecond: number): StreamingVideoSink {
    const directory = mkdtempSync(join(process.env.RECORDER_SCRATCH_DIR ?? tmpdir(), "recorder-frames-"));
    const startedAt = Date.now();
    const executable = this.executable, timeoutMs = this.timeoutMs;
    const frames: Array<{ file: string; atMs: number }> = [];
    let bytes = 0, lastHash = "";
    let failure: Error | undefined;
    let finished = false;
    return {
      write(frame, atMs = Date.now() - startedAt) {
        if (finished || failure) return;
        try {
          if (!Number.isFinite(atMs) || atMs < 0) throw new Error("capture_timestamp_invalid");
          const hash = frameHash(frame);
          if (hash === lastHash) return;
          bytes += frame.byteLength;
          // ponytail: bounded local spool; move capture storage to object storage for longer sessions.
          if (bytes > 512 * 1024 * 1024) throw new Error("capture_spool_too_large");
          const file = `${frames.length}.jpg`;
          writeFileSync(join(directory, file), frame, { mode: 0o600 });
          frames.push({ file, atMs: Math.max(frames.at(-1)?.atMs ?? 0, atMs) });
          lastHash = hash;
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
      },
      async finish(durationMs = Date.now() - startedAt) {
        if (finished) throw new Error("recording_not_started");
        finished = true;
        try {
          if (failure) throw failure;
          if (!frames.length) throw new Error("video_has_no_frames");
          if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("capture_timestamp_invalid");
          const duration = Math.max(durationMs, frames.at(-1)!.atMs + 1000 / framesPerSecond);
          const lines = ["ffconcat version 1.0"];
          for (const [index, frame] of frames.entries()) {
            // Hold the first painted frame from zero, including any compositor startup delay.
            const from = index === 0 ? 0 : frame.atMs;
            const until = frames[index + 1]?.atMs ?? duration;
            lines.push(`file '${frame.file}'`, `option framerate ${framesPerSecond}`, `duration ${(until - from) / 1000}`);
          }
          lines.push(`file '${frames.at(-1)!.file}'`, `option framerate ${framesPerSecond}`);
          writeFileSync(join(directory, "frames.ffconcat"), lines.join("\n") + "\n", { mode: 0o600 });
          const encoder = spawn(executable, [
            "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
            "-i", join(directory, "frames.ffconcat"), "-vf", `fps=${framesPerSecond}`,
            "-t", String(duration / 1000), "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p",
            "-deadline", "realtime", "-cpu-used", "8", "-f", "webm", "pipe:1",
          ], { env: browserProcessEnvironment(), stdio: ["ignore", "pipe", "ignore"] });
          const chunks: Buffer[] = [];
          let size = 0;
          const timer = setTimeout(() => {
            failure = new Error("video_encoding_timeout"); encoder.kill("SIGKILL");
          }, timeoutMs);
          try {
            await new Promise<void>((resolve, reject) => {
              encoder.on("error", reject);
              encoder.stdout.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > maximumVideoBytes) {
                  failure = new Error("video_output_too_large"); encoder.kill("SIGKILL");
                } else chunks.push(chunk);
              });
              encoder.on("close", code => code === 0 && !failure ? resolve() : reject(failure ?? new Error("video_encoding_failed")));
            });
          } finally { clearTimeout(timer); }
          if (!size) throw new Error("video_has_no_frames");
          return new Uint8Array(Buffer.concat(chunks));
        } finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  }
}

/**
 * The debugger endpoint is a full-control channel over the browser. It is only ever the loopback
 * address chromedriver reports for the session it just started; anything else is refused rather
 * than dialled.
 */
export function assertLoopbackDebuggerAddress(address: string): URL {
  const url = new URL(`http://${address.replace(/^https?:\/\//, "")}`);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    throw new Error("debugger_address_not_loopback");
  }
  if (!url.port) throw new Error("debugger_address_invalid");
  return url;
}

type CdpMessage = {
  id?: number;
  method?: string;
  params?: { data?: string; sessionId?: number };
};

export type ScreencastOptions = {
  width: number;
  height: number;
  framesPerSecond?: number;
  quality?: number;
  startedAtMs?: number;
};

export class CdpScreencastRecorder {
  #socket: WebSocket;
  #sink: StreamingVideoSink;
  #frames = 0;
  #nextId = 1;
  #stopped = false;
  #awaitingPaint = true;
  #skippedLead = 0;
  #lastSkipped: Uint8Array | null = null;
  #firstFrameHash: string | null = null;
  #hasMovement = false;

  private constructor(socket: WebSocket, sink: StreamingVideoSink, private readonly startedAtMs: number) {
    this.#socket = socket;
    this.#sink = sink;
  }

  static async start(
    debuggerAddress: string,
    encoder: StreamingVideoEncoder,
    options: ScreencastOptions,
    dependencies: {
      fetchImplementation?: typeof fetch;
      createSocket?: (url: string) => WebSocket;
    } = {},
  ): Promise<CdpScreencastRecorder> {
    const base = assertLoopbackDebuggerAddress(debuggerAddress);
    const fetchImplementation = dependencies.fetchImplementation ?? fetch;
    const response = await fetchImplementation(`${base.origin}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("debugger_target_lookup_failed");
    const targets = (await response.json()) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const target = targets.find(
      (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
    );
    if (!target?.webSocketDebuggerUrl) throw new Error("debugger_page_target_missing");

    const socket = (dependencies.createSocket ?? ((url: string) => new WebSocket(url)))(
      target.webSocketDebuggerUrl,
    );
    const framesPerSecond = options.framesPerSecond ?? 30;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debugger_connect_timeout")), 10_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("debugger_connect_failed"));
        },
        { once: true },
      );
    }).catch(error => { socket.close(); throw error; });
    const recorder = new CdpScreencastRecorder(socket, encoder.begin(framesPerSecond), options.startedAtMs ?? Date.now());
    socket.addEventListener("message", (event) => recorder.#onMessage(event));
    recorder.#send("Page.startScreencast", {
      format: "jpeg",
      quality: options.quality ?? 70,
      maxWidth: options.width,
      maxHeight: options.height,
      everyNthFrame: 1,
    });
    return recorder;
  }

  async stop(): Promise<Uint8Array> {
    if (this.#stopped) throw new Error("recording_not_started");
    this.#stopped = true;
    try {
      this.#send("Page.stopScreencast", {});
    } catch {
      // The page may already be gone; whatever was captured is still encodable.
    }
    if (this.#frames === 0 && this.#lastSkipped) {
      this.#writeFrame(this.#lastSkipped);
    }
    this.#lastSkipped = null;
    this.#socket.close();
    const body = await this.#sink.finish(Math.max(0, Date.now() - this.startedAtMs));
    if (!this.#hasMovement) {
      body.fill(0);
      throw new Error("recording_frozen");
    }
    return body;
  }

  #send(method: string, params: Record<string, unknown>): void {
    this.#socket.send(JSON.stringify({ id: this.#nextId++, method, params }));
  }

  #onMessage(event: MessageEvent): void {
    if (this.#stopped) return;
    let message: CdpMessage;
    try {
      message = JSON.parse(String(event.data)) as CdpMessage;
    } catch {
      return;
    }
    if (message.method !== "Page.screencastFrame" || !message.params?.data) return;
    // Chromium stops sending frames until each one is acknowledged.
    if (typeof message.params.sessionId === "number") {
      this.#send("Page.screencastFrameAck", { sessionId: message.params.sessionId });
    }
    const frame = new Uint8Array(Buffer.from(message.params.data, "base64"));
    if (
      this.#awaitingPaint &&
      isLeadingBlankScreencastFrame(frame) &&
      this.#skippedLead < maximumLeadSkips
    ) {
      this.#skippedLead += 1;
      this.#lastSkipped = frame;
      return;
    }
    this.#awaitingPaint = false;
    this.#writeFrame(frame);
  }

  #writeFrame(frame: Uint8Array): void {
    const hash = frameHash(frame);
    if (this.#firstFrameHash === null) this.#firstFrameHash = hash;
    else if (hash !== this.#firstFrameHash) this.#hasMovement = true;
    this.#frames += 1;
    this.#sink.write(frame, Math.max(0, Date.now() - this.startedAtMs));
  }
}
