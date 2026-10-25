import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExtensionBridge } from '../../mcp/src/extension-bridge.js';
import { withRecorderStore } from '../../mcp/src/store/open.js';

/**
 * The whole extension in a real Chrome: pairing through the connect page, then one recording driven
 * through the backend bridge exactly as the recorder drives it. Chrome for Testing is required because
 * branded Chrome no longer loads unpacked extensions from the command line.
 */
const chromeBinary = process.env.CFT_BINARY ?? join(homedir(), '.cache/toru-cft/chrome/mac_arm-154.0.8037.98/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const available = existsSync(chromeBinary) && process.env.TORU_EXTENSION_E2E !== '0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
/** The page layout the recording asks for: TORU_E2E_VIEWPORT=1440x900 or 1280x720 records another preset. */
const [layoutWidth, layoutHeight] = (process.env.TORU_E2E_VIEWPORT ?? '1920x1080').split('x').map(Number) as [number, number];
const layout = { width: layoutWidth, height: layoutHeight };
/** Frames are captured at most 2560 wide and at most 2x. */
const captureScale = Math.min(2, 2560 / layout.width);

/** The bounds of the window showing a page, from Chrome's browser DevTools endpoint, for the log. */
async function recordingWindow(devtools: number, url: string): Promise<{ width: number; height: number } | undefined> {
  const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json() as Array<{ id: string; url: string }>;
  const target = targets.find((item) => item.url === url);
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${devtools}/json/version`)).json() as { webSocketDebuggerUrl: string };
  if (!target) return undefined;
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  const reply = new Promise<{ result?: { bounds?: { width: number; height: number } } }>((done) => socket.addEventListener('message', (event) => done(JSON.parse(String(event.data))), { once: true }));
  socket.send(JSON.stringify({ id: 1, method: 'Browser.getWindowForTarget', params: { targetId: target.id } }));
  const bounds = (await reply).result?.bounds;
  socket.close();
  return bounds && { width: bounds.width, height: bounds.height };
}

describe.skipIf(!available)('Toru for Chrome end to end', () => {
  let chrome: ChildProcess, backend: Server, product: Server, scratch = '', server = '', productUrl = '', devtools = 0;
  let bridge: ExtensionBridge;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'toru-extension-e2e-'));
    const dataDir = join(scratch, 'data');
    await withRecorderStore(dataDir, (db) => { db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run('owner', 0); });
    bridge = new ExtensionBridge(dataDir);
    backend = createServer((req, res) => void bridge.http(req, res, new URL(req.url!, 'http://127.0.0.1')).then((handled) => { if (!handled) res.writeHead(404).end(); }));
    await new Promise<void>((done) => backend.listen(0, '127.0.0.1', done));
    server = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
    product = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Planilhas</title>
      <style>body{font:18px system-ui;margin:0;padding:40px;height:2400px;background:#f7f7f8}button,input,select{font:inherit;padding:10px 14px}</style>
      <h1>Planilhas</h1><p><input id="name" aria-label="Nome da planilha" placeholder="Nome"> <button onclick="document.getElementById('out').textContent='criada: '+document.getElementById('name').value">Criar planilha</button></p>
      <select aria-label="Tipo"><option value="a">Vendas</option><option value="b">Marketing</option></select><p id="out"></p>
      <p id="layout"></p><script>const show=()=>document.getElementById('layout').textContent='layout '+innerWidth+'x'+innerHeight;show();addEventListener('resize',show);</script>`));
    await new Promise<void>((done) => product.listen(0, '127.0.0.1', done));
    productUrl = `http://127.0.0.1:${(product.address() as { port: number }).port}/`;
    const out = join(scratch, 'extension');
    await run(process.execPath, [join(root, 'build.mjs')], { env: { ...process.env, TORU_SERVER: server, TORU_EXTENSION_OUT: out } });
    const profile = join(scratch, 'profile');
    chrome = spawn(chromeBinary, [`--user-data-dir=${profile}`, `--load-extension=${out}`, `--disable-extensions-except=${out}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--window-size=1400,1000',
      // E.g. --force-device-scale-factor=2 records a Retina screen's own screencast on any display.
      ...(process.env.TORU_E2E_CHROME_ARGS ?? '').split(' ').filter(Boolean), 'about:blank'], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 100 && !devtools; attempt++) {
      devtools = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]) || 0;
      if (!devtools) await new Promise((done) => setTimeout(done, 100));
    }
  }, 90_000);
  afterAll(async () => {
    bridge?.close();
    chrome?.kill('SIGTERM');
    backend?.closeAllConnections(); backend?.close(); product?.close();
    await new Promise((done) => setTimeout(done, 500));
    if (process.env.TORU_KEEP_E2E) console.log('kept', scratch); else await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  });

  it.runIf(Boolean(process.env.TORU_E2E_URL))('opens a real product page (TORU_E2E_URL)', async () => {
    const target = new URL(process.env.TORU_E2E_URL!);
    const { pairingCode } = bridge.pair('owner', async () => true);
    await fetch(`http://127.0.0.1:${devtools}/json/new?${encodeURIComponent(`${server}/extension/connect#code=${pairingCode}`)}`, { method: 'PUT' });
    await vi.waitFor(async () => expect((await bridge.devices('owner')).some((device) => device.status === 'ready')).toBe(true), { timeout: 20_000, interval: 250 });
    const device = (await bridge.devices('owner')).find((item) => item.status === 'ready')!;
    const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
    const offscreen = targets.find((item) => item.url.endsWith('/offscreen.html'))!;
    const socket = new WebSocket(offscreen.webSocketDebuggerUrl);
    const logs: string[] = [];
    await new Promise((done) => socket.addEventListener('open', done, { once: true }));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.consoleAPICalled') logs.push(message.params.args.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(' '));
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    const driver = await bridge.createContext('owner', device.connectionId, {
      viewport: { width: 1920, height: 1080 }, allowedOrigins: [target.origin], sessionState: new Uint8Array(), onNavigation: () => undefined, allowDownload: false, allowPopup: false,
    });
    let outcome = '';
    try { await driver.goto(target.href); outcome = `opened ${await driver.currentUrl()}`; } catch (error) { outcome = `failed ${(error as Error).message}`; }
    await new Promise((done) => setTimeout(done, 500));
    await writeFile(join(scratch, 'real-url.log'), `${outcome}\n${logs.join('\n')}`);
    socket.close();
    await driver.dispose().catch(() => undefined);
  }, 120_000);

  it('pairs from the connect link and records a flow in a window it opens, with no click', async () => {
    const { pairingCode } = bridge.pair('owner', async () => true);
    await fetch(`http://127.0.0.1:${devtools}/json/new?${encodeURIComponent(`${server}/extension/connect#code=${pairingCode}`)}`, { method: 'PUT' });
    await vi.waitFor(async () => expect((await bridge.devices('owner'))[0]?.status).toBe('ready'), { timeout: 20_000, interval: 250 });
    const [device] = await bridge.devices('owner');
    // The offscreen document's console, for diagnosing a failure.
    const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
    const offscreen = targets.find((target) => target.url.endsWith('/offscreen.html'));
    const logs: string[] = [];
    if (offscreen) {
      const socket = new WebSocket(offscreen.webSocketDebuggerUrl);
      await new Promise((done) => socket.addEventListener('open', done, { once: true }));
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.method === 'Runtime.consoleAPICalled') logs.push(message.params.args.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(' '));
        if (message.method === 'Runtime.exceptionThrown') logs.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      onTestFinished(async () => { await writeFile(join(scratch, 'offscreen.log'), logs.join('\n')); if (logs.length) console.log('offscreen console:\n' + logs.join('\n')); socket.close(); });
    }
    const onNavigation = vi.fn();
    const driver = await bridge.createContext('owner', device!.connectionId, {
      viewport: { ...layout }, allowedOrigins: [productUrl.slice(0, -1)], sessionState: new Uint8Array(), onNavigation, allowDownload: false, allowPopup: false,
    }) as Awaited<ReturnType<ExtensionBridge['createContext']>> & { recordingMode?: string; pointerTelemetry(): unknown[]; captureViewport?: unknown; captureSize?: { width: number; height: number } };
    try {
      await driver.goto(productUrl);
      expect(onNavigation).toHaveBeenLastCalledWith(productUrl, 0);
      expect(driver.captureViewport).toEqual(layout);
      // The page itself is laid out at the viewport asked for, whatever the window's size (a 1920x1080 viewport does not
      // fit a 1080p screen with Chrome's toolbar: the window is smaller and the capture renders the viewport itself).
      expect(await driver.pageText()).toContain(`layout ${layout.width}x${layout.height}`);
      const window = await recordingWindow(devtools, productUrl).catch(() => undefined);
      const outline = await driver.readPage({ filter: 'interactive' });
      const ref = (label: string) => new RegExp(`\\[(ref_\\d+)\\][^\\n]*${label}`).exec(outline)?.[1];
      expect(ref('Criar planilha')).toBeTruthy();
      // The navigator observes the viewport 1280 wide (a 1920x1080 page as 1280x720), though the tab renders denser.
      const observed = await driver.screenshot('agent-observation', false);
      const header = new DataView(observed.body.buffer, observed.body.byteOffset, observed.body.byteLength);
      expect([header.getUint32(16), header.getUint32(20)]).toEqual([1280, Math.round(1280 * layout.height / layout.width)]);
      await driver.redactSensitiveText();
      await driver.startRecording();
      expect(driver.recordingMode).toBe('screencast');
      await driver.formInput(ref('Nome da planilha')!, 'Pipeline Q4');
      await driver.formInput(ref('Tipo')!, 'b');
      await driver.pointer('left_click', { type: 'ref', ref: ref('Criar planilha')! });
      await driver.scrollBy({ type: 'coordinate', x: 640, y: 360 }, 'down', 3);
      await new Promise((done) => setTimeout(done, 1500));
      const video = await driver.stopRecording();
      const file = join(scratch, video.contentType === 'video/mp4' ? 'capture.mp4' : 'capture.webm');
      await writeFile(file, video.body);
      expect(await driver.pageText()).toContain('criada: Pipeline Q4');
      // A development server is recorded on its own local host only: another local name is refused before Chrome loads it.
      await expect(driver.goto(`${server.replace('127.0.0.1', 'localhost')}/`)).rejects.toThrow('local_navigation_blocked');
      expect(await driver.currentUrl()).toBe(productUrl);
      expect(['video/mp4', 'video/webm']).toContain(video.contentType);
      expect(video.body.length).toBeGreaterThan(10_000);
      expect(driver.pointerTelemetry().length).toBeGreaterThan(5);
      // Coordinates stay in the CSS viewport; the video is that viewport at most 2560 wide (2560x1440 for 1920x1080 and
      // 1280x720, 2560x1600 for 1440x900). A screen that shows the window at 1x yields 1x frames
      // (TORU_E2E_SCREEN_SCALE=1), and the recording says so.
      expect(driver.captureViewport).toEqual(layout);
      const expected = process.env.TORU_E2E_SCREEN_SCALE === '1' ? layout : { width: Math.round(layout.width * captureScale), height: Math.round(layout.height * captureScale) };
      expect(driver.captureSize).toEqual(expected);
      const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,bit_rate:format=duration,bit_rate', '-of', 'json', file]).catch(() => undefined);
      if (probe) {
        const info = JSON.parse(probe.stdout) as { streams: Array<{ width: number; height: number; codec_name: string }>; format: { duration: string; bit_rate: string } };
        expect(info.streams[0]).toMatchObject(expected);
        expect(Number(info.format.duration)).toBeGreaterThan(1.5);
        console.log('recorded', `layout ${layout.width}x${layout.height}`, window ? `window ${window.width}x${window.height}` : '', video.contentType, info.streams[0]!.codec_name, `${info.streams[0]!.width}x${info.streams[0]!.height}`, video.body.length, 'bytes', info.format.duration, 's', info.format.bit_rate, 'bit/s', process.env.TORU_KEEP_E2E ? file : '');
      }
    } finally {
      await driver.dispose();
    }
    expect((await bridge.devices('owner'))[0]?.status).toBe('ready');
  }, 120_000);
});
