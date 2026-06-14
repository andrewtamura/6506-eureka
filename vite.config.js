import { defineConfig } from "vite";

// Relative base so the built site works at any path — including a GitHub
// Pages project subpath like https://<user>.github.io/6506-eureka/.
export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist" },
  // web-ifc / fragments ship prebuilt wasm; don't let Vite try to optimize it.
  optimizeDeps: { exclude: ["web-ifc"] },
});
