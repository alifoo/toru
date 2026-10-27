export { spawnBrowserProcess, stopBrowserProcess } from './browser-process.js';
export { browserProcessEnvironment } from './process-environment.js';
import { isIP } from "node:net";
import { getDomain } from "tldts";
import { z } from "zod";
import { isInternalNavigationHost } from "./host-policy.js";
import { isLocalDevelopmentUrl } from "./local-development.js";

export const LocatorSchema = z.object({
  // "field" matches a form control by what it is for rather than by what it says. Visible labels are
  // localized and framework-specific — Clerk renders "Endereço de e-mail" in pt-BR — while the
  // underlying type, name and autocomplete attributes are stable across locales and providers.
  strategy: z.enum(["role", "label", "testId", "text", "field"]),
  value: z.string().trim().min(1).max(500),
});
export type CaptureLocator = z.infer<typeof LocatorSchema>;

const CaptureStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.url().max(2048) }),
  z.object({ type: z.literal("click"), locator: LocatorSchema }),
  z.object({
    type: z.literal("fill"),
    locator: LocatorSchema,
    valueHandle: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal("select"),
    locator: LocatorSchema,
    valueHandle: z.string().trim().min(1).max(200),
  }),
  z.object({ type: z.literal("waitFor"), locator: LocatorSchema }),
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().min(100).max(30_000) }),
  z.object({ type: z.literal("assertVisible"), locator: LocatorSchema }),
  z.object({ type: z.literal("mask"), locator: LocatorSchema }),
  z.object({
    type: z.literal("screenshot"),
    name: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
    fullPage: z.boolean().default(false),
  }),
  z.object({ type: z.literal("startRecording") }),
  z.object({ type: z.literal("stopRecording") }),
  z.object({
    type: z.literal("explore"),
    goals: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
    /**
     * What the finished flow looks like on screen.
     *
     * Without it the agent decides for itself when a demo is done, and it decides too early: it has
     * performed the steps, so it stops, with the setup recorded and the result never reached.
     */
    win: z.string().trim().min(3).max(400).optional(),
    tutorial: z.string().trim().min(1).max(40_000).optional(),
    /** True only when preparation actually read repository evidence. */
    sourceAvailable: z.boolean().optional(),
  }),
]);
export type CaptureStep = z.infer<typeof CaptureStepSchema>;

export const ComputerActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["click", "double_click", "move"]),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    button: z.enum(["left", "middle", "right"]).optional(),
  }),
  z.object({
    type: z.literal("scroll"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    scroll_x: z.number().int().min(-10_000).max(10_000),
    scroll_y: z.number().int().min(-10_000).max(10_000),
  }),
  z.object({ type: z.literal("type"), text: z.string().max(1000) }),
  z.object({ type: z.literal("keypress"), keys: z.array(z.string().min(1).max(50)).max(10) }),
  z.object({
    type: z.literal("drag"),
    path: z
      .array(z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }))
      .min(2)
      .max(100),
  }),
  z.object({ type: z.enum(["wait", "screenshot"]) }),
]);
export type ComputerAction = z.infer<typeof ComputerActionSchema>;

export const RedactionRuleSchema = z.object({
  locator: LocatorSchema,
  mode: z.enum(["mask", "blur"]),
  required: z.boolean().default(true),
});
export type RedactionRule = z.infer<typeof RedactionRuleSchema>;

export const CaptureRecipeSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    agentRequestId: z.uuid().optional(),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    allowedOrigins: z.array(z.url()).min(1).max(20),
    viewport: z.object({
      width: z.number().int().min(320).max(3840),
      height: z.number().int().min(240).max(2160),
    }),
    steps: z.array(CaptureStepSchema).min(1).max(100),
    redactionRules: z.array(RedactionRuleSchema).max(50).default([]),
    /**
     * Blur contact details wherever they appear, for as long as the recording runs.
     *
     * On by default, and a recipe has to say otherwise. What a demo of a lead-generation product
     * puts on screen is other people's work emails, personal addresses and phone numbers, arriving
     * after every locator-based rule has already run. A video that leaks them is worse than one
     * that over-blurs, so the default is the cautious one.
     */
    redactSensitiveText: z.boolean().default(true),
    output: z
      .object({
        screenshots: z.boolean().default(true),
        video: z.boolean().default(false),
        trace: z.boolean().default(true),
      })
      .default({ screenshots: true, video: false, trace: true }),
    limits: z
      .object({
        /**
         * The longest a capture may drive somebody's product, enforced as a hard deadline.
         *
         * Four minutes rather than two: an agent-driven demo spends most of its time waiting on a
         * model between actions, and at two minutes it was being cut off mid-flow, before the result
         * it set out to show. The default is unchanged — a recipe has to ask for the extra time.
         */
        maximumDurationMs: z.number().int().min(100).max(600_000).default(60_000),
        maximumActions: z.number().int().min(1).max(100).default(50),
        maximumRedirects: z.number().int().min(0).max(10).default(3),
      })
      .default({ maximumDurationMs: 60_000, maximumActions: 50, maximumRedirects: 3 }),
  })
  .superRefine((recipe, context) => {
    const normalizedOrigins = recipe.allowedOrigins.map(normalizeRecipeOrigin);
    if (new Set(normalizedOrigins).size !== normalizedOrigins.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedOrigins"],
        message: "Allowed origins must be unique after normalization",
      });
    }
    const recordingStarts = recipe.steps.filter((step) => step.type === "startRecording").length;
    const recordingStops = recipe.steps.filter((step) => step.type === "stopRecording").length;
    if (recipe.output.video && (recordingStarts !== 1 || recordingStops !== 1)) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Video recipes require exactly one recording start and stop",
      });
    }
    if (!recipe.output.video && recordingStarts + recordingStops > 0) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Recording steps require video output",
      });
    }
  });
export type CaptureRecipe = z.infer<typeof CaptureRecipeSchema>;

export const BrowserStorageStateSchema = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string().min(1).max(500),
        value: z.string().max(10_000),
        domain: z.string().min(1).max(255),
        path: z.string().max(2000).default("/"),
        expires: z.number().optional(),
        httpOnly: z.boolean().default(true),
        secure: z.boolean().default(true),
        sameSite: z.enum(["Strict", "Lax", "None"]).default("Lax"),
      }),
    )
    .max(500)
    .default([]),
  origins: z
    .array(
      z.object({
        origin: z.url(),
        localStorage: z
          .array(z.object({ name: z.string().min(1).max(500), value: z.string().max(20_000) }))
          .max(500)
          .default([]),
      }),
    )
    .max(20)
    .default([]),
});
export type BrowserStorageState = z.infer<typeof BrowserStorageStateSchema>;

/**
 * A cookie belongs to a session when its host is an allowed host, a parent of one, or another
 * subdomain of the same product site. Sign-in providers on the product's own domain (Clerk's
 * `clerk.product.com`) keep the long-lived session there; dropping it signs the next session out.
 * Hosted tenants stay apart: `a.vercel.app` and `b.vercel.app` are different sites.
 */
function cookieFitsAllowedOrigins(domain: string, allowedOrigins: string[]): boolean {
  const host = domain.replace(/^\./, "").toLocaleLowerCase();
  const site = getDomain(host, { allowPrivateDomains: true });
  return allowedOrigins.some((origin) => {
    const hostname = new URL(normalizeAllowedOrigin(origin)).hostname.toLocaleLowerCase();
    return hostname === host || hostname.endsWith(`.${host}`) ||
      (site !== null && site === getDomain(hostname, { allowPrivateDomains: true }));
  });
}

export function assertStorageStateAllowed(
  rawState: BrowserStorageState,
  allowedOrigins: string[],
): BrowserStorageState {
  const state = BrowserStorageStateSchema.parse(rawState);
  const origins = allowedOrigins.map((origin) => new URL(normalizeAllowedOrigin(origin)));
  for (const cookie of state.cookies) {
    if (!cookieFitsAllowedOrigins(cookie.domain, allowedOrigins)) {
      throw new CapturePolicyError("navigation_blocked");
    }
  }
  for (const storage of state.origins) {
    const origin = normalizeAllowedOrigin(storage.origin);
    if (!origins.some((allowed) => allowed.origin === origin)) {
      throw new CapturePolicyError("navigation_blocked");
    }
  }
  return state;
}

/** Keeps cookies and storage that belong on the new origin list; drops the rest. */
export function storageStateForAllowedOrigins(
  rawState: BrowserStorageState,
  allowedOrigins: string[],
): BrowserStorageState {
  const state = BrowserStorageStateSchema.parse(rawState);
  const allowed = new Set(allowedOrigins.map((origin) => normalizeAllowedOrigin(origin)));
  return {
    cookies: state.cookies.filter((cookie) =>
      cookieFitsAllowedOrigins(cookie.domain, allowedOrigins),
    ),
    origins: state.origins.filter((item) => allowed.has(normalizeAllowedOrigin(item.origin))),
  };
}

/**
 * Artifact name for the presented version of a recording — the one post-production produced.
 *
 * Defined here because two sides depend on it: the worker names the artifact, and draft assembly
 * prefers it over the raw capture. A string literal in both places would drift the first time either
 * changed.
 */
export const PRESENTED_RECORDING_NAME = "capture-presented";

/**
 * The explorer's own observation, which is not a deliverable.
 *
 * A recorded screenshot refuses to capture a half-loaded page, and should. The agent's observation
 * is the opposite case: it is how the agent sees, and a product whose demo waits on a three-minute
 * search spends much of the run behind exactly the full-screen loader that check rejects. Refusing
 * to let the agent look at a loader ends the run instead of waiting through it.
 */
export const AGENT_OBSERVATION_NAME = "agent-observation";

/** True when an object key holds the presented recording rather than the raw one. */
export function isPresentedRecording(objectKey: string): boolean {
  return objectKey.includes(`-${PRESENTED_RECORDING_NAME}.`);
}

export type CaptureArtifact = {
  kind: "screenshot" | "video" | "trace" | "diagnostic";
  name: string;
  contentType: string;
  body: Uint8Array;
  redactionPassed: boolean;
};

export type StoredCaptureArtifact = Omit<CaptureArtifact, "body"> & {
  handle: string;
  checksum: string;
  sizeBytes: number;
};

export type CaptureActionLog = {
  index: number;
  type: CaptureStep["type"];
  status: "succeeded" | "failed" | "blocked";
  startedAt: string;
  completedAt: string;
  detail: string;
};

/**
 * Where and when the agent acted, relative to the start of the recording. The agent generates these
 * interactions, so this is ground truth rather than the sampled guess a desktop recorder infers
 * from OS hooks. Post-production uses it to zoom where the viewer should be looking.
 */
/** What the pointer looked like. Read from the element's computed style, not guessed. */
export type CapturePointerShape = "arrow" | "hand" | "text";

/**
 * A single moment of pointer activity, sampled from the page's own events. Dense enough to be a
 * path, which is what the renderer's cursor smoothing and camera-follow are built to consume.
 */
export type CapturePointerSample = {
  atMs: number;
  /** Fraction of the viewport, 0 to 1. */
  x: number;
  y: number;
  kind: "move" | "down" | "up";
  /** The cursor the page was showing at this instant, from the hovered element's computed style. */
  shape?: CapturePointerShape;
};

export type CapturePointer = {
  atMs: number;
  /** Fraction of the captured frame width, 0 to 1. */
  x: number;
  /** Fraction of the captured frame height, 0 to 1. */
  y: number;
  shape: CapturePointerShape;
  /**
   * Size of what was clicked, as a fraction of the viewport. Post-production uses it to choose how
   * far to zoom: a small control needs a closer look than a full-width banner does.
   */
  width: number;
  height: number;
  /**
   * The panel around what was clicked (the card, form or list holding it), top-left box as fractions of the
   * viewport. Clicks inside one panel are one shot even when they are further apart than the shot radius.
   */
  container?: { x: number; y: number; width: number; height: number };
};

/** Browser intent recorded beside the pixels, without typed values or page content. */
export type CaptureSemanticAction = {
  /** End of a continuous interaction, such as typing, on the source clock. */
  endMs?: number;
  /** Result framing in normalized viewport coordinates; independent of the last click. */
  focus?: { x: number; y: number; width: number; height: number };
  atMs: number;
  type:
    | "click"
    | "double_click"
    | "right_click"
    | "type"
    | "key"
    | "scroll"
    | "navigate"
    | "setup"
    | "action"
    | "emphasis"
    | "result";
  ref: string | null;
  element: string;
};

export type CaptureResult = {
  status: "succeeded" | "failed" | "blocked" | "reauth_required" | "cancelled";
  artifacts: StoredCaptureArtifact[];
  actionCount: number;
  actionLog: CaptureActionLog[];
  pointerTrail: CapturePointer[];
  /** Dense pointer path for post-production; empty when the driver does not track it. */
  pointerTelemetry: CapturePointerSample[];
  /** Semantic intent used by post-production to frame interactions, never typed values. */
  semanticTimeline: CaptureSemanticAction[];
  /**
   * Which recorder produced the video, when the driver reports it.
   *
   * `poll` is a four-frames-a-second slideshow, chosen silently whenever the browser's DevTools
   * address is unreachable — which is every remote grid. It is surfaced here because the difference
   * is invisible until someone watches the result and calls it laggy.
   */
  recordingMode?: "screencast" | "poll";
  diagnosticCode?: string;
};

export type CaptureValue =
  | { kind: "plain"; value: string }
  | { kind: "secret"; secretHandle: string };

export type BrowserExecutionContext = {
  workspaceId: string;
  runId: string;
  session: {
    expiresAt: Date;
    encryptedStateHandle: string;
  };
  values: ReadonlyMap<string, CaptureValue>;
  signal?: AbortSignal;
};

export interface SecretMaterialResolver {
  resolveSessionState(workspaceId: string, handle: string): Promise<Uint8Array>;
  resolveValue(workspaceId: string, handle: string): Promise<Uint8Array>;
  persistSessionState?(workspaceId: string, handle: string, state: Uint8Array): Promise<void>;
}

export interface CaptureArtifactSink {
  put(
    workspaceId: string,
    runId: string,
    artifact: CaptureArtifact,
  ): Promise<StoredCaptureArtifact>;
}

export type BrowserContextOptions = {
  /** Headed local browsers may be capped by the physical display. Updates viewport to the measured size. */
  fitViewportToWindow?: boolean;
  viewport: { width: number; height: number };
  allowedOrigins: string[];
  sessionState: Uint8Array;
  onNavigation: (target: string, redirectCount: number) => void;
  allowDownload: false;
  allowPopup: false;
};

export interface BrowserContextDriver {
  goto(url: string): Promise<void>;
  click(locator: CaptureLocator): Promise<void>;
  fill(locator: CaptureLocator, value: string): Promise<void>;
  select(locator: CaptureLocator, value: string): Promise<void>;
  waitFor(locator: CaptureLocator): Promise<void>;
  assertVisible(locator: CaptureLocator): Promise<void>;
  mask(locator: CaptureLocator, mode?: "mask" | "blur"): Promise<void>;
  /** Blurs contact details already on the page and anything matching that appears later. */
  redactSensitiveText(): Promise<void>;
  screenshot(name: string, fullPage: boolean): Promise<CaptureArtifact>;
  computer(actions: readonly ComputerAction[]): Promise<void>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<CaptureArtifact>;
  stopTrace(): Promise<CaptureArtifact | null>;
  /** Cookies and origin storage the next run can hydrate, scoped to allowed origins. */
  exportStorageState(): Promise<BrowserStorageState>;
  /** Interactions recorded while the screencast was running, if the driver tracks them. */
  pointerTrail?(): CapturePointer[];
  /** Dense pointer path recorded from page events, if the driver tracks it. */
  pointerTelemetry?(): CapturePointerSample[];
  /** Where email addresses were on screen at each read while recording, as fractions of the viewport. */
  identitySightings?(): Array<{ atMs: number; rects: Array<{ x: number; y: number; width: number; height: number }> }>;
  dispose(): Promise<void>;
}

export interface BrowserDriver {
  createContext(options: BrowserContextOptions): Promise<BrowserContextDriver>;
}

export interface BrowserExecutor {
  execute(recipe: CaptureRecipe, context: BrowserExecutionContext): Promise<CaptureResult>;
}

export type CaptureExplorer = (input: {
  driver: BrowserContextDriver;
  workspaceId: string;
  runId: string;
  goals: string[];
  /** The on-screen state that means the flow succeeded, and the agent's signal to stop. */
  win?: string;
  tutorial?: string;
  sourceAvailable?: boolean;
  maximumActions: number;
  signal: AbortSignal;
}) => Promise<void>;

export class CapturePolicyError extends Error {
  /**
   * `reason` names what was refused, never what was on the page.
   *
   * The code alone reaches the run as `action_blocked`, which says a demo died without saying which
   * action killed it — an agent that presses one unrecognised key loses the whole recording and
   * leaves nothing to act on. Action types and key names are ours, not the tenant's, so they are
   * safe to carry.
   */
  constructor(
    readonly code: "navigation_blocked" | "action_blocked" | "recipe_invalid",
    readonly reason?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "CapturePolicyError";
  }
}

export class CaptureSessionError extends Error {
  constructor(readonly code: "session_expired" | "reauth_required") {
    super(code);
    this.name = "CaptureSessionError";
  }
}

const destructiveTerms = [
  "delete",
  "remove account",
  "remove user",
  "billing",
  "subscription",
  "payment",
  "credential",
  "api key",
  "invite user",
  "manage users",
] as const;

function normalizedPolicyText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}

export function assertLocatorAllowed(locator: CaptureLocator): void {
  const normalized = normalizedPolicyText(locator.value);
  const matched = destructiveTerms.find((term) => normalized.includes(term));
  if (matched) {
    /**
     * Name the term, never the text it was found in.
     *
     * A refusal that says only "blocked" sends whoever hit it hunting through a product's whole
     * screen for the reason, and the text itself is the customer's — it can hold names, addresses
     * and anything else the page had on it. The term is ours, is one of a short fixed list, and is
     * the only part anybody needs in order to act.
     */
    throw new CapturePolicyError("action_blocked", `matched policy term "${matched}"`);
  }
}

/**
 * The shape of an allowed origin: https on a public name, or a development server on this machine
 * (`isLocalDevelopmentUrl`). This is not where loopback is refused: Toru's server only lets a local
 * origin through for the user's own Chrome, and its hosted runtime refuses loopback names outright.
 */
export function normalizeAllowedOrigin(rawOrigin: string): string {
  const origin = new URL(rawOrigin);
  if (origin.username || origin.password) throw new CapturePolicyError("recipe_invalid");
  if (isLocalDevelopmentUrl(origin.href)) return origin.origin;
  const hostname = origin.hostname.replace(/^\[|\]$/gu, "");
  if (origin.protocol !== "https:" || isIP(hostname) > 0) {
    throw new CapturePolicyError("recipe_invalid");
  }
  return origin.origin;
}

/**
 * A recipe runs in Toru's own browser, so its origins stay public https, plus the `localhost` and
 * `127.0.0.1` fixtures local test runs serve. The wider development set (`[::1]`, `*.localhost`,
 * `*.test`) is only for the user's own Chrome.
 */
export function normalizeRecipeOrigin(rawOrigin: string): string {
  const origin = normalizeAllowedOrigin(rawOrigin);
  const { protocol, hostname } = new URL(origin);
  const loopbackFixture = hostname === "localhost" || hostname === "127.0.0.1";
  if (!loopbackFixture && (protocol !== "https:" || isLocalDevelopmentUrl(origin))) {
    throw new CapturePolicyError("recipe_invalid");
  }
  return origin;
}

/**
 * Production captures follow Clerk, Turnstile, and product APIs onto hosts
 * nobody can enumerate ahead of time. Allow any public hostname; refuse only
 * credentials-in-URL, destructive paths, and private/internal networks.
 */
export function assertUrlAllowed(_recipe: CaptureRecipe, target: string): void {
  const url = new URL(target);
  if (url.username || url.password) throw new CapturePolicyError("navigation_blocked");
  const targetHost = url.hostname.toLocaleLowerCase();
  if (
    isInternalNavigationHost(targetHost) ||
    destructiveTerms.some((term) => normalizedPolicyText(url.pathname).includes(term))
  ) {
    throw new CapturePolicyError("navigation_blocked", targetHost);
  }
}

export function assertRecipePolicy(rawRecipe: CaptureRecipe): CaptureRecipe {
  const recipe = CaptureRecipeSchema.parse(rawRecipe);
  if (recipe.steps.length > recipe.limits.maximumActions) {
    throw new CapturePolicyError("recipe_invalid");
  }
  for (const step of recipe.steps) {
    if (step.type === "goto") assertUrlAllowed(recipe, step.url);
    if ("locator" in step) assertLocatorAllowed(step.locator);
    if (step.type === "explore") {
      for (const goal of step.goals) assertLocatorAllowed({ strategy: "text", value: goal });
    }
  }
  for (const rule of recipe.redactionRules) assertLocatorAllowed(rule.locator);
  return recipe;
}

/**
 * The internal code behind a failure, when the message is one and not page text.
 *
 * Same reasoning as the policy reason above: an explore step that dies as "browser_execution_failed"
 * records that a demo died without saying what killed it. Internal codes are single lowercase
 * tokens, so requiring that shape keeps page content — which is where secrets and user data live —
 * out of the action log by construction.
 */
function failureCodeDetail(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = "code" in error && typeof error.code === "string" ? error.code : error.message;
  return /^[a-z][a-z0-9_]{2,63}$/u.test(code) ? code : null;
}

function executionFailureCode(error: unknown): string {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.message
        : "";
  return [
    "wait_timeout",
    "element_not_visible",
    "option_not_found",
    "invalid element state",
    "element not interactable",
    "stale element reference",
    "bot_challenge",
    "still_on_login",
    "loader_visible",
    "video_has_no_frames",
    "computer_use_win_not_visible",
    "browser_use_win_not_visible",
    "computer_use_no_actions",
    "computer_use_verification_invalid",
    "agent_budget_exhausted",
    "agent_budget_pricing_unknown",
    "model_provider_budget_exhausted",
  ].includes(code)
    ? code.replaceAll(" ", "_")
    : "browser_execution_failed";
}

function resultForFailure(
  status: CaptureResult["status"],
  diagnosticCode: string,
  actionLog: CaptureActionLog[],
  artifacts: StoredCaptureArtifact[],
  pointerTrail: CapturePointer[] = [],
  pointerTelemetry: CapturePointerSample[] = [],
  semanticTimeline: CaptureSemanticAction[] = [],
): CaptureResult {
  return {
    status,
    diagnosticCode,
    actionCount: actionLog.length,
    actionLog,
    artifacts,
    pointerTrail,
    pointerTelemetry,
    semanticTimeline,
  };
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class BrowserExecutionEngine implements BrowserExecutor {
  constructor(
    readonly driver: BrowserDriver,
    readonly secrets: SecretMaterialResolver,
    readonly artifactSink: CaptureArtifactSink,
    readonly killSwitch: () => boolean = () => false,
    readonly explore?: CaptureExplorer,
  ) {}

  async execute(
    rawRecipe: CaptureRecipe,
    context: BrowserExecutionContext,
  ): Promise<CaptureResult> {
    let recipe: CaptureRecipe;
    try {
      recipe = assertRecipePolicy(rawRecipe);
    } catch (error) {
      /**
       * Report which rule refused, not that some rule did.
       *
       * Policy raises `navigation_blocked` for a host and `recipe_invalid` for a malformed recipe,
       * and flattening both into the second sends whoever hit it reading the recipe for a fault
       * that is in the URL. The codes are ours and carry no page content.
       */
      return resultForFailure(
        "blocked",
        error instanceof CapturePolicyError ? error.code : "recipe_invalid",
        [],
        [],
      );
    }
    if (recipe.workspaceId !== context.workspaceId) {
      return resultForFailure("blocked", "workspace_mismatch", [], []);
    }
    if (context.session.expiresAt <= new Date()) {
      return resultForFailure("reauth_required", "session_expired", [], []);
    }
    if (this.killSwitch()) return resultForFailure("cancelled", "kill_switch", [], []);

    let sessionState: Uint8Array | undefined;
    let browserContext: BrowserContextDriver | undefined;
    const actionLog: CaptureActionLog[] = [];
    const artifacts: StoredCaptureArtifact[] = [];
    const deadline = AbortSignal.timeout(recipe.limits.maximumDurationMs);
    const signal = context.signal ? AbortSignal.any([deadline, context.signal]) : deadline;
    try {
      sessionState = await this.secrets.resolveSessionState(
        context.workspaceId,
        context.session.encryptedStateHandle,
      );
      browserContext = await this.driver.createContext({
        viewport: recipe.viewport,
        allowedOrigins: recipe.allowedOrigins.map(normalizeAllowedOrigin),
        sessionState,
        allowDownload: false,
        allowPopup: false,
        onNavigation: (target, redirectCount) => {
          if (redirectCount > recipe.limits.maximumRedirects) {
            throw new CapturePolicyError("navigation_blocked", "redirect_limit");
          }
          assertUrlAllowed(recipe, target);
        },
      });
      for (const [index, step] of recipe.steps.entries()) {
        if (signal.aborted) throw signal.reason;
        if (this.killSwitch()) throw new DOMException("Kill switch enabled", "AbortError");
        const startedAt = new Date();
        try {
          await withAbort(
            this.#executeStep(browserContext, recipe, step, context, artifacts, signal),
            signal,
          );
          actionLog.push({
            index,
            type: step.type,
            status: "succeeded",
            startedAt: startedAt.toISOString(),
            completedAt: new Date().toISOString(),
            detail: this.#safeDetail(step),
          });
        } catch (error) {
          actionLog.push({
            index,
            type: step.type,
            status: error instanceof CapturePolicyError ? "blocked" : "failed",
            startedAt: startedAt.toISOString(),
            completedAt: new Date().toISOString(),
            // The policy reason names the refused action, never page content, and it is the only
            // record of why: the run keeps just the code, and "action_blocked" on an explore step
            // says a demo died without saying what killed it.
            detail:
              error instanceof CapturePolicyError && error.reason
                ? `${this.#safeDetail(step)} — ${error.reason}`
                : failureCodeDetail(error)
                  ? `${this.#safeDetail(step)} — ${failureCodeDetail(error)}`
                  : this.#safeDetail(step),
          });
          // Local diagnostics only: the action log keeps codes, so an unrecognised failure would
          // otherwise reach the operator as a bare browser_execution_failed.
          if (!(error instanceof CapturePolicyError) && !failureCodeDetail(error)) {
            console.error(
              JSON.stringify({
                level: "error",
                service: "browser",
                message: "capture step failed",
                step: step.type,
                index,
                error:
                  error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : null,
              }),
            );
          }
          throw error;
        }
      }
      for (const rule of recipe.redactionRules) {
        try {
          await browserContext.mask(rule.locator, rule.mode);
        } catch (error) {
          if (rule.required) throw error;
        }
      }
      await this.#persistSession(browserContext, context, recipe.allowedOrigins);
      if (recipe.output.trace) {
        const trace = await browserContext.stopTrace();
        if (trace) {
          if (!trace.redactionPassed) throw new Error("trace_redaction_failed");
          artifacts.push(await this.artifactSink.put(context.workspaceId, context.runId, trace));
        }
      }
      return {
        status: "succeeded",
        artifacts,
        actionCount: actionLog.length,
        actionLog,
        pointerTrail: browserContext.pointerTrail?.() ?? [],
        pointerTelemetry: browserContext.pointerTelemetry?.() ?? [],
        ...(() => {
          const mode = (browserContext as { recordingMode?: "screencast" | "poll" }).recordingMode;
          return mode ? { recordingMode: mode } : {};
        })(),
        semanticTimeline:
          (
            browserContext as BrowserContextDriver & {
              semanticTimeline?: () => CaptureSemanticAction[];
            }
          ).semanticTimeline?.() ?? [],
      };
    } catch (error) {
      if (error instanceof CapturePolicyError) {
        return resultForFailure("blocked", error.code, actionLog, artifacts);
      }
      if (error instanceof CaptureSessionError) {
        return resultForFailure("reauth_required", error.code, actionLog, artifacts);
      }
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return resultForFailure(
          context.signal?.aborted ? "cancelled" : "failed",
          context.signal?.aborted ? "cancelled" : "execution_timeout",
          actionLog,
          artifacts,
        );
      }
      return resultForFailure("failed", executionFailureCode(error), actionLog, artifacts);
    } finally {
      sessionState?.fill(0);
      await browserContext?.dispose().catch(() => undefined);
    }
  }

  async #executeStep(
    driver: BrowserContextDriver,
    recipe: CaptureRecipe,
    step: CaptureStep,
    context: BrowserExecutionContext,
    artifacts: StoredCaptureArtifact[],
    signal: AbortSignal,
  ): Promise<void> {
    switch (step.type) {
      case "goto":
        assertUrlAllowed(recipe, step.url);
        await driver.goto(step.url);
        break;
      case "click":
        assertLocatorAllowed(step.locator);
        await driver.click(step.locator);
        break;
      case "fill":
      case "select": {
        assertLocatorAllowed(step.locator);
        const resolved = await this.#resolveValue(step.valueHandle, step.locator, context, driver);
        try {
          if (step.type === "fill") await driver.fill(step.locator, resolved.value);
          else await driver.select(step.locator, resolved.value);
          if (resolved.secret) await driver.mask(step.locator, "mask");
        } finally {
          resolved.bytes?.fill(0);
        }
        break;
      }
      case "waitFor":
        await driver.waitFor(step.locator);
        if (step.locator.strategy === "field" && step.locator.value === "signed_in") {
          await this.#persistSession(driver, context, recipe.allowedOrigins);
        }
        break;
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, step.milliseconds));
        break;
      case "assertVisible":
        await driver.assertVisible(step.locator);
        break;
      case "mask":
        await driver.mask(step.locator, "mask");
        break;
      case "screenshot": {
        await this.#applyRedactions(driver, recipe);
        const artifact = await driver.screenshot(step.name, step.fullPage);
        if (!artifact.redactionPassed) throw new Error("screenshot_redaction_failed");
        artifacts.push(await this.artifactSink.put(context.workspaceId, context.runId, artifact));
        break;
      }
      case "startRecording":
        await this.#applyRedactions(driver, recipe);
        await driver.startRecording();
        break;
      case "stopRecording": {
        await this.#applyRedactions(driver, recipe);
        const artifact = await driver.stopRecording();
        if (!artifact.redactionPassed) throw new Error("video_redaction_failed");
        artifacts.push(await this.artifactSink.put(context.workspaceId, context.runId, artifact));
        break;
      }
      case "explore":
        if (!this.explore) throw new Error("computer_use_unavailable");
        await this.explore({
          driver,
          workspaceId: context.workspaceId,
          runId: context.runId,
          goals: step.goals,
          ...(step.win ? { win: step.win } : {}),
          ...(step.tutorial ? { tutorial: step.tutorial } : {}),
          sourceAvailable: step.sourceAvailable ?? false,
          maximumActions: recipe.limits.maximumActions,
          signal,
        });
        break;
    }
  }

  async #persistSession(
    driver: BrowserContextDriver,
    context: BrowserExecutionContext,
    allowedOrigins: string[],
  ): Promise<void> {
    if (!this.secrets.persistSessionState) return;
    try {
      const exported = storageStateForAllowedOrigins(
        await driver.exportStorageState(),
        allowedOrigins.map(normalizeAllowedOrigin),
      );
      if (exported.cookies.length === 0 && exported.origins.length === 0) return;
      const bytes = new TextEncoder().encode(JSON.stringify(exported));
      try {
        await this.secrets.persistSessionState(
          context.workspaceId,
          context.session.encryptedStateHandle,
          bytes,
        );
      } finally {
        bytes.fill(0);
      }
    } catch {
      // A missed write-back must not fail a capture that already signed in.
    }
  }

  async #applyRedactions(driver: BrowserContextDriver, recipe: CaptureRecipe): Promise<void> {
    /**
     * Rules name elements that exist when the rule runs. A demo's most sensitive content does not:
     * a lead-search result table is empty until the agent searches, and by then every pass has
     * already happened. So a live redactor is installed alongside them, and it keeps working while
     * the agent explores.
     */
    if (recipe.redactSensitiveText) await driver.redactSensitiveText();
    for (const rule of recipe.redactionRules) {
      try {
        await driver.mask(rule.locator, rule.mode);
      } catch (error) {
        if (rule.required) throw error;
      }
    }
  }

  async #resolveValue(
    handle: string,
    locator: CaptureLocator,
    context: BrowserExecutionContext,
    driver: BrowserContextDriver,
  ): Promise<{ value: string; secret: boolean; bytes?: Uint8Array }> {
    const value = context.values.get(handle);
    if (!value) throw new CapturePolicyError("recipe_invalid");
    if (value.kind === "plain") return { value: value.value, secret: false };
    const bytes = await this.secrets.resolveValue(context.workspaceId, value.secretHandle);
    await driver.mask(locator, "mask");
    return { value: new TextDecoder().decode(bytes), secret: true, bytes };
  }

  #safeDetail(step: CaptureStep): string {
    if (step.type === "goto") return new URL(step.url).origin;
    if (step.type === "screenshot") return step.name;
    if (step.type === "explore") return `${step.goals.length} product goals`;
    if ("locator" in step) return `${step.locator.strategy}:[redacted-locator]`;
    return step.type;
  }
}

export * from "./browser-toolset.js";
export * from "./demo-recipe.js";
export { isLocalDevelopmentUrl, sameLocalHost } from "./local-development.js";
export * from "./screencast.js";
export * from "./webdriver.js";
