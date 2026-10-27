import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CdpWebDriverTransport, observationScale, type DebuggerChannel } from "./cdp-webdriver.js";
import { WebDriverBrowserDriver } from "./webdriver.js";

/** The same Chrome the recorder uses; the suite runs only where one is installed. */
const chromeBinary = process.env.CHROME_BINARY ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const available = existsSync(chromeBinary);

/** A DevTools WebSocket to one page target: what chrome.debugger gives the extension. */
async function pageChannel(port: number): Promise<{ channel: DebuggerChannel; close(): void }> {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((target) => target.type === "page")!;
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener("open", done, { once: true }));
  let next = 0;
  const waiting = new Map<number, { done(value: unknown): void; fail(error: Error): void }>();
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const wait = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) wait?.fail(new Error(message.error.message)); else wait?.done(message.result);
    } else listeners.forEach((listener) => listener(message.method, message.params ?? {}));
  });
  return {
    channel: {
      send: (method, params = {}) => new Promise((done, fail) => { const id = ++next; waiting.set(id, { done, fail }); socket.send(JSON.stringify({ id, method, params })); }),
      onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    close: () => socket.close(),
  };
}

describe.skipIf(!available)("WebDriver driver over CDP", () => {
  let chrome: ChildProcess, server: Server, profile: string, port = 0, product = "";
  beforeAll(async () => {
    server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Product</title>
      <style>body{font:16px system-ui;margin:0;height:2400px}button,input{font:inherit;padding:10px}</style>
      <h1>Planilhas</h1><p><input id="name" aria-label="Nome da planilha" placeholder="Nome"> <button id="create" onclick="document.getElementById('out').textContent='criada: '+document.getElementById('name').value">Criar planilha</button></p>
      <select id="kind" aria-label="Tipo"><option value="a">A</option><option value="b">B</option></select>
      <p id="out"></p><p id="keys"></p><script>addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('keys').textContent='enter';});</script>`));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };
    product = `http://127.0.0.1:${address.port}/`;
    profile = await mkdtemp(join(tmpdir(), "cdp-webdriver-"));
    chrome = spawn(chromeBinary, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
"about:blank"], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      const active = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
      port = Number(active.split("\n")[0]) || 0;
      if (!port) await new Promise((done) => setTimeout(done, 100));
    }
  }, 30_000);
  afterAll(async () => {
    chrome?.kill("SIGTERM");
    server?.close();
    await new Promise((done) => setTimeout(done, 300));
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  it("navigates, reads, clicks, fills, types, presses keys, scrolls and records with cursor telemetry", async () => {
    const { channel, close } = await pageChannel(port);
    const transport = new CdpWebDriverTransport(channel, { debuggerAddress: `127.0.0.1:${port}` });
    const browser = new WebDriverBrowserDriver(transport, { resolveHostname: async () => ["93.184.216.34"], recordingFrameRate: 30 });
    const driver = await browser.createContext({ viewport: { width: 1280, height: 720 }, allowedOrigins: [product], sessionState: new TextEncoder().encode('{"cookies":[],"origins":[]}'),
      allowDownload: false, allowPopup: false, onNavigation: () => undefined }) as Awaited<ReturnType<WebDriverBrowserDriver["createContext"]>> & {
      recordingMode: string | null; semanticTimeline(): Array<{ type: string }>; pointerTrail(): unknown[]; pointerTelemetry(): unknown[];
    };
    try {
      await driver.goto(product);
      expect(await driver.currentUrl()).toBe(product);
      const outline = await driver.readPage({ filter: "interactive" });
      const ref = (label: string) => new RegExp(`\\[(ref_\\d+)\\][^\\n]*${label}`).exec(outline)?.[1];
      expect(ref("Criar planilha")).toBeTruthy();
      expect(await driver.pageText()).toContain("Planilhas");
      await driver.redactSensitiveText();
      await driver.startRecording();
      expect(driver.recordingMode).toBe("screencast");
      await driver.formInput(ref("Nome da planilha")!, "Pipeline Q4");
      await driver.formInput(ref("Tipo")!, "b");
      await driver.pointer("left_click", { type: "ref", ref: ref("Criar planilha")! });
      await driver.pressKey("Enter");
      await driver.scrollBy({ type: "coordinate", x: 640, y: 360 }, "down", 3);
      await new Promise((done) => setTimeout(done, 800));
      const video = await driver.stopRecording();
      expect(await driver.pageText()).toContain("criada: Pipeline Q4");
      expect(await driver.pageText()).toContain("enter");
      expect(video.contentType).toBe("video/webm");
      expect(video.body.length).toBeGreaterThan(10_000);
      expect(driver.pointerTrail().length).toBeGreaterThan(0);
      expect(driver.pointerTelemetry().length).toBeGreaterThan(5);
      expect(driver.semanticTimeline().map((action) => action.type)).toEqual(expect.arrayContaining(["type", "click", "key"]));
      const shot = await driver.screenshot("agent-observation", false);
      expect(Buffer.from(shot.body.subarray(1, 4)).toString()).toBe("PNG");
      // Cookies never leave the browser through this transport.
      await expect(transport.request("POST", "/session/cdp/goog/cdp/execute", { cmd: "Network.getAllCookies", params: {} })).rejects.toThrow();
    } finally {
      await driver.dispose().catch(() => undefined);
      close();
    }
  }, 120_000);
});

describe("CdpWebDriverTransport device scale", () => {
  function fakeChannel(pageY = 0) {
    const sent: Array<{ method: string; params?: Record<string, unknown> | undefined }> = [];
    const channel: DebuggerChannel = {
      send: async (method, params) => {
        sent.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY } };
        if (method === "Page.captureScreenshot") return { data: "cG5n" };
        return {};
      },
      onEvent: () => () => undefined,
    };
    return { channel, sent };
  }

  it("renders the same CSS viewport at the device scale and observes it at one pixel per CSS pixel", async () => {
    const { channel, sent } = fakeChannel(1100);
    const transport = new CdpWebDriverTransport(channel, { deviceScaleFactor: 2 });
    await transport.request("POST", "/session", {});
    expect(await transport.request("POST", "/session/cdp/window/rect", { width: 1280, height: 720 })).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(sent.find((call) => call.method === "Emulation.setDeviceMetricsOverride")?.params).toEqual({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
    expect(await transport.request("GET", "/session/cdp/window/rect")).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    await transport.request("GET", "/session/cdp/screenshot");
    // The clip is in document coordinates: where the viewport is scrolled to, scaled back to CSS pixels.
    expect(sent.find((call) => call.method === "Page.captureScreenshot")?.params).toEqual({ format: "png", clip: { x: 0, y: 1100, width: 1280, height: 720, scale: 0.5 } });
  });

  it("observes a wider viewport scaled down to the observation width, at a fractional device scale", async () => {
    for (const [width, height] of [[1920, 1080], [1440, 900]] as const) {
      const { channel, sent } = fakeChannel(300);
      const transport = new CdpWebDriverTransport(channel, { deviceScaleFactor: 2560 / width, observationWidth: 1280 });
      await transport.request("POST", "/session", {});
      await transport.request("POST", "/session/cdp/window/rect", { width, height });
      expect(sent.find((call) => call.method === "Emulation.setDeviceMetricsOverride")?.params).toEqual({ width, height, deviceScaleFactor: 2560 / width, mobile: false });
      await transport.request("GET", "/session/cdp/screenshot");
      // CSS clip of the whole viewport; Chrome's output is clip x scale x device scale = 1280 wide.
      const clip = (sent.find((call) => call.method === "Page.captureScreenshot")?.params as { clip: { x: number; y: number; width: number; height: number; scale: number } }).clip;
      expect(clip).toMatchObject({ x: 0, y: 300, width, height });
      expect(width * clip.scale * (2560 / width)).toBeCloseTo(1280, 6);
    }
    // A viewport no wider than the observation is never scaled up.
    expect(observationScale(1280, 1280)).toBe(1);
    expect(observationScale(1024, 1280)).toBe(1);
    expect(observationScale(1920, undefined)).toBe(1);
    expect(observationScale(1920, 1280)).toBeCloseTo(2 / 3);
  });

  it("scales the observation itself when it can, so Chrome never re-renders the recorded tab smaller", async () => {
    const { channel, sent } = fakeChannel(300);
    const scaled: Array<[number, number]> = [];
    const transport = new CdpWebDriverTransport(channel, {
      deviceScaleFactor: 2560 / 1440,
      observationWidth: 1280,
      downscale: async (_png, width, height) => { scaled.push([width, height]); return "scaled"; },
    });
    await transport.request("POST", "/session", {});
    await transport.request("POST", "/session/cdp/window/rect", { width: 1440, height: 900 });
    expect(await transport.request("GET", "/session/cdp/screenshot")).toBe("scaled");
    // The capture is the tab as it renders (no clip, no scale); the 1280x800 observation comes from downscale.
    expect(sent.filter((call) => call.method === "Page.captureScreenshot").map((call) => call.params)).toEqual([{ format: "png" }]);
    expect(scaled).toEqual([[1280, 800]]);
  });

  it("keeps device scale 1 and an unclipped screenshot by default", async () => {
    const { channel, sent } = fakeChannel();
    const transport = new CdpWebDriverTransport(channel);
    await transport.request("POST", "/session", {});
    await transport.request("POST", "/session/cdp/window/rect", { width: 1280, height: 720 });
    await transport.request("GET", "/session/cdp/screenshot");
    expect(sent.find((call) => call.method === "Emulation.setDeviceMetricsOverride")?.params).toMatchObject({ deviceScaleFactor: 1 });
    expect(sent.find((call) => call.method === "Page.captureScreenshot")?.params).toEqual({ format: "png" });
  });

  it("refuses a device scale outside 1 to 3", () => {
    expect(() => new CdpWebDriverTransport(fakeChannel().channel, { deviceScaleFactor: 0 })).toThrow(RangeError);
    expect(() => new CdpWebDriverTransport(fakeChannel().channel, { deviceScaleFactor: 4 })).toThrow(RangeError);
  });
});
