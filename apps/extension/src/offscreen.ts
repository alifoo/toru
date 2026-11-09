/**
 * Toru for Chrome, offscreen document: the extension's brain.
 *
 * Long-polls Toru for commands, runs each one with the recorder's own browser driver over the tab the
 * service worker opened for this recording, encodes the screencast and uploads the video. Same contract as
 * the local companion: only the page methods below can be called, the page is checked before and after each
 * one, and passwords, cookies and storage never leave the browser.
 */
import { CdpWebDriverTransport, type DebuggerChannel } from '../../../packages/browser/src/cdp-webdriver.js';
import { WebDriverBrowserDriver } from '../../../packages/browser/src/webdriver.js';
import { assertLocalCommand, type LocalCommand } from '../../mcp/src/local-protocol.js';
import { privateFieldsScript, privatePageScript } from '../../mcp/src/private-page.js';
import { BUILD, captureFrameSize, captureScaleFor, chooseViewport, renderScaleFor, DEBUGGER_ADDRESS, DEVELOPMENT, OBSERVATION_WIDTH, SERVER, VERSION, type BrainState, type Credentials, type Viewport } from './config.js';
import { installDebuggerEndpoints, lastCaptureStats, liveCaptureStats, useDebuggerChannel } from './debugger-socket.js';
import { HiddenRanges, probeVisibility, watched, type PageVisibility } from './visibility.js';
import { WebCodecsStreamingEncoder } from './encoder.js';
import { scalePng } from './scale-image.js';
import { encodeValue } from './values.js';
import { allowedTarget, onProductSite } from './targets.js';

type Command = { id: string; method: string; args: unknown[] };
type Driver = Awaited<ReturnType<WebDriverBrowserDriver['createContext']>> & {
  recordingMode?: string | null; recordingStartedAtMs?: number | null;
  pointerTrail?(): unknown[]; pointerTelemetry?(): unknown[]; semanticTimeline?(): unknown[]; identitySightings?(): unknown[];
};
const METHODS = ['open', 'goto', 'currentUrl', 'readPage', 'pageText', 'screenshot', 'pointer', 'gesture', 'formInput', 'typeText', 'pressKey', 'scrollBy',
  'redactSensitiveText', 'startRecording', 'stopRecording', 'markDemoMoment', 'dispose'];
const FORWARDED = ['local_sign_in_required', 'local_navigation_blocked', 'local_method_forbidden', 'extension_tab_closed', 'extension_debugger_unavailable', 'recording_window_hidden'];

// ---- service worker port ----
let port: any;
let nextId = 0;
const waiting = new Map<number, { done(value: unknown): void; fail(error: Error): void }>();
const eventListeners = new Set<(tabId: number, method: string, params: Record<string, unknown>) => void>();
const detachListeners = new Set<(tabId: number) => void>();
function connect() {
  port = chrome.runtime.connect({ name: 'toru-brain' });
  port.onMessage.addListener((message: Record<string, any>) => {
    if (message.reply !== undefined) {
      const wait = waiting.get(message.reply);
      waiting.delete(message.reply);
      if (message.error) wait?.fail(new Error(message.error)); else wait?.done(message.result);
    } else if (message.event) {
      for (const listener of eventListeners) listener(message.event.tabId, message.event.method, message.event.params ?? {});
    } else if (message.detached) {
      for (const listener of detachListeners) listener(message.detached.tabId);
    }
  });
  port.onDisconnect.addListener(() => {
    port = undefined;
    for (const wait of waiting.values()) wait.fail(new Error('extension_worker_restarted'));
    waiting.clear();
  });
}
function worker<T = unknown>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!port) connect();
  return new Promise((done, fail) => {
    const id = ++nextId;
    waiting.set(id, { done: done as (value: unknown) => void, fail });
    port.postMessage({ id, op, ...payload });
  });
}
const report = (state: Omit<BrainState, 'at'>) => worker('state', { state }).catch(() => undefined);

// ---- Toru API ----
let credentials: Credentials | undefined;
class Unauthorized extends Error {}
/** One renewal at a time: the poll and an upload near the access token's expiry used to renew together, and the loser
 * of that race got 401 and dropped the pairing. Callers that arrive meanwhile share the renewal in flight. */
let renewing: Promise<boolean> | undefined;
function refresh(): Promise<boolean> {
  renewing ??= renew().finally(() => { renewing = undefined; });
  return renewing;
}
async function renew(): Promise<boolean> {
  if (!credentials) return false;
  const response = await fetch(`${SERVER}/extension/refresh`, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: credentials.refreshToken }),
  });
  if (response.status === 401) {
    credentials = undefined;
    await worker('store', { credentials: null });
    return false;
  }
  if (!response.ok) throw new Error(`refresh_failed_${response.status}`);
  credentials = { ...credentials, ...(await response.json() as Credentials) };
  await worker('store', { credentials });
  return true;
}
async function api(path: string, body: unknown = {}, binary = false, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!credentials) throw new Unauthorized('signed_out');
    if (credentials.accessExpiresAt - Date.now() < 60_000 && !await refresh()) throw new Unauthorized('signed_out');
    const response = await fetch(`${SERVER}/extension/${path}`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${credentials!.accessToken}`, 'content-type': binary ? 'application/octet-stream' : 'application/json', 'x-toru-extension-version': VERSION },
      body: binary ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 && attempt === 0) { if (!await refresh()) throw new Unauthorized('signed_out'); continue; }
    if (!response.ok) throw new Error(`toru_request_failed_${response.status}`);
    return await response.json() as Record<string, unknown>;
  }
  throw new Unauthorized('signed_out');
}

// ---- recording session ----
type Session = { tabId: number; driver: Driver; transport: CdpWebDriverTransport; product: URL; allowedOrigins: string[]; sessionPath: string; closed: boolean; encoder: WebCodecsStreamingEncoder; viewport: Viewport;
  channel: DebuggerChannel;
  /** Where the page was not drawn during the recording that started at `hiddenFor` (recordingStartedAtMs). */
  hidden: HiddenRanges; hiddenFor?: number };
let session: Session | undefined;
detachListeners.add((tabId) => { if (session?.tabId === tabId) session.closed = true; });

function channelFor(tabId: number): DebuggerChannel {
  // A rendered frame (Page.captureScreenshot) re-renders the view at the emulated device scale when that is not the
  // screen's own. Any mouse event Chrome receives meanwhile is mapped through the screen's own scale instead: on a 1x
  // display at a 4/3 capture scale a move or press aimed at (372, 372) lands at (279, 279), on a 2x display at 1.5
  // times the point. A click then opens the wrong row or none at all, and the hover the recording shows wanders. The
  // tab now renders at the screen's own scale (renderScaleFor), where a capture changes nothing; this stays as the
  // guard for a window dragged to a screen of another scale mid-recording. So no mouse event is sent while a frame is
  // in flight, and no frame starts while a mouse event is in flight or a button is held.
  //
  // Neither side waits for ever: Chrome can hold a screenshot of a page that is not painting (a static consent
  // screen, a window another one covers), and an unbounded wait there hung the click behind it until the server
  // gave the browser up. A press that fails never sends its release, so it clears the flag itself.
  let capturing: Promise<unknown> | undefined, inputting: Promise<unknown> | undefined, observing: Promise<unknown> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  // Two frames in flight at once leave Chrome mapping every later mouse event through the wrong scale, for good: on a
  // 1x screen at a scale of 2 a press aimed at (1316, 717) lands at (658, 358), and the next card along opens. Setting
  // the same device metrics again puts it right (no resize, under a millisecond), so a mouse event that follows an
  // overlap sends them first.
  let metrics: Record<string, unknown> | undefined, overlapped = false;
  let pressed = false, releasedAt = 0;
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') pressed = true;
      // Each event waits for the frame in flight, then claims the channel before its own await, so a frame that
      // starts later sees it.
      let release!: () => void;
      const previous = inputting;
      const mine = new Promise<void>((done) => { release = done; });
      inputting = mine;
      let failed = false;
      try {
        await Promise.race([Promise.all([capturing?.catch(() => undefined), previous]), pause(1_500)]);
        if (overlapped && metrics && !inFlight.size) {
          overlapped = false;
          await worker('send', { tabId, method: 'Emulation.setDeviceMetricsOverride', params: metrics }).catch(() => undefined);
        }
        return await worker('send', { tabId, method, params });
      }
      catch (error) { failed = true; throw error; }
      finally {
        release();
        if (inputting === mine) inputting = undefined;
        if (params.type === 'mouseReleased' || (failed && params.type === 'mousePressed')) { pressed = false; releasedAt = Date.now(); }
      }
    }
    if (method === 'Page.captureScreenshot' && params.optimizeForSpeed) {
      const waitingSince = Date.now();
      while ((pressed || inputting || observing || Date.now() - releasedAt < 60) && Date.now() - waitingSince < 2_000) {
        const busy = inputting ?? observing;
        if (busy) await Promise.race([busy.catch(() => undefined), pause(250)]); else await pause(15);
      }
      // Several frames can be in flight at once (the socket keeps a few going for a smooth capture): input waits for
      // all of them, not only the last one asked for.
      const frame = Promise.race([worker('send', { tabId, method, params }),
        pause(5_000).then(() => { throw new Error('screenshot_timeout'); })]);
      if (inFlight.size || observing) overlapped = true;
      inFlight.add(frame);
      capturing = Promise.allSettled([...inFlight]);
      try { return await frame; }
      finally { inFlight.delete(frame); capturing = inFlight.size ? Promise.allSettled([...inFlight]) : undefined; }
    }
    if (method === 'Page.captureScreenshot') {
      // The navigator's observation. Two screenshots at once render the view at two scales, and the observation came
      // back zoomed into a corner: it waits for the recording's frame in flight, and holds the next one until it is done.
      // Bounded too: a page that stops painting (a window another one covers) held it, and every call behind it, until
      // the server gave the command up 45 s later. Brought to the front, it paints again.
      const once = () => Promise.race([worker('send', { tabId, method, params }),
        pause(8_000).then(() => { throw new Error('screenshot_timeout'); })]);
      let release!: () => void;
      const mine = new Promise<void>((done) => { release = done; });
      observing = mine;
      try {
        await Promise.race([capturing?.catch(() => undefined), pause(1_500)]);
        if (inFlight.size) overlapped = true;
        try { return await once(); }
        catch (error) {
          if ((error as Error).message !== 'screenshot_timeout') throw error;
          await worker('send', { tabId, method: 'Page.bringToFront', params: {} }).catch(() => undefined);
          return await once();
        }
      } finally {
        release();
        if (observing === mine) observing = undefined;
      }
    }
    if (method === 'Emulation.setDeviceMetricsOverride') metrics = params;
    if (method === 'Emulation.clearDeviceMetricsOverride') metrics = undefined;
    return worker('send', { tabId, method, params });
  };
  return {
    send,
    onEvent: (listener) => {
      const forward = (from: number, method: string, params: Record<string, unknown>) => { if (from === tabId) listener(method, params); };
      eventListeners.add(forward);
      return () => eventListeners.delete(forward);
    },
  };
}
async function guard(active: Session) {
  if (active.closed) throw new Error('extension_tab_closed');
  const url = await active.driver.currentUrl();
  if (!allowedTarget(url, active.product, active.allowedOrigins)) throw new Error('local_navigation_blocked');
  // On the product's own site a sign-in path means the user is signed out; elsewhere (a provider's
  // consent screen under /signin/oauth) only visible password or one-time-code fields stop the recording.
  const script = onProductSite(url, active.product) ? privatePageScript : privateFieldsScript;
  if (await active.transport.request('POST', `${active.sessionPath}/execute/sync`, { script, args: [] })) throw new Error('local_sign_in_required');
}
async function closeSession() {
  const active = session;
  session = undefined;
  useDebuggerChannel(undefined);
  if (!active) return;
  await active.driver.dispose().catch(() => undefined);
  active.transport.close();
  await worker('close', { tabId: active.tabId }).catch(() => undefined);
}
async function open(input: { url?: unknown; allowedOrigins?: unknown; viewport?: unknown; sharpCapture?: unknown }) {
  if (typeof input?.url !== 'string') throw new Error('local_method_forbidden');
  const product = new URL(input.url);
  const allowedOrigins = Array.isArray(input.allowedOrigins) ? input.allowedOrigins.filter((origin): origin is string => typeof origin === 'string') : [product.origin];
  if (!allowedTarget(product.href, product, allowedOrigins) || product.protocol === 'about:') throw new Error('local_navigation_blocked');
  // The page layout the server chose (1920x1080 unless the recording picked another preset). A server that names
  // none predates the choice and gets the 1280x720 it expects; either way the recording reports what it used.
  const viewport = chooseViewport(input.viewport);
  const sharp = input.sharpCapture === true;
  const scale = captureScaleFor(viewport, sharp);
  await closeSession();
  const { tabId } = await worker<{ tabId: number }>('open', { viewport });
  const channel = channelFor(tabId);
  // The screen's own scale, read from the fresh tab (at 100%, before any device metrics override). The tab renders the
  // viewport at exactly that scale: any other makes each captured frame re-render the user's window (renderScaleFor).
  const screenScale = await channel.send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true })
    .then((result) => (result as { result?: { value?: unknown } }).result?.value, () => undefined);
  // Asked for a sharp capture, a 1x screen renders at the capture scale anyway (2560 wide): the socket then renders
  // each frame itself, which flickers the window, a cost the recording chose. A denser screen keeps its own scale.
  const render = sharp ? Math.max(renderScaleFor(screenScale), scale) : renderScaleFor(screenScale);
  useDebuggerChannel(channel, scale, render);
  let sessionPath = '';
  // The screencast asks for the viewport at `scale` (2560 device pixels wide at most): on a Retina screen Chrome scales
  // its denser frames down to that, on a 1x screen they stay 1x. The layout and every coordinate are the CSS viewport's.
  // The navigator's screenshots stay 1280 wide, the viewport scaled down into them.
  const cdp = new CdpWebDriverTransport(channel, { debuggerAddress: DEBUGGER_ADDRESS, deviceScaleFactor: render, observationWidth: OBSERVATION_WIDTH, downscale: (png, width, height) => scalePng(png, width, height, render) });
  const transport = {
    request: async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
      const value = await cdp.request(method, path, body);
      if (method === 'POST' && path === '/session' && value && typeof value === 'object' && 'sessionId' in value) sessionPath = `/session/${encodeURIComponent(String(value.sessionId))}`;
      return value;
    },
  };
  const encoder = new WebCodecsStreamingEncoder(captureFrameSize(viewport, sharp));
  // The user's Chrome resolves names itself; the driver's private-network check applies to Toru's own browsers.
  const browser = new WebDriverBrowserDriver(transport, { resolveHostname: async () => ['93.184.216.34'], streamingVideoEncoder: encoder, recordingFrameRate: 30, captureScale: scale });
  try {
    const driver = await browser.createContext({
      viewport: { ...viewport }, allowedOrigins, sessionState: new TextEncoder().encode('{"cookies":[],"origins":[]}'), allowDownload: false, allowPopup: false,
      onNavigation: (url: string) => { if (!allowedTarget(url, product, allowedOrigins)) throw new Error('local_navigation_blocked'); },
    }) as Driver;
    session = { tabId, driver, transport: cdp, product, allowedOrigins, sessionPath, closed: false, encoder, viewport, channel, hidden: new HiddenRanges() };
    await driver.goto(product.href);
    await guard(session);
    return await driver.currentUrl();
  } catch (error) {
    if (error instanceof Error && /viewport_size_mismatch/.test(`${(error as { code?: string }).code ?? ''} ${error.message}`)) {
      const measured = await channel.send('Runtime.evaluate', { expression: '[innerWidth,innerHeight,devicePixelRatio,outerWidth,outerHeight,visualViewport&&visualViewport.scale,document.visibilityState,location.protocol].join(" ")', returnByValue: true })
        .then((result) => (result as { result?: { value?: string } }).result?.value ?? '', (failure) => `measure failed ${String(failure)}`);
      const zoom = await worker('zoom', { tabId }).catch(() => 'unknown');
      error.message = `${error.message} measured ${measured} zoom ${zoom}`;
    }
    // Signed out: leave the window open so the user can sign in there, then ask the agent to record again.
    if (error instanceof Error && error.message === 'local_sign_in_required') {
      const left = session;
      session = undefined;
      useDebuggerChannel(undefined);
      left?.transport.close();
      await worker('release', { tabId }).catch(() => undefined);
    } else await closeSession();
    throw error;
  }
}

/** Whether this command found Chrome drawing the recording window; reported in its meta while recording. */
let commandVisibility: PageVisibility | undefined;
/** A command on the session, checked against Chrome not drawing the window while recording (see `watched`). */
async function perform(active: Session, command: Command): Promise<unknown> {
  const started = command.method === 'stopRecording' ? null : active.driver.recordingStartedAtMs ?? null;
  if (started && active.hiddenFor !== started) { active.hidden = new HiddenRanges(); active.hiddenFor = started; }
  const action = active.driver[command.method as keyof Driver];
  if (typeof action !== 'function') throw new Error('local_method_forbidden');
  return watched({
    method: command.method, args: command.args, clock: started ? () => Date.now() - started : undefined, hidden: active.hidden,
    probe: () => probeVisibility(active.channel), frames: () => liveCaptureStats()?.frames,
    bringToFront: async () => { await worker('send', { tabId: active.tabId, method: 'Page.bringToFront', params: {} }).catch(() => undefined); },
    seen: (state) => { commandVisibility = state; },
    act: () => (action as (...args: unknown[]) => unknown).apply(active.driver, command.args),
  });
}

async function run(command: Command): Promise<{ value?: unknown; error?: string; detail?: string; meta?: Record<string, unknown> }> {
  let value: unknown;
  commandVisibility = undefined;
  try {
    if (typeof command.id !== 'string' || !Array.isArray(command.args) || !METHODS.includes(command.method)) throw new Error('local_method_forbidden');
    if (command.method === 'open') {
      await report({ state: 'recording' });
      value = await open(command.args[0] as { url?: unknown; allowedOrigins?: unknown; viewport?: unknown });
    } else if (command.method === 'dispose') {
      await closeSession();
      await report({ state: 'online' });
      value = null;
    } else {
      assertLocalCommand(command as LocalCommand);
      const active = session;
      if (!active) throw new Error('extension_tab_closed');
      if (command.method !== 'stopRecording') await guard(active);
      value = await perform(active, command);
      if (command.method !== 'stopRecording') await guard(active);
      if (command.method === 'stopRecording' && value && typeof value === 'object' && 'body' in value) {
        const video = (value as { body: Uint8Array }).body;
        if (DEVELOPMENT) console.warn('capture', JSON.stringify({ ...lastCaptureStats(), size: active.encoder.captureSize, contentType: active.encoder.contentType, bytes: video.length }));
        // Up to 512 MB (a 20-minute Studio take): the server allows 600 s for the request and 660 s for the stop.
        await api(`result/${command.id}/video`, video, true, 600_000);
        value = { ...value, body: 'local_video_upload', contentType: active.encoder.contentType };
      }
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '';
    const error = FORWARDED.includes(message) ? message : session?.closed ? 'extension_tab_closed' : 'local_browser_action_failed';
    if (error !== 'local_browser_action_failed' || DEVELOPMENT) console.warn('toru command failed', command.method, message, DEVELOPMENT && caught instanceof Error ? caught.stack : '');
    // A short reason for Toru's logs: no URLs, no page text.
    const code = caught && typeof caught === 'object' && 'code' in caught ? `${String((caught as { code: unknown }).code)}: ` : '';
    const detail = (code + message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/[^\w .:<>()-]/g, '').slice(0, 160);
    return { error, detail, meta: meta() };
  }
  return { value: encodeValue(value), meta: meta() };
}
function meta() {
  const driver = session?.driver;
  if (!driver) return {};
  return {
    // The viewport every coordinate is in (CSS pixels), and the video's own frame size once it is known.
    captureViewport: { ...session!.viewport }, ...(session?.encoder.captureSize ? { captureSize: { ...session.encoder.captureSize } } : {}), recordingMode: driver.recordingMode,
    recordingElapsedMs: driver.recordingStartedAtMs ? Date.now() - driver.recordingStartedAtMs : undefined,
    pointerTrail: driver.pointerTrail?.(), pointerTelemetry: driver.pointerTelemetry?.(), semanticTimeline: driver.semanticTimeline?.(),
    identitySightings: driver.identitySightings?.(),
    // Whether Chrome was drawing the window at this command's check, and where it was not during the recording.
    ...(commandVisibility ? { pageVisibility: commandVisibility } : {}),
    ...(session!.hiddenFor !== undefined ? { hiddenRanges: session!.hidden.list() } : {}),
  };
}

/** An unpacked copy rebuilt on disk reloads itself, between recordings only. */
async function reloadIfRebuilt() {
  if (session || !BUILD) return;
  const onDisk = await fetch(chrome.runtime.getURL('build-id.txt'), { cache: 'no-store' }).then((response) => response.ok ? response.text() : '', () => '');
  if (onDisk.trim() && onDisk.trim() !== BUILD) await worker('reload').catch(() => undefined);
}

async function loop() {
  installDebuggerEndpoints();
  setInterval(() => void reloadIfRebuilt(), 5_000);
  setInterval(() => void worker('ping').catch(() => undefined), 20_000);
  let backoff = 1000;
  for (;;) {
    try {
      credentials ??= await worker<Credentials | null>('credentials') ?? undefined;
      if (!credentials) { await report({ state: 'signed_out' }); return; }
      const polled = await api('poll', {}, false, 30_000);
      if (!session) await report({ state: 'online' });
      backoff = 1000;
      const command = polled.command as Command | null;
      if (!command) continue;
      const result = await run(command);
      await api(`result/${command.id}`, result, false, 60_000);
    } catch (error) {
      if (error instanceof Unauthorized) { await closeSession(); await report({ state: 'signed_out' }); return; }
      await report({ state: 'offline', detail: error instanceof Error ? error.message.slice(0, 80) : 'error' });
      await new Promise((done) => setTimeout(done, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
void loop();
