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

  // 1-D complement of [lo,hi] minus holes (with margin), in plan feet. `minlen`
  // drops spans shorter than that (use a tiny value to keep the board continuous
  // right up to the openings; the default trims degenerate baseboard slivers).
  const subtract = (lo, hi, holes, margin, minlen = 0.25) => {
    const m = holes.map((h) => [Math.min(h[0], h[1]) - margin, Math.max(h[0], h[1]) + margin])
      .sort((a, b) => a[0] - b[0]);
    const out = []; let cur = lo;
    for (const [a, b] of m) { const A = Math.max(a, lo), B = Math.min(b, hi); if (A > cur) out.push([cur, A]); cur = Math.max(cur, B); }
    if (cur < hi) out.push([cur, hi]);
    return out.filter(([a, b]) => b - a > minlen);
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

    // 2) board-and-batten field: the BOARD (flat backing) is continuous across the
    //    whole wall, corner to corner — full height (bbH..head) everywhere except
    //    the openings, plus a continuous strip under each window (bbH..sill). It
    //    runs right up to the opening edges (the casing overlays it), so there are
    //    no gaps next to the trim.
    const openings = [...doors, ...winX].map(([a, b]) => [Math.min(a, b), Math.max(a, b)]);
    for (const [a, b] of subtract(w.lo, w.hi, [...doors, ...winX], 0, 0.02)) band(a, b, bbH, headY, 0.012, field);
    for (const [a, b, sill] of wins) {
      const sy = sill * ft; if (sy - bbH < 0.06) continue;
      band(a, b, bbH, sy, 0.012, field);
    }
    // Battens on a 12" grid anchored at the corner (w.lo). The board stays
    // continuous; a batten is simply OMITTED where its grid line lands inside a
    // door (no board there) or within a casing-width of any opening edge (so it
    // never doubles up against the trim).
    for (let g = w.lo + BATTEN_SPACING_FT; g < w.hi - 0.05; g += BATTEN_SPACING_FT) {
      if (doors.some(([a, b]) => g > Math.min(a, b) && g < Math.max(a, b))) continue; // in a doorway
      if (openings.some(([oa, ob]) => Math.abs(g - oa) < caseInset || Math.abs(g - ob) < caseInset)) continue; // too near trim
      let yTop = headY; // under a window the batten stops at the sill
      for (const [a, b, sill] of wins) { if (g > Math.min(a, b) && g < Math.max(a, b)) { yTop = sill * ft; break; } }
      if (yTop - bbH < 0.25) continue; // skip stubby battens (e.g. under a low sill)
      post(g, bbH, yTop, BATTEN_W, 0.03);
    }

    // 3) cornice: an entablature that sits DIRECTLY on top of the 7' opening
    //    heads (door-head line) — frieze, small bed mold, then a cove crown with
    //    a straight topper — with plain wall above it up to the ceiling. The cove
    //    height equals the frieze height. The crown runs on all four walls and
    //    miters at the corners.
    const topperH = 0.03, bedH = 0.04, P5 = 0.127;   // topper / bed-mold / 5" projection (m)
    const friezeH = 0.16, coveH = friezeH;   // frieze height == cove height (per spec)
    const Hc = coveH + topperH;             // total crown height
    const friezeTop = headY + friezeH;      // frieze bottom sits on the opening head
    const crownB = friezeTop + bedH;        // crown springline (bottom of crown)
    const crownTop = crownB + Hc;           // top of the crown
    band(w.lo, w.hi, headY, friezeTop, 0.024);             // FRIEZE — sits on the opening head (== cove height)
    band(w.lo, w.hi, friezeTop, friezeTop + 0.018, 0.05);  // bed mold: lower bead (most proud)
    band(w.lo, w.hi, friezeTop + 0.018, crownB, 0.058);    // bed mold: upper step
    band(w.lo, w.hi, crownTop, wallTop, 0.012, field);     // plain wall above the cornice, up to the ceiling
    // cove crown: a single concave COVE (quarter-hollow, height coveH) with a
    // STRAIGHT TOPPER (height topperH) running from the top of the cove out to
    // the crown top — together they read as the S-curve in the photo, but it's a
    // cove + flat topper, not an ogee. Profile is (X = projection into room,
    // Y = up); extruded along a RIGHT-HANDED basis (X->interior normal, Y->up,
    // Z->normal x up) so the rotation is valid on all four walls (a left-handed
    // basis would yield a bad quaternion and drop the crown off two of them); the
    // extrusion starts from whichever wall end lies in the +Z direction.
    {
      const A = P(w.lo), B = P(w.hi), L = A.distanceTo(B);
      const up = new THREE.Vector3(0, 1, 0);
      const zAxis = new THREE.Vector3().crossVectors(Nw, up).normalize(); // right-handed third axis
      const start = zAxis.dot(B.clone().sub(A)) >= 0 ? A : B;             // so the span runs A..B
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(0, 0.016);                                  // bottom fillet (fascia) at wall
      shape.quadraticCurveTo(0, coveH, 0.08, coveH);           // concave cove (up wall, sweep out)
      shape.lineTo(P5, Hc - 0.012);                            // straight topper (flat slope outward)
      shape.lineTo(P5, Hc);                                    // top fillet
      shape.lineTo(0, Hc);                                     // top face back to wall
      shape.lineTo(0, 0);                                      // down the wall (back face)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false });
      const crown = new THREE.Mesh(geo, crownMat);
      crown.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Nw, up, zAxis));
      crown.position.set(start.x, floorY + crownB, start.z);
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
