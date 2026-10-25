// Release probe for the real Railway SDK media path. A project-scoped
// RAILWAY_TOKEN is preferred; an existing RAILWAY_API_TOKEN works for local
// verification. RAILWAY_ENVIRONMENT_ID is always required. No token is logged.
import {randomUUID, createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Sandbox} from 'railway';
import {buildExporterConfig} from '../../../packages/render-contract/dist/index.js';
import {createRailwayRenderer} from '../dist/railway-render.js';
import {createSandboxJournal} from '../dist/sandbox-journal.js';

const run = promisify(execFile);
const [checkpoint, image] = process.argv.slice(2);
if (!(process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN) || !process.env.RAILWAY_ENVIRONMENT_ID)
  throw new Error('railway_token_and_environment_required');
if (!/^[A-Za-z0-9_.-]{1,80}$/.test(checkpoint ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(image ?? ''))
  throw new Error('usage: probe-railway-render CHECKPOINT IMAGE_SHA256');

const directory = await mkdtemp(join(tmpdir(), 'recorder-railway-render-probe-'));
const journal = createSandboxJournal(join(directory, 'sandbox-ids.json'));
try {
  const source = join(directory, 'synthetic.webm');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=duration=2:size=1280x720:rate=30', '-an', '-c:v', 'libvpx-vp9',
    '-b:v', '1M', '-y', source], {timeout: 30_000});
  const config = buildExporterConfig({width: 1280, height: 720, frameRate: 30,
    durationMs: 2000, pointerTrail: [], pointerTelemetry: []},
    {wallpaper: '#102035', padding: 20, borderRadius: 12});
  const render = createRailwayRenderer({checkpoint, image, journal,
    createSandbox: async () => {
      const sandbox = await Sandbox.create(checkpoint, {networkIsolation: 'ISOLATED', idleTimeoutMinutes: 15});
      console.log(JSON.stringify({phase: 'sandbox_created', id: sandbox.id}));
      return {id: sandbox.id, files: sandbox.files,
        exec: async (command, options) => {
          const result = await sandbox.exec(command, options);
          console.log(JSON.stringify({phase: command.startsWith('install ') ? 'media_directory' : 'render_command',
            exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated}));
          return result;
        },
        destroy: () => sandbox.destroy()};
    },
  });
  const bytes = await render(source, config, new AbortController().signal);
  if (bytes.length < 10_000 || bytes.toString('ascii', 4, 8) !== 'ftyp')
    throw new Error('railway_render_invalid_mp4');
  const output = join(directory, `${randomUUID()}.mp4`);
  await writeFile(output, bytes, {mode: 0o600});
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', output], {timeout: 30_000});
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 1.9 || seconds > 2.1)
    throw new Error('railway_render_duration_invalid');
  console.log(JSON.stringify({phase: 'railway_sdk_render_ready', bytes: bytes.length,
    seconds, sha256: createHash('sha256').update(bytes).digest('hex')}));
} finally {
  // Recovery retains the journal directory if the provider cannot destroy a VM.
  await journal.recover();
  await rm(directory, {recursive: true, force: true});
}
