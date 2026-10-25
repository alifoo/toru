/** Shapes and wording for demo runs in the console. Pure, so list, detail and tests share one vocabulary. */
export type RunStage = "planning" | "connecting" | "awaiting_code" | "navigating" | "needs_input" | "agent_driving" | "recording" | "rendering";
export type RunStatus = RunStage | "done" | "needs_review" | "failed" | "canceled" | "interrupted";
export type RunSession = {
  status?: string; durationMs?: number; errorCode?: string; needsReview?: boolean;
  qualityReview?: { passed?: boolean; reasons?: string[]; accepted?: boolean };
  branding?: { applied?: string[]; brand?: boolean; gif?: boolean };
  credits?: { available?: number; used?: number; plan?: string };
  progress?: { percent?: number };
};
export type DemoRun = {
  runId: string; status: RunStatus; title?: string; url?: string; route?: string; sessionId?: string; connectionId?: string;
  reason?: string; qualityReasons?: string[]; navigator?: "toru" | "agent"; handoff?: string; actions?: number; costUsd?: number; startedAt: string; finishedAt?: string;
  stages?: Partial<Record<RunStatus, string>>; active?: boolean; waitingForUser?: boolean; session?: RunSession; sessionExpired?: boolean;
  previewUrl?: string; videoUrl?: string; downloadUrl?: string; gifUrl?: string; rawUrl?: string; planUrl?: string; eventsUrl?: string;
  goal?: string; events?: Array<{ at?: string; event?: string; state?: string; reason?: string; [key: string]: unknown }>;
  /** The plan the agent sent: the shot list. */
  plan?: { steps: PlanStep[]; finalState: string };
  /** From the last delivered render: steps, shots and cuts on the video's clock, and the settings it used. */
  studio?: RunStudio;
};
export type PlanStep = { screen: string; action: string; target: string; value?: string; expect: string };
export type StudioStep = PlanStep & { index: number; matched: boolean; startMs?: number; endMs?: number };
export type RunStudio = {
  outputDurationMs: number; introMs: number; outroMs: number;
  steps: StudioStep[];
  zooms: Array<{ startMs: number; endMs: number; scale: number; element?: string; intent?: string }>;
  cuts: Array<{ atMs: number; removedMs: number }>;
  cursor: { scale: number; smooth: boolean };
  settings: { background?: string; padding: number; radius?: number; width: number; height: number; gif: boolean; logo: boolean; logoPosition?: string;
    cards: boolean; zoom: { enabled: boolean; scale?: number }; compressPauses: boolean };
};

/** A plan target's visible label: `button "Create invoice"` reads as Create invoice. */
export function targetLabel(target: string) {
  return /"([^"]+)"/.exec(target)?.[1] ?? target.replace(/^(button|field|link|tab|menu|option|checkbox|select|dropdown|row)\s+/i, "").trim();
}
const verbs: Record<string, string> = { click: "Click", type: "Type in", select: "Choose", press: "Press", scroll: "Scroll to", wait: "Wait for", navigate: "Open" };
/** One line for a plan step, the way the shot list reads it. */
export function stepLine(step: Pick<PlanStep, "action" | "target" | "value">) {
  const verb = verbs[step.action] ?? step.action, label = targetLabel(step.target);
  return step.action === "type" && step.value ? { verb: `Type “${step.value}” in`, label } : { verb, label };
}
/** m:ss for a point on the video's clock. */
export function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The visible track. Sign-in only appears for runs that signed in on the hosted browser. */
export const TRACK: Array<{ key: RunStage; label: string }> = [
  { key: "planning", label: "Opening" },
  { key: "connecting", label: "Signing in" },
  { key: "navigating", label: "Navigating" },
  { key: "recording", label: "Recording" },
  { key: "rendering", label: "Rendering" },
];
export function trackFor(run: Pick<DemoRun, "stages" | "route">) {
  const signsIn = Boolean(run.stages?.connecting) || run.route === "hosted-email-only" || run.route === "hosted-demo-account";
  return TRACK.filter(step => step.key !== "connecting" || signsIn);
}
/** awaiting_code sits inside connecting on the track; needs_input and agent_driving inside navigating. */
export function trackPosition(status: RunStatus): RunStage | "complete" | undefined {
  if (status === "awaiting_code") return "connecting";
  if (status === "needs_input" || status === "agent_driving") return "navigating";
  if (TRACK.some(step => step.key === status)) return status as RunStage;
  if (status === "done" || status === "needs_review") return "complete";
  return undefined;
}

export type Outcome = { tone: "live" | "ready" | "review" | "waiting" | "stopped"; label: string; detail?: string };
const qualityWords: Record<string, string> = {
  blank_frames: "The screen stayed blank",
  static_video: "Nothing moved on screen",
  too_short: "The video was too short",
};
export const qualityReason = (code: string) => qualityWords[code] ?? code.replaceAll("_", " ");

const stopWords: Array<[RegExp, string]> = [
  [/^navigation_agent_(stuck|idle)/, "Your agent couldn't finish the flow"],
  [/^navigation_(blocked|exhausted)/, "Toru couldn't finish the flow"],
  [/^navigation_(failed|timeout)/, "Navigation failed"],
  [/^connection_/, "Sign-in didn't complete"],
  [/^capture_/, "The capture stopped early"],
  [/^render_/, "Rendering failed"],
  [/^run_timeout$/, "The run hit the 30-minute limit"],
  [/^server_restarted$/, "Interrupted by a server restart"],
  [/^client_canceled$/, "Canceled"],
  [/^session_open_failed|^session_not_ready|^session_open_failed:/, "The browser session didn't open"],
  [/^demo_account_not_found/, "No demo account is saved for this product"],
  [/^video_credit_limit/, "No credits left"],
];
export function stopReason(reason?: string) {
  if (!reason) return undefined;
  const code = reason.split(":")[0]!;
  return stopWords.find(([pattern]) => pattern.test(code))?.[1] ?? code.replaceAll("_", " ");
}

export function outcomeOf(run: DemoRun): Outcome {
  // A held video the user chose to receive later is delivered, even though the run itself ended in review.
  if (run.session?.status === "completed") return { tone: "ready", label: "Ready", ...(run.session.qualityReview?.accepted ? { detail: "Delivered after review" } : {}) };
  if (run.status === "awaiting_code") return { tone: "waiting", label: "Waiting for you", detail: "Enter the e-mailed code on the secure link your agent sent" };
  if (run.status === "needs_input") return { tone: "waiting", label: "Waiting for you", detail: "Your agent needs a field value to continue" };
  if (run.status === "agent_driving") return { tone: "live", label: "Navigating", detail: run.handoff ? "Your agent took over from Toru" : "Your agent is driving" };
  if (run.active || TRACK.some(step => step.key === run.status)) {
    const step = TRACK.find(item => item.key === trackPosition(run.status));
    const percent = run.status === "rendering" ? run.session?.progress?.percent : undefined;
    return { tone: "live", label: step?.label ?? "Working", ...(percent !== undefined ? { detail: `${percent}%` } : {}) };
  }
  if (run.status === "done") return { tone: "ready", label: "Ready" };
  if (run.status === "needs_review") {
    const reasons = run.qualityReasons ?? run.session?.qualityReview?.reasons ?? [];
    return { tone: "review", label: "Needs review", detail: `Not charged${reasons.length ? ` · ${reasons.map(qualityReason).join(", ")}` : ""}` };
  }
  if (run.status === "canceled") return { tone: "stopped", label: "Canceled" };
  const detail = stopReason(run.reason);
  return { tone: "stopped", label: "Didn't finish", ...(detail ? { detail } : {}) };
}

export function domainOf(url?: string) {
  if (!url) return undefined;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return undefined; }
}
export function durationLabel(ms?: number) {
  if (!ms || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
export function relativeTime(iso: string, now = Date.now()) {
  const diff = Math.max(0, now - Date.parse(iso)), minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Where the demo is recorded: the user's own Chrome (Toru for Chrome) or an app on their Mac (Toru for Mac). */
export type PromptRoute = "chrome" | "mac";
const planAsk = "First read the code (or the live app) and write the step-by-step plan Toru needs: each screen, the exact button and field labels, the values to use and what the last screen shows.";
/** The prompt the user pastes into their agent: the plan first, then one run on the chosen route. */
export function demoPrompt({ url, flow, route, app }: { url: string; flow: string; route: PromptRoute; app?: string }) {
  const goal = flow.trim() || "create a new item and end with the result visible";
  const done = "Keep checking recording_run_status. When it's done, give me the MP4 and GIF links from recording_links.";
  if (route === "mac") {
    const name = app?.trim();
    return `Record a demo of ${name || "my app"} on my Mac with Toru: ${goal}.\n${planAsk}\nPick ${name ? `the ${name} window` : "its window"} with desktop_sources and desktop_select_source, then run it with desktop_recording_run. ${done}`;
  }
  const target = url.trim() || "https://app.example.com";
  return `Record a demo of ${target} with Toru in my own Chrome: ${goal}.\n${planAsk}\nUse my connected Chrome (extension_devices) and run it with recording_run. ${done}`;
}
