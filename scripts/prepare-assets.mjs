// Copies runtime assets into public/ so Vite serves/bundles them:
//   - ifc/levels.json + each level's IFC + manifests -> public/  (the BIM models)
//   - node_modules/web-ifc/*.wasm -> public/web-ifc/*.wasm        (self-hosted WASM)
//
// Runs automatically via the predev/prebuild npm hooks.
import { mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copy = (from, to) => {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  if (!existsSync(src)) throw new Error(`Missing asset: ${from} (did you run the IFC generator / npm install?)`);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copied ${from} -> ${to}`);
};

// The whole row of views: levels.json + every level's IFC + manifests.
copy("ifc/levels.json", "public/levels.json");
const { levels } = JSON.parse(readFileSync(resolve(root, "ifc/levels.json"), "utf8"));
for (const lvl of levels) {
  copy(`ifc/${lvl.ifc}`, `public/${lvl.ifc}`);
  for (const f of Object.values(lvl.manifests)) copy(`ifc/${f}`, `public/${f}`);
}
for (const f of ["web-ifc.wasm", "web-ifc-mt.wasm"]) {
  copy(`node_modules/web-ifc/${f}`, `public/web-ifc/${f}`);
}
// Self-host the fragments worker so the published site has NO runtime CDN
// dependency (the default OBC.FragmentsManager.getWorker() fetches from unpkg).
copy("node_modules/@thatopen/fragments/dist/Worker/worker.mjs", "public/worker.mjs");
// Publish the original Three.js model alongside the BIM viewer at /legacy/.
copy("legacy/index.html", "public/legacy/index.html");
// PWA icons (committed source; regenerate with scripts/gen-icons.mjs).
for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon-180.png"]) {
  copy(`icons/${f}`, `public/icons/${f}`);
}
