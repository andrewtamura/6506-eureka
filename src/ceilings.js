// Per-room ceilings. They always block the sun (castShadow) so daylight only
// reaches the interior through windows and open doorways — never "through" the
// ceiling. Visually they're opaque in the first-person (POV) view and
// transparent in the plan/overview (so you can see down into the rooms).
import * as THREE from "three";

export function buildCeilings({ scene, rooms, ceilingY, openings = [] }) {
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
  // A room's ceiling is cut around EVERY opening it holds — the stairwell void and any
  // skylight wells. Rather than special-casing a single hole with four bands, split the
  // slab on the openings' own edges and emit each grid cell that is not inside one. That
  // handles three skylights in a row as readily as one stairwell, with no ordering rules.
  const holds = (b, o) => o.minX > b.min.x - 0.5 && o.maxX < b.max.x + 0.5 &&
    o.minZ > b.min.z - 0.5 && o.maxZ < b.max.z + 0.5;
  for (const r of rooms) {
    const b = r.box;
    if (b.max.x - b.min.x < 0.2 || b.max.z - b.min.z < 0.2) continue;
    // grow by one wall thickness so the edge lands on the wall centerline (abuts
    // the neighbouring room's ceiling at the same line — no overlap, no balloon).
    const X1 = b.min.x - WALL / 2, X2 = b.max.x + WALL / 2;
    const Z1 = b.min.z - WALL / 2, Z2 = b.max.z + WALL / 2;
    const mine = openings.filter((o) => o && holds(b, o));
    if (!mine.length) { slab((X1 + X2) / 2, (Z1 + Z2) / 2, X2 - X1, Z2 - Z1); continue; }
    const cuts = (lo, hi, vals) => [...new Set([lo, hi, ...vals.filter((v) => v > lo && v < hi)])].sort((u, v) => u - v);
    const xs = cuts(X1, X2, mine.flatMap((o) => [o.minX, o.maxX]));
    const zs = cuts(Z1, Z2, mine.flatMap((o) => [o.minZ, o.maxZ]));
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (mine.some((o) => cx > o.minX && cx < o.maxX && cz > o.minZ && cz < o.maxZ)) continue;  // the hole
      slab(cx, cz, xs[i + 1] - xs[i], zs[j + 1] - zs[j]);
    }
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
