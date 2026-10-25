/**
 * Runs only on the Toru server's /extension/connect page: hands the one-time code in the link to the
 * extension, removes it from the address bar and tells the user how it went.
 */
const statusLine = document.getElementById('toru-extension-status');
const code = new URLSearchParams(location.hash.slice(1)).get('code');
history.replaceState(null, '', location.pathname);
const heading = document.getElementById('toru-extension-heading');
const titles: Record<string, string> = { connecting: 'Connecting…', connected: 'Chrome connected', failed: 'Not connected', invalid: 'Not connected' };
const show = (state: string, text: string) => {
  if (statusLine) { statusLine.dataset.state = state; statusLine.textContent = text; }
  if (heading && titles[state]) heading.textContent = titles[state];
};
if (!code) show('invalid', 'This link has no pairing code. Ask your agent for a new link.');
else {
  show('connecting', 'Connecting this Chrome to Toru…');
  chrome.runtime.sendMessage({ type: 'toru-pair', code }).then((reply: { paired?: boolean; error?: string } | undefined) => {
    if (reply?.paired) show('connected', 'Your agent can now record in this Chrome: Toru opens a new window for each recording. You can close this tab.');
    else if (reply?.error === 'toru_unreachable') show('failed', 'Toru could not be reached. Check your connection and open the link again.');
    else show('failed', 'This link expired or was already used. Ask your agent for a new one.');
  }, () => show('failed', 'The Toru extension did not answer. Reload this page.'));
}
export {};
