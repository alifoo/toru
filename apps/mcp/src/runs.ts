import { backgroundCatalog } from '@content-layer/render-contract';
import { createHash, randomUUID } from 'node:crypto';
import { openAfterSignIn } from './sign-in-landing.js';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { compilePlan, planSchema, planValues } from './run-plan.js';
import { viewportSchema } from './viewport.js';
import type { AuthorizationCheck } from './lifecycle.js';
import type { RecorderDatabase } from './store/database.js';

/** One tool call does the whole demo: open, record, let Jev (or the user's agent) drive the flow, stop, render, check. */
export type RunState = 'planning' | 'connecting' | 'awaiting_code' | 'navigating' | 'needs_input' | 'agent_driving' | 'recording' | 'rendering' | 'done' | 'needs_review' | 'failed' | 'canceled' | 'interrupted';
const ACTIVE: readonly RunState[] = ['planning', 'connecting', 'awaiting_code', 'navigating', 'needs_input', 'agent_driving', 'recording', 'rendering'];
const WAITS_FOR_USER: readonly RunState[] = ['needs_input', 'awaiting_code'];
/** Calls on a driving run's session that count as the agent's actions in the run. */
const AGENT_ACTIONS = new Set(['browser_click', 'browser_type', 'browser_key', 'browser_scroll', 'browser_select', 'browser_navigate',
  'browser_point', 'browser_trace', 'browser_sweep', 'browser_read']);
/** Only the run stops its own capture, after holding on the result. An agent that stops it the step-by-step way (an MCP
 * client that listed its tools before recording_run_finish existed does) finishes the run instead: stop = reached. */
const FINISHES_RUN: Record<string, 'reached' | 'stuck'> = { recording_stop: 'reached', recording_cancel: 'stuck', session_close: 'stuck' };
/** Navigator endings the user's agent can still rescue from the current screen. */
const HANDOFF_FROM = new Set(['blocked', 'exhausted', 'failed']);
export const runSchema = z.object({
  requestId: z.uuid(), url: z.string().url().max(2048), goal: z.string().trim().min(3).max(4000),
  /** Who drives the flow: the Toru navigator, or the agent calling the tool (see docs/plans/agent-mode.md). */
  navigator: z.enum(['toru', 'agent']).optional(),
  guidance: z.string().max(12000).optional(), maximumActions: z.number().int().min(1).max(60).default(20),
  values: z.record(z.string().max(200), z.string().max(2000)).default({}),
  /** Required: the step-by-step plan the agent wrote from the product's code (see run-plan.ts). */
  plan: planSchema.optional(),
  /** Filled from the plan: values for a field the flow fills more than once, in order. */
  sequences: z.record(z.string().max(200), z.array(z.string().max(2000)).max(30)).default({}),
  localConnectionId: z.uuid().optional(), importId: z.uuid().optional(), allowedOrigins: z.array(z.string().url()).min(1).max(12).optional(),
  loginEmail: z.string().trim().min(3).max(320).optional(), useDemoAccount: z.boolean().optional(),
  /** The page layout Toru for Chrome records (CSS viewport); 1920x1080 when absent. */
  viewport: viewportSchema.optional(),
  render: z.object({ background: z.enum(['midnight', 'ocean', 'sunset', ...backgroundCatalog.map(entry => entry.id)] as [string, ...string[]]).optional(), padding: z.number().finite().min(0).max(100).optional(),
    cursorScale: z.number().finite().min(0.5).max(3).optional(), compressPauses: z.boolean().optional(), gif: z.boolean().optional(), width: z.union([z.literal(1280), z.literal(1920), z.literal(2560)]).optional() }).default({}),
});
export type RunInput = z.infer<typeof runSchema>;
type Checkpoint = { state: RunState; sessionId?: string; connectionId?: string; reason?: string; navigationReason?: string; lastPage?: string; title?: string; url?: string; route?: string; actions: number; decisions: number; costUsd: number;
  startedAt: number; finishedAt?: number; stages: Partial<Record<RunState, number>>; qualityReasons?: string[]; input?: { inputId: string; field: unknown };
  /** Toru for Mac: the shared window's size for the recording and whether it was resized (desktopWindow from recording_status). */
  desktopWindow?: Record<string, unknown>;
  navigator?: 'toru' | 'agent'; /** The navigator ending the agent took over from. */ handoff?: string };
type AgentOutcome = { outcome: 'reached' | 'stuck' | 'idle'; note?: string };
type Run = Checkpoint & { id: string; owner: string; requestId: string; inputHash: string; controller: AbortController; done: Promise<void>; authorize?: AuthorizationCheck;
  /** While agent_driving: what the plan must end on, when the agent last called a tool on the session, and how the run hears it finished. */
  finalState?: string; lastAgentAt?: number; finish?: (outcome: AgentOutcome) => void };
type Call = (owner: string, name: string, args: unknown, authorize?: AuthorizationCheck) => Promise<CallToolResult>;
export type RunStore = { artifactDir(owner: string, sessionId: string): Promise<string> };
const reply = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const TTL = 24 * 60 * 60_000, RUN_TIMEOUT = 30 * 60_000;
/** The recorder serves one session or render at a time. A run that finds it busy waits its turn (up to BUSY_WAIT) instead of failing. */
const BUSY_WAIT = 10 * 60_000, BUSY_RETRY_TOOLS = new Set(['session_open', 'recording_render']);
/** Runs stay listable in the dashboard as long as the longest video retention; live state (idempotency, polling) only needs a day. */
const RECORD_TTL = 31 * 24 * 60 * 60_000;
/** A short dashboard label from the goal: the first words, never typed values (those live in `values`, not in the goal). */
export function runTitle(goal: string): string {
  const words = goal.replace(/\s+/g, ' ').trim().split(' ');
  const title = words.slice(0, 9).join(' ');
  return (words.length > 9 ? `${title}…` : title).slice(0, 90);
}
export type RunSummary = { runId: string; status: RunState; title?: string; url?: string; route?: string; sessionId?: string; connectionId?: string; reason?: string;
  qualityReasons?: string[]; navigator?: 'toru' | 'agent'; handoff?: string; actions: number; decisions: number; costUsd: number; startedAt: string; finishedAt?: string; stages: Record<string, string>; active: boolean; waitingForUser: boolean };

export class RunController {
  private runs = new Map<string, Run>();
  /** Pause between attempts when the recorder throws capacity_busy in-process (an error result carries its own retryAfterMs). */
  busyRetryMs = 5000;
  /**
   * How long the finished flow stays on screen before the capture stops.
   *
   * The camera holds on the result, but only for as long as there is video: stopping the moment the navigator
   * reached the final state ended a fast run (a Mac app the navigator reads instantly) a beat after its last
   * click, before anyone could read what it had done.
   */
  resultHoldMs = 2_500;
  /** Who drives a run that does not say: the agent when this server has no Toru navigator (self-host without TYPESAFE_API_KEY). */
  defaultNavigator: 'toru' | 'agent' = 'toru';
  /** An agent that chose to drive and then makes no call on the session for this long has left; the run stops. */
  agentIdleMs = 5 * 60_000;
  /** After a handoff the agent may not be watching; the run ends with the navigator's own outcome if it never acts. */
  handoffIdleMs = 2 * 60_000;
  constructor(private readonly recorder: { call: Call }, private readonly artifacts: RunStore, private readonly db?: RecorderDatabase) {
    if (!db) return;
    db.connection.prepare('DELETE FROM demo_runs WHERE expires_at<=?').run(Date.now());
    for (const row of db.connection.prepare('SELECT * FROM demo_runs WHERE created_at>? ORDER BY created_at').all(Date.now() - TTL)) {
      const saved = JSON.parse(String(row.checkpoint)) as Checkpoint;
      const run: Run = { ...saved, id: String(row.id), owner: String(row.owner), requestId: String(row.request_id), inputHash: String(row.input_hash), controller: new AbortController(), done: Promise.resolve() };
      // Browser actions are never replayed. The session job itself is recovered by the recorder (captured or interrupted).
      if (ACTIVE.includes(run.state)) { run.state = 'interrupted'; run.reason = 'server_restarted'; run.finishedAt = Date.now(); }
      this.runs.set(run.id, run); this.persist(run);
    }
  }
  private persist(run: Run) {
    const checkpoint: Checkpoint = { state: run.state, actions: run.actions, decisions: run.decisions, costUsd: run.costUsd, startedAt: run.startedAt, stages: run.stages,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(run.connectionId ? { connectionId: run.connectionId } : {}), ...(run.reason ? { reason: run.reason } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.navigationReason ? { navigationReason: run.navigationReason } : {}), ...(run.lastPage ? { lastPage: run.lastPage } : {}),
      ...(run.qualityReasons ? { qualityReasons: run.qualityReasons } : {}), ...(run.desktopWindow ? { desktopWindow: run.desktopWindow } : {}),
      ...(run.title ? { title: run.title } : {}), ...(run.url ? { url: run.url } : {}), ...(run.route ? { route: run.route } : {}),
      ...(run.navigator ? { navigator: run.navigator } : {}), ...(run.handoff ? { handoff: run.handoff } : {}) };
    // Guidance and typed values stay out of the database; only a short title from the goal is kept for the dashboard. plan.json holds the full goal.
    this.db?.connection.prepare(`INSERT INTO demo_runs(id,owner,request_id,input_hash,created_at,expires_at,checkpoint) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET checkpoint=excluded.checkpoint`).run(run.id, run.owner, run.requestId, run.inputHash, run.startedAt, run.startedAt + RECORD_TTL, JSON.stringify(checkpoint));
  }
  private view(run: Run): CallToolResult {
    const active = ACTIVE.includes(run.state);
    const next = run.state === 'awaiting_code' && run.connectionId
      ? { nextCall: { name: 'connection_status', arguments: { id: run.connectionId } }, userActionRequired: true,
          instruction: 'The product sent a one-time code or magic link to the user. Call connection_status with connectionId to get the setupUrl, show it to the user and ask them to enter the code there (never in chat), then poll recording_run_status again.' }
      : run.state === 'needs_input' && run.input && run.sessionId
      ? { nextCall: { name: 'navigation_guide', arguments: { id: run.sessionId, inputId: run.input.inputId } }, input: run.input,
          instruction: 'The Toru navigator needs a field value. Choose it from the user goal and call navigation_guide with the session id, this inputId and the value. Never send passwords or tokens.' }
      : run.state === 'agent_driving' && run.sessionId
      ? { nextCall: { name: 'browser_observe', arguments: { id: run.sessionId } }, agentDriving: true,
          ...(run.finalState ? { finalState: run.finalState } : {}),
          ...(run.handoff ? { handoff: { from: run.handoff, ...(run.navigationReason ? { reason: run.navigationReason } : {}), ...(run.lastPage ? { lastPage: run.lastPage } : {}) } } : {}),
          instruction: `${run.handoff ? `The Toru navigator stopped short (${run.handoff}) and the capture is still running: you take over from the current screen. ` : 'You drive this recording: the capture is running. '}Follow your plan one action at a time with browser_observe, browser_click, browser_type, browser_key, browser_scroll, browser_select and browser_wait on sessionId, inspecting each returned screenshot before the next action. When finalState is visible, call mark_demo_moment kind result with that screenshot's observationId, then recording_run_finish {runId, outcome:"reached"}: Toru holds on the result, stops, renders and checks the video. If the flow cannot be completed, call recording_run_finish with outcome:"stuck". Without recording_run_finish in your tool list, recording_stop on sessionId finishes the run as reached. Never call recording_render for this session. After ${Math.round((run.handoff ? this.handoffIdleMs : this.agentIdleMs) / 60_000)} minutes without a call on the session the run stops.` }
      : active ? { nextCall: { name: 'recording_run_status', arguments: { runId: run.id, waitMs: 25000 } }, instruction: 'The run continues on the server. Keep calling recording_run_status (waits up to 25 seconds); do not open sessions or record manually meanwhile.' }
      : run.state === 'done' && run.sessionId ? { nextCall: { name: 'recording_links', arguments: { id: run.sessionId } }, instruction: 'The demo passed the delivery check. Call recording_links with the session id and give the user the video link.' }
      : run.state === 'needs_review' && run.sessionId ? { nextCall: { name: 'recording_status', arguments: { id: run.sessionId } }, instruction: `The video failed the delivery check (${(run.qualityReasons ?? []).join(', ')}); it was not delivered and no credit was used. Start a new run with a corrected flow, or call recording_render with acceptReview:true on the session id if the user wants it anyway.` }
      : run.sessionId ? { nextCall: { name: 'recording_status', arguments: { id: run.sessionId } }, instruction: 'The run stopped before delivery. Check recording_status for the session: a captured session can still be rendered with recording_render; otherwise start a new run.' } : {};
    return reply({ runId: run.id, requestId: run.requestId, status: run.state, ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(run.connectionId ? { connectionId: run.connectionId } : {}), ...(run.reason ? { reason: run.reason } : {}),
      ...(run.navigationReason ? { navigationReason: run.navigationReason } : {}), ...(run.lastPage ? { lastPage: run.lastPage } : {}),
      actions: run.actions, decisions: run.decisions, costUsd: run.costUsd, startedAt: new Date(run.startedAt).toISOString(), ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
      stages: Object.fromEntries(Object.entries(run.stages).map(([stage, at]) => [stage, new Date(at).toISOString()])),
      ...(run.qualityReasons ? { qualityReasons: run.qualityReasons } : {}), ...(run.desktopWindow ? { desktopWindow: run.desktopWindow } : {}),
      ...(run.navigator ? { navigator: run.navigator } : {}), ...next });
  }
  private summary(checkpoint: Checkpoint, id: string): RunSummary {
    return { runId: id, status: checkpoint.state, ...(checkpoint.title ? { title: checkpoint.title } : {}), ...(checkpoint.url ? { url: checkpoint.url } : {}),
      ...(checkpoint.route ? { route: checkpoint.route } : {}), ...(checkpoint.sessionId ? { sessionId: checkpoint.sessionId } : {}),
      ...(checkpoint.connectionId ? { connectionId: checkpoint.connectionId } : {}), ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
      ...(checkpoint.qualityReasons ? { qualityReasons: checkpoint.qualityReasons } : {}),
      ...(checkpoint.navigator ? { navigator: checkpoint.navigator } : {}), ...(checkpoint.handoff ? { handoff: checkpoint.handoff } : {}),
      actions: checkpoint.actions, decisions: checkpoint.decisions, costUsd: checkpoint.costUsd, startedAt: new Date(checkpoint.startedAt).toISOString(),
      ...(checkpoint.finishedAt ? { finishedAt: new Date(checkpoint.finishedAt).toISOString() } : {}),
      stages: Object.fromEntries(Object.entries(checkpoint.stages).map(([stage, at]) => [stage, new Date(at as number).toISOString()])),
      active: ACTIVE.includes(checkpoint.state), waitingForUser: WAITS_FOR_USER.includes(checkpoint.state) };
  }
  /** Newest first, for the console. Live runs come from memory so the dashboard sees stage changes immediately. */
  list(owner: string, options: { limit?: number; before?: number } = {}): { runs: RunSummary[]; nextBefore: number | null } {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    if (!this.db) {
      const runs = [...this.runs.values()].filter(run => run.owner === owner && (options.before === undefined || run.startedAt < options.before))
        .sort((a, b) => b.startedAt - a.startedAt);
      return { runs: runs.slice(0, limit).map(run => this.summary(run, run.id)), nextBefore: runs.length > limit ? runs[limit - 1]!.startedAt : null };
    }
    const rows = this.db.connection.prepare('SELECT id,created_at,checkpoint FROM demo_runs WHERE owner=? AND created_at<? AND expires_at>? ORDER BY created_at DESC LIMIT ?')
      .all(owner, options.before ?? Number.MAX_SAFE_INTEGER, Date.now(), limit + 1);
    const runs = rows.slice(0, limit).map(row => {
      const live = this.runs.get(String(row.id));
      return live && live.owner === owner ? this.summary(live, live.id) : this.summary(JSON.parse(String(row.checkpoint)) as Checkpoint, String(row.id));
    });
    return { runs, nextBefore: rows.length > limit ? Number(rows[limit - 1]!.created_at) : null };
  }
  get(owner: string, id: string): RunSummary | undefined {
    const live = this.runs.get(id);
    if (live) return live.owner === owner ? this.summary(live, live.id) : undefined;
    const row = this.db?.connection.prepare('SELECT checkpoint FROM demo_runs WHERE id=? AND owner=? AND expires_at>?').get(id, owner, Date.now());
    return row ? this.summary(JSON.parse(String(row.checkpoint)) as Checkpoint, id) : undefined;
  }
  async call(owner: string, name: string, raw: unknown, authorize?: AuthorizationCheck): Promise<CallToolResult> {
    if (!name.startsWith('recording_run')) {
      const id = (raw as { id?: unknown } | null)?.id;
      const driving = typeof id === 'string' ? [...this.runs.values()].find(run => run.state === 'agent_driving' && run.owner === owner && run.sessionId === id) : undefined;
      if (driving) {
        const outcome = FINISHES_RUN[name];
        if (outcome) return this.call(owner, 'recording_run_finish', { runId: driving.id, outcome, note: `${name} while driving` }, authorize);
        driving.lastAgentAt = Date.now();
        if (AGENT_ACTIONS.has(name)) { driving.actions++; this.persist(driving); }
      }
      const result = await (authorize ? this.recorder.call(owner, name, raw, authorize) : this.recorder.call(owner, name, raw));
      // An answered field puts the run back to navigating at once; its own poll may wait up to 25 s to notice.
      const inputId = (raw as { inputId?: unknown } | null)?.inputId;
      if (name === 'navigation_guide' && !result.isError && typeof id === 'string' && typeof inputId === 'string') {
        const waiting = [...this.runs.values()].find(run => run.state === 'needs_input' && run.owner === owner && run.sessionId === id && run.input?.inputId === inputId);
        if (waiting) { delete waiting.input; waiting.state = 'navigating'; waiting.stages.navigating = Date.now(); this.persist(waiting); }
      }
      return result;
    }
    this.db?.connection.prepare('DELETE FROM demo_runs WHERE expires_at<=?').run(Date.now());
    for (const [id, run] of this.runs) if (!ACTIVE.includes(run.state) && Date.now() - run.startedAt > TTL) this.runs.delete(id);
    if (name === 'recording_run') {
      // A recording without the agent's plan would make the navigator guess; ask for the plan instead of recording.
      if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).plan === undefined) throw new Error('plan_required');
      if (!planSchema.safeParse((raw as Record<string, unknown>).plan).success) throw new Error('plan_invalid');
      const parsed = runSchema.parse(raw);
      const plan = parsed.plan!;
      // The plan becomes the navigator's script; its values fill the fields it names, unless the agent gave others.
      const fromPlan = planValues(plan);
      const input = { ...parsed, navigator: parsed.navigator ?? this.defaultNavigator, guidance: compilePlan(plan, parsed.guidance), values: { ...fromPlan.values, ...parsed.values }, sequences: fromPlan.sequences };
      const inputHash = createHash('sha256').update(JSON.stringify({ ...input, values: Object.keys(input.values).sort() })).digest('hex');
      for (const run of this.runs.values()) {
        if (run.owner === owner && run.requestId === input.requestId) { if (run.inputHash !== inputHash) throw new Error('request_id_conflict'); return this.view(run); }
      }
      for (const run of this.runs.values()) if (run.owner === owner && ACTIVE.includes(run.state)) throw new Error('run_in_progress');
      if ([...this.runs.values()].filter(run => ACTIVE.includes(run.state)).length >= 16) throw new Error('run_capacity_reached');
      const route = input.localConnectionId ? 'local-browser' : input.importId ? 'hosted-import' : input.useDemoAccount ? 'hosted-demo-account' : input.loginEmail ? 'hosted-email-only' : 'hosted';
      const run: Run = { id: randomUUID(), owner, requestId: input.requestId, inputHash, state: 'planning', actions: 0, decisions: 0, costUsd: 0, startedAt: Date.now(), stages: { planning: Date.now() },
        title: runTitle(input.goal), url: input.url, route, navigator: input.navigator, finalState: plan.finalState,
        controller: new AbortController(), done: Promise.resolve(), ...(authorize ? { authorize } : {}) };
      this.runs.set(run.id, run); this.persist(run);
      run.done = this.execute(run, input);
      return this.view(run);
    }
    const args = z.object({ runId: z.uuid(), waitMs: z.number().int().min(0).max(25000).optional(),
      outcome: z.enum(['reached', 'stuck']).optional(), note: z.string().trim().max(300).optional() }).parse(raw);
    const run = this.runs.get(args.runId);
    if (!run || run.owner !== owner) throw new Error('run_not_found');
    // The run waits for whoever must act next; the agent driving is one of them, so the status answers at once.
    const settledFor = (until: number) => ACTIVE.includes(run.state) && !WAITS_FOR_USER.includes(run.state) && run.state !== 'agent_driving' && Date.now() < until;
    if (name === 'recording_run_status') {
      const until = Date.now() + (args.waitMs ?? 1000);
      while (settledFor(until)) await delay(Math.min(200, until - Date.now()));
      return this.view(run);
    }
    if (name === 'recording_run_finish') {
      if (run.state !== 'agent_driving' || !run.finish) throw new Error('run_not_agent_driving');
      if (!args.outcome) throw new Error('outcome_required');
      run.finish({ outcome: args.outcome, ...(args.note ? { note: args.note } : {}) });
      // The run holds on the result before it stops: answer once it has left agent_driving, so the agent stops driving.
      const until = Date.now() + this.resultHoldMs + 2000;
      while (run.state === 'agent_driving' && Date.now() < until) await delay(50);
      return this.view(run);
    }
    if (name === 'recording_run_cancel') { run.controller.abort(); await run.done; return this.view(run); }
    throw new Error('unknown_tool');
  }
  private async execute(run: Run, input: RunInput) {
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(RUN_TIMEOUT)]);
    let events: string | undefined;
    const log = async (event: string, data: Record<string, unknown> = {}) => {
      if (events) await appendFile(events, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', { mode: 0o600 }).catch(() => undefined);
    };
    const enter = async (state: RunState) => { run.state = state; run.stages[state] = Date.now(); this.persist(run); await log('stage', { state }); };
    // Another account's session or render holds the recorder: wait for it rather than handing the agent a failed run.
    const waitForCapacity = async (tool: string, retryAfterMs: number) => {
      if (run.reason !== 'waiting_for_capacity') { run.reason = 'waiting_for_capacity'; this.persist(run); await log('busy', { tool }); }
      await delay(Math.min(Math.max(retryAfterMs, 100), 30_000), undefined, { signal });
    };
    const busyError = (error: unknown) => (error as { code?: unknown } | null)?.code === 'capacity_busy' || (error instanceof Error && error.message === 'capacity_busy');
    const call = async (name: string, args: Record<string, unknown>) => {
      const firstTry = Date.now();
      for (;;) {
        signal.throwIfAborted();
        if (run.authorize && !await run.authorize()) throw new Error('run_authorization_expired');
        const canWait = BUSY_RETRY_TOOLS.has(name) && Date.now() - firstTry < BUSY_WAIT;
        let result: CallToolResult;
        try { result = await (run.authorize ? this.recorder.call(run.owner, name, args, run.authorize) : this.recorder.call(run.owner, name, args)); }
        catch (error) {
          // In-process calls throw the bare code; only the MCP boundary turns it into an error result.
          if (!(canWait && busyError(error))) throw error;
          await waitForCapacity(name, this.busyRetryMs); continue;
        }
        const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
        if (result.isError && structured.code === 'capacity_busy' && canWait) {
          await waitForCapacity(name, typeof structured.retryAfterMs === 'number' ? structured.retryAfterMs : 5000); continue;
        }
        if (run.reason === 'waiting_for_capacity') { delete run.reason; this.persist(run); }
        if (result.isError) throw new Error(`${name}_failed:${result.content?.map(c => c.type === 'text' ? c.text : '').join(' ').slice(0, 120)}`);
        return structured;
      }
    };
    const waitFor = async (name: string, args: Record<string, unknown>, settled: (s: Record<string, unknown>) => boolean) => {
      for (;;) { const status = await call(name, { ...args, waitMs: 25000 }); if (settled(status)) return status; }
    };
    try {
      let importId = input.importId, openUrl = input.url;
      if (!importId && !input.localConnectionId && (input.useDemoAccount || input.loginEmail)) {
        // Hosted sign-in without a password in chat: the vault types it, or the user finishes an e-mail code on the secure page.
        await enter('connecting');
        const connection = await call('session_connect', { url: input.url, requestId: run.id, ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}),
          ...(input.useDemoAccount ? { useDemoAccount: true } : { loginEmail: input.loginEmail }) });
        if (typeof connection.id !== 'string') throw new Error('connection_open_failed');
        run.connectionId = connection.id; this.persist(run);
        for (;;) {
          const status = await call('connection_status', { id: run.connectionId, waitMs: 25000 });
          if (status.connectionStatus === 'ready' && typeof status.importId === 'string') {
            importId = status.importId; openUrl = openAfterSignIn(input.url, typeof status.signedInUrl === 'string' ? status.signedInUrl : undefined); break;
          }
          if (status.connectionStatus === 'awaiting_code') { if (run.state !== 'awaiting_code') await enter('awaiting_code'); await delay(1000, undefined, { signal }); continue; }
          if (run.state === 'awaiting_code') await enter('connecting');
          if (status.connectionStatus === 'failed') throw new Error(`connection_${String(status.connectionError ?? 'failed')}`);
        }
        if (run.state !== 'planning') await enter('planning');
      }
      const session = await call('session_open', { url: openUrl, requestId: run.id, ...(input.localConnectionId ? { localConnectionId: input.localConnectionId } : {}), ...(input.viewport ? { viewport: input.viewport } : {}),
        ...(importId ? { importId } : {}), ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}) });
      if (typeof session.id !== 'string' || session.status !== 'ready') throw new Error('session_not_ready');
      run.sessionId = session.id; this.persist(run);
      const dir = await this.artifacts.artifactDir(run.owner, session.id);
      events = join(dir, 'events.jsonl');
      await writeFile(join(dir, 'plan.json'), JSON.stringify({ version: 1, runId: run.id, sessionId: session.id, url: input.url, goal: input.goal, ...(input.guidance ? { guidance: input.guidance } : {}), ...(input.plan ? { plan: input.plan } : {}),
        maximumActions: input.maximumActions, valueFields: Object.keys(input.values), route: input.localConnectionId ? 'local-browser' : importId ? (input.useDemoAccount ? 'hosted-demo-account' : input.loginEmail ? 'hosted-email-only' : 'hosted-import') : 'hosted', render: input.render, navigator: input.navigator, createdAt: new Date(run.startedAt).toISOString() }, null, 2), { mode: 0o600 });
      await log('session_open', { sessionId: session.id });
      await enter('navigating');
      const started = await call('recording_start', { id: session.id });
      if (started.desktopWindow && typeof started.desktopWindow === 'object') { run.desktopWindow = started.desktopWindow as Record<string, unknown>; this.persist(run); }
      await log('recording_start', run.desktopWindow ? { desktopWindow: run.desktopWindow } : undefined);
      // The user's agent drives with the step-by-step tools until it calls recording_run_finish, or stops calling.
      const agentDrives = async (idleMs: number): Promise<AgentOutcome> => {
        run.lastAgentAt = Date.now();
        const finished = new Promise<AgentOutcome>(resolve => { run.finish = resolve; });
        await enter('agent_driving');
        try {
          for (;;) {
            const left = (run.lastAgentAt ?? Date.now()) + idleMs - Date.now();
            if (left <= 0) return { outcome: 'idle' };
            const outcome = await Promise.race([finished, delay(Math.min(left, 1000), undefined, { signal }).then(() => undefined)]);
            if (outcome) return outcome;
          }
        } finally { delete run.finish; delete run.lastAgentAt; }
      };
      let navigation: Record<string, unknown>;
      if (input.navigator === 'agent') {
        const driven = await agentDrives(this.agentIdleMs);
        navigation = { status: driven.outcome === 'reached' ? 'done' : `agent_${driven.outcome}` };
        await log('agent', { outcome: driven.outcome, actions: run.actions, ...(driven.note ? { note: driven.note } : {}) });
      } else {
        await call('navigation_start', { id: session.id, requestId: randomUUID(), goal: input.goal, maximumActions: input.maximumActions, values: input.values, ...(input.guidance ? { guidance: input.guidance } : {}),
          ...(input.plan ? { success: input.plan.finalState } : {}), ...(Object.keys(input.sequences).length ? { sequences: input.sequences } : {}) });
        for (;;) {
          navigation = await call('navigation_status', { id: session.id, waitMs: 25000 });
          run.actions = Number(navigation.actions ?? run.actions); run.decisions = Number(navigation.decisions ?? run.decisions); run.costUsd = Number(navigation.costUsd ?? run.costUsd);
          if (navigation.status === 'needs_input') {
            const pending = navigation.input as { inputId: string; field: unknown } | undefined;
            if (pending && (run.state !== 'needs_input' || run.input?.inputId !== pending.inputId)) { run.input = pending; await enter('needs_input'); await log('needs_input', { field: pending.field }); }
            await delay(1000, undefined, { signal });
            continue;
          }
          if (run.state === 'needs_input') { delete run.input; await enter('navigating'); }
          this.persist(run);
          if (navigation.status !== 'running') break;
        }
        if (navigation.status !== 'done') {
          if (typeof navigation.reason === 'string') run.navigationReason = navigation.reason;
          if (typeof navigation.lastPage === 'string') run.lastPage = navigation.lastPage;
        }
        await log('navigation', { status: navigation.status, actions: run.actions, decisions: run.decisions, costUsd: run.costUsd, ...(navigation.reason ? { reason: navigation.reason } : {}) });
        if (HANDOFF_FROM.has(String(navigation.status))) {
          // The capture is still running: the agent that wrote the plan may finish the flow from this screen.
          run.handoff = String(navigation.status);
          const driven = await agentDrives(this.handoffIdleMs);
          await log('agent', { outcome: driven.outcome, actions: run.actions, handoff: run.handoff, ...(driven.note ? { note: driven.note } : {}) });
          // An agent that never took over leaves the navigator's own outcome in place.
          if (driven.outcome !== 'idle') navigation = { status: driven.outcome === 'reached' ? 'done' : 'agent_stuck' };
        }
      }
      if (navigation.status === 'done' && this.resultHoldMs > 0) await delay(this.resultHoldMs, undefined, { signal });
      await enter('recording');
      await call('recording_stop', { id: session.id });
      const captured = await waitFor('recording_status', { id: session.id }, s => s.status !== 'recording' && s.status !== 'ready');
      // Now also says whether the window got its own size back.
      if (captured.desktopWindow && typeof captured.desktopWindow === 'object') { run.desktopWindow = captured.desktopWindow as Record<string, unknown>; this.persist(run); }
      await log('capture', { status: captured.status, ...(captured.durationMs !== undefined ? { durationMs: captured.durationMs } : {}) });
      if (captured.status !== 'captured') throw new Error(`capture_${String(captured.status)}`);
      if (navigation.status !== 'done') throw new Error(`navigation_${String(navigation.status)}`);
      await enter('rendering');
      await call('recording_render', { id: session.id, requestId: run.id, ...input.render });
      const rendered = await waitFor('recording_status', { id: session.id }, s => s.status !== 'rendering');
      if (rendered.status === 'completed') { await enter('done'); await log('delivered', { durationMs: rendered.durationMs }); }
      else if (rendered.needsReview) { run.qualityReasons = (rendered.qualityReview as { reasons?: string[] } | undefined)?.reasons ?? []; await enter('needs_review'); await log('quality_review', { reasons: run.qualityReasons }); }
      else throw new Error(`render_${String(rendered.errorCode ?? rendered.status)}`);
    } catch (error) {
      // Browser errors carry their meaning in `code` (loader_visible, bot_challenge); the message is generic.
      const code = (error as { code?: unknown }).code;
      const message = typeof code === 'string' && /^[a-z][a-z0-9_]{2,60}$/.test(code) ? code : error instanceof Error ? error.message : 'run_failed';
      run.state = run.controller.signal.aborted ? 'canceled' : 'failed';
      run.reason = run.controller.signal.aborted ? 'client_canceled' : signal.aborted ? 'run_timeout' : message;
      await log(run.state, { reason: run.reason });
      // Leave nothing running: a stopped capture stays rendereable through the session id.
      if (run.sessionId) await this.recorder.call(run.owner, run.state === 'canceled' && run.stages.rendering ? 'recording_cancel' : 'recording_stop', { id: run.sessionId }).catch(() => undefined);
    } finally {
      run.finishedAt = Date.now(); delete run.input; delete run.finalState; this.persist(run);
    }
  }
}
