import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RunController } from './runs.js';
import { openRecorderStore } from './store/open.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
/** The agent's plan every run carries; its values and end state reach the navigator. */
const PLAN = { steps: [{ screen: 'Items list', action: 'click', target: 'button "New item"', expect: 'The new item form opens' }], finalState: 'The new item appears in the list' };
const reply = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
/** What the server answers while another account's session or render holds the recorder. */
const busy = (): CallToolResult => { const data = { code: 'capacity_busy', retryable: true, scope: 'service', retryAfterMs: 20, queued: false }; return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; };
/** A scripted recorder: every tool answers from a tiny state machine, so the orchestration order is what is under test. */
function fake(options: { navigation?: string; review?: boolean; captureFails?: boolean; slow?: boolean; connect?: 'code' | 'vault'; signedInUrl?: string; startFails?: string; busyOpens?: number; busyRenders?: number } = {}) {
  const sessionId = randomUUID(), connectionId = randomUUID(), calls: string[] = [];
  let status = 'ready', navigation = 'running', polls = 0, renders = 0, connectionPolls = 0, codeSubmitted = false, busyOpens = options.busyOpens ?? 0, busyRenders = options.busyRenders ?? 0;
  const call = vi.fn(async (_owner: string, name: string, args: unknown) => {
    calls.push(name);
    const a = args as Record<string, unknown>;
    switch (name) {
      case 'session_connect': return reply({ id: connectionId, connectionStatus: 'verifying', ...(a.loginEmail ? { emailOnly: true } : {}), ...(a.useDemoAccount ? { demoAccount: true } : {}) });
      case 'connection_status': {
        connectionPolls++;
        if (options.connect === 'code' && !codeSubmitted) return reply({ id: connectionId, connectionStatus: connectionPolls >= 2 ? 'awaiting_code' : 'verifying' });
        return reply({ id: connectionId, connectionStatus: 'ready', importId: randomUUID(), ...(options.signedInUrl ? { signedInUrl: options.signedInUrl } : {}) });
      }
      // In-process the recorder throws the bare code; through the MCP boundary it is an error result. Both shapes are covered.
      case 'session_open': if (options.connect && !a.importId) throw new Error('import_expected'); if (busyOpens-- > 0) throw new Error('capacity_busy'); return reply({ id: sessionId, status });
      case 'recording_start': if (options.startFails) throw Object.assign(new Error('WebDriver command failed'), { code: options.startFails }); status = 'recording'; return reply({ id: sessionId, status });
      case 'navigation_start': return reply({ id: sessionId, status: 'running', actions: 0, decisions: 0, costUsd: 0 });
      case 'navigation_status': if (options.slow) await new Promise(resolve => setTimeout(resolve, 60)); navigation = ++polls >= 2 ? (options.navigation ?? 'done') : 'running'; return reply({ id: sessionId, status: navigation, actions: polls, decisions: polls, costUsd: 0.01 * polls, ...(navigation === 'blocked' ? { reason: 'model_blocked', lastPage: 'https://app.example.com/home' } : {}) });
      case 'recording_stop': status = options.captureFails ? 'interrupted' : 'captured'; return reply({ id: sessionId, status });
      case 'recording_render': if (busyRenders-- > 0) return busy(); renders++; status = 'rendering'; return reply({ id: sessionId, status });
      case 'recording_status':
        if (status === 'rendering') status = options.review ? 'captured' : 'completed';
        return reply({ id: sessionId, status, durationMs: 4000, ...(options.review && status === 'captured' && renders ? { needsReview: true, errorCode: 'quality_review', qualityReview: { passed: false, reasons: ['blank_frames'] } } : {}) });
      case 'recording_cancel': status = 'captured'; return reply({ id: sessionId, status });
      default: return reply({ id: sessionId, status, ...(a.id ? {} : {}) });
    }
  });
  return { call, calls, sessionId, connectionId, renders: () => renders, submitCode: () => { codeSubmitted = true; } };
}
async function harness(options?: Parameters<typeof fake>[0]) {
  const dir = await mkdtemp(join(tmpdir(), 'runs-')), owner = randomUUID();
  const db = await openRecorderStore(dir);
  db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner, Date.now());
  const recorder = fake(options);
  const controller = new RunController(recorder, { artifactDir: async () => dir }, db);
  // A handoff nobody takes ends quickly here; in production the agent gets two minutes to notice.
  controller.handoffIdleMs = 100;
  // Every run writes a last checkpoint when it ends; let that land before the database closes under it.
  cleanups.push(async () => {
    await Promise.allSettled([...(controller as unknown as { runs: Map<string, { done: Promise<void> }> }).runs.values()].map(run => run.done));
    db.close(); await rm(dir, { recursive: true, force: true });
  });
  return { dir, owner, db, recorder, controller };
}
const settled = async (controller: RunController, owner: string, runId: string) => {
  let status: Record<string, unknown> = {};
  await vi.waitFor(async () => { status = (await controller.call(owner, 'recording_run_status', { runId, waitMs: 0 })).structuredContent as Record<string, unknown>; expect(['done', 'needs_review', 'failed', 'canceled']).toContain(status.status); }, { timeout: 5000 });
  return status;
};
it('drives open, record, navigate, stop, render and check in order, writing plan and events', async () => {
  const h = await harness();
  const requestId = randomUUID();
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId, url: 'https://app.example.com', goal: 'Create a demo item', values: { Name: 'Demo' } })).structuredContent as Record<string, unknown>;
  expect(started.status).toBe('planning');
  const done = await settled(h.controller, h.owner, String(started.runId));
  expect(done).toMatchObject({ status: 'done', sessionId: h.recorder.sessionId, actions: 2, nextCall: { name: 'recording_links' } });
  expect(h.recorder.calls.filter(n => !['navigation_status', 'recording_status'].includes(n))).toEqual(['session_open', 'recording_start', 'navigation_start', 'recording_stop', 'recording_render']);
  const render = h.recorder.call.mock.calls.find(([, name]) => name === 'recording_render')![2] as Record<string, unknown>;
  expect(render).toMatchObject({ id: h.recorder.sessionId, requestId: started.runId });
  const plan = JSON.parse(await readFile(join(h.dir, 'plan.json'), 'utf8'));
  expect(plan).toMatchObject({ goal: 'Create a demo item', valueFields: ['Name'], route: 'hosted' });
  expect(plan).not.toHaveProperty('values');
  const events = (await readFile(join(h.dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(e => e.event)).toEqual(['session_open', 'stage', 'recording_start', 'navigation', 'stage', 'capture', 'stage', 'stage', 'delivered']);
  // Same requestId returns the same run; a different payload is a conflict.
  expect((await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId, url: 'https://app.example.com', goal: 'Create a demo item', values: { Name: 'Demo' } })).structuredContent?.runId).toBe(started.runId);
  await expect(h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId, url: 'https://app.example.com', goal: 'Other' })).rejects.toThrow('request_id_conflict');
  const row = h.db.connection.prepare('SELECT checkpoint FROM demo_runs WHERE id=?').get(String(started.runId));
  expect(String(row!.checkpoint)).not.toContain('"Demo"'); expect(String(row!.checkpoint)).not.toContain('guidance');
});
it('ends in needs_review without delivery when the video fails the check', async () => {
  const h = await harness({ review: true });
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Show the blank page' })).structuredContent as Record<string, unknown>;
  const result = await settled(h.controller, h.owner, String(started.runId));
  expect(result).toMatchObject({ status: 'needs_review', qualityReasons: ['blank_frames'], sessionId: h.recorder.sessionId });
  expect(String(result.instruction)).toContain('no credit');
});
it('fails with the navigation outcome but keeps the capture when Jev does not finish', async () => {
  const h = await harness({ navigation: 'blocked' });
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Do the thing' })).structuredContent as Record<string, unknown>;
  const result = await settled(h.controller, h.owner, String(started.runId));
  expect(result).toMatchObject({ status: 'failed', reason: 'navigation_blocked', navigationReason: 'model_blocked', lastPage: 'https://app.example.com/home' });
  expect(h.recorder.calls).toContain('recording_stop');
  expect(h.recorder.renders()).toBe(0);
});
it('rejects a second concurrent run per account and marks active runs interrupted after a restart', async () => {
  const h = await harness();
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  await expect(h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Another' })).rejects.toThrow('run_in_progress');
  await expect(h.controller.call(randomUUID(), 'recording_run_status', { runId: started.runId })).rejects.toThrow('run_not_found');
  // A fresh controller over the same database never replays browser actions.
  const reopened = new RunController(h.recorder, { artifactDir: async () => h.dir }, h.db);
  const recovered = (await reopened.call(h.owner, 'recording_run_status', { runId: started.runId, waitMs: 0 })).structuredContent as Record<string, unknown>;
  expect(recovered).toMatchObject({ status: 'interrupted', reason: 'server_restarted' });
  await settled(h.controller, h.owner, String(started.runId));
});
it('cancels a running run and stops the capture', async () => {
  const h = await harness({ slow: true });
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  await vi.waitFor(() => expect(h.recorder.calls).toContain('navigation_start'));
  const canceled = (await h.controller.call(h.owner, 'recording_run_cancel', { runId: started.runId })).structuredContent as Record<string, unknown>;
  expect(canceled).toMatchObject({ status: 'canceled', reason: 'client_canceled' });
  expect(h.recorder.calls).toContain('recording_stop');
});

it('signs in with e-mail only, pauses for the user code, then records with the imported session', async () => {
  const h = await harness({ connect: 'code' });
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item', loginEmail: 'demo@example.com' })).structuredContent as Record<string, unknown>;
  let paused: Record<string, unknown> = {};
  await vi.waitFor(async () => { paused = (await h.controller.call(h.owner, 'recording_run_status', { runId: started.runId, waitMs: 0 })).structuredContent as Record<string, unknown>; expect(paused.status).toBe('awaiting_code'); });
  expect(paused).toMatchObject({ connectionId: h.recorder.connectionId, userActionRequired: true, nextCall: { name: 'connection_status', arguments: { id: h.recorder.connectionId } } });
  expect(String(paused.instruction)).toContain('never in chat');
  h.recorder.submitCode();
  const done = await settled(h.controller, h.owner, String(started.runId));
  expect(done.status).toBe('done');
  expect(Object.keys(done.stages as object)).toEqual(expect.arrayContaining(['connecting', 'awaiting_code', 'planning', 'navigating', 'rendering', 'done']));
  const plan = JSON.parse(await readFile(join(h.dir, 'plan.json'), 'utf8'));
  expect(plan.route).toBe('hosted-email-only');
  expect(JSON.stringify(plan)).not.toContain('demo@example.com');
});
it('uses a saved demo account for a fully unattended hosted run', async () => {
  const h = await harness({ connect: 'vault' });
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item', useDemoAccount: true })).structuredContent as Record<string, unknown>;
  const done = await settled(h.controller, h.owner, String(started.runId));
  expect(done.status).toBe('done');
  const connect = h.recorder.call.mock.calls.find(([, name]) => name === 'session_connect')![2] as Record<string, unknown>;
  expect(connect).toMatchObject({ useDemoAccount: true });
  expect(JSON.parse(await readFile(join(h.dir, 'plan.json'), 'utf8')).route).toBe('hosted-demo-account');
});

it('lists runs newest first with a short title, url and route, and keeps typed values out', async () => {
  const h = await harness();
  const first = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item named Launch and open its settings page to show the new toggle', values: { Name: 'secret-value' } })).structuredContent as Record<string, unknown>;
  await settled(h.controller, h.owner, String(first.runId));
  const second = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://other.example.com', goal: 'Show billing', loginEmail: 'demo@example.com' })).structuredContent as Record<string, unknown>;
  await settled(h.controller, h.owner, String(second.runId));
  const page = h.controller.list(h.owner, { limit: 1 });
  expect(page.runs).toHaveLength(1);
  expect(page.runs[0]).toMatchObject({ runId: second.runId, title: 'Show billing', url: 'https://other.example.com', route: 'hosted-email-only', active: false });
  expect(page.nextBefore).toBeTypeOf('number');
  const older = h.controller.list(h.owner, { limit: 5, before: page.nextBefore! });
  expect(older.runs.map(run => run.runId)).toEqual([first.runId]);
  expect(older.runs[0]!.title).toBe('Create a demo item named Launch and open its…');
  expect(h.controller.get(h.owner, String(first.runId))).toMatchObject({ status: 'done', sessionId: h.recorder.sessionId });
  expect(h.controller.get(randomUUID(), String(first.runId))).toBeUndefined();
  expect(h.controller.list(randomUUID()).runs).toEqual([]);
  const stored = h.db.connection.prepare('SELECT checkpoint FROM demo_runs').all().map(row => String(row.checkpoint)).join('');
  expect(stored).not.toContain('secret-value'); expect(stored).not.toContain('demo@example.com');
  // A fresh controller (server restart) still lists runs older than the live window from the database.
  const reopened = new RunController(h.recorder, { artifactDir: async () => h.dir }, h.db);
  expect(reopened.list(h.owner).runs.map(run => run.runId)).toEqual([second.runId, first.runId]);
});

it('after a saved sign-in, a bare home page opens where the login landed; a specific path is kept', async () => {
  const h = await harness({ connect: 'vault', signedInUrl: 'https://app.example.com/home' });
  const first = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://example.com', goal: 'Open the spreadsheets page', useDemoAccount: true })).structuredContent as Record<string, unknown>;
  expect((await settled(h.controller, h.owner, String(first.runId))).status).toBe('done');
  const opens = () => h.recorder.call.mock.calls.filter(([, name]) => name === 'session_open').map(([, , args]) => (args as Record<string, unknown>).url);
  expect(opens()).toEqual(['https://app.example.com/home']);
  const second = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://example.com/sheets', goal: 'Open the spreadsheets page', useDemoAccount: true })).structuredContent as Record<string, unknown>;
  await settled(h.controller, h.owner, String(second.runId));
  expect(opens()).toEqual(['https://app.example.com/home', 'https://example.com/sheets']);
});

it('reports the browser error code, not the generic WebDriver message', async () => {
  const h = await harness({ startFails: 'loader_visible' });
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Open the home page' })).structuredContent as Record<string, unknown>;
  expect(await settled(h.controller, h.owner, String(started.runId))).toMatchObject({ status: 'failed', reason: 'loader_visible' });
});

it('refuses a run without the agent plan, or with a malformed one, before opening anything', async () => {
  const h = await harness();
  await expect(h.controller.call(h.owner, 'recording_run', { requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).rejects.toThrow('plan_required');
  await expect(h.controller.call(h.owner, 'recording_run', { requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item', plan: { steps: [], finalState: 'x' } })).rejects.toThrow('plan_invalid');
  // A presentation that points nothing out is sent back for its attention points.
  const walkthrough = { steps: [{ screen: 'Items', action: 'click', target: 'button "New item"', expect: 'The form opens' }], finalState: 'The new item is listed' };
  await expect(h.controller.call(h.owner, 'recording_run', { requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item',
    plan: { ...walkthrough, intent: 'presentation' } })).rejects.toThrow('plan_needs_attention');
  expect(h.recorder.calls).toEqual([]);
});

it('turns the plan into the navigator script, its values and its success condition, and keeps it in plan.json', async () => {
  const h = await harness();
  const plan = { preconditions: ['A customer named Acme exists'],
    steps: [{ screen: 'Invoices (/invoices)', action: 'click', target: 'button "New invoice"', expect: 'The "New invoice" dialog opens' },
      { screen: 'New invoice dialog', action: 'type', target: 'field "Customer"', value: 'Acme Inc.', expect: 'Acme Inc. is selected' }],
    finalState: 'The invoice page shows status "Draft" for Acme Inc.', avoid: ['Do not send the invoice'], sources: ['src/invoices/new.tsx:42'] };
  const run = await h.controller.call(h.owner, 'recording_run', { requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create an invoice', plan, values: { Notes: 'Thanks' } });
  const runId = (run.structuredContent as { runId: string }).runId;
  await vi.waitFor(() => expect(h.recorder.calls).toContain('navigation_start'));
  const start = h.recorder.call.mock.calls.find(([, name]) => name === 'navigation_start')![2] as { guidance: string; values: Record<string, string>; success: string };
  expect(start.guidance).toContain('1. On Invoices (/invoices): click button "New invoice" -> The "New invoice" dialog opens');
  expect(start.guidance).toContain('2. On New invoice dialog: type field "Customer" = "Acme Inc." -> Acme Inc. is selected');
  expect(start.guidance).toContain('Before: A customer named Acme exists');
  expect(start.guidance).toContain('Never: Do not send the invoice');
  expect(start.guidance).not.toContain('src/invoices/new.tsx');
  expect(start.values).toEqual({ Customer: 'Acme Inc.', Notes: 'Thanks' });
  expect(start.success).toBe('The invoice page shows status "Draft" for Acme Inc.');
  await vi.waitFor(async () => expect(((await h.controller.call(h.owner, 'recording_run_status', { runId })).structuredContent as { status: string }).status).toBe('done'), { timeout: 5000 });
  const saved = JSON.parse(await readFile(join(h.dir, 'artifacts', h.owner, (await h.controller.call(h.owner, 'recording_run_status', { runId })).structuredContent!.sessionId as string, 'plan.json'), 'utf8').catch(() => '{}'));
  if (saved.plan) expect(saved.plan.sources).toEqual(['src/invoices/new.tsx:42']);
});

it('gives a field the plan fills several times its values in order', async () => {
  const h = await harness();
  const plan = { steps: ['First task', 'Second task', 'Third task'].map(value => ({ screen: 'todos', action: 'type', target: 'field "What needs to be done?"', value, expect: `${value} is added` })),
    finalState: 'Three tasks are listed' };
  await h.controller.call(h.owner, 'recording_run', { requestId: randomUUID(), url: 'https://app.example.com', goal: 'Add three tasks', plan });
  await vi.waitFor(() => expect(h.recorder.calls).toContain('navigation_start'));
  const start = h.recorder.call.mock.calls.find(([, name]) => name === 'navigation_start')![2] as { values: Record<string, string>; sequences: Record<string, string[]> };
  expect(start.values).toEqual({});
  expect(start.sequences).toEqual({ 'What needs to be done?': ['First task', 'Second task', 'Third task'] });
});

it('passes the chosen page layout to the session it opens, and leaves the default to the recorder', async () => {
  const viewportOf = async (extra: Record<string, unknown>) => {
    const h = await harness();
    h.controller.resultHoldMs = 0;
    const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item', localConnectionId: randomUUID(), ...extra })).structuredContent as Record<string, unknown>;
    expect((await settled(h.controller, h.owner, String(started.runId))).status).toBe('done');
    // The run records its end after its last step: let it before the database closes.
    await vi.waitFor(async () => expect((await h.controller.call(h.owner, 'recording_run_status', { runId: String(started.runId), waitMs: 0 })).structuredContent).toHaveProperty('finishedAt'));
    return (h.recorder.call.mock.calls.find(([, name]) => name === 'session_open')![2] as Record<string, unknown>).viewport;
  };
  expect(await viewportOf({ viewport: '1440x900' })).toBe('1440x900');
  expect(await viewportOf({})).toBeUndefined();
  const h = await harness();
  await expect(h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item', viewport: '800x600' })).rejects.toThrow();
});
it('waits its turn when another account holds the recorder, for the session and for the render', async () => {
  const h = await harness({ busyOpens: 2, busyRenders: 1 });
  h.controller.busyRetryMs = 20;
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item', values: {} })).structuredContent as Record<string, unknown>;
  await settled(h.controller, h.owner, String(started.runId));
  let done: Record<string, unknown> = {};
  await vi.waitFor(async () => { done = (await h.controller.call(h.owner, 'recording_run_status', { runId: started.runId, waitMs: 0 })).structuredContent as Record<string, unknown>; expect(done.finishedAt).toBeDefined(); });
  expect(done).toMatchObject({ status: 'done', sessionId: h.recorder.sessionId });
  expect(done.reason).toBeUndefined();
  expect(h.recorder.calls.filter(n => n === 'session_open')).toHaveLength(3);
  expect(h.recorder.calls.filter(n => n === 'recording_render')).toHaveLength(2);
  expect(h.recorder.renders()).toBe(1);
});
it('fails a run only when the recorder stays busy past the wait, not on the first busy answer', async () => {
  const h = await harness({ busyOpens: 1000 });
  h.controller.busyRetryMs = 20;
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item', values: {} })).structuredContent as Record<string, unknown>;
  await new Promise(resolve => setTimeout(resolve, 150));
  const waiting = (await h.controller.call(h.owner, 'recording_run_status', { runId: started.runId, waitMs: 0 })).structuredContent as Record<string, unknown>;
  expect(waiting).toMatchObject({ status: 'planning', reason: 'waiting_for_capacity' });
  await h.controller.call(h.owner, 'recording_run_cancel', { runId: started.runId });
  const canceled = await settled(h.controller, h.owner, String(started.runId));
  expect(canceled.status).toBe('canceled');
});

/** Polls until the run waits for the agent to drive, as an agent following recording_run_status would. */
const driving = async (controller: RunController, owner: string, runId: string) => {
  let status: Record<string, unknown> = {};
  await vi.waitFor(async () => { status = (await controller.call(owner, 'recording_run_status', { runId, waitMs: 0 })).structuredContent as Record<string, unknown>; expect(status.status).toBe('agent_driving'); }, { timeout: 5000 });
  return status;
};
it('lets the agent drive: the run records, waits for its actions and finish, then renders and checks the same way', async () => {
  const h = await harness();
  h.controller.resultHoldMs = 0;
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, navigator: 'agent', requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  const waiting = await driving(h.controller, h.owner, String(started.runId));
  expect(waiting).toMatchObject({ navigator: 'agent', agentDriving: true, finalState: PLAN.finalState, nextCall: { name: 'browser_observe', arguments: { id: h.recorder.sessionId } } });
  expect(waiting).not.toHaveProperty('handoff');
  // The status answers at once while the agent drives, instead of holding the agent for waitMs.
  const before = Date.now();
  await h.controller.call(h.owner, 'recording_run_status', { runId: started.runId, waitMs: 25000 });
  expect(Date.now() - before).toBeLessThan(1000);
  await h.controller.call(h.owner, 'browser_click', { id: h.recorder.sessionId, ref: 'e1' });
  await h.controller.call(h.owner, 'browser_type', { id: h.recorder.sessionId, ref: 'e2', text: 'Demo' });
  await h.controller.call(h.owner, 'browser_observe', { id: h.recorder.sessionId });
  await h.controller.call(h.owner, 'recording_run_finish', { runId: started.runId, outcome: 'reached', note: 'Item visible' });
  const done = await settled(h.controller, h.owner, String(started.runId));
  expect(done).toMatchObject({ status: 'done', actions: 2, costUsd: 0, nextCall: { name: 'recording_links' } });
  expect(h.recorder.calls).not.toContain('navigation_start');
  expect(h.recorder.calls.filter(n => ['session_open', 'recording_start', 'recording_stop', 'recording_render'].includes(n))).toEqual(['session_open', 'recording_start', 'recording_stop', 'recording_render']);
  expect(JSON.parse(await readFile(join(h.dir, 'plan.json'), 'utf8'))).toMatchObject({ navigator: 'agent' });
  const events = (await readFile(join(h.dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events.find(e => e.event === 'agent')).toMatchObject({ outcome: 'reached', actions: 2, note: 'Item visible' });
  await expect(h.controller.call(h.owner, 'recording_run_finish', { runId: started.runId, outcome: 'reached' })).rejects.toThrow('run_not_agent_driving');
});
it('fails without rendering when the agent is stuck or stops calling, keeping the capture', async () => {
  const stuck = await harness();
  const first = (await stuck.controller.call(stuck.owner, 'recording_run', { plan: PLAN, navigator: 'agent', requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  await driving(stuck.controller, stuck.owner, String(first.runId));
  await stuck.controller.call(stuck.owner, 'recording_run_finish', { runId: first.runId, outcome: 'stuck' });
  expect(await settled(stuck.controller, stuck.owner, String(first.runId))).toMatchObject({ status: 'failed', reason: 'navigation_agent_stuck' });
  expect(stuck.recorder.calls).toContain('recording_stop');
  expect(stuck.recorder.renders()).toBe(0);

  const idle = await harness();
  idle.controller.agentIdleMs = 100;
  const second = (await idle.controller.call(idle.owner, 'recording_run', { plan: PLAN, navigator: 'agent', requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  expect(await settled(idle.controller, idle.owner, String(second.runId))).toMatchObject({ status: 'failed', reason: 'navigation_agent_idle' });
  expect(idle.recorder.renders()).toBe(0);
});
it('hands a stalled navigator run to the agent on the same capture, and delivers when the agent finishes it', async () => {
  const h = await harness({ navigation: 'blocked' });
  h.controller.resultHoldMs = 0; h.controller.handoffIdleMs = 5000;
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  const waiting = await driving(h.controller, h.owner, String(started.runId));
  expect(waiting).toMatchObject({ navigator: 'toru', handoff: { from: 'blocked', reason: 'model_blocked', lastPage: 'https://app.example.com/home' } });
  expect(String(waiting.instruction)).toContain('take over');
  expect(h.recorder.calls).not.toContain('recording_stop');
  await h.controller.call(h.owner, 'browser_click', { id: h.recorder.sessionId, ref: 'e9' });
  await h.controller.call(h.owner, 'recording_run_finish', { runId: started.runId, outcome: 'reached' });
  const done = await settled(h.controller, h.owner, String(started.runId));
  // The navigator's two actions and the agent's one.
  expect(done).toMatchObject({ status: 'done', actions: 3 });
  expect(h.controller.list(h.owner).runs[0]).toMatchObject({ navigator: 'toru', handoff: 'blocked', status: 'done' });
});
it('lets the agent drive by default on a server without a Toru navigator', async () => {
  const h = await harness();
  h.controller.defaultNavigator = 'agent';
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  expect(await driving(h.controller, h.owner, String(started.runId))).toMatchObject({ navigator: 'agent' });
  await h.controller.call(h.owner, 'recording_run_cancel', { runId: started.runId });
  expect(h.recorder.calls).not.toContain('navigation_start');
});
it('treats a step-by-step stop while the agent drives as finishing the run, so older clients are not stuck', async () => {
  const h = await harness();
  h.controller.resultHoldMs = 0;
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, navigator: 'agent', requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  await driving(h.controller, h.owner, String(started.runId));
  await h.controller.call(h.owner, 'browser_click', { id: h.recorder.sessionId, ref: 'e1' });
  // The run, not the agent, stops the capture: one recording_stop, after the hold.
  const stopped = (await h.controller.call(h.owner, 'recording_stop', { id: h.recorder.sessionId })).structuredContent as Record<string, unknown>;
  expect(stopped.runId).toBe(started.runId);
  expect(await settled(h.controller, h.owner, String(started.runId))).toMatchObject({ status: 'done', actions: 1 });
  expect(h.recorder.calls.filter(n => n === 'recording_stop')).toHaveLength(1);
  const events = (await readFile(join(h.dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events.find(e => e.event === 'agent')).toMatchObject({ outcome: 'reached', note: 'recording_stop while driving' });
});
it('leaves needs_input as soon as the agent answers the field', async () => {
  const h = await harness();
  const inputId = randomUUID();
  // The navigator asks for one value, then keeps running until the run's next poll.
  let asked = true;
  h.recorder.call.mockImplementation(async (_owner: string, name: string) => {
    if (name === 'session_open') return reply({ id: h.recorder.sessionId, status: 'ready' });
    if (name === 'navigation_status') { await new Promise(resolve => setTimeout(resolve, asked ? 0 : 400)); return reply({ status: asked ? 'needs_input' : 'running', input: { inputId, field: { role: 'textbox', name: 'Name' } } }); }
    if (name === 'navigation_guide') { asked = false; return reply({ status: 'running' }); }
    return reply({ id: h.recorder.sessionId, status: 'recording' });
  });
  const started = (await h.controller.call(h.owner, 'recording_run', { plan: PLAN, requestId: randomUUID(), url: 'https://app.example.com', goal: 'Create a demo item' })).structuredContent as Record<string, unknown>;
  await vi.waitFor(async () => expect((await h.controller.call(h.owner, 'recording_run_status', { runId: started.runId, waitMs: 0 })).structuredContent).toMatchObject({ status: 'needs_input' }));
  await h.controller.call(h.owner, 'navigation_guide', { id: h.recorder.sessionId, inputId, instruction: 'Use this', value: 'Demo' });
  expect((await h.controller.call(h.owner, 'recording_run_status', { runId: started.runId, waitMs: 0 })).structuredContent).toMatchObject({ status: 'navigating' });
  await h.controller.call(h.owner, 'recording_run_cancel', { runId: started.runId });
});
