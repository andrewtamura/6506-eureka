// Per-room ceilings. They always block the sun (castShadow) so daylight only
// reaches the interior through windows and open doorways — never "through" the
// ceiling. Visually they're opaque in the first-person (POV) view and
// transparent in the plan/overview (so you can see down into the rooms).
import * as THREE from "three";

export function buildCeilings({ scene, rooms, ceilingY, opening }) {
  // Each IfcSpace box is inset half a wall thickness from the wall centerlines, so
  // growing it by exactly one wall thickness lands the ceiling edge on the wall
  // CENTERLINE (halfway through the wall) — abutting the neighbour, not overlapping.
  const WALL = 0.4583 * 0.3048;                          // wall thickness (m), per model.json
  const mat = new THREE.MeshStandardMaterial({ color: 0xf2efe9, roughness: 0.95 });
  const slab = (cx, cz, sx, sz) => {
    if (sx < 0.05 || sz < 0.05) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.06, sz), mat);
    m.position.set(cx, ceilingY - 0.03, cz);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  };
  // the room that holds the stairwell void gets its ceiling cut open over it, so
  // looking up the stairwell reads through into the storey above (not a flat lid).
  const holds = (b) => opening && opening.minX > b.min.x - 0.5 && opening.maxX < b.max.x + 0.5 &&
    opening.minZ > b.min.z - 0.5 && opening.maxZ < b.max.z + 0.5;
  for (const r of rooms) {
    const b = r.box;
    const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
    if (sx < 0.2 || sz < 0.2) continue;
    // grow by one wall thickness so the edge lands on the wall centerline (abuts
    // the neighbouring room's ceiling at the same line — no overlap, no balloon).
    if (!holds(b)) { slab((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2, sx + WALL, sz + WALL); continue; }
    // frame the ceiling around the stairwell opening (4 bands) — hole stays clear
    const X1 = b.min.x - WALL / 2, X2 = b.max.x + WALL / 2, Z1 = b.min.z - WALL / 2, Z2 = b.max.z + WALL / 2;
    const oX1 = opening.minX, oX2 = opening.maxX, oZ1 = opening.minZ, oZ2 = opening.maxZ;
    slab((X1 + X2) / 2, (Z1 + oZ1) / 2, X2 - X1, oZ1 - Z1);   // south band
    slab((X1 + X2) / 2, (oZ2 + Z2) / 2, X2 - X1, Z2 - oZ2);   // north band
    slab((X1 + oX1) / 2, (oZ1 + oZ2) / 2, oX1 - X1, oZ2 - oZ1); // west band
    slab((oX2 + X2) / 2, (oZ1 + oZ2) / 2, X2 - oX2, oZ2 - oZ1); // east band
  }
  let plan = null;
  // POV: opaque. Plan/overview: transparent (but it still casts shadow, so the
  // sun never reaches the interior from above in either view).
  const setPlanView = (p) => {
    if (p === plan) return; plan = p;
    mat.transparent = p;
    mat.opacity = p ? 0.45 : 1.0;   // semi-transparent in the overview (see down into rooms, like the attic)
    mat.depthWrite = !p;
    mat.needsUpdate = true;
  };
  return { setPlanView };
}
