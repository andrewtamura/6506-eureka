// Per-room ceilings. They always block the sun (castShadow) so daylight only
// reaches the interior through windows and open doorways — never "through" the
// ceiling. Visually they're opaque in the first-person (POV) view and
// transparent in the plan/overview (so you can see down into the rooms).
import * as THREE from "three";

export function buildCeilings({ scene, rooms, ceilingY }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xf2efe9, roughness: 0.95 });
  for (const r of rooms) {
    const b = r.box;
    const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
    if (sx < 0.2 || sz < 0.2) continue;
    // oversize generously so adjacent room ceilings overlap across walls and
    // door thresholds (no sky leak overhead, no sun through the gaps)
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx + 1.3, 0.06, sz + 1.3), mat);
    m.position.set((b.min.x + b.max.x) / 2, ceilingY - 0.03, (b.min.z + b.max.z) / 2);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
  let plan = null;
  // POV: opaque. Plan/overview: transparent (but it still casts shadow, so the
  // sun never reaches the interior from above in either view).
  const setPlanView = (p) => {
    if (p === plan) return; plan = p;
    mat.transparent = p;
    mat.opacity = p ? 0.0 : 1.0;
    mat.depthWrite = !p;
    mat.needsUpdate = true;
  };
  return { setPlanView };
}
