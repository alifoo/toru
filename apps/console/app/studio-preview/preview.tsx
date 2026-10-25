"use client";
import { useEffect, useState } from "react";
import { DemoDetail, DemosHome, RecordingDetail, type LibraryRecording } from "../demos";
import { AgentInstall, OnboardingFlow } from "../onboarding-flow";
import { McpConnections } from "../mcp-connections";
import { MacDevices } from "../mac-devices";
import { ChromeDevices } from "../chrome-devices";
import { PlanCards } from "../pricing/pricing";
import { WorkspaceFrame, useWorkspaceRoute } from "../workspace-frame";
import { Brands } from "../brands";
import { DemoAccounts } from "../demo-accounts";
import type { DemoRun } from "../demo-status";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
/** The Linear demo on the landing page, as the run screen would get it from a render's timeline. */
const linearPlan = { finalState: "The issue list shows TOR-17 “Record the launch video” and a toast confirms it was created.", steps: [
  { screen: "Issues", action: "click", target: 'row "CSV export times out on large workspaces"', expect: "The issue opens" },
  { screen: "Issue TOR-3", action: "select", target: 'menu "Done"', expect: "The status reads Done" },
  { screen: "Issue TOR-3", action: "press", target: 'key "Escape"', expect: "Back on the issue list" },
  { screen: "Issues", action: "click", target: 'button "New issue"', expect: "The new issue form opens" },
  { screen: "New issue", action: "type", target: 'field "Title"', value: "Record the launch video", expect: "The title is filled" },
  { screen: "New issue", action: "click", target: 'button "Create issue"', expect: "TOR-17 is listed" },
] };
/** Where each step landed on the video's clock; the Escape press left no labelled action, so it stays unplaced. */
const placed: Array<[number, number] | undefined> = [[1_500, 7_200], [7_200, 12_400], undefined, [12_400, 17_600], [17_600, 25_300], [25_300, 34_766]];
const linearStudio = { outputDurationMs: 34_766, introMs: 0, outroMs: 0,
  steps: linearPlan.steps.map((step, index) => { const at = placed[index]; return at ? { ...step, index, matched: true, startMs: at[0], endMs: at[1] } : { ...step, index, matched: false }; }),
  zooms: [{ startMs: 900, endMs: 5_200, scale: 1.5, element: "row CSV export times out" }, { startMs: 6_600, endMs: 11_000, scale: 1.6, element: "menuitem Done" },
    { startMs: 11_800, endMs: 15_900, scale: 1.4, element: "button New issue" }, { startMs: 17_200, endMs: 24_600, scale: 1.6, element: "textbox Title" }, { startMs: 26_400, endMs: 31_800, scale: 1.3, element: "Issues" }],
  cuts: [{ atMs: 9_800, removedMs: 2_400 }, { atMs: 21_000, removedMs: 3_100 }],
  cursor: { scale: 2.4, smooth: true },
  settings: { background: "toru-sky", padding: 30, radius: 12, width: 1920, height: 1080, gif: true, logo: false, cards: false, zoom: { enabled: true }, compressPauses: true } };

const runs: DemoRun[] = [
  { runId: id(1), status: "rendering", active: true, title: "Create a project named Launch and invite a teammate", url: "https://app.acme.com", route: "local-browser", startedAt: ago(1), stages: { planning: ago(1), navigating: ago(1), recording: ago(0.5), rendering: ago(0.2) }, session: { status: "rendering", progress: { percent: 62 } } },
  { runId: id(2), status: "awaiting_code", active: true, waitingForUser: true, title: "Show the billing page and change the plan", url: "https://billing.globex.io", route: "hosted-email-only", startedAt: ago(4), stages: { planning: ago(4), connecting: ago(4), awaiting_code: ago(3) } },
  { runId: id(3), status: "done", title: "Mark the CSV export issue Done and create the launch video issue", url: "https://toru.tools", route: "local-browser", sessionId: id(8), startedAt: ago(42), finishedAt: ago(40), stages: { planning: ago(42), navigating: ago(41), recording: ago(41), rendering: ago(40), done: ago(40) }, session: { status: "completed", durationMs: 41200, branding: { brand: true, applied: [], gif: true }, credits: { available: 2 } }, previewUrl: "/landing/linear.jpg", videoUrl: "/landing/linear.mp4", gifUrl: "/landing/linear.jpg", downloadUrl: "#", rawUrl: "#", planUrl: "#", eventsUrl: "#", actions: 9, plan: linearPlan, studio: linearStudio },
  { runId: id(4), status: "needs_review", title: "Open the analytics dashboard", url: "https://app.initech.com", route: "local-browser", startedAt: ago(180), stages: { planning: ago(180), navigating: ago(180), recording: ago(179), rendering: ago(178), needs_review: ago(178) }, qualityReasons: ["blank_frames"], sessionId: id(9), session: { status: "captured", needsReview: true }, rawUrl: "#", planUrl: "#", plan: { finalState: "The analytics dashboard shows this week's chart.", steps: [{ screen: "Home", action: "click", target: 'link "Analytics"', expect: "The dashboard opens" }, { screen: "Analytics", action: "click", target: 'button "This week"', expect: "The chart updates" }] } },
  { runId: id(5), status: "failed", reason: "navigation_exhausted", title: "Submit the onboarding form with a new company", url: "https://app.umbrella.dev", route: "local-browser", startedAt: ago(60 * 26), stages: { planning: ago(1561), navigating: ago(1561), recording: ago(1560) }, session: { status: "captured" } },
];

const recordings: LibraryRecording[] = [
  { id: id(9), status: "captured", createdAt: ago(180) },
  { id: "00000000-0000-4000-8000-000000000008", status: "completed", createdAt: ago(60 * 30), durationMs: 72000, previewUrl: "/landing/demo-poster.jpg", videoUrl: "/landing/demo.mp4", downloadUrl: "#" },
];
let saved: Array<{ origin: string; username: string; kind: string; createdAt?: number; lastUsedAt?: number | null }> = [{ origin: "https://acme.example", username: "demo@acme.example", kind: "password", createdAt: Date.now(), lastUsedAt: Date.now() - 3600000 }];
/** Stubs the console APIs the components call, so the preview runs without auth or a recorder. */
export function StudioPreview() {
  const route = useWorkspaceRoute(), [ready, setReady] = useState(false);
  const empty = typeof window !== "undefined" && window.location.search.includes("empty");
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input), window.location.origin);
      if (url.pathname === "/api/runs") {
        const one = url.searchParams.get("id");
        if (one) { const run = runs.find(item => item.runId === one); return run ? Response.json({ run: { ...run, goal: run.title, events: [{ at: run.startedAt, event: "session_open" }, { at: run.startedAt, event: "stage", state: "navigating" }] } }) : new Response("{}", { status: 404 }); }
        return Response.json({ runs: empty ? [] : runs, nextBefore: null });
      }
      if (url.pathname === "/api/recordings/accept" || url.pathname === "/api/recordings/render") return Response.json({ status: "rendering" }, { status: 202 });
      if (url.pathname === "/api/brands/suggest") return Response.json({ suggestion: { origin: "https://linear.app", name: "Linear", accent: "#5e6ad2", found: { accent: "theme-color" } } });
      if (url.pathname === "/api/brands" && init?.method === "POST") return Response.json({ brand: {} });
      if (url.pathname === "/api/brands") return Response.json({ brands: [{ origin: "https://acme.example", brand: { accent: "#d36b59", cards: true, gif: true, width: 1920 }, updatedAt: Date.now() - 86400000 }, { origin: "*", brand: { accent: "#405f6d" }, updatedAt: Date.now() - 2 * 86400000 }] });
      if (url.pathname === "/api/connections") return Response.json({ connected: performance.now() > 8000, blocked: false, lastUsedAt: null });
      if (url.pathname === "/api/extension-devices") {
        if (init?.method === "POST") return Response.json({ connectUrl: "about:blank", expiresAt: ago(-10) });
        return Response.json({ available: true, devices: window.location.search.includes("online") ? [{ connectionId: id(7), name: "Chrome on Mac", status: "ready" }] : [] });
      }
      if (url.pathname === "/api/devices") {
        if (init?.method === "POST") return Response.json({ pairingCode: "K7Q2-9XMB", setupUrl: "#", expiresAt: ago(-5) });
        return Response.json({ devices: window.location.search.includes("online") ? [{ id: id(6), name: "MacBook Pro", status: "ready", control: true }] : [] });
      }
      if (url.pathname === "/api/demo-accounts") {
        if (init?.method === "POST") { const body = JSON.parse(String(init.body)); saved = [{ origin: body.url, username: body.username, kind: body.kind }, ...saved]; return Response.json({ account: saved[0] }); }
        return Response.json({ accounts: saved });
      }
      return original(input, init);
    };
    setReady(true);
    return () => { window.fetch = original; };
  }, [empty]);
  if (!ready) return null;
  const usage = { mode: "hosted", available: 2, admission: { state: "admitted" } };
  const view = route.view;
  if (window.location.pathname.endsWith("/onboarding")) return <OnboardingFlow mode={window.location.search.includes("from=demos") ? "new" : "setup"} onFinish={() => { window.location.assign("/studio-preview#demos"); }} />;
  const titles: Record<string, string> = { demos: "Demos", brand: "Settings", accounts: "Saved logins", agents: "Connections", plan: "Billing" };
  return <WorkspaceFrame route={route} locked={false} available={2} title={view === "demo" || view === "recording" ? null : titles[view] ?? view} newDemoHref="/studio-preview/onboarding?step=prompt&from=demos" identity={<span className="preview-avatar" aria-label="Account">AA</span>}>
    {view === "demos" && <DemosHome usage={usage} recordings={empty ? [] : recordings} recordingsState="ready" />}
    {view === "demo" && route.param && <DemoDetail key={route.param} id={route.param} usage={usage} />}
    {view === "brand" && <Brands />}
    {view === "accounts" && <DemoAccounts />}
    {view === "plan" && <div className="bl"><section className="cx-card bl-usage"><div className="bl-balance"><b className="st-mono">2</b><span>credits available</span></div><div className="bl-meter" aria-hidden="true"><i style={{ width: "80%" }} /></div><dl className="bl-facts"><div><dt>Plan</dt><dd>Free</dd></div><div><dt>Used</dt><dd className="st-mono">8</dd></div><div><dt>Renews</dt><dd>Nov 1</dd></div><div><dt>Per capture</dt><dd>Up to 2 min</dd></div><div><dt>Videos kept</dt><dd>7 days</dd></div></dl></section><section className="bl-plans"><PlanCards signedIn loaded /></section></div>}
    {view === "agents" && <McpConnections newRecording={false}>{connected => <>
      <div className="cx-devices"><ChromeDevices /><MacDevices /></div>
      <details className="cx-card cx-more" open={!connected}><summary><b>{connected ? "Connect another agent" : "Connect your agent"}</b><span>Claude Code, Claude, Cursor, Codex or any MCP client. Toru adds itself as tools.</span></summary><AgentInstall /></details>
      <details className="cx-card cx-more"><summary><b>Advanced</b><span>The MCP address, manual tokens and the instructions for your agent.</span></summary><p className="cx-quiet">Shown in the console.</p></details>
    </>}</McpConnections>}
    {view === "recording" && route.param && <RecordingDetail recording={recordings.find(item => item.id === route.param)} loading={false} />}
  </WorkspaceFrame>;
}
