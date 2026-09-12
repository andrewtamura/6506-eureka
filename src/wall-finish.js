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
const BATTEN_SPACING_FT = 14 / 12;  // 14" board grid, anchored at the wall corner

export async function buildWallFinish({ scene, floorY, ceilingY, baseUrl, manifestFile = "paneling.json" }) {
  let data;
  try { data = await (await fetch(`${baseUrl}${manifestFile}`)).json(); } catch (e) { return; }
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
    const doors = w.doors || [], wins = w.windows || [], tall = w.tall || [];
    // Transoms carry their own frame and get no casing, stool or apron — but they are
    // still holes, and the band that fills from the head line to the ceiling has to be
    // cut around them or the glass is plastered over.
    const trans = w.transoms || [];
    // Sidelights are the same idea one band lower: their own frame, no casing, but
    // still holes the field below the head line has to be cut around.
    const sides = w.sidelights || [];
    // Doors framed by something else (a steel screen's own mullions) take no casing.
    const bare = w.bareDoors || [];
    const winX = wins.map((q) => [q[0], q[1]]);
    const tallX = tall.map((t) => [t[0], t[1]]);   // full-height built-in openings (e.g. the hutch)
    const caseInset = caseW / ft + 0.05; // feet — keep field/battens off the casing

    // --- moulded architrave -----------------------------------------------------
    // A flat board reads as a flat board. A real casing is a BACKBAND at the outer
    // edge, a flat field, and a bead next to the opening — three planes at three
    // depths, so the trim catches light in steps. band() and post() both project
    // outward FROM the wall face, so stacking depths gives the steps for free.
    const CASE_P = [[0.30, 0.064], [0.48, 0.042], [0.22, 0.056]];  // [share of caseW, depth m], outer -> inner
    const cwf = caseW / ft;                                        // casing width in plan feet

    // Vertical jamb centred on `s`; `sgn` points from the outer edge toward the opening.
    const archV = (s, y0, y1, sgn) => {
      let off = -sgn * cwf / 2;
      for (const [share, d] of CASE_P) {
        const wd = share * cwf;
        post(s + off + sgn * wd / 2, y0, y1, wd * ft, d);
        off += sgn * wd;
      }
    };
    // Horizontal run from s0..s1 occupying yLo..yLo+caseW; `up` true puts the backband
    // at the TOP (a head), false at the bottom (a stool nosing).
    const archH = (s0, s1, yLo, up) => {
      let off = 0;
      for (const [share, d] of CASE_P) {
        const h = share * caseW;
        const y = up ? yLo + caseW - off - h : yLo + off;
        band(s0, s1, y, y + h, d);
        off += h;
      }
    };
    // MITRED RETURN: the profile turns the corner at the end of a run and dies back
    // into the wall, instead of stopping at a square cut that shows its section. A
    // 45 deg mitre runs back as far as it stands proud, so the steps walk the
    // projection to nothing over exactly that distance.
    //
    // The return eats the LAST `run` of the member, it does not extend past it: band()
    // boxes all start at the wall face, so a shallow box at the end cannot cut the deep
    // one behind it. The main run therefore has to stop short and the steps fill in.
    // Drawn the other way round, the trim simply grew longer with a staircase on the end.
    const mitreEnd = (sEnd, sgn, yLo, yHi, depth) => {
      const run = depth / ft;
      for (let i = 0; i < 3; i++) {
        const d = depth * (i + 1) / 4;                    // shallowest at the very end
        band(sEnd + sgn * i * run / 3, sEnd + sgn * (i + 1) * run / 3, yLo, yHi, d);
      }
      return run;
    };

    // 1) baseboard — minus doors + full-height built-ins (continuous under windows)
    for (const [a, b] of subtract(w.lo, w.hi, [...doors, ...tallX], 0.12)) band(a, b, 0, bbH, 0.05);

    // 2) board-and-batten field: the BOARD (flat backing) is continuous across the
    //    whole wall, corner to corner — full height (bbH..head) everywhere except
    //    the openings, plus a continuous strip under each window (bbH..sill). It
    //    runs right up to the opening edges (the casing overlays it), so there are
    //    no gaps next to the trim.
    const openings = [...doors, ...winX, ...tallX, ...sides].map(([a, b]) => [Math.min(a, b), Math.max(a, b)]);
    for (const [a, b] of subtract(w.lo, w.hi, [...doors, ...winX, ...tallX, ...sides], 0, 0.02))
      band(a, b, bbH, headY, 0.012, field);
    for (const [a, b, sill] of wins) {
      const sy = sill * ft; if (sy - bbH < 0.06) continue;
      band(a, b, bbH, sy, 0.012, field);
    }
    // Battens on ONE continuous 14" grid anchored at the corner (w.lo) — the SAME
    // rhythm for the tall full-height battens and the shorter battens under the
    // windows (a grid line under a window simply stops at the sill). A batten is
    // omitted only where it lands inside a doorway (no board there) or where it
    // would physically overlap a casing jamb (so it never doubles up on the trim),
    // which keeps the spacing uniform right through the openings.
    const battenClear = caseW / ft / 2 + 0.02; // half the casing width — overlap only
    // A room can keep the recessed field, baseboard and casings but drop the vertical
    // strapping over them (`battens: false`).
    for (let g = w.noBattens ? w.hi : w.lo + BATTEN_SPACING_FT; g < w.hi - 0.05; g += BATTEN_SPACING_FT) {
      if ([...doors, ...tallX].some(([a, b]) => g > Math.min(a, b) && g < Math.max(a, b))) continue; // in a doorway / built-in
      if (openings.some(([oa, ob]) => Math.abs(g - oa) < battenClear || Math.abs(g - ob) < battenClear)) continue; // would touch a jamb
      let yTop = headY; // under a window the batten stops at the sill
      for (const [a, b, sill] of wins) { if (g > Math.min(a, b) && g < Math.max(a, b)) { yTop = sill * ft; break; } }
      if (yTop - bbH < 0.25) continue; // skip stubby battens (e.g. under a low sill)
      post(g, bbH, yTop, BATTEN_W, 0.03);
    }

    // 2b) WAINSCOT — a framed dado on the walls that ask for it. Real relief in three
    //     planes: the wall's own recessed field (0.012), a panel ground proud of it,
    //     then rails and stiles proud of that, capped by the chair rail. `subtract`
    //     breaks each run at the doorways with the same margin the baseboard uses, so
    //     the rail dies behind the door casing rather than butting its edge.
    if (w.wainscot) {
      const capY = (w.chairRailFt || 3.0) * ft;
      const RAILH = 0.085, CAPH = 0.075, SW = 0.33;       // bottom rail / cap heights (m), stile width (ft)
      for (const [a, b] of subtract(w.lo, w.hi, [...doors, ...tallX], 0.12)) {
        band(a, b, bbH, capY, 0.020, field);              // panel ground
        band(a, b, bbH, bbH + RAILH, 0.045);              // bottom rail, sitting on the baseboard
        band(a, b, capY - CAPH, capY, 0.075);             // chair rail cap
        const n = Math.max(1, Math.round((b - a) / 1.7)); // panels about 20 in wide
        for (let i = 0; i <= n; i++) {
          const s = a + ((b - a) * i) / n;
          post(i === 0 ? s + SW / 2 : i === n ? s - SW / 2 : s, bbH, capY, SW * ft, 0.045);
        }
      }
    }

    // A wall can opt out of the entablature (`noCornice`) while keeping the rest of
    // the trim program — the crown, its frieze and bed mould, and the plain field
    // above them all belong to this block.
    if (!w.noCornice) {
      // 3) cornice: an entablature that sits DIRECTLY on top of the 7' opening
      //    heads (door-head line) — frieze, small bed mold, then a cove crown with
      //    a straight topper — with plain wall above it up to the ceiling. The cove
      //    height equals the frieze height. The crown runs on all four walls and
      //    miters at the corners, but BREAKS around full-height built-ins (`tall`),
      //    which run past the cornice; plain wall fills above each built-in instead.
      const topperH = 0.03, bedH = 0.04, P5 = 0.127;   // topper / bed-mold / 5" projection (m)
      const friezeH = 0.16, coveH = friezeH;   // frieze height == cove height (per spec)
      const Hc = coveH + topperH;             // total crown height
      const friezeTop = headY + friezeH;      // frieze bottom sits on the opening head
      const crownB = friezeTop + bedH;        // crown springline (bottom of crown)
      const crownTop = crownB + Hc;           // top of the crown
      // cove crown: a single concave COVE (quarter-hollow, height coveH) with a
      // STRAIGHT TOPPER (height topperH) — together they read as the S-curve in the
      // photo. Profile is (X = projection into room, Y = up); extruded along a
      // RIGHT-HANDED basis (X->interior normal, Y->up, Z->normal x up) so the
      // rotation is valid on all four walls; the extrusion starts from whichever
      // span end lies in the +Z direction.
      for (const [s0, s1] of subtract(w.lo, w.hi, tallX, 0, 0.05)) {
        band(s0, s1, headY, friezeTop, 0.024);             // FRIEZE — sits on the opening head
        band(s0, s1, friezeTop, friezeTop + 0.018, 0.05);  // bed mold: lower bead
        band(s0, s1, friezeTop + 0.018, crownB, 0.058);    // bed mold: upper step
        band(s0, s1, crownTop, wallTop, 0.012, field);     // plain wall above the cornice, up to the ceiling
        const A = P(s0), B = P(s1), L = A.distanceTo(B);
        const up = new THREE.Vector3(0, 1, 0);
        const zAxis = new THREE.Vector3().crossVectors(Nw, up).normalize(); // right-handed third axis
        const start = zAxis.dot(B.clone().sub(A)) >= 0 ? A : B;             // so the span runs s0..s1
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
      // plain wall above each full-height built-in (from its head up to the ceiling)
      for (const [a, b, th] of tall) band(a, b, th * ft, wallTop, 0.012, field);
    } else {
      // With no entablature the field has to carry on from the head line to the
      // ceiling itself — the band that normally fills above the crown lives inside
      // the block above, so without this the wall is bare from 7'0" up.
      for (const [s0, s1] of subtract(w.lo, w.hi, [...tallX, ...trans], 0, 0.05))
        band(s0, s1, headY, wallTop, 0.012, field);
      for (const [a, b, th] of tall) band(a, b, th * ft, wallTop, 0.012, field);
    }

    // 4) window casing: moulded jambs + HEAD + a stool with mitred returns + apron
    for (const [a, b, sill, plainBelow] of wins) {
      const sy = sill * ft;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      archV(lo, sy, headY, +1); archV(hi, sy, headY, -1);                 // jambs, moulded
      // The head was missing on every window in the house — the same gap doors had,
      // fixed for doors and never carried across. Two verticals and a stool with
      // nothing over them reads as an unfinished opening. It returns past both jambs
      // and MITRES back to the wall at each end rather than stopping square.
      const hOut = cwf;                        // horn past each jamb, as the door head returns
      const hRun = mitreEnd(lo - hOut, +1, headY, headY + caseW, 0.064)
                 + (mitreEnd(hi + hOut, -1, headY, headY + caseW, 0.064), 0);
      archH(lo - hOut + hRun, hi + hOut - hRun, headY, true);             // profile between the mitres
      // STOOL: a projecting sill board, nosed, and mitred back to the wall at the horns.
      const sTop = sy + 0.04, sD = 0.075;
      const sRun = mitreEnd(lo - hOut, +1, sy, sTop, sD)
                 + (mitreEnd(hi + hOut, -1, sy, sTop, sD), 0);
      band(lo - hOut + sRun, hi + hOut - sRun, sy, sTop, sD);             // the board
      archH(lo - hOut + sRun, hi + hOut - sRun, sy - 0.055, false);       // moulded nosing under it
      // The apron is a 2" proud board the exact width of the window. Where the wall
      // below is open floor rather than a counter it hangs 25" up with nothing under
      // it and reads as a stray panel, so `plainBelow` drops it and the field and
      // battens simply carry on to the stool.
      if (!plainBelow) band(a, b, sy - 0.12, sy, 0.05);                    // apron
    }
    // 5) door casing: jambs (floor..head) PLUS a head casing across the top. The head
    //    was missing everywhere — every cased door in the house had two verticals and
    //    nothing over them, which is what left trimmed doorways still reading unfinished.
    for (const [a, b] of doors) {
      if (bare.some(([ba, bb]) => Math.abs(ba - a) < 0.01 && Math.abs(bb - b) < 0.01)) continue;
      post(a, 0, headY, caseW, 0.045); post(b, 0, headY, caseW, 0.045);
      const lo = Math.min(a, b) - caseW / ft, hi = Math.max(a, b) + caseW / ft;
      // Where a TRANSOM spans this door, its bar is already the head member across the
      // whole composition — a door with sidelights needs one continuous head, not a
      // short casing over the leaf and a longer bar in the same plane fighting it.
      const spanned = trans.some(([ta, tb]) =>
        Math.min(ta, tb) <= Math.min(a, b) + 0.01 && Math.max(ta, tb) >= Math.max(a, b) - 0.01);
      if (!spanned) band(lo, hi, headY, headY + caseW, 0.045);   // head, returning over both jambs
    }
  }
}
