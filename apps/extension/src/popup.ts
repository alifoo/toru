const $ = (id: string) => document.getElementById(id)!;
type Status = { paired: boolean; connectionId: string | null; server: string; version: string; state: { state: string; detail?: string } | null };

async function render() {
  const status = await chrome.runtime.sendMessage({ type: 'toru-status' }) as Status;
  const state = status.paired ? status.state?.state ?? 'offline' : 'signed_out';
  $('status').dataset.state = state;
  $('label').textContent = { online: 'Ready to record', recording: 'Recording in a Toru window', offline: 'Reconnecting to Toru…', signed_out: 'Not connected' }[state] ?? state;
  $('help').textContent = status.paired
    ? 'Your agent can record in this Chrome. Each recording opens its own window; keep it visible until the recording ends.'
    : 'Connect this Chrome once from your Toru account, or open the link your agent gives you.';
  $('connect').hidden = status.paired;
  $('unpair').hidden = !status.paired;
  $('meta').textContent = `v${status.version}${status.connectionId ? ` · ${status.connectionId.slice(0, 8)}` : ''}`;
}
$('pair').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('code') as HTMLInputElement;
  const reply = await chrome.runtime.sendMessage({ type: 'toru-pair-code', code: input.value.trim() }) as { paired?: boolean; error?: string };
  if (!reply?.paired) $('help').textContent = reply?.error === 'toru_unreachable' ? 'Toru could not be reached.' : 'That code expired or was already used.';
  input.value = '';
  await render();
});
$('unpair').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'toru-unpair' }); await render(); });
void render();
setInterval(() => void render(), 2000);
