import { defineConfig } from "vite";
import { execSync } from "node:child_process";

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
});
