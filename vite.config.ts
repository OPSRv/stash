import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// `rehype-highlight` statically imports `common` from `lowlight`, which pulls
// ~38 highlight.js grammars (~250 KB) into every chunk that uses markdown —
// even when the caller passes its own `languages` set. Intercept the
// `lowlight/lib/common.js` import (both bare and relative forms) and replace
// it with an empty stub so tree-shaking drops the grammars; the renderer
// falls back to our curated set in `src/shared/ui/Markdown.tsx`.
const stubPath = fileURLToPath(
  new URL("./src/shared/ui/lowlight-common-stub.ts", import.meta.url),
);
const stubLowlightCommon: Plugin = {
  name: "stub-lowlight-common",
  enforce: "pre",
  async resolveId(source, importer) {
    // Both `common` (38 langs) and `all` (~190 langs) are re-exported from
    // lowlight's index.js; tree-shaking can't reach them across the package
    // boundary because rehype-highlight references `common` at module top.
    // Stub both so only the curated set in `Markdown.tsx` reaches the bundle.
    const isLowlightAggregate =
      source.endsWith("lowlight/lib/common.js") ||
      source.endsWith("lowlight/lib/common") ||
      source.endsWith("lowlight/lib/all.js") ||
      source.endsWith("lowlight/lib/all");
    if (isLowlightAggregate) return stubPath;
    if (
      (source === "./lib/common.js" ||
        source === "./common.js" ||
        source === "./lib/all.js" ||
        source === "./all.js") &&
      importer &&
      importer.includes("/lowlight/")
    ) {
      return stubPath;
    }
    return null;
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [stubLowlightCommon, react(), tailwindcss()],

  // Two HTML entries:
  //   index.html — the main 920×640 popup with every module tab.
  //   voice.html — the slim Claude-style voice capsule pinned to
  //                the bottom of the screen.
  // Listing both lets Vite build them together while keeping their
  // bundles separate so the voice popup doesn't drag the entire
  // module tree into its first paint.
  build: {
    // 800kB so the chunk-size warning fires only on genuinely problematic
    // bundles. The mermaid/wardley/cytoscape diagrams below are already
    // their own chunks via `manualChunks`, and they're lazy-loaded inside
    // the Markdown renderer, so they never block first paint.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        voice: fileURLToPath(new URL('./voice.html', import.meta.url)),
      },
      output: {
        // Force the heaviest viz libraries into named chunks so they don't
        // get duplicated across every Markdown-using shell. Each one is
        // 400-600kB and only loads when the user actually renders a
        // matching code block in a note preview. Path-based matcher
        // because mermaid pulls cytoscape + wardley as sub-deps that
        // aren't in our top-level package.json.
        manualChunks(id) {
          if (id.includes('node_modules/mermaid/') || id.includes('node_modules/@mermaid-js/')) {
            return 'mermaid';
          }
          if (id.includes('node_modules/cytoscape')) {
            return 'cytoscape';
          }
          if (id.includes('wardley')) {
            return 'wardley';
          }
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
