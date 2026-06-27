// Plywood SUBFLOOR rendered as 4x8 sheets in ONE THREE.InstancedMesh (one draw
// call), with seam grooves — the attic's low-headroom zone beyond the usable
// (finished-hardwood) area. Same contract as wood-floor.js: which coverings are
// subfloor (and their colour) comes from the subfloor manifest emitted by the
// generator. Sheets are laid on a GLOBAL grid so the 4x8 seams line up across
// rooms, and meet the finished floor exactly at the usable-headroom boundary.
import * as THREE from "three";

const FT = 0.3048;
const SX = 8 * FT, SZ = 4 * FT;            // sheet 8' (E-W, along X) x 4' (N-S, along Z)
const GAP = 0.02 * FT;                     // seam gap between sheets
const PH = 0.016;                          // sheet relief (height), metres
const SHADES = [0.94, 1.0, 1.05, 0.97, 1.03, 0.91, 1.0];   // subtle sheet-to-sheet variation
const hash = (n) => { const x = Math.sin(n * 91.7) * 47453.1; return x - Math.floor(x); };

export async function buildSubfloor({ scene, model, fragments, floorY, baseUrl, manifestFile = "subfloor.json" }) {
  let manifest = [];
  try { manifest = await (await fetch(`${baseUrl}${manifestFile}`)).json(); } catch (e) { /* none */ }
  if (!manifest.length) return;

  const covs = Object.values(await model.getItemsOfCategories([/IFCCOVERING/])).flat();
  const cdata = await model.getItemsData(covs, { attributesDefault: true });
  const cboxes = await model.getBoxes(covs);
  const byName = new Map();
  covs.forEach((id, i) => byName.set(String(cdata[i]?.Name?.value ?? ""), { id, box: cboxes[i] }));
  const areas = manifest.map((e) => ({ ...byName.get(e.name), rgb: e.rgb })).filter((f) => f.box);
  if (!areas.length) return;

  await model.setVisible(areas.map((f) => f.id), false);   // hide the flat IFC covering
  await fragments.core.update(true);

  const fy = floorY + 0.02;
  const baseMat = new THREE.MeshLambertMaterial({ color: 0x3a2c18 });   // seam groove colour
  const tiles = [];
  for (const fl of areas) {
    const bx = fl.box, [cr, cg, cb] = fl.rgb;
    const x1 = bx.min.x, x2 = bx.max.x, z1 = bx.min.z, z2 = bx.max.z;
    const base = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, z2 - z1), baseMat);
    base.rotation.x = -Math.PI / 2;
    base.position.set((x1 + x2) / 2, fy - 0.004, (z1 + z2) / 2);
    scene.add(base);
    for (let k = Math.floor(z1 / SZ); k < Math.ceil(z2 / SZ); k++) {
      const rz0 = Math.max(k * SZ, z1), rz1 = Math.min((k + 1) * SZ, z2);
      const depth = (rz1 - GAP) - rz0;
      if (depth < 0.03) continue;
      const cz = (rz0 + rz1 - GAP) / 2;
      for (let j = Math.floor(x1 / SX); j < Math.ceil(x2 / SX); j++) {
        const rx0 = Math.max(j * SX, x1), rx1 = Math.min((j + 1) * SX, x2);
        const len = (rx1 - GAP) - rx0;
        if (len < 0.03) continue;
        const sf = SHADES[Math.floor(hash(k * 73.1 + j * 19.7) * SHADES.length) % SHADES.length];
        tiles.push({ cx: (rx0 + rx1 - GAP) / 2, cz, len, depth, r: cr * sf, g: cg * sf, b: cb * sf });
      }
    }
  }

  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({}), tiles.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  tiles.forEach((p, i) => {
    m.makeScale(p.len, PH, p.depth);
    m.setPosition(p.cx, fy + PH / 2, p.cz);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, col.setRGB(p.r, p.g, p.b));
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  scene.add(inst);
}
