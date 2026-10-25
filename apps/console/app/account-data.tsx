'use client';

import { useEffect, useRef, useState } from 'react';

type State = 'idle' | 'working' | 'pending' | 'identity_pending' | 'removed' | 'unknown' | 'unavailable' | 'missing' | 'billing_review';
const messages: Record<State, string> = {
  idle: '',
  working: 'Stopping active work and removing your Toru account…',
  pending: 'Your account is disabled, but cleanup is still pending. Wait a few seconds, then retry to finish removing the data.',
  identity_pending: 'Your Toru data is removed from active storage, but deletion of your sign-in identity could not be confirmed. Retry to finish closing the account.',
  removed: 'Your Toru data was removed from active storage and your sign-in identity was deleted. Your account is closed.',
  unknown: 'We could not confirm the result. Removal may already have started. Retry safely to confirm or finish it; a timeout does not undo deletion.',
  unavailable: 'Self-service deletion is not configured on this recorder. Contact the operator to request removal.',
  missing: 'No Toru account was found for this login. No removal has been confirmed.',
  billing_review: 'Your account has a checkout or subscription that needs billing review before deletion. No account data was removed. Contact the service operator before retrying.',
};

export function AccountData({ onStart, onBlocked }: { onStart: () => void; onBlocked: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  const [state, setState] = useState<State>('idle');
  const alive = useRef(true), busy = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function remove() {
    if (confirmation !== 'DELETE' || busy.current || state === 'removed') return;
    busy.current = true; setState('working'); onStart();
    try {
      const response = await fetch('/api/account-data', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation }), signal: AbortSignal.timeout(50_000),
      });
      const body = await response.json();
      if (!alive.current) return;
      if (response.status === 200 && body?.state === 'account_deleted') setState('removed');
      else if (response.status === 202 && body?.state === 'deletion_pending') setState('pending');
      else if (response.status === 202 && body?.state === 'identity_deletion_pending') setState('identity_pending');
      else if (response.status === 503 && body?.error === 'account_deletion_unavailable') setState('unavailable');
      else if (response.status === 409 && body?.error === 'account_deletion_review_required') { setState('billing_review'); onBlocked(); }
      else if (response.status === 404 && body?.error === 'account_not_found') setState('missing');
      else setState('unknown');
    } catch { if (alive.current) setState('unknown'); }
    finally { busy.current = false; }
  }

  return <section className="account-data" aria-labelledby="account-data-title">
    <p className="eyebrow">Privacy and data</p>
    <h2 id="account-data-title">Delete my Toru account</h2>
    <p>This permanently removes your recordings, saved browser sessions and preparation notes from active storage. It stops your work, revokes your credentials and deletes your sign-in identity. There is no undo.</p>
    <p>Account deletion records, revoked credential records and financial / usage records are retained. Existing backups are not erased immediately; the deletion record prevents restored Toru data from becoming active again.</p>
    {state !== 'removed' && <form onSubmit={event => { event.preventDefault(); void remove(); }}>
      <label htmlFor="delete-confirmation">Type DELETE to confirm</label>
      <input id="delete-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={state === 'working'} aria-describedby="deletion-status" />
      <button className="quiet" type="submit" disabled={confirmation !== 'DELETE' || state === 'working'}>
        {state === 'working' ? 'Removing…' : state === 'pending' || state === 'identity_pending' || state === 'unknown' ? 'Retry removal' : 'Permanently delete my account'}
      </button>
    </form>}
    <p id="deletion-status" role="status" aria-live="polite">{messages[state]}</p>
    {state !== 'idle' && state !== 'working' && state !== 'removed' && state !== 'billing_review' && <p>Recording controls are hidden during this request. You can reload the console to check your account status.</p>}
  </section>;
}
