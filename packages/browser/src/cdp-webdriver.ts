/**
 * A WebDriver transport implemented with Chrome DevTools Protocol commands on one tab.
 *
 * The Toru extension drives the user's own Chrome through `chrome.debugger`, which speaks CDP, while the
 * browser driver (and every behavior Toru relies on: human typing, eased pointer travel, telemetry, redaction,
 * navigation checks) is written against WebDriver. This translates the small set of WebDriver endpoints the
 * driver uses into CDP, so the same driver runs unchanged. It has no Node dependencies.
 */
import { WebDriverProtocolError, type WebDriverTransport } from "./webdriver.js";

/** One attached tab: `chrome.debugger` in the extension, a DevTools WebSocket in tests. */
export interface DebuggerChannel {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}

const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const sessionId = "cdp";
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** WebDriver's private-use key code points mapped to the CDP key events Chrome expects. */
const specialKeys: Record<string, { key: string; code: string; keyCode: number; text?: string; modifier?: number }> = {
  "": { key: "Backspace", code: "Backspace", keyCode: 8 },
  "": { key: "Tab", code: "Tab", keyCode: 9 },
  "": { key: "Enter", code: "NumpadEnter", keyCode: 13, text: "\r" },
  "": { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  "": { key: "Shift", code: "ShiftLeft", keyCode: 16, modifier: 8 },
  "": { key: "Control", code: "ControlLeft", keyCode: 17, modifier: 2 },
  "": { key: "Alt", code: "AltLeft", keyCode: 18, modifier: 1 },
  "": { key: "Escape", code: "Escape", keyCode: 27 },
  "": { key: " ", code: "Space", keyCode: 32, text: " " },
  "": { key: "PageUp", code: "PageUp", keyCode: 33 },
  "": { key: "PageDown", code: "PageDown", keyCode: 34 },
  "": { key: "End", code: "End", keyCode: 35 },
  "": { key: "Home", code: "Home", keyCode: 36 },
  "": { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  "": { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  "": { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  "": { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  "": { key: "Insert", code: "Insert", keyCode: 45 },
  "": { key: "Delete", code: "Delete", keyCode: 46 },
  "": { key: "Meta", code: "MetaLeft", keyCode: 91, modifier: 4 },
};

function keyEvent(value: string) {
  const special = specialKeys[value];
  if (special) return special;
  const upper = value.toUpperCase();
  const letter = /^[a-z]$/i.test(value), digit = /^[0-9]$/.test(value);
  return {
    key: value,
    code: letter ? `Key${upper}` : digit ? `Digit${value}` : "",
    keyCode: letter ? upper.charCodeAt(0) : digit ? value.charCodeAt(0) : 0,
    text: value,
  };
}

/**
 * Runs in the page. Elements cross the protocol as WebDriver element references; the page keeps the
 * mapping under a registry key, as a browser's own WebDriver implementation does internally.
 */
const pageRuntime = `
const R=globalThis[Symbol.for('toru.webdriver')]??=(()=>{const map=new Map(),ids=new WeakMap();let next=1;return {map,ids,id(e){let v=ids.get(e);if(!v){v='e'+(next++);ids.set(e,v);map.set(v,new WeakRef(e));}return v;}};})();
const KEY=${JSON.stringify(elementKey)};
const decode=v=>{if(Array.isArray(v))return v.map(decode);if(v&&typeof v==='object'){if(typeof v[KEY]==='string'){const e=R.map.get(v[KEY])?.deref();if(!e||!e.isConnected)throw new Error('toru:stale element reference');return e;}const o={};for(const k of Object.keys(v))o[k]=decode(v[k]);return o;}return v;};
const encode=(v,d=0)=>{if(d>20)return null;if(v instanceof Element)return {[KEY]:R.id(v)};if(v instanceof NodeList||v instanceof HTMLCollection)v=Array.from(v);if(Array.isArray(v))return v.map(x=>encode(x,d+1));if(v&&typeof v==='object'){if(v instanceof Node||v instanceof Window)return null;const o={};for(const k of Object.keys(v))o[k]=encode(v[k],d+1);return o;}return v===undefined?null:v;};
`;

type Context = { id: number; frameId: string };

export class CdpWebDriverTransport implements WebDriverTransport {
  private viewport = { width: 1280, height: 720 };
  private contexts = new Map<string, number>();
  /** The frame WebDriver is switched to; null is the top-level document. */
  private frameId: string | null = null;
  private mainFrameId: string | null = null;
  private pointer = { x: 0, y: 0, buttons: 0, lastDown: 0, clickCount: 0 };
  private modifiers = 0;
  private started = false;
  private readonly unsubscribe: () => void;
  private loadWaiters: Array<() => void> = [];
  private readonly scale: number;

  constructor(
    private readonly channel: DebuggerChannel,
    private readonly options: {
      /** Advertised as goog:chromeOptions.debuggerAddress so the driver records through a screencast. */
      debuggerAddress?: string;
      /** CDP commands the driver may send through goog/cdp/execute. Anything else is refused. */
      allowedCdpCommands?: readonly string[];
      /**
       * Device pixels per CSS pixel the tab renders at. The CSS viewport, every coordinate and the page's layout
       * stay the same; only the picture gets denser, so a screencast asked for viewport × scale is that sharp.
       * WebDriver screenshots (what the navigator observes) stay one pixel per CSS pixel. Defaults to 1. May be
       * fractional (1920 CSS pixels at 4/3 are 2560 device pixels).
       */
      deviceScaleFactor?: number;
      /**
       * The widest a WebDriver screenshot is, in pixels: a wider viewport is scaled down into it (a 1920x1080 viewport
       * observed as 1280x720), a narrower one is never scaled up. Coordinates stay CSS pixels of the viewport. Absent
       * means one pixel per CSS pixel at any width.
       */
      observationWidth?: number;
      /**
       * Scales a PNG (base64) to `width`×`height` and returns it as PNG base64. When given, a scaled observation is
       * the viewport captured as the tab already renders it, scaled here. Without it, Chrome scales the capture
       * itself (a clip with a scale), which re-renders the tab at that scale for a moment: a live screencast streams
       * that shrunk frame, and on a page that does not repaint it stays in the recording until the next change.
       */
      downscale?: (png: string, width: number, height: number) => Promise<string>;
    } = {},
  ) {
    const scale = options.deviceScaleFactor ?? 1;
    if (!(Number.isFinite(scale) && scale >= 1 && scale <= 3)) throw new RangeError("deviceScaleFactor must be between 1 and 3");
    this.scale = scale;
    this.unsubscribe = channel.onEvent((method, params) => {
      if (method === "Runtime.executionContextCreated") {
        const context = params.context as { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
        if (context.auxData?.isDefault && context.auxData.frameId) this.contexts.set(context.auxData.frameId, context.id);
      } else if (method === "Runtime.executionContextDestroyed") {
        for (const [frame, id] of this.contexts) if (id === params.executionContextId) this.contexts.delete(frame);
      } else if (method === "Runtime.executionContextsCleared") {
        this.contexts.clear();
      } else if (method === "Page.loadEventFired") {
        this.loadWaiters.splice(0).forEach((done) => done());
      }
    });
  }

  close() { this.unsubscribe(); }

  async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    if (method === "POST" && path === "/session") return this.createSession();
    const prefix = `/session/${sessionId}`;
    if (!path.startsWith(prefix)) throw new WebDriverProtocolError("invalid session id");
    const route = path.slice(prefix.length) || "/";
    const input = isObject(body) ? body : {};
    const element = /^\/element\/([^/]+)(?:\/(.+))?$/.exec(route);
    if (method === "DELETE" && route === "/") return null;
    if (route === "/url") return method === "GET" ? this.evaluate("return location.href;", []) : this.navigate(String(input.url));
    if (route === "/execute/sync" && method === "POST") return this.evaluate(String(input.script ?? ""), Array.isArray(input.args) ? input.args : []);
    if (route === "/elements" && method === "POST") return this.findElements(String(input.using), String(input.value));
    if (route === "/element/active" && method === "GET") return this.evaluate("return document.activeElement;", []);
    if (route === "/actions" && method === "POST") return this.performActions(Array.isArray(input.actions) ? input.actions : []);
    if (route === "/screenshot" && method === "GET") return this.screenshot();
    if (route === "/window/rect") return method === "GET" ? { x: 0, y: 0, ...this.viewport } : this.resize(input);
    if (route === "/window" && method === "GET") return "toru-tab";
    if (route === "/window" && method === "POST") { if (input.handle !== "toru-tab") throw new WebDriverProtocolError("no such window"); return null; }
    if (route === "/frame" && method === "POST") return this.switchFrame(input.id);
    if (route === "/frame/parent" && method === "POST") return this.switchToParentFrame();
    // Cookies stay in the user's browser: nothing is exported from the extension.
    if (route === "/cookie" && method === "GET") return [];
    if (route === "/goog/cdp/execute" && method === "POST") return this.cdp(String(input.cmd), isObject(input.params) ? input.params : {});
    if (element) return this.elementCommand(method, element[1]!, element[2] ?? "", input);
    throw new WebDriverProtocolError("unknown command");
  }

  private async createSession() {
    if (!this.started) {
      this.started = true;
      await this.channel.send("Page.enable");
      await this.channel.send("Runtime.enable");
      const tree = await this.channel.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
      this.mainFrameId = tree.frameTree.frame.id;
      const metrics = await this.channel.send("Page.getLayoutMetrics") as { cssVisualViewport?: { clientWidth: number; clientHeight: number } };
      if (metrics.cssVisualViewport) this.viewport = { width: Math.round(metrics.cssVisualViewport.clientWidth), height: Math.round(metrics.cssVisualViewport.clientHeight) };
    }
    return { sessionId, capabilities: { browserName: "chrome", ...(this.options.debuggerAddress ? { "goog:chromeOptions": { debuggerAddress: this.options.debuggerAddress } } : {}) } };
  }

  private async contextId(): Promise<number | undefined> {
    const frame = this.frameId ?? this.mainFrameId;
    if (!frame) return undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = this.contexts.get(frame);
      if (id !== undefined) return id;
      await delay(20);
    }
    if (this.frameId) throw new WebDriverProtocolError("no such frame");
    return undefined;
  }

  /** WebDriver's execute/sync: a function body with `arguments`, element references in and out. */
  private async evaluate(script: string, args: unknown[]): Promise<unknown> {
    const expression = `(async()=>{${pageRuntime}const args=decode(${JSON.stringify(args)});const value=await (function(){${script}\n}).apply(null,args);return encode(value);})()`;
    const contextId = await this.contextId();
    const result = await this.channel.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId !== undefined ? { contextId } : {}) }) as {
      result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (result.exceptionDetails) {
      const text = `${result.exceptionDetails.exception?.description ?? ""} ${result.exceptionDetails.text ?? ""}`;
      throw new WebDriverProtocolError(text.includes("toru:stale element reference") ? "stale element reference" : "javascript error", text.trim().split("\n")[0]?.slice(0, 200) || undefined);
    }
    return result.result?.value ?? null;
  }

  private async findElements(using: string, value: string) {
    if (using === "xpath") {
      return this.evaluate("const r=document.evaluate(arguments[0],document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);const out=[];for(let i=0;i<r.snapshotLength;i++){const n=r.snapshotItem(i);if(n instanceof Element)out.push(n);}return out;", [value]);
    }
    if (using === "css selector") return this.evaluate("return Array.from(document.querySelectorAll(arguments[0]));", [value]);
    throw new WebDriverProtocolError("invalid argument");
  }

  private async navigate(url: string) {
    const loaded = new Promise<void>((done) => { this.loadWaiters.push(done); setTimeout(done, 30_000); });
    const result = await this.channel.send("Page.navigate", { url }) as { errorText?: string; loaderId?: string };
    if (result.errorText) throw new WebDriverProtocolError("unknown error", `navigation failed: ${result.errorText}`);
    // A same-document navigation (hash) has no loader and fires no load event.
    if (result.loaderId) await loaded;
    this.frameId = null;
    return null;
  }

  private async screenshot() {
    const observed = observationScale(this.viewport.width, this.options.observationWidth);
    if (this.scale === 1 && observed === 1) return (await this.channel.send("Page.captureScreenshot", { format: "png" }) as { data: string }).data;
    if (this.options.downscale) {
      const rendered = (await this.channel.send("Page.captureScreenshot", { format: "png" }) as { data: string }).data;
      return this.options.downscale(rendered, Math.round(this.viewport.width * observed), Math.round(this.viewport.height * observed));
    }
    // At a higher device scale Chrome captures device pixels. The navigator reads its observation at one pixel per CSS
    // pixel of the viewport, or narrower when the viewport is wider than observationWidth, so the picture is a clip in
    // document coordinates (where the viewport is scrolled to) scaled by that over the device scale.
    const metrics = await this.channel.send("Page.getLayoutMetrics") as { cssVisualViewport?: { pageX?: number; pageY?: number } };
    const clip = { x: metrics.cssVisualViewport?.pageX ?? 0, y: metrics.cssVisualViewport?.pageY ?? 0, ...this.viewport, scale: observed / this.scale };
    return (await this.channel.send("Page.captureScreenshot", { format: "png", clip }) as { data: string }).data;
  }

  private async resize(input: Json) {
    const width = Math.round(Number(input.width)), height = Math.round(Number(input.height));
    if (!(width >= 320 && width <= 3840 && height >= 240 && height <= 2160)) throw new WebDriverProtocolError("invalid argument");
    // The recording tab renders at exactly this CSS viewport, independent of the user's window size.
    await this.channel.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: this.scale, mobile: false });
    this.viewport = { width, height };
    return { x: 0, y: 0, width, height };
  }

  private async switchFrame(id: unknown) {
    if (id === null || id === undefined) { this.frameId = null; return null; }
    if (!isObject(id) || typeof id[elementKey] !== "string") throw new WebDriverProtocolError("no such frame");
    const contextId = await this.contextId();
    const found = await this.channel.send("Runtime.evaluate", {
      expression: `(()=>{${pageRuntime}return decode(${JSON.stringify(id)});})()`, ...(contextId !== undefined ? { contextId } : {}),
    }) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    if (found.exceptionDetails || !found.result?.objectId) throw new WebDriverProtocolError("stale element reference");
    const node = await this.channel.send("DOM.describeNode", { objectId: found.result.objectId }) as { node?: { frameId?: string; nodeName?: string } };
    const frame = node.node?.frameId;
    if (!frame || !["IFRAME", "FRAME"].includes(node.node?.nodeName ?? "")) throw new WebDriverProtocolError("no such frame");
    // Cross-origin frames run out of process and have no context here: report them as unavailable.
    if (!this.contexts.has(frame)) throw new WebDriverProtocolError("no such frame");
    this.frameId = frame;
    return null;
  }

  private async switchToParentFrame() {
    if (!this.frameId) return null;
    const tree = await this.channel.send("Page.getFrameTree") as { frameTree: FrameTree };
    this.frameId = parentOf(tree.frameTree, this.frameId) ?? null;
    if (this.frameId === this.mainFrameId) this.frameId = null;
    return null;
  }

  private async elementCommand(method: string, id: string, action: string, input: Json) {
    const reference = [{ [elementKey]: id }];
    if (method === "GET" && action === "displayed") {
      return this.evaluate("const e=arguments[0];const s=getComputedStyle(e);const r=e.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)>0&&r.width>0&&r.height>0;", reference);
    }
    const attribute = /^attribute\/(.+)$/.exec(action);
    if (method === "GET" && attribute) return this.evaluate("return arguments[0].getAttribute(arguments[1]);", [...reference, attribute[1]]);
    if (method === "POST" && action === "click") {
      const point = await this.evaluate("const e=arguments[0];e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};", reference);
      if (!isObject(point)) throw new WebDriverProtocolError("element not interactable");
      const offset = await this.frameOffset();
      await this.click(Number(point.x) + offset.x, Number(point.y) + offset.y);
      return null;
    }
    if (method === "POST" && action === "clear") {
      await this.evaluate("const e=arguments[0];e.focus();if('value' in e){const p=Object.getPrototypeOf(e);const d=Object.getOwnPropertyDescriptor(p,'value');d&&d.set?d.set.call(e,''):(e.value='');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}else if(e.isContentEditable){e.textContent='';e.dispatchEvent(new Event('input',{bubbles:true}));}return null;", reference);
      return null;
    }
    if (method === "POST" && action === "value") {
      await this.evaluate("arguments[0].focus();return null;", reference);
      const text = typeof input.text === "string" ? input.text : Array.isArray(input.value) ? input.value.join("") : "";
      for (const character of Array.from(text)) await this.typeKey(character);
      return null;
    }
    throw new WebDriverProtocolError("unknown command");
  }

  /** Viewport offset of the switched-to frame, so element coordinates become page input coordinates. */
  private async frameOffset() {
    if (!this.frameId) return { x: 0, y: 0 };
    const owner = await this.channel.send("DOM.getFrameOwner", { frameId: this.frameId }) as { backendNodeId?: number };
    if (!owner.backendNodeId) return { x: 0, y: 0 };
    const box = await this.channel.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }) as { model?: { content: number[] } };
    const content = box.model?.content;
    return content ? { x: content[0]!, y: content[1]! } : { x: 0, y: 0 };
  }

  private async mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, button: "left" | "middle" | "right" | "none" = "none", clickCount = 0) {
    await this.channel.send("Input.dispatchMouseEvent", { type, x, y, button, buttons: this.pointer.buttons, clickCount, modifiers: this.modifiers, pointerType: "mouse" });
  }

  private async click(x: number, y: number) {
    await this.mouse("mouseMoved", x, y);
    this.pointer = { ...this.pointer, x, y, buttons: 1 };
    await this.mouse("mousePressed", x, y, "left", 1);
    this.pointer.buttons = 0;
    await this.mouse("mouseReleased", x, y, "left", 1);
  }

  private async typeKey(value: string) {
    const event = keyEvent(value);
    if (event.modifier) {
      this.modifiers |= event.modifier;
      await this.channel.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: this.modifiers });
      return;
    }
    const text = event.text && !(this.modifiers & (2 | 4)) ? event.text : undefined;
    await this.channel.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: this.modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.channel.send("Input.dispatchKeyEvent", { type: "keyUp", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: this.modifiers });
  }

  /** W3C actions, tick by tick: every input source's nth action runs together and the tick lasts the longest. */
  private async performActions(sources: unknown[]) {
    const lanes = sources.filter(isObject).map((source) => ({ type: String(source.type), actions: Array.isArray(source.actions) ? source.actions.filter(isObject) : [] }));
    const ticks = Math.max(0, ...lanes.map((lane) => lane.actions.length));
    for (let tick = 0; tick < ticks; tick++) {
      const work: Array<Promise<void>> = [];
      let tickDuration = 0;
      for (const lane of lanes) {
        const action = lane.actions[tick];
        if (!action) continue;
        const duration = Math.max(0, Number(action.duration ?? 0)) || 0;
        tickDuration = Math.max(tickDuration, duration);
        work.push(this.performAction(lane.type, action, duration));
      }
      const started = Date.now();
      await Promise.all(work);
      const remaining = tickDuration - (Date.now() - started);
      if (remaining > 0) await delay(remaining);
    }
    return null;
  }

  private async performAction(type: string, action: Json, duration: number) {
    if (action.type === "pause") return;
    if (type === "key") {
      const value = String(action.value ?? "");
      if (action.type === "keyDown") {
        const event = keyEvent(value);
        if (event.modifier) { this.modifiers |= event.modifier; await this.channel.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: this.modifiers }); return; }
        const text = event.text && !(this.modifiers & (2 | 4)) ? event.text : undefined;
        await this.channel.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: this.modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
      } else if (action.type === "keyUp") {
        const event = keyEvent(value);
        await this.channel.send("Input.dispatchKeyEvent", { type: "keyUp", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: this.modifiers });
        if (event.modifier) this.modifiers &= ~event.modifier;
      }
      return;
    }
    if (type === "pointer") {
      const button = (["left", "middle", "right"] as const)[Number(action.button ?? 0)] ?? "left";
      if (action.type === "pointerMove") {
        const x = Number(action.x ?? 0), y = Number(action.y ?? 0);
        if (action.origin !== undefined && action.origin !== "viewport") throw new WebDriverProtocolError("invalid argument");
        // Interpolate like a browser's WebDriver: one move per animation frame across the duration.
        const steps = Math.max(1, Math.round(duration / 16));
        const from = { x: this.pointer.x, y: this.pointer.y };
        for (let step = 1; step <= steps; step++) {
          const at = { x: from.x + (x - from.x) * step / steps, y: from.y + (y - from.y) * step / steps };
          await this.mouse("mouseMoved", at.x, at.y);
          if (step < steps) await delay(duration / steps);
        }
        this.pointer.x = x; this.pointer.y = y;
      } else if (action.type === "pointerDown") {
        const now = Date.now();
        this.pointer.clickCount = now - this.pointer.lastDown < 500 ? this.pointer.clickCount + 1 : 1;
        this.pointer.lastDown = now;
        this.pointer.buttons |= button === "left" ? 1 : button === "right" ? 2 : 4;
        await this.mouse("mousePressed", this.pointer.x, this.pointer.y, button, this.pointer.clickCount);
      } else if (action.type === "pointerUp") {
        this.pointer.buttons &= ~(button === "left" ? 1 : button === "right" ? 2 : 4);
        await this.mouse("mouseReleased", this.pointer.x, this.pointer.y, button, this.pointer.clickCount);
      }
      return;
    }
    if (type === "wheel" && action.type === "scroll") {
      await this.channel.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Number(action.x ?? this.pointer.x), y: Number(action.y ?? this.pointer.y), deltaX: Number(action.deltaX ?? 0), deltaY: Number(action.deltaY ?? 0), modifiers: this.modifiers });
      if (duration > 0) await delay(duration);
    }
  }

  private async cdp(command: string, params: Json) {
    const allowed = this.options.allowedCdpCommands ?? ["Emulation.setDeviceMetricsOverride"];
    // Storage restore with an empty state sends nothing; any other command, cookies included, is refused.
    if (!allowed.includes(command)) throw new WebDriverProtocolError("unknown command");
    return this.channel.send(command, params);
  }
}

/** Screenshot pixels per CSS pixel: 1, or less when the viewport is wider than the observation may be. */
export function observationScale(viewportWidth: number, observationWidth: number | undefined): number {
  if (!observationWidth || !(viewportWidth > observationWidth)) return 1;
  return observationWidth / viewportWidth;
}

type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
function parentOf(tree: FrameTree, frameId: string, parent?: string): string | undefined {
  if (tree.frame.id === frameId) return parent;
  for (const child of tree.childFrames ?? []) {
    const found = parentOf(child, frameId, tree.frame.id);
    if (found !== undefined) return found;
  }
  return undefined;
}
