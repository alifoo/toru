import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { NavigationController } from './navigation.js';
import type { JevBrowserNavigator } from './jev.js';
const result = { status: 'done' as const, actions: 1, decisions: 1, costUsd: 0.001 };
function fixture(run: JevBrowserNavigator['run']) {
  const id = randomUUID(), owner = randomUUID();
  const call = vi.fn(async (who: string, name: string) => {
    if (who !== owner) throw new Error('recording_not_found');
    return { content: [], structuredContent: { id, status: 'recording', url: 'https://example.com', page: '[ref_1] input:text "Name" — visible at (100,100)' } };
  });
  const factory = vi.fn(() => ({ run }));
  const controller = new NavigationController({ call }, factory);
  return { id, owner, call, factory, controller, start: (requestId = randomUUID()) => controller.call(owner, 'navigation_start', { id, requestId, goal: 'Fill Name' }) };
}
it('yields missing text to the client agent, accepts a value and resumes without restarting', async () => {
  const f = fixture(async input => {
    await input.observe();
    const value = await input.writeValue({ goal: input.goal, purpose: 'type', field: { name: 'Name', role: 'input:text' }, pageText: '', recentActions: [] });
    expect(value).toBe('Demo team');
    await input.act({ kind: 'type', element: { ref: 'ref_1', role: 'input:text', name: 'Name', position: 'visible' }, text: value! });
    return result;
  });
  try {
    await f.start();
    await vi.waitFor(async () => expect((await f.controller.call(f.owner, 'navigation_status', { id: f.id, waitMs: 0 })).structuredContent?.status).toBe('needs_input'));
    const state = (await f.controller.call(f.owner, 'navigation_status', { id: f.id })).structuredContent!;
    await expect(f.controller.call(randomUUID(), 'navigation_status', { id: f.id })).rejects.toThrow('recording_not_found');
    await expect(f.controller.call(f.owner, 'browser_click', { id: f.id, ref: 'ref_1' })).rejects.toThrow('navigation_in_progress');
    await expect(f.controller.call(f.owner, 'navigation_guide', { id: f.id, instruction: 'Use this', inputId: randomUUID(), value: 'bad' })).rejects.toThrow('navigation_input_stale');
    await f.controller.call(f.owner, 'navigation_guide', { id: f.id, instruction: 'Use demo data', inputId: (state.input as { inputId: string }).inputId, value: 'Demo team' });
    await vi.waitFor(async () => expect((await f.controller.call(f.owner, 'navigation_status', { id: f.id, waitMs: 0 })).structuredContent?.status).toBe('done'));
    expect(f.call).toHaveBeenCalledWith(f.owner, 'browser_type', { id: f.id, ref: 'ref_1', text: 'Demo team' });
  } finally { await f.controller.close(); }
});
it('deduplicates retries, stops while waiting for input and allows manual takeover', async () => {
  const run = vi.fn<JevBrowserNavigator['run']>(async input => {
    await input.writeValue({ goal: input.goal, purpose: 'type', field: { name: 'Name', role: 'input:text' }, pageText: '', recentActions: [] });
    return result;
  });
  const f = fixture(run);
  try {
    const requestId = randomUUID();
    await Promise.all([f.start(requestId), f.start(requestId)]);
    expect(run).toHaveBeenCalledOnce();
    expect((await f.controller.call(f.owner, 'navigation_stop', { id: f.id })).structuredContent?.status).toBe('stopped');
    await f.controller.call(f.owner, 'browser_click', { id: f.id, ref: 'ref_1' });
    await f.start(requestId);
    expect(run).toHaveBeenCalledOnce();
    await f.start();
    expect(f.factory).toHaveBeenCalledOnce();
    await f.controller.call(f.owner, 'recording_stop', { id: f.id });
    expect(f.call).toHaveBeenCalledWith(f.owner, 'recording_stop', { id: f.id });
  } finally { await f.controller.close(); }
});
it('delivers corrections and supplied values to the navigator without another model', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async input => {
    await gate;
    expect(input.readGuidance?.()).toBe('Search marketing leaders instead');
    return result;
  });
  try {
    await f.start();
    await f.controller.call(f.owner, 'navigation_guide', { id: f.id, instruction: 'Search marketing leaders instead' });
    release();
    await vi.waitFor(async () => expect((await f.controller.call(f.owner, 'navigation_status', { id: f.id, waitMs: 0 })).structuredContent?.status).toBe('done'));
  } finally { release(); await f.controller.close(); }
});

it('checks the originating grant again before autonomous browser actions', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let authorized = true;
  const f = fixture(async input => {
    await input.observe();
    await gate;
    await input.act({ kind: 'enter' });
    return result;
  });
  try {
    await f.controller.call(f.owner, 'navigation_start', { id: f.id, requestId: randomUUID(), goal: 'Submit demo' }, async () => authorized);
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledWith(f.owner, 'browser_observe', { id: f.id, mode: 'outline' }));
    authorized = false; release();
    await vi.waitFor(async () => expect((await f.controller.call(f.owner, 'navigation_status', { id: f.id, waitMs: 0 })).structuredContent).toMatchObject({ status: 'failed', reason: 'navigation_authorization_expired' }));
    expect(f.call.mock.calls.some(([, name]) => name === 'browser_key')).toBe(false);
  } finally { release(); await f.controller.close(); }
});

it('gives a clicked button or link time to change the page before the navigator looks again', async () => {
  const f = fixture(async input => {
    await input.observe();
    await input.act({ kind: 'click', element: { ref: 'ref_1', role: 'button', name: 'Set up Google', position: 'visible' } });
    await input.act({ kind: 'click', element: { ref: 'ref_2', role: 'input:checkbox', name: 'Select all', position: 'visible' } });
    return result;
  });
  try {
    await f.start();
    await vi.waitFor(async () => expect((await f.controller.call(f.owner, 'navigation_status', { id: f.id, waitMs: 0 })).structuredContent).toMatchObject({ status: 'done' }));
    const names = f.call.mock.calls.map(([, name]) => name).filter(name => name === 'browser_click' || name === 'browser_wait');
    expect(names).toEqual(['browser_click', 'browser_wait', 'browser_click']);
    expect(f.call).toHaveBeenCalledWith(f.owner, 'browser_wait', { id: f.id, ms: 8000, until: 'change' });
  } finally { await f.controller.close(); }
});
