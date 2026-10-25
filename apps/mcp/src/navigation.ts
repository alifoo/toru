import { PreparationStore } from './preparation.js';
import { signedInPage } from './sign-in-landing.js';
import type { AuthorizationCheck } from './lifecycle.js';
import type { RecorderDatabase } from './store/database.js';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { JevBrowserNavigator, JevClient, type FieldValueRequest, type JevAction, type JevRunResult } from './jev.js';
import { parseOutline } from './jev-outline.js';

const startSchema = z.object({ id: z.uuid(), goal: z.string().trim().min(3).max(4000), requestId: z.uuid(),
  guidance: z.string().max(12000).optional(), maximumActions: z.number().int().min(1).max(60).default(20),
  values: z.record(z.string().max(200), z.string().max(2000)).default({}),
  /** What must be visible when the flow is done; the navigator weighs DONE against it. */
  success: z.string().trim().min(3).max(600).optional(),
  /** Values for a field the flow fills more than once, used in order (from the agent's plan). */
  sequences: z.record(z.string().max(200), z.array(z.string().max(2000)).max(30)).default({}) });
const guideSchema = z.object({ id: z.uuid(), instruction: z.string().trim().min(1).max(4000),
  inputId: z.uuid().optional(), value: z.string().max(2000).optional() });
type State = 'running' | 'needs_input' | 'done' | 'blocked' | 'exhausted' | 'stopped' | 'failed' | 'interrupted';
type Run = { inputHash: string; createdAt: number; owner: string; id: string; requestId: string; goal: string; state: State; controller: AbortController;
  done: Promise<void>; messages: string[]; actions: number; decisions: number; costUsd: number;
  authorize?: () => Promise<boolean>; reason?: string; lastPage?: string; pending?: { inputId: string; field: FieldValueRequest['field']; resolve(value: string): void } };
type Call = (owner: string, name: string, args: unknown, authorize?:AuthorizationCheck) => Promise<CallToolResult>;
type Navigator = Pick<JevBrowserNavigator, 'run'> & { readonly spentUsd?: number };
const reply = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

/** Client owns intent/text; the server owns bounded, serialized navigation. */
export class NavigationController {
  private runs = new Map<string, Run>();
  private navigators = new Map<string, Navigator>();
  private history = new Map<string, Map<string, Run>>();
  private created = new Map<string, number>();
  constructor(private readonly recorder: { call: Call }, private readonly factory: (checkpoint?: (costUsd:number)=>void) => Navigator, private readonly store?: RecorderDatabase) {
    if (!store) return;
    store.connection.prepare('DELETE FROM navigation_runs WHERE expires_at<=?').run(Date.now());
    for (const row of store.connection.prepare('SELECT * FROM navigation_runs ORDER BY created_at,rowid').all()) {
      const saved = JSON.parse(String(row.checkpoint));
      const run: Run = { ...saved, owner:String(row.owner), id:String(row.session_id), requestId:String(row.request_id),
        inputHash:String(row.input_hash), createdAt:Number(row.created_at), goal:'', messages:[], controller:new AbortController(), done:Promise.resolve() };
      if (this.active(run)) { run.state='interrupted'; run.reason='server_restarted_no_actions_replayed'; }
      this.runs.set(run.id,run);
      const history=this.history.get(run.id) ?? new Map<string,Run>();
      history.set(run.requestId,run); this.history.set(run.id,history);
      this.created.set(run.id,Math.min(this.created.get(run.id) ?? run.createdAt,run.createdAt));
      this.persist(run);
    }
  }
  private persist(run: Run) {
    // Never store prompts, typed values, page content or pending field details here.
    this.store?.connection.prepare(`INSERT INTO navigation_runs(owner,session_id,request_id,input_hash,created_at,expires_at,checkpoint)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner,session_id,request_id) DO UPDATE SET checkpoint=excluded.checkpoint`)
      .run(run.owner,run.id,run.requestId,run.inputHash,run.createdAt,run.createdAt+24*60*60_000,
        JSON.stringify({state:run.state,actions:run.actions,decisions:run.decisions,costUsd:run.costUsd,...(run.reason ? {reason:run.reason} : {})}));
  }
  private active(run?: Run) { return run?.state === 'running' || run?.state === 'needs_input'; }
  private view(run: Run) {
    if (this.active(run)) run.costUsd = this.navigators.get(run.id)?.spentUsd ?? run.costUsd;
    return reply({ id: run.id, requestId: run.requestId, status: run.state, actions: run.actions,
      decisions: run.decisions, costUsd: run.costUsd, outcomeVerified: false,
      ...(run.reason ? { reason: run.reason } : {}), ...(run.lastPage ? { lastPage: run.lastPage } : {}),
      ...(run.pending ? { input: { inputId: run.pending.inputId, field: run.pending.field },
        instruction: 'Choose a value using the user goal. Call navigation_guide with inputId and value. Never send passwords or tokens.' } : {}),
      instructionAfterRun: run.state === 'interrupted' ? 'Call recording_status. Render retained capture if available, otherwise create a new session. Browser actions were not replayed.' : 'Inspect browser_observe; continue with another short goal or recording_stop and recording_render. A partial attempt can be exported.' });
  }
  async call(owner: string, name: string, raw: unknown, authorize?: AuthorizationCheck): Promise<CallToolResult> {
    if (name === 'preparation_save' || name === 'preparation_read') {
      if (!this.store) throw new Error('preparation_unavailable');
      if (authorize && !await authorize()) throw new Error('navigation_authorization_expired');
      const preparation=new PreparationStore(this.store);
      return reply(name === 'preparation_save' ? preparation.save(owner,raw) : preparation.read(owner,raw));
    }
    this.store?.connection.prepare('DELETE FROM navigation_runs WHERE expires_at<=?').run(Date.now());
    for (const [session, at] of this.created) {
      if (Date.now() - at > 24 * 60 * 60_000 && !this.active(this.runs.get(session))) {
        this.created.delete(session); this.history.delete(session); this.runs.delete(session); this.navigators.delete(session);
      }
    }
    const args = raw as Record<string, unknown>;
    const navigation = name.startsWith('navigation_');
    const id = typeof args?.id === 'string' ? args.id : undefined;
    if (!id) return (authorize ? this.recorder.call(owner, name, raw, authorize) : this.recorder.call(owner, name, raw));
    // Authorize against persisted session ownership before reading navigation state.
    const status = await this.recorder.call(owner, 'recording_status', { id, waitMs: 0 });
    if (status.isError) return status;
    let run = this.runs.get(id);
    if (run && run.owner !== owner) throw new Error('recording_not_found');
    if (name === 'navigation_start') {
      const input = startSchema.parse(raw);
      const previous = this.history.get(id)?.get(input.requestId);
      const inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if (previous) { if(previous.inputHash!==inputHash) throw new Error('navigation_request_conflict'); return this.view(previous); }
      if ((this.history.get(id)?.size ?? 0) >= 30) throw new Error("navigation_session_goal_limit");
      if (!this.created.has(id) && this.created.size >= 128) throw new Error("navigation_capacity_reached");
      if (this.active(run)) throw new Error('navigation_in_progress');
      if (this.history.has(id) && !this.navigators.has(id)) throw new Error('navigation_recovered_session_requires_new_session');
      if (!['ready', 'recording'].includes(String(status.structuredContent?.status))) throw new Error('session_closed');
      // Factory validates configuration before starting work. Reuse cumulative session budget.
      const navigator = this.navigators.get(id) ?? this.factory(costUsd => {
        const current=this.runs.get(id);
        if(current) { current.costUsd=costUsd; this.persist(current); }
      });
      this.navigators.set(id, navigator);
      run = { inputHash, createdAt:Date.now(), owner, id, requestId: input.requestId, goal: input.goal, state: 'running', controller: new AbortController(),
        ...(authorize ? { authorize } : {}), done: Promise.resolve(), messages: [], actions: 0, decisions: 0, costUsd: 0 };
      this.runs.set(id, run);
      this.created.set(id, this.created.get(id) ?? Date.now());
      const history = this.history.get(id) ?? new Map<string, Run>();
      history.set(input.requestId, run); this.history.set(id, history);
      this.persist(run);
      const current = run;
      current.done = this.execute(current, navigator, input);
      return this.view(current);
    }
    if (navigation) {
      if (!run) throw new Error('navigation_not_found');
      if (name === 'navigation_status') {
        const waitMs = z.number().int().min(0).max(25000).parse(args.waitMs ?? 1000);
        const until = Date.now() + waitMs;
        while (run.state === 'running' && Date.now() < until) await delay(Math.min(100, until - Date.now()));
        return this.view(run);
      }
      if (name === 'navigation_guide') {
        const guide = guideSchema.parse(raw);
        if (!this.active(run)) throw new Error('navigation_not_running');
        if (guide.value !== undefined && (!run.pending || guide.inputId !== run.pending.inputId)) throw new Error('navigation_input_stale');
        if (run.messages.length >= 10) throw new Error('navigation_guidance_full');
        run.messages.push(guide.instruction);
        if (guide.value !== undefined) run.pending!.resolve(guide.value);
        return this.view(run);
      }
      if (name === 'navigation_stop') {
        run.controller.abort(); await run.done;
        return this.view(run);
      }
      throw new Error('unknown_tool');
    }
    if (this.active(run)) {
      if (['recording_stop', 'recording_cancel', 'session_close'].includes(name)) {
        run!.controller.abort(); await run!.done;
      } else if (name !== 'recording_status') throw new Error('navigation_in_progress_stop_before_manual_action');
    }
    const result = await (authorize ? this.recorder.call(owner, name, raw, authorize) : this.recorder.call(owner, name, raw));
    if (['recording_stop', 'recording_cancel', 'session_close'].includes(name)) {
      this.navigators.delete(id);
      this.runs.delete(id); this.history.delete(id); this.created.delete(id);
    }
    return result;
  }
  private async execute(run: Run, navigator: Navigator, input: z.infer<typeof startSchema>) {
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(120000)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      signal.throwIfAborted();
      if (run.authorize && !await run.authorize()) throw new Error('navigation_authorization_expired');
      signal.throwIfAborted();
      const result = await this.recorder.call(run.owner, name, { id: run.id, ...args });
      if (result.isError) throw new Error('navigation_browser_action_failed');
      signal.throwIfAborted();
      return result.structuredContent ?? {};
    };
    // A button, link or Enter may submit a form or start a redirect that takes seconds (a server action,
    // an OAuth hand-off). Wait for the page to change before the navigator looks again, so a slow but
    // working step is not read as no progress. browser_wait returns as soon as the change settles.
    const settle = () => call('browser_wait', { ms: SETTLE_AFTER_SUBMIT_MS, until: 'change' }).catch(() => undefined);
    const act = async (action: JevAction) => {
      switch (action.kind) {
        case 'click':
          await call('browser_click', { ref: action.element.ref });
          if (submitsOrNavigates(action.element.role)) await settle();
          break;
        case 'type': await call('browser_type', { ref: action.element.ref, text: action.text }); break;
        case 'select': await call('browser_select', { ref: action.element.ref, value: action.value }); break;
        case 'enter': await call('browser_key', { key: 'Enter' }); await settle(); break;
        case 'escape': await call('browser_key', { key: 'Escape' }); break;
        case 'scroll': await call('browser_scroll', { direction: action.direction, amount: 400, ...action.area.wheelAt }); break;
        case 'wait': await delay(Math.min(action.durationMs, 3000), undefined, { signal }); break;
      }
      run.actions++;
      this.persist(run);
      await delay(250, undefined, { signal });
    };
    try {
      const result: JevRunResult = await navigator.run({
        goal: input.goal, tutorial: input.guidance ?? '', maximumActions: input.maximumActions, verifySuccess: false, ...(input.success ? { win: input.success } : {}),
        observe: async () => {
          const page = await call('browser_observe', { mode: 'outline' });
          const seen = signedInPage(String(page.url ?? '')); if (seen) run.lastPage = seen;
          return { url: String(page.url ?? ''), text: String(page.text ?? page.page ?? '').slice(0, 6000), ...parseOutline(String(page.page ?? '')) };
        }, act,
        writeValue: async (request) => {
          const queued = input.sequences[request.field.name];
          if (queued?.length) return queued.shift()!;
          if (Object.hasOwn(input.values, request.field.name)) return input.values[request.field.name]!;
          run.state = 'needs_input'; this.persist(run);
          try {
            return await new Promise<string>((resolve, reject) => {
              const abort = () => { delete run.pending; reject(signal.reason); };
              run.pending = { inputId: randomUUID(), field: request.field, resolve: value => {
                signal.removeEventListener('abort', abort); delete run.pending; run.state = 'running'; this.persist(run); resolve(value);
              } };
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            });
          } finally { delete run.pending; }
        },
        readGuidance: () => run.messages.splice(0).join('\n') || undefined,
        onDecision: trace => {
          run.decisions++; run.costUsd = navigator.spentUsd ?? run.costUsd + trace.costUsd; this.persist(run);
          // Enough to see why a run stalled in the service log: never typed values, targets or page text.
          console.log(JSON.stringify({ event: 'navigation_decision', session: run.id, step: trace.step, operation: trace.operation,
            confidence: Math.round(trace.confidence * 100) / 100, ...(trace.error ? { error: trace.error.slice(0, 80) } : {}),
            ...(trace.pageChanged !== undefined ? { pageChanged: trace.pageChanged } : {}) }));
        }, signal,
      });
      run.state = result.status; run.actions = result.actions; run.costUsd = result.costUsd;
      if (result.reason) run.reason = result.reason;
    } catch (error) {
      run.state = run.controller.signal.aborted ? 'stopped' : 'failed';
      const code = error instanceof Error ? error.message : '';
      run.reason = signal.aborted ? (run.controller.signal.aborted ? 'client_stopped' : 'navigation_timeout')
        : /^[a-z][a-z0-9_]{2,70}$/.test(code) ? code : 'navigation_failed';
    } finally {
      run.costUsd = navigator.spentUsd ?? run.costUsd;
      this.persist(run);
    }
  }
  async close() {
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.all([...this.runs.values()].map(run => run.done));
    this.runs.clear(); this.navigators.clear(); this.history.clear(); this.created.clear();
  }
}
/** How long a click on a button or link may take to change the page before the navigator looks again. */
export const SETTLE_AFTER_SUBMIT_MS = 8_000;

/** Buttons and links are the controls whose click can submit a form or navigate. */
export function submitsOrNavigates(role: string): boolean {
  return /^(button|link|menuitem|tab)$/i.test(role.trim());
}

export function createNavigationController(recorder: { call: Call }, store?: RecorderDatabase) {
  return new NavigationController(recorder, onCostCheckpoint => {
    if (!process.env.TYPESAFE_API_KEY) throw new Error('navigation_not_configured');
    return new JevBrowserNavigator({ client: new JevClient({
    ...(onCostCheckpoint ? {onCostCheckpoint} : {}), apiKey: process.env.TYPESAFE_API_KEY ?? '', maximumRunCostUsd: Number(process.env.JEV_MAX_USD ?? '0.25'),
    ...(process.env.TYPESAFE_MODEL ? { model: process.env.TYPESAFE_MODEL } : {}),
  }) });
  }, store);
}

