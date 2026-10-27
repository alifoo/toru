import { sameProductSite } from "./product-origin.js";
import { openAfterSignIn, signedInPage } from './sign-in-landing.js';
import { DesktopUploadStore } from './store/desktop-uploads.js';
import { DesktopDeviceStore } from './store/desktop-devices.js';
import { assessDemo, type QualityAssessor, type QualityVerdict } from './quality.js';
import { operationalSnapshot } from './metrics.js';
import {eraseAccountDataInStore} from './store/erasure.js';
import { DurableScheduler, type QueueEntry, type QueueLease } from './scheduler.js';
import type { AuthorizationCheck } from './lifecycle.js';
import type { LifecycleFactory, RecorderLifecycle, RecordingPolicy } from './lifecycle.js';
import { openRecorderStore } from './store/open.js';
import {pruneSessionImports} from './store/retention.js';
import { exclusiveProcessLock } from './store/lock.js';
import type { RecorderDatabase } from './store/database.js';
import { OperationalUsage } from './store/usage.js';
import { activateOperationalPolicy, deploymentIdentityFromEnvironment, type DeploymentIdentity } from './policies.js';
import { defaultDailyLimits, validateDailyLimits, type DailyLimits } from './policies.js';
export type { DailyLimits } from './policies.js';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, rm, statfs, open, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  assertStorageStateAllowed, BrowserStorageStateSchema, isLocalDevelopmentUrl, normalizeAllowedOrigin, sameLocalHost, storageStateForAllowedOrigins, WebDriverProtocolError,
  type BrowserContextDriver, type BrowserContextOptions, type CaptureSemanticAction,
} from '@content-layer/browser';
import type { BrowserRefDriver } from '@content-layer/browser';
import { backgroundCatalog, buildExporterConfig, pointerIdleRanges, redactionIntervals, type CaptureLayers, type CaptureObservation, type IdentitySighting } from '@content-layer/render-contract';
import { detectStillRanges } from './stills.js';
import { viewportOf } from './viewport.js';
import { DemoAccountStore, demoOrigin } from './store/demo-accounts.js';
import { BrandStore, type Brand } from './store/brands.js';
import type { DesktopWindow } from './desktop-window.js';
import { applyBrand, brandWallpaper, makeGif, redactRegions } from './branding.js';
import { renderTimeline } from './studio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RenderProgress } from '@content-layer/render-host';

export type Driver = BrowserContextDriver & BrowserRefDriver & {
  semanticTimeline?(): CaptureSemanticAction[];
  /** Where the recorded Mac window showed who the user is (their account name and picture), read by read. */
  identitySightings?(): IdentitySighting[];
  markDemoMoment?(kind: 'setup' | 'action' | 'result', note: string, focus?: CaptureSemanticAction['focus'], observedAtMs?: number): void;
  capturePrivacy?: 'user-approved-desktop';
  captureViewport?: {width:number;height:number};
  /** The raw video's frame size when it differs from captureViewport: a capture at a device scale (Toru for Chrome records 1920x1080 as 2560x1440). */
  captureSize?: {width:number;height:number};
  /** A Mac capture of the window with a margin: where the window and its menus were inside it, over time. */
  contentLayers?: CaptureLayers;
  /** Toru for Mac: the shared window's size for the recording (windowSize preset) and whether it was resized and put back. */
  desktopWindow?: DesktopWindow;
  recordingMode?: 'screencast' | 'poll' | null;
  recordingStartedAtMs?: number | null;
  recordingDurationMs?: number;
  connectWithCredentials(username: string, password: string | undefined, signal: AbortSignal, targetUrl?: string): Promise<void>;
  /** Finishes a sign-in paused at a one-time code or magic link. */
  completeLoginChallenge?(input: { code?: string; link?: string }, signal: AbortSignal): Promise<void>;
};
type Job = {
  id: string; owner: string; status: 'ready' | 'recording' | 'captured' | 'rendering' | 'completed' | 'interrupted' | 'closed';
  createdAt: number; expiresAt: number; allowedOrigins: string[];
  /**
   * Recording in the user's own Chrome: the demo may visit any public https site, not only allowedOrigins.
   * A development server on the user's machine (localhost, *.test…) stays limited to the allowed origins.
   */
  anySite?: boolean;
  desktopDeviceId?:string; rawFile?: 'raw.webm'|'raw.mp4'; privacyMode?:'user-approved-unredacted';
  desktopRecoveryPending?:boolean;
  /** Toru for Mac: what the recording did with the shared window's size (see DesktopWindow). */
  desktopWindow?: DesktopWindow;
  /** Result of the delivery quality check on the last render; a failed check leaves the job unbilled and undelivered. */
  qualityReview?: QualityVerdict & { at: number; accepted?: boolean };
  /** What the last render added on top of the exporter output. */
  branding?: { applied: string[]; brand?: boolean; gif: boolean; gifError?: string };
  durationMs?: number; errorCode?: string; policy?:RecordingPolicy; rawExpiresAt?:number; requestId?:string; inputHash?:string; renderRequestId?:string;
  artifact?:{id:string;sha256:string;bytes:number}; pendingArtifact?:{id:string;sha256:string;bytes:number};
  connection?: { status: 'waiting' | 'verifying' | 'awaiting_code' | 'ready' | 'failed'; importId?: string; errorCode?: string; submittedAt?: number; targetUrl?: string; blockedOrigin?: string; signedInUrl?: string; retryId?: string; retryCount?: number; emailOnly?: boolean; demoAccount?: boolean; verificationAttempts?: number };
};
type Active = {
  job: Job; driver: Driver; openedAt: number; lastActivity: number; startedAt?: number; busy: boolean;
  inFlight?: Promise<CallToolResult>; finishRequested?: boolean; disposed?: boolean;
  closeRequested?: boolean; finishPromise?: Promise<void>; deadlineTimer?: ReturnType<typeof setTimeout>;
  finishGraceTimer?: ReturnType<typeof setTimeout>;
  connectionTask?: Promise<void>;
  connectionAbort?: AbortController;
  idleSince?: number;
  idleRanges?: CaptureObservation['idleRanges'];
  observations?: Map<string, number>;
  pageSignature?: string;
  waitRanges?: CaptureObservation['idleRanges'];
};
const limits = {
  session: 20 * 60_000, idle: 3 * 60_000, recording: 5 * 60_000,
  render: 10 * 60_000, retention: 24 * 60 * 60_000,
  storage: 2 * 1024 ** 3, artifact: 256 * 1024 ** 2, imports: 100,
};
const uuid = z.uuid();
/** The space every pointer, zoom and redaction coordinate of a capture is in: its viewport, in CSS pixels. */
function observationViewport(driver: Pick<Driver, 'captureViewport'>) {
  return { width: driver.captureViewport?.width ?? 1920, height: driver.captureViewport?.height ?? 1080 };
}
/**
 * The raw video's frame size, recorded when it is denser than the viewport (a capture at a device scale) so the
 * render knows how many video pixels a CSS pixel is. Only the same picture counts: the same aspect, between 1x and 3x.
 */
/** A PNG's pixel width, from its header. */
function pngWidth(body: Uint8Array): number | undefined {
  if (body.byteLength < 24 || body[1] !== 0x50 || body[2] !== 0x4e || body[3] !== 0x47) return undefined;
  return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16);
}
/** Output width when neither the request nor the brand sets one. */
export const DEFAULT_RENDER_WIDTH = 1920;

export function videoSize(viewport: { width: number; height: number }, size: { width: number; height: number } | undefined): { videoWidth?: number; videoHeight?: number } {
  if (!size || size.width === viewport.width && size.height === viewport.height) return {};
  // Down to 2/3: a 1920x1080 viewport an encoder could only record at 1280x720, its smallest step.
  const scale = size.width / viewport.width;
  if (!(scale >= 0.6 && scale <= 3) || Math.abs(size.height / viewport.height - scale) > 0.02) return {};
  return { videoWidth: size.width, videoHeight: size.height };
}
const backgrounds = {
  midnight: 'linear-gradient(135deg, #131725 0%, #344260 100%)',
  ocean: 'linear-gradient(135deg, #083344 0%, #0e7490 50%, #a5f3fc 100%)',
  sunset: 'linear-gradient(135deg, #312e81 0%, #be185d 55%, #fed7aa 100%)',
};
const reply = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
});

export type RecorderOptions = {
  dataDir: string; encryptionKey: Buffer;
  dailyLimits?: Partial<DailyLimits>;
  deployment?: DeploymentIdentity;
  lifecycle?: LifecycleFactory;
  createContext(options: BrowserContextOptions): Promise<Driver>;
  createLocalContext?(owner:string, connectionId:string, options:BrowserContextOptions & {captureId?:string}):Promise<Driver>;
  render(sourcePath: string, config: Record<string, unknown>, signal: AbortSignal, onProgress: (progress: RenderProgress) => void): Promise<Buffer>;
  /** Delivery quality check; defaults to the ffmpeg-based assessor. */
  assessQuality?: QualityAssessor;
  /** Test seams for the ffmpeg post-processing. */
  applyBrand?: typeof applyBrand;
  makeGif?: typeof makeGif;
  redactRegions?: typeof redactRegions;
  detectStills?: typeof detectStillRanges;
};

/** One heavy task at a time; reservations persist before resource allocation, including failures. */
export class Recorder {
  private active: Active | undefined;
  private rendering: { id: string; controller: AbortController; done: Promise<void>; startedAt: number; progress?: RenderProgress; progressedAt?: number } | undefined;
  private opening = false;
  private closing = false;
  private deleting = false;
  private deletionDone?:Promise<unknown>;
  private desktopPublications=new Map<string,Promise<Record<string,unknown>>>();
  private importsBusy = false;
  /** Imports a sign-in just produced: the first session that uses one continues that sign-in's browser start. */
  private signInImports = new Map<string, string>();
  /** The last signed-in state per owner and saved login. Reusing it avoids a fresh sign-in (and the product's new-device code) on every run. */
  private savedLoginImports?: Map<string, string>;
  /** Survives restarts: a deploy must not turn the next run into a fresh sign-in. Only ids are stored; the state stays in its encrypted import. */
  private async savedLogins(): Promise<Map<string, string>> {
    if (!this.savedLoginImports) {
      const raw = await readFile(join(this.options.dataDir, 'saved-login-imports.json'), 'utf8').catch(() => '{}');
      let parsed: unknown = {};
      try { parsed = JSON.parse(raw); } catch { /* start empty */ }
      this.savedLoginImports = new Map(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && uuid.safeParse(entry[1]).success));
    }
    return this.savedLoginImports;
  }
  private async rememberSavedLogin(key: string, importId: string | undefined) {
    const saved = await this.savedLogins();
    if (importId) saved.set(key, importId); else saved.delete(key);
    await this.atomic(join(this.options.dataDir, 'saved-login-imports.json'), Object.fromEntries(saved));
  }
  private store!: RecorderDatabase;
  demoAccounts!: DemoAccountStore;
  brands!: BrandStore;
  private usage!: OperationalUsage;
  private lifecycle: RecorderLifecycle|undefined;
  private scheduler!:DurableScheduler;
  private readonly queueWorker=randomUUID();
  private queueWork:{entry:QueueEntry;lease:QueueLease;recordingId?:string;leaseLost?:boolean}|undefined;
  private queuePump:Promise<void>|undefined;
  private queueEnabled=true;
  private releaseStoreLock?: () => void;
  private maintenance: ReturnType<typeof setInterval> | undefined;
  private lastLifecycleMaintenanceAt: number | undefined;
  private lastCleanupSucceededAt=0;
  private lastCleanupFailedAt:number|null=null;
  private lastCleanupFailureLogAt=0;
  private openingDone?: Promise<void>;

  constructor(private readonly options: RecorderOptions) {
    if (options.encryptionKey.length !== 32) throw new Error('invalid_encryption_key');
    validateDailyLimits(options.dailyLimits);
  }
  private path(id: string, name: string) { return join(this.options.dataDir, 'jobs', uuid.parse(id), name); }
  private async publishFile(path:string,body:string|Uint8Array) {
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle=await open(temp,'wx',0o600);
    try {await handle.writeFile(body);await handle.sync();} finally {await handle.close();}
    await rename(temp,path);
    const directory=await open(join(path,'..'),'r');try {await directory.sync();} finally {await directory.close();}
  }
  private async atomic(path:string,value:unknown) {await this.publishFile(path,JSON.stringify(value));}
  private async save(job: Job, effect?:()=>void) {
    this.store.transaction(() => {
      const sql = this.store.connection;
      sql.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?) ON CONFLICT(owner) DO NOTHING').run(job.owner,job.createdAt);
      effect?.();
      const existing = sql.prepare('SELECT owner FROM jobs WHERE id=?').get(job.id);
      if(existing && existing.owner !== job.owner) throw new Error('recording_owner_conflict');
      sql.prepare(`INSERT INTO jobs(id,owner,status,created_at,expires_at,metadata) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,expires_at=excluded.expires_at,metadata=excluded.metadata`)
        .run(job.id,job.owner,job.status,job.createdAt,job.expiresAt,JSON.stringify(job));
      if(job.status==='recording')this.lifecycle?.recordingStarted?.(job);
      if(job.status==='captured')this.lifecycle?.captureFinalized?.(job);
      if(job.renderRequestId && !job.pendingArtifact && ['completed','captured','interrupted'].includes(job.status)) {
        const result={...this.status(job),requestId:job.renderRequestId};
        sql.prepare("UPDATE operation_requests SET state=?,result=? WHERE owner=? AND operation='recording_render' AND request_id=? AND state='accepted'")
          .run(job.status==='completed'?'completed':'failed',JSON.stringify(result),job.owner,job.renderRequestId);
      }
    });
  }
  private storedJobs():Job[] {
    return this.store.connection.prepare('SELECT metadata FROM jobs').all().map(row => JSON.parse(String(row.metadata)) as Job);
  }
  private async admit() {
    if(this.deleting)throw new Error('service_draining');
    if (this.closing) throw new Error('service_draining');
    try { await stat(join(this.options.dataDir, 'paused')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {if(this.deleting||this.closing)throw new Error('service_draining');return;} throw error; }
    throw new Error('admissions_paused');
  }
  private async owned(owner: string, id: string): Promise<Job> {
    uuid.parse(owner);
    let job: Job;
    try { uuid.parse(id); job = JSON.parse(String(this.store.connection.prepare('SELECT metadata FROM jobs WHERE id=? AND owner=?').get(id,owner)?.metadata)) as Job; }
    catch { throw new Error('recording_not_found'); }
    if (job.owner !== owner || job.expiresAt <= Date.now()) throw new Error('recording_not_found');
    return job;
  }
  async initialize(options:{deferQueue?:boolean}={}) {
    if(this.releaseStoreLock) throw new Error('recorder_already_initialized');
    this.releaseStoreLock = exclusiveProcessLock(join(this.options.dataDir,'.runtime-lock.sqlite'));
    try {
    this.store = await openRecorderStore(this.options.dataDir);
    this.demoAccounts = new DemoAccountStore(this.store, this.options.encryptionKey);
    this.brands = new BrandStore(this.store);
    this.usage = new OperationalUsage(this.store);
    this.scheduler=new DurableScheduler(this.store);
    this.queueEnabled=!options.deferQueue;
    this.lifecycle = this.options.lifecycle?.(this.store);
    this.closing = false;
    activateOperationalPolicy(this.store,validateDailyLimits(this.options.dailyLimits),this.options.deployment ?? deploymentIdentityFromEnvironment({}));
    await mkdir(join(this.options.dataDir, 'jobs'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.options.dataDir, 'imports'), { recursive: true, mode: 0o700 });
    for (const job of this.storedJobs()) {
      if(job.policy && !this.lifecycle) throw new Error('recording_policy_adapter_required');
      if(job.pendingArtifact) {
        const pending=job.pendingArtifact;
        const bytes=await readFile(this.path(job.id,'video.mp4')).catch(()=>undefined);
        if(bytes && bytes.length===pending.bytes && createHash('sha256').update(bytes).digest('hex')===pending.sha256) {
          if(!job.artifact) job.expiresAt=Date.now()+(job.policy?.videoRetentionMs ?? limits.retention);
          job.artifact=pending;delete job.pendingArtifact;job.status='completed';
          await this.save(job,()=>this.lifecycle?.delivered(job,pending.id));
        } else {delete job.pendingArtifact;await this.save(job);}
      }
      if (['ready', 'recording', 'rendering'].includes(job.status) || (job.connection && ['waiting', 'verifying', 'awaiting_code'].includes(job.connection.status))) {
        job.status = 'interrupted'; job.errorCode = 'server_restarted';
        // Never replay browser actions. Only an already finalized capture is recoverable.
        if (await this.hasCapture(job.id)) job.status = 'captured';
        if (job.connection && job.connection.status !== 'ready') job.connection = { ...job.connection, status: 'failed', errorCode: 'server_restarted' };
        await this.save(job,()=>this.lifecycle?.abandon(job));
      } else if (job.status === 'captured') {
        // Captures from before credits were released at session end still hold theirs until expiry.
        try { this.store.transaction(()=>this.lifecycle?.abandon(job)); }
        catch (error) { console.error(JSON.stringify({ event: 'credit_release_failed', job: job.id, error: error instanceof Error ? error.message : 'unknown' })); }
      }
    }
    // This runtime holds the exclusive process lock; no previous recorder may still own a lease.
    this.store.connection.prepare("UPDATE queue_entries SET lease_until=? WHERE state='running'").run(Date.now());
    this.scheduler.reconcile(Date.now(),()=>true);
    await this.cleanup();
    this.maintenance = setInterval(() => {
      if(this.deleting)return;
      if(this.queueWork && !this.scheduler.heartbeat(this.queueWork.lease)) this.queueWork.leaseLost=true;
      void this.expire().catch(()=>undefined);
      this.kickQueue();
    }, 1_000);
    this.kickQueue();
    this.maintenance.unref();
    } catch(error) {this.store?.close();this.releaseStoreLock?.();delete this.releaseStoreLock;throw error;}
  }
  /** Start queued work only after its browser/render runtime is ready. */
  activateQueue(){
    if(!this.releaseStoreLock||this.closing)throw new Error('recorder_not_ready');
    this.queueEnabled=true;this.kickQueue();
  }
  private async hasCapture(id: string): Promise<boolean> {
    try {
      const metadata=this.store.connection.prepare('SELECT metadata FROM jobs WHERE id=?').get(id)?.metadata;
      if(metadata && Number((JSON.parse(String(metadata)) as Job).rawExpiresAt ?? Infinity)<=Date.now()) return false;
      const stored=metadata ? JSON.parse(String(metadata)) as Job : undefined;
      if(stored?.desktopRecoveryPending)return false;
      const raw = await stat(this.path(id, stored?.rawFile==='raw.mp4'?'raw.mp4':'raw.webm'));
      const observation = JSON.parse(await readFile(this.path(id, 'observation.json'), 'utf8')) as CaptureObservation;
      return raw.isFile() && raw.size > 0 && raw.size <= limits.artifact && Number.isFinite(observation.durationMs) && observation.durationMs >= 0;
    } catch { return false; }
  }
  private async reserve(owner: string, kind: 'browserMs' | 'renderMs', amount: number, jobId:string, countStart=true) {
    return this.usage.reserve(owner,kind,amount,{...defaultDailyLimits,...this.options.dailyLimits},Date.now(),jobId,countStart);
  }
  private async settle(reservation: string, elapsed: number) {
    this.usage.settle(reservation,Math.max(0,Math.ceil(elapsed)));
  }
  private browserReservation: Awaited<ReturnType<Recorder['reserve']>> | undefined;
  private async storageAvailable() {
    let bytes = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          // Transient files (SQLite journals, atomic temp files) may vanish between readdir and stat.
          try { bytes += (await stat(path)).size; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    };
    await walk(this.options.dataDir);
    const disk = await statfs(this.options.dataDir);
    // Reserve room for raw, output and renderer temporary bytes, before accepting heavy work.
    if (bytes + 3 * limits.artifact > limits.storage || disk.bavail * disk.bsize < 3 * limits.artifact) {
      throw new Error('storage_capacity_reached');
    }
  }
  /**
   * Public https origins only, unless the session runs in the user's own Chrome (localDevelopment): there a
   * development server on the user's machine is theirs, not ours, and no Toru server or hosted browser fetches it.
   */
  private origins(raw: string[], localDevelopment = false): string[] {
    return [...new Set(z.array(z.string()).min(1).max(12).parse(raw).map(value => {
      const url = new URL(value);
      if (isLocalDevelopmentUrl(value)) {
        if (localDevelopment) return normalizeAllowedOrigin(value);
        throw new Error('public_https_url_required');
      }
      if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
        throw new Error('public_https_url_required');
      }
      return normalizeAllowedOrigin(value);
    }))];
  }
  private validateUrl(raw: string, allowed: string[], anySite = false) {
    if (anySite && isLocalDevelopmentUrl(raw)) {
      // A development server: only the local hosts the session was opened with (any port, so an app on :3000 can
      // sign in through :3001). Following a link never adds one, so a public-site session can't reach localhost.
      const origin = normalizeAllowedOrigin(new URL(raw).origin);
      if (!allowed.some((candidate) => sameLocalHost(candidate, origin))) throw new Error(`origin_not_allowed:${origin}`);
      return;
    }
    const origin = this.origins([raw])[0];
    if (!origin) throw new Error('origin_not_allowed:unknown');
    // The user's own Chrome reaches the sites the user can reach; the extension still stops at sign-in fields.
    if (anySite) return;
    if (!allowed.includes(origin)) {
      // Only the product's own site expands automatically. Explicitly allowed
      // external identity providers do not become anchors for further expansion.
      if (allowed[0] && allowed.length < 12 && sameProductSite(origin,allowed[0])) allowed.push(origin);
      else throw new Error(`origin_not_allowed:${origin}`);
    }
  }
  async importSession(owner: string, raw: unknown, allowedOrigins: string[]) {
    uuid.parse(owner);
    if (this.importsBusy) throw new Error('capacity_busy');
    this.importsBusy = true;
    try {
      await this.admit();
      if(this.store.connection.prepare("SELECT 1 FROM accounts WHERE owner=? AND admission_status='deleted'").get(owner))throw new Error('account_not_admitted');
      await this.cleanup(); await this.storageAvailable();
      const imports = (await readdir(join(this.options.dataDir, 'imports')))
        .filter(name => name.endsWith('.json') && uuid.safeParse(name.slice(0, -5)).success);
      if (imports.length >= limits.imports) throw new Error('import_capacity_reached');
      const origins = this.origins(allowedOrigins);
      const state = assertStorageStateAllowed(BrowserStorageStateSchema.parse(raw), origins);
      const plain = Buffer.from(JSON.stringify(state));
      if (plain.length > 1024 * 1024) throw new Error('session_state_too_large');
      const id = randomUUID(), iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.options.encryptionKey, iv);
      cipher.setAAD(Buffer.from(`${owner}:${id}`));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); plain.fill(0);
      const importPath = join(this.options.dataDir, 'imports', `${id}.json`);
      const expiresAt = Date.now() + limits.retention;
      await this.atomic(importPath, {
        owner, origins, expiresAt,
        iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64'),
      });
      const checksum = createHash('sha256').update(await readFile(importPath)).digest('hex');
      this.store.transaction(() => {
        this.store.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?) ON CONFLICT(owner) DO NOTHING').run(owner,Date.now());
        this.store.connection.prepare('INSERT INTO session_imports(id,owner,expires_at,checksum,relative_path) VALUES (?,?,?,?,?)').run(id,owner,expiresAt,checksum,`imports/${id}.json`);
      });
      return { id };
    } finally { this.importsBusy = false; }
  }
  private async readImport(owner: string, id: string) {
    const path = join(this.options.dataDir, 'imports', `${uuid.parse(id)}.json`);
    const reference = this.store.connection.prepare('SELECT * FROM session_imports WHERE id=? AND owner=?').get(id,owner);
    if(!reference) throw new Error('session_import_not_found');
    if(Number(reference.expires_at) <= Date.now()) throw new Error('session_import_expired');
    let saved, contents:string;
    try { contents = await readFile(path,'utf8'); saved = JSON.parse(contents); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('session_import_not_found'); throw error; }
    if (saved.owner !== owner) throw new Error('session_import_not_found');
    if(createHash('sha256').update(contents).digest('hex') !== reference.checksum) throw new Error('session_import_invalid');
    if (saved.expiresAt <= Date.now()) throw new Error('session_import_expired');
    return saved;
  }
  private async sessionState(owner: string, id: string | undefined, requestedOrigins: string[] | undefined, targetOrigin: string, localDevelopment = false) {
    if (!id) return { state: Buffer.from(JSON.stringify({ cookies: [], origins: [] })), origins: this.origins([targetOrigin, ...(requestedOrigins ?? [])], localDevelopment) };
    const saved = await this.readImport(owner, id);
    // Inherit only this owner's saved grant. An explicit list may narrow it; never auto-trust redirects.
    const origins = this.origins([targetOrigin, ...(requestedOrigins ?? saved.origins)]);
    const decipher = createDecipheriv('aes-256-gcm', this.options.encryptionKey, Buffer.from(saved.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${owner}:${id}`)); decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    let plain: Buffer;
    try { plain = Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]); }
    catch { throw new Error('session_import_invalid'); }
    try { return { state: Buffer.from(JSON.stringify(storageStateForAllowedOrigins(JSON.parse(plain.toString()), origins))), origins }; }
    finally { plain.fill(0); }
  }

  /**
   * A recording started by the user in the Mac app, without an agent session. It is admitted exactly like an
   * agent-opened desktop capture (same account checks, same credit reservation) and waits for the device's upload;
   * publication reuses recoverDesktopUpload, so render/credit behavior is identical afterwards.
   */
  async beginManualDesktopCapture(owner:string,deviceId:string,requestId:string):Promise<Record<string,unknown>> {
    uuid.parse(owner);uuid.parse(deviceId);uuid.parse(requestId);
    await this.admit();
    if(this.deleting||this.closing)throw new Error('service_draining');
    const inputHash=createHash('sha256').update(JSON.stringify({manualDesktop:deviceId})).digest('hex');
    const receipt=this.store.connection.prepare('SELECT job_id,input_hash FROM operation_requests WHERE owner=? AND operation=? AND request_id=?').get(owner,'desktop_capture',requestId);
    if(receipt){
      if(receipt.input_hash!==inputHash)throw new Error('request_id_conflict');
      return this.status(await this.owned(owner,String(receipt.job_id)));
    }
    const device=new DesktopDeviceStore(this.store).list(owner).find(item=>item.id===deviceId);
    if(!device||device.revoked)throw new Error('desktop_device_not_found');
    await this.cleanup();await this.storageAvailable();
    const createdAt=Date.now();
    const job:Job={id:randomUUID(),owner,status:'interrupted',errorCode:'desktop_upload_pending',createdAt,expiresAt:createdAt+limits.retention,allowedOrigins:[],
      requestId,inputHash,desktopDeviceId:deviceId,rawFile:'raw.mp4',privacyMode:'user-approved-unredacted'};
    await this.save(job,()=>{
      this.store.connection.prepare('INSERT INTO operation_requests(owner,operation,request_id,input_hash,job_id,created_at) VALUES (?,?,?,?,?,?)').run(owner,'desktop_capture',requestId,inputHash,job.id,createdAt);
      if(this.lifecycle) job.policy=this.lifecycle.admit(job,requestId,inputHash);
    });
    await mkdir(this.path(job.id,''),{recursive:true,mode:0o700});
    return this.status(job);
  }
  /** Publish only a finalized upload from the device originally approved for this capture. */
  async recoverDesktopUpload(owner:string,deviceId:string,id:string):Promise<Record<string,unknown>> {
    if(this.closing||this.deleting)throw new Error('service_draining');
    const uploads=new DesktopUploadStore(this.store,this.options.dataDir);
    const receipt=uploads.status(owner,deviceId,id);
    if(!receipt.complete)throw new Error('desktop_upload_incomplete');
    if(!receipt.media)throw new Error('desktop_upload_metadata_required');
    const pending=this.desktopPublications.get(id);if(pending)return pending;
    const work=(async()=>{
      const job=await this.owned(owner,id);
      // Live Stop owns finalization; recovery must not race it or bypass fresh capture consent.
      if(this.active?.job.id===id)throw new Error('recording_in_progress');
      if(['captured','rendering','completed'].includes(job.status))return this.status(job);
      if(job.status!=='interrupted')throw new Error('desktop_recovery_not_allowed');
      const check=()=>{
        if(this.closing||this.deleting)throw new Error('service_draining');
        uploads.status(owner,deviceId,id);
      };
      check();
      const media=receipt.media!;
      job.rawFile='raw.mp4';job.durationMs=media.durationMs;
      job.desktopRecoveryPending=true;
      // Persist before writing media: startup can recover a crash after observation publication.
      job.rawExpiresAt??=Math.min(job.expiresAt,Date.now()+(job.policy?.rawRetentionMs??limits.retention));
      await this.save(job);
      const temporary=this.path(id,`raw.${randomUUID()}.tmp`);
      try {
        await link(uploads.completedFile(owner,deviceId,id),temporary);
        check();await rename(temporary,this.path(id,'raw.mp4'));
        const {layers,...size}=media;
        const observation:CaptureObservation={...size,...(layers?{layers}:{}),frameRate:60,pointerTrail:[],pointerTelemetry:[],semanticTimeline:[],idleRanges:[],waitRanges:[],directed:true};
        await this.atomic(this.path(id,'observation.json'),observation);
        check();job.status='captured';delete job.errorCode;delete job.desktopRecoveryPending;
        await this.save(job);
        return this.status(job);
      } catch(error) {
        // A failed authorization or publication must not leave a renderable partial result.
        // The durable upload remains available for an authorized retry.
        await rm(this.path(id,'observation.json'),{force:true});
        await rm(this.path(id,'raw.mp4'),{force:true});
        throw error;
      } finally {await rm(temporary,{force:true});}
    })();
    this.desktopPublications.set(id,work);
    try{return await work;}finally{if(this.desktopPublications.get(id)===work)this.desktopPublications.delete(id);}
  }

  async call(owner: string, name: string, raw: unknown, authorize?:AuthorizationCheck): Promise<CallToolResult> {
    uuid.parse(owner);
    if (this.closing||this.deleting) throw new Error('service_draining');
    const args = z.record(z.string(), z.unknown()).parse(raw);
    if(name==='queue_enqueue') return this.enqueue(owner,args,authorize);
    if(name==='queue_status' || name==='queue_cancel') {
      const jobId=uuid.parse(args.jobId);
      const entry=name==='queue_cancel'?this.scheduler.cancel(owner,jobId):this.scheduler.status(owner,jobId);
      this.kickQueue();return reply(this.queueStatus(entry));
    }
    if(name==='account_usage') {
      return reply(this.accountUsage(owner));
    }
    if (name === 'demo_accounts_list') return reply({ accounts: this.demoAccounts.list(owner).map(a => ({ origin: a.origin, username: a.username, kind: a.kind })), instruction: 'Saved logins come from the Toru console. For a listed origin, call recording_run with useDemoAccount:true; Toru types the login itself (an e-mail login pauses for the user to enter the code on a secure page). Secrets are never returned. For other products ask the user for an e-mail (loginEmail) or to save a login at https://app.toru.tools/onboarding?step=login.' });
    if (name === 'session_connect' || name === 'session_open') {
      const opening = name === 'session_connect' ? this.connect(owner, args) : this.open(owner, args);
      const done = opening.then(() => undefined, () => undefined);
      this.openingDone = done;
      try { return await opening; }
      finally { if (this.openingDone === done) delete this.openingDone; }
    }
    if (name === 'session_import_status') {
      const importId = uuid.parse(args.importId);
      const saved = await this.readImport(owner, importId);
      return reply({ importId, status: 'available', expiresAt: new Date(saved.expiresAt).toISOString(), allowedOrigins: saved.origins,
        instruction: 'Saved browser state is available. This does not prove the product has not revoked the login. Use session_open with this importId; no new credentials are needed to try restoring it.' });
    }
    const id = uuid.parse(args.id);
    const job = await this.owned(owner, id);
    if (name === 'connection_status') {
      if (job.connection?.retryId) return this.call(owner, name, { ...args, id: job.connection.retryId }, authorize);
      const waitMs = z.number().int().min(0).max(25_000).parse(args.waitMs ?? (job.connection?.status === 'waiting' ? 0 : 25_000));
      const deadline = Date.now() + waitMs;
      let latest = job;
      while (['waiting', 'verifying', 'awaiting_code'].includes(latest.connection?.status ?? '') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        latest = await this.owned(owner, id);
        if (latest.connection?.status !== job.connection?.status) break;
      }
      return reply(this.connectionStatus(latest));
    }
    if (name === 'recording_status') {
      const deadline = Date.now() + z.number().int().min(0).max(25_000).parse(args.waitMs ?? 25_000);
      let latest = job;
      while ((latest.status === 'rendering' || (this.active?.job.id===id && this.active.finishPromise)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        latest = await this.owned(owner, id);
      }
      return reply(this.status(latest));
    }
    if (name === 'recording_render') {
      if(this.active?.job.id===id && this.active.finishPromise && this.active.driver.capturePrivacy==='user-approved-desktop')return reply(this.status(job));
      return this.render(job, args);
    }
    if (name === 'recording_cancel' && this.rendering?.id === id) {
      this.rendering.controller.abort();
      return reply({ id, status: 'canceling', rawPreserved: true });
    }
    const active = this.active;
    if (!active || active.job.id !== id) {
      if (['recording_stop', 'session_close', 'recording_cancel'].includes(name)) return reply(this.status(job));
      throw new Error('session_closed');
    }
    if(name==='recording_stop' && active.driver.capturePrivacy==='user-approved-desktop' && !active.busy){
      // The file transfer can outlive a tool request. Status observes the same single finalizer.
      void this.finish(active).catch(()=>undefined);
      return reply(this.status(job));
    }
    const finishing = ['recording_stop', 'session_close', 'recording_cancel'].includes(name);
    if (job.connection && !finishing) throw new Error('connection_in_progress_use_connection_status');
    if (finishing && name === 'session_close') active.closeRequested = true;
    if (active.busy) {
      if (!finishing) throw new Error('action_in_progress');
      this.requestFinish(active);
      await this.waitForAction(active);
      if (this.active === active) await this.finish(active);
      return reply(this.status(job));
    }
    active.busy = true; active.lastActivity = Date.now();
    if (name !== 'mark_demo_moment') this.endIdle(active);
    this.armDeadline(active);
    let action!: Promise<CallToolResult>;
    action = (async () => {
      try {
        const driver = active.driver;
        switch (name) {
        case 'recording_start':
          if (active.job.status === 'recording') return reply(this.status(active.job));
          if (active.job.status !== 'ready') throw new Error('open_new_session_to_record_again');
          if(driver.capturePrivacy!=='user-approved-desktop')await driver.redactSensitiveText();
          this.assertActive(active);
          await driver.startRecording(); active.startedAt = driver.recordingStartedAtMs ?? Date.now();
          if (driver.desktopWindow) active.job.desktopWindow = driver.desktopWindow;
          active.idleRanges = []; active.waitRanges = []; active.observations = new Map();
          this.assertActive(active);
          active.job.status = 'recording'; await this.save(active.job);
          if (driver.recordingMode === 'poll') { await this.finish(active); throw new Error('smooth_capture_unavailable'); }
          break;
        case 'recording_stop': await this.finish(active); break;
        case 'session_close':
        case 'recording_cancel': await this.finish(active); break;
        case 'browser_observe': return await this.observe(active, args.mode ?? 'both');
        case 'browser_navigate': {
          const url = z.string().url().parse(args.url); this.validateUrl(url, job.allowedOrigins, job.anySite);
          await driver.goto(url); break;
        }
        case 'browser_click': {
          const target = typeof args.ref === 'string' ? { type: 'ref' as const, ref: args.ref } : {
            type: 'coordinate' as const, x: z.number().min(0).max(1919).parse(args.x), y: z.number().min(0).max(1079).parse(args.y),
          };
          await driver.pointer('left_click', target); break;
        }
        case 'browser_select': {
          await driver.formInput(z.string().parse(args.ref), z.string().max(2000).parse(args.value)); break;
        }
        case 'browser_move': {
          const target = typeof args.ref === 'string' ? { type: 'ref' as const, ref: args.ref } : {
            type: 'coordinate' as const, x: z.number().min(0).max(1919).parse(args.x), y: z.number().min(0).max(1079).parse(args.y),
          };
          await driver.pointer('move', target); break;
        }
        case 'browser_point':
        case 'browser_trace':
        case 'browser_sweep': {
          // Data is rarely clickable, so the outline has no ref for a number or a cell: a point on screen names it then.
          const target = typeof args.ref === 'string' ? { type: 'ref' as const, ref: args.ref } : {
            type: 'coordinate' as const, x: z.number().min(0).max(1919).parse(args.x), y: z.number().min(0).max(1079).parse(args.y),
          };
          const kind = name === 'browser_point' ? 'point' : name === 'browser_sweep' ? 'sweep' : z.enum(['circle', 'underline']).parse(args.shape);
          const options = name === 'browser_sweep' && args.rows !== undefined ? { rows: z.number().int().min(1).max(5).parse(args.rows) } : undefined;
          // A driver without gestures (Toru for Chrome before them, a Mac window) still points the cursor at the element.
          try {
            if (!driver.gesture) throw new Error('local_method_forbidden');
            await driver.gesture(kind, target, options);
          } catch (error) {
            if (!['local_method_forbidden', 'desktop_capture_only'].includes((error as Error).message)) throw error;
            await driver.pointer('move', target);
          }
          break;
        }
        case 'browser_read': {
          // Reading down a long page: smooth steps of 300–600px with a pause to read after each (docs/gestos-humanos.md).
          const total = z.number().int().min(300).max(3000).parse(args.amount ?? 1200);
          const at = { type: 'coordinate' as const, x: z.number().min(0).max(1919).parse(args.x ?? 960), y: z.number().min(0).max(1079).parse(args.y ?? 540) };
          for (let read = 0; read < total;) {
            this.assertActive(active);
            const step = Math.min(total - read, 300 + Math.round(Math.random() * 300));
            await driver.scrollBy(at, 'down', step); read += step;
            await new Promise(resolve => setTimeout(resolve, 600 + Math.round(Math.random() * 300)));
          }
          break;
        }
        case 'browser_type': {
          const value = z.string().max(10_000).parse(args.text);
          if (typeof args.ref === 'string') await driver.formInput(args.ref, value);
          else await driver.typeText(value);
          break;
        }
        case 'browser_scroll':
          await driver.scrollBy({ type: 'coordinate', x: z.number().min(0).max(1919).parse(args.x ?? 960), y: z.number().min(0).max(1079).parse(args.y ?? 540) },
            z.enum(['up', 'down', 'left', 'right']).parse(args.direction), z.number().min(1).max(3000).parse(args.amount ?? 600)); break;
        case 'browser_key': await driver.pressKey(z.string().min(1).max(50).parse(args.key)); break;
        case 'browser_wait': {
          const ms = z.number().int().min(250).max(10_000).parse(args.ms ?? 2_000);
          const last = driver.semanticTimeline?.().at(-1);
          const until = z.enum(['change', 'duration']).parse(args.until ?? (last?.type === 'result' ? 'duration' : 'change'));
          const start = Date.now();
          if (until === 'duration' || !driver.pageText) await new Promise(resolve => setTimeout(resolve, ms));
          else {
            const baseline = active.pageSignature ?? await this.pageSignature(driver);
            let previous = baseline, stable = 0;
            while (Date.now() - start < ms) {
              this.assertActive(active);
              await new Promise(resolve => setTimeout(resolve, Math.min(350, ms - (Date.now() - start))));
              const signature = await this.pageSignature(driver);
              stable = signature === previous ? stable + 1 : 0;
              previous = signature;
              if (signature !== baseline && stable >= 2) break;
            }
          }
          if (until === 'change' && active.startedAt !== undefined) active.waitRanges?.push({ startMs: start - active.startedAt, endMs: Date.now() - active.startedAt });
          break;
        }
        case 'mark_demo_moment': {
          if (!driver.markDemoMoment) throw new Error('demo_moment_recorder_unavailable');
          const kind = z.enum(['setup', 'action', 'result']).parse(args.kind);
          const observationId = args.observationId === undefined ? undefined : uuid.parse(args.observationId);
          if (observationId && kind !== 'result') throw new Error('observation_requires_result');
          const observedAtMs = observationId ? active.observations?.get(observationId)
            : kind === 'result' ? [...(active.observations?.values() ?? [])].at(-1) : undefined;
          if (observationId && observedAtMs === undefined) throw new Error('observation_not_found');
          driver.markDemoMoment(kind, z.string().min(1).max(120).parse(args.note), args.focus === undefined ? undefined : z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(f => f.x + f.width <= 1 && f.y + f.height <= 1).parse(args.focus), observedAtMs); break;
        }
        default: throw new Error('unknown_tool');
      }
        if (!finishing) this.assertActive(active);
        if (['browser_click', 'browser_type', 'browser_navigate', 'browser_scroll', 'browser_key', 'browser_wait'].includes(name) && !active.finishRequested) {
          try { return await this.observe(active, 'both', true); }
          catch { return reply({ ...this.status(active.job), observationRequired: true,
            instruction: 'The action ran, but its resulting screen could not be read. Call browser_observe before another action; do not repeat the action blindly.' }); }
        }
        return reply(this.status(active.job));
      } finally {
        if (active.job.status === 'recording' && !active.disposed) active.idleSince ??= Date.now();
        active.busy = false;
        if (active.inFlight === action) delete active.inFlight;
        if (active.finishRequested && this.active === active) await this.finish(active);
        else if (this.active === active) this.armDeadline(active);
      }
    })();
    active.inFlight = action;
    return action;
  }
  private endIdle(active: Active) {
    if (active.idleSince !== undefined && active.startedAt !== undefined) {
      active.idleRanges?.push({ startMs: active.idleSince - active.startedAt, endMs: Date.now() - active.startedAt });
      delete active.idleSince;
    }
  }
  private async pageSignature(driver: Driver) {
    // Text is used only to detect a changed, settled screen; never sent or persisted by this check.
    return createHash('sha256').update(await driver.pageText()).digest('hex');
  }
  private async observe(active: Active, mode: unknown, compact = false): Promise<CallToolResult> {
    const driver = active.driver;
    const data: Record<string, unknown> = { ...this.status(active.job), url: await driver.currentUrl() };
    if (mode !== 'screenshot') {
      const page = await driver.readPage({ filter: 'interactive' });
      data.page = compact && typeof page === 'string' ? compactOutline(page) : page;
    }
    const images: CallToolResult['content'] = [];
    if (mode !== 'outline') {
      const shot = await driver.screenshot('observation', false);
      if (!shot.redactionPassed) throw new Error('screenshot_redaction_failed');
      if (active.startedAt !== undefined && active.job.status === 'recording') {
        const observationId = randomUUID(), observedAtMs = Date.now() - active.startedAt;
        active.observations!.set(observationId, observedAtMs);
        // ponytail: retain 256 recent screenshots; increase only for longer recording sessions.
        if (active.observations!.size > 256) active.observations!.delete(active.observations!.keys().next().value!);
        Object.assign(data, { observationId, observedAtMs });
      }
      images.push({ type: 'image', mimeType: shot.contentType, data: Buffer.from(shot.body).toString('base64') });
      // Coordinates are CSS pixels of the page. A viewport wider than the screenshot (Toru for Chrome observes a
      // 1920x1080 layout as 1280x720) says so, for an agent that reads a position off the picture.
      const viewport = driver.captureViewport, width = pngWidth(shot.body);
      if (viewport && width && width < viewport.width) Object.assign(data, { viewport: { ...viewport }, screenshotScale: Math.round(width / viewport.width * 10_000) / 10_000 });
    }
    if (typeof driver.pageText === 'function') active.pageSignature = await this.pageSignature(driver);
    this.assertActive(active);
    const result = reply(data);
    result.content.push(...images);
    return result;
  }
  accountQueue(owner:string):Record<string,unknown>[] {
    uuid.parse(owner);
    return this.store.connection.prepare('SELECT id FROM queue_entries WHERE owner=? ORDER BY sequence DESC LIMIT 20').all(owner)
      .map(row=>this.queueStatus(this.scheduler.status(owner,String(row.id))));
  }
  cancelQueuedJob(owner:string,jobId:string):Record<string,unknown> {
    const result=this.scheduler.cancel(owner,jobId);this.kickQueue();return this.queueStatus(result);
  }
  private queueStatus(entry:QueueEntry):Record<string,unknown> {
    return {version:1,jobId:entry.id,state:entry.state,operation:entry.kind==='session'?'session_open':'recording_render',
      queuedAt:new Date(entry.enqueuedAt).toISOString(),waitExpiresAt:new Date(entry.deadline).toISOString(),
      ...(entry.result?{result:entry.result}:{}),...(entry.errorCode?{errorCode:entry.errorCode}:{}),
      cancelRequested:entry.cancelRequested,
      ...(['queued','running'].includes(entry.state)?{retryAfterMs:2000,nextCall:{name:'queue_status',arguments:{jobId:entry.id}},
        instruction:entry.result?.id?'Use result.id for browser/recording tools. The queue slot stays occupied until the session/render ends.':'Waiting does not open a browser or reserve video credits. Poll queue_status; do not enqueue a duplicate.'}:{})};
  }
  private async enqueue(owner:string,args:Record<string,unknown>,authorize?:AuthorizationCheck) {
    z.literal(1).parse(args.version);
    const operation=z.enum(['session_open','recording_render']).parse(args.operation);
    const requestId=uuid.parse(args.requestId);
    const input=z.record(z.string(),z.unknown()).parse(args.arguments);
    const schema=operation==='session_open'
      ?z.object({url:z.string().url(),allowedOrigins:z.array(z.string().url()).max(12).optional(),importId:uuid.optional()}).strict()
      :z.object({id:uuid,background:z.enum(['midnight','ocean','sunset',...backgroundCatalog.map(entry=>entry.id)] as [string,...string[]]).optional(),padding:z.number().min(0).max(100).optional(),cursorScale:z.number().min(.5).max(3).optional(),compressPauses:z.boolean().optional()}).strict();
    const parsed=schema.parse(input);
    if(operation==='recording_render') await this.owned(owner,String(input.id));
    else this.validateUrl(String(input.url),this.origins([new URL(String(input.url)).origin]));
    if(authorize && !await authorize()) throw new Error('authorization_revoked');
    if(!this.queueWork && (this.active?.job.owner===owner || (this.rendering && this.store.connection.prepare('SELECT 1 FROM jobs WHERE id=? AND owner=?').get(this.rendering.id,owner)))) throw new Error('owner_queue_limit');
    await this.admit();
    const payload={operation,args:{...parsed,requestId},...(authorize?.tokenHash?{tokenHash:authorize.tokenHash}:{})};
    const inputHash=createHash('sha256').update(JSON.stringify({operation,args:parsed})).digest('hex');
    this.store.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?) ON CONFLICT(owner) DO NOTHING').run(owner,Date.now());
    const entry=this.scheduler.enqueue(owner,operation==='session_open'?'session':'render',requestId,inputHash,payload);
    this.kickQueue();return reply(this.queueStatus(entry));
  }
  private kickQueue() {
    if(!this.queueEnabled || this.closing || this.deleting || this.queuePump) return;
    const pump=this.pumpQueue().catch(()=>undefined).finally(()=>{if(this.queuePump===pump) this.queuePump=undefined;});
    this.queuePump=pump;
  }
  private async pumpQueue() {
    this.scheduler.reconcile(Date.now());
    if(this.queueWork) {
      const work=this.queueWork;
      const entry=this.scheduler.status(work.entry.owner,work.entry.id);
      if(entry.cancelRequested || work.leaseLost) {
        if(work.recordingId && this.rendering?.id===work.recordingId) {this.rendering.controller.abort();await this.rendering.done;}
        if(work.recordingId && this.active?.job.id===work.recordingId) {
          const active=this.active;active.closeRequested=true;this.requestFinish(active);await this.waitForAction(active);await this.finish(active);
        }
      }
      if(this.active?.job.id===work.recordingId || this.rendering?.id===work.recordingId || this.opening) return;
      const job=work.recordingId?await this.owned(work.entry.owner,work.recordingId).catch(()=>undefined):undefined;
      if(work.leaseLost) this.scheduler.reconcile(Date.now(),candidate=>candidate.id===entry.id);
      else this.scheduler.finish(work.lease,entry.cancelRequested?'canceled':job?.status==='interrupted'||(entry.kind==='render'&&job?.status!=='completed')?'failed':'completed',job?this.status(job):{errorCode:'queue_execution_failed'});
      this.queueWork=undefined;
    }
    if(this.closing || this.active || this.rendering || this.opening) return;
    try {await this.admit();} catch {return;}
    const entry=this.scheduler.claim(this.queueWorker);
    if(!entry) return;
    const work={entry,lease:{id:entry.id,workerId:this.queueWorker,fence:entry.fence}} as NonNullable<Recorder['queueWork']>;
    this.queueWork=work;
    try {
      const tokenHash=entry.payload.tokenHash;
      if(typeof tokenHash==='string' && !this.store.connection.prepare(`SELECT 1 FROM grants g JOIN accounts a ON a.owner=g.owner WHERE g.owner=? AND token_hash=? AND expires_at>? AND (revoked_at IS NULL OR revoked_at>?) AND a.admission_status='admitted'`).get(entry.owner,tokenHash,Date.now(),Date.now())) throw new Error('authorization_revoked');
      const args=z.record(z.string(),z.unknown()).parse(entry.payload.args);
      const result=entry.kind==='session'?await this.open(entry.owner,args,false,true):await this.render(await this.owned(entry.owner,String(args.id)),args,true);
      const structured=result.structuredContent as Record<string,unknown>;
      work.recordingId=String(structured.id);
      this.scheduler.progress(work.lease,structured);
    } catch(error) {
      // Errors are safe codes only; URLs, credentials and driver detail never enter queue status.
      const known=['authorization_revoked','beta_admission_required','video_credit_limit','daily_compute_limit','daily_session_limit','daily_service_limit','capture_unavailable','recording_not_found','rerender_limit','request_id_conflict'];
      const code=error instanceof Error && known.includes(error.message)?error.message:'queue_execution_failed';
      if(!work.leaseLost) this.scheduler.finish(work.lease,'failed',{errorCode:code});
      this.queueWork=undefined;
    }
  }
  async operationalMetrics():Promise<Record<string,unknown>> {
    const disk=await statfs(this.options.dataDir);
    return {...operationalSnapshot(this.store),...(this.lifecycle?.metrics?{product:this.lifecycle.metrics()}:{}),storage:{availableBytes:disk.bavail*disk.bsize,totalBytes:disk.blocks*disk.bsize},
      retention:{lastCleanupSucceededAt:this.lastCleanupSucceededAt,lastCleanupFailedAt:this.lastCleanupFailedAt},
      recorderProcess:{rssBytes:process.memoryUsage().rss,uptimeSeconds:Math.floor(process.uptime()),excludesBrowserAndEncoder:true}};
  }
  artifactDownloaded(owner:string,id:string):void {
    if(this.closing||this.deleting||!this.lifecycle?.artifactDownloaded)return;
    this.store.transaction(()=>{
      if(!this.store.connection.prepare("SELECT 1 FROM jobs j JOIN accounts a ON a.owner=j.owner WHERE j.id=? AND j.owner=? AND a.admission_status!='deleted'").get(id,owner))return;
      this.lifecycle!.artifactDownloaded!(owner,id);
    });
  }
  mcpToolUsed(owner:string):void {
    if(this.closing||this.deleting)return;
    uuid.parse(owner);
    this.lifecycle?.mcpToolUsed?.(owner);
  }
  accountUsage(owner:string,historyCursor?:string):Record<string,unknown> {
    uuid.parse(owner);
    if(!this.lifecycle) return {mode:'self-hosted',commercialCredits:false};
    this.store.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?) ON CONFLICT(owner) DO NOTHING').run(owner,Date.now());
    return this.lifecycle.usage(owner,historyCursor);
  }
  recordingFeedback(owner:string,id:string,input:unknown):Record<string,unknown> {
    uuid.parse(owner);uuid.parse(id);
    if(this.closing||this.deleting)throw new Error('service_draining');
    if(!this.lifecycle?.recordingFeedback)throw new Error('feedback_unavailable');
    return this.lifecycle.recordingFeedback(owner,id,input);
  }
  /** Remaining credits travel with terminal statuses so the agent can tell the user before the next demo, never mid-flow. */
  private creditsFor(job: Job): Record<string, unknown> {
    if (!this.lifecycle || !(job.status === 'completed' || (job.status === 'captured' && job.qualityReview))) return {};
    try {
      const usage = this.lifecycle.usage(job.owner) as Record<string, unknown>;
      if (typeof usage.available !== 'number') return {};
      const credits = { available: usage.available, used: usage.used, reserved: usage.reserved, ...(usage.policy && typeof usage.policy === 'object' ? { plan: (usage.policy as { version?: string }).version } : {}) };
      const low = usage.available <= 2;
      return { credits, ...(low ? { creditsLow: true, creditsNote: `One credit = one delivered video that passed the check. ${usage.available} left; mention it once when you hand over the video, and point to https://toru.tools/pricing for plans or credit packs.` } : {}) };
    } catch { return {}; }
  }
  private status(job: Job): Record<string, unknown> {
    const active = this.active?.job.id === job.id ? this.active : undefined;
    const rendering = this.rendering?.id === job.id ? this.rendering : undefined;
    const progress = rendering?.progress;
    const rawAvailable=job.rawExpiresAt===undefined || job.rawExpiresAt>Date.now();
    return {
      id: job.id, status: active?.finishPromise && active.driver.capturePrivacy==='user-approved-desktop' ? 'stopping' : job.status, createdAt: new Date(job.createdAt).toISOString(), expiresAt: new Date(job.expiresAt).toISOString(),
      ...(active?.finishPromise && active.driver.capturePrivacy==='user-approved-desktop' ? {
        nextCall:{name:'recording_status',arguments:{id:job.id}},
        instruction:'Stop requested. Toru is finalizing and uploading the local capture. Check recording_status until captured or interrupted, then render only after captured. Do not start another recording or repeat the flow.',
      } : {}),
      ...(job.durationMs === undefined ? {} : { durationMs: job.durationMs }),
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      ...(job.qualityReview ? { qualityReview: job.qualityReview } : {}),
      ...(job.branding ? { branding: job.branding } : {}),
      ...(job.desktopWindow ? { desktopWindow: job.desktopWindow } : {}),
      ...this.creditsFor(job),
      ...(job.status==='interrupted' && job.errorCode==='desktop_upload_pending' ? { captureMs: job.policy?.captureMs ?? limits.recording, nextCall:{name:'recording_status',arguments:{id:job.id}}, instruction:'The user is recording or uploading this capture manually in the Toru Mac app. Wait for captured, then call recording_render. Do not open another session for it.' } : {}),
      ...(['captured', 'rendering', 'completed'].includes(job.status) ? { rawPreserved: rawAvailable,...(job.rawExpiresAt!==undefined?{rawExpiresAt:new Date(job.rawExpiresAt).toISOString()}:{}) } : {}),
      ...(rendering ? {
        renderStartedAt: new Date(rendering.startedAt).toISOString(),
        renderDeadlineAt: new Date(rendering.startedAt + limits.render).toISOString(),
        elapsedMs: Date.now() - rendering.startedAt,
        ...(progress ? { progress: { ...progress, percent: Math.min(100, Math.round(progress.currentFrame / progress.totalFrames * 100)), updatedAt: new Date(rendering.progressedAt!).toISOString() } } : {}),
        nextCall: { name: 'recording_status', arguments: { id: job.id } },
        instruction: 'Keep calling recording_status (waits up to 25 seconds) until completed or captured. Report actual progress; do not start another render while this one is running. Canceling rendering preserves the raw capture.',
      } : {}),
      ...(!rawAvailable ? {canRetryRender:false,instruction:'The raw capture has expired. Any published MP4 remains available until expiresAt; another render requires a new capture.'} : {}),
      ...(job.status === 'captured' && rawAvailable ? { canRetryRender: true, nextCall: { name: 'recording_render', arguments: { id: job.id } }, instruction: 'The raw capture is preserved. Retry recording_render with this id; do not repeat login or recording.' } : {}),
      ...(job.status==='captured' && job.qualityReview && !job.qualityReview.passed && !job.qualityReview.accepted ? { needsReview:true, nextCall:{name:'recording_render',arguments:{id:job.id,acceptReview:true}}, instruction:`The rendered video failed the delivery check (${job.qualityReview.reasons.join(', ')}). It was not delivered and no credit was used. Fix the capture (re-record) or, if the user wants it anyway, call recording_render again with acceptReview:true.` } : {}),
      ...(active ? { sessionExpiresAt: new Date(active.openedAt + (active.job.policy?.sessionMs ?? limits.session)).toISOString(), remainingSessionMs: Math.max(0, (active.job.policy?.sessionMs ?? limits.session) - (Date.now() - active.openedAt)) } : {}),
      ...(active?.startedAt ? { remainingRecordingMs: Math.max(0, (active.job.policy?.captureMs ?? limits.recording) - (Date.now() - active.startedAt)) } : {}),
    };
  }
  private connectionStatus(job: Job): Record<string, unknown> {
    return { ...this.status(job), ...(job.connection ? {
      connectionStatus: job.connection.status === 'waiting' && job.status === 'interrupted' ? 'failed' : job.connection.status,
      credentialsReceived: Boolean(job.connection.submittedAt),
      setupExpiresAt: new Date(job.createdAt + Math.min(15 * 60_000,job.policy?.sessionMs ?? limits.session)).toISOString(),
      targetUrl: job.connection.targetUrl,
      canRetry: job.connection.status === 'failed' && (job.connection.retryCount ?? 0) < 5,
      nextAction: job.connection.status === 'ready' ? 'session_open_with_importId' : job.connection.status === 'failed' || job.status === 'interrupted' ? 'new_connection_required' : job.connection.status === 'awaiting_code' ? 'user_enters_code_on_setup_page' : 'call_connection_status',
      ...(job.connection.emailOnly ? { emailOnly: true } : {}), ...(job.connection.demoAccount ? { demoAccount: true } : {}),
      ...(job.connection.status === 'awaiting_code' && job.status !== 'interrupted' ? { nextCall: { name: 'connection_status', arguments: { id: job.id } }, userActionRequired: true,
        instruction: 'The product sent a one-time code or magic link to the user\'s e-mail. Ask the user to enter the code (or paste the link) on the same secure setupUrl, then call connection_status. Never ask for the code in chat.' } : {}),
      ...(['waiting', 'verifying'].includes(job.connection.status) && job.status !== 'interrupted' ? {
        ...(job.connection.status === 'verifying' ? { nextCall: { name: 'connection_status', arguments: { id: job.id } } } : {}),
        instruction: job.connection.status === 'waiting' ? 'Display setupUrl in your FINAL response and ask the user to reply done after signing in. End this turn now; polling can hide the link in clients. Resume connection_status after the user replies. No push notification resumes an idle client.' : 'Credentials were received. Keep checking connection_status until ready or failed.',
      } : {}),
      ...(job.connection.signedInUrl ? { signedInUrl: job.connection.signedInUrl } : {}),
      ...(job.connection.importId ? { importId: job.connection.importId, nextCall: { name: 'session_open', arguments: { url: job.connection.targetUrl ? openAfterSignIn(job.connection.targetUrl, job.connection.signedInUrl) : job.connection.targetUrl, importId: job.connection.importId } } } : {}),
      ...(job.connection.blockedOrigin ? { blockedOrigin: job.connection.blockedOrigin, suggestedAllowedOrigins: [...new Set([...job.allowedOrigins, job.connection.blockedOrigin])] } : {}),
      ...(job.connection.errorCode ? {
        connectionError: job.connection.errorCode,
        instruction: 'Report the observed error, not a guessed cause. Only change allowedOrigins for an explicit origin_not_allowed error with a verified login redirect. Do not ask the user to re-enter credentials repeatedly for the same failure.',
      } : {}),
    } : {}) };
  }
  private assertActive(active: Active) {
    if (this.active !== active || active.disposed) throw new Error('session_closed');
  }
  private requestFinish(active: Active) {
    if (this.active !== active) return;
    active.finishRequested = true;
    if (!active.busy) {
      active.busy = true;
      void this.finish(active).catch(() => undefined);
    } else if (!active.finishGraceTimer) {
      active.finishGraceTimer = setTimeout(() => {
        delete active.finishGraceTimer;
        if (this.active === active) { active.busy = true; void this.finish(active).catch(() => undefined); }
      }, 1_000);
      active.finishGraceTimer.unref();
    }
  }
  private async waitForAction(active: Active) {
    if (!active.inFlight) return;
    let timeout!: ReturnType<typeof setTimeout>;
    await Promise.race([active.inFlight.catch(() => undefined), new Promise<void>(resolve => {
      timeout = setTimeout(resolve, 1_000); timeout.unref();
    })]);
    clearTimeout(timeout);
  }
  private armDeadline(active: Active) {
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    const now = Date.now();
    const deadlines = [active.openedAt + (active.job.policy?.sessionMs ?? limits.session), active.job.connection?.status === 'waiting' || active.job.connection?.status === 'awaiting_code' ? active.openedAt + 15 * 60_000 : active.lastActivity + limits.idle];
    if (active.startedAt) deadlines.push(active.startedAt + (active.job.policy?.captureMs ?? limits.recording));
    active.deadlineTimer = setTimeout(() => {
      if (this.active !== active) return;
      this.requestFinish(active);
    }, Math.max(0, Math.min(...deadlines) - now));
    active.deadlineTimer.unref();
  }
  private async open(owner: string, args: Record<string, unknown>, deferNavigation = false, fromQueue=false, restoreImportId?: string) {
    const localId=args.localConnectionId===undefined?undefined:uuid.parse(args.localConnectionId);
    if(localId&&(deferNavigation||args.importId||fromQueue))throw new Error('local_browser_requires_direct_session');
    if(localId&&!this.options.createLocalContext)throw new Error('local_browser_disabled');
    const requestId=args.requestId===undefined?undefined:uuid.parse(args.requestId);
    const viewport=viewportOf(args.viewport);
    const inputHash=createHash('sha256').update(JSON.stringify({url:args.url,allowedOrigins:args.allowedOrigins ?? null,importId:args.importId ?? null,...(localId?{localConnectionId:localId}:{}),...(args.viewport!==undefined?{viewport:args.viewport}:{}),connect:deferNavigation})).digest('hex');
    const operation=deferNavigation?'session_connect':'session_open';
    if(requestId) {
      const receipt=this.store.connection.prepare('SELECT job_id,input_hash FROM operation_requests WHERE owner=? AND operation=? AND request_id=?').get(owner,operation,requestId);
      if(receipt) {
        if(receipt.input_hash!==inputHash) throw new Error('request_id_conflict');
        const previous=await this.owned(owner,String(receipt.job_id));
        return reply(deferNavigation?this.connectionStatus(previous):this.status(previous));
      }
    }
    if(!fromQueue && this.store.connection.prepare("SELECT 1 FROM queue_entries WHERE state IN ('queued','running') LIMIT 1").get()) throw new Error('capacity_busy');
    await this.admit();
    // A finished sign-in reports ready before its browser has closed; the next step waits for that instead of seeing a busy service.
    const handoff=this.active;
    if(handoff&&handoff.job.owner===owner&&handoff.job.connection?.status==='ready') await this.finish(handoff).catch(()=>undefined);
    if (this.active || this.rendering || this.opening) throw new Error('capacity_busy');
    if (this.closing) throw new Error('service_draining');
    this.opening = true;
    const openedAt = Date.now();
    let driver: Driver | undefined;
    let job:Job|undefined;
    try {
      await this.cleanup(); await this.storageAvailable();
      if (this.closing) throw new Error('service_draining');
      const url = z.string().url().parse(args.url);
      const { state, origins: allowedOrigins } = await this.sessionState(owner, args.importId === undefined ? restoreImportId : uuid.parse(args.importId), args.allowedOrigins === undefined ? undefined : z.array(z.string()).parse(args.allowedOrigins), new URL(url).origin, Boolean(localId));
      this.validateUrl(url, allowedOrigins, Boolean(localId));
      try {
        job = {id:randomUUID(),owner,status:'ready',createdAt:openedAt,expiresAt:openedAt+limits.retention,allowedOrigins,...(localId?{anySite:true}:{}),inputHash,...(requestId?{requestId}:{}),...(deferNavigation?{connection:{status:'waiting',targetUrl:url}}:{})};
        const admitted=job;
        await this.save(job,()=>{
          if(requestId) this.store.connection.prepare('INSERT INTO operation_requests(owner,operation,request_id,input_hash,job_id,created_at) VALUES (?,?,?,?,?,?)').run(owner,operation,requestId,inputHash,admitted.id,openedAt);
          // Receipts are per operation, the credit ledger is per requestId: keep a sign-in and the session it unlocks apart.
          if(this.lifecycle) admitted.policy=this.lifecycle.admit(admitted,requestId ? (deferNavigation ? `connect_${requestId}` : requestId) : admitted.id,inputHash);
        });
        await mkdir(this.path(job.id,''),{recursive:true,mode:0o700});
        // One saved-login recording is one daily start: the sign-in counted it, its session continues it.
        const continuesSignIn = args.importId !== undefined && this.signInImports.get(String(args.importId)) === owner;
        if (continuesSignIn) this.signInImports.delete(String(args.importId));
        if(!localId)this.browserReservation = await this.reserve(owner, 'browserMs', job.policy?.sessionMs ?? limits.session,job.id,!continuesSignIn);
        if (this.closing) throw new Error('service_draining');
        const contextOptions:BrowserContextOptions={
          // The user's Chrome records the layout the request picked (1920x1080 by default); Toru's own browser and the
          // Mac keep theirs. The driver reports the viewport it actually used (captureViewport), which every coordinate is in.
          viewport: localId ? viewport : { width: 1920, height: 1080 }, allowedOrigins, sessionState: state,
          onNavigation: target => this.validateUrl(target, allowedOrigins, Boolean(localId)), allowDownload: false, allowPopup: false,
        };
        driver = localId ? await this.options.createLocalContext!(owner,localId,{...contextOptions,captureId:job.id}) : await this.options.createContext(contextOptions);
        if(localId && driver.capturePrivacy!=='user-approved-desktop')this.browserReservation=await this.reserve(owner,'browserMs',job.policy?.sessionMs ?? limits.session,job.id);
        if(driver.capturePrivacy==='user-approved-desktop'){if(localId)job.desktopDeviceId=localId;job.rawFile='raw.mp4';job.privacyMode='user-approved-unredacted';await this.save(job);}
        (driver as Driver & {onDisconnect?:(callback:()=>void)=>void}).onDisconnect?.(()=>{
          const active=this.active;
          if(!active||active.driver!==driver)return;
          // Finish now: a desktop capture cannot be stopped remotely any more, so the job becomes interrupted and the Mac's local file stays recoverable.
          if(active.job.status==='ready')active.job.connection={...(active.job.connection??{status:'failed' as const}),status:'failed',errorCode:'desktop_disconnected'};
          this.requestFinish(active);
        });
      } finally { state.fill(0); }
      if (this.closing||this.deleting||this.store.connection.prepare("SELECT 1 FROM accounts WHERE owner=? AND admission_status='deleted'").get(owner)) throw new Error('service_draining');
      if (!deferNavigation) await driver.goto(url);
      if(!job) throw new Error('admission_failed');
      this.active = { job, driver, openedAt, lastActivity: Date.now(), busy: false };
      this.armDeadline(this.active);
      return reply(this.status(job));
    } catch (error) {
      await driver?.dispose().catch(() => undefined);
      if(job && this.store.connection.prepare('SELECT 1 FROM jobs WHERE id=?').get(job.id)) {
        job.status='interrupted';job.errorCode='session_open_failed';
        const failed=job;await this.save(job,()=>this.lifecycle?.abandon(failed));
      }
      if (this.browserReservation) await this.settle(this.browserReservation, Date.now() - openedAt);
      this.browserReservation = undefined;
      throw error;
    } finally { this.opening = false; }
  }
  private async connect(owner: string, args: Record<string, unknown>) {
    // Check the vault before any browser is reserved so a missing account never costs a session.
    if (args.useDemoAccount === true && !this.demoAccounts.list(owner).some(account => account.origin === demoOrigin(String(args.url)))) throw new Error('demo_account_not_found');
    // A saved login starts from its last signed-in state; the driver signs in again only if that state no longer is.
    // Keyed by the saved username too: editing the saved login to another account must not reuse this one's session.
    const savedKey = `${owner}\0${demoOrigin(String(args.url))}\0${this.demoAccounts.list(owner).find(account => account.origin === demoOrigin(String(args.url)))?.username ?? ''}`;
    let restore = args.useDemoAccount === true && args.importId === undefined ? (await this.savedLogins()).get(savedKey) : undefined;
    if (restore) { try { await this.readImport(owner, restore); } catch { await this.rememberSavedLogin(savedKey, undefined); restore = undefined; } }
    const opened = await this.open(owner, args, true, false, restore);
    const id = typeof opened.structuredContent?.id === 'string' ? opened.structuredContent.id : undefined;
    if (!id) throw new Error('connection_open_failed');
    if(!this.active || this.active.job.id!==id) return opened;
    if(!this.active.job.connection) {
      this.active.job.connection = { status: 'waiting', targetUrl: z.string().url().parse(args.url) };
      this.armDeadline(this.active);
      await this.save(this.active.job);
    }
    if (this.active.job.connection.status !== 'waiting') return reply(this.connectionStatus(this.active.job));
    if (args.useDemoAccount === true) {
      // Opt-in vault: the agent never sees the secret; it is typed into the hosted browser and dropped.
      const stored = this.demoAccounts.take(owner, String(args.url));
      if (!stored) throw new Error('demo_account_not_found');
      this.active.job.connection.demoAccount = true;
      return reply(await this.submitConnectionCredentials(owner, id, stored.username, stored.password));
    }
    if (typeof args.loginEmail === 'string') {
      this.active.job.connection.emailOnly = true;
      return reply(await this.submitConnectionCredentials(owner, id, z.string().trim().min(3).max(320).parse(args.loginEmail), undefined));
    }
    return reply(this.connectionStatus(this.active.job));
  }
  async retryConnection(owner: string, id: string, targetUrl: string, approvedOrigin?: string): Promise<Record<string, unknown>> {
    const parent = await this.owned(owner, id);
    if (parent.connection?.retryId) return this.connectionStatus(await this.owned(owner, parent.connection.retryId));
    if (parent.connection?.status !== 'failed') throw new Error('connection_not_failed');
    if ((parent.connection.retryCount ?? 0) >= 5) throw new Error('connection_retry_limit');
    // The person explicitly supplies the login URL on the secure page. Existing
    // origins stay scoped; only this additional public HTTPS origin is authorized.
    const url = z.string().url().max(2048).parse(targetUrl);
    if (new URL(url).username || new URL(url).password) throw new Error('public_https_url_required');
    if (approvedOrigin !== undefined && (!parent.connection.blockedOrigin || approvedOrigin !== parent.connection.blockedOrigin)) {
      throw new Error('redirect_approval_invalid');
    }
    const origins = this.origins([...parent.allowedOrigins, url, ...(approvedOrigin ? [approvedOrigin] : [])]);
    this.validateUrl(url, origins);
    if (this.active?.job.id === id) await this.active.finishPromise;
    // Namespace the retry key: the original admission may already use parent.id
    // when the client omitted requestId. Keep identical HTTP retries idempotent.
    const retryHex=createHash('sha256').update(`connection-retry:${parent.id}`).digest('hex');
    const retryRequestId=`${retryHex.slice(0,8)}-${retryHex.slice(8,12)}-4${retryHex.slice(13,16)}-8${retryHex.slice(17,20)}-${retryHex.slice(20,32)}`;
    const result = await this.connect(owner, { url, allowedOrigins: origins, requestId: retryRequestId });
    const child = await this.owned(owner, String(result.structuredContent?.id));
    child.connection = { ...child.connection!, retryCount: (parent.connection.retryCount ?? 0) + 1 };
    if (this.active?.job.id === child.id) this.active.job = child;
    await this.save(child);
    parent.connection = { ...parent.connection, retryId: child.id };
    await this.save(parent);
    return this.connectionStatus(child);
  }
  async submitConnectionCredentials(owner: string, id: string, username: string, password: string | undefined): Promise<Record<string, unknown>> {
    if(this.deleting||this.closing)throw new Error('service_draining');
    z.string().trim().min(1).max(500).parse(username);
    if (password !== undefined) z.string().min(1).max(10_000).parse(password);
    await this.owned(owner, id);
    if(this.deleting||this.closing)throw new Error('service_draining');
    const active = this.active;
    if (!active || active.job.id !== id || active.disposed || active.job.connection?.status !== 'waiting') throw new Error('connection_not_waiting');
    if (active.busy) throw new Error('action_in_progress');
    active.busy = true;
    active.lastActivity = Date.now();
    active.job.connection = { ...active.job.connection, status: 'verifying', submittedAt: Date.now(), ...(password === undefined ? { emailOnly: true } : {}) };
    try { await this.save(active.job); }
    catch (error) { active.busy = false; active.job.connection = { ...active.job.connection, status: 'waiting' }; throw error; }
    this.armDeadline(active);
    const accepted = this.connectionStatus(active.job);
    const controller = new AbortController();
    active.connectionAbort = controller;
    active.connectionTask = this.runConnection(active, controller, signal => active.driver.connectWithCredentials(username, password, signal, active.job.connection?.targetUrl));
    // The HTTP response confirms receipt, never authentication. Credentials stay only in this task's memory.
    return accepted;
  }
  /** The user finishes a sign-in paused at a one-time code or magic link on the secure page; the agent never handles the value. */
  async submitConnectionVerification(owner: string, id: string, input: { code?: string; link?: string }): Promise<Record<string, unknown>> {
    if(this.deleting||this.closing)throw new Error('service_draining');
    const code = input.code === undefined ? undefined : z.string().trim().min(3).max(64).parse(input.code);
    const link = input.link === undefined ? undefined : z.string().url().max(4096).parse(input.link);
    if (!code && !link) throw new Error('verification_input_required');
    await this.owned(owner, id);
    const active = this.active;
    if (!active || active.job.id !== id || active.disposed || active.job.connection?.status !== 'awaiting_code') throw new Error('connection_not_awaiting_code');
    if (!active.driver.completeLoginChallenge) throw new Error('verification_unavailable');
    if (active.busy) throw new Error('action_in_progress');
    if (link) this.validateUrl(link, active.job.allowedOrigins);
    active.busy = true; active.lastActivity = Date.now();
    active.job.connection = { ...active.job.connection, status: 'verifying', verificationAttempts: (active.job.connection.verificationAttempts ?? 0) + 1 };
    try { await this.save(active.job); }
    catch (error) { active.busy = false; active.job.connection = { ...active.job.connection, status: 'awaiting_code' }; throw error; }
    this.armDeadline(active);
    const accepted = this.connectionStatus(active.job);
    const controller = new AbortController();
    active.connectionAbort = controller;
    const complete = active.driver.completeLoginChallenge.bind(active.driver);
    active.connectionTask = this.runConnection(active, controller, signal => complete(code ? { code } : { link: link! }, signal));
    return accepted;
  }
  private async runConnection(active: Active, controller: AbortController, step: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const timer = setTimeout(() => controller.abort(), 90_000);
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('connection_timed_out')), { once: true }));
    let paused = false;
    try {
      const work = (async () => {
        await step(controller.signal);
        this.assertActive(active); controller.signal.throwIfAborted();
        let signedInUrl = signedInPage(await active.driver.currentUrl?.().catch(() => undefined));
        if (signedInUrl) { try { this.validateUrl(signedInUrl, active.job.allowedOrigins); } catch { signedInUrl = undefined; } }
        const state = await active.driver.exportStorageState();
        this.assertActive(active); controller.signal.throwIfAborted();
        const imported = await this.importSession(active.job.owner, state, active.job.allowedOrigins);
        this.signInImports.set(imported.id, active.job.owner);
        if (active.job.connection?.demoAccount && active.job.connection.targetUrl) {
          const origin = demoOrigin(active.job.connection.targetUrl);
          const username = this.demoAccounts.list(active.job.owner).find(account => account.origin === origin)?.username ?? '';
          await this.rememberSavedLogin(`${active.job.owner}\0${origin}\0${username}`, imported.id);
        }
        if (this.signInImports.size > 200) this.signInImports.delete(this.signInImports.keys().next().value!);
        this.assertActive(active); controller.signal.throwIfAborted();
        active.job.connection = { ...active.job.connection!, status: 'ready', importId: imported.id, ...(signedInUrl ? { signedInUrl } : {}) };
        await this.save(active.job);
      })();
      await Promise.race([work, aborted]);
    } catch (error) {
      if (this.active === active && !active.disposed) {
        // Return only known codes; browser errors may contain page content or submitted credentials.
        const browserErrors: Record<string, string> = {
          'element not interactable': 'login_control_not_interactable', 'invalid element state': 'login_control_not_interactable',
          'stale element reference': 'login_page_changed', 'no such element': 'login_page_changed',
          'invalid session id': 'browser_session_lost', 'no such window': 'browser_session_lost',
          'timeout': 'connection_timed_out',
        };
        const code = error instanceof WebDriverProtocolError ? browserErrors[error.code] ?? 'connection_failed' : error instanceof Error ? error.message : '';
        const attempts = active.job.connection?.verificationAttempts ?? 0;
        if ((code === 'additional_verification_required' || code === 'invalid_verification_code') && active.driver.completeLoginChallenge && !controller.signal.aborted && attempts < 3) {
          // The product wants a code or magic link from the user's inbox. Keep the browser open on the challenge page.
          paused = true;
          active.job.connection = { ...active.job.connection!, status: 'awaiting_code', ...(code === 'invalid_verification_code' ? { errorCode: code } : {}) };
          if (code !== 'invalid_verification_code') delete active.job.connection.errorCode;
          await this.save(active.job).catch(() => undefined);
          return;
        }
        const safeCodes = ['login_control_not_interactable', 'login_page_changed', 'browser_session_lost', 'invalid_credentials', 'additional_verification_required', 'invalid_verification_code', 'verification_field_not_found', 'login_fields_not_found', 'login_not_confirmed', 'connection_timed_out', 'origin_not_allowed'];
        let blockedOrigin: string | undefined;
        if (code.startsWith('origin_not_allowed:')) {
          try { blockedOrigin = this.origins([code.slice('origin_not_allowed:'.length)])[0]; } catch { /* no unvalidated suggestion */ }
        }
        active.job.connection = { ...active.job.connection!, status: 'failed', errorCode: safeCodes.includes(code) ? code : code.startsWith('origin_not_allowed:') ? 'origin_not_allowed' : 'connection_failed', ...(blockedOrigin ? { blockedOrigin } : {}) };
      }
    } finally {
      clearTimeout(timer);
      active.busy = false;
      if (paused) { active.lastActivity = Date.now(); this.armDeadline(active); }
      else if (this.active === active && !active.disposed) await this.finish(active).catch(() => undefined);
    }
  }
  async completeConnection(owner: string, id: string): Promise<Record<string, unknown>> {
    // Legacy links cannot bypass verification and promote an unauthenticated profile to ready.
    return this.connectionStatus(await this.owned(owner, id));
  }
  private async finish(active: Active) {
    if (active.finishPromise) return active.finishPromise;
    active.finishPromise = (async () => {
      let failure: unknown;
      active.disposed = true;
      active.connectionAbort?.abort();
      if (active.job.connection && ['waiting', 'verifying', 'awaiting_code'].includes(active.job.connection.status)) {
        active.job.connection = { ...active.job.connection, status: 'failed', errorCode: this.closing ? 'server_restarted' : active.closeRequested ? 'connection_closed' : 'connection_expired' };
      }
      try {
        if (active.job.status === 'recording') {
          this.endIdle(active);
          active.job.durationMs = Date.now() - (active.startedAt ?? Date.now());
          const raw = await active.driver.stopRecording();
          const capturedDuration = active.driver.recordingDurationMs;
          if (active.driver.desktopWindow) active.job.desktopWindow = active.driver.desktopWindow;
          if (typeof capturedDuration === 'number' && Number.isFinite(capturedDuration) && capturedDuration > 0 && capturedDuration <= 305000) {
            active.job.durationMs = capturedDuration;
          }
          if (!raw.redactionPassed && active.driver.capturePrivacy!=='user-approved-desktop') throw new Error('capture_redaction_failed');
          if (!raw.body.length || raw.body.length > limits.artifact) throw new Error('capture_size_invalid');
          active.job.rawFile=raw.contentType==='video/mp4'||active.driver.capturePrivacy==='user-approved-desktop'?'raw.mp4':'raw.webm';
          if(active.driver.capturePrivacy==='user-approved-desktop')active.job.privacyMode='user-approved-unredacted';
          await this.publishFile(this.path(active.job.id, active.job.rawFile),raw.body);
          active.job.rawExpiresAt=Date.now()+(active.job.policy?.rawRetentionMs ?? limits.retention);
          active.job.expiresAt=active.job.rawExpiresAt;
          const observation: CaptureObservation = {
            ...observationViewport(active.driver), frameRate: 60, durationMs: active.job.durationMs,
            pointerTrail: active.driver.pointerTrail?.() ?? [], pointerTelemetry: active.driver.pointerTelemetry?.() ?? [],
            semanticTimeline: active.driver.semanticTimeline?.() ?? [],
            // A Mac capture someone drove by hand keeps every moment: the gaps between calls are them working. When
            // Toru operated the window (it left a cursor path), the gaps are the navigator thinking, as on the web.
            ...(active.idleRanges ? { idleRanges: active.driver.capturePrivacy!=='user-approved-desktop' ? active.idleRanges
              : (active.driver.pointerTelemetry?.() ?? []).length
                // Toru operated the Mac window: its reads and decisions leave the window still, marked by the cursor path.
                ? [...active.idleRanges, ...pointerIdleRanges(active.driver.pointerTelemetry?.() ?? [], active.job.durationMs ?? 0)]
                : [] } : {}),
            waitRanges: active.waitRanges ?? [], directed: true,
            ...(active.driver.contentLayers ? { layers: active.driver.contentLayers } : {}),
            ...(active.job.desktopWindow ? { window: { width: active.job.desktopWindow.width, height: active.job.desktopWindow.height, resized: active.job.desktopWindow.resized } } : {}),
            ...videoSize(observationViewport(active.driver), active.driver.captureSize),
          };
          const clicks = observation.pointerTelemetry.filter(sample => sample.kind === 'down').map(sample => sample.atMs);
          const redactions = redactionIntervals(active.driver.identitySightings?.() ?? [], observation.durationMs, clicks,
            active.driver.capturePrivacy !== 'user-approved-desktop');
          if (redactions.length) observation.redactions = redactions;
          await this.atomic(this.path(active.job.id, 'observation.json'), observation);
          const preview = await active.driver.screenshot('preview', false).catch(() => null);
          if (preview && (preview.redactionPassed || active.driver.capturePrivacy==='user-approved-desktop')) await writeFile(this.path(active.job.id, 'preview.png'), preview.body, { mode: 0o600 });
          active.job.status = 'captured';
        } else if (active.job.status === 'ready') {
          const interrupted = !active.closeRequested && (this.closing || active.finishRequested || active.job.connection?.status === 'failed');
          active.job.status = interrupted ? 'interrupted' : 'closed';
          if (interrupted) active.job.errorCode = active.job.connection?.errorCode ?? (this.closing ? 'server_restarted' : 'session_expired');
        }
      } catch (error) {
        active.job.status = 'interrupted'; active.job.errorCode = 'capture_interrupted'; failure = error;
      } finally {
        if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
        if (active.finishGraceTimer) clearTimeout(active.finishGraceTimer);
        await active.driver.dispose().catch(() => undefined);
        // A capture is not a video: its credit goes back now, and recording_render reserves one again
        // (beforeRender) only if the user actually renders it. Holding it here kept credits "reserved"
        // for a day after every run that stopped short of delivery.
        await this.save(active.job,()=>this.lifecycle?.abandon(active.job)).catch(error => { failure ??= error; });
        const reservation = this.browserReservation;
        this.browserReservation = undefined; this.active = undefined;
        if (reservation) await this.settle(reservation, Date.now() - active.openedAt).catch(error => { failure ??= error; });
      }
      if (failure) throw failure;
    })();
    return active.finishPromise;
  }
  private async render(job: Job, args: Record<string, unknown>,fromQueue=false) {
    if(this.desktopPublications.has(job.id))throw new Error('capacity_busy');
    const requestId=args.requestId===undefined?randomUUID():uuid.parse(args.requestId);
    // The domain brand saved in the console applies by default; explicit render arguments still win.
    const brand:Brand|undefined=this.brands.resolve(job.owner, job.connection?.targetUrl ?? job.allowedOrigins[0]);
    const presentation={id:job.id,
      background:args.background===undefined?undefined:z.enum(['midnight','ocean','sunset',...backgroundCatalog.map(entry=>entry.id)] as [string,...string[]]).parse(args.background),
      padding:args.padding===undefined&&brand?.padding===undefined?undefined:z.number().min(0).max(100).parse(args.padding ?? brand?.padding),
      cursorScale:z.number().min(0.5).max(3).parse(args.cursorScale ?? 1),
      compressPauses:z.boolean().parse(args.compressPauses ?? true),
      acceptReview:z.boolean().parse(args.acceptReview ?? false),
      gif:z.boolean().parse(args.gif ?? brand?.gif ?? false),
      // Full HD unless the brand or the request picks another size; captures are 2x, so 1920 stays sharp.
      width:args.width===undefined?brand?.width??DEFAULT_RENDER_WIDTH:z.union([z.literal(1280),z.literal(1920),z.literal(2560)]).parse(args.width),
      brand};
    const inputHash=createHash('sha256').update(JSON.stringify(presentation)).digest('hex');
    const receipt=this.store.connection.prepare("SELECT input_hash,result FROM operation_requests WHERE owner=? AND operation='recording_render' AND request_id=?").get(job.owner,requestId);
    if(receipt) {
      if(receipt.input_hash!==inputHash) throw new Error('request_id_conflict');
      return reply(receipt.result ? JSON.parse(String(receipt.result)) : {...this.status(job),requestId});
    }
    if(!fromQueue && this.store.connection.prepare("SELECT 1 FROM queue_entries WHERE state IN ('queued','running') LIMIT 1").get()) throw new Error('capacity_busy');
    await this.admit();
    if (this.rendering?.id === job.id) {
      if(args.requestId!==undefined) throw new Error('capacity_busy');
      return reply(this.status(job));
    }
    if (this.active || this.rendering || this.opening) throw new Error('capacity_busy');
    this.opening = true;
    try {
      await this.storageAvailable();
      if (!['captured', 'completed', 'interrupted'].includes(job.status)) throw new Error('capture_required');
      if (!await this.hasCapture(job.id)) throw new Error('capture_unavailable');
      const observation = JSON.parse(await readFile(this.path(job.id, 'observation.json'), 'utf8')) as CaptureObservation;
      // A Mac window recorded with room around it is shown on a light backdrop with a thin frame, unless the brand
      // or the request says otherwise; everything else stays full-bleed.
      const layered = (observation.layers?.samples.length ?? 0) > 0;
      const padding = presentation.padding ?? (layered ? 8 : 0);
      // The default behind a Mac window is the light, grainy blue of toru.tools.
      const wallpaper = presentation.background ? backgrounds[presentation.background as keyof typeof backgrounds] ?? presentation.background
        : brandWallpaper(brand) ?? (layered ? 'toru-sky' : backgrounds.midnight);
      const outputWidth = presentation.width && observation.width > 0 ? Math.min(presentation.width, 2560) : undefined;
      // Measured on the raw capture for this render only: where nothing on screen changes, so those moments can be cut.
      if (presentation.compressPauses && observation.idleRanges !== undefined && observation.directed) {
        const stills = await (this.options.detectStills ?? detectStillRanges)(
          this.path(job.id, job.rawFile==='raw.mp4'?'raw.mp4':'raw.webm'), observation.durationMs);
        if (stills) observation.stillRanges = stills;
      }
      const config = buildExporterConfig(observation, {
        wallpaper,
        padding,
        ...(padding === 0 ? { borderRadius: 0, showShadow: false } : brand?.radius !== undefined ? { borderRadius: brand.radius } : {}),
        ...(outputWidth ? { width: outputWidth, height: Math.round(outputWidth * observation.height / observation.width / 2) * 2 } : {}),
        cursorScale: presentation.cursorScale,
        // Older captures lack reliable idle intervals; stationary cursors can be typing.
        compressPauses: presentation.compressPauses && observation.idleRanges !== undefined,
        // The brand's camera and pointer; both are on unless the brand turns them off.
        ...(brand?.zoom?.enabled === false ? { zoom: false } : brand?.zoom?.scale !== undefined ? { zoomScale: brand.zoom.scale } : {}),
        ...(brand?.cursor?.smooth === false ? { smoothCursor: false } : {}),
      });
      const reservation = await this.reserve(job.owner, 'renderMs', limits.render,job.id);
      try {
        job.status = 'rendering'; job.renderRequestId=requestId; delete job.errorCode;
        await this.save(job,()=>{
          this.lifecycle?.beforeRender?.(job);
          this.store.connection.prepare('INSERT INTO operation_requests(owner,operation,request_id,input_hash,job_id,created_at) VALUES (?,?,?,?,?,?)')
            .run(job.owner,'recording_render',requestId,inputHash,job.id,Date.now());
        });
      } catch (error) {
        await this.settle(reservation, 0).catch(() => undefined);
        throw error;
      }
      const controller = new AbortController(); const startedAt = Date.now();
      const timer = setTimeout(() => controller.abort(new Error('render_timeout')), limits.render); timer.unref();
      const done = (async () => {
        const previousArtifact=job.artifact;
        let publication:Job['artifact'];
        let redacted:string|undefined;
        try {
          let source = this.path(job.id, job.rawFile==='raw.mp4'?'raw.mp4':'raw.webm');
          // The user's account name and picture are blurred in the source, so zooms and crops never reveal them.
          if (observation.redactions?.length) {
            redacted = this.path(job.id, `raw.redacted.${randomUUID()}.tmp.mp4`);
            await (this.options.redactRegions ?? redactRegions)(source, redacted, observation.redactions, controller.signal);
            source = redacted;
          }
          const rendered = await this.options.render(source, config, controller.signal, progress => {
            if (this.rendering?.id !== job.id) return;
            if (progress.currentFrame !== this.rendering.progress?.currentFrame) this.rendering.progressedAt = Date.now();
            this.rendering.progress = progress;
          });
          if (controller.signal.aborted) throw new Error('render_canceled');
          // Logo and intro/outro cards are composited after the exporter; the raw capture stays untouched.
          const branded = await (this.options.applyBrand ?? applyBrand)(rendered, brand, controller.signal);
          const output = branded.bytes;
          if (controller.signal.aborted) throw new Error('render_canceled');
          if (!output.length || output.length > limits.artifact) throw new Error('render_size_invalid');
          const artifact={id:randomUUID(),bytes:output.length,sha256:createHash('sha256').update(output).digest('hex')};
          // Quality gate: a blank, static or too-short video is kept for review but never delivered or charged.
          const reviewPath=this.path(job.id,`video.review.${artifact.id}.tmp`);
          await writeFile(reviewPath,output,{mode:0o600});
          let verdict:QualityVerdict;
          try {
            const observation=await readFile(this.path(job.id,'observation.json'),'utf8').then(text=>JSON.parse(text) as CaptureObservation).catch(()=>undefined);
            verdict=await (this.options.assessQuality ?? assessDemo)(reviewPath,observation,config);
          } finally { await rm(reviewPath,{force:true}); }
          if(!verdict.passed && !presentation.acceptReview) {
            job.qualityReview={...verdict,at:Date.now()};job.status='captured';job.errorCode='quality_review';delete job.pendingArtifact;
            // Release the render reservation: the user is not charged for a video that failed the check.
            await this.save(job,()=>this.lifecycle?.abandon(job));
            return;
          }
          job.qualityReview={...verdict,at:Date.now(),...(verdict.passed?{}:{accepted:true})};
          publication=artifact;job.pendingArtifact=artifact;await this.save(job);
          // The timeline describes the video beside it; an older one must not outlive the video it described.
          await rm(this.path(job.id,'timeline.json'),{force:true});
          await this.publishFile(this.path(job.id,'video.mp4'),output);
          await rm(this.path(job.id,'demo.gif'),{force:true});
          let gifError:string|undefined;
          if(presentation.gif){
            // ffmpeg picks the container from the extension, so the temp name must end in .gif.
            const gifTmp=this.path(job.id,`demo.${artifact.id}.tmp.gif`);
            try { await (this.options.makeGif ?? makeGif)(this.path(job.id,'video.mp4'),gifTmp,controller.signal); await rename(gifTmp,this.path(job.id,'demo.gif')); }
            catch(error) { await rm(gifTmp,{force:true}); gifError=error instanceof Error?error.message.slice(0,120):'gif_failed'; /* The MP4 is the deliverable; a GIF failure is not a render failure. */ }
          }
          job.branding={applied:branded.applied,...(brand?{brand:true}:{}),gif:presentation.gif&&!gifError,...(gifError?{gifError}:{})};
          // What this render did, for the console's run screen. Optional: a video without it is still delivered.
          await this.atomic(this.path(job.id,'timeline.json'),renderTimeline(observation,config,{brand,applied:branded.applied,gif:presentation.gif&&!gifError,compressPauses:presentation.compressPauses}))
            .catch(error=>console.error(JSON.stringify({event:'timeline_write_failed',job:job.id,error:error instanceof Error?error.message.slice(0,200):'unknown'})));
          job.artifact=artifact;delete job.pendingArtifact;job.status='completed';delete job.errorCode;
          if(!previousArtifact) job.expiresAt=Date.now()+(job.policy?.videoRetentionMs ?? limits.retention);
          await this.save(job,()=>this.lifecycle?.delivered(job,artifact.id));
        } catch (error) {
          if(publication) {job.pendingArtifact=publication;if(previousArtifact) job.artifact=previousArtifact;else delete job.artifact;}
          job.status = 'captured';
          job.errorCode = controller.signal.reason?.message === 'render_timeout' || (error instanceof Error && error.message === 'render_timeout')
            ? 'render_timeout' : controller.signal.aborted ? 'render_canceled' : 'render_failed';
          // The status only carries the code; keep the cause in the service log so a failed render can be diagnosed.
          console.error(JSON.stringify({ event: 'render_failed', job: job.id, code: job.errorCode, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
            ...(error instanceof Error && typeof error.cause === 'string' ? { cause: error.cause.slice(0, 500) } : {}) }));
        } finally {
          clearTimeout(timer);
          if (redacted) await rm(redacted, { force: true }).catch(() => undefined);
          await this.save(job).catch(() => undefined);
          this.rendering = undefined;
          await this.settle(reservation, Date.now() - startedAt).catch(() => undefined);
        }
      })();
      this.rendering = { id: job.id, controller, done, startedAt };
      return reply({...this.status(job),requestId});
    } finally { this.opening = false; }
  }
  async artifact(owner: string, id: string, kind: 'video' | 'preview' | 'raw' | 'plan' | 'events' | 'gif' | 'timeline') {
    const job=await this.owned(owner, id);
    if(kind==='gif'){ if(!job.artifact) throw new Error('artifact_not_published'); const path=this.path(id,'demo.gif');await stat(path);return {path,contentType:'image/gif'}; }
    if(kind==='raw'){
      const name=job.rawFile ?? 'raw.webm';const path=this.path(id,name);await stat(path);
      return {path,contentType:name==='raw.mp4'?'video/mp4':'video/webm'};
    }
    if(kind==='timeline'){ if(!job.artifact) throw new Error('artifact_not_published'); const path=this.path(id,'timeline.json');await stat(path);return {path,contentType:'application/json'}; }
    if(kind==='plan'||kind==='events'){
      const path=this.path(id,kind==='plan'?'plan.json':'events.jsonl');await stat(path);
      return {path,contentType:kind==='plan'?'application/json':'application/x-ndjson'};
    }
    if(kind==='video' && job.policy && !job.artifact) throw new Error('artifact_not_published');
    const path = this.path(id, kind === 'video' ? 'video.mp4' : 'preview.png');
    await stat(path);
    if(kind==='video' && job.artifact && createHash('sha256').update(await readFile(path)).digest('hex')!==job.artifact.sha256) throw new Error('artifact_not_published');
    return { path, contentType: kind === 'video' ? 'video/mp4' : 'image/png' };
  }
  listBrands(owner: string) { uuid.parse(owner); return this.brands.list(owner); }
  saveBrand(owner: string, origin: string, brand: unknown) { uuid.parse(owner); return this.brands.save(owner, origin, brand); }
  deleteBrand(owner: string, origin: string) { uuid.parse(owner); return this.brands.remove(owner, origin); }
  listDemoAccounts(owner: string) { uuid.parse(owner); return this.demoAccounts.list(owner); }
  saveDemoAccount(owner: string, url: string, username: string, password: string | undefined, kind?: 'password' | 'email') { uuid.parse(owner); return this.demoAccounts.save(owner, url, username, password, Date.now(), kind ?? (password === undefined ? 'email' : 'password')); }
  deleteDemoAccount(owner: string, origin: string) { uuid.parse(owner); return this.demoAccounts.remove(owner, demoOrigin(origin)); }
  /** Folder where a run stores its plan and event log next to the session's media. */
  async artifactDir(owner: string, id: string) {
    await this.owned(owner, id);const dir=this.path(id,'');await mkdir(dir,{recursive:true,mode:0o700});return dir;
  }
  async recordings(owner: string): Promise<Record<string, unknown>[]> {
    uuid.parse(owner);
    const jobs = this.storedJobs();
    return jobs.filter((job): job is Job => Boolean(job && job.owner === owner && job.expiresAt > Date.now() && (job.durationMs !== undefined || ['recording', 'captured', 'rendering', 'completed'].includes(job.status))))
      .sort((left, right) => right.createdAt - left.createdAt).slice(0, 20).map(job => this.status(job));
  }
  private async expire() {
    await this.cleanup();
    const active = this.active;
    if (!active) return;
    const now = Date.now();
    if (now - active.openedAt >= (active.job.policy?.sessionMs ?? limits.session) || now - active.lastActivity >= (active.job.connection?.status === 'waiting' ? 15 * 60_000 : limits.idle) ||
      (active.startedAt && now - active.startedAt >= (active.job.policy?.captureMs ?? limits.recording))) {
      this.requestFinish(active);
    }
  }
  private async cleanup() {
    const now=Date.now();
    try {
    if(this.lifecycle?.maintenance && (this.lastLifecycleMaintenanceAt===undefined || now-this.lastLifecycleMaintenanceAt>=60*60_000)) {
      this.lifecycle.maintenance(now);
      this.lastLifecycleMaintenanceAt=now;
    }
    this.store.connection.prepare('DELETE FROM preparation_notes WHERE expires_at<=?').run(Date.now());
    this.store.connection.prepare('DELETE FROM navigation_runs WHERE expires_at<=?').run(Date.now());
    for (const job of this.storedJobs()) {
      if(job.id === this.active?.job.id || job.id === this.rendering?.id || this.desktopPublications.has(job.id)) continue;
      if(job.rawExpiresAt!==undefined && job.rawExpiresAt<=Date.now()) {
        await rm(this.path(job.id,'raw.webm'),{force:true});await rm(this.path(job.id,'raw.mp4'),{force:true});
        await rm(this.path(job.id,'desktop-upload.mp4'),{force:true});await rm(this.path(job.id,'desktop-upload.partial'),{force:true});
        this.store.connection.prepare('DELETE FROM desktop_uploads WHERE job_id=?').run(job.id);
        await rm(this.path(job.id,'observation.json'),{force:true});
      }
      if (job.expiresAt <= Date.now()) {
        this.store.transaction(()=>this.lifecycle?.abandon(job));
        await rm(this.path(job.id, ''), { recursive: true, force: true });
        this.store.connection.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
      }
    }
    await pruneSessionImports(this.store,this.options.dataDir,now,()=>this.importsBusy);
    this.lastCleanupSucceededAt=Date.now();
    this.lastCleanupFailedAt=null;
    this.lastCleanupFailureLogAt=0;
    }catch(error){
      this.lastCleanupFailedAt=Date.now();
      if(!this.lastCleanupFailureLogAt||this.lastCleanupFailedAt-this.lastCleanupFailureLogAt>=60_000){
        console.error('recorder_retention_cleanup_failed');
        this.lastCleanupFailureLogAt=this.lastCleanupFailedAt;
      }
      throw error;
    }
  }
  async deleteAccountData(owner:string){
    uuid.parse(owner);
    if(this.closing||this.deleting)throw new Error('service_draining');
    if(!this.lifecycle?.beforeAccountErase)throw new Error('account_deletion_unavailable');
    this.lifecycle.assertAccountEraseAllowed?.(owner);
    this.deleting=true;
    const work=(async()=>{
      await this.lifecycle!.beforeAccountErase!(owner);
      this.store.transaction(()=>{
        this.lifecycle!.assertAccountEraseAllowed?.(owner);
        const sql=this.store.connection;
        sql.prepare("UPDATE accounts SET admission_status='deleted',deleted_at=coalesce(deleted_at,?) WHERE owner=?").run(Date.now(),owner);
        this.demoAccounts.removeAll(owner);
        this.brands.removeAll(owner);
        sql.prepare('UPDATE grants SET revoked_at=coalesce(revoked_at,?) WHERE owner=?').run(Date.now(),owner);
      });
      const savedLogins=await this.savedLogins();
      if([...savedLogins.keys()].some(key=>key.startsWith(`${owner}\0`))){
        for(const key of [...savedLogins.keys()])if(key.startsWith(`${owner}\0`))savedLogins.delete(key);
        await this.atomic(join(this.options.dataDir,'saved-login-imports.json'),Object.fromEntries(savedLogins));
      }
      const deadline=Date.now()+30000;
      const wait=async(work:Promise<unknown>|undefined)=>{
        if(!work)return;
        const remaining=deadline-Date.now();if(remaining<=0)throw new Error('account_deletion_pending');
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('account_deletion_pending')),remaining);})]);}
        finally{if(timer)clearTimeout(timer);}
      };
      await wait(this.queuePump);await wait(this.openingDone);
      await wait(Promise.allSettled([...this.desktopPublications.values()]));
      while(this.importsBusy||this.opening){if(Date.now()>deadline)throw new Error('account_deletion_pending');await new Promise(resolve=>setTimeout(resolve,25));}
      if(this.rendering && this.store.connection.prepare('SELECT 1 FROM jobs WHERE id=? AND owner=?').get(this.rendering.id,owner)){
        this.rendering.controller.abort();await wait(this.rendering.done);
      }
      if(this.active?.job.owner===owner){
        const active=this.active;active.closeRequested=true;this.requestFinish(active);await wait(this.waitForAction(active));await wait(this.finish(active).catch(()=>undefined));
      }
      if(this.queueWork?.entry.owner===owner)this.queueWork=undefined;
      // A Clerk identity may request erasure before its first Recorder request.
      // Persist a tombstone for that owner too, so restoring an older volume
      // cannot later re-enable data associated with the deleted identity.
      return eraseAccountDataInStore(this.store,this.options.dataDir,owner,this.lifecycle,{tombstoneMissingAccount:true});
    })();
    this.deletionDone=work;
    try{return await work;}finally{this.deleting=false;delete this.deletionDone;this.kickQueue();}
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.desktopPublications.values()]);
    await this.deletionDone?.catch(()=>undefined);
    if (this.maintenance) clearInterval(this.maintenance);
    this.rendering?.controller.abort();
    await this.rendering?.done;
    await this.openingDone;
    await this.queuePump;
    const active = this.active;
    if (active) {
      this.requestFinish(active); await this.waitForAction(active);
      if (this.active === active) await this.finish(active).catch(() => undefined);
    }
    if(this.queueWork && this.store) {
      const work=this.queueWork;
      try {this.scheduler.finish(work.lease,'failed',{...(work.recordingId?{id:work.recordingId}:{}),errorCode:'server_stopped'});} catch {/* Restart reconciles a lost lease. */}
      this.queueWork=undefined;
    }
    this.store?.close();
    this.releaseStoreLock?.();delete this.releaseStoreLock;
  }
}

/** Elements an action reply lists at most: the agent acts on what is on screen, and the whole outline of a long page
 * cost it about 20k tokens per click (Wikipedia, 2026-10-24). browser_observe still returns everything. */
export const COMPACT_OUTLINE_ELEMENTS = 80;
/** The outline an action returns: its scroll header and the elements visible in the viewport, capped, with a count of
 * what it left out. Refs keep their numbers, so a ref from the compact list is the same element in the full one. */
export function compactOutline(outline: string, limit = COMPACT_OUTLINE_ELEMENTS): string {
  const lines = outline.split('\n');
  const header = lines[0]?.startsWith('Scroll areas') ? [lines.shift()!] : [];
  const kept: string[] = [];
  let left = 0;
  for (const line of lines) {
    if (!/^\s*\[ref_/.test(line)) { if (line.trim()) kept.push(line); continue; }
    if (line.includes('— visible at') && kept.length < limit) kept.push(line); else left++;
  }
  return [...header, ...kept, ...(left ? [`(${left} more elements outside the viewport, covered or past the first ${limit}; browser_observe with mode "outline" lists them all)`] : [])].join('\n');
}

