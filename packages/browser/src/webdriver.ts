import { getDomain } from "tldts";
import { smoothScrollScript } from "./smooth-scroll.js";
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { browserProcessEnvironment } from './process-environment.js';
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  type BrowserRefDriver,
  type BrowserTarget,
  type CoordinateTarget,
  findElementsScript,
  maximumPageReadCharacters,
  type PageReadFilter,
  type PointerKind,
  pageTextScript,
  readPageScript,
  refAttribute,
  type ScrollDirection,
  StaleRefError,
  scrollStateScript,
} from "./browser-toolset.js";
import { isPublicNetworkAddress } from "./host-policy.js";
import {
  AGENT_OBSERVATION_NAME,
  assertLocatorAllowed,
  assertStorageStateAllowed,
  type BrowserContextDriver,
  type BrowserContextOptions,
  type BrowserDriver,
  type BrowserStorageState,
  type CaptureArtifact,
  type CaptureLocator,
  type CapturePointer,
  type CapturePointerSample,
  type CapturePointerShape,
  CapturePolicyError,
  type CaptureSemanticAction,
  CaptureSessionError,
  type ComputerAction,
  normalizeAllowedOrigin,
  storageStateForAllowedOrigins,
} from "./index.js";
import {
  CdpScreencastRecorder,
  FfmpegStreamingEncoder,
  frameHash,
  type StreamingVideoEncoder,
} from "./screencast.js";

/**
 * Rectangles of the email addresses visible in the viewport: in text, and in field values (an email input the user
 * filled). Fractions of the viewport; open shadow roots and same-origin frames included. Never returns the text.
 */
const identityRectsScript = `
const pattern=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, out=[], vw=innerWidth, vh=innerHeight;
const push=(r,dx,dy)=>{const x=(r.left+dx)/vw,y=(r.top+dy)/vh,w=r.width/vw,h=r.height/vh;if(w>0&&h>0&&x<1&&y<1&&x+w>0&&y+h>0)out.push({x:Math.max(0,x),y:Math.max(0,y),width:Math.min(1,x+w)-Math.max(0,x),height:Math.min(1,y+h)-Math.max(0,y)});};
const visit=(root,dx,dy)=>{
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node&&out.length<60;node=walker.nextNode()){
    const text=node.nodeValue;if(!text||text.indexOf('@')<0)continue;
    const style=node.parentElement&&getComputedStyle(node.parentElement);if(style&&(style.visibility==='hidden'||style.display==='none'))continue;
    pattern.lastIndex=0;for(const match of text.matchAll(pattern)){const range=document.createRange();range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);
      for(const r of range.getClientRects())push(r,dx,dy);}
  }
  for(const field of root.querySelectorAll('input,textarea')){const v=field.value||'';pattern.lastIndex=0;const filled=v.indexOf('@')>=0&&pattern.test(v);pattern.lastIndex=0;if(filled)push(field.getBoundingClientRect(),dx,dy);}
  for(const el of root.querySelectorAll('*')){if(el.shadowRoot)visit(el.shadowRoot,dx,dy);
    if(el.tagName==='IFRAME'){try{const doc=el.contentDocument;if(doc&&doc.body){const r=el.getBoundingClientRect();visit(doc.body,dx+r.left,dy+r.top);}}catch{}}}
};
if(document.body)visit(document.body,0,0);
return out;`;

const elementKey = "element-6066-11e4-a52e-4f735466cecf";
/** How long the pointer takes to travel to a target. Long enough to read, short enough not to bore. */
const pointerTravelMs = 550;
/**
 * Typing cadence while the camera is running.
 *
 * WebDriver's element/value endpoint sets the whole string in one go, which on camera is a field
 * that fills in a single frame — the one thing no human does. These are per-character key events
 * with a jittered gap, because a perfectly even cadence reads as machine-generated too.
 */
const typeCharacterMs = 95;
const typeJitterMs = 75;
/** Interval between interpolated pointer positions, near display rate. */
const pointerStepMs = 16;
/** The beat after a travel that lets hover styling register. */
const travelPauseMs = 160;
/**
 * The extra beat before pressing a target that opens a new shot (far from the last press, or long after it).
 * The renderer's camera needs about a second to reach a new framing; a press right after a 550ms travel landed
 * before it arrived. The values mirror render-contract's shot grouping (`sameShotRadius`, `sameShotGapMs`).
 */
const newShotHoldMs = 700;
const newShotRadius = 0.33;
const newShotGapMs = 9_000;

/** Whether a press at `target` starts a new shot after `previous`, in viewport fractions as the renderer groups them. */
export function opensNewShot(
  previous: { x: number; y: number; atMs: number } | null,
  target: { x: number; y: number },
  viewport: { width: number; height: number },
  nowMs: number,
): boolean {
  if (!previous) return true;
  const dx = (target.x - previous.x) / Math.max(1, viewport.width);
  const dy = (target.y - previous.y) / Math.max(1, viewport.height);
  return Math.hypot(dx, dy) > newShotRadius || nowMs - previous.atMs > newShotGapMs;
}

/**
 * The click target and the panel it sits in. The panel is the widest ancestor still at most half the viewport and at
 * least four times the target: the card, form or filter list a viewer reads as one place, never the page itself.
 */
const containerScript = `const e=arguments[0],p=arguments[1],r=e.getBoundingClientRect(),W=innerWidth,H=innerHeight,a=r.width*r.height;
let c=null;for(let n=e.parentElement;n&&n!==document.body&&n!==document.documentElement;n=n.parentElement){const q=n.getBoundingClientRect(),s=q.width*q.height;if(s>W*H*0.5)break;if(s>=a*4)c=q;}
return {x:(p?.x??(r.left+r.width/2))/W,y:(p?.y??(r.top+r.height/2))/H,w:r.width/W,h:r.height/H,cursor:getComputedStyle(e).cursor,
c:c&&{x:Math.max(0,c.left)/W,y:Math.max(0,c.top)/H,w:(Math.min(W,c.right)-Math.max(0,c.left))/W,h:(Math.min(H,c.bottom)-Math.max(0,c.top))/H}};`;

/** The measured panel as `CapturePointer.container`, or nothing when it is missing or off screen. */
export function containerFrom(raw: unknown): { container: NonNullable<CapturePointer["container"]> } | undefined {
  if (!isObject(raw)) return undefined;
  const [x, y, width, height] = [raw.x, raw.y, raw.w, raw.h].map(value => typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
  if (![x, y, width, height].every(Number.isFinite) || !(width! > 0 && height! > 0) || x! >= 1 || y! >= 1) return undefined;
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
  return { container: { x: round(x!), y: round(y!), width: round(width!), height: round(height!) } };
}
/** Cap on retained telemetry samples, so a long capture cannot grow without bound. */
const maximumTelemetrySamples = 20_000;
const maximumRecordingBytes = 256 * 1024 * 1024;
const maximumVideoBytes = 50 * 1024 * 1024;

/**
 * Every spelling the computer-use model uses for a key, mapped to its WebDriver code.
 *
 * Deliberately generous with aliases. An unrecognised key is refused, and refusing one key aborts
 * the whole capture — so a model that says "Return" where the table said "ENTER", or "Control" where
 * it said "CTRL", costs an entire recording. The aliases add no capability: they name keys already
 * permitted, in the other words for them.
 */
const webdriverKeys: Record<string, string> = {
  ALT: "\uE00A",
  ARROWDOWN: "\uE015",
  ARROWLEFT: "\uE012",
  ARROWRIGHT: "\uE014",
  ARROWUP: "\uE013",
  BACKSPACE: "\uE003",
  CMD: "\uE03D",
  COMMAND: "\uE03D",
  CONTROL: "\uE009",
  CTRL: "\uE009",
  DELETE: "\uE017",
  DEL: "\uE017",
  DOWN: "\uE015",
  END: "\uE010",
  ENTER: "\uE007",
  ESC: "\uE00C",
  ESCAPE: "\uE00C",
  HOME: "\uE011",
  INSERT: "\uE016",
  LEFT: "\uE012",
  META: "\uE03D",
  OPTION: "\uE00A",
  PAGEDOWN: "\uE00F",
  PAGEUP: "\uE00E",
  PGDN: "\uE00F",
  PGUP: "\uE00E",
  RETURN: "\uE007",
  RIGHT: "\uE014",
  SHIFT: "\uE008",
  SPACE: " ",
  SPACEBAR: " ",
  SUPER: "\uE03D",
  TAB: "\uE004",
  UP: "\uE013",
  WIN: "\uE03D",
  ...Object.fromEntries(
    // F1 is \uE031 and the function keys run consecutively from there.
    Array.from({ length: 12 }, (_unused, index) => [
      `F${index + 1}`,
      String.fromCharCode(0xe031 + index),
    ]),
  ),
};

type JsonObject = Record<string, unknown>;

export interface WebDriverTransport {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown>;
}

export class WebDriverProtocolError extends Error {
  constructor(
    readonly code: string,
    message = "WebDriver command failed",
  ) {
    super(message);
    this.name = "WebDriverProtocolError";
  }
}

export class FetchWebDriverTransport implements WebDriverTransport {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly fetchImplementation: typeof fetch = fetch,
    readonly commandTimeoutMs = 30_000,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.commandTimeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as JsonObject;
    const value = payload.value;
    if (!response.ok || (isObject(value) && typeof value.error === "string")) {
      const errorValue = isObject(value) ? value : payload;
      throw new WebDriverProtocolError(
        typeof errorValue.error === "string" ? errorValue.error : `http_${response.status}`,
      );
    }
    return value;
  }
}

export interface VideoEncoder {
  encodePngFrames(frames: Uint8Array[], framesPerSecond: number): Promise<Uint8Array>;
}

export class FfmpegVideoEncoder implements VideoEncoder {
  constructor(
    readonly executable = "ffmpeg",
    readonly timeoutMs = 30_000,
  ) {}

  async encodePngFrames(frames: Uint8Array[], framesPerSecond: number): Promise<Uint8Array> {
    if (frames.length === 0) throw new Error("video_has_no_frames");
    return new Promise<Uint8Array>((resolve, reject) => {
      const process = spawn(
        this.executable,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "image2pipe",
          "-framerate",
          String(framesPerSecond),
          "-i",
          "pipe:0",
          "-an",
          "-c:v",
          "libvpx-vp9",
          "-pix_fmt",
          "yuv420p",
          "-deadline",
          "realtime",
          "-cpu-used",
          "8",
          "-f",
          "webm",
          "pipe:1",
        ],
        { env: browserProcessEnvironment(), stdio: ["pipe", "pipe", "ignore"] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(new Uint8Array(Buffer.concat(chunks)));
      };
      const timer = setTimeout(() => {
        process.kill("SIGKILL");
        finish(new Error("video_encoding_timeout"));
      }, this.timeoutMs);
      process.on("error", (error) => finish(error));
      process.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maximumVideoBytes) {
          process.kill("SIGKILL");
          finish(new Error("video_output_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      process.on("close", (code) => {
        if (code !== 0) finish(new Error("video_encoding_failed"));
        else finish();
      });
      for (const frame of frames) process.stdin.write(frame);
      process.stdin.end();
    });
  }
}

type WebDriverOptions = {
  browserName?: string;
  /**
   * Browser executable, for a driver that cannot find one on its own.
   *
   * A grid image ships its browser and needs nothing here. A chromedriver running on a developer's
   * machine refuses to start without it unless Chrome sits in the one place it looks — and a
   * machine with only Chrome for Testing, which is what the render side already uses, is not that
   * place. Naming it is also what keeps capture and render on the same build.
   */
  chromeBinary?: string;
  chromeArguments?: string[];
  videoEncoder?: VideoEncoder;
  streamingVideoEncoder?: StreamingVideoEncoder;
  recordingFrameRate?: number;
  /**
   * Device pixels per CSS pixel the screencast is asked for: the viewport stays the same and the recording is this
   * many times larger on each side. Only worth more than 1 when the browser renders that densely (a transport set
   * to the same device scale). Defaults to 1.
   */
  captureScale?: number;
  now?: () => Date;
  resolveHostname?: (hostname: string) => Promise<string[]>;
};

/**
 * Chromedriver reports the loopback DevTools endpoint of the session it just started. Its presence
 * is what upgrades recording from a screenshot poll to a real screencast.
 */
export function debuggerAddressOf(capabilities: unknown): string | null {
  if (!isObject(capabilities)) return null;
  const chromeOptions = capabilities["goog:chromeOptions"];
  if (!isObject(chromeOptions)) return null;
  const address = chromeOptions.debuggerAddress;
  return typeof address === "string" && address.length > 0 ? address : null;
}

export class WebDriverBrowserDriver implements BrowserDriver {
  readonly browserName: string;
  readonly chromeBinary: string | undefined;
  readonly chromeArguments: string[];
  readonly videoEncoder: VideoEncoder;
  readonly streamingVideoEncoder: StreamingVideoEncoder;
  readonly recordingFrameRate: number;
  readonly captureScale: number;
  readonly now: () => Date;
  readonly resolveHostname: (hostname: string) => Promise<string[]>;

  constructor(
    readonly transport: WebDriverTransport,
    options: WebDriverOptions = {},
  ) {
    this.browserName = options.browserName ?? "chrome";
    this.chromeBinary = options.chromeBinary;
    this.chromeArguments = options.chromeArguments ?? [];
    this.videoEncoder = options.videoEncoder ?? new FfmpegVideoEncoder();
    this.streamingVideoEncoder = options.streamingVideoEncoder ?? new FfmpegStreamingEncoder();
    this.recordingFrameRate = options.recordingFrameRate ?? 30;
    this.captureScale = options.captureScale ?? 1;
    if (!(Number.isFinite(this.captureScale) && this.captureScale >= 1 && this.captureScale <= 3)) throw new RangeError("captureScale must be between 1 and 3");
    this.now = options.now ?? (() => new Date());
    this.resolveHostname =
      options.resolveHostname ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map((x) => x.address));
  }

  async createContext(
    options: BrowserContextOptions,
  ): Promise<BrowserContextDriver & BrowserRefDriver & Pick<WebDriverContext, "connectWithCredentials">> {
    const allowedHosts = options.allowedOrigins.map((origin) => new URL(origin).hostname);
    const hostRules: string[] = [];
    for (const host of allowedHosts) {
      const isLocalDevelopmentHost = host === "localhost" || host === "127.0.0.1";
      let addresses: string[] = [];
      try {
        addresses = isLocalDevelopmentHost ? ["127.0.0.1"] : await this.resolveHostname(host);
      } catch {
        // ENOTFOUND is not a policy refusal. Optional recipe origins such as
        // protect.clerk.com often have no A record; skip the pin and keep going.
      }
      const privateAddress = addresses.find((address) => !isPublicNetworkAddress(address));
      if (addresses.length > 0 && !isLocalDevelopmentHost && privateAddress) {
        /**
         * Name the host and the address it resolved to.
         *
         * This refusal and "the URL is outside the recipe's origins" were both bare
         * `navigation_blocked`, and they call for opposite responses: one is a recipe to rebuild,
         * the other is a resolver answering with a private address — a VPN or split-horizon DNS,
         * where nothing about the recipe is wrong. Told apart only by the reason carried here.
         */
        throw new CapturePolicyError("navigation_blocked", `${host} resolved to ${privateAddress}`);
      }
      const address = addresses.find((candidate) => isIP(candidate) === 4) ?? addresses[0];
      if (address) hostRules.push(`MAP ${host} ${address}`);
    }
    const safeArguments = [
      // Headed on the grid's Xvfb. Headless Chrome is what Cloudflare Turnstile
      // classifies as a bot, and the recording becomes a 5s security interstitial.
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=DnsOverHttps",
      "--disable-blink-features=AutomationControlled",
      "--disable-popup-blocking=false",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      // Pin listed hosts to the addresses we already checked (no private
      // rebinding). Do not MAP * ~NOTFOUND: Clerk, Turnstile, and the product
      // API load hostnames the recipe cannot enumerate in production.
      ...(hostRules.length > 0 ? [`--host-resolver-rules=${hostRules.join(", ")}`] : []),
      `--window-size=${options.viewport.width},${options.viewport.height}`,
      ...this.chromeArguments,
    ];
    // Hosted service owns this scratch root under its exclusive volume lock.
    // Remote-grid library users leave it unset because local paths do not apply there.
    const profile = process.env.RECORDER_SCRATCH_DIR
      ? await mkdtemp(join(process.env.RECORDER_SCRATCH_DIR,'recorder-browser-')) : undefined;
    if(profile) safeArguments.push(`--user-data-dir=${profile}`);
    const response = await this.transport.request("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: this.browserName,
          acceptInsecureCerts: false,
          "goog:chromeOptions": {
            args: safeArguments,
            ...(this.chromeBinary ? { binary: this.chromeBinary } : {}),
            excludeSwitches: ["enable-automation"],
            prefs: {
              "download.prompt_for_download": true,
              download_restrictions: 3,
              "profile.default_content_setting_values.notifications": 2,
            },
          },
        },
      },
    }).catch(async error => { if(profile) await rm(profile,{recursive:true,force:true}); throw error; });
    if (!isObject(response) || typeof response.sessionId !== "string") {
      if(profile) await rm(profile,{recursive:true,force:true});
      throw new WebDriverProtocolError("invalid_session_response");
    }
    const context = new WebDriverContext(
      this.transport,
      response.sessionId,
      options,
      this.videoEncoder,
      this.now,
      debuggerAddressOf(response.capabilities),
      this.streamingVideoEncoder,
      this.recordingFrameRate,
      profile,
      this.captureScale,
    );
    try {
      await context.initialize();
      return context;
    } catch (error) {
      await context.dispose().catch(() => undefined);
      throw error;
    }
  }
}

type TraceEntry = {
  at: string;
  operation: string;
  origin?: string;
  status: "succeeded" | "failed";
};

class WebDriverContext implements BrowserContextDriver, BrowserRefDriver {
  readonly basePath: string;
  readonly trace: TraceEntry[] = [];
  authenticationFlowActive = false;
  /** True after a navigation that landed on a non-login page. A later bounce
   * back to sign-in is a dead session; the first bounce is just "please log in". */
  sawApplicationPage = false;
  recordingFrames: Uint8Array[] | null = null;
  recordingFrameTimes: number[] = [];
  recordingBytes = 0;
  recordingFailure: Error | null = null;
  screencast: CdpScreencastRecorder | null = null;
  recordingStartedAtMs: number | null = null;
  private lastRecordedRoute: string | undefined;
  /**
   * Which of the two recorders actually ran.
   *
   * The poll is a working recording at four frames a second, which is a slideshow rather than a
   * demo — and it is chosen silently, whenever the DevTools address is unreachable. A caller that
   * cannot see which one it got has no way to know its footage is unusable until it watches it.
   */
  recordingMode: "screencast" | "poll" | null = null;
  /** The last observation's image next to the page it was taken of, for mapping coordinates back. */
  observationSize: {
    width: number;
    height: number;
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    scrollHeight: number;
  } | null = null;
  readonly pointers: CapturePointer[] = [];
  readonly telemetry: CapturePointerSample[] = [];
  readonly driverTelemetry: CapturePointerSample[] = [];
  private readonly identityReads: Array<{ atMs: number; rects: Array<{ x: number; y: number; width: number; height: number }> }> = [];
  private driverShape: CapturePointerShape = "arrow";
  private viewportSize = { width: 1_280, height: 720 };
  readonly semanticActions: CaptureSemanticAction[] = [];
  /** Last commanded pointer position, in viewport pixels, so travel starts where it stopped. */
  pointerAt: { x: number; y: number } | null = null;
  /** Where and when the last recorded press landed, to tell a press inside the current shot from one that opens a new one. */
  private lastPress: { x: number; y: number; atMs: number } | null = null;
  recordingTimer: ReturnType<typeof setInterval> | undefined;
  recordingCapturePending = false;
  redirectCount = 0;
  disposed = false;
  /** Clerk's identifier Continue stays in the DOM on the password screen.
   * Enter already submits the password; clicking the first primary button
   * re-fires the identifier step and the session never leaves /sign-in. */
  passwordSubmitSent = false;
  /** Cookie restore may bounce through marketing and login. That is not a dead session. */
  hydrating = false;

  constructor(
    readonly transport: WebDriverTransport,
    readonly sessionId: string,
    readonly options: BrowserContextOptions,
    readonly videoEncoder: VideoEncoder,
    readonly now: () => Date,
    readonly debuggerAddress: string | null = null,
    readonly streamingVideoEncoder: StreamingVideoEncoder = new FfmpegStreamingEncoder(),
    readonly recordingFrameRate = 30,
    readonly profileDirectory: string | undefined = undefined,
    readonly captureScale = 1,
  ) {
    this.basePath = `/session/${encodeURIComponent(sessionId)}`;
  }

  async initialize(): Promise<void> {
    await this.resizeViewport();
    const decoded = new TextDecoder().decode(this.options.sessionState);
    let rawState: unknown;
    try {
      rawState = JSON.parse(decoded);
    } catch {
      throw new CaptureSessionError("reauth_required");
    }
    const state = assertStorageStateAllowed(
      rawState as BrowserStorageState,
      this.options.allowedOrigins,
    );
    this.hydrating = true;
    try {
      await this.hydrateStorageState(state);
    } finally {
      this.hydrating = false;
    }
  }

  private async resizeViewport(): Promise<void> {
    const requested = this.options.viewport;
    let outer = { ...requested };
    let measured = {width:0,height:0};
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.command("window_rect", () =>
        this.transport.request("POST", `${this.basePath}/window/rect`, outer),
      );
      const inner = await this.executeScript(
        "viewport_size",
        "return {width:window.innerWidth,height:window.innerHeight};",
        [],
      );
      if (!isObject(inner)) throw new WebDriverProtocolError("invalid_viewport_response");
      const width = numeric(inner.width, 0);
      const height = numeric(inner.height, 0);
      measured={width,height};
      if (width === requested.width && height === requested.height) return;

      const current = await this.command("window_rect", () =>
        this.transport.request("GET", `${this.basePath}/window/rect`),
      );
      if (!isObject(current)) throw new WebDriverProtocolError("invalid_window_rect_response");
      outer = {
        width: numeric(current.width, outer.width) + requested.width - width,
        height: numeric(current.height, outer.height) + requested.height - height,
      };
    }
    if(this.options.fitViewportToWindow && measured.width>=640 && measured.height>=360){
      Object.assign(this.options.viewport,measured);
      return;
    }
    throw new WebDriverProtocolError("viewport_size_mismatch");
  }

  async goto(url: string): Promise<void> {
    this.passwordSubmitSent = false;
    await this.switchToTop();
    const current = await this.command("current_url", () =>
      this.transport.request("GET", `${this.basePath}/url`),
    );
    if (
      typeof current === "string" &&
      sameOrigin(current, url) &&
      isOriginRoot(url) &&
      !isAuthenticationUrl(current)
    ) {
      // Already on the signed-in origin. Reloading the apex is how Cloudflare
      // puts a confirmation page in front of a session that just landed.
      this.options.onNavigation(current, this.redirectCount);
      return;
    }
    this.options.onNavigation(url, this.redirectCount);
    await this.command("navigate", () =>
      this.transport.request("POST", `${this.basePath}/url`, { url }),
    );
    await this.verifyNavigation(url);
    this.recordSemanticAction("navigate", null, "page");
  }

  async click(locator: CaptureLocator): Promise<void> {
    if (isLoginField(locator) && (await this.loginStepAlreadyPassed(locator))) return;
    if (locator.strategy === "field" && locator.value === "submit" && this.passwordSubmitSent) {
      return;
    }
    const element = await this.findElementReady(locator);
    const semanticElement = await this.describeSemanticElement(element);
    await this.scrollIntoViewSmoothly(element);
    const moved = this.recordingStartedAtMs === null ? false : await this.movePointerTo(element);
    await this.recordPointer(element);
    if (moved) {
      // A press that opens a new shot waits for the camera to get there; one inside the current shot does not.
      if (this.pointerAt && opensNewShot(this.lastPress, this.pointerAt, this.viewportSize, Date.now())) {
        await delay(newShotHoldMs);
      }
      if (this.pointerAt) this.lastPress = { ...this.pointerAt, atMs: Date.now() };
      this.recordPress();
      // Press and release where the pointer already is, rather than the element click command,
      // which would jump the pointer to the target and undo the travel just recorded.
      await this.command("click", () =>
        this.transport.request("POST", `${this.basePath}/actions`, {
          actions: [
            {
              type: "pointer",
              id: "mouse",
              parameters: { pointerType: "mouse" },
              actions: [
                { type: "pointerDown", button: 0 },
                { type: "pause", duration: 90 },
                { type: "pointerUp", button: 0 },
              ],
            },
          ],
        }),
      );
    } else {
      await this.command("click", () =>
        this.transport.request("POST", `${this.basePath}/element/${element}/click`, {}),
      );
    }
    this.recordSemanticAction("click", null, semanticElement);
    // An in-page anchor jumps the viewport instantly. Let the smooth scroll it triggers play out,
    // otherwise the recording cuts straight to the destination.
    if (this.recordingStartedAtMs !== null) await this.settleScroll();
    await this.verifyNavigation();
    // A navigation discards the page-side buffer, so it is drained and reinstalled around one.
    if (this.recordingStartedAtMs !== null) {
      await this.drainTelemetry();
      await this.installTelemetryCollector();
    }
  }

  /**
   * Travels the pointer to an element instead of arriving at it.
   *
   * A recording where the pointer only exists at click instants reads as synthetic, and hover states
   * never fire. `pointerMove` with a duration makes the browser emit intermediate `mousemove` events
   * along the way, which is both what a viewer sees and what the renderer's cursor smoothing needs.
   *
   * Outside a recording, move directly without the presentation pauses.
   */
  private async movePointerTo(element: string, point?: { x: number; y: number }): Promise<boolean> {
    const centre = await this.executeScript(
      "element_centre",
      "const e=arguments[0],r=e.getBoundingClientRect();let c='default';try{c=getComputedStyle(e).cursor}catch{}return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:window.innerWidth,h:window.innerHeight,c};",
      [{ [elementKey]: element }],
    );
    if (!isObject(centre)) throw new WebDriverProtocolError("invalid_pointer_target");
    this.viewportSize = { width: numeric(centre.w, 1_280), height: numeric(centre.h, 720) };
    const arrivalShape = pointerShapeFor(centre.c);
    const targetX = point?.x ?? numeric(centre.x, Number.NaN);
    const targetY = point?.y ?? numeric(centre.y, Number.NaN);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || targetX < 0 || targetY < 0) {
      throw new WebDriverProtocolError("invalid_pointer_target");
    }
    this.assertPoint(targetX, targetY);

    const from = this.pointerAt ?? {
      x: Math.round(numeric(centre.w, 1_280) / 2),
      y: Math.round(numeric(centre.h, 720) / 2),
    };

    const move = (x: number, y: number) =>
      this.transport.request("POST", `${this.basePath}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [{ type: "pointerMove", origin: "viewport", x, y, duration: 0 }],
          },
        ],
      });
    if (this.recordingStartedAtMs === null) {
      await this.command("pointer_move", () => move(targetX, targetY));
      this.pointerAt = { x: targetX, y: targetY };
      await this.drainTelemetry();
      return true;
    }

    /**
     * Stepped here rather than by handing the driver one long move: ChromeDriver satisfies a move's
     * duration with only a handful of intermediate events, which is neither a path to smooth nor
     * motion a viewer reads as a hand.
     *
     * Every step is placed by the clock, not by its index. A driver delivers each move and waits for
     * the page to take it, and a heavy page (Notion re-rendering a board) takes anything from one
     * frame to several. Counting steps let those waits add up to twice the travel, which renders as
     * a cursor dragging toward its target; reading the clock makes a slow page cost smoothness
     * (fewer, longer steps) instead of time.
     */
    const travelMs = Math.min(
      1_200,
      pointerTravelMs + Math.hypot(targetX - from.x, targetY - from.y) * 0.5,
    );
    await this.command("pointer_move", async () => {
      const startedAt = performance.now();
      const maximumSteps = Math.ceil(travelMs / pointerStepMs) * 2;
      let at = from;
      for (let step = 0; ; step++) {
        const stepStartedAt = performance.now();
        const progress =
          step >= maximumSteps ? 1 : Math.min(1, (stepStartedAt - startedAt) / travelMs);
        const eased = progress * progress * (3 - 2 * progress);
        const next = {
          x: Math.round(from.x + (targetX - from.x) * eased),
          y: Math.round(from.y + (targetY - from.y) * eased),
        };
        if (next.x !== at.x || next.y !== at.y || progress === 1) {
          await move(next.x, next.y);
          this.recordDriverSample(next.x, next.y, "move", progress === 1 ? arrivalShape : this.driverShape);
        }
        at = next;
        if (progress === 1) break;
        await delay(Math.max(0, pointerStepMs - (performance.now() - stepStartedAt)));
      }
      // A short beat lets hover styling register without making the cursor trail the intent.
      await delay(travelPauseMs);
    });
    this.pointerAt = { x: targetX, y: targetY };
    this.driverShape = arrivalShape;
    // Save the travel before a click can navigate and destroy the page's event buffer.
    await this.drainTelemetry();
    return true;
  }

  /**
   * Brings the target into view as a scroll rather than a jump, and waits for it to finish.
   *
   * WebDriver scrolls an element into view instantly before clicking it, which in a recording reads
   * as the page teleporting. A real demo scrolls.
   */
  private async scrollIntoViewSmoothly(element: string): Promise<void> {
    if (this.recordingStartedAtMs === null) return;
    try {
      const needsScroll = await this.executeScript(
        "needs_scroll",
        "const r=arguments[0].getBoundingClientRect();return r.top<80||r.bottom>window.innerHeight-80;",
        [{ [elementKey]: element }],
      );
      if (needsScroll !== true) return;
      await this.executeScript(
        "smooth_scroll",
        "arguments[0].scrollIntoView({behavior:'smooth',block:'center'});",
        [{ [elementKey]: element }],
      );
      await this.settleScroll();
    } catch {
      // Falling back to WebDriver's own instant scroll costs smoothness, never the capture.
    }
  }

  /** Polls until the scroll position stops changing, so the recording captures the whole movement. */
  private async settleScroll(timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableReadings = 0;
    while (Date.now() < deadline) {
      const offset = await this.executeScript("scroll_offset", scrollStateScript, []).catch(
        () => null,
      );
      if (typeof offset !== "string") return;
      stableReadings = offset === previous ? stableReadings + 1 : 0;
      // Two identical readings in a row: the animation has stopped rather than paused between frames.
      if (stableReadings >= 2) return;
      previous = offset;
      await delay(80);
    }
  }

  pointerTrail(): CapturePointer[] {
    return [...this.pointers];
  }

  semanticTimeline(): CaptureSemanticAction[] {
    return [...this.semanticActions];
  }

  /** Where email addresses were on screen at each read while recording, for the render to blur. */
  identitySightings(): Array<{ atMs: number; rects: Array<{ x: number; y: number; width: number; height: number }> }> {
    return this.identityReads.map((read) => ({ atMs: read.atMs, rects: read.rects.map((rect) => ({ ...rect })) }));
  }

  /**
   * Notes every visible email address, as fractions of the viewport. A recording that shows an account chooser, a
   * consent screen or a profile menu shows whose account it is (and often other people's); YouTube removes a demo
   * for that alone. Only rectangles leave the page, never the text. Each read also proves an address is gone, which
   * is what lets the render stop blurring once the page changes.
   */
  private async readIdentity(): Promise<void> {
    if (this.recordingStartedAtMs === null) return;
    const startedAt = this.recordingStartedAtMs;
    try {
      const rects = await this.executeScript("identity_rects", identityRectsScript, []);
      if (!Array.isArray(rects)) return;
      const valid = rects.filter((rect): rect is { x: number; y: number; width: number; height: number } =>
        isObject(rect) && [rect.x, rect.y, rect.width, rect.height].every((value) => typeof value === "number" && Number.isFinite(value))
        && (rect.width as number) > 0 && (rect.height as number) > 0).slice(0, 60);
      this.identityReads.push({ atMs: Math.max(0, Date.now() - startedAt), rects: valid });
    } catch {
      // A page between documents has nothing to read; the next read covers it.
    }
  }

  markDemoMoment(kind: "setup" | "action" | "result", note: string, focus?: CaptureSemanticAction["focus"], observedAtMs?: number): void {
    if (this.recordingStartedAtMs === null) return;
    const index = this.semanticActions.length - 1;
    const previous = this.semanticActions[index];
    const element = note
      .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/gu, "[redacted]")
      .replace(/(?:\+?\d[\d ().-]{7,}\d)/gu, "[redacted]")
      .slice(0, 120);
    if (kind === "result") {
      const now = Date.now() - this.recordingStartedAtMs;
      if (observedAtMs !== undefined && (!Number.isFinite(observedAtMs) || observedAtMs < 0 || observedAtMs > now)) throw new Error("invalid_observation_time");
      this.semanticActions.push({ atMs: observedAtMs ?? now, type: kind, ref: null, element,
        focus: focus ?? { x: 0, y: 0, width: 1, height: 1 } });
    } else if (previous) this.semanticActions[index] = { ...previous, type: previous.endMs !== undefined && kind === "action" ? previous.type : kind, element };
  }

  private recordSemanticAction(
    type: CaptureSemanticAction["type"],
    ref: string | null,
    element: string,
  ): void {
    if (this.recordingStartedAtMs === null) return;
    this.semanticActions.push({
      atMs: Math.max(0, Date.now() - this.recordingStartedAtMs),
      type,
      ref,
      element,
    });
  }

  private async describeSemanticElement(element: string): Promise<string> {
    const description = await this.executeScript(
      "semantic_element",
      "const e=arguments[0],role=e.getAttribute('role')||e.tagName.toLowerCase(),name=(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('title')||e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);return name?role+' '+name:role;",
      [{ [elementKey]: element }],
    ).catch(() => "element");
    if (typeof description !== "string") return "element";
    return description
      .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/gu, "[redacted]")
      .replace(/(?:\+?\d[\d ().-]{7,}\d)/gu, "[redacted]")
      .slice(0, 120);
  }

  /**
   * Records where the pointer actually went, from the page's own `mousemove` events.
   *
   * Sampling the events rather than replaying our intended path means the trail reflects the
   * browser's real interpolation, including anything the page did to it. Coordinates are fractions
   * of the viewport for the same reason click positions are: the captured frame is not the requested
   * viewport size.
   */
  private async installTelemetryCollector(): Promise<void> {
    const recordingOffsetMs =
      this.recordingStartedAtMs === null ? 0 : Math.max(0, Date.now() - this.recordingStartedAtMs);
    await this.executeScript(
      "install_telemetry",
      `if (!window.__captureTelemetry) {
         window.__captureTelemetry = [];
         window.__captureTelemetryOffset = arguments[0];
         const record = (event, kind) => {
           if (window.__captureTelemetry.length >= ${maximumTelemetrySamples}) return;
           // The cursor the page is actually showing under the pointer. Read per sample, because the
           // shape belongs to whatever is hovered at that instant, not to the next thing clicked.
           let cursor = 'default';
           try {
             const target = event.target instanceof Element ? event.target : null;
             if (target) cursor = getComputedStyle(target).cursor;
           } catch {}
           window.__captureTelemetry.push({
             atMs: Math.round(performance.now()),
             x: event.clientX / window.innerWidth,
             y: event.clientY / window.innerHeight,
             cursor,
             kind,
           });
         };
         window.__captureTelemetryOrigin = performance.now();
         addEventListener('mousemove', (e) => record(e, 'move'), { capture: true, passive: true });
         addEventListener('mousedown', (e) => record(e, 'down'), { capture: true, passive: true });
         addEventListener('mouseup', (e) => record(e, 'up'), { capture: true, passive: true });
       }`,
      [recordingOffsetMs],
    ).catch(() => undefined);
  }

  /** Reads and clears the page-side buffer, rebasing timestamps onto the recording clock. */
  private async drainTelemetry(): Promise<void> {
    if (this.recordingStartedAtMs === null) return;
    try {
      const drained = await this.executeScript(
        "drain_telemetry",
        `const t = window.__captureTelemetry || [];
         const origin = window.__captureTelemetryOrigin ?? 0;
         const offset = window.__captureTelemetryOffset ?? 0;
         if (window.__captureTelemetry) window.__captureTelemetry = [];
         return { origin, offset, samples: t };`,
        [],
      );
      if (!isObject(drained) || !Array.isArray(drained.samples)) return;
      // A navigation creates a new page clock. Its collector keeps the elapsed recording offset so
      // samples from successive documents stay on one monotonic timeline.
      for (const raw of drained.samples) {
        if (!isObject(raw)) continue;
        const atMs = typeof raw.atMs === "number" ? raw.atMs : Number.NaN;
        const x = typeof raw.x === "number" ? raw.x : Number.NaN;
        const y = typeof raw.y === "number" ? raw.y : Number.NaN;
        const origin = typeof drained.origin === "number" ? drained.origin : 0;
        const offset = typeof drained.offset === "number" ? drained.offset : 0;
        if (!Number.isFinite(atMs) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < 0 || x > 1 || y < 0 || y > 1) continue;
        this.telemetry.push({
          atMs: Math.max(0, Math.round(offset + atMs - origin)),
          x: Math.round(x * 10_000) / 10_000,
          y: Math.round(y * 10_000) / 10_000,
          kind: raw.kind === "down" || raw.kind === "up" ? (raw.kind as "down" | "up") : "move",
          shape: pointerShapeFor(raw.cursor),
        });
      }
    } catch {
      // A lost buffer costs smoothing detail, never the recording.
    }
  }

  /**
   * Where the driver itself put the pointer, step by step, while recording.
   *
   * The page's own mousemove events are lost whenever a navigation replaces the document before its
   * collector is installed (an OAuth redirect, a form post), which left the rendered cursor frozen on
   * the new page and jumping to the next click. The driver knows every position it moves to, on any
   * page, so these samples are the source of truth for the cursor path.
   */
  private recordDriverSample(x: number, y: number, kind: CapturePointerSample["kind"], shape: CapturePointerShape, atMs?: number): void {
    if (this.recordingStartedAtMs === null) return;
    const { width, height } = this.viewportSize;
    if (!(width > 0 && height > 0)) return;
    this.driverTelemetry.push({
      atMs: atMs ?? Math.max(0, Date.now() - this.recordingStartedAtMs),
      x: Math.round(Math.min(1, Math.max(0, x / width)) * 10_000) / 10_000,
      y: Math.round(Math.min(1, Math.max(0, y / height)) * 10_000) / 10_000,
      kind,
      shape,
    });
  }

  /** A press and release at the pointer, offset by `delayMs` for multi-clicks. */
  private recordPress(delayMs = 0, pressedAt = Date.now()): void {
    if (this.recordingStartedAtMs === null || !this.pointerAt) return;
    const at = Math.max(0, pressedAt - this.recordingStartedAtMs) + delayMs;
    this.recordDriverSample(this.pointerAt.x, this.pointerAt.y, "down", this.driverShape, at);
    this.recordDriverSample(this.pointerAt.x, this.pointerAt.y, "up", this.driverShape, at + 90);
  }

  /** Everything the pointer did while recording, in order: the driver's own path when it has one. */
  pointerTelemetry(): CapturePointerSample[] {
    const samples = this.driverTelemetry.length ? this.driverTelemetry : this.telemetry;
    return [...samples].sort((left, right) => left.atMs - right.atMs);
  }

  /**
   * Notes the centre of the element about to be clicked, relative to the start of the recording.
   * Only while recording: outside a recording there is no timeline to place it on.
   *
   * Recorded as a fraction of the viewport, not as pixels. The WebDriver element rect is document
   * coordinates including scroll offset, while the screencast captures the viewport, so a rect from
   * a scrolled page names a point that is not on screen — and the captured frame is shorter than the
   * requested viewport anyway. `getBoundingClientRect` is viewport-relative, and a fraction survives
   * whatever size the frames turn out to be.
   */
  private async recordPointer(element: string, point?: { x: number; y: number }): Promise<void> {
    const measured = await this.measurePointer(element, point);
    if (measured && this.recordingStartedAtMs !== null) {
      this.pointers.push({ ...measured, atMs: Math.max(0, Date.now() - this.recordingStartedAtMs) });
    }
  }

  /** The click target as `recordPointer` notes it, without the time, so it can be measured before the travel. */
  private async measurePointer(element: string, point?: { x: number; y: number }): Promise<Omit<CapturePointer, "atMs"> | undefined> {
    if (this.recordingStartedAtMs === null) return undefined;
    try {
      const measured = await this.executeScript(
        "element_viewport_rect",
        containerScript,
        [{ [elementKey]: element }, point ?? null],
      );
      if (!isObject(measured)) return undefined;
      // Not `numeric`, which floors: every fraction below 1 would collapse to zero.
      const x = typeof measured.x === "number" ? measured.x : Number.NaN;
      const y = typeof measured.y === "number" ? measured.y : Number.NaN;
      // Off-screen elements would drag the zoom to an edge that shows nothing.
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
      return {
        x: Math.round(x * 10_000) / 10_000,
        y: Math.round(y * 10_000) / 10_000,
        // What the page itself says the pointer is, rather than what the element type implies.
        shape: pointerShapeFor(measured.cursor),
        width: Math.min(1, Math.max(0, typeof measured.w === "number" ? measured.w : 0)),
        height: Math.min(1, Math.max(0, typeof measured.h === "number" ? measured.h : 0)),
        ...(containerFrom(measured.c) ?? {}),
      };
    } catch {
      // A missing rect costs a zoom, never the recording.
      return undefined;
    }
  }

  /**
   * Credential-only login path: never skip fields just because a public page has no password box.
   * Without a password (e-mail-only sign-in) the identifier is submitted and the product's code or
   * magic-link step surfaces as additional_verification_required, which completeLoginChallenge finishes.
   */
  async connectWithCredentials(username: string, password: string | undefined, signal: AbortSignal, targetUrl?: string): Promise<void> {
    const pause = async () => { signal.throwIfAborted(); await delay(250); signal.throwIfAborted(); };
    const snapshot = async () => {
      signal.throwIfAborted(); await this.switchToTop();
      return await this.executeScript("connection_evidence", connectionEvidenceScript, []) as {
        signedIn: boolean; rejected: boolean; challenge: boolean; loginLinks: string[];
      };
    };
    const field = async (kind: string) => {
      signal.throwIfAborted();
      try { return await this.findElement({ strategy: 'field', value: kind }); }
      catch (error) {
        if (error instanceof WebDriverProtocolError && error.code === 'element_not_visible') return null;
        throw error;
      }
    };
    // Inspect the actual target, not the fresh browser's blank page.
    if (targetUrl) await this.goto(targetUrl);
    const first = await snapshot();
    if (first.signedIn) return;
    const current = await this.currentUrl();
    const requested = targetUrl ?? current;
    const origin = new URL(requested).origin;
    const candidates = [...new Set([requested, ...first.loginLinks, ...['/entrar', '/sign-in', '/signin', '/login', '/auth/login'].map(path => origin + path)])];
    let blockedLogin: Error | undefined;
    let identifier: string | null = null;
    for (const url of candidates) {
      signal.throwIfAborted();
      if (url !== current) {
        try { await this.goto(url); }
        catch (error) {
          if (error instanceof Error && error.message.startsWith('origin_not_allowed')) { blockedLogin ??= error; continue; }
          throw error;
        }
      }
      for (let i = 0; i < 12; i++) {
        const state = await snapshot();
        if (state.challenge) throw new Error('additional_verification_required');
        // A restored session follows the login link straight into the app.
        if (state.signedIn) { await this.verifyNavigation(); return; }
        identifier = await field('email');
        if (identifier) break;
        await pause();
      }
      if (identifier) break;
    }
    if (!identifier) throw blockedLogin ?? new Error('login_fields_not_found');
    // No more route guesses after submitting an identifier: avoid duplicate sign-in attempts.
    await this.verifyNavigation();
    await this.command('clear_login_identifier', () => this.transport.request('POST', `${this.basePath}/element/${identifier}/clear`, {}));
    await this.typeInto(identifier, username);
    let secret = password === undefined ? null : await field('password');
    if (!secret) {
      const submit = await field('submit');
      if (submit) await this.command('submit_identifier', () => this.transport.request('POST', `${this.basePath}/element/${submit}/click`, {}));
      else {
        identifier = await field('email');
        if (!identifier) throw new Error('login_fields_not_found');
        await this.typeInto(identifier, "\uE007");
      }
      for (let i = 0; i < (password === undefined ? 20 : 60); i++) {
        const state = await snapshot();
        if (state.rejected) throw new Error('invalid_credentials');
        if (state.challenge) throw new Error('additional_verification_required');
        if (state.signedIn) { await this.verifyNavigation(); return; }
        if (password === undefined) { await pause(); continue; }
        secret = await field('password');
        if (secret) break;
        await this.revealPasswordStrategy();
        await pause();
      }
    }
    if (!secret || password === undefined) throw new Error('additional_verification_required');
    signal.throwIfAborted();
    await this.verifyNavigation();
    await this.command('clear_login_password', () => this.transport.request('POST', `${this.basePath}/element/${secret}/clear`, {}));
    await this.typeInto(secret, password);
    await this.typeInto(secret, "\uE007");
    for (let i = 0; i < 120; i++) {
      const state = await snapshot();
      if (state.rejected) throw new Error('invalid_credentials');
      if (state.challenge) throw new Error('additional_verification_required');
      if (state.signedIn) { await this.verifyNavigation(); return; }
      await pause();
    }
    throw new Error('login_not_confirmed');
  }

  /** Finish a sign-in that stopped at a one-time code or magic link; the value comes from the user, never from the agent. */
  async completeLoginChallenge(input: { code?: string; link?: string }, signal: AbortSignal): Promise<void> {
    const pause = async () => { signal.throwIfAborted(); await delay(250); signal.throwIfAborted(); };
    const snapshot = async () => {
      signal.throwIfAborted(); await this.switchToTop();
      return await this.executeScript("connection_evidence", connectionEvidenceScript, []) as { signedIn: boolean; rejected: boolean; challenge: boolean };
    };
    if (input.link) {
      await this.goto(input.link);
    } else if (input.code) {
      let field: string | null = null;
      for (let i = 0; i < 12 && !field; i++) {
        signal.throwIfAborted();
        try { field = await this.findElement({ strategy: 'field', value: 'code' }); }
        catch (error) { if (!(error instanceof WebDriverProtocolError && error.code === 'element_not_visible')) throw error; }
        if (!field) await pause();
      }
      if (!field) throw new Error('verification_field_not_found');
      await this.command('clear_verification_code', () => this.transport.request('POST', `${this.basePath}/element/${field}/clear`, {}));
      await this.typeInto(field, input.code);
      await this.typeInto(field, ENTER_KEY);
    } else throw new Error('verification_input_required');
    for (let i = 0; i < 120; i++) {
      const state = await snapshot();
      if (state.rejected) throw new Error('invalid_verification_code');
      if (state.signedIn) { await this.verifyNavigation(); return; }
      await pause();
    }
    const last = await snapshot();
    throw new Error(last.challenge ? 'invalid_verification_code' : 'login_not_confirmed');
  }

  async fill(locator: CaptureLocator, value: string): Promise<void> {
    if (isLoginField(locator) && (await this.loginStepAlreadyPassed(locator))) return;
    let element: string;
    try {
      element = await this.findElementReady(locator);
    } catch (error) {
      /**
       * The session can come back while the form is still on screen.
       *
       * waitFor sees the identifier, Clerk then restores the stored session and navigates into the
       * product, and this step spends its retry budget hunting a field that has gone for good — a
       * resumed login failing as element_not_visible. Re-asking whether the step is already behind
       * us turns that race into the skip it should have been.
       */
      if (
        isLoginField(locator) &&
        error instanceof WebDriverProtocolError &&
        error.code === "element_not_visible" &&
        (await this.loginStepAlreadyPassed(locator))
      ) {
        return;
      }
      throw error;
    }
    const password = locator.strategy === "field" && locator.value === "password";
    if (!password) {
      await this.command("clear", () =>
        this.transport.request("POST", `${this.basePath}/element/${element}/clear`, {}),
      );
    }
    let target = element;
    try {
      await this.typeInto(element, value);
    } catch (error) {
      if (!password) throw error;
      const fallback = (await this.findActivePassword()) ?? element;
      target = fallback;
      try {
        await this.typeInto(fallback, value);
      } catch {
        await this.executeScript(
          "fill_password",
          "const e=arguments[0],v=arguments[1];e.focus();const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');if(d&&d.set)d.set.call(e,v);else e.value=v;e.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertFromPaste',data:v}));e.dispatchEvent(new Event('change',{bubbles:true}));",
          [{ [elementKey]: fallback }, value],
        );
      }
    }
    if (password) {
      // Clerk submits the password screen on Enter. Clicking the shared
      // primary button can re-hit the identifier Continue instead.
      await delay(200);
      this.passwordSubmitSent = true;
      await this.typeInto(target, "\uE007");
    }
  }

  /**
   * Types a value the way the recording should show it being typed.
   *
   * Only while recording: before the camera starts, a login has nothing to demonstrate and the
   * slower path would just make every run longer. Credential fills keep using `typeInto` for the
   * same reason, and because their value is masked anyway.
   */
  private async typeHumanly(element: string, text: string): Promise<void> {
    if (this.recordingStartedAtMs === null || text.length === 0) {
      await this.typeInto(element, text);
      return;
    }
    if ((await this.activeElement()) !== element) {
      await this.movePointerTo(element);
      await this.recordPointer(element);
      await this.command("focus_before_type", () =>
        this.transport.request("POST", `${this.basePath}/element/${element}/click`, {}),
      );
    }
    const restingPoint = await this.executeScript(
      "typing_pointer_rest",
      "const r=arguments[0].getBoundingClientRect();const x=Math.max(12,Math.min(innerWidth-12,r.right+24));const y=r.bottom+28<innerHeight-12?r.bottom+28:Math.max(12,r.top-28);return {x:Math.round(x),y:Math.round(y)};",
      [{ [elementKey]: element }],
    );
    if (
      isObject(restingPoint) &&
      typeof restingPoint.x === "number" &&
      typeof restingPoint.y === "number"
    ) {
      await this.movePointerTo(element, { x: restingPoint.x, y: restingPoint.y });
    }
    const bounds = await this.executeScript("typing_focus",
      "const r=arguments[0].getBoundingClientRect();return {x:Math.max(0,r.left-32)/innerWidth,y:Math.max(0,r.top-24)/innerHeight,width:Math.min(innerWidth-Math.max(0,r.left-32),r.width+64)/innerWidth,height:Math.min(innerHeight-Math.max(0,r.top-24),r.height+88)/innerHeight};",
      [{ [elementKey]: element }]);
    const focus = isObject(bounds) && [bounds.x, bounds.y, bounds.width, bounds.height].every(v => typeof v === "number" && Number.isFinite(v))
      ? bounds as CaptureSemanticAction["focus"] : undefined;
    const moment: CaptureSemanticAction = { atMs: Date.now() - this.recordingStartedAtMs, type: "type", ref: null, element: "Text input", ...(focus ? { focus } : {}) };
    this.semanticActions.push(moment);
    const actions = [...text].flatMap((character) => [
      { type: "keyDown", value: character },
      { type: "keyUp", value: character },
      {
        type: "pause",
        duration: Math.round(typeCharacterMs + Math.random() * typeJitterMs),
      },
    ]);
    await this.command("type_humanly", () =>
      this.transport.request("POST", `${this.basePath}/actions`, {
        actions: [{ type: "key", id: "keyboard", actions }],
      }),
    );
    moment.endMs = Date.now() - this.recordingStartedAtMs;
  }

  private async typeInto(element: string, text: string): Promise<void> {
    await this.command("fill", () =>
      this.transport.request("POST", `${this.basePath}/element/${element}/value`, { text }),
    );
  }

  async select(locator: CaptureLocator, value: string): Promise<void> {
    const element = await this.findElement(locator);
    await this.executeScript(
      "select",
      "const e=arguments[0],v=arguments[1];const o=[...e.options].find(x=>x.value===v);if(!o)throw new Error('option_not_found');e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));",
      [{ [elementKey]: element }, value],
    );
  }

  async waitFor(locator: CaptureLocator): Promise<void> {
    const signedIn = locator.strategy === "field" && locator.value === "signed_in";
    const loginField = isLoginField(locator);
    if (loginField && (await this.loginStepAlreadyPassed(locator))) return;
    const deadline = Date.now() + (signedIn ? 30_000 : 20_000);
    const password = locator.strategy === "field" && locator.value === "password";
    let sawChallenge = false;
    let sawLogin = false;
    let sinceSignInCheck = 0;
    while (Date.now() < deadline) {
      try {
        await this.assertVisible(locator);
        return;
      } catch (error) {
        if (!(error instanceof WebDriverProtocolError)) throw error;
        if (error.code === "bot_challenge") sawChallenge = true;
        if (error.code === "still_on_login") sawLogin = true;
        // Clerk's identifier-first screen offers "Use password" before the input exists.
        if (password) {
          await this.revealPasswordStrategy();
          await this.clickClerkPrimaryIfPresent();
        }
        /**
         * The session can land AFTER the initial check.
         *
         * The recipe opens the app's origin precisely to reuse a live session; the redirect is then still in
         * flight when the short-circuit above runs, and it answers "not signed in". Without reconsidering, the
         * loop spent the full 20 seconds looking for a login field the page had already left behind, which is the
         * wait_timeout seen on a real dashboard.
         *
         * About once a second, and only for a login field: each check is a round trip to the browser, not worth
         * doing every 200ms.
         */
        if (loginField) {
          sinceSignInCheck += 1;
          if (sinceSignInCheck >= 5) {
            sinceSignInCheck = 0;
            if (await this.loginStepAlreadyPassed(locator)) return;
          }
        }
        await delay(signedIn ? 400 : 200);
      }
    }
    if (signedIn || isLoginField(locator)) {
      await this.recordSignedInFailure(signedIn ? "signed_in" : `login:${locator.value}`);
    }
    throw new WebDriverProtocolError(
      sawChallenge ? "bot_challenge" : sawLogin ? "still_on_login" : "wait_timeout",
    );
  }

  async assertVisible(locator: CaptureLocator): Promise<void> {
    if (locator.strategy === "field" && locator.value === "signed_in") {
      await this.assertSignedIn();
      return;
    }
    const element = await this.findElement(locator);
    if (await this.isDisplayed(element)) return;
    throw new WebDriverProtocolError("element_not_visible");
  }

  async mask(locator: CaptureLocator, mode: "mask" | "blur" = "mask"): Promise<void> {
    if (isLoginField(locator) && (await this.loginStepAlreadyPassed(locator))) return;
    const element = await this.findElement(locator);
    const style =
      mode === "blur"
        ? "arguments[0].style.filter='blur(12px)';"
        : "arguments[0].style.color='transparent';arguments[0].style.background='#111827';arguments[0].style.caretColor='transparent';";
    await this.executeScript("redact", style, [{ [elementKey]: element }]);
  }

  /**
   * Blurs contact details on the page, and keeps blurring them as more arrive.
   *
   * A locator-based rule redacts what exists when it runs. The content this is for does not exist
   * then: a lead-search table is empty until the agent searches, and it fills with other people's
   * work addresses, personal addresses and phone numbers minutes after every rule has passed. The
   * blur is applied to the live page, so it is in the recorded pixels and cannot be undone from the
   * video.
   *
   * The smallest element containing a match is blurred rather than its ancestors, so a table keeps
   * its shape and only the cell goes soft — a demo has to still show that results arrived.
   *
   * Names need the other half of the trick. There is no pattern for "michael ferrara", so the table
   * is read instead: a table holding contact details is a table of people, and in that table the
   * column whose heading names a person is blurred too. Scoping it to tables that already matched
   * matters — a "Nome" column elsewhere in the product lists spreadsheets, and blurring those would
   * cost a demo for nothing.
   */
  async redactSensitiveText(): Promise<void> {
    await this.executeScript(
      "install_redactor",
      `if (!window.__captureRedactor) {
         const style = document.createElement('style');
         style.textContent = '.__cl-redacted{filter:blur(7px)!important;}';
         document.documentElement.appendChild(style);
         // An address, or a run of digits long enough to be a telephone number. Deliberately blunt:
         // a false positive costs one blurred cell, a false negative publishes somebody's number.
         const email = /[\\w.!#$%&'*+/=?^\`{|}~-]+@[\\w-]+(?:\\.[\\w-]+)+/;
         const telephone = /(?:\\+?\\d[\\d ().-]{7,}\\d)/;
         // Headings that introduce a person rather than a thing. Short list, both languages this
         // product ships in; anything unmatched simply stays legible.
         const personHeading = /^\\s*(nome|name|full name|nome completo|contato|contact|pessoa|person|lead)\\b/i;
         const redact = (element) => element.classList.add('__cl-redacted');
         const scan = () => {
           const elements = document.body ? document.body.querySelectorAll('*') : [];
           for (const element of elements) {
             if (element.childElementCount > 0) continue;
             if (element.classList.contains('__cl-redacted')) continue;
             const text = element.textContent;
             if (!text || text.length > 200) continue;
             if (email.test(text) || telephone.test(text)) redact(element);
           }
           for (const table of document.querySelectorAll('table')) {
             if (!table.querySelector('.__cl-redacted')) continue;
             const rows = table.rows;
             const heading = rows[0];
             if (!heading) continue;
             const columns = [];
             for (let index = 0; index < heading.cells.length; index++) {
               if (personHeading.test(heading.cells[index].textContent || '')) columns.push(index);
             }
             for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
               for (const column of columns) {
                 const cell = rows[rowIndex].cells[column];
                 if (cell) redact(cell);
               }
             }
           }
         };
         let queued = false;
         const schedule = () => {
           if (queued) return;
           queued = true;
           // Coalesced: a results table mutates once per row, and scanning per mutation on a page
           // being driven by an agent is a visible stall in the recording.
           setTimeout(() => { queued = false; scan(); }, 150);
         };
         window.__captureRedactor = new MutationObserver(schedule);
         window.__captureRedactor.observe(document.documentElement, {
           childList: true, subtree: true, characterData: true,
         });
         scan();
       }`,
      [],
    );
  }

  async screenshot(name: string, fullPage: boolean): Promise<CaptureArtifact> {
    // The agent observes to decide what to do next, a loading page included; only what we keep has
    // to be free of loaders.
    if (name !== AGENT_OBSERVATION_NAME) await this.assertPageReady();
    let previousRect: unknown;
    if (fullPage) {
      previousRect = await this.command("window_rect", () =>
        this.transport.request("GET", `${this.basePath}/window/rect`),
      );
      const dimensions = await this.executeScript(
        "page_dimensions",
        "return {width:Math.min(3840,Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)),height:Math.min(2160,Math.max(document.documentElement.scrollHeight,document.body.scrollHeight))};",
        [],
      );
      if (isObject(dimensions)) {
        await this.command("window_rect", () =>
          this.transport.request("POST", `${this.basePath}/window/rect`, {
            width: numeric(dimensions.width, this.options.viewport.width),
            height: numeric(dimensions.height, this.options.viewport.height),
          }),
        );
      }
    }
    try {
      const body = await this.capturePng();
      /**
       * Remember the observation's own size, because the navigator's coordinates are read in it.
       *
       * WebDriver returns device pixels of whatever it captured, which on a scaled display is
       * larger than the viewport and on a tall page is longer than it too. The model then points
       * inside that image while every check downstream speaks CSS pixels of the viewport, so on a
       * Retina machine most of the screen is unreachable and the run dies on its first click. Only
       * this method knows both frames, so the mapping is recorded here and applied in `computer`.
       */
      if (name === AGENT_OBSERVATION_NAME && !fullPage && body.byteLength > 24) {
        const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const image = { width: header.getUint32(16), height: header.getUint32(20) };
        const page = await this.executeScript(
          "observation_frame",
          "return {iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio,sh:document.documentElement.scrollHeight};",
          [],
        );
        this.observationSize = isObject(page)
          ? {
              ...image,
              innerWidth: numeric(page.iw, 0),
              innerHeight: numeric(page.ih, 0),
              devicePixelRatio: numeric(page.dpr, 1),
              scrollHeight: numeric(page.sh, 0),
            }
          : null;
        if (this.observationSize) {
          console.log(
            JSON.stringify({
              level: "info",
              service: "browser",
              message: "observation frame",
              ...this.observationSize,
              viewport: this.options.viewport,
            }),
          );
        }
      }
      return {
        kind: "screenshot",
        name,
        contentType: "image/png",
        body,
        redactionPassed: true,
      };
    } finally {
      if (fullPage && isObject(previousRect)) {
        await this.command("window_rect", () =>
          this.transport.request("POST", `${this.basePath}/window/rect`, {
            width: numeric(previousRect.width, this.options.viewport.width),
            height: numeric(previousRect.height, this.options.viewport.height),
          }),
        ).catch(() => undefined);
      }
    }
  }

  /**
   * Moves a point from the observation the navigator saw into the viewport the page lives in.
   *
   * The identity when the two already agree, which is every headless run on an unscaled display —
   * so this costs nothing where the problem does not exist, and is the whole fix where it does.
   */
  private toViewportPoint(x: number, y: number): { x: number; y: number } {
    const observed = this.observationSize;
    if (!observed) return { x, y };
    const { width, height } = this.options.viewport;
    if (observed.width === width && observed.height === height) return { x, y };

    /**
     * Only rescale an image that is provably the same picture at a different size.
     *
     * A screenshot taken at a device pixel ratio is the viewport magnified, and dividing the
     * coordinates back is exact. A screenshot that reaches past the fold is a different picture:
     * the model can point at something the viewport genuinely does not show, and any arithmetic
     * that forces that point into range produces a confident click on the wrong element. That is
     * strictly worse than the error it replaces, so the mismatch is left to `assertPoint`, which
     * now reports both frames and lets somebody fix the capture instead of the symptom.
     */
    const horizontal = observed.width / observed.innerWidth;
    const vertical = observed.height / observed.innerHeight;
    const uniform = Math.abs(horizontal - vertical) <= 0.02 * Math.max(horizontal, vertical);
    if (!uniform || observed.innerWidth !== width || observed.innerHeight !== height) {
      return { x, y };
    }
    return {
      x: Math.min(width - 1, Math.max(0, Math.round(x / horizontal))),
      y: Math.min(height - 1, Math.max(0, Math.round(y / vertical))),
    };
  }

  /** The same actions, with every coordinate expressed in viewport pixels. */
  private inViewportSpace(actions: readonly ComputerAction[]): ComputerAction[] {
    return actions.map((action) => {
      if (action.type === "click" || action.type === "double_click" || action.type === "move") {
        return { ...action, ...this.toViewportPoint(action.x, action.y) };
      }
      if (action.type === "scroll") {
        return { ...action, ...this.toViewportPoint(action.x, action.y) };
      }
      if (action.type === "drag") {
        return {
          ...action,
          path: action.path.map((point) => this.toViewportPoint(point.x, point.y)),
        };
      }
      return action;
    });
  }

  async computer(rawActions: readonly ComputerAction[]): Promise<void> {
    const actions = this.inViewportSpace(rawActions);
    for (const action of actions) {
      if (action.type === "screenshot") continue;
      if (action.type === "wait") {
        await delay(1_000);
        continue;
      }
      if (action.type === "scroll") {
        this.assertPoint(action.x, action.y);
        await this.command("computer_scroll", () =>
          this.transport.request("POST", `${this.basePath}/actions`, {
            actions: [
              {
                type: "wheel",
                id: "wheel",
                actions: [
                  {
                    type: "scroll",
                    origin: "viewport",
                    x: action.x,
                    y: action.y,
                    deltaX: action.scroll_x,
                    deltaY: action.scroll_y,
                    duration: 500,
                  },
                ],
              },
            ],
          }),
        );
        this.recordSemanticAction("scroll", null, "viewport");
        await this.settleScroll();
        continue;
      }
      if (action.type === "type") {
        const element = await this.activeElement();
        await this.assertElementAllowed(element);
        /**
         * The same per-character cadence the toolset path already uses.
         *
         * This one posted the whole string to the value endpoint, which fills a field in a single
         * frame — the one thing no person watching a demo has ever seen a person do. `typeHumanly`
         * already exists for exactly this, already jitters the gap so an even rhythm does not read
         * as machine-generated, and already falls back to the instant path when no camera is
         * running, so nothing outside a recording gets slower.
         */
        await this.typeHumanly(element, action.text);
        await this.afterComputerInteraction();
        continue;
      }
      if (action.type === "keypress") {
        const element = await this.activeElement();
        await this.assertElementAllowed(element);
        const semanticElement = await this.describeSemanticElement(element);
        const requested = action.keys.flatMap((key) => key.split("+"));
        const keys = requested.map((key) => {
          const normalized = key.trim().toLocaleUpperCase();
          return webdriverKeys[normalized] ?? (key.length === 1 ? key : "");
        });
        const unknown = requested.filter((_key, index) => keys[index]?.length === 0);
        if (unknown.length > 0) {
          throw new CapturePolicyError("action_blocked", `unknown key ${unknown.join("+")}`);
        }
        await this.command("computer_keypress", () =>
          this.transport.request("POST", `${this.basePath}/actions`, {
            actions: [
              {
                type: "key",
                id: "keyboard",
                actions: [
                  ...keys.map((value) => ({ type: "keyDown", value })),
                  ...[...keys].reverse().map((value) => ({ type: "keyUp", value })),
                ],
              },
            ],
          }),
        );
        this.recordSemanticAction("key", null, semanticElement);
        await this.afterComputerInteraction();
        continue;
      }
      if (action.type === "drag") {
        for (const point of action.path) this.assertPoint(point.x, point.y);
        const [first, ...rest] = action.path;
        const last = action.path.at(-1);
        if (!first || !last) throw new CapturePolicyError("action_blocked", "drag path is empty");
        await this.assertElementAllowed(await this.elementAt(first.x, first.y));
        await this.assertElementAllowed(await this.elementAt(last.x, last.y));
        await this.command("computer_drag", () =>
          this.transport.request("POST", `${this.basePath}/actions`, {
            actions: [
              {
                type: "pointer",
                id: "mouse",
                parameters: { pointerType: "mouse" },
                actions: [
                  { type: "pointerMove", origin: "viewport", x: first.x, y: first.y },
                  { type: "pointerDown", button: 0 },
                  ...rest.map((point) => ({
                    type: "pointerMove",
                    origin: "viewport",
                    x: point.x,
                    y: point.y,
                    duration: pointerStepMs,
                  })),
                  { type: "pointerUp", button: 0 },
                ],
              },
            ],
          }),
        );
        this.pointerAt = { ...last };
        await this.afterComputerInteraction();
        continue;
      }

      if (action.type !== "click" && action.type !== "double_click" && action.type !== "move") {
        throw new CapturePolicyError("action_blocked", `unsupported action ${action.type}`);
      }
      this.assertPoint(action.x, action.y);
      if (action.button && action.button !== "left") {
        throw new CapturePolicyError("action_blocked", `${action.button} button`);
      }
      const element = await this.elementAt(action.x, action.y);
      await this.assertElementAllowed(element);
      if (action.type === "move") {
        await this.movePointerTo(element, action);
        continue;
      }
      const semanticElement = await this.describeSemanticElement(element);
      await this.movePointerTo(element, action);
      await this.recordPointer(element, action);
      await this.command(`computer_${action.type}`, () =>
        this.transport.request("POST", `${this.basePath}/actions`, {
          actions: [
            {
              type: "pointer",
              id: "mouse",
              parameters: { pointerType: "mouse" },
              actions: Array.from({ length: action.type === "double_click" ? 2 : 1 }).flatMap(
                () => [
                  { type: "pointerDown", button: 0 },
                  { type: "pause", duration: 90 },
                  { type: "pointerUp", button: 0 },
                  { type: "pause", duration: 100 },
                ],
              ),
            },
          ],
        }),
      );
      this.recordSemanticAction(
        action.type === "double_click" ? "double_click" : "click",
        null,
        semanticElement,
      );
      await this.afterComputerInteraction();
    }
  }

  private assertPoint(x: number, y: number): void {
    /**
     * Measure against the viewport the observation was taken of, not the one that was asked for.
     *
     * A window can end up a different size than it was told to be — it is a real window on a real
     * desktop — and the navigator is looking at a picture of what the page actually is. Judging its
     * coordinates by the requested size then rejects points that are plainly on screen, and the
     * whole lower part of the page becomes unreachable for a reason nothing reports.
     */
    const frame = this.observationSize ?? {
      innerWidth: this.options.viewport.width,
      innerHeight: this.options.viewport.height,
    };
    if (x >= frame.innerWidth || y >= frame.innerHeight) {
      /**
       * Coordinates and the viewport are ours, so both can be named.
       *
       * A point outside the frame is almost never the model misreading its own screenshot; it is
       * the screenshot and the viewport having different sizes, and every action lands out of
       * bounds until that is fixed. Reporting the two numbers turns a whole dead recording into an
       * arithmetic problem.
       */
      throw new CapturePolicyError(
        "action_blocked",
        `point ${x},${y} outside viewport ${frame.innerWidth}x${frame.innerHeight}`,
      );
    }
  }

  private async activeElement(): Promise<string> {
    const response = await this.command("active_element", () =>
      this.transport.request("GET", `${this.basePath}/element/active`),
    );
    if (!isObject(response) || typeof response[elementKey] !== "string") {
      throw new WebDriverProtocolError("invalid_element_response");
    }
    return response[elementKey];
  }

  private async elementAt(x: number, y: number): Promise<string> {
    const response = await this.executeScript(
      "computer_target",
      "const e=document.elementFromPoint(arguments[0],arguments[1]);return e?.closest('a,button,input,select,textarea,[role=button],[role=link],[contenteditable=true]')||e;",
      [x, y],
    );
    if (!isObject(response) || typeof response[elementKey] !== "string") {
      throw new WebDriverProtocolError("element_not_visible");
    }
    return response[elementKey];
  }

  private async assertElementAllowed(element: string): Promise<void> {
    const description = await this.executeScript(
      "computer_target_policy",
      // Nothing focused (or a click on empty space) resolves to the page itself, whose text is the
      // whole screen; that is not a target, so it is never matched against the policy terms.
      "const e=arguments[0];if(e===document.body||e===document.documentElement)return '';const f=e.form;return [e.innerText,e.value,e.getAttribute('aria-label'),e.title,e.href,f?.action,e.type].filter(Boolean).join(' ');",
      [{ [elementKey]: element }],
    );
    assertLocatorAllowed({
      strategy: "text",
      value:
        typeof description === "string" && description.trim()
          ? description.slice(0, 500)
          : "safe target",
    });
  }

  private async afterComputerInteraction(): Promise<void> {
    if (this.recordingStartedAtMs !== null) await this.settleScroll();
    await this.verifyNavigation();
    if (this.recordingStartedAtMs !== null) {
      await this.drainTelemetry();
      await this.installTelemetryCollector();
      await this.readIdentity();
    }
  }

  /**
   * Resolves a `ref_N` tag back to the element the page reader stamped it on.
   *
   * The tag lives in the DOM, so a re-render drops it and the lookup misses — which is precisely
   * the signal we want. No generation counter is needed: the page itself tells us.
   */
  private async elementForRef(ref: string): Promise<string> {
    if (!/^ref_\d{1,6}$/u.test(ref)) throw new StaleRefError(ref);
    const response = await this.executeScript(
      "resolve_ref",
      `return document.querySelector('[${refAttribute}="' + arguments[0] + '"]');`,
      [ref],
    );
    if (!isObject(response) || typeof response[elementKey] !== "string") {
      throw new StaleRefError(ref);
    }
    return response[elementKey];
  }

  private async elementForTarget(target: BrowserTarget): Promise<string> {
    return target.type === "ref"
      ? await this.elementForRef(target.ref)
      : await this.elementAt(target.x, target.y);
  }

  async readScrollState(): Promise<string> {
    const result = await this.executeScript("scroll_state", scrollStateScript, []);
    return typeof result === "string" ? result : "Scroll geometry unavailable.";
  }

  async readPage(
    options: { filter?: PageReadFilter; depth?: number; ref?: string } = {},
  ): Promise<string> {
    await this.switchToTop();
    await this.readIdentity();
    const result = await this.executeScript("read_page", readPageScript, [
      options.filter ?? "interactive",
      Math.min(15, Math.max(1, options.depth ?? 15)),
      options.ref ?? null,
      refAttribute,
      maximumPageReadCharacters,
    ]);
    if (!isObject(result)) return "";
    if (result.missingRoot === true && options.ref) throw new StaleRefError(options.ref);
    const text = typeof result.text === "string" ? result.text : "";
    if (!text) return "No addressable elements are visible on this page.";
    return result.truncated === true
      ? `${text}\n… output truncated; narrow it with depth or ref.`
      : text;
  }

  async findElements(query: string): Promise<string> {
    // Tags have to exist before they can be searched, so a find on a page nobody has read yet
    // indexes it first rather than returning a confusing nothing.
    await this.readPage({ filter: "interactive" });
    const found = await this.executeScript("find_page", findElementsScript, [
      query,
      refAttribute,
      20,
    ]);
    const text = typeof found === "string" ? found : "";
    return (
      text || `No elements match ${JSON.stringify(query)}. Try read_page for the full outline.`
    );
  }

  async pageText(): Promise<string> {
    await this.switchToTop();
    // Waits poll the page text while it changes (a redirect, a consent screen loading): each poll is also a read.
    await this.readIdentity();
    const text = await this.executeScript("page_text", pageTextScript, [maximumPageReadCharacters]);
    return typeof text === "string" ? text : "";
  }

  async currentUrl(): Promise<string> {
    const current = await this.command("current_url", () =>
      this.transport.request("GET", `${this.basePath}/url`),
    );
    return typeof current === "string" ? current : "";
  }

  /**
   * Every pointer member travels before it presses.
   *
   * `movePointerTo` draws the eased path the recording shows and `recordPointer` is what post
   * production reads to draw the cursor at all; a bare element click would land silently and leave
   * the video cutting between states with a motionless cursor.
   */
  async pointer(kind: PointerKind, target: BrowserTarget): Promise<void> {
    const element = await this.elementForTarget(target);
    await this.assertElementAllowed(element);
    const point = target.type === "coordinate" ? target : undefined;
    if (kind === "hover" || kind === "move") {
      await this.movePointerTo(element, point);
      await this.afterComputerInteraction();
      return;
    }
    /**
     * Every check is made before the pointer sets off. Each one is a round trip, and over the Chrome extension a
     * round trip is a few hundred milliseconds: made after the travel, they left the cursor parked on its target for
     * a second and a half before pressing, which reads as hesitation. Nothing here depends on where the pointer is.
     */
    const disabled = await this.executeScript("click_readiness",
      "return Boolean(arguments[0].matches(':disabled') || arguments[0].closest('[aria-disabled=true],[inert]'));",
      [{ [elementKey]: element }]);
    if (disabled === true) throw new WebDriverProtocolError("element_disabled");
    const semanticElement = await this.describeSemanticElement(element);
    const focusOnly = await this.executeScript("editable_focus",
      "return arguments[0].matches('textarea,input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),[contenteditable=true]');",
      [{ [elementKey]: element }]);
    const measured = await this.measurePointer(element, point);
    await this.movePointerTo(element, point);
    const presses = kind === "double_click" ? 2 : kind === "triple_click" ? 3 : 1;
    const button = kind === "right_click" ? 2 : 0;
    const sentAt = Date.now();
    await this.command(`browser_${kind}`, () =>
      this.transport.request("POST", `${this.basePath}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: Array.from({ length: presses }).flatMap(() => [
              { type: "pointerDown", button },
              { type: "pause", duration: 90 },
              { type: "pointerUp", button },
              { type: "pause", duration: 100 },
            ]),
          },
        ],
      }),
    );
    // The press reached the page about halfway through the round trip, not when the request left: placing it there
    // keeps the drawn click on the moment the page reacts, even over a slow link.
    const pressedAt = Math.round((sentAt + Date.now() - 190 * presses) / 2);
    if (measured) this.pointers.push({ ...measured, atMs: Math.max(0, Math.max(sentAt, pressedAt) - (this.recordingStartedAtMs ?? 0)) });
    for (let press = 0; press < presses; press++) this.recordPress(press * 190, Math.max(sentAt, pressedAt));
    this.recordSemanticAction(
      focusOnly === true ? "setup" : kind === "right_click" ? "right_click" : kind === "double_click" ? "double_click" : "click",
      target.type === "ref" ? target.ref : null,
      semanticElement,
    );
    await this.afterComputerInteraction();
  }

  /**
   * Sets a form value by typing it, not by assigning it.
   *
   * The member is specified as a direct value set, which is invisible on camera. A demo exists to
   * show the entry happening, so text is typed; only controls where typing means nothing — selects
   * and checkboxes — take the assignment path.
   */
  async formInput(ref: string, value: string | number | boolean): Promise<void> {
    const element = await this.elementForRef(ref);
    await this.assertElementAllowed(element);
    const semanticElement = await this.describeSemanticElement(element);
    const kind = await this.executeScript(
      "form_input_kind",
      "const e=arguments[0];return e.tagName==='SELECT'?'select':(e.type==='checkbox'||e.type==='radio')?'toggle':'text';",
      [{ [elementKey]: element }],
    );
    if (kind === "select") {
      await this.movePointerTo(element);
      // The member accepts either the option's value or its visible text, so match on both.
      const chosen = await this.executeScript(
        "form_input_select",
        "const e=arguments[0],v=String(arguments[1]);const o=[...e.options].find(x=>x.value===v)||[...e.options].find(x=>(x.textContent||'').trim()===v);if(!o)return false;e.value=o.value;e.dispatchEvent(new Event('change',{bubbles:true}));return true;",
        [{ [elementKey]: element }, String(value)],
      );
      if (chosen !== true) throw new WebDriverProtocolError("option_not_found");
    } else if (kind === "toggle") {
      await this.movePointerTo(element);
      await this.recordPointer(element);
      const wanted = value === true || value === "true";
      await this.executeScript(
        "form_input_toggle",
        "const e=arguments[0],v=arguments[1];if(e.checked!==v){e.click();}",
        [{ [elementKey]: element }, wanted],
      );
    } else {
      await this.command("form_input_clear", () =>
        this.transport.request("POST", `${this.basePath}/element/${element}/clear`, {}),
      );
      await this.typeHumanly(element, String(value));
    }
    if (kind !== "text") this.recordSemanticAction("type", ref, semanticElement);
    await this.afterComputerInteraction();
  }

  async scrollToRef(ref: string): Promise<void> {
    const element = await this.elementForRef(ref);
    await this.executeScript(
      "scroll_to_ref",
      "arguments[0].scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});",
      [{ [elementKey]: element }],
    );
    await this.settleScroll();
    this.recordSemanticAction("scroll", ref, await this.describeSemanticElement(element));
  }

  async scrollBy(
    target: CoordinateTarget,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    const steps = Math.min(10, Math.max(1, amount)) * 100;
    const deltaX = direction === "left" ? -steps : direction === "right" ? steps : 0;
    const deltaY = direction === "up" ? -steps : direction === "down" ? steps : 0;
    const animated = await this.executeScript("smooth_scroll_by", smoothScrollScript,
      [target.x, target.y, deltaX, deltaY]).catch(() => false);
    if (animated !== true) await this.command("browser_scroll", () =>
      this.transport.request("POST", `${this.basePath}/actions`, {
        actions: [
          {
            type: "wheel",
            id: "wheel",
            actions: [
              {
                type: "scroll",
                origin: "viewport",
                x: target.x,
                y: target.y,
                deltaX,
                deltaY,
                duration: 500,
              },
            ],
          },
        ],
      }),
    );
    await this.settleScroll();
    this.recordSemanticAction("scroll", null, "viewport");
  }

  async typeText(text: string): Promise<void> {
    const element = await this.activeElement();
    await this.assertElementAllowed(element);
    await this.typeHumanly(element, text);
    await this.afterComputerInteraction();
  }

  async pressKey(text: string, repeat = 1): Promise<void> {
    const element = await this.activeElement();
    await this.assertElementAllowed(element);
    const semanticElement = await this.describeSemanticElement(element);
    const chords = text.trim().split(/\s+/u);
    for (let pass = 0; pass < Math.min(100, Math.max(1, repeat)); pass++) {
      for (const chord of chords) {
        const requested = chord.split("+");
        const keys = requested.map((key) => {
          const normalized = key.trim().toLocaleUpperCase();
          return webdriverKeys[normalized] ?? (key.length === 1 ? key : "");
        });
        if (keys.some((key) => key.length === 0)) {
          throw new CapturePolicyError("action_blocked", `unknown key ${chord}`);
        }
        await this.command("browser_key", () =>
          this.transport.request("POST", `${this.basePath}/actions`, {
            actions: [
              {
                type: "key",
                id: "keyboard",
                actions: [
                  ...keys.map((key) => ({ type: "keyDown", value: key })),
                  ...[...keys].reverse().map((key) => ({ type: "keyUp", value: key })),
                ],
              },
            ],
          }),
        );
      }
    }
    this.recordSemanticAction("key", null, semanticElement);
    await this.afterComputerInteraction();
  }

  async startRecording(): Promise<void> {
    if (this.recordingFrames || this.screencast) throw new Error("recording_already_started");
    await this.waitForPageReady();
    // Anchor navigation jumps unless the document asks for smooth scrolling. A page that already
    // sets its own behaviour keeps it; this only supplies a default where there is none.
    await this.executeScript(
      "enable_smooth_scroll",
      "const s=document.createElement('style');s.textContent='html:not([data-scroll-behavior]){scroll-behavior:smooth}';document.head.appendChild(s);",
      [],
    ).catch(() => undefined);
    this.recordingStartedAtMs = Date.now();
    await this.installTelemetryCollector();
    await this.readIdentity();
    if (this.debuggerAddress) {
      try {
        this.screencast = await CdpScreencastRecorder.start(
          this.debuggerAddress,
          this.streamingVideoEncoder,
          {
            width: Math.round(this.options.viewport.width * this.captureScale),
            height: Math.round(this.options.viewport.height * this.captureScale),
            framesPerSecond: this.recordingFrameRate,
            startedAtMs: this.recordingStartedAtMs,
          },
        );
        this.recordingMode = "screencast";
        return;
      } catch {
        // The address is reachable only from wherever the browser runs. A remote grid reports a
        // port on its own host, so recording degrades to the poll instead of failing the capture.
        this.trace.push({
          at: this.now().toISOString(),
          operation: "screencast_unavailable",
          status: "failed",
        });
      }
    }
    // A WebDriver endpoint without a reachable DevTools address still records, as a slideshow.
    this.recordingMode = "poll";
    this.recordingFrames = [];
    this.recordingFrameTimes = [];
    this.recordingBytes = 0;
    this.recordingFailure = null;
    await this.captureRecordingFrame();
    if (this.recordingFrames.length === 0) throw new Error("video_has_no_frames");
    this.recordingTimer = setInterval(() => void this.captureRecordingFrame(), 250);
  }

  async stopRecording(): Promise<CaptureArtifact> {
    await this.drainTelemetry();
    if (this.screencast) {
      const recorder = this.screencast;
      this.screencast = null;
      await this.assertPageReady().catch(() => undefined);
      return {
        kind: "video",
        name: "capture",
        contentType: "video/webm",
        body: await recorder.stop(),
        redactionPassed: true,
      };
    }
    if (!this.recordingFrames) throw new Error("recording_not_started");
    await this.assertPageReady().catch(() => undefined);
    if (this.recordingTimer) clearInterval(this.recordingTimer);
    this.recordingTimer = undefined;
    const pendingDeadline = Date.now() + 2_000;
    while (this.recordingCapturePending && Date.now() < pendingDeadline) await delay(10);
    await this.captureRecordingFrame();
    const frames = this.recordingFrames;
    this.recordingFrames = null;
    try {
      if (this.recordingFailure) throw this.recordingFailure;
      if (new Set(frames.map(frameHash)).size < 2) throw new Error("recording_frozen");
      // A screenshot can wait behind a long WebDriver action. Preserve that elapsed time by
      // holding the previous frame; packing received screenshots at 4 fps sped the screen up
      // independently of the cursor and zooms, whose timestamps stayed on the recording clock.
      const timedFrames: Uint8Array[] = [];
      for (const [index, frame] of frames.entries()) {
        const nextAt =
          this.recordingFrameTimes[index + 1] ?? (this.recordingFrameTimes.at(-1) ?? 0) + 250;
        while (timedFrames.length * 250 < nextAt) timedFrames.push(frame);
      }
      const body = await this.videoEncoder.encodePngFrames(timedFrames, 4);
      return {
        kind: "video",
        name: "capture",
        contentType: "video/webm",
        body,
        redactionPassed: true,
      };
    } finally {
      frames.forEach((frame) => {
        frame.fill(0);
      });
    }
  }

  async stopTrace(): Promise<CaptureArtifact> {
    const body = new TextEncoder().encode(JSON.stringify({ version: 1, entries: this.trace }));
    return {
      kind: "trace",
      name: "trace",
      contentType: "application/json",
      body,
      redactionPassed: true,
    };
  }

  async exportStorageState(): Promise<BrowserStorageState> {
    const cookies = new Map<string, BrowserStorageState["cookies"][number]>();
    const origins: BrowserStorageState["origins"] = [];
    const seenOrigins = new Set<string>();
    const collect = async () => {
      const pageCookies = await this.transport.request("GET", `${this.basePath}/cookie`);
      if (Array.isArray(pageCookies)) {
        for (const candidate of pageCookies) {
          const cookie = webDriverCookie(candidate);
          if (!cookie) continue;
          cookies.set(`${cookie.domain}\0${cookie.name}\0${cookie.path}`, cookie);
        }
      }
      const current = await this.transport.request("GET", `${this.basePath}/url`);
      if (typeof current !== "string") return;
      const origin = normalizeAllowedOrigin(new URL(current).origin);
      if (seenOrigins.has(origin)) return;
      const localStorage = await this.executeScript(
        "export_local_storage",
        "return Object.entries(localStorage).map(([name,value])=>({name,value}));",
        [],
      );
      if (!Array.isArray(localStorage) || localStorage.length === 0) return;
      const entries = localStorage.flatMap((item) => {
        if (!isObject(item) || typeof item.name !== "string" || typeof item.value !== "string") {
          return [];
        }
        if (item.name.length === 0 || item.name.length > 500 || item.value.length > 20_000) {
          return [];
        }
        return [{ name: item.name, value: item.value }];
      });
      if (entries.length === 0) return;
      seenOrigins.add(origin);
      origins.push({ origin, localStorage: entries });
    };
    await collect();
    // WebDriver only lists the current page's cookies. A sign-in provider on a sibling subdomain
    // (Clerk's clerk.product.com) is only ever fetched, never visited, and holds the long-lived
    // session; the browser-wide list includes it. The origin filter below still scopes the result.
    for (const cmd of ["Storage.getCookies", "Network.getAllCookies"]) {
      const all = await this.transport.request("POST", `${this.basePath}/goog/cdp/execute`, { cmd, params: {} }).catch(() => undefined);
      if (!isObject(all) || !Array.isArray(all.cookies)) continue;
      for (const candidate of all.cookies) {
        const cookie = webDriverCookie(candidate);
        if (cookie) cookies.set(`${cookie.domain}\0${cookie.name}\0${cookie.path}`, cookie);
      }
      break;
    }
    // Session saves also run immediately after login. Keep the application page intact.
    const originalWindow = await this.transport.request("GET", `${this.basePath}/window`);
    const temporaryWindow = await this.transport.request("POST", `${this.basePath}/window/new`, {
      type: "tab",
    });
    if (!isObject(temporaryWindow) || typeof temporaryWindow.handle !== "string") {
      throw new WebDriverProtocolError("invalid_window_response");
    }
    await this.transport.request("POST", `${this.basePath}/window`, {
      handle: temporaryWindow.handle,
    });
    try {
      for (const allowedOrigin of this.options.allowedOrigins) {
        const origin = normalizeAllowedOrigin(allowedOrigin);
        try {
          await this.command("export_origin", () =>
            this.transport.request("POST", `${this.basePath}/url`, { url: origin }),
          );
          await collect();
        } catch {
          // One origin failing must not drop cookies already collected from the others.
        }
      }
    } finally {
      try {
        await this.transport.request("DELETE", `${this.basePath}/window`);
      } finally {
        await this.transport.request("POST", `${this.basePath}/window`, { handle: originalWindow });
      }
    }
    return storageStateForAllowedOrigins(
      { cookies: [...cookies.values()], origins },
      this.options.allowedOrigins,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.screencast?.stop().catch(() => undefined);
    this.screencast = null;
    if (this.recordingTimer) clearInterval(this.recordingTimer);
    this.recordingTimer = undefined;
    this.recordingFrames?.forEach((frame) => {
      frame.fill(0);
    });
    this.recordingFrames = null;
    await this.transport.request("DELETE", this.basePath).catch(() => undefined);
    if(this.profileDirectory) await rm(this.profileDirectory,{recursive:true,force:true,maxRetries:3});
  }

  private async hydrateStorageState(state: BrowserStorageState): Promise<void> {
    // Restore before the first request: visiting a protected origin first can redirect away.
    // A URL (no Domain attribute) preserves host-only cookies, including the __Host- prefix.
    const cookies = state.cookies.filter(cookie => cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > Date.now() / 1000).map(cookie => ({
      name: cookie.name, value: cookie.value, path: cookie.path,
      url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
      ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
      secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
      ...(cookie.expires !== undefined && cookie.expires > 0 ? { expires: cookie.expires } : {}),
    }));
    if (cookies.length) await this.command('restore_cookies', () => this.transport.request('POST', `${this.basePath}/goog/cdp/execute`, {
      cmd: 'Network.setCookies', params: { cookies },
    }));
    for (const storage of state.origins) {
      const origin = normalizeAllowedOrigin(storage.origin);
      this.options.onNavigation(origin, this.redirectCount);
      // Install before application scripts, scoped to this origin even across redirects.
      const source = `if(location.origin===${JSON.stringify(origin)}){for(const item of ${JSON.stringify(storage.localStorage)})localStorage.setItem(item.name,item.value);}`;
      const installed = await this.command('prepare_local_storage', () => this.transport.request('POST', `${this.basePath}/goog/cdp/execute`, {
        cmd: 'Page.addScriptToEvaluateOnNewDocument', params: { source },
      }));
      if (!isObject(installed) || typeof installed.identifier !== 'string') throw new WebDriverProtocolError('invalid_storage_script');
      try {
        await this.command('hydrate_origin', () => this.transport.request('POST', `${this.basePath}/url`, { url: origin }));
        await this.verifyNavigation(origin);
      } finally {
        await this.command('remove_storage_script', () => this.transport.request('POST', `${this.basePath}/goog/cdp/execute`, {
          cmd: 'Page.removeScriptToEvaluateOnNewDocument', params: { identifier: installed.identifier },
        }));
      }
    }
  }

  private async findElement(locator: CaptureLocator): Promise<string> {
    await this.switchToTop();
    const found = await this.findVisibleInCurrent(locator);
    if (found) return found;
    const nested = await this.findVisibleInFrames(locator, 0);
    if (nested) return nested;
    throw new WebDriverProtocolError("element_not_visible");
  }

  /**
   * Clerk remounts the identifier field between waitFor and fill. One miss is a
   * rebuild, not a missing form — waitFor already proved the control exists.
   */
  private async findElementReady(locator: CaptureLocator): Promise<string> {
    const budgetMs = isLoginField(locator) ? 8_000 : 0;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      try {
        return await this.findElement(locator);
      } catch (error) {
        if (
          !(error instanceof WebDriverProtocolError) ||
          error.code !== "element_not_visible" ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await delay(150);
      }
    }
  }

  /**
   * Sign-in widgets may place fields in frames; search them after the top document.
   */
  private async findVisibleInFrames(
    locator: CaptureLocator,
    depth: number,
  ): Promise<string | null> {
    if (depth > 2) return null;
    const frames = await this.findElementIds("//iframe | //frame");
    for (const frame of frames) {
      await this.command("switch_frame", () =>
        this.transport.request("POST", `${this.basePath}/frame`, {
          id: { [elementKey]: frame },
        }),
      );
      const found = await this.findVisibleInCurrent(locator);
      if (found) return found;
      const nested = await this.findVisibleInFrames(locator, depth + 1);
      if (nested) return nested;
      await this.switchToParent();
    }
    return null;
  }

  private async findVisibleInCurrent(locator: CaptureLocator): Promise<string | null> {
    if (locator.strategy === "field" && locator.value === "submit") {
      const preferred = await this.firstDisplayed(
        "//button[@data-localization-key='formButtonPrimary']",
      );
      if (preferred) return preferred;
    }
    const ids = await this.findElementIds(locatorXpath(locator));
    for (const id of ids) {
      if (await this.isDisplayed(id)) return id;
    }
    if (locator.strategy === "field") {
      const deep = await this.findDeepField(locator.value);
      if (deep) return deep;
      if (locator.value === "password") return this.findActivePassword();
    }
    return null;
  }

  private async firstDisplayed(xpath: string): Promise<string | null> {
    for (const id of await this.findElementIds(xpath)) {
      if (await this.isDisplayed(id)) return id;
    }
    return null;
  }

  private async isDisplayed(id: string): Promise<boolean> {
    try {
      return (
        (await this.command("displayed", () =>
          this.transport.request("GET", `${this.basePath}/element/${id}/displayed`),
        )) === true
      );
    } catch {
      return false;
    }
  }

  /**
   * Closed shadow roots can hide fields from selectors. A focused fallback still must be visible.
   */
  private async findActivePassword(): Promise<string | null> {
    const response = await this.command("active_element", () =>
      this.transport.request("GET", `${this.basePath}/element/active`),
    );
    if (!isObject(response) || typeof response[elementKey] !== "string") return null;
    const id = response[elementKey];
    const type = await this.command("attribute", () =>
      this.transport.request("GET", `${this.basePath}/element/${id}/attribute/type`),
    );
    const name = await this.command("attribute", () =>
      this.transport.request("GET", `${this.basePath}/element/${id}/attribute/name`),
    );
    const autocomplete = await this.command("attribute", () =>
      this.transport.request("GET", `${this.basePath}/element/${id}/attribute/autocomplete`),
    );
    if (type === "password" || name === "password" || autocomplete === "current-password") {
      return await this.isDisplayed(id) ? id : null;
    }
    return null;
  }

  private async recordSignedInFailure(field = "signed_in"): Promise<void> {
    try {
      const current = await this.transport.request("GET", `${this.basePath}/url`);
      const snapshot = await this.pageChallengeSnapshot();
      console.error(
        JSON.stringify({
          level: "error",
          service: "browser",
          message: `${field} wait failed`,
          url: typeof current === "string" ? current : null,
          challengeFrame: snapshot.challengeFrame,
          passwordSubmitSent: this.passwordSubmitSent,
          text: snapshot.text.slice(0, 800),
        }),
      );
    } catch {
      // Diagnostics must not replace the signed_in error.
    }
  }

  private async clickClerkPrimaryIfPresent(): Promise<void> {
    try {
      await this.switchToTop();
      const button = await this.firstDisplayed(
        "//button[@data-localization-key='formButtonPrimary']",
      );
      if (!button) return;
      await this.command("click_primary", () =>
        this.transport.request("POST", `${this.basePath}/element/${button}/click`, {}),
      );
    } catch {
      // Optional retry of Continue after a cookie banner ate the first click.
    }
  }

  /**
   * Clerk's hosted controls often live in shadow roots, which XPath never enters.
   */
  private async findDeepField(kind: string): Promise<string | null> {
    const selectors = fieldCssSelectors(kind);
    if (selectors.length === 0) return null;
    const result = await this.executeScript("find_deep_field", findDeepFieldScript, [selectors]);
    if (!isObject(result) || typeof result[elementKey] !== "string") return null;
    return await this.isDisplayed(result[elementKey]) ? result[elementKey] : null;
  }

  private async revealPasswordStrategy(): Promise<void> {
    try {
      await this.switchToTop();
      const clicked = await this.executeScript(
        "reveal_password_strategy",
        revealPasswordStrategyScript,
        [],
      );
      if (clicked === true) return;
      const button =
        (await this.findVisibleInCurrent({ strategy: "field", value: "password-strategy" })) ??
        (await this.findVisibleInFrames({ strategy: "field", value: "password-strategy" }, 0));
      if (!button) return;
      await this.command("click_strategy", () =>
        this.transport.request("POST", `${this.basePath}/element/${button}/click`, {}),
      );
    } catch {
      // The chooser is optional. A miss just keeps waiting for the password input.
    }
  }

  private async findElementIds(xpath: string): Promise<string[]> {
    const response = await this.command("find_elements", () =>
      this.transport.request("POST", `${this.basePath}/elements`, {
        using: "xpath",
        value: xpath,
      }),
    );
    if (!Array.isArray(response)) throw new WebDriverProtocolError("invalid_element_response");
    return response.flatMap((candidate) => {
      if (!isObject(candidate) || typeof candidate[elementKey] !== "string") return [];
      return [candidate[elementKey]];
    });
  }

  private async switchToTop(): Promise<void> {
    await this.command("switch_top", () =>
      this.transport.request("POST", `${this.basePath}/frame`, { id: null }),
    );
  }

  private async switchToParent(): Promise<void> {
    await this.command("switch_parent", () =>
      this.transport.request("POST", `${this.basePath}/frame/parent`, {}),
    );
  }

  private async executeScript(
    operation: string,
    script: string,
    args: unknown[],
  ): Promise<unknown> {
    return this.command(operation, () =>
      this.transport.request("POST", `${this.basePath}/execute/sync`, { script, args }),
    );
  }

  private async capturePng(): Promise<Uint8Array> {
    const base64 = await this.command("screenshot", () =>
      this.transport.request("GET", `${this.basePath}/screenshot`),
    );
    if (typeof base64 !== "string") throw new WebDriverProtocolError("invalid_screenshot");
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  /**
   * Recording starts right after a session opens, while an app may still show its full-screen
   * loader or finish a sign-in handshake redirect. Both settle on their own in a few seconds; a bot
   * challenge does not, so it fails at once.
   */
  private async waitForPageReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try { await this.assertPageReady(); return; }
      catch (error) {
        if (!(error instanceof WebDriverProtocolError) || error.code === "bot_challenge" || Date.now() >= deadline) throw error;
        await delay(500);
      }
    }
  }

  private async assertPageReady(): Promise<void> {
    const loading = await this.executeScript(
      "page_readiness",
      "const vw=window.innerWidth,vh=window.innerHeight;return [...document.querySelectorAll('[aria-busy=true],[data-loading=true],.loader,.loading,.spinner')].some(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);if(r.width<=0||r.height<=0||s.visibility==='hidden'||s.display==='none'||Number(s.opacity)===0)return false;return r.width*r.height>=vw*vh*0.2;});",
      [],
    );
    if (loading === true) throw new WebDriverProtocolError("loader_visible");
    await this.assertNoBotChallenge();
  }

  private async pageChallengeSnapshot(): Promise<{ text: string; challengeFrame: boolean }> {
    const snapshot = await this.executeScript(
      "bot_challenge",
      `const texts=[]; let frame=false;
       const visit=(root)=>{
         if(!root) return;
         try{ if(root.innerText) texts.push(root.innerText); }catch(e){}
         try{
           for(const iframe of root.querySelectorAll('iframe')){
             const src=iframe.src||iframe.getAttribute('src')||'';
             if(/cloudflare|turnstile|challenges/i.test(src)) frame=true;
           }
           if(root.querySelector('.cf-turnstile,[data-cf-turnstile],[name="cf-turnstile-response"]')) frame=true;
           for(const el of root.querySelectorAll('*')){ if(el.shadowRoot) visit(el.shadowRoot); }
         }catch(e){}
       };
       visit(document);
       return {text:texts.join('\\n'),challengeFrame:frame};`,
      [],
    );
    if (!isObject(snapshot)) return { text: "", challengeFrame: false };
    return {
      text: typeof snapshot.text === "string" ? snapshot.text : "",
      challengeFrame: snapshot.challengeFrame === true,
    };
  }

  private async assertNoBotChallenge(): Promise<void> {
    if (pageLooksLikeBotChallenge(await this.pageChallengeSnapshot())) {
      throw new WebDriverProtocolError("bot_challenge");
    }
  }

  private async isSignedIn(): Promise<boolean> {
    try {
      await this.assertSignedIn();
      return true;
    } catch (error) {
      if (
        error instanceof WebDriverProtocolError &&
        (error.code === "still_on_login" || error.code === "bot_challenge")
      ) {
        return false;
      }
      throw error;
    }
  }

  private async loginStepAlreadyPassed(locator: CaptureLocator): Promise<boolean> {
    if (await this.isSignedIn()) return true;
    if (locator.strategy !== "field" || !["email", "submit"].includes(locator.value)) return false;
    const current = await this.command("current_url", () =>
      this.transport.request("GET", `${this.basePath}/url`),
    );
    if (
      typeof current !== "string" ||
      !/(^|\/)(factor-one|password)(\/|$)/u.test(new URL(current).pathname.toLocaleLowerCase())
    ) {
      return false;
    }
    try {
      await this.findElement({ strategy: "field", value: "password" });
      return true;
    } catch (error) {
      if (error instanceof WebDriverProtocolError && error.code === "element_not_visible") {
        return false;
      }
      throw error;
    }
  }

  private async assertSignedIn(): Promise<void> {
    await this.switchToTop();
    await this.assertNoBotChallenge();
    const current = await this.command("current_url", () =>
      this.transport.request("GET", `${this.basePath}/url`),
    );
    if (typeof current === "string" && isAuthenticationUrl(current)) {
      throw new WebDriverProtocolError("still_on_login");
    }
    // Clerk's password screen keeps the identifier field mounted. The password
    // control leaving the page is what "the form finished" looks like.
    const password = await this.findVisibleInCurrent({ strategy: "field", value: "password" });
    if (password) throw new WebDriverProtocolError("still_on_login");
  }

  private async captureRecordingFrame(): Promise<void> {
    const frames = this.recordingFrames;
    const startedAt = this.recordingStartedAtMs;
    if (!frames || startedAt === null || this.recordingCapturePending || this.recordingFailure) {
      return;
    }
    this.recordingCapturePending = true;
    try {
      const frame = await this.capturePng();
      this.recordingBytes += frame.byteLength;
      if (this.recordingBytes > maximumRecordingBytes) {
        frame.fill(0);
        this.recordingFailure = new Error("recording_memory_limit");
        return;
      }
      frames.push(frame);
      this.recordingFrameTimes.push(Date.now() - startedAt);
    } catch {
      // A missed frame is safe; the action command remains authoritative.
    } finally {
      this.recordingCapturePending = false;
    }
  }

  private async verifyNavigation(requestedUrl?: string): Promise<void> {
    const current = await this.command("current_url", () =>
      this.transport.request("GET", `${this.basePath}/url`),
    );
    if (typeof current !== "string") throw new WebDriverProtocolError("invalid_current_url");
    const route = new URL(current).origin + new URL(current).pathname;
    if (this.lastRecordedRoute !== undefined && route !== this.lastRecordedRoute) this.recordSemanticAction("navigate", null, "Page changed");
    this.lastRecordedRoute = route;
    if (requestedUrl && isAuthenticationUrl(requestedUrl)) this.authenticationFlowActive = true;
    if (isAuthenticationUrl(current)) {
      // A provider's sign-in or consent page on another site (Connect Google, Sign in with GitHub) is a
      // flow the demo started, not the product's session expiring.
      if (
        this.hydrating ||
        this.authenticationFlowActive ||
        !this.sawApplicationPage ||
        !this.onProductSite(current)
      ) {
        this.authenticationFlowActive = true;
        this.options.onNavigation(current, this.redirectCount);
        return;
      }
      throw new CaptureSessionError("reauth_required");
    }
    if (this.hydrating) {
      this.options.onNavigation(current, this.redirectCount);
      return;
    }
    if (this.authenticationFlowActive) {
      // Clerk's identifier → password → app hop must not spend the product redirect budget.
      this.redirectCount = 0;
      this.authenticationFlowActive = false;
    }
    if (requestedUrl && new URL(current).href !== new URL(requestedUrl).href) {
      this.redirectCount += 1;
    }
    this.options.onNavigation(current, this.redirectCount);
    this.sawApplicationPage = true;
  }

  /** Same registrable domain as the product (the first allowed origin); unknown product counts as same. */
  private onProductSite(url: string): boolean {
    const product = this.options.allowedOrigins[0];
    if (!product) return true;
    try {
      const domain = (value: string) =>
        getDomain(new URL(value).hostname, { allowPrivateDomains: true }) ?? new URL(value).hostname;
      return domain(url) === domain(product);
    } catch {
      return true;
    }
  }

  private async command<T>(operation: string, execute: () => Promise<T>): Promise<T> {
    try {
      const result = await execute();
      this.trace.push({
        at: this.now().toISOString(),
        operation,
        ...(operation === "navigate" ? { origin: "approved-origin" } : {}),
        status: "succeeded",
      });
      return result;
    } catch (error) {
      this.trace.push({ at: this.now().toISOString(), operation, status: "failed" });
      if (
        error instanceof WebDriverProtocolError &&
        ["invalid cookie domain", "no such cookie"].includes(error.code)
      ) {
        throw new CaptureSessionError("reauth_required");
      }
      throw error;
    }
  }
}

function isLoginField(locator: CaptureLocator): boolean {
  return (
    locator.strategy === "field" &&
    (locator.value === "email" || locator.value === "password" || locator.value === "submit")
  );
}

function isAuthenticationUrl(value: string): boolean {
  const path = new URL(value).pathname.toLocaleLowerCase();
  return /(^|\/)(login|log-in|signin|sign-in|mfa|verify|verification)(\/|$)/u.test(path);
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function isOriginRoot(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === "/" || path === "";
  } catch {
    return false;
  }
}

/** Visible copy and frames Cloudflare / Clerk use when they halt an automated browser. */
export function pageLooksLikeBotChallenge(snapshot: {
  text?: string;
  challengeFrame?: boolean;
}): boolean {
  if (snapshot.challengeFrame) return true;
  return /verify you are (a )?human|security confirmation|checking your browser|incompatible browser extension|attention required|confirma[cç][aã]o de seguran[cç]a|verifique se voc[eê] [eé] humano|verificando seu navegador|\bray id\b/i.test(
    snapshot.text ?? "",
  );
}

/** Maps a CSS cursor keyword onto the shapes worth drawing. */
export function pointerShapeFor(cursor: unknown): CapturePointerShape {
  if (typeof cursor !== "string") return "arrow";
  if (cursor === "pointer" || cursor === "grab" || cursor === "grabbing") return "hand";
  if (cursor === "text" || cursor === "vertical-text") return "text";
  return "arrow";
}

const ENTER_KEY = '\uE007';
function locatorXpath(locator: CaptureLocator): string {
  const value = xpathLiteral(locator.value);
  switch (locator.strategy) {
    case "testId":
      return `//*[@data-testid=${value}]`;
    case "label":
      return `//*[@id=//label[normalize-space(.)=${value}]/@for] | //label[normalize-space(.)=${value}]//*[self::input or self::textarea or self::select]`;
    case "role": {
      const separator = locator.value.indexOf(":");
      if (separator > 0) {
        const role = xpathLiteral(locator.value.slice(0, separator).trim());
        const name = xpathLiteral(locator.value.slice(separator + 1).trim());
        return `//*[@role=${role} and (@aria-label=${name} or normalize-space(.)=${name})]`;
      }
      return `//*[@aria-label=${value} or normalize-space(.)=${value}]`;
    }
    case "text":
      return `//*[normalize-space(.)=${value}]`;
    case "field":
      return fieldXpath(locator.value);
  }
}

function webDriverCookie(value: unknown): BrowserStorageState["cookies"][number] | null {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.value !== "string") {
    return null;
  }
  if (value.name.length === 0 || value.name.length > 500 || value.value.length > 10_000) {
    return null;
  }
  const sameSite =
    value.sameSite === "Strict" || value.sameSite === "Lax" || value.sameSite === "None"
      ? value.sameSite
      : value.sameSite === "strict"
        ? "Strict"
        : value.sameSite === "none"
          ? "None"
          : "Lax";
  const expires =
    typeof value.expiry === "number"
      ? value.expiry
      : typeof value.expires === "number"
        ? value.expires
        : undefined;
  if (typeof value.domain !== "string" || value.domain.length === 0 || value.domain.length > 255) {
    return null;
  }
  return {
    name: value.name,
    value: value.value,
    domain: value.domain,
    path: typeof value.path === "string" && value.path.length > 0 ? value.path : "/",
    httpOnly: value.httpOnly === true,
    secure: value.secure !== false,
    sameSite,
    ...(expires === undefined ? {} : { expires }),
  };
}

/**
 * Semantic form-control lookup. Each kind lists the attribute spellings real sign-in forms use, so
 * one recipe works against Clerk, Auth0 and a hand-written form in any language.
 */
function fieldXpath(kind: string): string {
  switch (kind) {
    case "email":
      return "//input[@type='email' or @name='email' or @name='identifier' or @name='username' or @autocomplete='username' or @autocomplete='email']";
    case "password":
      return "//input[@type='password' or @name='password' or @autocomplete='current-password' or @autocomplete='new-password']";
    case "submit":
      return "//button[@type='submit'] | //input[@type='submit'] | //button[@data-localization-key='formButtonPrimary']";
    case "password-strategy":
      return "//button[contains(@data-localization-key,'password') or contains(@data-localization-key,'Password')] | //a[contains(@data-localization-key,'password')]";
    case "code":
      return "//input[@autocomplete='one-time-code' or @name='otp' or @name='code' or @name='verificationCode' or @name='token' or @id='otp' or @id='code' or @inputmode='numeric']";
    default:
      throw new WebDriverProtocolError("unsupported_field_kind");
  }
}

function fieldCssSelectors(kind: string): string[] {
  switch (kind) {
    case "email":
      return [
        "input[type='email']",
        "input[name='email']",
        "input[name='identifier']",
        "input[name='username']",
        "input[autocomplete='username']",
        "input[autocomplete='email']",
      ];
    case "password":
      return [
        "input[type='password']",
        "input[name='password']",
        "input[autocomplete='current-password']",
        "input[autocomplete='new-password']",
      ];
    case "code":
      return [
        "input[autocomplete='one-time-code']",
        "input[name='otp']",
        "input[name='code']",
        "input[name='verificationCode']",
        "input[name='token']",
        "input[inputmode='numeric']",
      ];
    case "submit":
      return [
        "button[type='submit']",
        "input[type='submit']",
        "button[data-localization-key='formButtonPrimary']",
      ];
    case "password-strategy":
      return [
        "button[data-localization-key*='password']",
        "button[data-localization-key*='Password']",
        "a[data-localization-key*='password']",
      ];
    default:
      return [];
  }
}

const findDeepFieldScript = `const selectors=arguments[0];
const visible=(el)=>{if(el.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)!==0};
const search=(root)=>{
  for (const sel of selectors) {
    let nodes; try { nodes=root.querySelectorAll(sel); } catch { continue; }
    for (const el of nodes) { if (visible(el)) return el; }
  }
  const tree=root.querySelectorAll?root.querySelectorAll('*'):[];
  for (const el of tree) { if (el.shadowRoot) { const found=search(el.shadowRoot); if (found) return found; } }
  return null;
};
return search(document);`;

const revealPasswordStrategyScript = `const visible=(el)=>{if(el.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
const isStrategy=(el)=>{
  const key=(el.getAttribute('data-localization-key')||'').toLowerCase();
  if (key.includes('forgot') || key.includes('reset')) return false;
  if (key.includes('password')) return true;
  const text=(el.innerText||el.textContent||'').trim().toLowerCase();
  return /^(use password|usar senha|password|senha)$/.test(text);
};
const search=(root)=>{
  const nodes=root.querySelectorAll?root.querySelectorAll('button,a,[role=button]'):[];
  for (const el of nodes) { if (visible(el) && isStrategy(el)) return el; }
  const tree=root.querySelectorAll?root.querySelectorAll('*'):[];
  for (const el of tree) { if (el.shadowRoot) { const found=search(el.shadowRoot); if (found) return found; } }
  return null;
};
const button=search(document);
if (!button) return false;
button.click();
return true;`;

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map(
      (part, index, parts) =>
        `${index > 0 ? `,"'",` : ""}'${part}'${index === parts.length - 1 ? "" : ""}`,
    )
    .join("")})`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { isPublicNetworkAddress } from "./host-policy.js";

// Return authentication evidence only, never field values, tokens, names or page text.
const connectionEvidenceScript = `
const roots=[document];
const visible=e=>{if(e.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
for(let i=0;i<roots.length&&i<30;i++) for(const e of roots[i].querySelectorAll('*')) {
  if(e.shadowRoot) roots.push(e.shadowRoot);
  if(e.tagName==='IFRAME') {try{if(e.contentDocument) roots.push(e.contentDocument)}catch{}}
}
const controls=roots.flatMap(root=>[...root.querySelectorAll('input,button,a,[role=button],[role=alert],.cl-formFieldErrorText')]).filter(visible);
const label=e=>(e.innerText||e.getAttribute('aria-label')||e.textContent||'').trim();
const password=controls.some(e=>e.tagName==='INPUT'&&e.type==='password');
const identifier=controls.some(e=>e.tagName==='INPUT'&&(/email|username/.test(e.autocomplete)||/email|identifier|username/.test(e.name)||e.type==='email'));
const alerts=controls.filter(e=>e.matches('[role=alert],.cl-formFieldErrorText')).map(label).join(' ');
const rejected=/incorrect|invalid password|invalid credentials|wrong password|couldn.t find your account|incorret|senha inv[aá]lida|credenciais inv[aá]lidas/i.test(alerts);
const challenge=controls.some(e=>e.tagName==='INPUT'&&(e.autocomplete==='one-time-code'||/^(otp|verificationCode|code)$/.test(e.name)))||/captcha|verifique.*humano|verify.*human/i.test(alerts);
const logout=controls.some(e=>/^(sign out|log out|logout|sair|desconectar)(\\s|$)/i.test(label(e)));
const clerk=window.Clerk;
const signedIn=clerk ? Boolean(clerk.loaded&&clerk.session&&clerk.session.status==='active') : Boolean(logout&&!password&&!identifier);
const loginLinks=controls.filter(e=>e.tagName==='A'&&/sign.?in|log.?in|entrar|acessar/i.test(label(e))).map(e=>e.href).filter(Boolean).slice(0,5);
return {signedIn,rejected,challenge,loginLinks};`;
