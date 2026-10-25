import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserExecutionEngine,
  type CaptureArtifact,
  CaptureRecipeSchema,
  type StoredCaptureArtifact,
} from "./index.js";
import { FetchWebDriverTransport, WebDriverBrowserDriver } from "./webdriver.js";

const runLiveE2e = process.env.RUN_BROWSER_E2E === "true";

describe.skipIf(!runLiveE2e)("live Chromium capture", () => {
  let fixture: Server;
  let fixtureOrigin: string;
  let chromedriver: ChildProcess | undefined;

  beforeAll(async () => {
    fixture = createFixtureServer();
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("fixture_address_unavailable");
    fixtureOrigin = `http://127.0.0.1:${address.port}`;

    if (!process.env.WEBDRIVER_E2E_URL) {
      chromedriver = spawn(process.env.CHROMEDRIVER_BIN ?? "chromedriver", [
        "--port=9515",
        "--url-base=/wd/hub",
        "--allowed-ips=127.0.0.1",
      ]);
      await waitForWebDriver("http://127.0.0.1:9515/wd/hub");
    }
  }, 20_000);

  afterAll(async () => {
    fixture?.close();
    chromedriver?.kill("SIGTERM");
  });

  it("captures a comparable PNG and encoded WebM from a controlled product flow", async () => {
    const workspaceId = "019fe3f6-9a9a-7cb1-bb2e-d342309e7f09";
    const runId = "019fe3f6-abcd-7f4e-aae4-46a6ccbff3c2";
    const recipe = CaptureRecipeSchema.parse({
      id: "019fe3f6-6b52-7f4e-aae4-46a6ccbff3c2",
      workspaceId,
      version: 1,
      name: "Controlled fixture",
      allowedOrigins: [fixtureOrigin],
      viewport: { width: 1280, height: 720 },
      steps: [
        { type: "goto", url: `${fixtureOrigin}/dashboard` },
        { type: "waitFor", locator: { strategy: "testId", value: "feature-title" } },
        { type: "screenshot", name: "feature", fullPage: false },
        { type: "startRecording" },
        { type: "click", locator: { strategy: "role", value: "button:Show result" } },
        { type: "waitFor", locator: { strategy: "testId", value: "result" } },
        { type: "stopRecording" },
      ],
      redactionRules: [
        {
          locator: { strategy: "testId", value: "customer-email" },
          mode: "mask",
          required: true,
        },
      ],
      output: { screenshots: true, video: true, trace: true },
      limits: { maximumDurationMs: 30_000, maximumActions: 10, maximumRedirects: 0 },
    });
    const artifacts = new Map<string, Uint8Array>();
    const engine = new BrowserExecutionEngine(
      new WebDriverBrowserDriver(
        new FetchWebDriverTransport(
          process.env.WEBDRIVER_E2E_URL ?? "http://127.0.0.1:9515/wd/hub",
        ),
        {
          /**
           * Headless, unlike the recipes this exercises.
           *
           * They run headed so a hosted sign-in does not meet a browser that Turnstile classifies
           * as a bot. This test drives an HTML fixture served from this process — there is nobody
           * to convince — and the container it runs in has no display at all, so a headed browser
           * renders nothing and every wait here times out.
           */
          chromeArguments: ["--headless=new"],
          // CI's image has a browser where chromedriver looks; a developer's machine often has one
          // only where a tool installed it, and without this the test is unrunnable there.
          ...(process.env.CHROME_BIN ? { chromeBinary: process.env.CHROME_BIN } : {}),
        },
      ),
      {
        async resolveSessionState() {
          return new TextEncoder().encode('{"cookies":[],"origins":[]}');
        },
        async resolveValue() {
          throw new Error("not_used");
        },
      },
      {
        async put(_workspace, _run, artifact: CaptureArtifact): Promise<StoredCaptureArtifact> {
          const body = new Uint8Array(artifact.body);
          const handle = `memory:${artifact.kind}:${artifact.name}`;
          artifacts.set(handle, body);
          return {
            ...artifact,
            handle,
            checksum: createHash("sha256").update(body).digest("hex"),
            sizeBytes: body.byteLength,
          };
        },
      },
    );

    const result = await engine.execute(recipe, {
      workspaceId,
      runId,
      session: { expiresAt: new Date(Date.now() + 60_000), encryptedStateHandle: "fixture" },
      values: new Map(),
    });

    // A bare status tells whoever reads CI that a real browser flow died, and nothing else. The
    // diagnostic and the step log are what turn that into something anybody can act on.
    expect(
      {
        status: result.status,
        diagnostic: result.diagnosticCode ?? null,
        lastStep: result.actionLog.at(-1)?.detail ?? null,
      },
      "capture did not succeed",
    ).toEqual({ status: "succeeded", diagnostic: null, lastStep: expect.anything() });
    const png = artifacts.get("memory:screenshot:feature");
    expect(png?.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png && readPngDimensions(png)).toMatchObject({ width: 1280 });
    expect(png?.byteLength).toBeGreaterThan(5_000);
    const video = artifacts.get("memory:video:capture");
    expect(video?.slice(0, 4)).toEqual(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    expect(video?.byteLength).toBeGreaterThan(100);
  }, 40_000);
});

function createFixtureServer(): Server {
  return createServer((request, response) => {
    if (request.url !== "/dashboard") {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'",
    });
    response.end(`<!doctype html>
      <html><head><style>
        body{margin:0;background:#f4f7fb;color:#10213b;font:20px system-ui}
        main{padding:72px}.card{background:white;border-radius:24px;padding:48px;box-shadow:0 12px 40px #18315322}
        h1{font-size:52px;margin:0 0 16px}.email{display:inline-block;padding:8px;background:#ffe9a8}
        button{margin-top:32px;padding:16px 24px;border:0;border-radius:12px;background:#315efb;color:white;font-weight:700}
      </style></head><body><main><section class="card">
        <h1 data-testid="feature-title">Analytics that explain themselves</h1>
        <p>Weekly insights are ready for <span class="email" data-testid="customer-email">private@example.com</span>.</p>
        <button role="button" aria-label="Show result" onclick="document.querySelector('[data-testid=result]').hidden=false">Show result</button>
        <p data-testid="result" hidden>12 hours saved this week</p>
      </section></main></body></html>`);
  });
}

async function waitForWebDriver(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/status`);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("chromedriver_start_timeout");
}

function readPngDimensions(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
