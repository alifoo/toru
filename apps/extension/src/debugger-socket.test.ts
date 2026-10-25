import { afterEach, describe, expect, it } from 'vitest';
import type { DebuggerChannel } from '../../../packages/browser/src/cdp-webdriver.js';
import { DEBUGGER_ADDRESS } from './config.js';
import { cssViewport, installDebuggerEndpoints, jpegSize, useDebuggerChannel } from './debugger-socket.js';

const RealWebSocket = globalThis.WebSocket, realFetch = globalThis.fetch;
afterEach(() => { globalThis.WebSocket = RealWebSocket; globalThis.fetch = realFetch; useDebuggerChannel(undefined); });

function channel() {
  const sent: string[] = [];
  let listener: ((method: string, params: Record<string, unknown>) => void) | undefined;
  const value: DebuggerChannel = {
    send: async (method) => { sent.push(method); return method === 'Page.captureScreenshot' ? { data: 'c2hvdA==' } : {}; },
    onEvent: (next) => { listener = next; return () => { listener = undefined; }; },
  };
  return { value, sent, frame: (deviceWidth: number, deviceHeight: number, data = 'ZnJhbWU=') => listener?.('Page.screencastFrame', { data, sessionId: 1, metadata: { deviceWidth, deviceHeight } }) };
}

/** The start of a JPEG Chrome would send: SOI, a JFIF segment, then the frame header with its size. */
function jpeg(width: number, height: number) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, ...new Array(64).fill(0)]).toString('base64');
}

async function screencast(scale: number, viewport = { width: 1280, height: 720 }) {
  const fake = channel();
  installDebuggerEndpoints();
  useDebuggerChannel(fake.value, scale);
  const socket = new WebSocket(`ws://${DEBUGGER_ADDRESS}/devtools/page/toru`);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  const messages: Array<{ method?: string; params?: { data?: string; metadata?: { deviceWidth?: number } } }> = [];
  socket.addEventListener('message', (event) => messages.push(JSON.parse(String((event as MessageEvent).data))));
  socket.send(JSON.stringify({ id: 1, method: 'Page.startScreencast', params: { format: 'jpeg', maxWidth: Math.round(viewport.width * scale), maxHeight: Math.round(viewport.height * scale) } }));
  return { socket, messages, ...fake };
}

describe('Toru for Chrome screencast socket', () => {
  it('maps a screencast asked for in device pixels to the CSS viewport Chrome reports', () => {
    expect(cssViewport({ width: 2560, height: 1440 }, 2)).toEqual({ width: 1280, height: 720 });
    expect(cssViewport({ width: 1280, height: 720 }, 1)).toEqual({ width: 1280, height: 720 });
    // Fractional scales: 1920x1080 and 1440x900 asked for at most 2560 wide.
    expect(cssViewport({ width: 2560, height: 1440 }, 2560 / 1920)).toEqual({ width: 1920, height: 1080 });
    expect(cssViewport({ width: 2560, height: 1600 }, 2560 / 1440)).toEqual({ width: 1440, height: 900 });
  });

  it('keeps the screencast of a 1920x1080 viewport at 4/3 when its frames are 2560x1440', async () => {
    const { socket, messages, sent, frame } = await screencast(2560 / 1920, { width: 1920, height: 1080 });
    frame(1920, 1080, jpeg(2560, 1440));
    await new Promise((done) => setTimeout(done, 10));
    expect(messages.filter((message) => message.method === 'Page.screencastFrame')).toHaveLength(1);
    expect(sent).not.toContain('Page.captureScreenshot');
    socket.close();
  });

  it('renders a 1920x1080 viewport itself on a 1x screen, or when the window only shows part of it', async () => {
    for (const [width, height, data] of [[1920, 1080, jpeg(1920, 1080)], [1424, 740, jpeg(1424, 740)]] as const) {
      const { socket, messages, sent, frame } = await screencast(2560 / 1920, { width: 1920, height: 1080 });
      frame(width, height, data);
      await new Promise((done) => setTimeout(done, 60));
      socket.close();
      expect(sent).toContain('Page.stopScreencast');
      expect(sent).toContain('Page.captureScreenshot');
      expect(messages.find((message) => message.method === 'Page.screencastFrame')?.params).toMatchObject({ metadata: { deviceWidth: 1920, deviceHeight: 1080 } });
    }
  });

  it('keeps Chrome\'s own screencast at 2x when its frames show the whole 1280x720 viewport', async () => {
    const { socket, messages, sent, frame } = await screencast(2);
    frame(1280, 720);
    await new Promise((done) => setTimeout(done, 10));
    expect(messages.filter((message) => message.method === 'Page.screencastFrame').map((message) => message.params?.data)).toEqual(['ZnJhbWU=']);
    expect(sent).not.toContain('Page.captureScreenshot');
    socket.close();
  });

  it('reads a JPEG\'s pixel size from its frame header', () => {
    expect(jpegSize(jpeg(2560, 1440))).toEqual({ width: 2560, height: 1440 });
    expect(jpegSize(jpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(jpegSize('ZnJhbWU=')).toBeUndefined();
    expect(jpegSize('not base64!')).toBeUndefined();
  });

  it('keeps the screencast when its frames are 2560x1440 for the 1280x720 viewport', async () => {
    const { socket, messages, sent, frame } = await screencast(2);
    frame(1280, 720, jpeg(2560, 1440));
    await new Promise((done) => setTimeout(done, 10));
    expect(messages.filter((message) => message.method === 'Page.screencastFrame')).toHaveLength(1);
    expect(sent).not.toContain('Page.captureScreenshot');
    socket.close();
  });

  it('renders 2x frames itself when the window is on a 1x screen, whose screencast is only 1280x720', async () => {
    const { socket, sent, frame } = await screencast(2);
    frame(1280, 720, jpeg(1280, 720));
    await new Promise((done) => setTimeout(done, 60));
    socket.close();
    expect(sent).toContain('Page.stopScreencast');
    expect(sent).toContain('Page.captureScreenshot');
  });

  it('keeps a 1x screencast when 1x was asked for', async () => {
    const { socket, sent, frame } = await screencast(1);
    frame(1280, 720, jpeg(1280, 720));
    await new Promise((done) => setTimeout(done, 10));
    socket.close();
    expect(sent).not.toContain('Page.captureScreenshot');
  });

  it('renders the viewport itself when the window shows less of it, reporting CSS sizes', async () => {
    const { socket, messages, sent, frame } = await screencast(2);
    frame(900, 600);
    await new Promise((done) => setTimeout(done, 60));
    socket.close();
    expect(sent).toContain('Page.stopScreencast');
    expect(sent).toContain('Page.captureScreenshot');
    const rendered = messages.find((message) => message.method === 'Page.screencastFrame');
    expect(rendered?.params).toMatchObject({ data: 'c2hvdA==', metadata: { deviceWidth: 1280, deviceHeight: 720 } });
  });
});
