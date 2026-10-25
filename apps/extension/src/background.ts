/**
 * Toru for Chrome, service worker.
 *
 * Holds the pairing, keeps the offscreen document (which talks to Toru and runs the driver) alive, and relays
 * DevTools commands to the one window it opened for the current recording. It never attaches to a tab it did
 * not open, and only the commands the driver needs pass.
 */
import { CDP_COMMANDS, chooseViewport, SERVER, VERSION, type BrainState, type Credentials, type Viewport } from './config.js';
import { RECORDING_PLACEHOLDER } from './placeholder.js';

type Session = { tabId: number; windowId: number };
const offscreenUrl = chrome.runtime.getURL('offscreen.html');
let brain: any;

async function credentials(): Promise<Credentials | undefined> {
  return (await chrome.storage.local.get('credentials')).credentials;
}
async function sessions(): Promise<Session[]> {
  return (await chrome.storage.session.get('sessions')).sessions ?? [];
}
async function saveSessions(list: Session[]) {
  await chrome.storage.session.set({ sessions: list });
}
async function setState(state: BrainState) {
  await chrome.storage.session.set({ state });
  await chrome.action.setBadgeText({ text: state.state === 'recording' ? 'REC' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}

async function ensureOffscreen() {
  if (!(await credentials())) return;
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS'],
    justification: 'Talks to Toru and encodes the recording of the tab Toru opened into a video file.',
  }).catch(() => undefined);
}
async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => undefined);
}

function deviceName() {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return `Chrome${platform ? ` on ${platform === 'macOS' ? 'Mac' : platform}` : ''}`;
}
async function pair(code: string) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return { error: 'pairing_code_invalid' };
  const response = await fetch(`${SERVER}/extension/pair`, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-toru-extension-version': VERSION },
    body: JSON.stringify({ code, deviceName: deviceName() }),
  }).catch(() => undefined);
  if (!response?.ok) return { error: response?.status === 401 ? 'pairing_code_invalid' : 'toru_unreachable' };
  const issued = await response.json() as Credentials;
  await chrome.storage.local.set({ credentials: issued });
  await closeOffscreen();
  await ensureOffscreen();
  return { paired: true, connectionId: issued.connectionId ?? issued.deviceId };
}
async function unpair() {
  const current = await credentials();
  if (current) {
    await fetch(`${SERVER}/extension/revoke`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${current.accessToken}` } }).catch(() => undefined);
  }
  await chrome.storage.local.remove('credentials');
  await closeOffscreen();
  for (const session of await sessions()) await closeSession(session.tabId);
  await setState({ state: 'signed_out', at: Date.now() });
  return { unpaired: true };
}

/**
 * Where the recording window opens: always on a secondary display when one is connected, so it stays
 * off the main screen; on the primary display only when there is a single screen.
 */
async function recordingBounds(width: number, height: number): Promise<Record<string, number>> {
  type Area = { left: number; top: number; width: number; height: number };
  type Display = { isPrimary: boolean; isEnabled?: boolean; workArea: Area };
  const api = (chrome as unknown as { system?: { display?: { getInfo(): Promise<Display[]> } } }).system?.display;
  const displays: Display[] = api ? await api.getInfo().catch(() => []) : [];
  const enabled = displays.filter((item) => item.isEnabled !== false);
  const display = enabled.find((item) => !item.isPrimary) ?? enabled.find((item) => item.isPrimary);
  if (!display) return { width, height };
  const area = display.workArea;
  const w = Math.min(width, area.width), h = Math.min(height, area.height);
  return {
    width: w,
    height: h,
    left: Math.round(area.left + (area.width - w) / 2),
    top: Math.round(area.top + (area.height - h) / 2),
  };
}

/** The window that shows a viewport whole: the page plus Chrome's frame, tab strip and toolbar. */
function windowFor(viewport: Viewport) {
  return { width: viewport.width + 16, height: viewport.height + 160 };
}

async function openSession(viewport: Viewport): Promise<Session> {
  // A window of its own, sized so the recording viewport fits without scaling where the screen has room. On a smaller
  // screen (a 1920x1080 viewport on a 1440x900 laptop) it is as large as the screen allows: the emulated device
  // metrics keep the page laid out at the full viewport, and the capture renders that viewport itself.
  // Chrome refuses bounds it considers off screen; any size works, for the same reason.
  const size = windowFor(viewport);
  const create = (bounds: Record<string, number>) => chrome.windows.create({ url: RECORDING_PLACEHOLDER, type: 'normal', focused: true, ...bounds });
  const window = await create(await recordingBounds(size.width, size.height)).catch(() => create({ ...size })).catch(() => create({}));
  const tabId = window.tabs?.[0]?.id as number;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    await chrome.windows.remove(window.id).catch(() => undefined);
    throw new Error('extension_debugger_unavailable');
  }
  // The recording renders at exactly 100%: a zoom saved for the site or the browser would shrink the viewport.
  await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-tab' }).catch(() => undefined);
  await chrome.tabs.setZoom(tabId, 1).catch(() => undefined);
  const session = { tabId, windowId: window.id as number };
  await saveSessions([...(await sessions()).filter((item) => item.tabId !== tabId), session]);
  return session;
}
async function closeSession(tabId: number) {
  const list = await sessions();
  const session = list.find((item) => item.tabId === tabId);
  await saveSessions(list.filter((item) => item.tabId !== tabId));
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
  if (session) await chrome.windows.remove(session.windowId).catch(() => undefined);
}

async function handle(message: Record<string, any>): Promise<unknown> {
  switch (message.op) {
    case 'credentials': return await credentials() ?? null;
    case 'store': {
      if (message.credentials) await chrome.storage.local.set({ credentials: message.credentials });
      else { await chrome.storage.local.remove('credentials'); setTimeout(() => void closeOffscreen(), 100); }
      return true;
    }
    case 'state': await setState({ ...message.state, at: Date.now() }); return true;
    case 'ping': return true;
    case 'zoom': return await chrome.tabs.getZoom(Number(message.tabId)).catch(() => null);
    case 'reload': setTimeout(() => chrome.runtime.reload(), 100); return true;
    case 'open': return await openSession(chooseViewport(message.viewport));
    case 'close': await closeSession(Number(message.tabId)); return true;
    case 'release': {
      // Stop controlling the window but leave it open, for the user to sign in there.
      const tabId = Number(message.tabId);
      await saveSessions((await sessions()).filter((item) => item.tabId !== tabId));
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      return true;
    }
    case 'send': {
      const tabId = Number(message.tabId);
      if (!(await sessions()).some((item) => item.tabId === tabId)) throw new Error('extension_tab_closed');
      if (!CDP_COMMANDS.has(message.method)) throw new Error('local_method_forbidden');
      return await chrome.debugger.sendCommand({ tabId }, message.method, message.params ?? {});
    }
    default: throw new Error('unknown_operation');
  }
}

chrome.runtime.onConnect.addListener((port: any) => {
  if (port.name !== 'toru-brain' || port.sender?.url !== offscreenUrl) { port.disconnect(); return; }
  brain = port;
  port.onMessage.addListener((message: Record<string, any>) => {
    handle(message).then(
      (result) => port.postMessage({ reply: message.id, result }),
      (error) => port.postMessage({ reply: message.id, error: error instanceof Error ? error.message : 'extension_failed' }),
    );
  });
  port.onDisconnect.addListener(() => { if (brain === port) brain = undefined; });
});

chrome.debugger.onEvent.addListener((source: { tabId?: number }, method: string, params: unknown) => {
  // Only what the driver listens for crosses to the offscreen document.
  if (!/^(Page\.(screencastFrame|loadEventFired|frameNavigated)|Runtime\.executionContext)/.test(method)) return;
  brain?.postMessage({ event: { tabId: source.tabId, method, params } });
});
chrome.debugger.onDetach.addListener((source: { tabId?: number }, reason: string) => {
  void sessions().then(async (list) => {
    if (!list.some((item) => item.tabId === source.tabId)) return;
    await saveSessions(list.filter((item) => item.tabId !== source.tabId));
    brain?.postMessage({ detached: { tabId: source.tabId, reason } });
  });
});
// Navigating restores a site's saved zoom; Toru's tab goes back to 100%.
chrome.tabs.onZoomChange.addListener((change: { tabId: number; newZoomFactor: number }) => {
  if (Math.abs(change.newZoomFactor - 1) < 0.001) return;
  void sessions().then((list) => {
    if (list.some((item) => item.tabId === change.tabId)) void chrome.tabs.setZoom(change.tabId, 1).catch(() => undefined);
  });
});
chrome.windows.onRemoved.addListener((windowId: number) => {
  void sessions().then(async (list) => {
    const session = list.find((item) => item.windowId === windowId);
    if (!session) return;
    await saveSessions(list.filter((item) => item.windowId !== windowId));
    brain?.postMessage({ detached: { tabId: session.tabId, reason: 'window_closed' } });
  });
});

chrome.runtime.onMessage.addListener((message: Record<string, any>, sender: any, reply: (value: unknown) => void) => {
  if (message?.type === 'toru-pair') {
    // Only the connect page on the Toru server may hand over a pairing code.
    const from = typeof sender.url === 'string' ? new URL(sender.url) : undefined;
    if (!from || from.origin !== SERVER || from.pathname !== '/extension/connect' || sender.id !== chrome.runtime.id) { reply({ error: 'pairing_origin_invalid' }); return false; }
    void pair(message.code).then(reply);
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.url?.startsWith(`${SERVER}/`)) return false;
  if (message?.type === 'toru-pair-code') { void pair(String(message.code ?? '').trim()).then(reply); return true; }
  if (message?.type === 'toru-unpair') { void unpair().then(reply); return true; }
  if (message?.type === 'toru-status') {
    void Promise.all([credentials(), chrome.storage.session.get('state')]).then(([current, stored]) =>
      reply({ paired: Boolean(current), connectionId: current?.connectionId ?? current?.deviceId ?? null, server: SERVER, version: VERSION, state: stored.state ?? null }));
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
chrome.alarms.create('toru-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void ensureOffscreen());
void ensureOffscreen();
