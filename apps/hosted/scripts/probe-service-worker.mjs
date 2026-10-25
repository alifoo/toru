// Pipe into `node --input-type=module - ENDPOINT SYNTHETIC_TOKEN` on a Railway service.
// No application data or credentials are read by this synthetic connectivity probe.
import {createServer} from 'node:http';
import {connect} from 'node:net';
const [endpoint, token] = process.argv.slice(2);
if (!endpoint || !token) {
  throw new Error('usage: probe-service-worker.mjs PRIVATE_ENDPOINT SYNTHETIC_TOKEN');
}

async function command(method, path, payload) {
  const response = await fetch(endpoint + path, {
    method,
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`worker_http_${response.status}`);
  return (await response.json()).value;
}

async function screencastFrame(sessionBase) {
  const response = await fetch(endpoint + '/cdp/json/list', {
    headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`worker_cdp_targets_${response.status}`);
  const targets = await response.json();
  const target = targets.find(item => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string');
  if (!target) throw new Error('worker_cdp_page_missing');
  const path = new URL(target.webSocketDebuggerUrl).pathname;
  if (!/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(path)) throw new Error('worker_cdp_page_invalid');

  // Node's WebSocket API cannot attach the worker Bearer header. A loopback-only
  // bridge adds it to exactly one validated page target; it exposes no public port.
  const sockets = new Set();
  const bridge = createServer((_request, reply) => { reply.writeHead(404); reply.end(); });
  bridge.on('upgrade', (request, client, head) => {
    if (request.url !== path) { client.destroy(); return; }
    const remote = new URL(endpoint);
    const upstream = connect({host: remote.hostname.replace(/^\[|\]$/g, ''), port: Number(remote.port)});
    sockets.add(client); sockets.add(upstream);
    upstream.once('connect', () => {
      const headers = [`GET /cdp${path} HTTP/1.1`, `Host: ${remote.host}`,
        `Authorization: Bearer ${token}`];
      for (const name of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.push(`${name}: ${value}`);
      }
      upstream.write(headers.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(0, '127.0.0.1', resolve);
  });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}${path}`);
    const frame = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('worker_cdp_frame_timeout')), 20_000);
      const fail = () => { clearTimeout(timeout); reject(new Error('worker_cdp_socket_closed')); };
      socket.addEventListener('error', fail, {once: true});
      socket.addEventListener('close', fail, {once: true});
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({id: 1, method: 'Page.enable'}));
        socket.send(JSON.stringify({id: 2, method: 'Page.startScreencast',
          params: {format: 'jpeg', quality: 60, everyNthFrame: 1}}));
        void command('POST', `${sessionBase}/execute/sync`, {
          script: 'window.scrollTo(0, Math.min(100, document.body.scrollHeight));', args: [],
        }).catch(reject);
      }, {once: true});
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.error) { clearTimeout(timeout); reject(new Error('worker_cdp_command_failed')); return; }
        if (message.method !== 'Page.screencastFrame') return;
        const bytes = Buffer.from(message.params?.data ?? '', 'base64');
        if (!bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
          clearTimeout(timeout); reject(new Error('worker_cdp_frame_invalid')); return;
        }
        socket.send(JSON.stringify({id: 3, method: 'Page.screencastFrameAck',
          params: {sessionId: message.params.sessionId}}));
        socket.send(JSON.stringify({id: 4, method: 'Page.stopScreencast'}));
        clearTimeout(timeout);
        resolve(bytes.length);
      });
    }).finally(() => { if (socket.readyState === WebSocket.OPEN) socket.close(); });
    return frame;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => bridge.close(resolve));
  }
}

const opened = await command('POST', '/session', {
  capabilities: {alwaysMatch: {
    browserName: 'chrome',
    'goog:chromeOptions': {
      binary: '/usr/bin/chromium',
      args: [
        '--headless=new', '--no-first-run',
        '--proxy-server=http://recorder-egress:37843',
        '--proxy-bypass-list=<-loopback>', '--disable-quic',
      ],
    },
  }},
});
const sessionId = opened.sessionId;
try {
  const base = `/session/${sessionId}`;
  await command('POST', `${base}/url`, {url: 'https://www.selenium.dev/selenium/web/web-form.html'});
  const title = await command('GET', `${base}/title`);
  const png = Buffer.from(await command('GET', `${base}/screenshot`), 'base64');
  if (title !== 'Web form' || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error('worker_navigation_result_invalid');
  const frameBytes = await screencastFrame(base);
  console.log(JSON.stringify({phase: 'service_to_worker_cdp_ready', title,
    screenshotBytes: png.length, screencastFrameBytes: frameBytes}));
} finally {
  await command('DELETE', `/session/${sessionId}`);
}
