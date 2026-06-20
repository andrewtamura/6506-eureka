import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import { VitePWA } from "vite-plugin-pwa";

// Stamp the build with the git short hash + date so the running site can show
// which version it is (useful when a stale asset is cached). Falls back to the
// CI-provided commit SHA, then "dev", if git isn't available.
function buildHash() {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return (process.env.GITHUB_SHA || "").slice(0, 7) || "dev";
  }
}
const BUILD_HASH = buildHash();
const BUILD_DATE = new Date().toISOString().slice(0, 10);

// Relative base so the built site works at any path — including a GitHub
// Pages project subpath like https://<user>.github.io/6506-eureka/.
export default defineConfig({
  base: "./",
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
  build: { target: "esnext", outDir: "dist" },
  // web-ifc / fragments ship prebuilt wasm; don't let Vite try to optimize it.
  optimizeDeps: { exclude: ["web-ifc"] },
  plugins: [
    // Offline support (installable PWA). A Workbox service worker precaches the
    // ENTIRE app on first load — the hashed JS/CSS, the self-hosted Fragments
    // worker + web-ifc WASM, and every level's IFC + JSON manifest — so the
    // viewer runs with no network. `autoUpdate` swaps in a new build silently on
    // the next visit (matching the site's "always show the latest deploy" goal).
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      // The /legacy/ three.js model stays online-only (excluded below).
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "6506 Eureka — BIM Viewer",
        short_name: "6506 Eureka",
        description: "Interactive BIM viewer for the 6506 Eureka residence.",
        theme_color: "#b0d4f1",
        background_color: "#b0d4f1",
        display: "standalone",
        orientation: "any",
        // Relative src (no leading slash) so icons resolve under the Pages base.
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the whole viewer payload. Include the non-default asset types
        // (WASM, the .mjs worker, the .ifc models, the JSON manifests).
        globPatterns: ["**/*.{js,css,html,wasm,mjs,ifc,json,webmanifest,png,svg,ico}"],
        // Main viewer only: don't precache the legacy three.js model or maps.
        globIgnores: ["legacy/**", "**/*.map"],
        // The bundle (~6 MB) and the Fragments worker (~3.3 MB) blow past
        // Workbox's 2 MB default — raise the cap so they get precached.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        // Model assets are fetched with a ?v=<buildhash> cache-buster; ignore it
        // so a precached IFC/manifest still matches regardless of the query.
        ignoreURLParametersMatching: [/^v$/],
        // Serve index.html for offline navigations / deep links (and reloads).
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/\/legacy\//],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
});
