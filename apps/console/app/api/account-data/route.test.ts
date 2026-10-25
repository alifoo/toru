import { afterEach, expect, it, vi } from 'vitest';
const { auth, clerkClient, deleteUser } = vi.hoisted(() => ({ auth: vi.fn(), clerkClient: vi.fn(), deleteUser: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth, clerkClient }));
import { DELETE } from './route';
import { recorderOwnerFor } from '../../../lib/recorder-owner';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
const removed = { state: 'data_removed', accountTombstoneRetained: true, financialRecordsRetained: true, backupsErased: false };
function setup(userId: string | null = 'verified-user') {
  auth.mockResolvedValue({ userId });
  clerkClient.mockResolvedValue({ users: { deleteUser } }); deleteUser.mockResolvedValue({ deleted: true });
  vi.stubEnv('RECORDER_URL', 'https://recorder.example'); vi.stubEnv('RECORDER_ADMIN_KEY', 'synthetic-admin');
  const fetch = vi.fn(async () => Response.json(removed)); vi.stubGlobal('fetch', fetch); return fetch;
}
function request(body: unknown = { confirmation: 'DELETE' }, origin = 'https://console.example') {
  return new Request('https://console.example/api/account-data?owner=untrusted', {
    method: 'DELETE', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
it('requires same origin, authentication and explicit confirmation before contacting the service', async () => {
  const fetch = setup(null);
  expect((await DELETE(request())).status).toBe(401);
  auth.mockResolvedValue({ userId: 'verified-user' });
  expect((await DELETE(request({}, 'https://attacker.example'))).status).toBe(403);
  expect((await DELETE(request({}))).status).toBe(400);
  expect((await DELETE(request({ confirmation: 'DELETE', padding: 'x'.repeat(1024) }))).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled(); expect(deleteUser).not.toHaveBeenCalled();
});
it('derives ownership from the session and deletes only that Clerk identity after Recorder confirms erasure', async () => {
  const fetch = setup();
  const response = await DELETE(request({ confirmation: 'DELETE', owner: 'another-owner', confirmOwner: 'another-owner' }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...removed, state: 'account_deleted' });
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('verified-user');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/admin/account-data');
  expect(JSON.parse(options.body as string)).toEqual({ owner: recorderOwnerFor('verified-user'), confirmOwner: recorderOwnerFor('verified-user') });
});
it('keeps pending deletion distinct from completed deletion', async () => {
  const fetch = setup(); fetch.mockResolvedValueOnce(Response.json({ state: 'deletion_pending', privateDetail: 'hidden' }, { status: 202 }));
  const response = await DELETE(request()); expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ state: 'deletion_pending', retryAfterMs: 5000 });
  expect(deleteUser).not.toHaveBeenCalled();
});
it('does not delete the Clerk identity when Recorder requires billing review', async () => {
  const fetch = setup();
  fetch.mockResolvedValueOnce(Response.json({ error: 'account_deletion_review_required' }, { status: 409 }));
  const response = await DELETE(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'account_deletion_review_required' });
  expect(deleteUser).not.toHaveBeenCalled();
});
it('does not claim completion on malformed responses or transport timeouts', async () => {
  const fetch = setup();
  fetch.mockResolvedValueOnce(Response.json({ state: 'data_removed', sensitive: 'hidden' }));
  let response = await DELETE(request()); expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'deletion_status_unknown' });
  fetch.mockRejectedValueOnce(new DOMException('private upstream detail', 'TimeoutError'));
  response = await DELETE(request()); expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'deletion_status_unknown' });
  expect(deleteUser).not.toHaveBeenCalled();
});
it('reports an incomplete identity deletion without claiming Recorder data is still present', async () => {
  setup(); deleteUser.mockRejectedValueOnce(new Error('private Clerk detail'));
  const response = await DELETE(request()); expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ state: 'identity_deletion_pending', retryAfterMs: 5000 });
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('verified-user');
});
