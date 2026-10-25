import type { DebuggerChannel } from '../../../packages/browser/src/cdp-webdriver.js';
import { DEBUGGER_ADDRESS } from './config.js';

/**
 * The shared screencast recorder finds its page with GET /json/list and streams over a DevTools WebSocket.
 * In the extension there is no DevTools port: both are answered here, over the chrome.debugger session of
 * the tab being recorded. Every other request goes to the real fetch and WebSocket untouched.
 *
 * Chrome's screencast captures the window as it is on screen. When the window is smaller than the
 * recording viewport (a small screen, a window manager, a resize), its frames would be cropped, so the
 * socket switches to rendering the viewport itself with Page.captureScreenshot, which always renders the whole
 * emulated viewport (1920x1080 by default, at its device scale), and hands those frames to the recorder as screencast
 * frames. That is also what happens when the viewport is larger than the screen can show (a 1920x1080 viewport on a
 * 1440x900 laptop): the device metrics override keeps the layout at the full viewport, the window shows part of it.
 *
 * The recorder asks for the screencast in device pixels (the viewport times the capture scale, which may be
 * fractional: 1920 at 4/3 is 2560), while Chrome reports each frame's size in CSS pixels, so the two are compared
 * through the scale. Chrome's screencast is only as dense as the screen the window is on: on a 1x display it sends
 * one pixel per CSS pixel whatever the emulated scale. Page.captureScreenshot renders at the emulated scale on any
 * screen, so there the socket renders frames as well.
 */
let current: DebuggerChannel | undefined;
let currentScale = 1;
export function useDebuggerChannel(channel: DebuggerChannel | undefined, scale = 1) { current = channel; currentScale = scale; }

const base = `http://${DEBUGGER_ADDRESS}`;
const socketUrl = `ws://${DEBUGGER_ADDRESS}/devtools/page/toru`;
/** Synthetic frame ids start here, far above Chrome's own screencast session ids. */
const syntheticIds = 1_000_000_000;

type Frame = { data: string; metadata?: { deviceWidth?: number; deviceHeight?: number }; sessionId?: number };
export type CaptureStats = { mode: 'screencast' | 'rendered' | 'idle'; frames: number };

class DebuggerSocket extends EventTarget {
  readyState = 0;
  private unsubscribe: (() => void) | undefined;
  private wanted: { width: number; height: number; quality: number } | undefined;
  private mode: CaptureStats['mode'] = 'idle';
  private frames = 0;
  private nextSynthetic = syntheticIds;
  constructor(private readonly channel: DebuggerChannel, private readonly scale = 1) {
    super();
    this.unsubscribe = channel.onEvent((method, params) => {
      if (this.readyState !== 1 || method !== 'Page.screencastFrame') return;
      const frame = params as Frame;
      if (this.mode === 'idle' && this.wanted) {
        const { deviceWidth = 0, deviceHeight = 0 } = frame.metadata ?? {};
        // The first frame decides: the window shows the whole viewport at the capture scale, or the socket renders it itself.
        const viewport = cssViewport(this.wanted, this.scale);
        const pixels = jpegSize(frame.data);
        const cropped = Math.abs(deviceWidth - viewport.width) > 2 || Math.abs(deviceHeight - viewport.height) > 2;
        const sparse = pixels !== undefined && (pixels.width < this.wanted.width - 2 || pixels.height < this.wanted.height - 2);
        if (cropped || sparse) {
          void this.channel.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
          void this.channel.send('Page.stopScreencast', {}).catch(() => undefined);
          this.render();
          return;
        }
        this.mode = 'screencast';
      }
      if (this.mode !== 'screencast') return;
      this.frames++;
      this.emit({ method, params });
    });
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  stats(): CaptureStats { return { mode: this.mode, frames: this.frames }; }
  private emit(message: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  private rendered = false;
  private render() {
    this.mode = 'rendered';
    this.rendered = true;
    const interval = 1000 / 30;
    const pump = async () => {
      while (this.readyState === 1 && this.mode === 'rendered' && this.wanted) {
        const started = performance.now();
        try {
          const shot = await this.channel.send('Page.captureScreenshot', { format: 'jpeg', quality: this.wanted.quality, optimizeForSpeed: true }) as { data: string };
          if (this.readyState !== 1 || this.mode !== 'rendered') break;
          this.frames++;
          const viewport = cssViewport(this.wanted, this.scale);
          this.emit({ method: 'Page.screencastFrame', params: { data: shot.data, sessionId: this.nextSynthetic++, metadata: { deviceWidth: viewport.width, deviceHeight: viewport.height, synthetic: true } } });
        } catch {
          // A navigation in progress: the next capture usually succeeds.
        }
        await new Promise((done) => setTimeout(done, Math.max(0, interval - (performance.now() - started))));
      }
    };
    void pump();
  }
  send(data: string) {
    if (this.readyState !== 1) return;
    const message = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
    const params = message.params ?? {};
    if (message.method === 'Page.startScreencast') {
      this.wanted = { width: Number(params.maxWidth), height: Number(params.maxHeight), quality: Number(params.quality ?? 70) };
      this.mode = 'idle';
    }
    if (message.method === 'Page.screencastFrameAck' && Number(params.sessionId) >= syntheticIds) { this.reply(message.id, {}); return; }
    if (message.method === 'Page.stopScreencast' && this.mode === 'rendered') { this.mode = 'idle'; this.wanted = undefined; this.reply(message.id, {}); return; }
    this.channel.send(message.method, params).then(
      (result) => this.reply(message.id, result),
      (error) => { if (this.readyState === 1) this.emit({ id: message.id, error: { message: String(error?.message ?? error) } }); },
    );
  }
  private reply(id: number, result: unknown) { if (this.readyState === 1) this.emit({ id, result }); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unsubscribe?.();
    lastStats = { mode: this.rendered ? 'rendered' : this.mode, frames: this.frames };
    this.dispatchEvent(new Event('close'));
  }
}

/** A JPEG's pixel size from its frame header, read from the first few kilobytes of its base64. */
export function jpegSize(base64: string): { width: number; height: number } | undefined {
  let bytes: Uint8Array;
  // 8192 is a whole number of base64 quads, so the prefix decodes on its own.
  try { bytes = Uint8Array.from(atob(base64.slice(0, 8192)), (c) => c.charCodeAt(0)); }
  catch { return undefined; }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    // Start of frame (baseline, extended, progressive): precision, then height and width.
    if (marker >= 0xc0 && marker <= 0xc2) return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    at += 2 + length;
  }
  return undefined;
}

/** The CSS viewport a screencast asked for in device pixels shows, which is what Chrome reports per frame. */
export function cssViewport(wanted: { width: number; height: number }, scale: number) {
  return { width: Math.round(wanted.width / scale), height: Math.round(wanted.height / scale) };
}

let lastStats: CaptureStats = { mode: 'idle', frames: 0 };
/** How the last recording was captured, for diagnostics. */
export function lastCaptureStats() { return lastStats; }

export function installDebuggerEndpoints() {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${base}/`)) {
      if (url !== `${base}/json/list` || !current) return new Response('[]', { status: 404 });
      return Response.json([{ type: 'page', webSocketDebuggerUrl: socketUrl }]);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args: [string | URL, ...unknown[]]) {
      if (String(args[0]) === socketUrl) {
        if (!current) throw new Error('debugger_page_target_missing');
        return new DebuggerSocket(current, currentScale) as unknown as WebSocket;
      }
      return Reflect.construct(target, args);
    },
  });
}
