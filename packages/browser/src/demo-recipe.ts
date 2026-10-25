import {
  type CaptureRecipe,
  CaptureRecipeSchema,
  type CaptureStep,
  normalizeRecipeOrigin,
} from "./index.js";

/**
 * Builds a capture recipe from product evidence instead of asking someone to author one by hand.
 *
 * `suggestedDemoFlows` is already produced by product normalisation and has never been consumed.
 * The flows are goals, not guessed selectors. A visual agent decides how to demonstrate them from
 * the live product screen, so the same recipe shape works across products.
 */

/**
 * The worker resolves a `credential:<id>` handle by looking that id up in the encrypted credential
 * store (`captureValues` in the browser worker, then `retrieveForAdapter`). The id is the stored
 * credential's own identifier — a friendly name resolves to nothing and the fill step is refused —
 * so the recipe can only be built after the login has been stored.
 */
export function credentialHandle(credentialId: string): string {
  return `credential:${credentialId}`;
}

export type DemoLoginCredentials = {
  loginUrl: string;
  emailCredentialId: string;
  passwordCredentialId: string;
  /** HTTPS origins needed to render the sign-in provider's client-side form. */
  resourceOrigins?: string[];
  /**
   * Hosted providers such as Clerk ask for the address, submit, then ask for the password on a
   * second screen. Submitting a single-step form after only the address would fail validation, so
   * the shape has to be known rather than guessed.
   */
  flow?: "single_step" | "two_step";
};

export type DemoRecipeInput = {
  agentRequestId?: string | undefined;
  productName: string;
  productUrl: string;
  tutorial?: string;
  sourceAvailable?: boolean;
  /** Omit to record the product without signing in. */
  login?: DemoLoginCredentials;
  demoFlows: string[];
  /**
   * What the finished flow looks like on screen, from the demo plan.
   *
   * Optional so a caller without a plan still records something, but a capture without one is the
   * agent guessing when it is done — and it guesses early.
   */
  win?: string;
  viewport?: { width: number; height: number };
  maximumFlows?: number;
};

export type DemoRecipeDraft = Omit<CaptureRecipe, "id" | "workspaceId" | "version">;

const defaultViewport = { width: 1920, height: 1080 };
const settleMs = 1_200;
/**
 * How long the recording keeps running after the agent stops acting.
 *
 * Long enough for a search to come back and render, because that result is the demo. Post-production
 * speeds up the agent's thinking pauses but deliberately leaves this one alone: it only compresses
 * gaps between two pointer events, and nothing moves after the last one.
 */
const payoffMs = 5_000;

/**
 * Login is the one place the recipe touches a secret. It never carries the value — only a handle
 * the executor resolves through `SecretMaterialResolver`, which also masks the field afterwards.
 */
const emailField = { strategy: "field", value: "email" } as const;
const passwordField = { strategy: "field", value: "password" } as const;
const submitButton = { strategy: "field", value: "submit" } as const;

function loginSteps(login: DemoLoginCredentials): CaptureStep[] {
  const advance: CaptureStep[] =
    login.flow === "two_step"
      ? [
          { type: "wait", milliseconds: 800 },
          { type: "click", locator: submitButton },
          { type: "wait", milliseconds: 4_000 },
          { type: "waitFor", locator: passwordField },
        ]
      : [];
  // Open the app origin, not /sign-in. A hydrated Clerk session already on
  // that origin would be thrown away by forcing the hosted sign-in (and
  // Turnstile) every run.
  const appOrigin = new URL(login.loginUrl).origin;
  return [
    { type: "goto", url: appOrigin },
    { type: "wait", milliseconds: settleMs },
    { type: "waitFor", locator: emailField },
    {
      type: "fill",
      locator: emailField,
      valueHandle: credentialHandle(login.emailCredentialId),
    },
    ...advance,
    {
      type: "fill",
      locator: passwordField,
      valueHandle: credentialHandle(login.passwordCredentialId),
    },
    { type: "waitFor", locator: { strategy: "field", value: "signed_in" } },
  ];
}

/**
 * One flow to record and the state that means it worked. Structural rather than imported from the
 * contracts package: this package needs the shape, not the schema, and staying dependency-free
 * keeps the recipe builder usable from anywhere.
 */
export type DemoRecipeFlow = { label: string; win: string };

/**
 * One recipe per flow, because one recording per flow is what a demo is.
 *
 * A single run given three goals produced one long video that visited all three and landed on none:
 * the agent's budget went on the first two and the third was where it ran out. Separate recordings
 * give each flow the whole budget, its own win to stop at, and a clip short enough to attach to a
 * post — which is what these are for.
 *
 * The login runs again in each, because they are independent sessions. That is the cost, and it buys
 * a failure in one flow not taking the others with it.
 */
export function buildDemoRecipeDrafts(
  input: Omit<DemoRecipeInput, "demoFlows" | "win"> & { flows: readonly DemoRecipeFlow[] },
): DemoRecipeDraft[] {
  const flows = input.flows
    .map((flow) => ({ label: flow.label.trim(), win: flow.win.trim() }))
    .filter((flow) => flow.label.length > 2)
    .slice(0, input.maximumFlows ?? 3);

  if (flows.length === 0) return [buildDemoRecipeDraft({ ...input, demoFlows: [] })];

  return flows.map((flow) => {
    const draft = buildDemoRecipeDraft({
      ...input,
      demoFlows: [flow.label],
      ...(flow.win ? { win: flow.win } : {}),
    });
    // Named for what it records, so a workspace with several can tell them apart in a list.
    return { ...draft, name: `${draft.name}: ${flow.label}`.slice(0, 120) };
  });
}

export function buildDemoRecipeDraft(input: DemoRecipeInput): DemoRecipeDraft {
  const productOrigin = normalizeRecipeOrigin(new URL(input.productUrl).origin);
  const loginOrigin = input.login
    ? normalizeRecipeOrigin(new URL(input.login.loginUrl).origin)
    : productOrigin;
  const viewport = input.viewport ?? defaultViewport;
  const maximumFlows = input.maximumFlows ?? 3;

  const flows = input.demoFlows
    .map((flow) => flow.trim())
    .filter((flow) => flow.length > 2)
    .slice(0, maximumFlows);

  // After sign-in the session is on the app host. Sending the browser to the marketing site
  // (often the brand profile URL) drops the demo on a homepage with nothing to record.
  const recordUrl = input.login ? new URL(input.login.loginUrl).origin : input.productUrl;
  const steps: CaptureStep[] = [
    ...(input.login ? loginSteps(input.login) : []),
    { type: "goto", url: recordUrl },
    { type: "wait", milliseconds: settleMs },
    ...(input.login
      ? [{ type: "waitFor" as const, locator: { strategy: "field" as const, value: "signed_in" } }]
      : []),
    { type: "startRecording" },
    {
      type: "explore",
      goals:
        flows.length > 0
          ? flows
          : [
              `Discover and demonstrate the main value of ${input.productName.trim() || "the product"}`,
            ],
      ...(input.win?.trim() ? { win: input.win.trim() } : {}),
      ...(input.tutorial?.trim() ? { tutorial: input.tutorial.trim() } : {}),
      sourceAvailable: input.sourceAvailable ?? false,
    },
    // The agent's last act is usually the one that matters — submitting the search, opening the
    // result — and it stops as soon as it has performed it. Stopping the recording there ends the
    // demo on the spinner, a frame before the thing the demo exists to show. This waits for the
    // payoff to arrive and be seen.
    { type: "wait", milliseconds: payoffMs },
    { type: "stopRecording" },
    { type: "screenshot", name: "product-demo", fullPage: false },
  ];

  const allowedOrigins = [
    ...new Set([
      productOrigin,
      loginOrigin,
      ...(input.login?.resourceOrigins ?? []).map(normalizeRecipeOrigin),
    ]),
  ];
  const draft: DemoRecipeDraft = {
    name: `${input.productName.trim() || "Product"} demo`.slice(0, 120),
    ...(input.agentRequestId ? { agentRequestId: input.agentRequestId } : {}),
    allowedOrigins,
    viewport,
    steps,
    redactionRules: [{ locator: passwordField, mode: "mask", required: false }],
    // A demo of this product puts other people's contact details on screen, minutes after any
    // locator-based rule has run.
    redactSensitiveText: true,
    output: { screenshots: true, video: true, trace: true },
    // Include reconnaissance and multi-step workflows; actions and retries remain bounded.
    limits: { maximumDurationMs: 600_000, maximumActions: 100, maximumRedirects: 3 },
  };

  // Fail here rather than at execution time if the generated shape ever drifts from policy.
  CaptureRecipeSchema.parse({
    ...draft,
    id: "00000000-0000-4000-8000-000000000000",
    workspaceId: "00000000-0000-4000-8000-000000000000",
    version: 1,
  });
  return draft;
}
