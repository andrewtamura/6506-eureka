// Classical wall finish, built as procedural millwork meshes on the spans in
// paneling.json (the generator supplies each wall's extent + openings). Program,
// floor to ceiling:
//   - 10" baseboard (runs under the windows)
//   - board-and-batten field (also continues under the windows, down to the sill)
//   - window/door casing (architrave) with sill stool + apron under windows
//   - a continuous entablature (architrave + frieze + cornice) at the uniform
//     head line, running around all four walls (over windows AND doors)
// Lightweight, no asset files.
import * as THREE from "three";

const MILL = 0xefece4;   // millwork white (battens, casing, base, cornice)
const FIELD = 0xdcd7cb;  // slightly deeper field/frieze so the millwork reads
const BATTEN_W = 0.0254;        // 1" battens
const BATTEN_SPACING_FT = 1.0;  // 12" board grid, anchored at the wall corner

export async function buildWallFinish({ scene, floorY, ceilingY, baseUrl }) {
  let data;
  try { data = await (await fetch(`${baseUrl}paneling.json`)).json(); } catch (e) { return; }
  const { ft = 0.3048, xs = -1, zs = 1, baseboardFt = 10 / 12, headFt = 7, casingFt = 0.33, walls = [] } = data || {};
  const mill = new THREE.MeshStandardMaterial({ color: MILL, roughness: 0.8 });
  const field = new THREE.MeshStandardMaterial({ color: FIELD, roughness: 0.85 });
  const crownMat = new THREE.MeshStandardMaterial({ color: MILL, roughness: 0.8, side: THREE.DoubleSide });
  const world = (px, pz) => new THREE.Vector3(xs * px * ft, 0, -(zs * pz * ft));

  const bbH = baseboardFt * ft;
  const headY = headFt * ft;
  const wallTop = ceilingY - floorY;
  const caseW = casingFt * ft;

  // 1-D complement of [lo,hi] minus holes (with margin), in plan feet.
  const subtract = (lo, hi, holes, margin) => {
    const m = holes.map((h) => [Math.min(h[0], h[1]) - margin, Math.max(h[0], h[1]) + margin])
      .sort((a, b) => a[0] - b[0]);
    const out = []; let cur = lo;
    for (const [a, b] of m) { const A = Math.max(a, lo), B = Math.min(b, hi); if (A > cur) out.push([cur, A]); cur = Math.max(cur, B); }
    if (cur < hi) out.push([cur, hi]);
    return out.filter(([a, b]) => b - a > 0.25);
  };

  for (const w of walls) {
    const planAt = (s) => (w.along === "x" ? [s, w.at] : [w.at, s]);
    const P = (s) => world(...planAt(s));
    const dir = P(w.hi).clone().sub(P(w.lo)); dir.y = 0; dir.normalize();
    const rotY = Math.atan2(-dir.z, dir.x);     // box local +X -> along the wall
    // interior normal (world): map the wall midpoint and a point offset by the
    // plan normal, then take the difference.
    const mid = (w.lo + w.hi) / 2;
    const nMidPlan = w.along === "x" ? [mid, w.at] : [w.at, mid];
    const nOff = [nMidPlan[0] + w.normal[0] * 0.5, nMidPlan[1] + w.normal[1] * 0.5];
    const Nw = world(nOff[0], nOff[1]).sub(world(nMidPlan[0], nMidPlan[1])); Nw.y = 0; Nw.normalize();

    // a horizontal band from s0..s1 at height y0..y1, projecting `depth` into room
    const band = (s0, s1, y0, y1, depth, m = mill) => {
      const A = P(s0), B = P(s1); const L = A.distanceTo(B); if (L < 0.02) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, y1 - y0, depth), m);
      mesh.position.set((A.x + B.x) / 2 + Nw.x * depth / 2, floorY + (y0 + y1) / 2, (A.z + B.z) / 2 + Nw.z * depth / 2);
      mesh.rotation.y = rotY; scene.add(mesh);
    };
    // a vertical post of width `wd` (along wall) centred at s, y0..y1
    const post = (s, y0, y1, wd, depth, m = mill) => {
      const C = P(s);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(wd, y1 - y0, depth), m);
      mesh.position.set(C.x + Nw.x * depth / 2, floorY + (y0 + y1) / 2, C.z + Nw.z * depth / 2);
      mesh.rotation.y = rotY; scene.add(mesh);
    };
    const doors = w.doors || [], wins = w.windows || [];
    const winX = wins.map((q) => [q[0], q[1]]);
    const caseInset = caseW / ft + 0.05; // feet — keep field/battens off the casing

    // 1) baseboard — minus doors only (continuous under windows)
    for (const [a, b] of subtract(w.lo, w.hi, doors, 0.12)) band(a, b, 0, bbH, 0.05);

    // 2) board-and-batten field backings: solid columns (minus doors+windows)
    //    full bbH..head, and under each window bbH..sill. Collect the field
    //    regions (with their top) so battens can be laid on one grid below.
    const regions = []; // [a, b, yTop]
    for (const [a, b] of subtract(w.lo, w.hi, [...doors, ...winX], caseInset)) {
      band(a, b, bbH, headY, 0.012, field); regions.push([a, b, headY]);
    }
    for (const [a, b, sill] of wins) {
      const sy = sill * ft; if (sy - bbH < 0.06) continue;
      band(a, b, bbH, sy, 0.012, field); regions.push([a + caseInset, b - caseInset, sy]);
    }
    // Battens on a 12" grid anchored at the corner (w.lo) moving inward — drawn
    // only where a grid line falls inside a field region (so none double up next
    // to a casing jamb, and boards read consistently from the corner).
    for (let g = w.lo + BATTEN_SPACING_FT; g < w.hi - 0.05; g += BATTEN_SPACING_FT) {
      for (const [ra, rb, yTop] of regions) {
        if (g > ra + 0.04 && g < rb - 0.04) { post(g, bbH, yTop, BATTEN_W, 0.03); break; }
      }
    }

    // 3) cornice matching the photo — NO dentils: a plain frieze, a small bed
    //    mold, and a stepped cove crown that projects ~5" and miters at corners.
    const Hc = 0.19, P5 = 0.127;            // crown height / 5" projection (m)
    const crownB = wallTop - Hc;            // crown springline
    band(w.lo, w.hi, headY, headY + 0.05, 0.04);             // architrave cap (atop casing)
    band(w.lo, w.hi, headY + 0.05, crownB - 0.05, 0.012, field); // frieze (flat, recessed)
    band(w.lo, w.hi, crownB - 0.05, crownB, 0.05);           // bed mold under the crown
    // stepped cove crown: a profile (X = projection into room, Y = up) extruded
    // along the wall, oriented via a basis (X->normal, Y->up, Z->wall dir).
    {
      const A = P(w.lo), B = P(w.hi), L = A.distanceTo(B);
      const dir = B.clone().sub(A); dir.y = 0; dir.normalize();
      const shape = new THREE.Shape();
      shape.moveTo(0, 0); shape.lineTo(0, Hc); shape.lineTo(P5, Hc);  // back up wall, out along ceiling
      shape.lineTo(P5, Hc - 0.022);                                   // ceiling fillet
      shape.quadraticCurveTo(0.012, Hc - 0.11, 0.05, 0.052);         // big cove (concave)
      shape.lineTo(0.05, 0.028); shape.lineTo(0.022, 0.028);          // bottom fascia
      shape.lineTo(0.022, 0); shape.lineTo(0, 0);                     // fillet back to wall
      const geo = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false });
      const crown = new THREE.Mesh(geo, crownMat);
      crown.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Nw, new THREE.Vector3(0, 1, 0), dir));
      crown.position.set(A.x, floorY + crownB, A.z);
      scene.add(crown);
    }

    // 4) window casing: jambs (sill..head) + sill stool + apron
    for (const [a, b, sill] of wins) {
      const sy = sill * ft;
      post(a, sy, headY, caseW, 0.045); post(b, sy, headY, caseW, 0.045);
      band(a - caseW / ft, b + caseW / ft, sy, sy + 0.04, 0.07);          // stool
      band(a, b, sy - 0.12, sy, 0.05);                                     // apron
    }
    // 5) door casing: jambs (floor..head)
    for (const [a, b] of doors) { post(a, 0, headY, caseW, 0.045); post(b, 0, headY, caseW, 0.045); }
  }
}
