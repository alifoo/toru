#!/usr/bin/env node
// Launch-day numbers from the private metrics endpoint, in one screen.
//
//   INVITE_ADMIN_KEY=… node scripts/launch-dashboard.mjs            # https://mcp.toru.tools
//   RECORDER_MONITOR_URL=http://127.0.0.1:3002 … node scripts/launch-dashboard.mjs
//   node scripts/launch-dashboard.mjs --json                        # raw metrics
//
// The key is read from the environment only (never from arguments), and nothing here writes anywhere.

const origin = (process.env.RECORDER_MONITOR_URL ?? 'https://mcp.toru.tools').replace(/\/$/, '');
const key = process.env.INVITE_ADMIN_KEY;
if (!key) { console.error('INVITE_ADMIN_KEY is required: the admin key of the recorder you are monitoring.'); process.exit(2); }

const response = await fetch(`${origin}/admin/metrics`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
if (!response.ok) { console.error(`metrics: HTTP ${response.status}`); process.exit(1); }
const metrics = await response.json();
if (process.argv.includes('--json')) { console.log(JSON.stringify(metrics, null, 1)); process.exit(0); }

const product = metrics.product ?? {};
const minutes = ms => `${Math.round((ms ?? 0) / 60_000)} min`;
const gb = bytes => `${((bytes ?? 0) / 1e9).toFixed(2)} GB`;
const pad = (label, value) => `${label.padEnd(34)}${value}`;
const sum = (groups, event, field = 'accounts') => (groups ?? []).filter(g => g.event === event).reduce((n, g) => n + (g[field] ?? 0), 0);
const events = product.groups ?? [];
const admissions = product.admissionOutcomes?.groups ?? [];
const budget = product.renderBudget ?? {};
const today = metrics.todayUtc ?? {};
const feedback = product.feedback?.groups ?? [];

const lines = [
  `Toru · ${origin} · observed ${metrics.observedAt}`,
  '',
  `Funnel, last 30 days (accounts that reached each step; internal and test accounts included)`,
  pad('  admitted', sum(events, 'admission_granted')),
  pad('  first MCP call', sum(events, 'mcp_connected')),
  pad('  started a demo', sum(events, 'demo_started')),
  pad('  finished a capture', sum(events, 'capture_finalized')),
  pad('  render completed', sum(events, 'render_completed')),
  pad('  downloaded', sum(events, 'download_completed')),
  pad('  demos started (events)', sum(events, 'demo_started', 'events')),
  pad('  renders completed (events)', sum(events, 'render_completed', 'events')),
  '',
  `Credits, last 30 days (jobs admitted by credit source)`,
  ...admissions.map(g => pad(`  ${g.cohort}/${g.source}`, `${g.admittedJobs} admitted · ${g.committed} delivered · ${g.released} released · ${g.reserved} open · ${g.accounts} accounts`)),
  '',
  `Today ${today.day} (UTC)`,
  pad('  active accounts', today.activeOwners ?? 0),
  pad('  browser starts', today.browserStarts ?? 0),
  pad('  browser time', minutes(today.browserMs)),
  pad('  render time', minutes(today.renderMs)),
  pad('  render budget left', `${minutes(budget.remainingMs)} of ${minutes(budget.limitMs)}`),
  '',
  `Service now`,
  pad('  queue', `${JSON.stringify(metrics.queue?.states ?? {})} · oldest wait ${Math.round((metrics.queue?.oldestWaitMs ?? 0) / 1000)} s`),
  pad('  retained jobs', JSON.stringify(metrics.retainedJobs?.states ?? {})),
  pad('  retained error codes', JSON.stringify(metrics.retainedJobs?.errorCodes ?? {})),
  pad('  storage free', `${gb(metrics.storage?.availableBytes)} of ${gb(metrics.storage?.totalBytes)}`),
  pad('  process uptime', `${Math.round((metrics.recorderProcess?.uptimeSeconds ?? 0) / 60)} min`),
  pad('  last retention cleanup', metrics.retention?.lastCleanupFailedAt ? 'FAILED' : 'ok'),
  '',
  `Feedback, last 30 days ("Would you use this video?")`,
  ...(feedback.length ? feedback.map(g => pad(`  ${JSON.stringify(g)}`, '')) : ['  none yet']),
  '',
  `Elsewhere: sign-ups in the Clerk dashboard · visits and CTA clicks in Vercel Web Analytics · revenue in Stripe · installs in the Chrome Web Store.`,
];
console.log(lines.join('\n'));
