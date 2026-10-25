"use client";
import { useCallback, useEffect, useState } from "react";
import chromeJson from "../public/downloads/chrome.json";
import { macRelease } from "../lib/mac-release";
import { demoPrompt, type PromptRoute } from "./demo-status";
import { BrandLook } from "./brand-look";
import { CLIENTS, type Client } from "./agent-setup";
import { ToruOrb } from "./toru-orb";

export { CLIENTS };

/** The two ways to record: the user's own Chrome (Toru for Chrome) or their Mac (Toru for Mac). Each gets its own setup step. */
export type Path = "chrome" | "mac";
export type Step = "path" | "connect" | "chrome" | "mac" | "brand" | "prompt";
export const PATH_STEPS: Record<Path, Step[]> = {
  chrome: ["path", "connect", "chrome", "brand", "prompt"],
  mac: ["path", "connect", "mac", "prompt"],
};
const ALL_STEPS: Step[] = ["path", "connect", "chrome", "mac", "brand", "prompt"];
export function parseStep(search: string): Step {
  const value = new URLSearchParams(search).get("step");
  return ALL_STEPS.includes(value as Step) ? value as Step : "path";
}
export function parsePath(search: string): Path | undefined {
  const value = new URLSearchParams(search).get("path");
  return value === "chrome" || value === "mac" ? value : undefined;
}
/** The step after `step` on a path; the device step of the other path is never shown. */
export function nextStep(path: Path, step: Step): Step {
  const steps = PATH_STEPS[path], index = steps.indexOf(step);
  return index < 0 ? steps[1]! : steps[Math.min(index + 1, steps.length - 1)]!;
}
export function previousStep(path: Path, step: Step): Step {
  const steps = PATH_STEPS[path], index = steps.indexOf(step);
  return index <= 0 ? "path" : steps[index - 1]!;
}


const originOf = (value: string) => { try { const url = new URL(value.trim().startsWith("http") ? value.trim() : `https://${value.trim()}`); return url.protocol === "https:" ? url.origin : undefined; } catch { return undefined; } };

function Copyable({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="ob-code"><code>{code}</code><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy"}</button></div>;
}

type ChromeDevice = { connectionId: string; name: string; status: "ready" | "in_use" | "offline" };
type MacDevice = { id: string; name: string; status: "ready" | "in_use" | "awaiting_approval" | "offline" | "revoked"; control?: boolean };
type MacSetup = { pairingCode: string; setupUrl: string; expiresAt: string };
const chromeRelease = chromeJson as { version?: string; webStoreUrl?: string | null };
const lastPathKey = "toru.onboarding.path";
const rememberedPath = (): Path | undefined => { try { const value = window.localStorage.getItem(lastPathKey); return value === "chrome" || value === "mac" ? value : undefined; } catch { return undefined; } };

/** Polls a device list while `active`, so each setup step shows the browser or Mac arriving. */
function usePolled<T>(url: string, active: boolean, read: (body: Record<string, unknown>) => T): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const check = async () => {
      try { const response = await fetch(url, { cache: "no-store", signal: controller.signal }); if (response.ok) setValue(read(await response.json() as Record<string, unknown>)); } catch { /* keep the last state */ }
    };
    void check(); const timer = setInterval(check, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, active]);
  return value;
}

/**
 * The first-run flow. The user picks how to record (their Chrome or their Mac), connects their agent, sets up
 * that path's device, adds a brand for web products, and copies the first prompt.
 * `onFinish` persists completion on the account; `mode="new"` reuses the last screen for "New demo".
 */
export function OnboardingFlow({ onFinish, mode = "setup" }: { onFinish: () => Promise<void> | void; mode?: "setup" | "new" }) {
  const [step, setStepState] = useState<Step>(mode === "new" ? "prompt" : "path");
  const [path, setPath] = useState<Path>();
  const [client, setClient] = useState<Client>("claude-code"), [clip, setClip] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [domain, setDomain] = useState(""), [accent, setAccent] = useState("#405f6d"), [logo, setLogo] = useState<string>();
  const [background, setBackground] = useState<string | undefined>("toru-sky"), [padding, setPadding] = useState(30);
  const [flow, setFlow] = useState(""), [app, setApp] = useState(""), [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const [connectUrl, setConnectUrl] = useState(""), [macSetup, setMacSetup] = useState<MacSetup>(), [codeCopied, setCodeCopied] = useState(false);
  useEffect(() => {
    const search = window.location.search, fromUrl = parsePath(search);
    if (mode === "setup") setStepState(parseStep(search));
    setPath(fromUrl ?? (mode === "new" ? rememberedPath() ?? "chrome" : undefined));
    // The landing page's ask box hands over what the visitor typed and the agent they picked.
    const params = new URLSearchParams(search), landingFlow = params.get("flow"), landingClient = params.get("client");
    if (landingFlow) setFlow(landingFlow.slice(0, 600));
    if (landingClient && landingClient in CLIENTS) setClient(landingClient as Client);
  }, [mode]);
  const go = useCallback((next: Step, nextPath: Path | undefined = path) => {
    setStepState(next); setNote("");
    if (nextPath !== path) setPath(nextPath);
    if (nextPath) try { window.localStorage.setItem(lastPathKey, nextPath); } catch { /* a remembered choice is optional */ }
    if (mode === "setup") window.history.replaceState(null, "", `?${nextPath ? `path=${nextPath}&` : ""}step=${next}`);
    window.scrollTo({ top: 0 });
  }, [mode, path]);
  const steps = PATH_STEPS[path ?? "chrome"], index = steps.indexOf(step);
  const forward = () => go(nextStep(path ?? "chrome", step)), back = () => go(previousStep(path ?? "chrome", step));

  // The connect step watches for the agent's first connection, so the user sees it land.
  useEffect(() => {
    if (step !== "connect") return;
    const controller = new AbortController();
    const check = async () => {
      try { const response = await fetch("/api/connections", { cache: "no-store", signal: controller.signal }); if (response.ok) setConnected(Boolean((await response.json() as { connected?: boolean }).connected)); } catch { /* keep the last state */ }
    };
    void check(); const timer = setInterval(check, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [step]);
  const chrome = usePolled("/api/extension-devices", step === "path" || step === "chrome", body => ({ available: body.available === true, devices: (Array.isArray(body.devices) ? body.devices : []) as ChromeDevice[] }));
  const macs = usePolled("/api/devices", step === "mac", body => ((Array.isArray(body.devices) ? body.devices : []) as MacDevice[]).filter(device => device.status !== "revoked"));
  const chromeReady = chrome?.devices.find(device => device.status !== "offline");
  const mac = macs?.find(device => device.control) ?? macs?.find(device => device.status !== "offline") ?? macs?.[0];
  const chromeClosed = chrome !== null && !chrome.available;

  const origin = originOf(domain);
  const target = origin ?? "";
  const route: PromptRoute = path ?? "chrome";
  const prompt = demoPrompt({ url: target, flow, route, app });

  async function pickLogo(file?: File) {
    if (!file) { setLogo(undefined); return; }
    if (file.type !== "image/png" || file.size > 150_000) { setNote("Use a PNG logo under 150 KB."); return; }
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
    setLogo(`data:image/png;base64,${btoa(binary)}`); setNote("");
  }
  async function saveBrand() {
    if (!origin) { setNote("Enter your product's address, like app.your-product.com, or skip."); return; }
    setBusy(true); setNote("");
    try {
      const response = await fetch("/api/brands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin, brand: { accent, padding, radius: 12, ...(background ? { background } : {}), ...(logo ? { logo, cards: true } : {}) } }) });
      if (!response.ok) throw new Error();
      go("prompt");
    } catch { setNote("Couldn't save the brand. Try again or skip; you can set it later in Settings."); } finally { setBusy(false); }
  }
  async function connectChrome() {
    setBusy(true); setNote("");
    try {
      const response = await fetch("/api/extension-devices", { method: "POST" });
      if (!response.ok) throw new Error(response.status === 404 ? "closed" : "failed");
      const body = await response.json() as { connectUrl?: string };
      if (!body.connectUrl) throw new Error("failed");
      setConnectUrl(body.connectUrl);
      window.open(body.connectUrl, "_blank", "noopener");
    } catch (error) { setNote(error instanceof Error && error.message === "closed" ? "Toru for Chrome isn't open to your account yet. Pick the Mac, or check back soon." : "Couldn't create the connect link. Try again."); } finally { setBusy(false); }
  }
  async function connectMac() {
    setBusy(true); setNote(""); setCodeCopied(false);
    try {
      const response = await fetch("/api/devices", { method: "POST" });
      if (!response.ok) throw new Error();
      setMacSetup(await response.json() as MacSetup);
    } catch { setNote("Couldn't create the setup link. Try again."); } finally { setBusy(false); }
  }
  async function copyCode() { if (!macSetup) return; try { await navigator.clipboard.writeText(macSetup.pairingCode); setCodeCopied(true); } catch { setNote("Select the code and copy it."); } }
  async function copyPrompt() { try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); } }
  async function finish() { setBusy(true); try { await onFinish(); } finally { setBusy(false); } }

  const setup = CLIENTS[client], release = macRelease().latest;
  const macStatus = !mac ? "Waiting for your Mac…" : mac.control ? `${mac.name} is connected. Toru can operate the window you share.`
    : mac.status === "offline" ? `${mac.name} is paired. Open Toru on your Mac to connect it.` : `${mac.name} is connected. Turn on the switch below, then share a window.`;
  return <div className="ob">
    <header className="ob-top">
      <a className="st-brand" href="/" aria-label="Toru"><ToruOrb size={22} still />toru</a>
      {mode === "setup" ? <button className="ob-skip" type="button" disabled={busy} onClick={() => void finish()}>Skip setup</button> : <a className="ob-skip" href="/#demos">Back to demos</a>}
    </header>
    <main className="ob-column">
      {mode === "setup" && index >= 0 && <p className="ob-count" aria-label={`Step ${index + 1} of ${steps.length}`}>{String(index + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</p>}

      {step === "path" && <section aria-labelledby="ob-title">
        <h1 id="ob-title">How do you want to record?</h1>
        <p className="ob-lede">Pick one to start. Setup follows your choice, and you can add the other anytime.</p>
        <div className="ob-paths" role="radiogroup" aria-label="Where Toru records">
          <button type="button" role="radio" aria-checked={path === "chrome"} className={path === "chrome" ? "selected" : undefined} disabled={chromeClosed} onClick={() => setPath("chrome")}>
            <img src="/landing/route-notion.jpg" alt="" />
            <strong>In your Chrome</strong>
            <span>For web apps. Toru opens your product in a window of its own in your Chrome, where you're already signed in, and records the flow your agent planned.</span>
            <small>{chromeClosed ? "Opening soon for your account" : "Chrome 120 or newer"}</small>
          </button>
          <button type="button" role="radio" aria-checked={path === "mac"} className={path === "mac" ? "selected" : undefined} onClick={() => setPath("mac")}>
            <img src="/landing/route-mac.jpg" alt="" />
            <strong>On your Mac</strong>
            <span>For native apps. Toru operates the app window you share, in the background, and records it. Your mouse and keyboard stay yours.</span>
            <small>macOS 15 or newer · Apple silicon</small>
          </button>
        </div>
        <div className="ob-actions"><button className="primary" disabled={!path || (path === "chrome" && chromeClosed)} onClick={() => path && go("connect", path)}>Continue<span aria-hidden="true">→</span></button></div>
      </section>}

      {step === "connect" && <section aria-labelledby="ob-title">
        <h1 id="ob-title">Connect your agent.</h1>
        <p className="ob-lede">Your agent plans the demo from your code and asks Toru to record it. Pick where you run it, then follow the steps.</p>
        <div className="ob-chips" role="tablist" aria-label="Your agent">{(Object.keys(CLIENTS) as Client[]).map(key => <button key={key} role="tab" aria-selected={client === key} onClick={() => { setClient(key); setClip(false); }}>{CLIENTS[key].title}</button>)}</div>
        {setup.clip && <button className="ob-watch" type="button" onClick={() => setClip(true)}><span className="ob-play" aria-hidden="true" /><span><strong>Watch how</strong><small>Setting up Toru in {setup.title}</small></span></button>}
        <ol className="ob-steps">{setup.steps.map((item, i) => <li key={item.text}><span className="ob-num">{String(i + 1).padStart(2, "0")}</span><div><p>{item.text}</p>{item.code && <Copyable code={item.code} />}</div></li>)}</ol>
        <p className={`ob-status ${connected ? "on" : ""}`} role="status"><i aria-hidden="true" />{connected ? "Toru is connected to your agent." : "Waiting for your agent to connect…"}</p>
        <div className="ob-actions"><button className="quiet" onClick={back}>Back</button><button className="primary" onClick={forward}>{connected ? "Continue" : "I connected my agent"}<span aria-hidden="true">→</span></button></div>
        {clip && setup.clip && <div className="ob-modal" role="dialog" aria-label={`Setting up Toru in ${setup.title}`} onClick={() => setClip(false)}><div onClick={event => event.stopPropagation()}><header><strong>Setting up Toru in {setup.title}</strong><button type="button" onClick={() => setClip(false)} aria-label="Close">×</button></header><video src={setup.clip} controls autoPlay playsInline /></div></div>}
      </section>}

      {step === "chrome" && <section aria-labelledby="ob-title">
        <h1 id="ob-title">Add Toru to Chrome.</h1>
        <p className="ob-lede">Do this in the Chrome where you're signed in to your product. Toru only controls the window it opens for a recording.</p>
        <ol className="ob-steps">
          <li><span className="ob-num">01</span><div>
            {chromeRelease.webStoreUrl ? <><p>Install Toru for Chrome from the Chrome Web Store.</p><a className="ob-link" href={chromeRelease.webStoreUrl} target="_blank" rel="noreferrer">Add to Chrome ↗</a></> : <p>Toru for Chrome is not published yet.</p>}
          </div></li>
          <li><span className="ob-num">02</span><div>
            <p>Connect this Chrome. A Toru page opens and connects by itself.</p>
            <button type="button" className="ob-link" disabled={busy} onClick={() => void connectChrome()}>{connectUrl ? "Connect again" : "Connect this Chrome"} ↗</button>
            {connectUrl && !chromeReady && <p className="ob-sub">Nothing opened? <a className="text-link" href={connectUrl} target="_blank" rel="noreferrer">Open the connect page</a>. The link works once, for 10 minutes.</p>}
          </div></li>
          <li><span className="ob-num">03</span><div><p>Make sure you're signed in to your product in this Chrome. Each recording opens its own window; leave it open until the recording ends.</p></div></li>
        </ol>
        <p className={`ob-status ${chromeReady ? "on" : ""}`} role="status"><i aria-hidden="true" />{chromeReady ? `${chromeReady.name} is connected.` : chrome?.devices.length ? "Chrome is paired. Open Chrome to connect it." : "Waiting for Chrome to connect…"}</p>
        {note && <p className="ob-note" role="alert">{note}</p>}
        <div className="ob-actions"><button className="quiet" onClick={back}>Back</button><button className="primary" onClick={forward}>{chromeReady ? "Continue" : "I'll connect later"}<span aria-hidden="true">→</span></button></div>
      </section>}

      {step === "mac" && <section aria-labelledby="ob-title">
        <h1 id="ob-title">Set up Toru for Mac.</h1>
        <p className="ob-lede">Toru records the one window you share and, when you allow it, lets your agent click and type in it.</p>
        <ol className="ob-steps">
          <li><span className="ob-num">01</span><div>
            <p>Install Toru: paste this into Terminal. It puts Toru in Applications and opens it, with no security prompt.</p>
            <Copyable code="curl -fsSL https://toru.tools/install.sh | bash" />
            <p className="ob-sub">With Homebrew: <code>brew install --cask alifoo/toru/toru</code>. Or <a className="text-link" href="/downloads/Toru-latest.zip">download the zip{release ? ` (${release.version})` : ""}</a>{release?.notarized === false && <>: the first time, macOS says it can't verify the app; click <b>Done</b>, then open <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>.</>} <a className="text-link" href="/mac" target="_blank" rel="noreferrer">Details</a></p>
          </div></li>
          <li><span className="ob-num">02</span><div>
            <p>Connect this Mac to your account.</p>
            <button type="button" className="ob-link" disabled={busy} onClick={() => void connectMac()}>{macSetup ? "New setup link" : "Create setup link"}</button>
            {macSetup && <div className="ob-setup"><a className="primary" href={macSetup.setupUrl}>Open in Toru</a><span>or paste the code in Toru</span><button type="button" onClick={() => void copyCode()}><code>{macSetup.pairingCode}</code>{codeCopied ? "Copied" : "Copy"}</button></div>}
          </div></li>
          <li><span className="ob-num">03</span><div>
            <p>In Toru, open <b>Settings</b> and turn on <b>Let your agent operate the shared window</b>. macOS asks for Screen Recording and Accessibility; allow both.</p>
          </div></li>
          <li><span className="ob-num">04</span><div><p>Choose the app window to record and click <b>Share</b>. Your agent can switch windows later.</p></div></li>
        </ol>
        <p className={`ob-status ${mac?.control ? "on" : ""}`} role="status"><i aria-hidden="true" />{macStatus}</p>
        {note && <p className="ob-note" role="alert">{note}</p>}
        <div className="ob-actions"><button className="quiet" onClick={back}>Back</button><button className="primary" onClick={forward}>{mac?.control ? "Continue" : "I'll finish this later"}<span aria-hidden="true">→</span></button></div>
      </section>}

      {step === "brand" && <section aria-labelledby="ob-title">
        <h1 id="ob-title">Make it look like you.</h1>
        <p className="ob-lede">Every demo of this product gets your background, color and logo, with short intro and outro cards.</p>
        <label className="ob-field">Product address<input value={domain} onChange={event => setDomain(event.target.value)} placeholder="app.your-product.com" inputMode="url" autoComplete="url" /></label>
        <div className="ob-brand-row">
          <label className="ob-field">Accent<input type="color" value={accent} onChange={event => setAccent(event.target.value)} /></label>
          <label className="ob-field ob-file">Logo (PNG)<input type="file" accept="image/png" onChange={event => void pickLogo(event.target.files?.[0])} /></label>
        </div>
        <div className="ob-field">Background and padding
          <BrandLook background={background} accent={accent} padding={padding} logo={logo}
            onChange={patch => { if ("background" in patch) setBackground(patch.background); if (patch.padding !== undefined) setPadding(patch.padding); }} />
        </div>
        {note && <p className="ob-note" role="alert">{note}</p>}
        <div className="ob-actions"><button className="quiet" onClick={back}>Back</button><button className="quiet" onClick={() => go("prompt")}>Skip</button><button className="primary" disabled={busy} onClick={() => void saveBrand()}>Save brand<span aria-hidden="true">→</span></button></div>
      </section>}

      {step === "prompt" && <section aria-labelledby="ob-title">
        <h1 id="ob-title">{mode === "new" ? "New demo." : "Create your first demo."}</h1>
        <p className="ob-lede">Paste this into your agent. It plans the demo from your code, Toru records it, and your agent brings back the video. Follow it live on the Demos page.</p>
        <div className="ob-chips" role="tablist" aria-label="Where Toru records">
          <button role="tab" aria-selected={path === "chrome"} onClick={() => go("prompt", "chrome")}>In your Chrome</button>
          <button role="tab" aria-selected={path === "mac"} onClick={() => go("prompt", "mac")}>On your Mac</button>
        </div>
        {path === "mac"
          ? <label className="ob-field">Which app?<input value={app} onChange={event => setApp(event.target.value)} placeholder="Notes, Figma, your own app…" /></label>
          : <label className="ob-field">Product address<input value={domain} onChange={event => setDomain(event.target.value)} placeholder="app.your-product.com" inputMode="url" /></label>}
        <label className="ob-field">What should the demo show?<textarea rows={3} value={flow} onChange={event => setFlow(event.target.value)} placeholder={path === "mac" ? "Write a short note, make the title bold, and end with the note visible" : "Create a project named Launch, invite a teammate, and end on the project dashboard"} /></label>
        <div className="ob-prompt"><span>prompt</span><pre>{prompt}</pre><button type="button" onClick={() => void copyPrompt()}>{copied ? "Copied" : "Copy"}</button></div>
        <p className="ob-fine">You only use a credit when the video passes Toru's check.</p>
        <div className="ob-actions">{mode === "setup" && <button className="quiet" onClick={() => path ? back() : go("path")}>Back</button>}<button className="primary" disabled={busy} onClick={() => void finish()}>Open dashboard<span aria-hidden="true">→</span></button></div>
      </section>}
    </main>
  </div>;
}

/** The same per-agent steps, for the Connections page. */
export function AgentInstall() {
  const [client, setClient] = useState<Client>("claude-code");
  return <div className="ob-install">
    <div className="ob-chips" role="tablist" aria-label="Your agent">{(Object.keys(CLIENTS) as Client[]).map(key => <button key={key} role="tab" aria-selected={client === key} onClick={() => setClient(key)}>{CLIENTS[key].title}</button>)}</div>
    <ol className="ob-steps">{CLIENTS[client].steps.map((item, i) => <li key={item.text}><span className="ob-num">{String(i + 1).padStart(2, "0")}</span><div><p>{item.text}</p>{item.code && <Copyable code={item.code} />}</div></li>)}</ol>
  </div>;
}
