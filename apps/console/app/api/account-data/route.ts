import { auth, clerkClient } from '@clerk/nextjs/server';
import { recorderOwnerFor } from '../../../lib/recorder-owner';

const headers = { 'cache-control': 'private, no-store' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

export async function DELETE(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return fail('origin_forbidden', 403);
  const { userId } = await auth();
  if (!userId) return fail('authentication_required', 401);
  const recorderUrl = process.env.RECORDER_URL, adminKey = process.env.RECORDER_ADMIN_KEY;
  if (!recorderUrl || !adminKey) return fail('recorder_not_configured', 503);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return fail('json_required', 415);
  try {
    const reader = request.body?.getReader();
    if (!reader) return fail('invalid_body', 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) { await reader.cancel(); return fail('body_too_large', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input?.confirmation !== 'DELETE') return fail('confirmation_required', 400);
  } catch { return fail('invalid_body', 400); }
  const owner = recorderOwnerFor(userId);
  try {
    const response = await fetch(new URL('/admin/account-data', recorderUrl), {
      method: 'DELETE', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ owner, confirmOwner: owner }), cache: 'no-store', signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json();
    if (response.status === 202 && body?.state === 'deletion_pending') {
      return Response.json({ state: 'deletion_pending', retryAfterMs: 5000 }, { status: 202, headers });
    }
    if (response.status === 200 && body?.state === 'data_removed' &&
        body.accountTombstoneRetained === true && body.financialRecordsRetained === true && body.backupsErased === false) {
      try { await (await clerkClient()).users.deleteUser(userId); }
      catch {
        // Recorder data is gone; a retry can finish identity deletion without
        // replaying browser work or restoring the account.
        return Response.json({ state: 'identity_deletion_pending', retryAfterMs: 5000 }, { status: 202, headers });
      }
      return Response.json({ state: 'account_deleted', accountTombstoneRetained: true,
        financialRecordsRetained: true, backupsErased: false }, { headers });
    }
    if (response.status === 404 && body?.error === 'account_not_found') return fail('account_not_found', 404);
    if (response.status === 409 && body?.error === 'account_deletion_review_required') return fail('account_deletion_review_required', 409);
    if (response.status === 503 && body?.error === 'account_deletion_unavailable') return fail('account_deletion_unavailable', 503);
    return fail('deletion_status_unknown', 503);
  } catch {
    // A timeout does not prove that the upstream deletion failed. Retrying is safe.
    return fail('deletion_status_unknown', 503);
  }
}
