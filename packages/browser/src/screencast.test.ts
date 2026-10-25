import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  assertLoopbackDebuggerAddress,
  CdpScreencastRecorder,
  FfmpegStreamingEncoder,
  isLeadingBlankScreencastFrame,
  type StreamingVideoEncoder,
} from "./screencast.js";
import { debuggerAddressOf } from "./webdriver.js";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  readonly sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  closed = false;
  #listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    if (type === "open") queueMicrotask(() => listener({}));
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
  }

  emitFrame(data: string, sessionId: number) {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({
        data: JSON.stringify({
          method: "Page.screencastFrame",
          params: { data, sessionId },
        }),
      });
    }
  }
}

function recordingEncoder() {
  const frames: Uint8Array[] = [];
  const encoder: StreamingVideoEncoder = {
    begin: vi.fn(() => ({
      write: (frame: Uint8Array) => frames.push(frame),
      finish: async () => new TextEncoder().encode("webm"),
    })),
  };
  return { encoder, frames };
}

const targets = [
  { type: "background_page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/background" },
  { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/main" },
];

describe("CDP screencast recorder", () => {
  it("streams acknowledged frames from the page target into the encoder", async () => {
    const socket = new FakeSocket();
    const { encoder, frames } = recordingEncoder();
    const fetchImplementation = vi.fn(
      async () => new Response(JSON.stringify(targets), { status: 200 }),
    );

    const recorder = await CdpScreencastRecorder.start(
      "127.0.0.1:9222",
      encoder,
      { width: 1280, height: 720 },
      { fetchImplementation, createSocket: () => socket as unknown as WebSocket },
    );

    socket.emitFrame(Buffer.from("first-frame").toString("base64"), 1);
    socket.emitFrame(Buffer.from("second-frame").toString("base64"), 2);
    const video = await recorder.stop();

    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/list",
      expect.anything(),
    );
    expect(socket.sent[0]?.method).toBe("Page.startScreencast");
    expect(socket.sent[0]?.params).toMatchObject({
      format: "jpeg",
      maxWidth: 1280,
      maxHeight: 720,
    });
    // Chromium sends no further frames until each one is acknowledged.
    expect(socket.sent.filter((call) => call.method === "Page.screencastFrameAck")).toHaveLength(2);
    expect(frames.map((frame) => new TextDecoder().decode(frame))).toEqual([
      "first-frame",
      "second-frame",
    ]);
    expect(socket.sent.at(-1)?.method).toBe("Page.stopScreencast");
    expect(socket.closed).toBe(true);
    expect(new TextDecoder().decode(video)).toBe("webm");
  });

  it("keeps recording late interactions after 3,600 incoming frames", async () => {
    const socket = new FakeSocket();
    const { encoder, frames } = recordingEncoder();
    const recorder = await CdpScreencastRecorder.start(
      "127.0.0.1:9222",
      encoder,
      { width: 800, height: 600 },
      {
        fetchImplementation: async () => new Response(JSON.stringify(targets), { status: 200 }),
        createSocket: () => socket as unknown as WebSocket,
      },
    );

    for (let index = 0; index < 3_600; index++) {
      socket.emitFrame(Buffer.from(`animation-${index}`).toString("base64"), index);
    }
    socket.emitFrame(Buffer.from("late-click-result").toString("base64"), 3_600);
    await recorder.stop();

    expect(frames).toHaveLength(3_601);
    expect(new TextDecoder().decode(frames.at(-1))).toBe("late-click-result");
    expect(socket.sent.filter((call) => call.method === "Page.screencastFrameAck")).toHaveLength(
      3_601,
    );
  });

  it("ignores frames that arrive after the recording stopped", async () => {
    const socket = new FakeSocket();
    const { encoder, frames } = recordingEncoder();
    const recorder = await CdpScreencastRecorder.start(
      "127.0.0.1:9222",
      encoder,
      { width: 800, height: 600 },
      {
        fetchImplementation: async () => new Response(JSON.stringify(targets), { status: 200 }),
        createSocket: () => socket as unknown as WebSocket,
      },
    );

    await expect(recorder.stop()).rejects.toThrow("recording_frozen");
    socket.emitFrame(Buffer.from("late").toString("base64"), 3);

    expect(frames).toHaveLength(0);
    await expect(recorder.stop()).rejects.toThrow("recording_not_started");
  });

  it("refuses a debugger address that is not loopback", () => {
    expect(assertLoopbackDebuggerAddress("127.0.0.1:9222").port).toBe("9222");
    expect(assertLoopbackDebuggerAddress("localhost:9333").port).toBe("9333");
    expect(() => assertLoopbackDebuggerAddress("attacker.test:9222")).toThrow(
      "debugger_address_not_loopback",
    );
    expect(() => assertLoopbackDebuggerAddress("169.254.169.254:80")).toThrow(
      "debugger_address_not_loopback",
    );
    expect(() => assertLoopbackDebuggerAddress("127.0.0.1")).toThrow("debugger_address_invalid");
  });

  it("upgrades to screencast only when chromedriver reports a debugger address", () => {
    expect(
      debuggerAddressOf({ "goog:chromeOptions": { debuggerAddress: "127.0.0.1:57321" } }),
    ).toBe("127.0.0.1:57321");
    expect(debuggerAddressOf({})).toBeNull();
    expect(debuggerAddressOf({ "goog:chromeOptions": {} })).toBeNull();
    expect(debuggerAddressOf({ "goog:chromeOptions": { debuggerAddress: "" } })).toBeNull();
    expect(debuggerAddressOf(undefined)).toBeNull();
  });

  it("drops opening compositor-flash JPEGs and keeps the first painted frame", async () => {
    const socket = new FakeSocket();
    const { encoder, frames } = recordingEncoder();
    const recorder = await CdpScreencastRecorder.start(
      "127.0.0.1:9222",
      encoder,
      { width: 1280, height: 720 },
      {
        fetchImplementation: async () => new Response(JSON.stringify(targets), { status: 200 }),
        createSocket: () => socket as unknown as WebSocket,
      },
    );
    const flash = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(200, 0xff),
      Buffer.from([0xff, 0xd9]),
    ]);
    const painted = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(24_000, 0x80),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(isLeadingBlankScreencastFrame(flash)).toBe(true);
    expect(isLeadingBlankScreencastFrame(painted)).toBe(false);

    socket.emitFrame(flash.toString("base64"), 1);
    socket.emitFrame(painted.toString("base64"), 2);
    await expect(recorder.stop()).rejects.toThrow("recording_frozen");

    expect(frames).toHaveLength(1);
    expect(frames[0]?.byteLength).toBe(painted.byteLength);
  });

  it("encodes the last opening flash when the page never paints", async () => {
    const socket = new FakeSocket();
    const { encoder, frames } = recordingEncoder();
    const recorder = await CdpScreencastRecorder.start(
      "127.0.0.1:9222",
      encoder,
      { width: 1280, height: 720 },
      {
        fetchImplementation: async () => new Response(JSON.stringify(targets), { status: 200 }),
        createSocket: () => socket as unknown as WebSocket,
      },
    );
    const flash = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(200, 0xff),
      Buffer.from([0xff, 0xd9]),
    ]);
    socket.emitFrame(flash.toString("base64"), 1);
    await expect(recorder.stop()).rejects.toThrow("recording_frozen");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.byteLength).toBe(flash.byteLength);
  });

  it("reports an unreachable debugger endpoint so the caller can degrade", async () => {
    await expect(
      CdpScreencastRecorder.start(
        "127.0.0.1:9222",
        recordingEncoder().encoder,
        { width: 800, height: 600 },
        {
          fetchImplementation: async () => new Response("nope", { status: 500 }),
          createSocket: () => new FakeSocket() as unknown as WebSocket,
        },
      ),
    ).rejects.toThrow("debugger_target_lookup_failed");
  });

  it("fails when the browser exposes no page target", async () => {
    await expect(
      CdpScreencastRecorder.start(
        "127.0.0.1:9222",
        recordingEncoder().encoder,
        { width: 800, height: 600 },
        {
          fetchImplementation: async () =>
            new Response(JSON.stringify([targets[0]]), { status: 200 }),
          createSocket: () => new FakeSocket() as unknown as WebSocket,
        },
      ),
    ).rejects.toThrow("debugger_page_target_missing");
  });
});

// Real encoder regression: delivered in a burst, but captured a second apart.
it("encodes capture timestamps and the final hold independently of delivery/encoding speed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-clock-test-"));
  try {
    const jpeg = (color: string) => execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=64x64`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"]);
    const sink = new FfmpegStreamingEncoder().begin(60);
    sink.write(jpeg("red"), 0);
    sink.write(jpeg("blue"), 1000);
    // Encode immediately: wallclock-based image2pipe collapses this to almost no video.
    const video = join(dir, "timed.webm");
    await writeFile(video, await sink.finish(2000));
    const pixel = (at: string) => execFileSync("ffmpeg", ["-v", "error", "-ss", at, "-i", video, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    expect([...pixel("0.8")]).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(pixel("0.8")[0]).toBeGreaterThan(200);
    expect(pixel("1.2")[2]).toBeGreaterThan(200);
    expect(pixel("1.9")[2]).toBeGreaterThan(200);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
