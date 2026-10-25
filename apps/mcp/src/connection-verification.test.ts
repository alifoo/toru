import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Recorder, type RecorderOptions } from './recorder.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
function harness(driver: Record<string, unknown>) {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recorder-verification-')), owner = randomUUID();
    const recorder = new Recorder({ dataDir: dir, encryptionKey: randomBytes(32), createContext: vi.fn(async () => driver) as unknown as RecorderOptions['createContext'], render: vi.fn() });
    await recorder.initialize();
    cleanups.push(async () => { await recorder.close(); await rm(dir, { recursive: true, force: true }); });
    const status = async (id: string) => (await recorder.call(owner, 'connection_status', { id, waitMs: 0 })).structuredContent as Record<string, unknown>;
    return { dir, owner, recorder, status };
  })();
}
it('e-mail-only sign-in pauses for the user code on the secure page and never stores a password', async () => {
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    connectWithCredentials: vi.fn(async (_u: string, password: string | undefined) => { expect(password).toBeUndefined(); throw new Error('additional_verification_required'); }),
    completeLoginChallenge: vi.fn(async (input: { code?: string }) => { if (input.code !== '246810') throw new Error('invalid_verification_code'); }),
    exportStorageState: vi.fn(async () => ({ cookies: [], origins: [] })),
  };
  const h = await harness(driver);
  const opened = (await h.recorder.call(h.owner, 'session_connect', { url: 'https://app.example.com/login', loginEmail: 'demo@example.com' })).structuredContent as Record<string, unknown>;
  const id = String(opened.id);
  expect(opened.connectionStatus).toBe('verifying');
  await vi.waitFor(async () => expect((await h.status(id)).connectionStatus).toBe('awaiting_code'));
  const paused = await h.status(id);
  expect(paused).toMatchObject({ emailOnly: true, nextAction: 'user_enters_code_on_setup_page', userActionRequired: true });
  expect(String(paused.instruction)).toContain('Never ask for the code in chat');
  expect(driver.dispose).not.toHaveBeenCalled();
  await expect(h.recorder.submitConnectionVerification(h.owner, id, {})).rejects.toThrow('verification_input_required');
  // A wrong code keeps the page open for another attempt.
  expect((await h.recorder.submitConnectionVerification(h.owner, id, { code: '000000' })).connectionStatus).toBe('verifying');
  await vi.waitFor(async () => expect(await h.status(id)).toMatchObject({ connectionStatus: 'awaiting_code', connectionError: 'invalid_verification_code' }));
  expect((await h.recorder.submitConnectionVerification(h.owner, id, { code: '246810' })).connectionStatus).toBe('verifying');
  await vi.waitFor(async () => expect(await h.status(id)).toMatchObject({ connectionStatus: 'ready', importId: expect.any(String) }));
  expect(driver.completeLoginChallenge).toHaveBeenCalledTimes(2);
  const stored = await readFile(join(h.dir, 'jobs', id, 'job.json'), 'utf8').catch(() => '');
  expect(stored).not.toContain('246810');
});
it('a magic link outside the allowed origins is refused before the browser opens it', async () => {
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), connectWithCredentials: vi.fn(async () => { throw new Error('additional_verification_required'); }), completeLoginChallenge: vi.fn(), exportStorageState: vi.fn() };
  const h = await harness(driver);
  const id = String((await h.recorder.call(h.owner, 'session_connect', { url: 'https://app.example.com/login', loginEmail: 'demo@example.com' })).structuredContent?.id);
  await vi.waitFor(async () => expect((await h.status(id)).connectionStatus).toBe('awaiting_code'));
  await expect(h.recorder.submitConnectionVerification(h.owner, id, { link: 'https://evil.example.net/magic' })).rejects.toThrow(/origin_not_allowed/);
  expect(driver.completeLoginChallenge).not.toHaveBeenCalled();
});
it('a saved demo account signs in without the agent or the chat seeing the password', async () => {
  const seen: Array<[string, string | undefined]> = [];
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), connectWithCredentials: vi.fn(async (u: string, p: string | undefined) => { seen.push([u, p]); }), exportStorageState: vi.fn(async () => ({ cookies: [], origins: [] })) };
  const h = await harness(driver);
  await expect(h.recorder.call(h.owner, 'session_connect', { url: 'https://app.example.com/login', useDemoAccount: true })).rejects.toThrow('demo_account_not_found');
  h.recorder.saveDemoAccount(h.owner, 'https://app.example.com', 'demo@example.com', 'vault-secret');
  const listed = (await h.recorder.call(h.owner, 'demo_accounts_list', {})).structuredContent as { accounts: unknown[] };
  expect(listed.accounts).toEqual([{ origin: 'https://app.example.com', username: 'demo@example.com', kind: 'password' }]);
  const opened = (await h.recorder.call(h.owner, 'session_connect', { url: 'https://app.example.com/login', useDemoAccount: true })).structuredContent as Record<string, unknown>;
  expect(opened).toMatchObject({ connectionStatus: 'verifying', demoAccount: true });
  expect(JSON.stringify(opened)).not.toContain('vault-secret');
  await vi.waitFor(async () => expect(await h.status(String(opened.id))).toMatchObject({ connectionStatus: 'ready', importId: expect.any(String) }));
  expect(seen).toEqual([['demo@example.com', 'vault-secret']]);
  expect(h.recorder.deleteDemoAccount(h.owner, 'https://app.example.com')).toBe(true);
  expect(h.recorder.listDemoAccounts(h.owner)).toEqual([]);
});

it('a saved e-mail login goes through the code pause, never a password', async () => {
  const driver = {
    goto: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    connectWithCredentials: vi.fn(async (_u: string, password: string | undefined) => { expect(password).toBeUndefined(); throw new Error('additional_verification_required'); }),
    completeLoginChallenge: vi.fn(async () => undefined), exportStorageState: vi.fn(async () => ({ cookies: [], origins: [] })),
  };
  const h = await harness(driver);
  h.recorder.saveDemoAccount(h.owner, 'https://app.example.com', 'demo@example.com', undefined);
  const listed = (await h.recorder.call(h.owner, 'demo_accounts_list', {})).structuredContent as { accounts: unknown[] };
  expect(listed.accounts).toEqual([{ origin: 'https://app.example.com', username: 'demo@example.com', kind: 'email' }]);
  const id = String((await h.recorder.call(h.owner, 'session_connect', { url: 'https://app.example.com/login', useDemoAccount: true })).structuredContent?.id);
  await vi.waitFor(async () => expect(await h.status(id)).toMatchObject({ connectionStatus: 'awaiting_code', demoAccount: true }));
  await h.recorder.submitConnectionVerification(h.owner, id, { code: '123456' });
  await vi.waitFor(async () => expect((await h.status(id)).connectionStatus).toBe('ready'));
});

it('a ready sign-in reports where it landed, without the query, and points session_open there', async () => {
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), connectWithCredentials: vi.fn(async () => undefined),
    currentUrl: vi.fn(async () => 'https://app.example.com/home?session=secret'), exportStorageState: vi.fn(async () => ({ cookies: [], origins: [] })) };
  const h = await harness(driver);
  h.recorder.saveDemoAccount(h.owner, 'https://example.com', 'demo@example.com', 'vault-secret');
  const id = String((await h.recorder.call(h.owner, 'session_connect', { url: 'https://example.com', useDemoAccount: true })).structuredContent?.id);
  await vi.waitFor(async () => expect((await h.status(id)).connectionStatus).toBe('ready'));
  const ready = await h.status(id);
  expect(ready).toMatchObject({ signedInUrl: 'https://app.example.com/home', nextCall: { name: 'session_open', arguments: { url: 'https://app.example.com/home' } } });
  expect(JSON.stringify(ready)).not.toContain('secret');
});

it('a saved login starts the next sign-in from its last signed-in state, so the product sees a returning browser', async () => {
  const driver = { goto: vi.fn(), dispose: vi.fn(async () => undefined), connectWithCredentials: vi.fn(async () => undefined), currentUrl: vi.fn(async () => 'https://app.example.com/home'),
    exportStorageState: vi.fn(async () => ({ cookies: [{ name: '__client', value: 'trusted-device', domain: 'clerk.example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] })) };
  const h = await harness(driver);
  const createContext = (h.recorder as unknown as { options: { createContext: ReturnType<typeof vi.fn> } }).options.createContext;
  h.recorder.saveDemoAccount(h.owner, 'https://example.com', 'demo@example.com', 'vault-secret');
  // The recorder zeroes the state buffer after use; read it when the browser is created.
  const seen: string[] = [];
  createContext.mockImplementation(async (options: { sessionState: Uint8Array }) => { seen.push(Buffer.from(options.sessionState).toString()); return driver; });
  const restored = () => seen.at(-1) ?? '';
  const connect = async () => {
    const id = String((await h.recorder.call(h.owner, 'session_connect', { url: 'https://example.com', useDemoAccount: true })).structuredContent?.id);
    await vi.waitFor(async () => expect((await h.status(id)).connectionStatus).toBe('ready'));
  };
  await connect();
  expect(restored()).not.toContain('trusted-device');
  await connect();
  expect(restored()).toContain('trusted-device');
  // Editing the saved login to another account starts fresh instead of reusing this one's session.
  h.recorder.saveDemoAccount(h.owner, 'https://example.com', 'other@example.com', 'vault-secret');
  await connect();
  expect(restored()).not.toContain('trusted-device');
  // A different saved login does not inherit it.
  h.recorder.saveDemoAccount(h.owner, 'https://other.example.org', 'demo@example.org', 'vault-secret');
  const id = String((await h.recorder.call(h.owner, 'session_connect', { url: 'https://other.example.org', useDemoAccount: true })).structuredContent?.id);
  await vi.waitFor(async () => expect((await h.status(id)).connectionStatus).not.toBe('verifying'));
  expect(restored()).not.toContain('trusted-device');
});
