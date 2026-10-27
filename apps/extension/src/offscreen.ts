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
import { BUILD, captureFrameSize, captureScaleFor, chooseViewport, DEBUGGER_ADDRESS, DEVELOPMENT, OBSERVATION_WIDTH, SERVER, VERSION, type BrainState, type Credentials, type Viewport } from './config.js';
import { installDebuggerEndpoints, lastCaptureStats, useDebuggerChannel } from './debugger-socket.js';
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
const FORWARDED = ['local_sign_in_required', 'local_navigation_blocked', 'local_method_forbidden', 'extension_tab_closed', 'extension_debugger_unavailable'];

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
type Session = { tabId: number; driver: Driver; transport: CdpWebDriverTransport; product: URL; allowedOrigins: string[]; sessionPath: string; closed: boolean; encoder: WebCodecsStreamingEncoder; viewport: Viewport };
let session: Session | undefined;
detachListeners.add((tabId) => { if (session?.tabId === tabId) session.closed = true; });

function channelFor(tabId: number): DebuggerChannel {
  // A rendered frame (Page.captureScreenshot) briefly resizes the view to the emulated viewport, which can
  // swallow a mouse press. A press waits for the frame in flight, and frames wait until its release.
  //
  // Neither side waits for ever: Chrome can hold a screenshot of a page that is not painting (a static consent
  // screen, a window another one covers), and an unbounded wait there hung the click behind it until the server
  // gave the browser up. A press that fails never sends its release, so it clears the flag itself.
  let capturing: Promise<unknown> | undefined, pressed = false, releasedAt = 0;
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Input.dispatchMouseEvent' && (params.type === 'mousePressed' || params.type === 'mouseReleased')) {
      if (params.type === 'mousePressed') pressed = true;
      await Promise.race([capturing?.catch(() => undefined), pause(1_500)]);
      let failed = false;
      try { return await worker('send', { tabId, method, params }); }
      catch (error) { failed = true; throw error; }
      finally { if (params.type === 'mouseReleased' || failed) { pressed = false; releasedAt = Date.now(); } }
    }
    if (method === 'Page.captureScreenshot' && params.optimizeForSpeed) {
      const waitingSince = Date.now();
      while ((pressed || Date.now() - releasedAt < 60) && Date.now() - waitingSince < 2_000) await pause(15);
      capturing = Promise.race([worker('send', { tabId, method, params }),
        pause(5_000).then(() => { throw new Error('screenshot_timeout'); })]);
      return await capturing;
    }
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
async function open(input: { url?: unknown; allowedOrigins?: unknown; viewport?: unknown }) {
  if (typeof input?.url !== 'string') throw new Error('local_method_forbidden');
  const product = new URL(input.url);
  const allowedOrigins = Array.isArray(input.allowedOrigins) ? input.allowedOrigins.filter((origin): origin is string => typeof origin === 'string') : [product.origin];
  if (!allowedTarget(product.href, product, allowedOrigins) || product.protocol === 'about:') throw new Error('local_navigation_blocked');
  // The page layout the server chose (1920x1080 unless the recording picked another preset). A server that names
  // none predates the choice and gets the 1280x720 it expects; either way the recording reports what it used.
  const viewport = chooseViewport(input.viewport);
  const scale = captureScaleFor(viewport);
  await closeSession();
  const { tabId } = await worker<{ tabId: number }>('open', { viewport });
  const channel = channelFor(tabId);
  useDebuggerChannel(channel, scale);
  let sessionPath = '';
  // The tab renders the viewport at `scale` device pixels per CSS pixel (2560 device pixels wide at most) and the
  // screencast asks for that many: the same layout and coordinates, a sharper recording. The navigator's screenshots
  // stay 1280 wide, the viewport scaled down into them.
  const cdp = new CdpWebDriverTransport(channel, { debuggerAddress: DEBUGGER_ADDRESS, deviceScaleFactor: scale, observationWidth: OBSERVATION_WIDTH, downscale: scalePng });
  const transport = {
    request: async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
      const value = await cdp.request(method, path, body);
      if (method === 'POST' && path === '/session' && value && typeof value === 'object' && 'sessionId' in value) sessionPath = `/session/${encodeURIComponent(String(value.sessionId))}`;
      return value;
    },
  };
  const encoder = new WebCodecsStreamingEncoder(captureFrameSize(viewport));
  // The user's Chrome resolves names itself; the driver's private-network check applies to Toru's own browsers.
  const browser = new WebDriverBrowserDriver(transport, { resolveHostname: async () => ['93.184.216.34'], streamingVideoEncoder: encoder, recordingFrameRate: 30, captureScale: scale });
  try {
    const driver = await browser.createContext({
      viewport: { ...viewport }, allowedOrigins, sessionState: new TextEncoder().encode('{"cookies":[],"origins":[]}'), allowDownload: false, allowPopup: false,
      onNavigation: (url: string) => { if (!allowedTarget(url, product, allowedOrigins)) throw new Error('local_navigation_blocked'); },
    }) as Driver;
    session = { tabId, driver, transport: cdp, product, allowedOrigins, sessionPath, closed: false, encoder, viewport };
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

async function run(command: Command): Promise<{ value?: unknown; error?: string; detail?: string; meta?: Record<string, unknown> }> {
  let value: unknown;
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
      const action = active.driver[command.method as keyof Driver];
      if (typeof action !== 'function') throw new Error('local_method_forbidden');
      value = await (action as (...args: unknown[]) => unknown).apply(active.driver, command.args);
      if (command.method !== 'stopRecording') await guard(active);
      if (command.method === 'stopRecording' && value && typeof value === 'object' && 'body' in value) {
        const video = (value as { body: Uint8Array }).body;
        if (DEVELOPMENT) console.warn('capture', JSON.stringify({ ...lastCaptureStats(), size: active.encoder.captureSize, contentType: active.encoder.contentType, bytes: video.length }));
        // Up to 256 MB (five minutes of 1440p scrolling at the encoder's target): the server allows 300 s for it.
        await api(`result/${command.id}/video`, video, true, 330_000);
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
