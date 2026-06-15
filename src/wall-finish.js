// Board-and-batten wall finish + baseboards, built as procedural meshes on the
// solid wall spans listed in paneling.json (the generator already subtracted
// door/window openings). Lightweight, no asset files.
import * as THREE from "three";

const PAINT = 0xe9e5dc;          // warm white millwork
const BASE_PROJ = 0.045;         // baseboard projection into the room (m)
const FIELD_PROJ = 0.012;        // recessed field backing
const BATTEN_PROJ = 0.03;        // battens stand proud of the field
const RAIL_PROJ = 0.038;         // top rail
const RAIL_H = 0.09;             // top-rail height (m)
const BATTEN_W = 0.06;           // batten width (m)
const BATTEN_SPACING = 0.55;     // target spacing between battens (m)

export async function buildWallFinish({ scene, floorY, ceilingY, baseUrl }) {
  let data;
  try { data = await (await fetch(`${baseUrl}paneling.json`)).json(); } catch (e) { return; }
  const { ft = 0.3048, xs = -1, zs = 1, baseboardFt = 10 / 12, walls = [] } = data || {};
  const world = (px, pz) => new THREE.Vector3(xs * px * ft, 0, -(zs * pz * ft));
  const paint = new THREE.MeshStandardMaterial({ color: PAINT, roughness: 0.85 });

  const bbH = baseboardFt * ft;
  const wallH = ceilingY - floorY;
  const fieldBottom = bbH, fieldTop = wallH - RAIL_H, fieldH = Math.max(0.1, fieldTop - fieldBottom);

  const add = (g, w, h, proj, cy) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, proj), paint);
    m.position.set(0, cy, proj / 2); // local +Z points into the room
    g.add(m);
  };

  for (const wall of walls) {
    const planAt = (s) => (wall.along === "x" ? [s, wall.at] : [wall.at, s]);
    const build = (spans, isField) => {
      for (const [a, b] of spans || []) {
        const A = world(...planAt(a)), B = world(...planAt(b));
        const L = A.distanceTo(B);
        if (L < 0.3) continue;
        const center = A.clone().add(B).multiplyScalar(0.5);
        // interior normal in world (from the plan normal at the wall midpoint)
        const mid = wall.along === "x" ? [(a + b) / 2, wall.at] : [wall.at, (a + b) / 2];
        const N = world(mid[0] + wall.normal[0] * 0.5, mid[1] + wall.normal[1] * 0.5)
          .sub(world(mid[0], mid[1])); N.y = 0; N.normalize();
        const g = new THREE.Group();
        g.position.set(center.x, floorY, center.z);
        g.rotation.y = Math.atan2(N.x, N.z); // local +Z -> interior normal; local X runs along the wall
        if (!isField) {
          add(g, L, bbH, BASE_PROJ, bbH / 2);                       // baseboard
        } else {
          add(g, L, fieldH, FIELD_PROJ, fieldBottom + fieldH / 2);  // recessed field
          add(g, L, RAIL_H, RAIL_PROJ, fieldTop + RAIL_H / 2);      // top rail
          const n = Math.max(2, Math.round(L / BATTEN_SPACING));    // vertical battens
          for (let i = 0; i <= n; i++) {
            const m = new THREE.Mesh(new THREE.BoxGeometry(BATTEN_W, fieldH, BATTEN_PROJ), paint);
            m.position.set(-L / 2 + (L * i) / n, fieldBottom + fieldH / 2, BATTEN_PROJ / 2);
            g.add(m);
          }
        }
        scene.add(g);
      }
    };
    build(wall.base, false);
    build(wall.field, true);
  }
}
