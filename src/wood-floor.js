// Realistic hardwood floor rendered as ONE THREE.InstancedMesh (every plank in
// every room is a single draw call), instead of the IFC's hundreds of plank
// solids — which the fragments engine streams/re-renders as the camera moves.
//
// Which coverings are plank floors (and their colour) comes from floors.json,
// emitted by the generator — an explicit contract rather than guessing by name.
// The plank grid uses GLOBAL world coordinates so boards line up and run
// continuously across rooms and through doorways.
import * as THREE from "three";

const FT = 0.3048;
const PW = 0.5 * FT, RGAP = 0.012 * FT;   // board width 6" (across grain, N-S)
const SEG = 10 * FT, EGAP = 0.03 * FT;    // board length 10' (along grain, E-W)
const PH = 0.02;                          // plank relief (height), metres
const SHADES = [0.82, 0.9, 0.97, 1.05, 1.12, 0.86, 1.0];
const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5; return x - Math.floor(x); };

export async function buildWoodFloor({ scene, model, fragments, floorY, baseUrl, manifestFile = "floors.json" }) {
  let manifest = [];
  try { manifest = await (await fetch(`${baseUrl}${manifestFile}`)).json(); } catch (e) { /* none */ }
  if (!manifest.length) return;

  const covs = Object.values(await model.getItemsOfCategories([/IFCCOVERING/])).flat();
  const cdata = await model.getItemsData(covs, { attributesDefault: true });
  const cboxes = await model.getBoxes(covs);
  const byName = new Map();
  covs.forEach((id, i) => byName.set(String(cdata[i]?.Name?.value ?? ""), { id, box: cboxes[i] }));
  const floors = manifest.map((e) => ({ ...byName.get(e.name), rgb: e.rgb })).filter((f) => f.box);
  if (!floors.length) return;

  await model.setVisible(floors.map((f) => f.id), false); // hide the IFC plank geometry
  await fragments.core.update(true);

  const fy = floorY + 0.02;                  // plank underside, just above the slab
  const baseMat = new THREE.MeshLambertMaterial({ color: 0x2a1c0d }); // groove colour
  const planks = [];
  for (const fl of floors) {
    const bx = fl.box, [cr, cg, cb] = fl.rgb;
    const x1 = bx.min.x, x2 = bx.max.x, z1 = bx.min.z, z2 = bx.max.z;
    const base = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, z2 - z1), baseMat);
    base.rotation.x = -Math.PI / 2;
    base.position.set((x1 + x2) / 2, fy - 0.004, (z1 + z2) / 2);
    scene.add(base);
    for (let k = Math.floor(z1 / PW); k < Math.ceil(z2 / PW); k++) {
      const ry0 = Math.max(k * PW, z1), ry1 = Math.min((k + 1) * PW, z2);
      const depth = (ry1 - RGAP) - ry0;
      if (depth < 0.03) continue;
      const cz = (ry0 + ry1 - RGAP) / 2;
      const off = hash(k) * SEG;               // per-row stagger on the global grid
      for (let j = Math.floor((x1 - off) / SEG); j < Math.ceil((x2 - off) / SEG); j++) {
        const px0 = off + j * SEG;
        const a = Math.max(px0, x1), bEnd = Math.min(px0 + SEG - EGAP, x2);
        const len = bEnd - a;
        if (len < 0.05) continue;
        const sf = SHADES[Math.floor(hash(k * 131.7 + j * 7.31) * SHADES.length) % SHADES.length];
        planks.push({ cx: (a + bEnd) / 2, cz, len, depth, r: cr * sf, g: cg * sf, b: cb * sf });
      }
    }
  }

  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({}), planks.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  planks.forEach((p, i) => {
    m.makeScale(p.len, PH, p.depth);
    m.setPosition(p.cx, fy + PH / 2, p.cz);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, col.setRGB(p.r, p.g, p.b));
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  scene.add(inst);
}
