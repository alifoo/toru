import { withRecorderStore } from './store/open.js';
async function readJob(dir:string,id:string):Promise<string> {
  return withRecorderStore(dir,db => String(db.connection.prepare('SELECT metadata FROM jobs WHERE id=?').get(id)!.metadata));
}
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { WebDriverProtocolError } from '@content-layer/browser';
import { Recorder, videoSize, type RecorderOptions } from './recorder.js';

it('isolates owners, preserves captured data on render failure and permits retry without replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-test-'));
  const owner = randomUUID(), intruder = randomUUID();
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), startRecording: vi.fn(), recordingMode: 'screencast',
    redactSensitiveText: vi.fn(), stopRecording: vi.fn(async () => ({ body: Buffer.from('raw capture'), redactionPassed: true })),
    screenshot: vi.fn(async () => ({ body: Buffer.from('preview'), redactionPassed: true })),
    pointerTrail: () => [], pointerTelemetry: () => [], semanticTimeline: () => [],
  };
  const render = vi.fn().mockRejectedValueOnce(new Error('encoder failure')).mockResolvedValue(Buffer.from('video'));
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render });
  try {
    await recorder.initialize();
    const result = await recorder.call(owner, 'session_open', { url: 'https://example.com' });
    const id = String(result.structuredContent?.id);
    await expect(recorder.call(intruder, 'recording_status', { id })).rejects.toThrow('recording_not_found');
    await expect(recorder.call(intruder, 'session_open', { url: 'https://example.org' })).rejects.toThrow('capacity_busy');
    await recorder.call(owner, 'recording_start', { id });
    await writeFile(join(dir, 'paused'), 'paused');
    await expect(recorder.call(owner, 'session_open', { url: 'https://example.com' })).rejects.toThrow('admissions_paused');
    await expect(recorder.importSession(owner, { cookies: [], origins: [] }, ['https://example.com'])).rejects.toThrow('admissions_paused');
    await recorder.call(owner, 'recording_stop', { id });
    await expect(recorder.call(owner, 'recording_render', { id })).rejects.toThrow('admissions_paused');
    await rm(join(dir, 'paused'));
    await recorder.call(owner, 'recording_stop', { id });
    expect(driver.stopRecording).toHaveBeenCalledTimes(1);
    await recorder.call(owner, 'recording_render', { id });
    expect(render.mock.calls[0]?.[1]).toMatchObject({ padding: 0, borderRadius: 0, showShadow: false });
    await vi.waitFor(async () => expect((await recorder.call(owner, 'recording_status', { id })).structuredContent?.status).toBe('captured'));
    expect(await readFile(join(dir, 'jobs', id, 'raw.webm'), 'utf8')).toBe('raw capture');
    render.mockImplementationOnce((_source, _config, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await recorder.call(owner, 'recording_render', { id });
    render.mock.lastCall![3]({ currentFrame: 50, totalFrames: 100 });
    const progress = (await recorder.call(owner, 'recording_status', { id, waitMs: 0 })).structuredContent!;
    expect(progress.progress).toMatchObject({ currentFrame: 50, totalFrames: 100, percent: 50 });
    expect(progress.rawPreserved).toBe(true);
    expect(progress.renderDeadlineAt).toBeTruthy();
    let returned = false;
    const pending = recorder.call(owner, 'recording_status', { id }).then(value => { returned = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(returned).toBe(false);
    await recorder.call(owner, 'recording_cancel', { id });
    expect((await pending).structuredContent).toMatchObject({ status: 'captured', errorCode: 'render_canceled', rawPreserved: true, canRetryRender: true });
    expect(await readFile(join(dir, 'jobs', id, 'raw.webm'), 'utf8')).toBe('raw capture');
    await recorder.call(owner, 'recording_render', { id, padding: 20 });
    await vi.waitFor(async () => expect((await recorder.call(owner, 'recording_status', { id })).structuredContent?.status).toBe('completed'));
    expect(await recorder.recordings(owner)).toEqual([expect.objectContaining({ id, status: 'completed', createdAt: expect.any(String) })]);
    expect(driver.goto).toHaveBeenCalledTimes(1);
    await expect(recorder.artifact(intruder, id, 'video')).rejects.toThrow('recording_not_found');
    expect(await readFile((await recorder.artifact(owner, id, 'video')).path, 'utf8')).toBe('video');
    await expect(recorder.call(owner, 'session_open', { url: 'http://127.0.0.1:3000' })).rejects.toThrow('public_https_url_required');
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('exposes recording direction as browser movement, waiting and semantic emphasis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-direction-'));
  const owner = randomUUID();
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), startRecording: vi.fn(async () => undefined),
    recordingMode: 'screencast' as const, redactSensitiveText: vi.fn(async () => undefined),
    pointer: vi.fn(async () => undefined), markDemoMoment: vi.fn(), formInput: vi.fn(async () => undefined),
    readPage: vi.fn(async () => '[ref_1] button Send enabled — visible at (10,10) viewport CSS pixels'), currentUrl: vi.fn(async () => 'https://example.com'),
    screenshot: vi.fn(async () => ({ body: Buffer.from('frame'), contentType: 'image/png', redactionPassed: true })),
  };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent?.id);
    await recorder.call(owner, 'recording_start', { id });
    await recorder.call(owner, 'browser_move', { id, x: 1800, y: 1000 });
    const typed = await recorder.call(owner, 'browser_type', { id, ref: 'ref_2', text: 'Find people' });
    expect(typed.structuredContent?.page).toContain('Send enabled');
    expect(typed.content).toContainEqual(expect.objectContaining({ type: 'image' }));
    driver.screenshot.mockRejectedValueOnce(new Error('screenshot failed'));
    const clicked = await recorder.call(owner, 'browser_click', { id, ref: 'ref_1' });
    expect(clicked.structuredContent?.observationRequired).toBe(true);
    expect(driver.pointer).toHaveBeenCalledTimes(2);
    await recorder.call(owner, 'browser_wait', { id, ms: 250 });
    await recorder.call(owner, 'mark_demo_moment', { id, kind: 'result', note: 'Dashboard ready' });
    expect(driver.pointer).toHaveBeenCalledWith('move', { type: 'coordinate', x: 1800, y: 1000 });
    expect(driver.markDemoMoment).toHaveBeenCalledWith('result', 'Dashboard ready', undefined, expect.any(Number));
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('anchors results to owned screenshots and compresses only client pauses, never typing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-timing-'));
  let clock = Date.now();
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const timeline: Array<Record<string, unknown>> = [];
  const driver = {
    goto: vi.fn(), dispose: vi.fn(async () => undefined), startRecording: vi.fn(), redactSensitiveText: vi.fn(),
    recordingMode: 'screencast', stopRecording: vi.fn(async () => ({ body: Buffer.from('raw'), redactionPassed: true })),
    currentUrl: async () => 'https://example.com', readPage: async () => 'Results',
    screenshot: async () => ({ body: Buffer.from('frame'), contentType: 'image/png', redactionPassed: true }),
    formInput: async () => { clock += 6_000; },
    markDemoMoment: vi.fn((type, element, focus, atMs) => timeline.push({ type, element, focus, atMs, ref: null })),
    semanticTimeline: () => timeline, pointerTrail: () => [], pointerTelemetry: () => [],
  };
  const render = vi.fn(async () => Buffer.from('video'));
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render });
  try {
    await recorder.initialize();
    const owner = randomUUID();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent?.id);
    expect((await recorder.call(owner, 'browser_observe', { id })).structuredContent?.observationId).toBeUndefined();
    await recorder.call(owner, 'recording_start', { id });
    clock += 6_000;
    const seen = (await recorder.call(owner, 'browser_type', { id, ref: 'ref_1', text: 'Hello' })).structuredContent!;
    expect(seen.observedAtMs).toBe(12_000);
    clock += 8_000;
    const focus = { x: 0.2, y: 0.2, width: 0.5, height: 0.3 };
    await recorder.call(owner, 'mark_demo_moment', { id, kind: 'result', note: 'Visible result', focus, observationId: seen.observationId });
    expect(driver.markDemoMoment).toHaveBeenLastCalledWith('result', 'Visible result', focus, 12_000);
    await expect(recorder.call(owner, 'mark_demo_moment', { id, kind: 'result', note: 'Forged', observationId: randomUUID() })).rejects.toThrow('observation_not_found');
    await expect(recorder.call(owner, 'mark_demo_moment', { id, kind: 'action', note: 'Wrong kind', observationId: seen.observationId })).rejects.toThrow('observation_requires_result');
    clock += 5_000;
    await recorder.call(owner, 'recording_stop', { id });
    const observation = JSON.parse(await readFile(join(dir, 'jobs', id, 'observation.json'), 'utf8'));
    expect(observation.idleRanges).toEqual([{ startMs: 0, endMs: 6_000 }, { startMs: 12_000, endMs: 25_000 }]);
    await recorder.call(owner, 'recording_render', { id });
    await vi.waitFor(async () => expect((await recorder.call(owner, 'recording_status', { id, waitMs: 0 })).structuredContent?.status).toBe('completed'));
    const config = (render.mock.calls[0] as unknown as [string, { trimRegions: Array<{ startMs: number; endMs: number }>; speedRegions: Array<{ startMs: number; endMs: number }>; zoomRegions: Array<{ startMs: number }> }])[1];
    expect(config.zoomRegions[0]?.startMs).toBe(12_000);
    expect(config.trimRegions.length).toBeGreaterThan(0);
    for (const span of config.trimRegions) {
      expect(span.endMs <= 6_000 || span.startMs >= 16_000).toBe(true);
    }
    await recorder.call(owner, 'recording_render', { id, compressPauses: false });
    expect((render.mock.lastCall as unknown as [string, { speedRegions: unknown[] }])[1].speedRegions).toEqual([]);
  } finally { await recorder.close(); now.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});

it('returns early on settled visible changes and preserves deliberate holds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-wait-'));
  const driver = {
    goto: vi.fn(), dispose: vi.fn(async () => undefined), currentUrl: async () => 'https://example.com',
    readPage: async () => 'Current controls', pageText: vi.fn(async () => 'Loading'),
    screenshot: async () => ({ body: Buffer.from('frame'), contentType: 'image/png', redactionPassed: true }),
  };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const owner = randomUUID();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent?.id);
    await recorder.call(owner, 'browser_observe', { id });
    driver.pageText.mockResolvedValue('New visible results');
    const started = Date.now();
    const result = await recorder.call(owner, 'browser_wait', { id, ms: 7_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(driver.pageText.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(result)).not.toContain('New visible results');
    const held = Date.now();
    await recorder.call(owner, 'browser_wait', { id, ms: 300, until: 'duration' });
    expect(Date.now() - held).toBeGreaterThanOrEqual(290);
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('encrypts scoped session imports and rejects cross-owner reuse before opening a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-import-'));
  const createContext = vi.fn();
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext, render: vi.fn() });
  try {
    await recorder.initialize();
    const owner = randomUUID();
    const imported = await recorder.importSession(owner, { cookies: [{ name: 'session', value: 'private-value', domain: 'example.com' }] }, ['https://example.com']);
    expect(await readFile(join(dir, 'imports', `${imported.id}.json`), 'utf8')).not.toContain('private-value');
    await expect(recorder.call(randomUUID(), 'session_open', { url: 'https://example.com', importId: imported.id })).rejects.toThrow('session_import_not_found');
    await expect(recorder.importSession(owner, { cookies: [{ name: 'session', value: 'private-value', domain: 'another.com' }] }, ['https://example.com'])).rejects.toThrow();
    expect(createContext).not.toHaveBeenCalled();
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('waits for a busy browser action before canceling and disposing the session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-cancel-'));
  const owner = randomUUID();
  let release!: () => void;
  const typing = new Promise<void>(resolve => { release = resolve; });
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), startRecording: vi.fn(async () => undefined),
    recordingMode: 'screencast' as const, redactSensitiveText: vi.fn(async () => undefined),
    typeText: vi.fn(async () => typing), stopRecording: vi.fn(async () => ({ body: Buffer.from('raw capture'), redactionPassed: true })),
    screenshot: vi.fn(async () => ({ body: Buffer.from('preview'), redactionPassed: true })), pointerTrail: () => [], pointerTelemetry: () => [], semanticTimeline: () => [],
  };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const opened = await recorder.call(owner, 'session_open', { url: 'https://example.com' });
    const id = String(opened.structuredContent?.id);
    await recorder.call(owner, 'recording_start', { id });
    const action = recorder.call(owner, 'browser_type', { id, text: 'slow input' });
    await vi.waitFor(() => expect(driver.typeText).toHaveBeenCalled());
    const cancel = recorder.call(owner, 'recording_cancel', { id });
    await Promise.resolve();
    expect(driver.stopRecording).not.toHaveBeenCalled();
    release();
    await action;
    await cancel;
    expect(driver.stopRecording).toHaveBeenCalledTimes(1);
    expect(driver.dispose).toHaveBeenCalledTimes(1);
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('forces cancellation after the bounded in-flight grace period', async () => {
  vi.useFakeTimers();
  const dir = await mkdtemp(join(tmpdir(), 'recorder-hard-cancel-'));
  const owner = randomUUID();
  let release!: () => void;
  const typing = new Promise<void>(resolve => { release = resolve; });
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), startRecording: vi.fn(async () => undefined),
    recordingMode: 'screencast' as const, redactSensitiveText: vi.fn(async () => undefined),
    typeText: vi.fn(async () => typing), stopRecording: vi.fn(async () => ({ body: Buffer.from('raw capture'), redactionPassed: true })),
    screenshot: vi.fn(async () => ({ body: Buffer.from('preview'), redactionPassed: true })), pointerTrail: () => [], pointerTelemetry: () => [], semanticTimeline: () => [],
  };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const opened = await recorder.call(owner, 'session_open', { url: 'https://example.com' });
    const id = String(opened.structuredContent?.id);
    await recorder.call(owner, 'recording_start', { id });
    const action = recorder.call(owner, 'browser_type', { id, text: 'never ending input' });
    await vi.waitFor(() => expect(driver.typeText).toHaveBeenCalled());
    const cancel = recorder.call(owner, 'recording_cancel', { id });
    await vi.waitFor(() => expect((recorder as unknown as { active?: { finishRequested?: boolean } }).active?.finishRequested).toBe(true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(driver.stopRecording).toHaveBeenCalledTimes(1);
    await cancel;
    expect(driver.stopRecording).toHaveBeenCalledTimes(1);
    expect(driver.dispose).toHaveBeenCalledTimes(1);
    release();
    await expect(action).rejects.toThrow('session_closed');
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); vi.useRealTimers(); }
});

it('accepts credentials before login completes, wakes a waiting agent, and exports only verified sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-connect-'));
  const owner = randomUUID();
  let release!: () => void;
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    connectWithCredentials: vi.fn(() => new Promise<void>(resolve => { release = resolve; })),
    exportStorageState: vi.fn(async () => ({ cookies: [], origins: [] })),
  };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const opened = await recorder.call(owner, 'session_connect', { url: 'https://example.com/entrar' });
    const id = String(opened.structuredContent?.id);
    expect(driver.goto).not.toHaveBeenCalled();
    expect(opened.structuredContent?.instruction).toContain('FINAL response');
    expect(opened.structuredContent?.nextCall).toBeUndefined();
    expect((await recorder.call(owner, 'connection_status', { id })).structuredContent?.connectionStatus).toBe('waiting');
    const waiting = recorder.call(owner, 'connection_status', { id, waitMs: 25000 });
    await new Promise(resolve => setTimeout(resolve, 25));
    const accepted = await recorder.submitConnectionCredentials(owner, id, 'user@example.com', 'secret');
    expect(accepted.connectionStatus).toBe('verifying');
    expect((await waiting).structuredContent?.connectionStatus).toBe('verifying');
    expect(driver.exportStorageState).not.toHaveBeenCalled();
    expect((await recorder.completeConnection(owner, id)).connectionStatus).toBe('verifying');
    await expect(recorder.call(owner, 'browser_observe', { id })).rejects.toThrow('connection_in_progress');
    release();
    await vi.waitFor(async () => expect((await recorder.call(owner, 'connection_status', { id })).structuredContent).toMatchObject({ connectionStatus: 'ready', importId: expect.any(String) }));
    expect(await readJob(dir,id)).not.toContain('secret');
  } finally { release?.(); await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it.each(['invalid_credentials', 'additional_verification_required', 'sensitive-secret-in-driver-error', 'webdriver:element not interactable', 'webdriver:invalid element state'])('terminates failed connections with safe errors: %s', async failure => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-connect-failed-'));
  const owner = randomUUID();
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), connectWithCredentials: vi.fn(async () => { throw failure.startsWith('webdriver:') ? new WebDriverProtocolError(failure.slice(10), 'secret-password-must-not-leak') : new Error(failure); }), exportStorageState: vi.fn() };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_connect', { url: 'https://example.com' })).structuredContent?.id);
    expect((await recorder.submitConnectionCredentials(owner, id, 'user', 'secret')).connectionStatus).toBe('verifying');
    await vi.waitFor(async () => expect((await recorder.call(owner, 'connection_status', { id })).structuredContent).toMatchObject({ connectionStatus: 'failed', connectionError: failure.startsWith('webdriver:') ? 'login_control_not_interactable' : failure.startsWith('sensitive') ? 'connection_failed' : failure }));
    expect(driver.exportStorageState).not.toHaveBeenCalled();
    expect(await readJob(dir,id)).not.toContain('secret-password');
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('times out stalled logins and migrates interrupted waiting connections on restart', async () => {
  vi.useFakeTimers();
  const dir = await mkdtemp(join(tmpdir(), 'recorder-connect-timeout-'));
  const owner = randomUUID();
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), connectWithCredentials: vi.fn(() => new Promise<void>(() => {})), exportStorageState: vi.fn() };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_connect', { url: 'https://example.com' })).structuredContent?.id);
    await recorder.submitConnectionCredentials(owner, id, 'user', 'secret');
    await vi.advanceTimersByTimeAsync(90_001);
    await vi.waitFor(async () => expect((await recorder.call(owner, 'connection_status', { id })).structuredContent).toMatchObject({ connectionStatus: 'failed', connectionError: 'connection_timed_out' }));
    expect(driver.dispose).toHaveBeenCalledTimes(1);
    expect(driver.exportStorageState).not.toHaveBeenCalled();
    await recorder.close();
    await withRecorderStore(dir,db => db.connection.prepare("UPDATE jobs SET metadata=json_set(metadata,'$.connection',json(?)) WHERE id=?").run(JSON.stringify({status:'waiting',submittedAt:Date.now()}),id));
    await recorder.initialize();
    expect(JSON.parse(await readJob(dir,id)).connection).toMatchObject({ status: 'failed', errorCode: 'server_restarted' });
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); vi.useRealTimers(); }
});

it('cancels credential work without letting a late login overwrite failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-connect-cancel-'));
  const owner = randomUUID();
  let release!: () => void;
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), connectWithCredentials: vi.fn(() => new Promise<void>(resolve => { release = resolve; })), exportStorageState: vi.fn() };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_connect', { url: 'https://example.com' })).structuredContent?.id);
    await recorder.submitConnectionCredentials(owner, id, 'user', 'secret');
    await recorder.call(owner, 'session_close', { id });
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect((await recorder.call(owner, 'connection_status', { id })).structuredContent).toMatchObject({ connectionStatus: 'failed', connectionError: 'connection_closed' });
    expect(driver.exportStorageState).not.toHaveBeenCalled();
    expect(await readJob(dir,id)).not.toContain('secret-password');
  } finally { release?.(); await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('reuses owner-scoped import origins, narrows explicit grants, and preserves imports after browser failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-restore-'));
  const owner = randomUUID();
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined) };
  let restored: { state: { cookies: unknown[]; origins: unknown[] }; origins: string[] };
  const createContext = vi.fn(async (options) => {
    restored = { state: JSON.parse(Buffer.from(options.sessionState).toString()), origins: options.allowedOrigins };
    return driver;
  });
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: createContext as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    // An external identity provider: narrowing drops it. Same-site subdomains stay with the product.
    const saved = await recorder.importSession(owner, { cookies: [{ name: 'session', value: 'private', domain: 'login.example.net' }], origins: [] }, ['https://app.example.com', 'https://login.example.net']);
    await expect(recorder.call(randomUUID(), 'session_import_status', { importId: saved.id })).rejects.toThrow('session_import_not_found');
    createContext.mockRejectedValueOnce(new WebDriverProtocolError('unable to set cookie'));
    await expect(recorder.call(owner, 'session_open', { url: 'https://app.example.com', importId: saved.id })).rejects.toBeInstanceOf(WebDriverProtocolError);
    expect((await recorder.call(owner, 'session_import_status', { importId: saved.id })).structuredContent?.status).toBe('available');
    const opened = await recorder.call(owner, 'session_open', { url: 'https://app.example.com', importId: saved.id });
    expect(restored!.origins).toEqual(['https://app.example.com', 'https://login.example.net']);
    expect(restored!.state.cookies).toHaveLength(1);
    expect((await recorder.call(owner, 'session_close', { id: opened.structuredContent?.id })).structuredContent?.status).toBe('closed');
    const narrowed = await recorder.call(owner, 'session_open', { url: 'https://app.example.com', allowedOrigins: ['https://other.example.com'], importId: saved.id });
    expect(restored!.origins).toEqual(['https://app.example.com', 'https://other.example.com']);
    expect(restored!.state.cookies).toHaveLength(0);
    await recorder.call(owner, 'session_close', { id: narrowed.structuredContent?.id });
    await withRecorderStore(dir,db => db.connection.prepare('UPDATE session_imports SET expires_at=? WHERE id=?').run(Date.now()-1,saved.id));
    await expect(recorder.call(owner, 'session_import_status', { importId: saved.id })).rejects.toThrow('session_import_expired');
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('persists session admission limits across restart and shares the global cap across owners', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-quota-'));
  const owner = randomUUID();
  const createContext = vi.fn(async () => ({ goto: vi.fn(), dispose: vi.fn(async () => undefined) })) as unknown as RecorderOptions['createContext'];
  const options = { dataDir: dir, encryptionKey: randomBytes(32), createContext, render: vi.fn(), dailyLimits: { browserStarts: 1, globalBrowserStarts: 1 } };
  let recorder = new Recorder(options);
  try {
    await recorder.initialize();
    const id = (await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent!.id;
    await recorder.call(owner, 'session_close', { id });
    await recorder.close();
    recorder = new Recorder(options); await recorder.initialize();
    await expect(recorder.call(owner, 'session_open', { url: 'https://example.com' })).rejects.toThrow('daily_session_limit');
    await expect(recorder.call(randomUUID(), 'session_open', { url: 'https://example.com' })).rejects.toThrow('daily_service_limit');
    expect(createContext).toHaveBeenCalledTimes(1);
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('reserves worst-case compute before starting a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-compute-'));
  const createContext = vi.fn();
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext, render: vi.fn(), dailyLimits: { browserMs: 1 } });
  try {
    await recorder.initialize();
    await expect(recorder.call(randomUUID(), 'session_open', { url: 'https://example.com' })).rejects.toThrow('daily_compute_limit');
    expect(createContext).not.toHaveBeenCalled();
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('recovers a finalized capture after restart without replay and rejects missing captures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-recovery-'));
  const owner = randomUUID();
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), startRecording: vi.fn(), recordingMode: 'screencast', redactSensitiveText: vi.fn(),
    stopRecording: vi.fn(async () => ({ body: Buffer.from('raw'), redactionPassed: true })),
    screenshot: vi.fn(async () => ({ body: Buffer.from('unsafe preview'), redactionPassed: false })) };
  const options = { dataDir: dir, encryptionKey: randomBytes(32), createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn(async () => Buffer.from('video')) };
  let recorder = new Recorder(options);
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent!.id);
    await recorder.call(owner, 'recording_start', { id });
    await new Promise(resolve => setTimeout(resolve, 5));
    await recorder.call(owner, 'recording_stop', { id });
    await expect(recorder.artifact(owner, id, 'preview')).rejects.toThrow();
    await recorder.close();
    await withRecorderStore(dir,db => db.connection.prepare("UPDATE jobs SET status='rendering',metadata=json_set(metadata,'$.status','rendering') WHERE id=?").run(id)); // state left by a killed renderer
    recorder = new Recorder(options); await recorder.initialize();
    expect((await recorder.call(owner, 'recording_status', { id })).structuredContent).toMatchObject({ status: 'captured', canRetryRender: true, errorCode: 'server_restarted' });
    await recorder.call(owner, 'recording_render', { id });
    await vi.waitFor(async () => expect((await recorder.call(owner, 'recording_status', { id })).structuredContent!.status).toBe('completed'));
    expect(driver.goto).toHaveBeenCalledTimes(1);
    await rm(join(dir, 'jobs', id, 'raw.webm'));
    await expect(recorder.call(owner, 'recording_render', { id })).rejects.toThrow('capture_unavailable');
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('reports the Mac window size a recording used, in its status and its observation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-desktop-window-'));
  const owner = randomUUID();
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), startRecording: vi.fn(), recordingMode: 'screencast', redactSensitiveText: vi.fn(),
    desktopWindow: { requested: '1920x1080', width: 1512, height: 850, resized: true, reason: 'fitted_to_screen' } as Record<string, unknown>,
    stopRecording: vi.fn(async () => { driver.desktopWindow = { ...driver.desktopWindow, restored: true }; return { body: Buffer.from('raw'), redactionPassed: true }; }),
    screenshot: vi.fn(async () => ({ body: Buffer.from('preview'), redactionPassed: false })) };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn(async () => Buffer.from('video')) });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent!.id);
    expect((await recorder.call(owner, 'recording_start', { id })).structuredContent).toMatchObject({ desktopWindow: { width: 1512, height: 850, resized: true, reason: 'fitted_to_screen' } });
    await recorder.call(owner, 'recording_stop', { id });
    expect((await recorder.call(owner, 'recording_status', { id })).structuredContent).toMatchObject({ status: 'captured', desktopWindow: { restored: true } });
    const observation = JSON.parse(await readFile(join(dir, 'jobs', id, 'observation.json'), 'utf8'));
    expect(observation.window).toEqual({ width: 1512, height: 850, resized: true });
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('never persists a recording whose redaction was not confirmed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-redaction-'));
  const owner = randomUUID();
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), startRecording: vi.fn(), recordingMode: 'screencast', redactSensitiveText: vi.fn(),
    stopRecording: vi.fn(async () => ({ body: Buffer.from('sensitive'), redactionPassed: false })) };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent!.id);
    await recorder.call(owner, 'recording_start', { id });
    await expect(recorder.call(owner, 'recording_stop', { id })).rejects.toThrow('capture_redaction_failed');
    await expect(readFile(join(dir, 'jobs', id, 'raw.webm'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

it('recovers a failed connection from its secure page and lets the agent follow the original id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-connect-retry-'));
  const owner = randomUUID();
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined),
    connectWithCredentials: vi.fn(async (): Promise<void> => { throw new Error('login_fields_not_found'); }),
    exportStorageState: vi.fn(async () => ({ cookies: [], origins: [] })) };
  const createContext = vi.fn(async () => driver);
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: createContext as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_connect', { url: 'https://example.com' })).structuredContent?.id);
    await expect(recorder.retryConnection(owner,id,'https://app.example.com/login')).rejects.toThrow('connection_not_failed');
    await recorder.submitConnectionCredentials(owner,id,'user','secret');
    await vi.waitFor(async () => expect((await recorder.call(owner,'connection_status',{id,waitMs:0})).structuredContent).toMatchObject({connectionStatus:'failed',canRetry:true}));
    await expect(recorder.retryConnection(randomUUID(),id,'https://app.example.com/login')).rejects.toThrow('recording_not_found');
    await expect(recorder.retryConnection(owner,id,'http://localhost/login')).rejects.toThrow('public_https_url_required');
    const retried = await recorder.retryConnection(owner,id,'https://app.example.com/login');
    expect(retried).toMatchObject({connectionStatus:'waiting',credentialsReceived:false,targetUrl:'https://app.example.com/login'});
    expect(createContext).toHaveBeenLastCalledWith(expect.objectContaining({allowedOrigins:expect.arrayContaining(['https://example.com','https://app.example.com'])}));
    expect((await recorder.retryConnection(owner,id,'https://app.example.com/login')).id).toBe(retried.id);
    expect(createContext).toHaveBeenCalledTimes(2);
    driver.connectWithCredentials.mockImplementation(async()=>undefined);
    await recorder.submitConnectionCredentials(owner,String(retried.id),'corrected-user','corrected-password');
    expect(driver.connectWithCredentials).toHaveBeenLastCalledWith('corrected-user','corrected-password',expect.any(AbortSignal),'https://app.example.com/login');
    await vi.waitFor(async () => expect((await recorder.call(owner,'connection_status',{id,waitMs:0})).structuredContent).toMatchObject({id:retried.id,connectionStatus:'ready',importId:expect.any(String)}));
    expect(await readJob(dir,id)).not.toContain('secret');
  } finally { await recorder.close(); await rm(dir,{recursive:true,force:true}); }
});

it('secure retry only adds the external origin actually observed and explicitly approved', async () => {
  const dir=await mkdtemp(join(tmpdir(),'recorder-redirect-'));
  const owner=randomUUID();
  const driver={goto:vi.fn(),dispose:vi.fn(async()=>undefined),connectWithCredentials:vi.fn(async()=>{throw new Error('origin_not_allowed:https://identity.example.net');})};
  const createContext=vi.fn(async()=>driver);
  const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),createContext:createContext as unknown as RecorderOptions['createContext'],render:vi.fn()});
  try {
    await recorder.initialize();
    const id=String((await recorder.call(owner,'session_connect',{url:'https://product.example.com'})).structuredContent?.id);
    await recorder.submitConnectionCredentials(owner,id,'user','secret');
    await vi.waitFor(async()=>expect((await recorder.call(owner,'connection_status',{id,waitMs:0})).structuredContent).toMatchObject({connectionStatus:'failed',blockedOrigin:'https://identity.example.net'}));
    await expect(recorder.retryConnection(owner,id,'https://product.example.com','https://unobserved.example.org')).rejects.toThrow('redirect_approval_invalid');
    await recorder.retryConnection(owner,id,'https://product.example.com','https://identity.example.net');
    expect(createContext).toHaveBeenLastCalledWith(expect.objectContaining({allowedOrigins:['https://product.example.com','https://identity.example.net']}));
  } finally {await recorder.close();await rm(dir,{recursive:true,force:true});}
});

it('exports explicitly approved desktop capture without claiming automatic redaction', async () => {
 const dir=await mkdtemp(join(tmpdir(),'recorder-desktop-')),owner=randomUUID();
 let finishUpload!:()=>void;
 const uploadPending=new Promise<void>(resolve=>{finishUpload=resolve;});
 const driver={capturePrivacy:'user-approved-desktop',captureViewport:{width:1280,height:720},recordingDurationMs:15050,
  goto:vi.fn(),dispose:vi.fn(async()=>undefined),startRecording:vi.fn(),redactSensitiveText:vi.fn(),
  stopRecording:vi.fn(async()=>{await uploadPending;return {body:Buffer.from('desktop video'),contentType:'video/mp4',redactionPassed:false};}),
  screenshot:vi.fn(async()=>({body:Buffer.from('desktop preview'),redactionPassed:false})),
 };
 const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),
  createContext:async()=>{throw Error('hosted_not_expected');},
  createLocalContext:vi.fn(async()=>driver) as unknown as NonNullable<RecorderOptions['createLocalContext']>,
  render:async()=>Buffer.from('rendered')});
 try {
  await recorder.initialize();
  const opened=await recorder.call(owner,'session_open',{url:'https://toru.tools',localConnectionId:randomUUID()});
  const id=String(opened.structuredContent?.id);
  await recorder.call(owner,'recording_start',{id});
  expect(driver.redactSensitiveText).not.toHaveBeenCalled();
  const stopping=await recorder.call(owner,'recording_stop',{id});
  expect(stopping.structuredContent?.status).toBe('stopping');
  expect((await recorder.call(owner,'recording_render',{id})).structuredContent?.status).toBe('stopping');
  expect((await recorder.call(owner,'recording_stop',{id})).structuredContent?.status).toBe('stopping');
  expect(driver.stopRecording).toHaveBeenCalledTimes(1);
  finishUpload();
  expect((await recorder.call(owner,'recording_status',{id})).structuredContent?.status).toBe('captured');
  expect(await readFile(join(dir,'jobs',id,'preview.png'),'utf8')).toBe('desktop preview');
  expect(await readFile(join(dir,'jobs',id,'raw.mp4'),'utf8')).toBe('desktop video');
  expect(JSON.parse(await readJob(dir,id))).toMatchObject({rawFile:'raw.mp4',privacyMode:'user-approved-unredacted'});
  expect(await withRecorderStore(dir,db=>db.connection.prepare("SELECT count(*) AS n FROM usage_reservations WHERE owner=? AND kind='browser_ms'").get(owner)?.n)).toBe(0);
  const observation=JSON.parse(await readFile(join(dir,'jobs',id,'observation.json'),'utf8'));
  expect(observation.idleRanges).toEqual([]);
  expect(observation.durationMs).toBe(15050);
  await recorder.call(owner,'recording_render',{id});
  expect((await recorder.call(owner,'recording_status',{id})).structuredContent?.status).toBe('completed');
 }finally{finishUpload();await recorder.close();await rm(dir,{recursive:true,force:true});}
});

it('opens the user\'s Chrome at the chosen page layout, 1920x1080 by default, and says how the screenshot scales', async () => {
 const dir=await mkdtemp(join(tmpdir(),'recorder-viewport-')),owner=randomUUID();
 const png=(width:number,height:number)=>{const body=Buffer.alloc(32);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(body);body.writeUInt32BE(width,16);body.writeUInt32BE(height,20);return body;};
 const driver:Record<string,unknown>={goto:vi.fn(async()=>undefined),dispose:vi.fn(async()=>undefined),currentUrl:vi.fn(async()=>'https://app.example.com/'),
  readPage:vi.fn(async()=>''),screenshot:vi.fn(async()=>({body:png(1280,720),contentType:'image/png',redactionPassed:true}))};
 const createLocalContext=vi.fn(async(_owner:string,_id:string,options:{viewport:{width:number;height:number}})=>{driver.captureViewport={...options.viewport};return driver;});
 const createContext=vi.fn(async()=>driver);
 const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),createContext:createContext as never,
  createLocalContext:createLocalContext as unknown as NonNullable<RecorderOptions['createLocalContext']>,render:async()=>Buffer.from('rendered')});
 try {
  await recorder.initialize();
  const id=String((await recorder.call(owner,'session_open',{url:'https://app.example.com/',localConnectionId:randomUUID()})).structuredContent?.id);
  expect(createLocalContext.mock.calls[0]![2].viewport).toEqual({width:1920,height:1080});
  // Coordinates stay CSS pixels of the 1920x1080 page; the 1280-wide screenshot says how it relates to them.
  expect((await recorder.call(owner,'browser_observe',{id,mode:'screenshot'})).structuredContent).toMatchObject({viewport:{width:1920,height:1080},screenshotScale:0.6667});
  await recorder.call(owner,'session_close',{id});
  const small=String((await recorder.call(owner,'session_open',{url:'https://app.example.com/',localConnectionId:randomUUID(),viewport:'1280x720'})).structuredContent?.id);
  expect(createLocalContext.mock.calls[1]![2].viewport).toEqual({width:1280,height:720});
  // An older extension records 1280x720 whatever was asked; a screenshot at the page's own size needs no note.
  expect((await recorder.call(owner,'browser_observe',{id:small,mode:'screenshot'})).structuredContent).not.toHaveProperty('screenshotScale');
  await recorder.call(owner,'session_close',{id:small});
  const laptop=String((await recorder.call(owner,'session_open',{url:'https://app.example.com/',localConnectionId:randomUUID(),viewport:'1440x900'})).structuredContent?.id);
  expect(createLocalContext.mock.calls[2]![2].viewport).toEqual({width:1440,height:900});
  await recorder.call(owner,'session_close',{id:laptop});
  // Only the presets.
  await expect(recorder.call(owner,'session_open',{url:'https://app.example.com/',localConnectionId:randomUUID(),viewport:'2560x1440'})).rejects.toThrow(/Invalid option/);
  expect(createLocalContext).toHaveBeenCalledTimes(3);
 }finally{await recorder.close();await rm(dir,{recursive:true,force:true});}
});

it('lets a recording in the user\'s own Chrome follow the demo to any https site, but not a hosted one', async () => {
 const dir=await mkdtemp(join(tmpdir(),'recorder-any-site-')),owner=randomUUID();
 const driver={goto:vi.fn(async()=>undefined),dispose:vi.fn(async()=>undefined)};
 let localOptions:{onNavigation(url:string):void}|undefined,hostedOptions:{onNavigation(url:string):void}|undefined;
 const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),
  createContext:vi.fn(async(options:{onNavigation(url:string):void})=>{hostedOptions=options;return driver;}) as unknown as RecorderOptions['createContext'],
  createLocalContext:vi.fn(async(_owner:string,_id:string,options:{onNavigation(url:string):void})=>{localOptions=options;return driver;}) as unknown as NonNullable<RecorderOptions['createLocalContext']>,
  render:async()=>Buffer.from('rendered')});
 try {
  await recorder.initialize();
  const local=await recorder.call(owner,'session_open',{url:'https://app.example.com/settings',localConnectionId:randomUUID()});
  const localId=String(local.structuredContent?.id);
  expect(()=>localOptions?.onNavigation('https://accounts.google.com/signin/oauth/consent')).not.toThrow();
  await recorder.call(owner,'browser_navigate',{id:localId,url:'https://docs.vendor.example.org/page'});
  expect(driver.goto).toHaveBeenLastCalledWith('https://docs.vendor.example.org/page');
  expect(()=>localOptions?.onNavigation('http://insecure.example.net/')).toThrow('public_https_url_required');
  await recorder.call(owner,'session_close',{id:localId});
  await recorder.call(owner,'session_open',{url:'https://app.example.com/settings'});
  expect(()=>hostedOptions?.onNavigation('https://accounts.google.com/signin')).toThrow('origin_not_allowed');
 }finally{await recorder.close();await rm(dir,{recursive:true,force:true});}
});

it('opens a local development server only in the user\'s own Chrome, and keeps that session on its origin', async () => {
 const dir=await mkdtemp(join(tmpdir(),'recorder-local-dev-')),owner=randomUUID();
 const driver={goto:vi.fn(async()=>undefined),dispose:vi.fn(async()=>undefined)};
 let localOptions:{allowedOrigins:string[];onNavigation(url:string):void}|undefined;
 const createContext=vi.fn(async()=>driver);
 const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),
  createContext:createContext as unknown as RecorderOptions['createContext'],
  createLocalContext:vi.fn(async(_owner:string,_id:string,options:{allowedOrigins:string[];onNavigation(url:string):void})=>{localOptions=options;return driver;}) as unknown as NonNullable<RecorderOptions['createLocalContext']>,
  render:async()=>Buffer.from('rendered')});
 try {
  await recorder.initialize();
  // Toru's own browser is ours: a localhost there would be the server's own loopback.
  for(const url of ['http://localhost:3000','https://localhost','https://127.0.0.1','https://[::1]','https://app.test','https://shop.localhost','http://app.test','http://[::1]:3000'])
   await expect(recorder.call(owner,'session_open',{url}),url).rejects.toThrow('public_https_url_required');
  await expect(recorder.call(owner,'queue_enqueue',{version:1,operation:'session_open',requestId:randomUUID(),arguments:{url:'http://localhost:3000'}})).rejects.toThrow('public_https_url_required');
  expect(createContext).not.toHaveBeenCalled();
  // Other private addresses and other schemes stay refused in the user's Chrome too.
  for(const url of ['http://10.0.0.8:3000','http://192.168.1.20','http://169.254.169.254/latest','http://service.internal','http://127.0.0.2:3000','http://user:pw@localhost:3000'])
   await expect(recorder.call(owner,'session_open',{url,localConnectionId:randomUUID()}),url).rejects.toThrow('public_https_url_required');
  // Opaque origins never parse as an origin at all.
  for(const url of ['file:///etc/passwd','chrome://settings','data:text/html,x','javascript:alert(1)'])
   await expect(recorder.call(owner,'session_open',{url,localConnectionId:randomUUID()}),url).rejects.toThrow(/public_https_url_required|Invalid URL/);
  expect(driver.goto).not.toHaveBeenCalled();
  for(const url of ['http://[::1]:5173/','http://shop.localhost:3000/','https://app.test/']){
   const opened=await recorder.call(owner,'session_open',{url,localConnectionId:randomUUID()});
   expect(driver.goto).toHaveBeenLastCalledWith(url);
   await recorder.call(owner,'session_close',{id:String(opened.structuredContent?.id)});
  }
  const local=await recorder.call(owner,'session_open',{url:'http://localhost:3000/dashboard',localConnectionId:randomUUID()});
  const id=String(local.structuredContent?.id);
  expect(localOptions?.allowedOrigins).toEqual(['http://localhost:3000']);
  expect(()=>localOptions?.onNavigation('http://localhost:3000/settings?tab=billing')).not.toThrow();
  await recorder.call(owner,'browser_navigate',{id,url:'http://localhost:3000/invoices/new'});
  expect(driver.goto).toHaveBeenLastCalledWith('http://localhost:3000/invoices/new');
  // Another port on the same local host is the same product (sign-in on :3001); another dev name or a private
  // address is never reached by following the demo.
  expect(()=>localOptions?.onNavigation('http://localhost:3001/')).not.toThrow();
  expect(()=>localOptions?.onNavigation('http://127.0.0.1:3000/')).toThrow('origin_not_allowed');
  expect(()=>localOptions?.onNavigation('http://10.0.0.8/')).toThrow('public_https_url_required');
  await expect(recorder.call(owner,'browser_navigate',{id,url:'http://admin.localhost:3000/'})).rejects.toThrow('origin_not_allowed');
  // The demo may still leave for a public https site (a provider's consent screen), as any own-Chrome recording.
  expect(()=>localOptions?.onNavigation('https://accounts.google.com/signin/oauth/consent')).not.toThrow();
  await recorder.call(owner,'session_close',{id});
  // A recording of a public site cannot wander onto the user's dev server.
  const site=await recorder.call(owner,'session_open',{url:'https://app.example.com/',localConnectionId:randomUUID()});
  expect(()=>localOptions?.onNavigation('http://localhost:3000/')).toThrow('origin_not_allowed');
  await expect(recorder.call(owner,'browser_navigate',{id:String(site.structuredContent?.id),url:'http://localhost:3000/'})).rejects.toThrow('origin_not_allowed');
  await recorder.call(owner,'session_close',{id:String(site.structuredContent?.id)});
 }finally{await recorder.close();await rm(dir,{recursive:true,force:true});}
});

it('blurs where the recorded window showed who the user is, in the source the renderer reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-identity-'));
  const owner = randomUUID();
  const footer = { x: 0.02, y: 0.92, width: 0.12, height: 0.05 };
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), startRecording: vi.fn(), recordingMode: 'screencast',
    redactSensitiveText: vi.fn(), stopRecording: vi.fn(async () => ({ body: Buffer.from('raw capture'), redactionPassed: true })),
    screenshot: vi.fn(async () => ({ body: Buffer.from('preview'), redactionPassed: true })),
    pointerTrail: () => [], pointerTelemetry: () => [], semanticTimeline: () => [],
    identitySightings: () => [{ atMs: 400, rects: [footer] }, { atMs: 1_800, rects: [footer] }],
  };
  const redactRegions = vi.fn(async (_source: string, output: string, _regions: unknown) => { await writeFile(output, 'redacted capture'); });
  const sources: string[] = [];
  const render = vi.fn(async (source: string) => { sources.push(await readFile(source, 'utf8')); return Buffer.from('video'); });
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render, redactRegions,
    assessQuality: async () => ({ passed: true, reasons: [], metrics: {} }) });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent?.id);
    await recorder.call(owner, 'recording_start', { id });
    await new Promise(resolve => setTimeout(resolve, 60));
    await recorder.call(owner, 'recording_stop', { id });
    const observation = JSON.parse(await readFile(join(dir, 'jobs', id, 'observation.json'), 'utf8'));
    expect(observation.redactions).toEqual([expect.objectContaining({ startMs: 0 })]);
    await recorder.call(owner, 'recording_render', { id });
    await vi.waitFor(async () => expect((await recorder.call(owner, 'recording_status', { id })).structuredContent?.status).toBe('completed'));
    expect(redactRegions.mock.calls[0]?.[2]).toEqual(observation.redactions);
    // The renderer only ever saw the blurred copy, and the copy is gone afterwards; the raw capture is untouched.
    expect(sources).toEqual(['redacted capture']);
    expect(await readFile(join(dir, 'jobs', id, 'raw.webm'), 'utf8')).toBe('raw capture');
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(dir, 'jobs', id))).some(name => name.startsWith('raw.redacted.'))).toBe(false);
  } finally {
    await recorder.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('records the raw video size of a capture at a device scale, keeping coordinates in the viewport', async () => {
 expect(videoSize({width:1280,height:720},{width:2560,height:1440})).toEqual({videoWidth:2560,videoHeight:1440});
 expect(videoSize({width:1280,height:720},{width:1920,height:1080})).toEqual({videoWidth:1920,videoHeight:1080});
 expect(videoSize({width:1280,height:720},{width:1280,height:720})).toEqual({});
 expect(videoSize({width:1280,height:720},undefined)).toEqual({});
 // Not the same picture: another aspect, smaller, or implausibly dense.
 expect(videoSize({width:1280,height:720},{width:2560,height:1600})).toEqual({});
 expect(videoSize({width:1280,height:720},{width:640,height:360})).toEqual({});
 expect(videoSize({width:1280,height:720},{width:5120,height:2880})).toEqual({});
 // The other presets: 1920x1080 and 1440x900 at most 2560 wide, and 1920x1080 at the encoder's smallest step.
 expect(videoSize({width:1920,height:1080},{width:2560,height:1440})).toEqual({videoWidth:2560,videoHeight:1440});
 expect(videoSize({width:1440,height:900},{width:2560,height:1600})).toEqual({videoWidth:2560,videoHeight:1600});
 expect(videoSize({width:1920,height:1080},{width:1280,height:720})).toEqual({videoWidth:1280,videoHeight:720});

 const dir=await mkdtemp(join(tmpdir(),'recorder-dense-')),owner=randomUUID();
 const driver={captureViewport:{width:1280,height:720},captureSize:{width:2560,height:1440},recordingDurationMs:4000,
  goto:vi.fn(),dispose:vi.fn(async()=>undefined),startRecording:vi.fn(),redactSensitiveText:vi.fn(),
  stopRecording:vi.fn(async()=>({body:Buffer.from('chrome video'),contentType:'video/mp4',redactionPassed:true})),
  screenshot:vi.fn(async()=>({body:Buffer.from('preview'),redactionPassed:true})),
 };
 const render=vi.fn(async()=>Buffer.from('rendered'));
 const recorder=new Recorder({dataDir:dir,encryptionKey:randomBytes(32),
  createContext:async()=>{throw Error('hosted_not_expected');},
  createLocalContext:vi.fn(async()=>driver) as unknown as NonNullable<RecorderOptions['createLocalContext']>,
  render,assessQuality:async()=>({passed:true,checks:[]}) as never});
 try {
  await recorder.initialize();
  const id=String((await recorder.call(owner,'session_open',{url:'https://toru.tools',localConnectionId:randomUUID()})).structuredContent?.id);
  await recorder.call(owner,'recording_start',{id});
  await recorder.call(owner,'recording_stop',{id});
  await vi.waitFor(async()=>expect((await recorder.call(owner,'recording_status',{id})).structuredContent?.status).toBe('captured'));
  const observation=JSON.parse(await readFile(join(dir,'jobs',id,'observation.json'),'utf8'));
  expect(observation).toMatchObject({width:1280,height:720,videoWidth:2560,videoHeight:1440});
  await recorder.call(owner,'recording_render',{id,width:2560});
  await vi.waitFor(async()=>expect((await recorder.call(owner,'recording_status',{id})).structuredContent?.status).toBe('completed'));
  // A 2560 render of the 1280x720 viewport: the frame is 2560 wide and the cursor keeps its size on the denser video.
  const config=(render.mock.calls[0] as unknown[])[1] as {width:number;height:number;cursorScale:number};
  expect(config).toMatchObject({width:2560,height:1440});
  expect(config.cursorScale).toBe(2);
 }finally{await recorder.close();await rm(dir,{recursive:true,force:true});}
});

it('makes gestures with the driver, falls back to pointing on one without them, and reads a page in steps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-gestures-'));
  const owner = randomUUID();
  const driver: Record<string, unknown> & { pointer: ReturnType<typeof vi.fn>; gesture?: ReturnType<typeof vi.fn>; scrollBy: ReturnType<typeof vi.fn> } = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), startRecording: vi.fn(async () => undefined),
    recordingMode: 'screencast' as const, redactSensitiveText: vi.fn(async () => undefined),
    pointer: vi.fn(async () => undefined), gesture: vi.fn(async () => undefined), scrollBy: vi.fn(async () => undefined),
    readPage: vi.fn(async () => '[ref_1] row Acme — visible at (10,10) viewport CSS pixels'), currentUrl: vi.fn(async () => 'https://example.com'),
    screenshot: vi.fn(async () => ({ body: Buffer.from('frame'), contentType: 'image/png', redactionPassed: true })),
  };
  const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32),
    createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
  try {
    await recorder.initialize();
    const id = String((await recorder.call(owner, 'session_open', { url: 'https://example.com' })).structuredContent?.id);
    await recorder.call(owner, 'recording_start', { id });
    await recorder.call(owner, 'browser_trace', { id, ref: 'ref_1', shape: 'circle' });
    await recorder.call(owner, 'browser_sweep', { id, ref: 'ref_1', rows: 3 });
    expect(driver.gesture).toHaveBeenCalledWith('circle', { type: 'ref', ref: 'ref_1' }, undefined);
    expect(driver.gesture).toHaveBeenCalledWith('sweep', { type: 'ref', ref: 'ref_1' }, { rows: 3 });
    driver.gesture!.mockRejectedValueOnce(new Error('local_method_forbidden'));
    await recorder.call(owner, 'browser_point', { id, ref: 'ref_1' });
    expect(driver.pointer).toHaveBeenCalledWith('move', { type: 'ref', ref: 'ref_1' });
    // A number or a cell has no ref: a point on screen names it.
    await recorder.call(owner, 'browser_trace', { id, x: 640, y: 300, shape: 'underline' });
    expect(driver.gesture).toHaveBeenCalledWith('underline', { type: 'coordinate', x: 640, y: 300 }, undefined);
    await recorder.call(owner, 'browser_highlight', { id, ref: 'ref_1', text: 'founded in 2013' });
    expect(driver.gesture).toHaveBeenCalledWith('highlight', { type: 'ref', ref: 'ref_1' }, { text: 'founded in 2013' });
    await recorder.call(owner, 'browser_read', { id, amount: 900 });
    const scrolled = driver.scrollBy.mock.calls.map(call => call[2] as number);
    expect(scrolled.reduce((sum, step) => sum + step, 0)).toBe(900);
    expect(scrolled.every(step => step <= 600)).toBe(true);
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
}, 20_000);
