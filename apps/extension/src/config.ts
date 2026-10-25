/** The Toru backend this build talks to: production, or a loopback server for local tests. */
export const SERVER = typeof __TORU_SERVER__ === 'string' ? __TORU_SERVER__ : 'https://mcp.toru.tools';
export const VERSION = typeof __TORU_VERSION__ === 'string' ? __TORU_VERSION__ : '0.0.0';
export const BUILD = typeof __TORU_BUILD__ === 'string' ? __TORU_BUILD__ : '';
export const DEVELOPMENT = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SERVER);
/** Not a real port: the screencast recorder's DevTools requests are answered inside the extension. */
export const DEBUGGER_ADDRESS = '127.0.0.1:1';
export type Viewport = { width: number; height: number };
/** The page layouts (CSS viewports) a recording can choose, as the server names them. */
export const VIEWPORT_PRESETS = { '1280x720': { width: 1280, height: 720 }, '1440x900': { width: 1440, height: 900 }, '1920x1080': { width: 1920, height: 1080 } } as const;
/** What a recording uses when the server asks for a size this build does not know. */
export const DEFAULT_VIEWPORT: Viewport = VIEWPORT_PRESETS['1920x1080'];
/** What a server that names no size expects: every build before 0.1.8 recorded this layout. */
export const LEGACY_VIEWPORT: Viewport = VIEWPORT_PRESETS['1280x720'];
/**
 * The layout a recording asked for: one of the presets, the legacy 1280x720 when the server names none (an older
 * server reads coordinates in that layout), or the default for anything else. The recording reports what it used
 * (captureViewport), so a server never has to guess.
 */
export function chooseViewport(requested: unknown): Viewport {
  if (requested === undefined || requested === null) return { ...LEGACY_VIEWPORT };
  const size = requested as { width?: unknown; height?: unknown };
  const preset = Object.values(VIEWPORT_PRESETS).find((item) => item.width === size?.width && item.height === size?.height);
  return { ...(preset ?? DEFAULT_VIEWPORT) };
}
/** The widest frame a recording is captured at, in device pixels. */
export const MAX_CAPTURE_WIDTH = 2560;
/**
 * Device pixels per CSS pixel the recording tab renders and is captured at: at most 2, and never wider than 2560.
 * 1280x720 and 1920x1080 record as 2560x1440, 1440x900 as 2560x1600, so a 1920 or 2560 render and its zooms are
 * sharp. The encoder may settle for less on a machine that cannot encode that size, and a screen that shows the tab
 * at 1x can yield 1x frames; the recording reports its size.
 */
export function captureScaleFor(viewport: Viewport): number {
  return Math.min(2, MAX_CAPTURE_WIDTH / viewport.width);
}
/** The frame size a viewport is captured at: even integers, as a video encoder needs. */
export function captureFrameSize(viewport: Viewport): Viewport {
  const scale = captureScaleFor(viewport);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(viewport.width * scale), height: even(viewport.height * scale) };
}
/** How wide the navigator's screenshots are: a wider viewport is scaled down into them, a narrower one is not scaled up. */
export const OBSERVATION_WIDTH = 1280;
export type Credentials = { deviceId: string; connectionId?: string; accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number };
export type BrainState = { state: 'online' | 'recording' | 'offline' | 'signed_out'; detail?: string; at: number };
/** Every DevTools command the shared driver and its screencast send. Anything else is refused by the service worker. */
export const CDP_COMMANDS = new Set([
  'DOM.describeNode', 'DOM.getBoxModel', 'DOM.getFrameOwner', 'Emulation.setDeviceMetricsOverride',
  'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Page.captureScreenshot', 'Page.enable', 'Page.getFrameTree',
  'Page.getLayoutMetrics', 'Page.navigate', 'Runtime.enable', 'Runtime.evaluate',
  'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck', 'Page.bringToFront',
]);
