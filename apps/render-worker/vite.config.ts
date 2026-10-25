import { fileURLToPath } from "node:url";
import { cp, mkdir } from "node:fs/promises";
import { defineConfig } from "vite";

/**
 * Bundles OpenScreen's exporter, unmodified, into a page we host.
 *
 * The submodule is pinned and never edited, so its own `@/` import alias has to be honoured here
 * rather than rewritten in its source. Everything the exporter needs is a direct dependency of this
 * workspace root, where the vendored tree can reach them by ordinary resolution; its Electron, React
 * and UI dependencies are deliberately absent because the export path does not reach them.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  // Their static assets, served from the same origin as the page because their code resolves them
  // relative to `window.location`: the demuxer WASM, the cursor themes and the wallpapers.
  publicDir: false,
  // Ship the decoder runtime and Toru's own backgrounds. Their wallpaper set and third-party cursor packs are not used.
  plugins: [{
    name: "decoder-assets",
    async closeBundle() {
      const destination = fileURLToPath(new URL("./dist-web/wasm", import.meta.url));
      await mkdir(destination, { recursive: true });
      await cp(fileURLToPath(new URL("../../vendor/openscreen/public/wasm", import.meta.url)), destination, { recursive: true });
      // Toru's backgrounds (render-contract's backgroundCatalog), where their renderer loads image wallpapers from.
      await cp(fileURLToPath(new URL("./backgrounds", import.meta.url)), fileURLToPath(new URL("./dist-web/wallpapers", import.meta.url)), { recursive: true });
    },
  }],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../vendor/openscreen/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-web", import.meta.url)),
    emptyOutDir: true,
    // The renderer is served over loopback to one browser we launch; a modern target keeps the
    // bundle honest about what it actually needs.
    target: "es2022",
  },
});
