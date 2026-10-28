import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { BrowserContextDriver, BrowserContextOptions, BrowserStorageState, CaptureSemanticAction } from "./index.js";
import { AGENT_OBSERVATION_NAME } from "./index.js";
import { CdpScreencastRecorder } from "./screencast.js";
import {
  FetchWebDriverTransport,
  isPublicNetworkAddress,
  pageLooksLikeBotChallenge,
  type VideoEncoder,
  WebDriverBrowserDriver,
  type WebDriverTransport,
  opensNewShot,
  containerFrom,
  circlePoint,
  humanTravelPoint,
  underlinePoint,
  minimumJerk,
  motionRandom,
  planHumanTravel,
} from "./webdriver.js";

const elementKey = "element-6066-11e4-a52e-4f735466cecf";

class ProtocolHarness implements WebDriverTransport {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  currentUrl = "about:blank";
  loaderVisible = false;
  disabled = false;
  challengeSnapshot: { text: string; challengeFrame: boolean } | null = null;
  identityRects: unknown[] = [];
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }> = [];
  windowRect = { width: 1280, height: 720, x: 0, y: 0 };
  browserChrome = { width: 0, height: 0 };
  targetDescription = "Search";
  passage: unknown = { rects: [{ x: 200, y: 400, width: 300, height: 20 }], interactive: false, endsOnControl: true, length: 20 };
  rows: unknown = [{ x: 100, y: 100, width: 800, height: 40 }, { x: 100, y: 140, width: 800, height: 40 }, { x: 100, y: 180, width: 800, height: 40 }];
  /** Ref lookups miss when this is null, which is how a stale ref is simulated. */
  refElement: string | null = "element-1";
  pageOutline = '[ref_1] button "Encontrar novos leads"';
  findOutput = '[ref_1] button "Encontrar novos leads"';
  pageTextValue = "Acme dashboard";
  formKind: "text" | "select" | "toggle" = "text";
  freezeScreenshots = false;
  screenshotNumber = 0;
  telemetryDrain: unknown = null;

  async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (path.endsWith('/goog/cdp/execute')) {
      if ((body as { cmd: string }).cmd === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'storage-script' };
      return {};
    }
    if (path === "/session") return { sessionId: "session-1", capabilities: {} };
    if (path.endsWith("/url") && method === "POST") {
      this.currentUrl = (body as { url: string }).url;
      return null;
    }
    if (path.endsWith("/url") && method === "GET") return this.currentUrl;
    if (path.endsWith("/cookie") && method === "GET") return this.cookies;
    if (path.endsWith("/elements")) return [{ [elementKey]: "element-1" }];
    if (path.endsWith("/element/active")) return { [elementKey]: "element-1" };
    if (path.endsWith("/displayed")) return true;
    if (path.endsWith("/screenshot"))
      return Buffer.from(
        this.freezeScreenshots ? "png-frame" : `png-frame-${this.screenshotNumber++}`,
      ).toString("base64");
    if (path.endsWith("/window/rect") && method === "POST") {
      this.windowRect = { ...this.windowRect, ...(body as Partial<typeof this.windowRect>) };
      return this.windowRect;
    }
    if (path.endsWith("/window/rect") && method === "GET") {
      return this.windowRect;
    }
    if (path.endsWith("/execute/sync")) {
      const script = (body as { script: string }).script;
      if (script.includes("const norm=t=>")) return (body as { args: unknown[] }).args[2] === "select" ? { selected: 20 } : this.passage;
      if (script.includes("createTreeWalker(root,NodeFilter.SHOW_TEXT)")) return this.identityRects;
      if (script.includes("tbody tr")) return this.rows;
      if (script.includes("y:r.top,width:r.width")) return { x: 400, y: 300, width: 200, height: 40, w: 1280, h: 720 };
      if (script.includes('r.left-32')) return { x: 0.2, y: 0.2, width: 0.5, height: 0.3 };
      if (script.includes("matches(':disabled')")) return this.disabled;
      if (script.includes("const t = window.__captureTelemetry")) return this.telemetryDrain;
      if (script.includes("r.bottom+28")) return { x: 300, y: 270 };
      if (script.includes("interactiveSelector"))
        return { text: this.pageOutline, count: 1, truncated: false };
      if (script.includes("remainingPixels")) return JSON.stringify({ regions: [] });
      if (script.includes("elementFromPoint")) return { [elementKey]: "element-1" };
      if (script.includes("data-content-layer-ref"))
        return this.refElement ? { [elementKey]: this.refElement } : null;
      if (script.includes("scored.sort")) return this.findOutput;
      if (script.includes("role=main")) return this.pageTextValue;
      if (script.includes("e.tagName==='SELECT'")) return this.formKind;
      // Ordered before the viewport branch: both scripts mention window.innerWidth.
      if (script.includes("Math.round(r.left")) return { x: 100, y: 200, w: 1280, h: 720 };
      if (script.includes("getComputedStyle(e).cursor"))
        return { x: 0.5, y: 0.4, w: 0.1, h: 0.05, cursor: "pointer" };
      if (script.includes("f?.action")) return this.targetDescription;
      if (script.includes("aria-busy")) return this.loaderVisible;
      if (script.includes("window.innerWidth")) {
        return {
          width: this.windowRect.width - this.browserChrome.width,
          height: this.windowRect.height - this.browserChrome.height,
        };
      }
      if (script.includes("scrollWidth")) return { width: 1600, height: 1000 };
      if (script.includes("challengeFrame")) return this.challengeSnapshot;
      return null;
    }
    return null;
  }
}

function contextOptions(
  state: BrowserStorageState = { cookies: [], origins: [] },
): BrowserContextOptions {
  return {
    viewport: { width: 1280, height: 720 },
    allowedOrigins: ["https://demo.example.com"],
    sessionState: new TextEncoder().encode(JSON.stringify(state)),
    onNavigation(target) {
      if (new URL(target).origin !== "https://demo.example.com") throw new Error("blocked");
    },
    allowDownload: false,
    allowPopup: false,
  };
}

describe("WebDriverBrowserDriver", () => {
  it("keeps slow and missed screenshots on the cursor clock past two minutes", async () => {
    vi.useFakeTimers();
    const protocol = new ProtocolHarness();
    const original = protocol.request.bind(protocol);
    let slow = false;
    vi.spyOn(protocol, "request").mockImplementation(async (method, path, body) => {
      if (slow && path.endsWith("/screenshot")) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return original(method, path, body);
    });
    let encoded: string[] = [];
    const context = await new WebDriverBrowserDriver(protocol, {
      videoEncoder: {
        encodePngFrames: async (frames) => {
          encoded = frames.map((frame) => new TextDecoder().decode(frame));
          return new Uint8Array([1]);
        },
      },
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.startRecording();
      // Exceeds the former 480-frame cutoff, then simulates a busy driver.
      await vi.advanceTimersByTimeAsync(121_000);
      slow = true;
      const before = protocol.screenshotNumber;
      await vi.advanceTimersByTimeAsync(3_000);
      const stopping = context.stopRecording();
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;
      expect(encoded.length * 250).toBeGreaterThanOrEqual(124_000);
      expect(new Set(encoded.slice(484)).size).toBeGreaterThan(1);
      expect(protocol.screenshotNumber - before).toBeLessThan(10);
      // The first slow screenshot arrives at 121850ms, so the previous image must hold until then.
      expect(encoded[487]).toBe(encoded[484]);
      expect(encoded[488]).not.toBe(encoded[487]);
    } finally {
      await context.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps pointer travel to its intended length on a page that takes frames to take each move", async () => {
    const protocol = new ProtocolHarness();
    // A heavy page (Notion re-rendering a board) answers each move a few frames later.
    const original = protocol.request.bind(protocol);
    const moveTimes: number[] = [];
    vi.spyOn(protocol, "request").mockImplementation(async (method, path, body) => {
      if (path.endsWith("/actions") && JSON.stringify(body).includes("pointerMove")) {
        moveTimes.push(performance.now());
        await new Promise((resolve) => setTimeout(resolve, 45));
      }
      return original(method, path, body);
    });
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      await context.pointer("left_click", { type: "coordinate", x: 200, y: 200 });
      moveTimes.length = 0;
      await context.pointer("left_click", { type: "coordinate", x: 1000, y: 600 });
      // 550ms plus half the 894px distance, however long the page took over each move.
      const travel = moveTimes.at(-1)! - moveTimes[0]!;
      expect(travel).toBeGreaterThanOrEqual(850);
      expect(travel).toBeLessThanOrEqual(1_100);
      expect(moveTimes.length).toBeGreaterThan(10);
    } finally {
      await context.dispose();
    }
  });

  it("records the cursor path from the driver even when the page reports no pointer events", async () => {
    const protocol = new ProtocolHarness();
    // A page just replaced by a redirect has no collector: its buffer is empty.
    protocol.telemetryDrain = { origin: 0, offset: 0, samples: [] };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      await context.pointer("left_click", { type: "coordinate", x: 1000, y: 600 });
      const samples = context.pointerTelemetry?.() ?? [];
      const moves = samples.filter((sample) => sample.kind === "move");
      expect(moves.length).toBeGreaterThan(5);
      const last = moves.at(-1)!;
      expect(samples.map((sample) => sample.kind).slice(-2)).toEqual(["down", "up"]);
      const press = samples.find((sample) => sample.kind === "down")!;
      expect([press.x, press.y]).toEqual([last.x, last.y]);
      expect(samples.every((sample, index) => index === 0 || sample.atMs >= samples[index - 1]!.atMs)).toBe(true);
    } finally {
      await context.dispose();
    }
  });

  it("notes where email addresses are on screen while recording, and when they are gone", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      expect(context.identitySightings?.() ?? []).toEqual([]);
      await context.startRecording();
      protocol.identityRects = [{ x: 0.5, y: 0.25, width: 0.2, height: 0.03 }, { x: "bad" }];
      await context.pointer("left_click", { type: "coordinate", x: 1000, y: 600 });
      protocol.identityRects = [];
      await context.readPage({ filter: "interactive" });
      const reads = context.identitySightings?.() ?? [];
      expect(reads.length).toBeGreaterThanOrEqual(3);
      expect(reads.some((read) => read.rects.length === 1 && read.rects[0]!.x === 0.5)).toBe(true);
      expect(reads.at(-1)!.rects).toEqual([]);
    } finally {
      await context.dispose();
    }
  });

  it("makes its checks before the pointer travels, so the press follows the arrival", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      const before = protocol.calls.length;
      await context.pointer("left_click", { type: "coordinate", x: 1000, y: 600 });
      // Body-less reads are the recorder's frame captures, which run on their own clock during the settle.
      const calls = protocol.calls.slice(before).map((call) => JSON.stringify(call.body) ?? "").filter(Boolean);
      const lastMove = calls.map((body) => body.includes("pointerMove")).lastIndexOf(true);
      const press = calls.findIndex((body) => body.includes("pointerDown"));
      // Between arriving and pressing only the travel's telemetry is saved; every check came before the travel.
      expect(press).toBeLessThanOrEqual(lastMove + 2);
      expect(calls.slice(lastMove + 1, press).join("")).not.toMatch(/disabled|contenteditable|getBoundingClientRect/);
      const trail = context.pointerTrail?.() ?? [];
      const arrival = (context.pointerTelemetry?.() ?? []).filter((sample) => sample.kind === "move").at(-1)!;
      expect(trail.at(-1)!.atMs).toBeGreaterThanOrEqual(arrival.atMs);
    } finally {
      await context.dispose();
    }
  });

  it("moves to the requested point before clicking and never clicks after failed travel", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      await context.computer([{ type: "click", x: 900, y: 500, button: "left" }]);
      await context.pointer("left_click", { type: "coordinate", x: 800, y: 400 });
      const moves = protocol.calls.filter(
        (call) =>
          call.path.endsWith("/actions") && (JSON.stringify(call.body) ?? "").includes("pointerMove"),
      );
      // Each click travels and ends on its own point.
      const bodies = moves.map((call) => JSON.stringify(call.body));
      const first = bodies.findIndex((body) => body.includes('"x":900,"y":500'));
      expect(first).toBeGreaterThan(0);
      expect(bodies.findIndex((body) => body.includes('"x":800,"y":400'))).toBeGreaterThan(first);
      const original = protocol.request.bind(protocol);
      vi.spyOn(protocol, "request").mockImplementation((method, path, body) => {
        if (path.endsWith("/actions") && JSON.stringify(body).includes("pointerMove")) {
          return Promise.reject(new Error("move failed"));
        }
        return original(method, path, body);
      });
      const clicks = () =>
        protocol.calls.filter((call) => JSON.stringify(call.body ?? {}).includes("pointerDown"))
          .length;
      const before = clicks();
      await expect(
        context.computer([{ type: "click", x: 200, y: 100, button: "left" }]),
      ).rejects.toThrow("move failed");
      await expect(context.pointer("left_click", { type: "ref", ref: "ref_1" })).rejects.toThrow(
        "move failed",
      );
      expect(clicks()).toBe(before);
    } finally {
      await context.dispose();
    }
  });

  it("reinstalls pointer collection when a navigation lands on a fresh document", async () => {
    const protocol = new ProtocolHarness();
    const request = protocol.request.bind(protocol);
    const listeners = new Map<string, (event: unknown) => void>();
    let page = {};
    vi.spyOn(protocol, "request").mockImplementation((method, path, body) => {
      const payload = body as { script?: string; args?: unknown[] } | undefined;
      if (payload?.script?.includes("window.__captureTelemetry")) {
        return Promise.resolve(
          runInNewContext(`(function(){${payload.script}}).apply(null,args)`, {
            window: page,
            args: payload.args,
            performance: { now: () => 100 },
            Element: class {},
            addEventListener: (name: string, listener: (event: unknown) => void) =>
              listeners.set(name, listener),
          }),
        );
      }
      return request(method, path, body);
    });
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      page = { innerWidth: 1280, innerHeight: 720 };
      listeners.clear();
      await context.computer([{ type: "keypress", keys: ["ESC"] }]);
      expect(listeners.has("mousemove")).toBe(true);
      listeners.get("mousemove")?.({ clientX: 640, clientY: 360 });
      await context.computer([{ type: "keypress", keys: ["ESC"] }]);
      expect(context.pointerTelemetry?.()).toContainEqual(
        expect.objectContaining({ x: 0.5, y: 0.5, kind: "move" }),
      );
    } finally {
      await context.dispose();
    }
  });

  it("passes the requested 60 fps to the screencast recorder", async () => {
    const protocol = new ProtocolHarness();
    const request = protocol.request.bind(protocol);
    vi.spyOn(protocol, "request").mockImplementation((method, path, body) =>
      path === "/session"
        ? Promise.resolve({
            sessionId: "session-1",
            capabilities: {
              "goog:chromeOptions": { debuggerAddress: "127.0.0.1:9222" },
            },
          })
        : request(method, path, body),
    );
    const start = vi.spyOn(CdpScreencastRecorder, "start").mockResolvedValue({
      stop: async () => new Uint8Array([1]),
    } as CdpScreencastRecorder);
    const context = await new WebDriverBrowserDriver(protocol, {
      recordingFrameRate: 60,
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      expect(start).toHaveBeenCalledWith(
        "127.0.0.1:9222",
        expect.anything(),
        expect.objectContaining({ framesPerSecond: 60 }),
      );
    } finally {
      await context.dispose();
      start.mockRestore();
    }
  });

  it("asks the screencast for the viewport times the capture scale, keeping the viewport", async () => {
    const protocol = new ProtocolHarness();
    const request = protocol.request.bind(protocol);
    vi.spyOn(protocol, "request").mockImplementation((method, path, body) =>
      path === "/session"
        ? Promise.resolve({ sessionId: "session-1", capabilities: { "goog:chromeOptions": { debuggerAddress: "127.0.0.1:9222" } } })
        : request(method, path, body),
    );
    const start = vi.spyOn(CdpScreencastRecorder, "start").mockResolvedValue({
      stop: async () => new Uint8Array([1]),
    } as CdpScreencastRecorder);
    const context = await new WebDriverBrowserDriver(protocol, {
      captureScale: 2,
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      expect(start).toHaveBeenCalledWith("127.0.0.1:9222", expect.anything(), expect.objectContaining({ width: 2560, height: 1440 }));
      // The window, and so every coordinate, is still the 1280x720 viewport.
      expect(protocol.calls.find((call) => call.method === "POST" && call.path.endsWith("/window/rect"))?.body).toEqual({ width: 1280, height: 720 });
    } finally {
      await context.dispose();
      start.mockRestore();
    }
  });

  it("refuses a capture scale outside 1 to 3", () => {
    expect(() => new WebDriverBrowserDriver(new ProtocolHarness(), { captureScale: 0.5 })).toThrow(RangeError);
    expect(() => new WebDriverBrowserDriver(new ProtocolHarness(), { captureScale: 4 })).toThrow(RangeError);
  });

  it("creates an isolated W3C session, hydrates approved state, captures, and deletes it", async () => {
    const protocol = new ProtocolHarness();
    const encoder: VideoEncoder = {
      encodePngFrames: vi.fn(async () => new TextEncoder().encode("webm")),
    };
    const driver = new WebDriverBrowserDriver(protocol, {
      videoEncoder: encoder,
      resolveHostname: async () => ["93.184.216.34"],
    });
    const context = await driver.createContext(
      contextOptions({
        cookies: [
          {
            name: "session",
            value: "opaque-cookie",
            domain: "demo.example.com",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [
          {
            origin: "https://demo.example.com",
            localStorage: [{ name: "workspace", value: "one" }],
          },
        ],
      }),
    );

    await context.goto("https://demo.example.com/dashboard");
    await context.fill({ strategy: "label", value: "API token" }, "never-in-trace");
    await context.mask({ strategy: "testId", value: "email" }, "blur");
    const image = await context.screenshot("dashboard", true);
    await context.startRecording();
    const video = await context.stopRecording();
    const trace = await context.stopTrace();
    await context.dispose();

    expect(image).toMatchObject({ kind: "screenshot", contentType: "image/png" });
    expect(video).toMatchObject({ kind: "video", contentType: "video/webm" });
    expect(trace && new TextDecoder().decode(trace.body)).not.toContain("never-in-trace");
    expect(protocol.calls).toContainEqual({
      method: "DELETE",
      path: "/session/session-1",
    });
    const newSession = protocol.calls.find((call) => call.path === "/session");
    expect(JSON.stringify(newSession?.body)).toContain("MAP demo.example.com 93.184.216.34");
    expect(JSON.stringify(newSession?.body)).toContain("excludeSwitches");
    expect(JSON.stringify(newSession?.body)).toContain(
      "disable-blink-features=AutomationControlled",
    );
    expect(JSON.stringify(newSession?.body)).not.toContain("headless=new");
    expect(protocol.calls.some((call) => (call.body as { cmd?: string })?.cmd === 'Network.setCookies')).toBe(true);
    expect(protocol.calls.some((call) => call.path.endsWith("/execute/sync"))).toBe(true);
    expect(encoder.encodePngFrames).toHaveBeenCalledOnce();
  });

  it("sizes the page viewport rather than the browser's outer window", async () => {
    const protocol = new ProtocolHarness();
    protocol.browserChrome.height = 139;
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    expect(
      protocol.calls.filter((call) => call.method === "POST" && call.path.endsWith("/window/rect")),
    ).toEqual([
      expect.objectContaining({ body: { width: 1280, height: 720 } }),
      expect.objectContaining({ body: { width: 1280, height: 859 } }),
    ]);
    await context.dispose();
  });

  it("uses the measured local viewport only when explicitly requested", async () => {
    const protocol = new ProtocolHarness();
    const original = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if(path.endsWith('/window/rect') && method==='POST')return protocol.windowRect;
      return original(method,path,body);
    };
    const browser=new WebDriverBrowserDriver(protocol,{resolveHostname:async()=>['93.184.216.34']});
    const strict={...contextOptions(),viewport:{width:1920,height:1080}};
    await expect(browser.createContext(strict)).rejects.toMatchObject({code:'viewport_size_mismatch'});
    const local={...contextOptions(),viewport:{width:1920,height:1080},fitViewportToWindow:true};
    const context=await browser.createContext(local);
    expect(local.viewport).toEqual({width:1280,height:720});
    await context.dispose();
  });

  it("checks the final URL after WebDriver navigation and blocks a foreign redirect", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      const result = await originalRequest(method, path, body);
      if (path.endsWith("/url") && method === "POST") {
        protocol.currentUrl = "https://evil.example/redirect";
      }
      return result;
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await expect(context.goto("https://demo.example.com/dashboard")).rejects.toThrow("blocked");
    await context.dispose();
  });

  it("hydrates a stale session that bounces the app to sign-in instead of aborting", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      const result = await originalRequest(method, path, body);
      if (path.endsWith("/url") && method === "POST") {
        const url = (body as { url: string }).url;
        if (url.includes("app.example.com")) {
          protocol.currentUrl = "https://accounts.example.com/sign-in";
        }
      }
      return result;
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext({
      viewport: { width: 1280, height: 720 },
      allowedOrigins: [
        "https://example.com",
        "https://app.example.com",
        "https://accounts.example.com",
      ],
      sessionState: new TextEncoder().encode(
        JSON.stringify({
          cookies: [
            {
              name: "marketing",
              value: "1",
              domain: "example.com",
              path: "/",
              httpOnly: false,
              secure: true,
              sameSite: "Lax",
            },
            {
              name: "session",
              value: "stale",
              domain: "app.example.com",
              path: "/",
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        }),
      ),
      onNavigation() {},
      allowDownload: false,
      allowPopup: false,
    });
    expect(context).toBeDefined();
    await context.dispose();
  });

  it("treats a first-load redirect to sign-in as login, not an expired session", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      const result = await originalRequest(method, path, body);
      if (path.endsWith("/url") && method === "POST") {
        protocol.currentUrl = "https://demo.example.com/sign-in";
      }
      return result;
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await expect(context.goto("https://demo.example.com/")).resolves.toBeUndefined();
    await context.dispose();
  });

  it("does not spend the redirect budget on login hops before returning to the app", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    const landings = [
      "https://accounts.example.com/sign-in",
      "https://accounts.example.com/sign-in/factor-one",
      "https://accounts.example.com/sign-in/sso-callback",
      "https://app.example.com/dashboard",
    ];
    let hop = 0;
    protocol.request = async (method, path, body) => {
      const result = await originalRequest(method, path, body);
      if (path.endsWith("/url") && method === "POST") {
        protocol.currentUrl = landings[Math.min(hop, landings.length - 1)] ?? protocol.currentUrl;
        hop += 1;
      }
      return result;
    };
    let maxRedirects = 0;
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext({
      viewport: { width: 1280, height: 720 },
      allowedOrigins: ["https://app.example.com", "https://accounts.example.com"],
      sessionState: new TextEncoder().encode(JSON.stringify({ cookies: [], origins: [] })),
      onNavigation(_target, redirectCount) {
        maxRedirects = Math.max(maxRedirects, redirectCount);
        if (redirectCount > 3) throw new Error("navigation_blocked");
      },
      allowDownload: false,
      allowPopup: false,
    });
    await context.goto("https://accounts.example.com/sign-in");
    await context.goto("https://accounts.example.com/sign-in");
    await context.goto("https://accounts.example.com/sign-in");
    await context.goto("https://app.example.com/");
    await context.goto("https://app.example.com/");
    expect(maxRedirects).toBeLessThanOrEqual(3);
    await context.dispose();
  });

  it("allows an intentional sign-in page but rejects an unexpected redirect back to it", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await expect(context.goto("https://demo.example.com/sign-in")).resolves.toBeUndefined();
    await context.goto("https://demo.example.com/dashboard");
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      const result = await originalRequest(method, path, body);
      if (path.endsWith("/url") && method === "POST") {
        protocol.currentUrl = "https://demo.example.com/sign-in";
      }
      return result;
    };
    await expect(context.goto("https://demo.example.com/settings")).rejects.toThrow(
      "reauth_required",
    );
    await context.dispose();
  });

  it("follows a provider's sign-in or consent page on another site instead of asking to reauthenticate", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext({ ...contextOptions(), onNavigation() {} });
    await context.goto("https://demo.example.com/settings");
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      const result = await originalRequest(method, path, body);
      if (path.endsWith("/url") && method === "POST") {
        protocol.currentUrl = "https://accounts.google.com/signin/oauth/consent";
      }
      return result;
    };
    await expect(context.goto("https://demo.example.com/connect/google")).resolves.toBeUndefined();
    await context.dispose();
  });

  it("finds a password field inside a hosted sign-in iframe", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    let frame = "top";
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/frame") && method === "POST") {
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        const id = (body as { id: { [elementKey]?: string } | null }).id;
        frame = id?.[elementKey] ?? "top";
        return null;
      }
      if (path.endsWith("/frame/parent")) {
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        frame = "top";
        return null;
      }
      if (path.endsWith("/elements")) {
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        const xpath = (body as { value: string }).value;
        if (xpath.includes("iframe") && frame === "top") return [{ [elementKey]: "clerk-frame" }];
        if (xpath.includes("password") && frame === "clerk-frame") {
          return [{ [elementKey]: "password" }];
        }
        return [];
      }
      if (path.endsWith("/element/password/displayed")) {
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        return true;
      }
      return originalRequest(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await context.goto("https://demo.example.com/sign-in");
    await context.click({ strategy: "field", value: "password" });
    expect(protocol.calls).toContainEqual({
      method: "POST",
      path: "/session/session-1/frame",
      body: { id: { [elementKey]: "clerk-frame" } },
    });
    await context.dispose();
  });

  it("finds a password field inside a shadow root after Clerk offers a password strategy", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    let offeredPassword = false;
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/execute/sync")) {
        const script = (body as { script: string }).script;
        if (script.includes("isStrategy")) {
          offeredPassword = true;
          return true;
        }
        if (script.includes("querySelectorAll")) {
          return offeredPassword ? { [elementKey]: "shadow-password" } : null;
        }
      }
      if (path.endsWith("/elements")) return [];
      if (path.endsWith("/element/shadow-password/displayed")) return true;
      return originalRequest(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await context.goto("https://demo.example.com/sign-in");
    await context.waitFor({ strategy: "field", value: "password" });
    expect(offeredPassword).toBe(true);
    await context.dispose();
  });

  it("types a password without clearing when Clerk rejects clear on the control", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/elements")) return [{ [elementKey]: "password" }];
      if (path.endsWith("/element/password/displayed")) return true;
      if (path.endsWith("/element/password/clear")) {
        throw Object.assign(new Error("invalid element state"), { code: "invalid element state" });
      }
      return originalRequest(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await context.goto("https://demo.example.com/sign-in");
    await context.fill({ strategy: "field", value: "password" }, "secret");
    expect(protocol.calls).toContainEqual({
      method: "POST",
      path: "/session/session-1/element/password/value",
      body: { text: "secret" },
    });
    expect(protocol.calls.some((call) => call.path.endsWith("/clear"))).toBe(false);
    await context.dispose();
  });

  it.each([false, true])(
    "exports session state without leaving the application (origin fails: %s)",
    async (originFails) => {
      const protocol = new ProtocolHarness();
      const request = protocol.request.bind(protocol);
      let activeWindow = "application";
      let applicationUrl = "";
      const closedWindows: string[] = [];
      vi.spyOn(protocol, "request").mockImplementation(async (method, path, body) => {
        if (path.endsWith("/window/new")) return { handle: "export", type: "tab" };
        if (path.endsWith("/window")) {
          if (method === "GET") return activeWindow;
          if (method === "DELETE") {
            closedWindows.push(activeWindow);
            return [];
          }
          if (activeWindow === "application") applicationUrl = protocol.currentUrl;
          activeWindow = (body as { handle: string }).handle;
          protocol.currentUrl = activeWindow === "application" ? applicationUrl : "about:blank";
          return null;
        }
        if (
          originFails &&
          method === "POST" &&
          path.endsWith("/url") &&
          activeWindow === "export"
        ) {
          throw new Error("origin unavailable");
        }
        return request(method, path, body);
      });
      protocol.cookies = [
        {
          name: "__session",
          value: "clerk",
          domain: "demo.example.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ];
      const context = await new WebDriverBrowserDriver(protocol, {
        resolveHostname: async () => ["93.184.216.34"],
      }).createContext(contextOptions());
      await context.goto("https://demo.example.com/dashboard");
      const state = await context.exportStorageState();
      expect(state.cookies).toEqual([
        expect.objectContaining({ name: "__session", domain: "demo.example.com" }),
      ]);
      expect(activeWindow).toBe("application");
      expect(protocol.currentUrl).toBe("https://demo.example.com/dashboard");
      expect(closedWindows).toEqual(["export"]);
      await context.dispose();
    },
  );

  it("exports a sign-in provider's cookie that only the browser-wide list shows", async () => {
    const protocol = new ProtocolHarness();
    const request = protocol.request.bind(protocol);
    vi.spyOn(protocol, "request").mockImplementation(async (method, path, body) => {
      if (path.endsWith("/window/new")) return { handle: "export", type: "tab" };
      if (path.endsWith("/goog/cdp/execute") && (body as { cmd: string }).cmd === "Storage.getCookies") {
        return { cookies: [
          { name: "__client", value: "long-lived", domain: "clerk.demo.example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
          { name: "tracker", value: "drop", domain: "evil.example", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "None" },
        ] };
      }
      return request(method, path, body);
    });
    protocol.cookies = [{ name: "__session", value: "short", domain: "demo.example.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }];
    const context = await new WebDriverBrowserDriver(protocol, { resolveHostname: async () => ["93.184.216.34"] }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    const state = await context.exportStorageState();
    expect(state.cookies.map((cookie) => `${cookie.domain}:${cookie.name}`).sort()).toEqual(["clerk.demo.example.com:__client", "demo.example.com:__session"]);
    await context.dispose();
  });

  it("stops when a restored session follows the login link straight into the app", async () => {
    const protocol = new ProtocolHarness();
    const request = protocol.request.bind(protocol);
    vi.spyOn(protocol, "request").mockImplementation(async (method, path, body) => {
      const script = (body as { script?: string } | undefined)?.script;
      if (path.endsWith("/execute/sync") && script?.includes("cl-formFieldErrorText")) {
        const inApp = protocol.currentUrl.startsWith("https://demo.example.com/entrar");
        return { signedIn: inApp, rejected: false, challenge: false, loginLinks: inApp ? [] : ["https://demo.example.com/entrar"] };
      }
      // Neither the marketing page nor the app shows a login form.
      if (path.endsWith("/elements")) return [];
      return request(method, path, body);
    });
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.connectWithCredentials("demo@example.com", "secret", new AbortController().signal, "https://demo.example.com");
    expect(protocol.currentUrl).toBe("https://demo.example.com/entrar");
    expect(protocol.calls.some((call) => call.path.endsWith("/value") || call.path.endsWith("/clear"))).toBe(false);
    await context.dispose();
  }, 20_000);

  it("does not click Continue after Enter already submitted the password", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/sign-in");
    await context.fill({ strategy: "field", value: "password" }, "secret");
    const calls = protocol.calls.length;
    await context.click({ strategy: "field", value: "submit" });
    expect(
      protocol.calls
        .slice(calls)
        .some((call) => call.path.endsWith("/click") || call.path.endsWith("/actions")),
    ).toBe(false);
    await context.dispose();
  });

  it.each([true, false])("requires a focused shadow-root password to be displayed: %s", async (displayed) => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/elements")) return [];
      if (path.endsWith("/element/active")) return { [elementKey]: "shadow-password" };
      if (path.endsWith("/element/shadow-password/attribute/type")) return "password";
      if (path.endsWith("/element/shadow-password/displayed")) return displayed;
      return originalRequest(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await context.goto("https://demo.example.com/sign-in");
    if (displayed) await context.assertVisible({ strategy: "field", value: "password" });
    else await expect(context.assertVisible({ strategy: "field", value: "password" })).rejects.toMatchObject({ code: "element_not_visible" });
    await context.dispose();
  });

  it("uses the visible control when a client-rendered form leaves a hidden duplicate", async () => {
    const protocol = new ProtocolHarness();
    const originalRequest = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/elements")) {
        return [{ [elementKey]: "hidden" }, { [elementKey]: "visible" }];
      }
      if (path.endsWith("/element/hidden/displayed")) return false;
      return originalRequest(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await context.goto("https://demo.example.com/sign-in");
    await context.click({ strategy: "field", value: "submit" });
    expect(protocol.calls).toContainEqual({
      method: "POST",
      path: "/session/session-1/element/visible/click",
      body: {},
    });
    await context.dispose();
  });

  it("does not read the whole page as the target when nothing is focused", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    await context.computer([{ type: "click", x: 100, y: 100 }]);
    const policyScript = protocol.calls
      .map((call) => (call.body as { script?: string } | undefined)?.script ?? "")
      .find((script) => script.includes("f?.action"));
    expect(policyScript).toContain("e===document.body||e===document.documentElement");
    await context.dispose();
  });

  it("executes visual coordinates but blocks a destructive target before clicking", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");

    protocol.targetDescription = "Delete account";
    await expect(context.computer([{ type: "click", x: 100, y: 100 }])).rejects.toThrow(
      "action_blocked",
    );
    protocol.targetDescription = "Search";
    await expect(context.computer([{ type: "click", x: 100, y: 100 }])).resolves.toBeUndefined();
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/session/session-1/actions" }),
    );
    await context.dispose();
  });

  /**
   * One unrecognised key aborts the capture, so the aliases are load-bearing: the model says
   * "Return" and "Control" as readily as "Enter" and "Ctrl", and a table that knew only one spelling
   * threw away the whole recording. A genuinely unknown key is still refused, and now says which.
   */
  it("accepts every spelling of a key, and names the one it cannot place", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    protocol.targetDescription = "Search";

    for (const keys of [["Return"], ["Control", "a"], ["cmd+Down"], ["F5"], ["PgDn"]]) {
      await expect(context.computer([{ type: "keypress", keys }])).resolves.toBeUndefined();
    }
    await expect(context.computer([{ type: "keypress", keys: ["Hyper"] }])).rejects.toThrow(
      "unknown key Hyper",
    );
    await context.dispose();
  });

  it("disposes a session when encrypted browser state cannot be decoded", async () => {
    const protocol = new ProtocolHarness();
    await expect(
      new WebDriverBrowserDriver(protocol, {
        resolveHostname: async () => ["93.184.216.34"],
      }).createContext({
        ...contextOptions(),
        sessionState: new TextEncoder().encode("not-json"),
      }),
    ).rejects.toThrow("reauth_required");
    expect(protocol.calls.at(-1)).toEqual({ method: "DELETE", path: "/session/session-1" });
  });

  it("starts recording once an app's opening loader clears, instead of failing on it", async () => {
    const protocol = new ProtocolHarness();
    protocol.loaderVisible = true;
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/home");
    setTimeout(() => { protocol.loaderVisible = false; }, 700);
    await context.startRecording();
    expect(protocol.calls.filter((call) => JSON.stringify(call.body ?? "").includes("aria-busy")).length).toBeGreaterThan(1);
    await context.stopRecording().catch(() => undefined);
    await context.dispose();
  });

  it("rejects screenshots while a visible loader can produce a misleading asset", async () => {
    const protocol = new ProtocolHarness();
    protocol.loaderVisible = true;
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await expect(context.screenshot("loading", false)).rejects.toMatchObject({
      code: "loader_visible",
    });
    await context.dispose();
  });

  it("moves and records the pointer for a ref click, so the recording shows a cursor", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    await context.startRecording();
    await context.readPage();
    await context.pointer("left_click", { type: "ref", ref: "ref_1" });

    // The cursor in the finished video is drawn from this trail; an element click that skipped it
    // would land silently and leave the video cutting between states.
    expect(context.pointerTrail?.() ?? []).toHaveLength(1);
    expect((context.pointerTrail?.() ?? [])[0]).toMatchObject({ shape: "hand", x: 0.5, y: 0.4 });
    expect(
      (
        context as unknown as BrowserContextDriver & { semanticTimeline(): unknown[] }
      ).semanticTimeline(),
    ).toEqual([expect.objectContaining({ type: "click", ref: "ref_1" })]);
    const moved = protocol.calls.filter(
      (call) =>
        call.path.endsWith("/actions") && JSON.stringify(call.body ?? {}).includes("pointerMove"),
    );
    // A travel, not a jump: many small moves, ending on the target.
    expect(moved.length).toBeGreaterThan(10);
    expect(JSON.stringify(moved.at(-1)?.body)).toContain('"x":100,"y":200');
    await context.dispose();
  });

  it("records a result at the current time without relabeling the submit click", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    await context.startRecording();
    await context.readPage();
    await context.pointer("left_click", { type: "ref", ref: "ref_1" });

    const semantic = context as unknown as BrowserContextDriver & {
      markDemoMoment(kind: "setup" | "action" | "result", note: string, focus?: CaptureSemanticAction["focus"], observedAtMs?: number): void;
      semanticTimeline(): Array<{ type: string; element: string }>;
    };
    semantic.markDemoMoment("result", "Results for person@example.com");

    expect(semantic.semanticTimeline()).toEqual([
      expect.objectContaining({ type: "click" }),
      expect.objectContaining({ type: "result", ref: null, focus: { x: 0, y: 0, width: 1, height: 1 }, element: "Results for [redacted]" }),
    ]);
    semantic.markDemoMoment("result", "Previously observed", undefined, 0);
    expect(semantic.semanticTimeline().at(-1)).toMatchObject({ type: "result", atMs: 0 });
    expect(() => semantic.markDemoMoment("result", "Future", undefined, Number.MAX_SAFE_INTEGER)).toThrow("invalid_observation_time");
    expect(() => semantic.markDemoMoment("result", "Invalid", undefined, NaN)).toThrow("invalid_observation_time");
    await context.dispose();
  });

  it("reports a stale ref as recoverable text instead of ending the run", async () => {
    const protocol = new ProtocolHarness();
    protocol.refElement = null;
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");

    await expect(
      context.pointer("left_click", { type: "ref", ref: "ref_9" }),
    ).rejects.toMatchObject({ name: "StaleRefError" });
    await expect(context.pointer("left_click", { type: "ref", ref: "ref_9" })).rejects.toThrow(
      /Re-read the page/u,
    );
    await context.dispose();
  });

  it("refuses a malformed ref without touching the page", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    const before = protocol.calls.length;

    await expect(
      context.pointer("left_click", { type: "ref", ref: "'; DROP TABLE" }),
    ).rejects.toMatchObject({ name: "StaleRefError" });
    expect(protocol.calls.length).toBe(before);
    await context.dispose();
  });

  it("types a form value rather than assigning it, so entry is visible", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    await context.startRecording();
    await context.formInput("ref_1", "example.com");

    // Typed through the keyboard rather than assigned to the element: the direct value set the
    // member specifies is invisible on camera.
    const typed = protocol.calls.find(
      (call) =>
        call.path.endsWith("/actions") && JSON.stringify(call.body ?? {}).includes('"keyDown"'),
    );
    expect(typed).toBeDefined();
    expect(context.pointerTrail?.() ?? []).toHaveLength(0);
    expect(
      (
        context as unknown as BrowserContextDriver & { semanticTimeline(): unknown[] }
      ).semanticTimeline(),
    ).toEqual([
      expect.objectContaining({ type: "type", ref: null, element: expect.any(String), atMs: expect.any(Number), endMs: expect.any(Number), focus: { x: 0.2, y: 0.2, width: 0.5, height: 0.3 } }),
    ]);
    await context.dispose();
  });

  it("types a demo value character by character so the field fills on camera", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    await context.startRecording();
    await context.formInput("ref_1", "example.com");

    const typed = protocol.calls.find(
      (call) =>
        call.path.endsWith("/actions") && JSON.stringify(call.body ?? {}).includes('"keyDown"'),
    );
    const keys = (
      typed?.body as
        | { actions: Array<{ actions: Array<{ type: string; duration?: number }> }> }
        | undefined
    )?.actions[0]?.actions;
    // One keyDown, one keyUp and one pause per character: a field that fills in a single frame is
    // the one thing no human does.
    expect(keys?.filter((action) => action.type === "keyDown")).toHaveLength("example.com".length);
    const pauses = keys?.filter((action) => action.type === "pause") ?? [];
    expect(pauses).toHaveLength("example.com".length);
    expect(
      pauses.every((action) => (action.duration ?? 0) >= 95 && (action.duration ?? 0) <= 170),
    ).toBe(true);
    const typedIndex = protocol.calls.indexOf(typed as (typeof protocol.calls)[number]);
    const moves = protocol.calls
      .slice(0, typedIndex)
      .filter(
        (call) =>
          call.path.endsWith("/actions") && (JSON.stringify(call.body) ?? "").includes('"pointerMove"'),
      );
    expect(JSON.stringify(moves.at(-1)?.body)).toContain('"x":300,"y":270');
    await context.dispose();
  });

  it("paces the browser toolset's focused type member too", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    await context.startRecording();
    await (
      context as unknown as BrowserContextDriver & { typeText(text: string): Promise<void> }
    ).typeText("demo");

    const typed = protocol.calls.find(
      (call) =>
        call.path.endsWith("/actions") && JSON.stringify(call.body ?? {}).includes('"keyDown"'),
    );
    const keys = (
      typed?.body as { actions: Array<{ actions: Array<{ type: string }> }> } | undefined
    )?.actions[0]?.actions;
    expect(keys?.filter((action) => action.type === "keyDown")).toHaveLength(4);
    expect(protocol.calls.some((call) => call.path.endsWith("/element/element-1/click"))).toBe(
      false,
    );
    await context.dispose();
  });

  it("keeps login fills fast, because nothing is being recorded yet", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/sign-in");
    await context.fill({ strategy: "field", value: "email" }, "user@example.com");

    // The one-shot value endpoint, not the paced keyboard: a login has nothing to demonstrate.
    expect(protocol.calls.some((call) => call.path.endsWith("/value"))).toBe(true);
    expect(
      protocol.calls.some(
        (call) =>
          call.path.endsWith("/actions") && JSON.stringify(call.body ?? {}).includes('"keyDown"'),
      ),
    ).toBe(false);
    await context.dispose();
  });

  it("reads the page as a ref-tagged outline the model can address", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");

    expect(await context.readPage()).toContain("[ref_1]");
    expect(await context.findElements("novos leads")).toContain("[ref_1]");
    expect(await context.pageText()).toBe("Acme dashboard");
    await context.dispose();
  });

  it("lets the agent observe a loading page instead of ending the run", async () => {
    const protocol = new ProtocolHarness();
    protocol.loaderVisible = true;
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    // The same loader that must block a kept screenshot is what the agent needs to see to wait.
    await expect(context.screenshot(AGENT_OBSERVATION_NAME, false)).resolves.toMatchObject({
      kind: "screenshot",
    });
    await context.dispose();
  });

  it("still delivers a recording when a loader is visible at stop", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      videoEncoder: { encodePngFrames: vi.fn(async () => new TextEncoder().encode("webm")) },
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.startRecording();
    protocol.loaderVisible = true;
    await expect(context.stopRecording()).resolves.toMatchObject({ kind: "video" });
    await context.dispose();
  });

  it("keeps pointer timestamps on the recording clock after a document navigation", async () => {
    const protocol = new ProtocolHarness();
    protocol.telemetryDrain = {
      origin: 200,
      offset: 5_000,
      samples: [{ atMs: 250, x: 0.25, y: 0.5, cursor: "pointer", kind: "down" }],
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      videoEncoder: { encodePngFrames: vi.fn(async () => new TextEncoder().encode("webm")) },
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await context.startRecording();
    await context.stopRecording();

    expect(context.pointerTelemetry?.()).toEqual([
      expect.objectContaining({ atMs: 5_050, x: 0.25, y: 0.5, kind: "down" }),
    ]);
    await context.dispose();
  });

  it("rejects a recording whose frames never change", async () => {
    const protocol = new ProtocolHarness();
    protocol.freezeScreenshots = true;
    const context = await new WebDriverBrowserDriver(protocol, {
      videoEncoder: { encodePngFrames: vi.fn(async () => new TextEncoder().encode("webm")) },
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.startRecording();
    await expect(context.stopRecording()).rejects.toThrow("recording_frozen");
    await context.dispose();
  });

  it("rejects private, loopback, link-local, and carrier-grade NAT addresses", async () => {
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.20.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
      "fd00::1",
    ]) {
      expect(isPublicNetworkAddress(address)).toBe(false);
    }
    expect(isPublicNetworkAddress("93.184.216.34")).toBe(true);

    const protocol = new ProtocolHarness();
    await expect(
      new WebDriverBrowserDriver(protocol, {
        resolveHostname: async () => ["169.254.169.254"],
      }).createContext(contextOptions()),
    ).rejects.toThrow("navigation_blocked");
    expect(protocol.calls).toHaveLength(0);
  });
});

describe("pageLooksLikeBotChallenge", () => {
  it("recognizes Cloudflare confirmation copy and challenge frames", () => {
    expect(pageLooksLikeBotChallenge({ text: "Verify you are human" })).toBe(true);
    expect(pageLooksLikeBotChallenge({ text: "Security confirmation" })).toBe(true);
    expect(
      pageLooksLikeBotChallenge({
        text: "Incompatible browser extension or network configuration",
      }),
    ).toBe(true);
    expect(pageLooksLikeBotChallenge({ challengeFrame: true })).toBe(true);
    expect(pageLooksLikeBotChallenge({ text: "Search people" })).toBe(false);
  });
});

describe("FetchWebDriverTransport", () => {
  it("unwraps successful W3C values and converts protocol failures to typed errors", async () => {
    const successfulFetch = vi.fn(
      async () => new Response(JSON.stringify({ value: { sessionId: "one" } }), { status: 200 }),
    );
    const transport = new FetchWebDriverTransport(
      "http://webdriver:4444/wd/hub/",
      successfulFetch as unknown as typeof fetch,
      30_000,
      { authorization: "Bearer session-token" },
    );
    await expect(transport.request("POST", "/session", {})).resolves.toEqual({
      sessionId: "one",
    });
    expect(successfulFetch).toHaveBeenCalledWith(
      "http://webdriver:4444/wd/hub/session",
      expect.objectContaining({ method: "POST", headers: { authorization: "Bearer session-token", "content-type": "application/json" } }),
    );

    const failed = new FetchWebDriverTransport(
      "http://webdriver:4444",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ value: { error: "invalid session id", message: "sensitive" } }),
            { status: 404 },
          ),
      ) as unknown as typeof fetch,
    );
    await expect(failed.request("GET", "/session/nope/url")).rejects.toMatchObject({
      code: "invalid session id",
    });
  });
});

describe("host resolution policy", () => {
  async function hostRulesFor(allowedOrigins: string[]): Promise<string> {
    const protocol = new ProtocolHarness();
    const driver = new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    });
    await driver.createContext({ ...contextOptions(), allowedOrigins });
    const request = protocol.calls.find((entry) => entry.path === "/session");
    const capabilities = (
      request?.body as
        | { capabilities: { alwaysMatch: Record<string, { args: string[] }> } }
        | undefined
    )?.capabilities;
    const args = capabilities?.alwaysMatch["goog:chromeOptions"]?.args ?? [];
    return args.find((argument) => argument.startsWith("--host-resolver-rules=")) ?? "";
  }

  it("pins listed public hosts without jailing the rest of DNS", async () => {
    const rules = await hostRulesFor(["https://demo.example.com"]);
    expect(rules).toContain("MAP demo.example.com 93.184.216.34");
    expect(rules).not.toContain("MAP * ~NOTFOUND");
    expect(rules).not.toContain("EXCLUDE");
  });

  it("retries a login fill when the identifier field remounts after waitFor", async () => {
    const protocol = new ProtocolHarness();
    let emailLookups = 0;
    const original = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/elements") && method === "POST") {
        const query = String((body as { value?: string }).value ?? "");
        if (query.includes("identifier") || query.includes("@type='email'")) {
          emailLookups += 1;
          protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
          if (emailLookups === 1) return [];
          return [{ [elementKey]: "element-1" }];
        }
      }
      return original(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/sign-in");
    await context.fill({ strategy: "field", value: "email" }, "user@example.com");
    expect(emailLookups).toBeGreaterThan(1);
    expect(protocol.calls.some((call) => call.path.endsWith("/value"))).toBe(true);
    await context.dispose();
  });

  it("skips a login fill when the session resumes while the form is still on screen", async () => {
    const protocol = new ProtocolHarness();
    const original = protocol.request.bind(protocol);
    let emailLookups = 0;
    protocol.request = async (method, path, body) => {
      // Nothing on the resumed dashboard matches a sign-in locator any more, identifier included.
      if (path.endsWith("/elements") && method === "POST") {
        const query = String((body as { value?: string }).value ?? "");
        if (query.includes("identifier") || query.includes("@type='email'")) {
          emailLookups += 1;
          if (emailLookups === 1) protocol.currentUrl = "https://demo.example.com/dashboard";
        }
        return [];
      }
      return original(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/sign-in");

    // Resolves rather than throwing element_not_visible, and never writes the identifier.
    await expect(
      context.fill({ strategy: "field", value: "email" }, "user@example.com"),
    ).resolves.toBeUndefined();
    expect(protocol.calls.some((call) => call.path.endsWith("/value"))).toBe(false);
    await context.dispose();
    // Waits out the 8s login retry budget before the resumed-session check can run.
  }, 15_000);

  it("stops waiting for the login form once the session lands mid-wait", async () => {
    /**
     * The recipe opens the app's origin to reuse a live session. Right after the goto the redirect is still in
     * flight, so the initial check answers "not signed in", and without reconsidering the wait spent the full 20
     * seconds looking for a field the page had already left behind: the wait_timeout seen on a real dashboard.
     */
    const protocol = new ProtocolHarness();
    const original = protocol.request.bind(protocol);
    let onLoginPage = true;
    protocol.request = async (method, path, body) => {
      // A terceira leitura de URL já encontra o app: a sessão chegou.
      if (path.endsWith("/url") && method === "GET") {
        const url = onLoginPage
          ? "https://demo.example.com/sign-in"
          : "https://demo.example.com/dashboard";
        onLoginPage = false;
        return url;
      }
      if (path.endsWith("/elements") && method === "POST") {
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        return [];
      }
      return original(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    const started = Date.now();
    await context.waitFor({ strategy: "field", value: "email" });
    // Sem a reconsideração isto levaria os 20s do deadline.
    expect(Date.now() - started).toBeLessThan(10_000);
    await context.dispose();
  });

  it("skips the login form when the hydrated session is already signed in", async () => {
    const protocol = new ProtocolHarness();
    const original = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/elements") && method === "POST") {
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        return [];
      }
      return original(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    const calls = protocol.calls.length;
    await context.waitFor({ strategy: "field", value: "email" });
    await context.fill({ strategy: "field", value: "email" }, "user@example.com");
    await context.click({ strategy: "field", value: "submit" });
    const extra = protocol.calls.slice(calls);
    expect(
      extra.some(
        (call) =>
          call.path.endsWith("/value") ||
          call.path.endsWith("/click") ||
          call.path.endsWith("/actions"),
      ),
    ).toBe(false);
    await context.dispose();
  });

  it("skips credential masking when the hydrated session is already signed in", async () => {
    const protocol = new ProtocolHarness();
    const original = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/elements") && method === "POST") {
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        return [];
      }
      return original(method, path, body);
    };
    protocol.currentUrl = "https://demo.example.com/dashboard";
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());

    await expect(context.mask({ strategy: "field", value: "email" })).resolves.toBeUndefined();
    expect(
      protocol.calls.some(
        (call) =>
          call.path.endsWith("/execute/sync") &&
          (JSON.stringify(call.body) ?? "").includes("style.color='transparent'"),
      ),
    ).toBe(false);
    await context.dispose();
  });

  it("skips identifier steps when Clerk resumes at the password factor", async () => {
    const protocol = new ProtocolHarness();
    const original = protocol.request.bind(protocol);
    protocol.request = async (method, path, body) => {
      if (path.endsWith("/elements") && method === "POST") {
        const query = String((body as { value?: string }).value ?? "");
        protocol.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        return query.includes("password") ? [{ [elementKey]: "password-element" }] : [];
      }
      return original(method, path, body);
    };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/sign-in/factor-one");
    const calls = protocol.calls.length;
    await context.waitFor({ strategy: "field", value: "email" });
    await context.fill({ strategy: "field", value: "email" }, "user@example.com");
    await context.click({ strategy: "field", value: "submit" });
    expect(
      protocol.calls
        .slice(calls)
        .some(
          (call) =>
            call.path.endsWith("/clear") ||
            call.path.endsWith("/value") ||
            call.path.endsWith("/actions"),
        ),
    ).toBe(false);
    await context.dispose();
  });

  it("does not reload an origin the session is already on", async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await context.goto("https://demo.example.com/dashboard");
    const navigations = protocol.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/url"),
    ).length;
    await context.goto("https://demo.example.com/");
    expect(
      protocol.calls.filter((call) => call.method === "POST" && call.path.endsWith("/url")),
    ).toHaveLength(navigations);
    await context.dispose();
  });

  it("refuses to record a Cloudflare confirmation page", async () => {
    const protocol = new ProtocolHarness();
    protocol.challengeSnapshot = { text: "Verify you are human", challengeFrame: true };
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions());
    await expect(context.startRecording()).rejects.toMatchObject({ code: "bot_challenge" });
    await context.dispose();
  });

  it("skips pinning a host that does not resolve so optional Clerk origins cannot abort the session", async () => {
    const protocol = new ProtocolHarness();
    const driver = new WebDriverBrowserDriver(protocol, {
      resolveHostname: async (hostname) => {
        if (hostname === "protect.clerk.com") {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND protect.clerk.com"), {
            code: "ENOTFOUND",
          });
        }
        if (hostname === "js.clerk.com") return [];
        return ["93.184.216.34"];
      },
    });
    await driver.createContext({
      ...contextOptions(),
      allowedOrigins: [
        "https://demo.example.com",
        "https://protect.clerk.com",
        "https://js.clerk.com",
      ],
    });
    const request = protocol.calls.find((entry) => entry.path === "/session");
    const capabilities = (
      request?.body as
        | { capabilities: { alwaysMatch: Record<string, { args: string[] }> } }
        | undefined
    )?.capabilities;
    const args = capabilities?.alwaysMatch["goog:chromeOptions"]?.args ?? [];
    const rules = args.find((argument) => argument.startsWith("--host-resolver-rules=")) ?? "";
    expect(rules).toContain("MAP demo.example.com 93.184.216.34");
    expect(rules).not.toContain("MAP protect.clerk.com");
    expect(rules).not.toContain("MAP js.clerk.com");
    expect(rules).not.toContain("MAP * ~NOTFOUND");
  });
});

it("does not dispatch or record a click on a disabled control", async () => {
  const protocol = new ProtocolHarness();
  protocol.disabled = true;
  const context = await new WebDriverBrowserDriver(protocol, {
    resolveHostname: async () => ["93.184.216.34"],
  }).createContext(contextOptions());
  try {
    await expect(context.pointer("left_click", { type: "ref", ref: "ref_1" })).rejects.toThrow();
    expect(protocol.calls.some(call => (JSON.stringify(call.body) ?? "").includes('"pointerDown"'))).toBe(false);
    expect(context.pointerTrail?.()).toEqual([]);
  } finally { await context.dispose(); }
});


it('uses a private per-session hosted profile and removes it after disposal or failed creation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'webdriver-profile-'));
 vi.stubEnv('RECORDER_SCRATCH_DIR',root);
 try {
  const protocol=new ProtocolHarness();
  const driver=new WebDriverBrowserDriver(protocol,{resolveHostname:async()=>['93.184.216.34']});
  const context=await driver.createContext(contextOptions());
  const names=await readdir(root);expect(names).toHaveLength(1);expect(names[0]).toMatch(/^recorder-browser-/);
  const request=protocol.calls.find(call=>call.path==='/session');
  expect(JSON.stringify(request?.body)).toContain(`--user-data-dir=${join(root,names[0]!)}`);
  await context.dispose();expect(await readdir(root)).toEqual([]);
  const failed=new WebDriverBrowserDriver({request:async()=>{throw new Error('launch_failed');}},{resolveHostname:async()=>['93.184.216.34']});
  await expect(failed.createContext(contextOptions())).rejects.toThrow('launch_failed');
  expect(await readdir(root)).toEqual([]);
 }finally{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

describe("new shot hold", () => {
  const viewport = { width: 1440, height: 900 };
  it("holds the first press and one far from or long after the last", () => {
    expect(opensNewShot(null, { x: 700, y: 400 }, viewport, 10_000)).toBe(true);
    expect(opensNewShot({ x: 200, y: 200, atMs: 9_000 }, { x: 1_200, y: 700 }, viewport, 10_000)).toBe(true);
    expect(opensNewShot({ x: 700, y: 400, atMs: 0 }, { x: 720, y: 410 }, viewport, 10_000)).toBe(true);
  });

  it("presses at once inside the current shot", () => {
    // The next field of the same form, a second later: the camera is already there.
    expect(opensNewShot({ x: 700, y: 400, atMs: 9_000 }, { x: 760, y: 470 }, viewport, 10_000)).toBe(false);
  });
});

describe("click panel", () => {
  it("keeps the panel around the target as viewport fractions", () => {
    expect(containerFrom({ x: 0.18, y: 0.2, w: 0.44, h: 0.3 })).toEqual({ container: { x: 0.18, y: 0.2, width: 0.44, height: 0.3 } });
  });

  it("drops a missing, empty or off-screen panel", () => {
    expect(containerFrom(null)).toBeUndefined();
    expect(containerFrom({ x: 0.1, y: 0.1, w: 0, h: 0.2 })).toBeUndefined();
    expect(containerFrom({ x: 1.2, y: 0.1, w: 0.2, h: 0.2 })).toBeUndefined();
    expect(containerFrom({ x: "a", y: 0.1, w: 0.2, h: 0.2 })).toBeUndefined();
  });
});

describe("human travel", () => {
  const from = { x: 100, y: 100 }, to = { x: 900, y: 500 };

  it("speeds up and slows down like a reaching hand", () => {
    expect(minimumJerk(0)).toBe(0);
    expect(minimumJerk(1)).toBe(1);
    expect(minimumJerk(0.5)).toBeCloseTo(0.5);
    // Slow at both ends, fast in the middle.
    expect(minimumJerk(0.1)).toBeLessThan(0.1);
    expect(minimumJerk(0.6) - minimumJerk(0.4)).toBeGreaterThan(0.2);
  });

  it("repeats for a seed and varies between seeds", () => {
    const first = Array.from({ length: 5 }, motionRandom(42));
    expect(Array.from({ length: 5 }, motionRandom(42))).toEqual(first);
    expect(Array.from({ length: 5 }, motionRandom(43))).not.toEqual(first);
    expect(first.every(value => value >= 0 && value < 1)).toBe(true);
  });

  it("bows 2–6% of the distance, starts and ends where it should, and lands on target after any correction", () => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    for (let seed = 1; seed <= 200; seed++) {
      const travel = planHumanTravel(from, to, motionRandom(seed));
      expect(Math.abs(travel.bend)).toBeGreaterThanOrEqual(0.02 * distance - 0.001);
      expect(Math.abs(travel.bend)).toBeLessThanOrEqual(0.06 * distance + 0.001);
      expect(humanTravelPoint(from, travel, 0)).toEqual(from);
      expect(humanTravelPoint(from, travel, 1)).toEqual(travel.through);
      const miss = Math.hypot(travel.through.x - to.x, travel.through.y - to.y);
      if (travel.correctionMs === 0) expect(miss).toBe(0);
      else {
        expect(miss).toBeLessThanOrEqual(11);
        expect(travel.correctionMs).toBeGreaterThanOrEqual(120);
        expect(travel.correctionMs).toBeLessThanOrEqual(220);
      }
    }
  });

  it("keeps short hops straight and exact", () => {
    const travel = planHumanTravel({ x: 100, y: 100 }, { x: 150, y: 120 }, motionRandom(7));
    expect(travel).toEqual({ bend: 0, correctionMs: 0, through: { x: 150, y: 120 } });
  });
});

describe("gestures", () => {
  const box = { x: 400, y: 300, width: 200, height: 40 };

  it("loops once around the element from its upper left, and strokes under it left to right", () => {
    const start = circlePoint(box, 12, 0);
    expect(circlePoint(box, 12, 1)).toEqual(start);
    expect(start.x).toBeLessThan(500);
    expect(start.y).toBeLessThan(320);
    // Halfway round it is on the far side, outside the box.
    const half = circlePoint(box, 12, 0.5);
    expect(half.x).toBeGreaterThan(500);
    expect(half.y).toBeGreaterThan(320);
    expect(underlinePoint(box, 0)).toEqual({ x: 400, y: 346 });
    expect(underlinePoint(box, 1)).toEqual({ x: 600, y: 346 });
  });

  it("records each gesture as an emphasis moment framed on the element, without pressing", { timeout: 20_000 }, async () => {
    const protocol = new ProtocolHarness();
    const context = await new WebDriverBrowserDriver(protocol, {
      resolveHostname: async () => ["93.184.216.34"],
    }).createContext(contextOptions()) as unknown as BrowserContextDriver & {
      gesture(kind: string, target: unknown, options?: { rows?: number; text?: string }): Promise<void>;
      semanticTimeline(): Array<{ type: string; element: string; atMs: number; endMs?: number; focus?: unknown }>;
    };
    try {
      await context.goto("https://demo.example.com/dashboard");
      await context.startRecording();
      const before = protocol.calls.length;
      await context.gesture("circle", { type: "coordinate", x: 500, y: 320 });
      await context.gesture("sweep", { type: "coordinate", x: 500, y: 150 }, { rows: 3 });
      const bodies = protocol.calls.slice(before).map(call => JSON.stringify(call.body) ?? "");
      expect(bodies.some(body => body.includes("pointerDown"))).toBe(false);
      const emphasis = context.semanticTimeline().filter(moment => moment.type === "emphasis");
      expect(emphasis.map(moment => moment.element.split(" ")[0])).toEqual(["circle", "sweep"]);
      expect(emphasis[0]!.focus).toEqual({ x: 400 / 1280, y: 300 / 720, width: 200 / 1280, height: 40 / 720 });
      // The sweep frames the rows it ran down, not the element named.
      expect(emphasis[1]!.focus).toEqual({ x: 100 / 1280, y: 100 / 720, width: 800 / 1280, height: 120 / 720 });
      expect(emphasis.every(moment => moment.endMs! > moment.atMs)).toBe(true);
      protocol.rows = [];
      await expect(context.gesture("sweep", { type: "coordinate", x: 500, y: 150 })).rejects.toMatchObject({ code: "no_rows_to_sweep" });
      // A highlight runs the cursor across the passage and grows the selection under it, without pressing.
      const before2 = protocol.calls.length;
      await context.gesture("highlight", { type: "coordinate", x: 300, y: 410 }, { text: "most populous country" });
      const calls2 = protocol.calls.slice(before2).map(call => JSON.stringify(call.body) ?? "");
      expect(calls2.some(body => body.includes("pointerDown"))).toBe(false);
      const fractions = protocol.calls.slice(before2).map(call => (call.body as { args?: unknown[] } | undefined)?.args)
        .filter(args => args?.[2] === "select").map(args => Number(args![3]));
      expect(fractions.length).toBeGreaterThan(3);
      expect(fractions.at(-1)).toBe(1);
      expect(fractions.every((value, index) => index === 0 || value >= fractions[index - 1]!)).toBe(true);
      expect(context.semanticTimeline().at(-1)).toMatchObject({ type: "emphasis", focus: { x: 200 / 1280, y: 400 / 720 } });
      protocol.passage = { missing: true };
      await expect(context.gesture("highlight", { type: "coordinate", x: 300, y: 410 }, { text: "absent" })).rejects.toMatchObject({ code: "text_to_highlight_not_found" });
    } finally {
      await context.dispose();
    }
  });
});
