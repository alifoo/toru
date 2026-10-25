"""Disposable Linux/WebDriver probe. Synthetic content only; no recorder credentials.

Feed on stdin to an isolated container with Python, ChromeDriver and Chromium.
This is a sandbox diagnostic, not tenant isolation or full capture acceptance.
"""
import base64
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

assert os.getuid() != 0, 'nonroot_required'
browser = os.environ.get('PROBE_CHROMIUM', '/usr/lib/chromium/chromium')
driver = subprocess.Popen(['chromedriver', '--port=9515', '--log-level=OFF'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
session = None
def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:9515' + path, data=data,
                                 headers={'Content-Type': 'application/json'}, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        value = json.load(response)['value']
    if isinstance(value, dict) and value.get('error'):
        raise RuntimeError(value['error'] + ': ' + value.get('message', '')[:500])
    return value

try:
    for _ in range(100):
        if driver.poll() is not None:
            raise RuntimeError('driver_exited')
        try:
            if request('/status')['ready']:
                break
        except OSError:
            pass
        time.sleep(.1)
    else:
        raise RuntimeError('driver_timeout')
    with tempfile.TemporaryDirectory(prefix='recorder-probe-') as profile:
        opened = request('/session', {'capabilities': {'alwaysMatch': {
            'browserName': 'chrome', 'goog:chromeOptions': {'binary': browser, 'args': [
                '--headless=new', '--no-first-run', '--no-default-browser-check',
                '--window-size=800,600', '--user-data-dir=' + profile]}}}})
        session = opened['sessionId']
        root = '/session/' + session
        request(root + '/url', {'url': 'chrome://sandbox/'})
        sandbox_text = request(root + '/execute/sync', {'script': 'return document.body.innerText', 'args': []})
        for label in ['PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox']:
            assert re.search(re.escape(label) + r'\s+Yes(?:\s|$)', sandbox_text), 'browser_sandbox_status_failed'
        request(root + '/url', {'url': 'data:text/html,<title>Recorder isolation probe</title><h1>synthetic</h1>'})
        assert request(root + '/title') == 'Recorder isolation probe', 'synthetic_page_failed'
        png = base64.b64decode(request(root + '/screenshot'))
        assert png.startswith(b'\x89PNG\r\n\x1a\n'), 'screenshot_failed'
        renderers = []
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                # Chromium rewrites its process title into one space-separated argv entry.
                args = re.split(rb'[\x00\s]+', (path / 'cmdline').read_bytes())
                if b'--type=renderer' not in args:
                    continue
                assert b'--no-sandbox' not in args, 'renderer_sandbox_disabled'
                status = dict(line.split(':', 1) for line in (path / 'status').read_text().splitlines() if ':' in line)
                safe = {k: status[k].strip() for k in ['Uid', 'NoNewPrivs', 'Seccomp', 'CapEff']}
                assert all(int(uid) != 0 for uid in safe['Uid'].split()), 'root_renderer'
                assert safe['NoNewPrivs'] == '1' and safe['Seccomp'] == '2', 'renderer_filter_missing'
                assert int(safe['CapEff'], 16) == 0, 'renderer_capabilities'
                renderers.append(safe)
            except (FileNotFoundError, ProcessLookupError):
                continue
        assert renderers, 'renderer_evidence_missing'
        print(json.dumps({'browserVersion': opened['capabilities']['browserVersion'],
                          'sandboxStatusText': sandbox_text, 'rendererStatus': renderers,
                          'screenshotBytes': len(png), 'syntheticPage': True}))
        request(root, method='DELETE')
        session = None
finally:
    if session:
        try:
            request('/session/' + session, method='DELETE')
        except Exception:
            pass
    driver.terminate()
    try:
        driver.wait(timeout=5)
    except subprocess.TimeoutExpired:
        driver.kill()
        driver.wait(timeout=5)
