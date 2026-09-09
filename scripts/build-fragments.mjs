// Convert each level's IFC to a prebuilt .frag, so the browser never runs the
// web-ifc conversion itself.
//
// Profiled cold in the headless viewer, parsing the four IFCs (the 1.3 MB exterior
// twice — once as "Site", once as the alt lot) is the dominant cost of a page load.
// IfcImporter does the same job in Node at build time; the viewer then fetches the
// .frag and skips straight to geometry. Falls back gracefully: src/main.js still
// parses the IFC if a .frag is missing, so a bare checkout works.
//
// Incremental — a level is reconverted only when its IFC is newer than its .frag.
import { IfcImporter } from "@thatopen/fragments";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mtime = async (p) => { try { return (await stat(p)).mtimeMs; } catch { return 0; } };

const serializer = new IfcImporter();
serializer.wasm = { path: `${resolve(root, "node_modules/web-ifc")}/`, absolute: true };
// MUST match src/main.js's ifcLoader.setup({ webIfc: ... }) — the viewer tessellates
// circles at 48 segments so pedestal tables and columns read as round, and a .frag
// built at the default would quietly make them coarse.
serializer.webIfcSettings = { CIRCLE_SEGMENTS: 48 };

const { levels } = JSON.parse(await readFile(resolve(root, "ifc/levels.json"), "utf8"));
await mkdir(resolve(root, "public"), { recursive: true });
for (const lvl of levels) {
  const src = resolve(root, "ifc", lvl.ifc);
  const dst = resolve(root, "public", lvl.ifc.replace(/\.ifc$/, ".frag"));
  if (await mtime(dst) > await mtime(src)) { console.log(`fragments: ${lvl.ifc} up to date`); continue; }
  const t = Date.now();
  const bytes = new Uint8Array(await readFile(src));
  const frag = await serializer.process({ bytes });
  await writeFile(dst, frag);
  console.log(`fragments: ${lvl.ifc} -> ${lvl.ifc.replace(/\.ifc$/, ".frag")}`
    + ` (${(bytes.length / 1e6).toFixed(2)} MB -> ${(frag.length / 1e6).toFixed(2)} MB, ${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

// web-ifc keeps its WASM instance alive, so the process will not exit on its own.
process.exit(0);
