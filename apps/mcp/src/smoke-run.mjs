// External MCP client: one recording_run drives open → record → Jev → stop → render → delivery check. Real browser, real Jev.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const url = process.env.RECORDER_URL, token = process.env.RECORDER_TOKEN;
if (!url || !token) throw new Error('RECORDER_URL and RECORDER_TOKEN required');
const client = new Client({ name: 'recorder-run-smoke', version: '1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? result;
}
// With an admin key, save a brand for the product domain first: the run must come back branded, with a GIF.
const adminKey = process.env.RECORDER_ADMIN_KEY, owner = process.env.RECORDER_OWNER;
let branded = false;
if (adminKey && owner) {
  const png = process.env.RUN_SMOKE_LOGO ? await import('node:fs/promises').then(fs => fs.readFile(process.env.RUN_SMOKE_LOGO)) : undefined;
  const brand = { accent: '#ff8800', padding: 30, radius: 12, gif: true, width: 1280, ...(png ? { logo: 'data:image/png;base64,' + png.toString('base64'), cards: true, logoPosition: 'bottom-right' } : {}) };
  const saved = await fetch(new URL(`/admin/brands?owner=${owner}`, url), { method: 'POST', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'https://www.selenium.dev', brand }) });
  assert.equal(saved.status, 200, 'brand saved: ' + await saved.text());
  branded = true;
}
const requestId = randomUUID();
// The plan an agent writes before asking Toru; recording_run refuses calls without one.
const plan = { steps: [{ screen: 'Web form', action: 'type', target: 'field "Text input"', value: 'Recorded by your agent', expect: 'The text appears in the Text input field' }],
  finalState: 'The Text input field shows "Recorded by your agent"', avoid: ['Do not click Submit or press Enter'] };
const started = await call('recording_run', { plan, requestId, url: 'https://www.selenium.dev/selenium/web/web-form.html',
  goal: 'Type Recorded by your agent into the Text input field. Do not click Submit or press Enter. Stop after filling the field.', maximumActions: 10,
  values: { 'Text input': 'Recorded by your agent' } });
assert.equal(started.status, 'planning');
assert.deepEqual(await call('recording_run', { plan, requestId, url: 'https://www.selenium.dev/selenium/web/web-form.html',
  goal: 'Type Recorded by your agent into the Text input field. Do not click Submit or press Enter. Stop after filling the field.', maximumActions: 10,
  values: { 'Text input': 'Recorded by your agent' } }).then(r => r.runId), started.runId, 'same requestId returns the same run');
await assert.rejects(call('recording_run', { plan, requestId: randomUUID(), url: 'https://example.com', goal: 'Another one' }), /run_in_progress/);
let run, seen = new Set();
for (let attempt = 0; attempt < 60; attempt++) {
  run = await call('recording_run_status', { runId: started.runId, waitMs: 25000 });
  if (!seen.has(run.status)) { seen.add(run.status); console.log(JSON.stringify({ run: run.status, actions: run.actions, costUsd: run.costUsd, reason: run.reason })); }
  if (run.status === 'needs_input') { await call('navigation_guide', { id: run.sessionId, instruction: 'Use the given value.', inputId: run.input.inputId, value: 'Recorded by your agent' }); continue; }
  if (!['planning', 'navigating', 'recording', 'rendering'].includes(run.status)) break;
}
console.log(JSON.stringify({ final: run.status, sessionId: run.sessionId, stages: run.stages, qualityReasons: run.qualityReasons, reason: run.reason }));
assert.ok(['done', 'needs_review'].includes(run.status), `run ended ${run.status}: ${run.reason}`);
for (const stage of ['planning', 'navigating', 'recording', 'rendering']) assert.ok(run.stages[stage], `stage ${stage} recorded: ${JSON.stringify(run.stages)}`);
if (run.status === 'done') {
  const links = await call('recording_links', { id: run.sessionId });
  for (const key of ['videoUrl', 'rawUrl', 'planUrl', 'eventsUrl', ...(branded ? ['gifUrl'] : [])]) {
    assert.ok(links[key], `${key} present`);
    const response = await fetch(links[key]);
    assert.equal(response.status, 200, `${key} downloadable`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.length > 0, `${key} non-empty`);
    if (key === 'planUrl') assert.equal(JSON.parse(body.toString()).runId, started.runId);
    if (key === 'eventsUrl') assert.ok(body.toString().includes('"delivered"'), 'event log ends with delivered');
    if (key === 'videoUrl' && process.env.RUN_SMOKE_OUTPUT) await writeFile(process.env.RUN_SMOKE_OUTPUT, body);
    if (key === 'gifUrl') { assert.equal(body.subarray(0, 6).toString(), 'GIF89a'); if (process.env.RUN_SMOKE_OUTPUT) await writeFile(process.env.RUN_SMOKE_OUTPUT.replace(/\.mp4$/, '.gif'), body); }
  }
  if (branded) { const status = await call('recording_status', { id: run.sessionId }); console.log(JSON.stringify({ branding: status.branding })); assert.equal(status.branding?.brand, true); assert.equal(status.branding?.gif, true); }
  if (adminKey && owner) {
    // The console reads the same run back: list with session state and links, detail with goal and events.
    const listed = await (await fetch(new URL(`/admin/runs?owner=${owner}`, url), { headers: { authorization: `Bearer ${adminKey}` } })).json();
    const mine = listed.runs.find(item => item.runId === started.runId);
    assert.ok(mine, 'run listed for the console');
    assert.equal(mine.status, 'done'); assert.equal(mine.session.status, 'completed'); assert.ok(mine.videoUrl && mine.gifUrl, 'console links signed');
    assert.ok(mine.title.startsWith('Type Recorded by your agent'), mine.title);
    const detail = (await (await fetch(new URL(`/admin/runs/${started.runId}?owner=${owner}`, url), { headers: { authorization: `Bearer ${adminKey}` } })).json()).run;
    assert.ok(detail.goal.includes('Text input field')); assert.ok(detail.events.some(event => event.event === 'delivered'));
    console.log(JSON.stringify({ console: { title: mine.title, status: mine.status, session: mine.session.status, events: detail.events.length } }));
  }
  const usage = await call('account_usage', {});
  console.log(JSON.stringify({ usage }));
  console.log('PASS: one recording_run produced a checked, delivered MP4 with raw, plan and event artifacts');
} else {
  const status = await call('recording_status', { id: run.sessionId });
  assert.equal(status.needsReview, true);
  console.log('PASS (needs_review): the run finished and the delivery check held the video back without charging: ' + run.qualityReasons.join(','));
}
await client.close();
