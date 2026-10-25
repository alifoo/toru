import { spawnBrowserProcess, stopBrowserProcess } from '@content-layer/browser';
import { constants, createReadStream } from "node:fs";
import { access, readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs OpenScreen's exporter in a browser and returns the file it produces.
 *
 * The host owns three things and no rendering decisions: serving the bundle and the source
 * recording over loopback, driving the page, and receiving the finished file. Everything visible in
 * the output — camera, motion blur, cursor, background — is decided by the vendored exporter.
 *
 * Serving over `http://127.0.0.1` is not a convenience. WebCodecs is gated on a secure context, and
 * from a `file://` or `about:blank` origin the exporter fails by reporting its own API as absent,
 * which reads like a missing browser feature rather than a wrong URL.
 */

export type RenderProgress = { currentFrame: number; totalFrames: number };

export type RenderRequest = {
  /** Path to the recording the exporter should read. Served to the page over loopback. */
  sourcePath: string;
  /** `VideoExporterConfig` minus `videoUrl`, which the host fills in with the served URL. */
  config: Record<string, unknown>;
  /** Hard ceiling for one render. Includes browser startup and encoding. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
};

export type RenderOutcome =
  | { status: "rendered"; bytes: Buffer; durationMs: number; rendererBackend?: "portable" | "gpu" }
  | { status: "failed"; reason: string; durationMs: number };

export type RenderHostOptions = {
  /** Browser executable. Chromium in the container, Chrome for Testing in development. */
  browserBinary: string;
  /** Built page bundle, i.e. `apps/render-worker/dist-web`. */
  bundleDirectory?: string;
  browserArguments?: string[];
};

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  // The catalog wallpapers are JPEGs; served as octet-stream the exporter cannot decode them.
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Serves the bundle, the source recording, and an endpoint the page posts the finished file to. */
function startHostServer(
  bundleDirectory: string,
  sourcePath: string,
  onResult: (bytes: Buffer) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/result") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) { request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on("end", () => {
        onResult(Buffer.concat(chunks));
        response.writeHead(204).end();
      });
      return;
    }

    if (url.pathname === "/source") {
      // Range support: the exporter's demuxer seeks rather than reading start to end.
      void serveFile(sourcePath, request.headers.range, response);
      return;
    }

    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = resolve(bundleDirectory, relative);
    // Anything resolving outside the bundle is a bug or an attack; either way it is not served.
    if (!target.startsWith(resolve(bundleDirectory) + sep)) {
      response.writeHead(403).end();
      return;
    }
    void serveFile(target, undefined, response);
  });

  return new Promise((resolvePromise, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("render host could not determine its port"));
        return;
      }
      resolvePromise({ server, port: address.port });
    });
  });
}

async function serveFile(
  path: string,
  range: string | undefined,
  response: import("node:http").ServerResponse,
): Promise<void> {
  try {
    const info = await stat(path);
    const type = contentTypes[extname(path)] ?? "application/octet-stream";
    const match = range?.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : info.size - 1;
      response.writeHead(206, {
        "content-type": type,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${info.size}`,
        "accept-ranges": "bytes",
      });
      createReadStream(path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "accept-ranges": "bytes",
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}

type CdpConnection = {
  evaluate: (expression: string, timeoutMs?: number) => Promise<unknown>;
  close: () => void;
};

async function connectToPage(port: number, timeoutMs: number, signal: AbortSignal): Promise<CdpConnection> {
  const deadline = Date.now() + timeoutMs;
  let target: { webSocketDebuggerUrl?: string } | undefined;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
      const targets = (await response.json()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      target = targets.find((candidate) => candidate.type === "page");
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      // The browser is still starting.
    }
    await new Promise((wait) => setTimeout(wait, 200));
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("browser did not expose a page target");

  signal.throwIfAborted();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const close = () => socket.close();
  signal.addEventListener("abort", close, { once: true });
  socket.addEventListener("close", () => signal.removeEventListener("abort", close), { once: true });
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => { close(); reject(new Error("browser debugger did not connect")); },
      timeoutMs,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
    socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("browser debugger closed")); }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("browser debugger connection failed"));
    });
  });

  let nextId = 1;
  return {
    evaluate: (expression, timeoutMs = 10_000) =>
      new Promise((resolvePromise, reject) => {
        const id = nextId++;
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("close", onClose);
          socket.removeEventListener("error", onClose);
        };
        const onClose = () => { cleanup(); reject(new Error("browser debugger closed")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("browser evaluation timed out")); }, timeoutMs);
        const onMessage = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data)) as {
            id?: number;
            error?: { message: string };
            result?: {
              result?: { value?: unknown };
              exceptionDetails?: { text?: string; exception?: { description?: string } };
            };
          };
          if (message.id !== id) return;
          cleanup();
          if (message.error) { reject(new Error(message.error.message)); return; }
          const failure = message.result?.exceptionDetails;
          if (failure) {
            // The description carries the message and stack; `text` on its own is only "Uncaught",
            // which says a render failed without saying anything about why.
            reject(new Error(failure.exception?.description ?? failure.text ?? "page threw"));
            return;
          }
          resolvePromise(message.result?.result?.value);
        };
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onClose);
        socket.addEventListener("message", onMessage);
        if (socket.readyState !== WebSocket.OPEN) { onClose(); return; }
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      }),
    close: () => socket.close(),
  };
}

export function createRenderHost(options: RenderHostOptions) {
  // The page bundle is built by apps/render-worker; this package only drives it, so the location is
  // configuration rather than a relative path that would tie the two together.
  const bundleDirectory =
    options.bundleDirectory ??
    process.env.RENDER_BUNDLE_DIRECTORY ??
    fileURLToPath(new URL("../../../apps/render-worker/dist-web", import.meta.url));

  return {
    async render(request: RenderRequest): Promise<RenderOutcome> {
      request.signal?.throwIfAborted();
      const timeoutMs = request.timeoutMs ?? 10 * 60_000;
      const startedAt = Date.now();
      let rendered: Buffer | null = null;
      const timeout = AbortSignal.timeout(timeoutMs);
      const browserFailure = new AbortController();
      const signal = AbortSignal.any([timeout, browserFailure.signal, ...(request.signal ? [request.signal] : [])]);
      const profile = await mkdtemp(join(process.env.RECORDER_SCRATCH_DIR ?? tmpdir(), "recorder-render-"));

      const { server, port } = await startHostServer(
        bundleDirectory,
        request.sourcePath,
        (bytes) => {
          rendered = bytes;
        },
      );
      const debuggingPort = 9400 + Math.floor(Math.random() * 500);
      const browser = spawnBrowserProcess(
        options.browserBinary,
        [
          "--headless=new",
          "--disable-dev-shm-usage",
          `--user-data-dir=${profile}`,
          "--autoplay-policy=no-user-gesture-required",
          `--remote-debugging-port=${debuggingPort}`,
          ...(options.browserArguments ?? []),
          `http://127.0.0.1:${port}/`,
        ],
      );

      const abort = () => { void stopBrowserProcess(browser); };
      signal.addEventListener("abort", abort, { once: true });
      browser.once("error", error => browserFailure.abort(error));
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      let readingProgress = false;
      let page: CdpConnection | undefined;

      const finish = async (outcome: RenderOutcome): Promise<RenderOutcome> => {
        if (progressTimer) clearInterval(progressTimer);
        signal.removeEventListener('abort', abort);
        page?.close();
        await stopBrowserProcess(browser);
        server.close();
        server.closeAllConnections();
        await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
        return outcome;
      };

      try {
        signal.throwIfAborted();
        page = await connectToPage(debuggingPort, 30_000, signal);
        // Wait for the bundle to install its entry point before calling into it.
        const ready = Date.now() + 30_000;
        while (Date.now() < ready) {
          signal.throwIfAborted();
          if ((await page.evaluate("typeof window.renderDemo === 'function'")) === true) break;
          await new Promise((wait) => setTimeout(wait, 150));
        }
        if ((await page.evaluate("typeof window.renderDemo === 'function'")) !== true) {
          const loadError = await page.evaluate("window.renderLoadError");
          throw new Error(typeof loadError === "string" && loadError ? loadError : "render_bundle_not_ready");
        }

        const config = { ...request.config, videoUrl: `http://127.0.0.1:${port}/source` };
        if (request.onProgress) progressTimer = setInterval(() => {
          if (readingProgress || signal.aborted) return;
          readingProgress = true;
          void page!.evaluate("window.renderProgress", 5_000).then(value => {
            const progress = value as RenderProgress | null;
            if (progress && Number.isFinite(progress.currentFrame) && Number.isFinite(progress.totalFrames)
                && progress.totalFrames > 0 && progress.currentFrame >= 0) request.onProgress?.(progress);
          }).catch(() => undefined).finally(() => { readingProgress = false; });
        }, 2_000);
        signal.throwIfAborted();
        const outcome = await page.evaluate(`window.renderDemo(${JSON.stringify(config)})`, timeoutMs) as {
          ok: boolean;
          error?: string;
          backend?: "portable" | "gpu";
        };

        page.close();
        if (!outcome?.ok) {
          return finish({
            status: "failed",
            reason: outcome?.error ?? "the page returned no outcome",
            durationMs: Date.now() - startedAt,
          });
        }
        if (!rendered) {
          return finish({
            status: "failed",
            reason: "the page reported success without posting a file",
            durationMs: Date.now() - startedAt,
          });
        }
        return finish({
          status: "rendered",
          bytes: rendered,
          durationMs: Date.now() - startedAt,
          ...(outcome.backend ? { rendererBackend: outcome.backend } : {}),
        });
      } catch (error) {
        return finish({
          status: "failed",
          reason: signal.reason?.name === "TimeoutError" ? "render_timeout" : request.signal?.aborted ? "render_canceled" : error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
      }
    },
  };
}

/**
 * Finds a browser to render in: the container's chromium, or whatever a laptop has.
 *
 * `RENDER_BROWSER_BINARY` still wins, but nothing should have to set it. A missing binary here is
 * silent — the renderer returns null and the capture succeeds without its camera work, cursor and
 * backdrop — so a lookup that only knew Linux paths cost every demo on a developer machine.
 */
export async function resolveBrowserBinary(): Promise<string> {
  const configured = process.env.RENDER_BROWSER_BINARY;
  if (configured) return configured;
  for (const candidate of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...(await puppeteerChromeBinaries()),
    ...(await playwrightChromeBinaries()),
  ]) {
    try {
      // Presence only. Reading it would pull hundreds of megabytes into memory to learn a boolean.
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new Error("no browser binary found; set RENDER_BROWSER_BINARY");
}

/**
 * Chrome for Testing, as installed by puppeteer, newest first.
 *
 * Its directories are version-stamped, so the path cannot be written down — pinning one in an env
 * file works until the cache is cleared or a dependency pulls a newer Chrome.
 */
/**
 * Chromium from a Playwright install.
 *
 * A machine that runs the browser tests already has one, and on a Mac it is the only one the
 * candidate list would otherwise miss — Chrome is not in /usr/bin and a developer need not have
 * installed it under /Applications. Without this, post-production is silently unavailable and every
 * capture dies at the last step with `post_production_unavailable`.
 */
async function playwrightChromeBinaries(): Promise<string[]> {
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    const versions = (await readdir(root))
      .filter((entry) => entry.startsWith("chromium"))
      .sort()
      .reverse();
    return versions.flatMap((version) =>
      ["chrome-mac-arm64", "chrome-mac-x64"].map((platform) =>
        join(
          root,
          version,
          platform,
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
      ),
    );
  } catch {
    return [];
  }
}

async function puppeteerChromeBinaries(): Promise<string[]> {
  const root = join(homedir(), ".cache", "puppeteer", "chrome");
  try {
    const versions = (await readdir(root)).sort().reverse();
    return versions.flatMap((version) =>
      ["chrome-mac-arm64", "chrome-mac-x64"].map((platform) =>
        join(
          root,
          version,
          platform,
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
      ),
    );
  } catch {
    return [];
  }
}

export { forgetSystemCursors, resolveSystemCursors } from "./system-cursors.js";
