// Copies runtime assets into public/ so Vite serves/bundles them:
//   - ifc/floorplan.ifc          -> public/floorplan.ifc   (the BIM model)
//   - node_modules/web-ifc/*.wasm -> public/web-ifc/*.wasm  (self-hosted WASM)
//
// Runs automatically via the predev/prebuild npm hooks.
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
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

copy("ifc/floorplan.ifc", "public/floorplan.ifc");
for (const f of ["web-ifc.wasm", "web-ifc-mt.wasm"]) {
  copy(`node_modules/web-ifc/${f}`, `public/web-ifc/${f}`);
}
// Self-host the fragments worker so the published site has NO runtime CDN
// dependency (the default OBC.FragmentsManager.getWorker() fetches from unpkg).
copy("node_modules/@thatopen/fragments/dist/Worker/worker.mjs", "public/worker.mjs");
// Publish the original Three.js model alongside the BIM viewer at /legacy/.
copy("legacy/index.html", "public/legacy/index.html");
// Door hinge/swing manifest consumed by the viewer.
copy("ifc/doors.json", "public/doors.json");
// Plank-floor manifest (which coverings to re-render as instanced wood + colour).
copy("ifc/floors.json", "public/floors.json");
// Furniture manifest (soft/curved pieces the viewer renders as meshes).
copy("ifc/furniture.json", "public/furniture.json");
