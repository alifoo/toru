import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SystemCursorAssets } from "@content-layer/render-contract";

/**
 * Reads this machine's own cursor bitmaps, so a render can wear the operating system's pointer
 * instead of OpenScreen's replacement artwork.
 *
 * The bitmaps belong to the OS vendor. Extracting them on a machine that already has them is
 * unremarkable; shipping them inside a product is not. So they are read here, at render time, and
 * never written anywhere the repository or a build would pick them up. A host that cannot read them
 * — any platform but macOS, no Swift toolchain, a failed run — returns null, and the caller falls
 * back to the artwork OpenScreen ships. That fallback is the reason nothing here throws.
 */

const run = promisify(execFile);

/** Long enough for a cold compile on a loaded machine, short enough not to stall a render. */
const compileTimeoutMs = 60_000;
const extractTimeoutMs = 10_000;

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(packageRoot, "native", "SystemCursorAssets.swift");

function cacheDirectory(): string {
  return join(homedir(), "Library", "Caches", "content-layer", "system-cursors");
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the extractor, reusing a previous build unless the source has moved on.
 *
 * Compared by mtime rather than a hash: the input is one file this repository owns, and the cost of
 * being wrong is a rebuild that takes a second.
 */
async function buildExtractor(): Promise<string | null> {
  const directory = cacheDirectory();
  const binaryPath = join(directory, "system-cursors");
  try {
    const [source, binary] = await Promise.all([stat(sourcePath), stat(binaryPath)]);
    if (binary.mtimeMs >= source.mtimeMs) return binaryPath;
  } catch {
    // No build yet, or no source. The compile below reports which.
  }
  try {
    await mkdir(directory, { recursive: true });
    await run("swiftc", ["-O", "-o", binaryPath, sourcePath], { timeout: compileTimeoutMs });
    return binaryPath;
  } catch {
    return null;
  }
}

/** Every shape OpenScreen can be told about from a page's reported cursor. */
const wantedShapes = ["arrow", "pointer", "text"] as const;

function parseAssets(payload: string): SystemCursorAssets | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed as Record<string, unknown>;
  const assets: SystemCursorAssets = {};
  for (const shape of wantedShapes) {
    const entry = source[shape];
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const { dataUrl, width, height, hotspotX, hotspotY } = candidate;
    if (
      typeof dataUrl !== "string" ||
      !dataUrl.startsWith("data:image/png;base64,") ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      typeof hotspotX !== "number" ||
      typeof hotspotY !== "number" ||
      /**
       * Upstream classifies any bitmap of 24–64px as one of its own and substitutes its artwork for
       * it. A real extraction is normalised far above that, so a set that lands inside the band is
       * not the OS artwork we asked for and would be silently replaced anyway.
       */
      height <= 64
    ) {
      continue;
    }
    assets[shape] = { imageDataUrl: dataUrl, width, height, hotspotX, hotspotY };
  }
  return Object.keys(assets).length > 0 ? assets : null;
}

let pending: Promise<SystemCursorAssets | null> | undefined;

/**
 * The cursor set for this machine, or null when it has none to give.
 *
 * Memoised per process: the answer is a property of the host, and a worker rendering in a loop
 * should pay for it once.
 */
export function resolveSystemCursors(): Promise<SystemCursorAssets | null> {
  pending ??= extract();
  return pending;
}

async function extract(): Promise<SystemCursorAssets | null> {
  // An explicit opt-out, for a host that would rather ship OpenScreen's cursors deliberately.
  if (process.env.RENDER_SYSTEM_CURSORS === "0") return null;
  if (process.platform !== "darwin") return null;
  if (!(await isReadable(sourcePath))) return null;

  const cachePath = join(cacheDirectory(), "cursors.json");
  const cached = await readFile(cachePath, "utf8").catch(() => null);
  if (cached) {
    const assets = parseAssets(cached);
    if (assets) return assets;
  }

  const binaryPath = await buildExtractor();
  if (!binaryPath) return null;
  try {
    // The bitmaps are large and arrive base64-encoded; the default 1MB buffer truncates them.
    const { stdout } = await run(binaryPath, [], {
      timeout: extractTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const assets = parseAssets(stdout);
    if (!assets) return null;
    // Cached under the user's own cache directory, never in the repository or a build output.
    await writeFile(cachePath, stdout).catch(() => undefined);
    return assets;
  } catch {
    return null;
  }
}

/** Drops the memoised answer. For tests, and for a host that changed appearance mid-process. */
export function forgetSystemCursors(): void {
  pending = undefined;
}
