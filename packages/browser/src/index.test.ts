import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertRecipePolicy,
  assertStorageStateAllowed,
  assertUrlAllowed,
  type BrowserContextDriver,
  type BrowserContextOptions,
  type BrowserDriver,
  BrowserExecutionEngine,
  type BrowserStorageState,
  type CaptureArtifact,
  type CaptureArtifactSink,
  type CaptureLocator,
  CaptureRecipeSchema,
  CaptureSessionError,
  type SecretMaterialResolver,
  storageStateForAllowedOrigins,
} from "./index.js";

const recipe = CaptureRecipeSchema.parse({
  id: "019fe3f6-6b52-7f4e-aae4-46a6ccbff3c2",
  workspaceId: "019fe3f6-9a9a-7cb1-bb2e-d342309e7f09",
  version: 1,
  name: "Dashboard screenshot",
  allowedOrigins: ["https://demo.example.com"],
  viewport: { width: 1440, height: 900 },
  steps: [
    { type: "goto", url: "https://demo.example.com/dashboard" },
    {
      type: "fill",
      locator: { strategy: "label", value: "Access token" },
      valueHandle: "token",
    },
    { type: "screenshot", name: "dashboard", fullPage: false },
  ],
  redactionRules: [
    {
      locator: { strategy: "testId", value: "customer-email" },
      mode: "blur",
      required: true,
    },
  ],
  output: { screenshots: true, video: false, trace: true },
  limits: { maximumDurationMs: 1_000, maximumActions: 10, maximumRedirects: 2 },
});

class FakeContext implements BrowserContextDriver {
  readonly calls: string[] = [];
  disposed = false;
  filledValue = "";
  exportedState: {
    cookies: BrowserStorageState["cookies"];
    origins: BrowserStorageState["origins"];
  } = { cookies: [], origins: [] };

  constructor(
    readonly options: BrowserContextOptions,
    readonly behavior: "success" | "redirect" | "expired" | "hang" = "success",
  ) {}

  async goto(url: string) {
    if (this.behavior === "redirect") {
      this.options.onNavigation("http://169.254.169.254/steal", 1);
    }
    if (this.behavior === "expired") throw new CaptureSessionError("reauth_required");
    this.options.onNavigation(url, 0);
    this.calls.push(`goto:${url}`);
  }

  async click(locator: CaptureLocator) {
    this.calls.push(`click:${locator.strategy}`);
  }

  async fill(locator: CaptureLocator, value: string) {
    this.filledValue = value;
    this.calls.push(`fill:${locator.strategy}`);
  }

  async select(locator: CaptureLocator, _value: string) {
    this.calls.push(`select:${locator.strategy}`);
  }

  async waitFor(locator: CaptureLocator) {
    this.calls.push(`wait:${locator.strategy}`);
    if (this.behavior === "hang") await new Promise(() => undefined);
  }

  async assertVisible(locator: CaptureLocator) {
    this.calls.push(`assert:${locator.strategy}`);
  }

  async mask(locator: CaptureLocator, mode = "mask") {
    this.calls.push(`mask:${mode}:${locator.strategy}`);
  }

  async redactSensitiveText() {
    this.calls.push("redactSensitiveText");
  }

  async screenshot(name: string, _fullPage: boolean): Promise<CaptureArtifact> {
    this.calls.push(`screenshot:${name}`);
    return {
      kind: "screenshot",
      name,
      contentType: "image/png",
      body: new Uint8Array([1, 2, 3]),
      redactionPassed: true,
    };
  }

  async computer() {}

  async startRecording() {
    this.calls.push("record:start");
  }

  async stopRecording(): Promise<CaptureArtifact> {
    this.calls.push("record:stop");
    return {
      kind: "video",
      name: "demo",
      contentType: "video/webm",
      body: new Uint8Array([4, 5, 6]),
      redactionPassed: true,
    };
  }

  async stopTrace(): Promise<CaptureArtifact> {
    this.calls.push("trace:stop");
    return {
      kind: "trace",
      name: "trace",
      contentType: "application/zip",
      body: new Uint8Array([7, 8, 9]),
      redactionPassed: true,
    };
  }

  async exportStorageState() {
    this.calls.push("exportStorageState");
    return this.exportedState;
  }

  async dispose() {
    this.disposed = true;
  }
}

function harness(behavior: "success" | "redirect" | "expired" | "hang" = "success") {
  let context: FakeContext | undefined;
  const driver: BrowserDriver = {
    async createContext(options) {
      context = new FakeContext(options, behavior);
      return context;
    },
  };
  const sessionBytes = new Uint8Array([9, 9, 9]);
  const secretBytes = new TextEncoder().encode("must-never-appear-in-logs");
  const persistSessionState = vi.fn(
    async (_workspaceId: string, _handle: string, state: Uint8Array) => {
      persisted.push(Uint8Array.from(state));
    },
  );
  const persisted: Uint8Array[] = [];
  const secrets: SecretMaterialResolver = {
    async resolveSessionState() {
      return sessionBytes;
    },
    async resolveValue() {
      return secretBytes;
    },
    persistSessionState,
  };
  const put = vi.fn(async (_workspaceId: string, _runId: string, artifact: CaptureArtifact) => ({
    handle: `asset:${artifact.name}`,
    checksum: createHash("sha256").update(artifact.body).digest("hex"),
    sizeBytes: artifact.body.byteLength,
    kind: artifact.kind,
    name: artifact.name,
    contentType: artifact.contentType,
    redactionPassed: artifact.redactionPassed,
  }));
  const sink: CaptureArtifactSink = { put };
  const engine = new BrowserExecutionEngine(driver, secrets, sink);
  return {
    engine,
    getContext: () => context,
    put,
    sessionBytes,
    secretBytes,
    persistSessionState,
    persisted,
  };
}

function executionContext(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: recipe.workspaceId,
    runId: "019fe3f6-abcd-7f4e-aae4-46a6ccbff3c2",
    session: {
      expiresAt: new Date(Date.now() + 60_000),
      encryptedStateHandle: "session-state",
    },
    values: new Map([["token", { kind: "secret" as const, secretHandle: "secret:token" }]]),
    ...overrides,
  };
}

describe("browser recipe policy", () => {
  it("allows any public host so login and CDN hops do not need a recipe allowlist", () => {
    expect(() => assertUrlAllowed(recipe, "https://demo.example.com/projects/1")).not.toThrow();
    expect(() => assertUrlAllowed(recipe, "https://accounts.acme.example/sign-in")).not.toThrow();
    expect(() => assertUrlAllowed(recipe, "https://client.clerk.com/v1")).not.toThrow();
    expect(() => assertUrlAllowed(recipe, "https://challenges.cloudflare.com")).not.toThrow();
  });

  it("still refuses private and metadata addresses", () => {
    expect(() => assertUrlAllowed(recipe, "http://169.254.169.254/latest")).toThrow(
      "navigation_blocked",
    );
    expect(() => assertUrlAllowed(recipe, "http://10.0.0.8/admin")).toThrow("navigation_blocked");
    expect(() => assertUrlAllowed(recipe, "http://metadata.google.internal")).toThrow(
      "navigation_blocked",
    );
  });

  it("blocks destructive actions before a browser context exists", () => {
    expect(() =>
      assertRecipePolicy(
        CaptureRecipeSchema.parse({
          ...recipe,
          steps: [
            {
              type: "click",
              locator: { strategy: "role", value: "Delete account" },
            },
          ],
        }),
      ),
    ).toThrow("action_blocked");
  });

  it("requires balanced recording steps only for video output", () => {
    expect(() =>
      CaptureRecipeSchema.parse({
        ...recipe,
        output: { screenshots: false, video: true, trace: false },
        steps: [{ type: "startRecording" }],
      }),
    ).toThrow("exactly one recording start and stop");
  });

  it("installs the live redactor before the recording starts, and by default", () => {
    // The content worth hiding — other people's addresses and phone numbers — arrives while the
    // agent explores, long after every locator-based rule has run.
    expect(CaptureRecipeSchema.parse(recipe).redactSensitiveText).toBe(true);
  });

  it("rejects cookies or local storage outside session origins", () => {
    expect(() =>
      assertStorageStateAllowed(
        {
          cookies: [
            {
              name: "session",
              value: "secret",
              domain: "evil.example",
              path: "/",
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
        recipe.allowedOrigins,
      ),
    ).toThrow("navigation_blocked");
  });

  it("keeps a sign-in provider's cookie on a sibling subdomain of the product, never another tenant", () => {
    const cookie = (domain: string) => ({ name: "__client", value: "v", domain, path: "/", httpOnly: true, secure: true, sameSite: "Lax" as const });
    const state = storageStateForAllowedOrigins(
      { cookies: [cookie("clerk.acme.example"), cookie(".acme.example"), cookie("accounts.google.com"), cookie("other.vercel.app")], origins: [] },
      ["https://app.acme.example", "https://demo.vercel.app"],
    );
    expect(state.cookies.map((item) => item.domain)).toEqual(["clerk.acme.example", ".acme.example"]);
    expect(() => assertStorageStateAllowed({ cookies: [cookie("clerk.acme.example")], origins: [] }, ["https://app.acme.example"])).not.toThrow();
    expect(() => assertStorageStateAllowed({ cookies: [cookie("other.vercel.app")], origins: [] }, ["https://demo.vercel.app"])).toThrow("navigation_blocked");
  });

  it("keeps only cookies that belong on the next session's origins", () => {
    const state = storageStateForAllowedOrigins(
      {
        cookies: [
          {
            name: "session",
            value: "kept",
            domain: "demo.example.com",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
          {
            name: "tracker",
            value: "drop",
            domain: "evil.example",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [
          { origin: "https://demo.example.com", localStorage: [{ name: "ok", value: "1" }] },
          { origin: "https://evil.example", localStorage: [{ name: "no", value: "2" }] },
        ],
      },
      ["https://demo.example.com"],
    );
    expect(state.cookies).toEqual([
      expect.objectContaining({ name: "session", domain: "demo.example.com" }),
    ]);
    expect(state.origins).toEqual([
      { origin: "https://demo.example.com", localStorage: [{ name: "ok", value: "1" }] },
    ]);
  });
});

describe("BrowserExecutionEngine", () => {
  it("executes a recipe, masks secrets before fill and stores redacted artifacts", async () => {
    const test = harness();
    const result = await test.engine.execute(recipe, executionContext());
    expect(result).toMatchObject({ status: "succeeded", actionCount: 3 });
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["screenshot", "trace"]);
    expect(test.getContext()?.calls).toEqual([
      "goto:https://demo.example.com/dashboard",
      "mask:mask:label",
      "fill:label",
      "mask:mask:label",
      // Every redaction pass installs the live redactor first: what it hides has not arrived yet.
      "redactSensitiveText",
      "mask:blur:testId",
      "screenshot:dashboard",
      "mask:blur:testId",
      "exportStorageState",
      "trace:stop",
    ]);
    expect(JSON.stringify(result)).not.toContain("must-never-appear-in-logs");
    expect(test.getContext()?.filledValue).toBe("must-never-appear-in-logs");
    expect(test.secretBytes.every((byte) => byte === 0)).toBe(true);
    expect(test.sessionBytes.every((byte) => byte === 0)).toBe(true);
    expect(test.getContext()?.disposed).toBe(true);
    expect(test.persistSessionState).not.toHaveBeenCalled();
  });

  it("writes signed-in cookies back so the next capture can skip login", async () => {
    const test = harness();
    const signedIn = CaptureRecipeSchema.parse({
      ...recipe,
      steps: [
        { type: "goto", url: "https://demo.example.com/dashboard" },
        { type: "waitFor", locator: { strategy: "field", value: "signed_in" } },
      ],
    });
    const driver = test.engine.driver;
    const createContext = driver.createContext.bind(driver);
    driver.createContext = async (options) => {
      const created = (await createContext(options)) as FakeContext;
      created.exportedState = {
        cookies: [
          {
            name: "__session",
            value: "clerk",
            domain: "demo.example.com",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      };
      return created;
    };
    const result = await test.engine.execute(signedIn, executionContext());
    expect(result.status).toBe("succeeded");
    expect(test.persistSessionState).toHaveBeenCalled();
    const written = JSON.parse(new TextDecoder().decode(test.persisted[0]));
    expect(written.cookies[0]).toMatchObject({ name: "__session", domain: "demo.example.com" });
  });

  it("blocks an external redirect and still disposes the context", async () => {
    const test = harness("redirect");
    const result = await test.engine.execute(recipe, executionContext());
    expect(result).toMatchObject({ status: "blocked", diagnosticCode: "navigation_blocked" });
    expect(test.put).not.toHaveBeenCalled();
    expect(test.getContext()?.disposed).toBe(true);
  });

  it("returns reauth_required once instead of looping an expired application session", async () => {
    const test = harness("expired");
    const result = await test.engine.execute(recipe, executionContext());
    expect(result).toMatchObject({ status: "reauth_required", diagnosticCode: "reauth_required" });
    expect(result.actionCount).toBe(1);
  });

  it("stops a hung action at the recipe deadline and disposes the context", async () => {
    const test = harness("hang");
    const timeoutRecipe = CaptureRecipeSchema.parse({
      ...recipe,
      steps: [
        {
          type: "waitFor",
          locator: { strategy: "testId", value: "loader" },
        },
      ],
      limits: { maximumDurationMs: 100, maximumActions: 1, maximumRedirects: 0 },
    });
    const result = await test.engine.execute(timeoutRecipe, executionContext());
    expect(result).toMatchObject({ status: "failed", diagnosticCode: "execution_timeout" });
    expect(test.getContext()?.disposed).toBe(true);
  });

  it("supports a bounded settle delay before capture", async () => {
    const test = harness();
    const settleRecipe = CaptureRecipeSchema.parse({
      ...recipe,
      steps: [{ type: "wait", milliseconds: 100 }],
      limits: { maximumDurationMs: 500, maximumActions: 1, maximumRedirects: 0 },
    });
    const startedAt = Date.now();
    await expect(test.engine.execute(settleRecipe, executionContext())).resolves.toMatchObject({
      status: "succeeded",
      actionCount: 1,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(() =>
      CaptureRecipeSchema.parse({
        ...settleRecipe,
        steps: [{ type: "wait", milliseconds: 30_001 }],
      }),
    ).toThrow();
  });

  it("fails instead of publishing a static recording when no explorer is configured", async () => {
    const test = harness();
    const exploreRecipe = CaptureRecipeSchema.parse({
      ...recipe,
      output: { screenshots: true, video: true, trace: false },
      steps: [
        { type: "goto", url: "https://demo.example.com/dashboard" },
        { type: "startRecording" },
        { type: "explore", goals: ["Show the dashboard"] },
        { type: "stopRecording" },
        { type: "screenshot", name: "dashboard", fullPage: false },
      ],
    });
    await expect(test.engine.execute(exploreRecipe, executionContext())).resolves.toMatchObject({
      status: "failed",
      diagnosticCode: "browser_execution_failed",
    });
    expect(test.getContext()?.calls).not.toContain("screenshot:dashboard");
  });

  it.each([undefined, false, true])(
    "passes source availability (%s) from the stored recipe to the explorer",
    async (sourceAvailable) => {
      const test = harness();
      const explore = vi.fn(async () => {});
      const engine = new BrowserExecutionEngine(
        test.engine.driver,
        test.engine.secrets,
        test.engine.artifactSink,
        () => false,
        explore,
      );
      const result = await engine.execute(
        CaptureRecipeSchema.parse({
          ...recipe,
          steps: [
            { type: "goto", url: "https://demo.example.com/dashboard" },
            { type: "explore", goals: ["Inspect projects"], sourceAvailable },
            { type: "screenshot", name: "dashboard" },
          ],
        }),
        executionContext(),
      );
      expect(result.status).toBe("succeeded");
      expect(explore).toHaveBeenCalledWith(
        expect.objectContaining({ sourceAvailable: sourceAvailable ?? false }),
      );
    },
  );

  it("preserves the result-verification failure code for the dashboard", async () => {
    const test = harness();
    const assertion = vi
      .spyOn(FakeContext.prototype, "assertVisible")
      .mockRejectedValue(new Error("computer_use_win_not_visible"));
    try {
      const result = await test.engine.execute(
        {
          ...recipe,
          steps: [{ type: "assertVisible", locator: { strategy: "text", value: "Result" } }],
        },
        executionContext(),
      );
      expect(result).toMatchObject({
        status: "failed",
        diagnosticCode: "computer_use_win_not_visible",
      });
    } finally {
      assertion.mockRestore();
    }
  });

  it("honors cancellation and the global kill switch", async () => {
    const cancelled = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.engine.execute(recipe, executionContext({ signal: controller.signal })),
    ).resolves.toMatchObject({ status: "cancelled", diagnosticCode: "cancelled" });

    const blocked = harness();
    const engine = new BrowserExecutionEngine(
      blocked.engine.driver,
      blocked.engine.secrets,
      blocked.engine.artifactSink,
      () => true,
    );
    await expect(engine.execute(recipe, executionContext())).resolves.toMatchObject({
      status: "cancelled",
      diagnosticCode: "kill_switch",
    });
  });
});
