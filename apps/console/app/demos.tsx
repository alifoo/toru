"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { CreditPacks } from "./credit-packs";
import { creditPacksEnabled } from "./pricing/plans";
import { RecordingPlayer } from "./recording-player";
import { RecordingFeedback } from "./recording-feedback";
import { clock, demoPrompt, domainOf, durationLabel, outcomeOf, qualityReason, relativeTime, stepLine, stopReason, trackFor, trackPosition, type DemoRun, type PromptRoute, type RunStudio, type StudioStep } from "./demo-status";
import { backgroundCss, backgrounds } from "./brand-look";
import { ToruOrb } from "./toru-orb";
import { SITE_URL } from "./site";

type Usage = { mode?: string; available?: number; admission?: { state: string } };
/** A run in the user's own Chrome or on their Mac is recorded again there; a Mac run's address is Toru's own. Older runs in
 * Toru's own browser are recorded again in the user's Chrome. */
const routeOf = (route?: string, url?: string): PromptRoute => route === "local-browser" && url?.startsWith(SITE_URL) ? "mac" : "chrome";
const placeLabel = (route?: string, url?: string) => route === "local-browser" ? (routeOf(route, url) === "mac" ? "Your Mac" : "Your Chrome") : route ? "Toru's browser" : "—";

function usePacksDismissed() {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => { try { setDismissed(localStorage.getItem("toru:packs-dismissed") === "1"); } catch { setDismissed(false); } }, []);
  return [dismissed, () => { setDismissed(true); try { localStorage.setItem("toru:packs-dismissed", "1"); } catch { /* per viewer only */ } }] as const;
}

/** The signature of the page: where the run is, with the live stage pulsing in record red. */
export function StageTrack({ run, labels = false }: { run: DemoRun; labels?: boolean }) {
  const steps = trackFor(run), at = trackPosition(run.status), index = at === "complete" ? steps.length : steps.findIndex(step => step.key === at);
  const stoppedAt = at === undefined ? steps.filter(step => run.stages?.[step.key]).length - 1 : -1;
  return <ol className={`stage-track${labels ? " labeled" : ""}`} aria-label="Progress">
    {steps.map((step, i) => {
      const state = at === undefined ? (i < stoppedAt ? "done" : i === stoppedAt ? "stopped" : "todo") : i < index ? "done" : i === index ? (run.waitingForUser ? "waiting" : "live") : "todo";
      const time = run.stages?.[step.key];
      return <li key={step.key} className={state} title={`${step.label}${time ? ` · ${new Date(time).toLocaleTimeString()}` : ""}`}>
        <i aria-hidden="true" />{labels && <span>{step.label}{time && <small>{new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>}</span>}
      </li>;
    })}
  </ol>;
}

function Outcome({ run }: { run: DemoRun }) {
  const outcome = outcomeOf(run);
  return <div className={`outcome ${outcome.tone}`}><strong>{outcome.label}</strong>{outcome.detail && <span>{outcome.detail}</span>}</div>;
}

function Thumb({ run }: { run: DemoRun }) {
  const [hover, setHover] = useState(false);
  const still = run.previewUrl, moving = run.gifUrl;
  const live = outcomeOf(run).tone === "live";
  return <div className="demo-thumb" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    {(hover && moving) || (!still && moving) ? <img src={moving} alt="" /> : still ? <img src={still} alt="" /> : <span className={`thumb-lens${live ? " live" : ""}`} aria-hidden="true" />}
  </div>;
}

/** A capture made outside recording_run (step by step, or on the Mac). Shown in the same list as runs. */
export type LibraryRecording = { id: string; status: string; createdAt: string; durationMs?: number; errorCode?: string; previewUrl?: string; videoUrl?: string; downloadUrl?: string; rawUrl?: string; gifUrl?: string; progress?: { percent: number } };
const recordingOutcome = (recording: LibraryRecording) => recording.status === "completed" ? { tone: "ready", label: "Ready" } : recording.status === "rendering" ? { tone: "live", label: "Rendering", detail: recording.progress ? `${recording.progress.percent}%` : undefined }
  : recording.status === "recording" ? { tone: "live", label: "Recording" } : recording.status === "captured" ? { tone: "stopped", label: "Not rendered yet", detail: "Ask your agent to render it" } : { tone: "stopped", label: recording.status.replaceAll("_", " ") };
function RecordingRow({ recording }: { recording: LibraryRecording }) {
  const outcome = recordingOutcome(recording);
  return <a href={`#recording/${recording.id}`} className="demo-row standalone">
    <div className="demo-thumb">{recording.previewUrl ? <img src={recording.previewUrl} alt="" /> : <span className={`thumb-lens${outcome.tone === "live" ? " live" : ""}`} aria-hidden="true" />}</div>
    <div className="demo-what"><strong>Step-by-step recording</strong><span>{relativeTime(recording.createdAt)}</span></div>
    <span className="demo-kind">Recorded by your agent, step by step</span>
    <div className={`outcome ${outcome.tone}`}><strong>{outcome.label}</strong>{outcome.detail && <span>{outcome.detail}</span>}</div>
    <span className="demo-length">{durationLabel(recording.durationMs) ?? ""}</span>
  </a>;
}

export function DemosHome({ usage, recordings, recordingsState, activeJobs = 0 }: { usage: Usage | null; recordings: LibraryRecording[]; recordingsState: "loading" | "ready" | "error"; activeJobs?: number }) {
  const [runs, setRuns] = useState<DemoRun[] | null>(null), [failed, setFailed] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const [packsDismissed, dismissPacks] = usePacksDismissed();
  const anyActive = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/runs", { cache: "no-store", ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error();
      const body = await response.json() as { runs: DemoRun[]; nextBefore: number | null };
      // Keep pages already loaded below the first one.
      setRuns(previous => { const first = body.runs, ids = new Set(first.map(run => run.runId)); return [...first, ...(previous ?? []).slice(30).filter(run => !ids.has(run.runId))]; });
      setNextBefore(current => current ?? body.nextBefore);
      anyActive.current = body.runs.some(run => run.active);
      setFailed(false);
    } catch { if (!signal?.aborted) setFailed(true); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const tick = async () => { if (first || !document.hidden) await load(controller.signal); first = false; timer = setTimeout(tick, anyActive.current ? 2500 : 15000); };
    void tick();
    const onVisible = () => { if (!document.hidden) void load(controller.signal); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);
  async function more() {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/runs?before=${nextBefore}`, { cache: "no-store" });
      const body = await response.json() as { runs: DemoRun[]; nextBefore: number | null };
      setRuns(previous => [...(previous ?? []), ...body.runs.filter(run => !(previous ?? []).some(p => p.runId === run.runId))]);
      setNextBefore(body.nextBefore);
    } catch { /* the button stays for a retry */ } finally { setLoadingMore(false); }
  }
  const showPacks = creditPacksEnabled && !packsDismissed && typeof usage?.available === "number" && usage.available <= 3 && (runs ?? []).some(run => outcomeOf(run).tone === "ready");
  if (runs === null) return <div className="demos-loading" role="status">{failed ? "Your demos are temporarily unavailable. Retrying while this tab is open." : <><ToruOrb size={22} />Loading your demos…</>}</div>;
  const runSessions = new Set(runs.map(run => run.sessionId).filter(Boolean));
  const standalone = recordings.filter(recording => !runSessions.has(recording.id));
  const rows = [...runs.map(run => ({ at: Date.parse(run.startedAt), run })), ...standalone.map(recording => ({ at: Date.parse(recording.createdAt), recording }))].sort((a, b) => b.at - a.at);
  if (rows.length === 0 && recordingsState !== "loading") return <div className="demos-empty-state">
    <span className="thumb-lens" aria-hidden="true" />
    <h2>No demos yet</h2>
    <p>Describe a flow once and your agent records it. Demos show up here while they run.</p>
    <a className="primary" href="/onboarding?step=prompt&from=demos"><span className="record-dot" aria-hidden="true" />Create your first demo</a>
  </div>;
  return <div className="demos">
    {showPacks && <CreditPacks usage={usage} compact onDismiss={dismissPacks} />}
    {failed && <p className="inline-alert" role="status">Couldn't refresh. Showing the last known state.</p>}
    {activeJobs > 0 && <p className="inline-alert" role="status">{activeJobs === 1 ? "1 job is" : `${activeJobs} jobs are`} running in the queue.</p>}
    <ul className="demo-list">
      {rows.map(row => "recording" in row && row.recording ? <li key={row.recording.id}><RecordingRow recording={row.recording} /></li> : "run" in row && row.run ? (run => <li key={run.runId}>
        <a href={`#demo/${run.runId}`} className="demo-row">
          <Thumb run={run} />
          <div className="demo-what"><strong>{run.title ?? "Untitled demo"}</strong><span>{domainOf(run.url) ?? "—"} · {relativeTime(run.startedAt)}</span></div>
          <StageTrack run={run} />
          <Outcome run={run} />
          <span className="demo-length">{durationLabel(run.session?.durationMs) ?? ""}</span>
        </a>
      </li>)(row.run) : null)}
    </ul>
    {nextBefore && <button className="quiet load-more" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "Loading…" : "Show older demos"}</button>}
  </div>;
}

export function DemoDetail({ id, usage }: { id: string; usage: Usage | null }) {
  const [run, setRun] = useState<DemoRun | null>(null), [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [copied, setCopied] = useState(false);
  const [packsDismissed, dismissPacks] = usePacksDismissed();
  const active = useRef(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/runs?id=${id}`, { cache: "no-store", ...(signal ? { signal } : {}) });
      if (response.status === 404) { setState("missing"); return; }
      if (!response.ok) throw new Error();
      const body = await response.json() as { run: DemoRun };
      active.current = Boolean(body.run.active) || body.run.session?.status === "rendering";
      setRun(body.run); setState("ready");
    } catch { if (!signal?.aborted) setState(previous => previous === "ready" ? "ready" : "error"); }
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const tick = async () => { if (first || !document.hidden) await load(controller.signal); first = false; timer = setTimeout(tick, active.current ? 2000 : 20000); };
    void tick();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load]);
  const video = useRef<HTMLVideoElement | null>(null);
  const playhead = usePlayhead(video, run?.videoUrl);
  if (state === "missing") return <div className="demos-loading"><p>This demo isn't available anymore. Runs are kept for 31 days.</p><a className="text-link" href="#demos">Back to demos</a></div>;
  if (!run) return <div className="demos-loading" role="status">{state === "error" ? "This demo is temporarily unavailable. Retrying…" : "Loading the demo…"}</div>;
  const outcome = outcomeOf(run), route = routeOf(run.route, run.url);
  const againPrompt = demoPrompt({ url: run.url ?? "", flow: run.goal ?? run.title ?? "", route });
  async function recordAgain() {
    try { await navigator.clipboard.writeText(againPrompt); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setMessage("Select the prompt and copy it."); }
  }
  async function post(path: string, confirmText: string, working: string, errors: Record<string, string>) {
    if (!run?.sessionId || busy || !window.confirm(confirmText)) return;
    setBusy(true); setMessage(working);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: run.sessionId }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 202) { setMessage("Rendering. The video appears here when it's ready."); active.current = true; void load(); }
      else setMessage(errors[body.error ?? ""] ?? "Couldn't start the render. Try again in a moment.");
    } catch { setMessage("Couldn't start the render. Try again in a moment."); } finally { setBusy(false); }
  }
  const deliverAnyway = () => post("/api/recordings/accept", "Deliver this video even though it failed the check? It renders again and uses 1 credit.", "Rendering the video…",
    { review_not_pending: "This video isn't waiting for review anymore.", video_credit_limit: "No credits left. Add credits in Billing." });
  const renderAgain = () => post("/api/recordings/render", "Render this demo again with the brand as it is saved now? It uses no credit; each demo can be rendered again twice.", "Rendering again…",
    { rerender_limit: "This demo was already rendered again twice.", capture_unavailable: "The original capture has expired, so it can't be rendered again. Record it again instead.",
      capacity_busy: "Toru is busy with another recording. Try again in a minute.", review_pending: "This video is held for review. Use Deliver anyway instead." });
  const downloads = [["MP4", run.downloadUrl], ["GIF", run.gifUrl], ["Raw capture", run.rawUrl], ["Plan", run.planUrl], ["Run log", run.eventsUrl]] as const;
  const credits = run.session?.credits?.available, studio = run.studio;
  const showPacks = creditPacksEnabled && !packsDismissed && outcome.tone === "ready" && typeof usage?.available === "number" && usage.available <= 3;
  const steps: StudioStep[] = studio?.steps ?? (run.plan?.steps ?? []).map((step, index) => ({ ...step, index, matched: false }));
  const seek = (ms: number) => { const element = video.current; if (!element) return; element.currentTime = ms / 1000; void element.play().catch(() => undefined); };
  const delivered = run.session?.status === "completed";
  return <div className="rx">
    <div className="rx-top">
      <a className="back-link" href="#demos">← All demos</a>
      <span className="rx-where">{run.url ? <a href={run.url} target="_blank" rel="noreferrer">{domainOf(run.url)}</a> : "—"} · {relativeTime(run.startedAt)} · {placeLabel(run.route, run.url)}</span>
      <div className={`outcome ${outcome.tone}`}><strong>{outcome.label}</strong>{outcome.detail && <span>{outcome.detail}</span>}</div>
    </div>
    <h2 className="rx-title">{run.goal ?? run.title ?? "Untitled demo"}</h2>
    <section className="rx-window" aria-label="Run">
      <aside className="rx-panel rx-left">
        <p className="rx-label"><span>Shot list</span><span>{steps.length ? `${steps.length} steps` : ""}</span></p>
        {steps.length > 0 ? <ol className="rx-shots">{steps.map(step => {
          const line = stepLine(step), playing = step.matched && step.startMs !== undefined && step.endMs !== undefined && playhead >= step.startMs && playhead < step.endMs;
          const content = <><span className={`rx-tick${step.matched ? " rx-tick-on" : ""}`} aria-hidden="true">{step.matched ? "✓" : ""}</span>
            <span className="rx-shot-text">{line.verb} <b>{line.label}</b><small>{step.screen}</small></span>
            {step.startMs !== undefined && <time className="st-mono">{clock(step.startMs)}</time>}</>;
          return <li key={step.index} className={playing ? "rx-now" : step.matched ? "" : "rx-unplaced"}>
            {step.matched && step.startMs !== undefined && run.videoUrl ? <button type="button" onClick={() => seek(step.startMs!)} title={step.expect}>{content}</button> : <div title={step.expect}>{content}</div>}
          </li>;
        })}</ol> : <p className="rx-note">{outcome.tone === "live" ? "The plan appears here once your agent has sent it." : "This run has no plan on record."}</p>}
        {run.plan?.finalState && <p className="rx-final"><span>Ends on</span>{run.plan.finalState}</p>}
        {studio && steps.some(step => !step.matched) && <p className="rx-note">Steps without a time weren't matched to an action on the page.</p>}
        {outcome.tone !== "live" && outcome.tone !== "waiting" && <div className="rx-again">
          <p className="rx-label"><span>Record again</span></p>
          <pre>{againPrompt}</pre>
          <button type="button" className="rx-copy" onClick={() => void recordAgain()}>{copied ? "Prompt copied" : "Copy prompt"}</button>
        </div>}
      </aside>

      <div className="rx-canvas">
        {outcome.tone === "waiting" && <div className="rx-callout rx-callout-wait"><strong>Your turn</strong><p>{outcome.detail}. The run continues by itself afterwards.</p></div>}
        {outcome.tone === "review" && <div className="rx-callout rx-callout-wait">
          <strong>Held back by the delivery check, not charged</strong>
          <p>{(run.qualityReasons ?? run.session?.qualityReview?.reasons ?? []).map(qualityReason).join(" · ")}</p>
          <div className="rx-callout-actions"><button className="primary" onClick={() => void recordAgain()}>{copied ? "Prompt copied" : "Record again"}</button>
            {run.sessionId && <button className="quiet" disabled={busy} onClick={() => void deliverAnyway()}>Deliver anyway · 1 credit</button>}</div>
        </div>}
        {outcome.tone === "stopped" && <div className="rx-callout">
          <strong>{outcome.detail ?? "The run stopped before delivery"}</strong>
          <p>{run.session?.status === "captured" ? "The capture was kept. Ask your agent to render it, or record again." : "No credit was used."}</p>
        </div>}
        <div className="rx-output">
          <p className="rx-output-label"><span>{studio ? `Output · ${studio.settings.width} × ${studio.settings.height}` : "Output"}</span><span>{run.gifUrl ? "MP4 + GIF" : run.videoUrl ? "MP4" : ""}</span></p>
          <div className={`rx-screen${run.videoUrl || run.gifUrl || run.previewUrl ? "" : " empty"}`}>
            {run.videoUrl ? <RecordingPlayer url={run.videoUrl} poster={run.previewUrl} videoRef={video} /> : run.gifUrl ? <img src={run.gifUrl} alt="Demo preview" /> : run.previewUrl ? <img src={run.previewUrl} alt="Latest frame" /> : <div className="screen-waiting"><span className={`thumb-lens${outcome.tone === "live" ? " live" : ""}`} aria-hidden="true" /><p>{outcome.tone === "live" ? `${outcome.label}…` : "No video for this run."}</p></div>}
          </div>
          {studio ? <Timeline studio={studio} playhead={playhead} onSeek={run.videoUrl ? seek : undefined} /> : <div className="rx-panel rx-stages"><StageTrack run={run} labels /></div>}
        </div>
        {message && <p className="inline-alert" role="status">{message}</p>}
        {showPacks && <CreditPacks usage={usage} compact onDismiss={dismissPacks} />}
      </div>

      <aside className="rx-panel rx-inspector" aria-label="What this demo used">
        <div className="rx-insp-head"><b>{delivered ? "Delivered" : outcome.label}</b><span>{studio ? clock(studio.outputDurationMs) : durationLabel(run.session?.durationMs) ?? ""}</span></div>
        {studio && <>
          <div className="rx-insp"><p>Frame</p>
            <div className="rx-frame-row"><span className="rx-swatch" style={{ background: backgroundCss(studio.settings.background, "#405f6d") }} aria-hidden="true" /><span>{backgroundName(studio.settings.background)}</span></div>
            <dl><dt>Padding</dt><dd>{studio.settings.padding}</dd>{studio.settings.radius !== undefined && <><dt>Radius</dt><dd>{studio.settings.radius}</dd></>}
              <dt>Logo</dt><dd>{studio.settings.logo ? positionName(studio.settings.logoPosition) : "None"}</dd><dt>Cards</dt><dd>{studio.settings.cards ? "Intro and outro" : "None"}</dd></dl>
          </div>
          <div className="rx-insp"><p>Camera</p>
            <dl><dt>Zoom</dt><dd>{studio.settings.zoom.enabled ? `${studio.zooms.length} ${studio.zooms.length === 1 ? "shot" : "shots"}` : "Off"}</dd>
              {studio.zooms.length > 0 && <><dt>Deepest</dt><dd>{Math.max(...studio.zooms.map(zoom => zoom.scale)).toFixed(1)}×</dd></>}
              <dt>Pauses cut</dt><dd>{studio.cuts.length ? `${studio.cuts.length} · ${Math.round(studio.cuts.reduce((sum, cut) => sum + cut.removedMs, 0) / 1000)} s` : "None"}</dd></dl>
          </div>
          <div className="rx-insp"><p>Cursor</p>
            <dl><dt>Travel</dt><dd>{studio.cursor.smooth ? "Smoothed" : "As recorded"}</dd><dt>Clicks</dt><dd>Rest, then press</dd></dl>
          </div>
        </>}
        <div className="rx-insp"><p>Files</p>
          <div className="rx-files">{downloads.filter(([, url]) => url).map(([label, url]) => <a key={label} href={url} download={label !== "GIF" || undefined} target={label === "GIF" ? "_blank" : undefined} rel="noreferrer">{label}</a>)}{downloads.every(([, url]) => !url) && <span className="muted">Files appear as the run produces them.</span>}</div>
        </div>
        <div className="rx-insp"><p>Details</p>
          <dl>{studio ? <><dt>Length</dt><dd>{clock(studio.outputDurationMs)}</dd></> : durationLabel(run.session?.durationMs) && <><dt>Length</dt><dd>{durationLabel(run.session?.durationMs)}</dd></>}
            <dt>Recorded in</dt><dd>{placeLabel(run.route, run.url)}</dd>
            <dt>Agent actions</dt><dd>{run.actions ?? 0}</dd>
            {!studio && run.session?.branding?.brand && <><dt>Brand</dt><dd>Applied{run.session.branding.applied?.length ? ` · ${run.session.branding.applied.join(", ")}` : ""}</dd></>}
            {credits !== undefined && <><dt>Credits left</dt><dd>{credits}</dd></>}</dl>
        </div>
        {delivered && run.sessionId && <div className="rx-insp"><p>Brand changed?</p>
          <button type="button" className="rx-action" disabled={busy} onClick={() => void renderAgain()}>Render again with the saved brand</button>
          <span className="rx-insp-note">From the original capture, while it is kept. No credit.</span>
        </div>}
        {delivered && run.sessionId && <div className="rx-insp rx-feedback"><RecordingFeedback id={run.sessionId} /></div>}
        {run.events && run.events.length > 0 && <details className="rx-insp rx-log"><summary>Run log</summary><ol>{run.events.map((event, index) => <li key={index}><time>{event.at ? new Date(event.at).toLocaleTimeString() : ""}</time><span>{event.event === "stage" ? `→ ${event.state}` : event.event}{event.reason ? ` · ${stopReason(String(event.reason))}` : ""}</span></li>)}</ol></details>}
      </aside>
    </section>
  </div>;
}

/** Follows the video's clock while it plays, smoothly, for the playhead and the step being shown. */
function usePlayhead(video: RefObject<HTMLVideoElement | null>, source?: string) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let frame = 0;
    const read = () => setMs(Math.round(element.currentTime * 1000));
    const loop = () => { read(); frame = requestAnimationFrame(loop); };
    const play = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(loop); };
    const stop = () => { cancelAnimationFrame(frame); read(); };
    element.addEventListener("play", play); element.addEventListener("pause", stop); element.addEventListener("seeked", read); element.addEventListener("ended", stop);
    return () => { cancelAnimationFrame(frame); element.removeEventListener("play", play); element.removeEventListener("pause", stop); element.removeEventListener("seeked", read); element.removeEventListener("ended", stop); };
  }, [video, source]);
  return ms;
}

/** The delivered video's timeline: cards, one clip per placed step, the camera's shots above, cuts as ticks. */
function Timeline({ studio, playhead, onSeek }: { studio: RunStudio; playhead: number; onSeek: ((ms: number) => void) | undefined }) {
  const total = Math.max(1, studio.outputDurationMs), at = (ms: number) => `${Math.min(100, Math.max(0, ms / total * 100))}%`;
  const span = (start: number, end: number) => ({ left: at(start), width: `${Math.max(0.4, (end - start) / total * 100)}%` });
  const pick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.round((event.clientX - box.left) / box.width * total));
  };
  return <div className="rx-panel rx-timeline">
    <div className="rx-timeline-top"><span className="st-mono"><b>{clock(playhead)}</b> / {clock(total)}</span>
      <span className="rx-legend"><i className="rx-key-step" />Steps<i className="rx-key-zoom" />Zoom<i className="rx-key-cut" />Cut</span></div>
    <div className="rx-track" onClick={pick} role={onSeek ? "presentation" : undefined}>
      <div className="rx-row rx-row-zoom">{studio.zooms.map((zoom, index) => <span key={index} style={span(zoom.startMs, zoom.endMs)} title={`${zoom.scale}×${zoom.element ? ` · ${zoom.element}` : ""}`} />)}</div>
      <div className="rx-row rx-row-steps">
        {studio.introMs > 0 && <span className="rx-card" style={span(0, studio.introMs)} title="Intro card" />}
        {studio.steps.filter(step => step.matched && step.startMs !== undefined && step.endMs !== undefined).map(step => <span key={step.index} className={playhead >= step.startMs! && playhead < step.endMs! ? "rx-on" : ""} style={span(step.startMs!, step.endMs!)} title={`${step.index + 1}. ${stepLine(step).verb} ${stepLine(step).label}`}><b>{step.index + 1}</b></span>)}
        {studio.outroMs > 0 && <span className="rx-card" style={span(total - studio.outroMs, total)} title="Outro card" />}
      </div>
      {studio.cuts.map((cut, index) => <i key={index} className="rx-cut" style={{ left: at(cut.atMs) }} title={`${(cut.removedMs / 1000).toFixed(1)} s cut`} />)}
      <i className="rx-playhead" style={{ left: at(playhead) }} />
    </div>
  </div>;
}

const backgroundName = (id?: string) => id ? backgrounds.find(entry => entry.id === id)?.label ?? (id.startsWith("#") ? id : "Custom") : "From the accent";
const positionName = (position?: string) => position ? position.replace("-", " ").replace(/^./, letter => letter.toUpperCase()) : "Bottom right";

/** Detail for a capture made outside recording_run. */
export function RecordingDetail({ recording, loading }: { recording?: LibraryRecording; loading: boolean }) {
  if (!recording) return <div className="demos-loading" role="status">{loading ? "Loading the recording…" : <>This recording isn't available anymore. <a className="text-link" href="#demos">Back to demos</a></>}</div>;
  const outcome = recordingOutcome(recording);
  const files = [["MP4", recording.downloadUrl], ["GIF", recording.gifUrl], ["Raw capture", recording.rawUrl]] as const;
  return <div className="demo-detail">
    <a className="back-link" href="#demos">← All demos</a>
    <div className="demo-detail-head">
      <div><p className="demo-domain">{relativeTime(recording.createdAt)}</p><h2>Step-by-step recording</h2></div>
      <div className={`outcome large ${outcome.tone}`}><strong>{outcome.label}</strong>{outcome.detail && <span>{outcome.detail}</span>}</div>
    </div>
    <div className="demo-detail-body">
      <div className="demo-stage"><div className={`demo-screen${recording.videoUrl || recording.previewUrl ? "" : " empty"}`}>
        {recording.videoUrl ? <RecordingPlayer url={recording.videoUrl} poster={recording.previewUrl} /> : recording.previewUrl ? <img src={recording.previewUrl} alt="Latest frame" /> : <div className="screen-waiting"><span className="thumb-lens" aria-hidden="true" /><p>No video yet.</p></div>}
      </div></div>
      <aside className="demo-facts">
        <section><h3>Files</h3><div className="file-chips">{files.filter(([, url]) => url).map(([label, url]) => <a key={label} href={url} download={label !== "GIF" || undefined} target={label === "GIF" ? "_blank" : undefined} rel="noreferrer">{label}</a>)}{files.every(([, url]) => !url) && <span className="muted">No files yet.</span>}</div></section>
        <section><h3>Details</h3><dl>{durationLabel(recording.durationMs) && <><dt>Length</dt><dd>{durationLabel(recording.durationMs)}</dd></>}{recording.errorCode && <><dt>Note</dt><dd>{recording.errorCode.replaceAll("_", " ")}</dd></>}</dl></section>
        {recording.status === "completed" && <section className="demo-feedback"><RecordingFeedback id={recording.id} /></section>}
      </aside>
    </div>
  </div>;
}
