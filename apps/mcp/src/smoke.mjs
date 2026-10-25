// Deterministic external-client smoke test. No model calls. Run against a started test server.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.RECORDER_URL;
const token = process.env.RECORDER_TOKEN;
if (!url || !token) throw new Error('RECORDER_URL and RECORDER_TOKEN required');
let client = new Client({ name: 'recorder-smoke', version: '1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
let id;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent ?? result;
}
async function enqueueAndWait(operation,args) {
  const queued=await call('queue_enqueue',{version:1,operation,requestId:randomUUID(),arguments:args});
  for(let i=0;i<120;i++) {
    const status=await call('queue_status',{jobId:queued.jobId});
    if(status.result?.id) return {jobId:queued.jobId,result:status.result};
    assert.ok(['queued','running'].includes(status.state),JSON.stringify(status));
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw new Error('queue_wait_timeout');
}
let sessionQueue;
try {
  const initialUsage=process.env.RECORDER_MODE==='hosted'?await call('account_usage',{}):undefined;
  const openArgs={url:'https://www.selenium.dev/selenium/web/web-form.html'};
  sessionQueue=process.env.QUEUE_SMOKE==='1'?await enqueueAndWait('session_open',openArgs):undefined;
  const opened=sessionQueue?.result ?? await call('session_open',{...openArgs,requestId:randomUUID()});
  id = opened.id;
  const observed = await call('browser_observe', { id });
  const textLine = observed.page.split('\n').find(line => line.includes('input:text'));
  assert.ok(textLine, 'text field visible');
  const ref = textLine.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, 'text field reference present');
  await call('recording_start', { id });
  if (process.env.NAVIGATION_SMOKE === '1') {
    const requestId = randomUUID();
    await call('navigation_start', { id, requestId,
      goal: 'Type Recorded by your agent into the Text input field. Do not click Submit or press Enter. Stop after filling the field.',
      maximumActions: 6 });
    let navigation;
    let testedStop = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      navigation = await call('navigation_status', { id, waitMs: 1000 });
      console.log(JSON.stringify({ navigation: navigation.status, actions: navigation.actions, costUsd: navigation.costUsd }));
      if (navigation.status === 'needs_input') {
        assert.equal(navigation.input.field.name, 'Text input');
        if (!testedStop) {
          const stopped = await call('navigation_stop', { id });
          assert.equal(stopped.status, 'stopped');
          const sameBrowser = await call('browser_observe', { id });
          assert.equal(sameBrowser.id, id);
          assert.equal(sameBrowser.status, 'recording');
          testedStop = true;
          console.log('Stopped Jev without closing the recording; resuming in the same browser.');
          await call('navigation_start', { id, requestId: randomUUID(),
            goal: 'Type Recorded by your agent into the Text input field. Do not click Submit or press Enter. Stop after filling the field.', maximumActions: 6 });
          continue;
        }
        await call('navigation_guide', { id, instruction: 'Fill this field only; do not submit.', inputId: navigation.input.inputId, value: 'Recorded by your agent' });
      } else if (navigation.status !== 'running') break;
    }
    assert.equal(navigation.status, 'done', JSON.stringify(navigation));
    const outcome = await call('browser_observe', { id });
    assert.ok(outcome.page.includes('Recorded by your agent'), 'Jev filled the field');
    assert.ok(outcome.url.includes('web-form.html'), 'no form submission');
    await call('mark_demo_moment', { id, kind: 'result', note: 'Client text entered by Jev', observationId: outcome.observationId });
    await call('browser_wait', { id, until: 'duration', ms: 3000 });
    console.log('Real Jev navigation and client-supplied field value passed.');
  } else {
  await call('browser_click', { id, ref });
  await call('browser_type', { id, ref, text: 'Recorded by your agent' });
  await call('browser_scroll', { id, direction: 'down', amount: 400 });
  await call('browser_scroll', { id, direction: 'up', amount: 400 });
  }
  await call('recording_stop', { id });
  if(sessionQueue) {
    for(let i=0;i<30;i++) {const status=await call('queue_status',{jobId:sessionQueue.jobId});if(status.state==='completed') break;await new Promise(resolve=>setTimeout(resolve,1000));}
    await enqueueAndWait('recording_render',{id,padding:40,background:'ocean'});
  } else await call('recording_render', { id, requestId:randomUUID(), padding: 40, background: 'ocean' });
  if (process.env.RECOVERY_SMOKE === '1') {
    assert.ok(process.send, 'Run recovery smoke through scripts/smoke-local.mjs');
    await client.close();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('restart_timeout')), 45000);
      process.once('message', message => { clearTimeout(timer); message?.type === 'restarted' ? resolve() : reject(new Error('restart_failed')); });
      process.send({ type: 'restart' });
    });
    client = new Client({ name: 'recorder-recovered', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const recovered = await call('recording_status', { id, waitMs: 0 });
    assert.ok(['captured', 'completed'].includes(recovered.status), JSON.stringify(recovered));
    console.log(JSON.stringify({ recovered: recovered.status, id, replayedBrowserActions: false }));
    if (recovered.status === 'captured') await call('recording_render', { id, padding: 40, background: 'ocean' });
  }
  let status;
  for (let attempt = 0; attempt < 300; attempt++) {
    status = await call('recording_status', { id });
    if (status.status !== 'rendering') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(status.status, 'completed', JSON.stringify(status));
  const links = await call('recording_links', { id });
  const response = await fetch(links.videoUrl);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 10_000);
  await writeFile(process.env.SMOKE_OUTPUT ?? '/tmp/agent-recorder-smoke.mp4', bytes);
  if(initialUsage) {const usage=await call('account_usage',{});assert.equal(usage.used,initialUsage.used+1);assert.equal(usage.reserved,0);assert.equal(usage.available,initialUsage.available-1);console.log(JSON.stringify({credits:usage}));}
  console.log(JSON.stringify({ id, durationMs: status.durationMs, bytes: bytes.length, output: process.env.SMOKE_OUTPUT ?? '/tmp/agent-recorder-smoke.mp4' }));
} finally {
  if (id) await call('session_close', { id }).catch(() => undefined);
  await client.close();
}
