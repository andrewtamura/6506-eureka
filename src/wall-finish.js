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

    // --- real mouldings, swept ----------------------------------------------------
    // Stacked boxes cannot make a cove or an ovolo. These are PROFILES: a 2-D section
    // drawn once and extruded along the run, the same way the cornice below is built.
    //
    // A section is drawn in (X = projection into the room, Y = across the member's
    // width). `sweep` puts X on the wall normal, Y on whatever axis the member's width
    // runs along, and extrudes down the third — so one profile serves a vertical jamb
    // and a horizontal head without being redrawn.
    // `ends` cuts the extrusion's caps at 45 deg instead of square. A straight extrude
    // has flat caps perpendicular to the run, so butting a run against its return shows
    // the CUT FACE at the corner — you see the section end-on, and the profile stops
    // dead instead of turning. A real mitre is a 45 deg plane through the corner: the
    // long point at the wall, the short point at the front, so the two faces meet edge
    // to edge and the moulded face changes direction and runs back to the wall.
    //
    // With no bevel and one step, vertices exist only at z=0 and z=length, so the cut is
    // a shear on the caps: SQUARE leaves it, IN pulls it to z=x, OUT to z=length-x
    // (x being the profile's own projection, which is what makes the angle 45 deg).
    // Cuts, as seen looking down on the member. BACK_* is the one a return wants: the
    // LONG POINT AT THE FRONT and the short point at the wall, so the cut slopes
    // backwards toward the wall and the return piece tucks in behind it. FWD_* slopes
    // the other way — long point at the wall — which is what was here, and it presents
    // the cut face outward where you can see it.
    // FRAME_* is a different cut again: a picture-frame mitre, in the plane OF THE WALL
    // rather than the plane containing the projection. It is what joins a door's head to
    // its jambs — the two meet at 45 deg at each top corner and the architrave runs
    // round the opening with no overhang at all. Sheared by the section's WIDTH
    // coordinate (its Y) where BACK_*/FWD_* shear by its projection (its X).
    const SQUARE = 0, FWD_NEAR = 1, FWD_FAR = 2, BACK_NEAR = 3, BACK_FAR = 4,
          FRAME_NEAR = 5, FRAME_FAR = 6, FRAME_TOP = 7, FRAME_TOP_N = 8;
    const sweep = (shape, startPt, xAxis, yAxis, length, ends = [SQUARE, SQUARE], m = mill) => {
      if (length < 0.004) return;
      const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: 8 });
      const [nearCut, farCut] = ends;
      if (nearCut || farCut) {
        const pos = geo.getAttribute('position');
        let pmax = 0, wmax = 0;
        for (let i = 0; i < pos.count; i++) {
          pmax = Math.max(pmax, pos.getX(i));
          wmax = Math.max(wmax, pos.getY(i));
        }
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          const cut = z > length / 2 ? farCut : nearCut;
          if (cut === FWD_NEAR) pos.setZ(i, x);
          else if (cut === FWD_FAR) pos.setZ(i, length - x);
          else if (cut === BACK_NEAR) pos.setZ(i, pmax - x);
          else if (cut === BACK_FAR) pos.setZ(i, length - pmax + x);
          else if (cut === FRAME_NEAR) pos.setZ(i, wmax - y);
          else if (cut === FRAME_FAR) pos.setZ(i, length - wmax + y);
          else if (cut === FRAME_TOP) pos.setZ(i, length - y);
          // Same mitre on a jamb swept DOWNWARD, where z counts from the top: the cut
          // lands on the near cap and runs the other way. Using FRAME_TOP there drove
          // the near cap to the far end and collapsed the jamb to a stub.
          else if (cut === FRAME_TOP_N) pos.setZ(i, y);
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();
      }
      const mesh = new THREE.Mesh(geo, m);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        xAxis.clone().normalize(), yAxis.clone().normalize(), zAxis));
      mesh.position.copy(startPt);
      mesh.castShadow = true; mesh.receiveShadow = true;
      scene.add(mesh);
    };
    const UP = new THREE.Vector3(0, 1, 0);
    const cwf = caseW / ft;                                        // casing width, plan feet

    // ARCHITRAVE: backband, fillet, COVE, fascia, OVOLO, then a bead dying into the
    // opening. Outer edge at Y=0, opening edge at Y=caseW.
    const casingShape = (() => {
      const W = caseW, P = 0.030;
      const sh = new THREE.Shape();
      sh.moveTo(0, 0);
      sh.lineTo(P, 0);                                            // backband, out from the wall
      sh.lineTo(P, W * 0.20);                                     // its square face
      sh.lineTo(P * 0.60, W * 0.22);                              // fillet, stepping in
      sh.quadraticCurveTo(P * 0.40, W * 0.33, P * 0.58, W * 0.44); // COVE — concave
      sh.lineTo(P * 0.66, W * 0.54);                              // fascia
      sh.quadraticCurveTo(P * 0.97, W * 0.66, P * 0.60, W * 0.82); // OVOLO — convex
      sh.quadraticCurveTo(P * 0.40, W * 0.90, P * 0.26, W);        // bead, dying in
      sh.lineTo(0, W);
      sh.lineTo(0, 0);
      return sh;
    })();
    const CASE_P = 0.030;                                          // its max projection

    // STOOL: a sill board, bullnosed at the front and undercut beneath.
    // Slim: a stool is a ~2 in board with a nosed edge, not a rolled bar. At 0.085 x
    // 0.042 the bullnose swallowed the whole section and it read as a tube.
    const stoolShape = (() => {
      const D = 0.055, T = 0.026;
      const sh = new THREE.Shape();
      sh.moveTo(0, 0);
      sh.lineTo(D * 0.62, 0);
      sh.quadraticCurveTo(D * 0.94, 0, D, T * 0.34);              // ogee under the nosing
      sh.quadraticCurveTo(D, T * 0.86, D * 0.80, T);              // nosed over the top
      sh.lineTo(0, T);
      sh.lineTo(0, 0);
      return sh;
    })();
    const STOOL_D = 0.055;

    // APRON: a SPRUNG section, like crown — not a flat board laid on the wall. It seats
    // on two surfaces, the wall behind it and the stool's underside above it, with the
    // moulded face sweeping diagonally between them. That is what makes the mitre work:
    // a sprung section cut at 45 deg meets its return along the whole diagonal, so the
    // profile turns the corner and dies into the wall with no flat face anywhere. A
    // flat back-face board has nothing to return INTO, which is why its "mitre" kept
    // reading as a block stuck on the end.
    // Shape coords here are (X = projection from the wall, Y = drop below the stool),
    // Y running downward because the apron is swept flipped.
    const apronShape = (() => {
      const H = caseW, PJ = 0.050;
      const sh = new THREE.Shape();
      sh.moveTo(0, 0);                                            // wall, at the stool soffit
      sh.lineTo(0, H);                                            // down the wall — the back seat
      sh.lineTo(PJ * 0.16, H);                                    // bottom fillet
      sh.quadraticCurveTo(PJ * 0.40, H * 0.88, PJ * 0.54, H * 0.58); // COVE, sweeping out and up
      sh.quadraticCurveTo(PJ * 0.72, H * 0.34, PJ, H * 0.20);     // OGEE reversing into the soffit
      sh.lineTo(PJ, H * 0.06);
      sh.lineTo(PJ * 0.86, 0);                                    // top seat, under the stool
      sh.lineTo(0, 0);
      return sh;
    })();
    const APRON_P = 0.050;

    // A run of moulding plus MITRED RETURNS: at each end the same section is swept
    // perpendicular, so the profile wraps the corner and dies into the wall instead of
    // stopping at a square cut that shows its section as a flat face.
    const mouldH = (s0, s1, yLo, shape, proj, flip) => {
      // The mitre EATS the last `proj` of the run at each end — s0..s1 is the finished
      // length of the assembly, returns included. Swept the other way the returns hang
      // off the ends and the member is 2 x proj longer than asked for, which is how a
      // 3/4 in horn measured 1.93 in. (The box version had the same bug; sweeping the
      // profile reintroduced it.)
      const pf = proj / ft;
      const A = P(s0), B = P(s1);
      const along = B.clone().sub(A).setY(0).normalize();
      const across = flip ? UP.clone().negate() : UP.clone();
      // The RUN gets a 45 deg cut at each end — long point at the wall, short point at
      // the front — so it now runs the assembly's full length and the mitre takes the
      // material back, rather than the run being shortened and a block set beside it.
      const zAxis = new THREE.Vector3().crossVectors(Nw, across).normalize();
      const fwd = zAxis.dot(B.clone().sub(A)) >= 0;
      const startPt = fwd ? A : B;
      sweep(shape, new THREE.Vector3(startPt.x, floorY + yLo, startPt.z),
            Nw, across, A.distanceTo(B), [BACK_NEAR, BACK_FAR]);
      // The RETURN is the matching wedge: the same section, turned so its moulded face
      // looks along the wall, swept from the wall out to the front, and cut at 45 deg on
      // the face that meets the run. The two cut faces are the same plane, so the profile
      // carries round the corner and dies into the wall.
      for (const [endS, out] of [[s0, along.clone().negate()], [s1, along.clone()]]) {
        // origin one projection INBOARD, with X running outward to the assembly's end
        const originPlan = endS + (out.dot(along) > 0 ? -pf : pf);
        const o = P(originPlan);
        const base = new THREE.Vector3(o.x, floorY + yLo, o.z);
        const zr = new THREE.Vector3().crossVectors(out, across).normalize();
        // MATCHING cut: the return's 45 deg face has to lie in the same plane as the
        // run's, which is the opposite assignment to the run's own — the wedge tucks in
        // BEHIND the run's long front point, thick at the wall and dying at the front.
        sweep(shape, zr.dot(Nw) >= 0 ? base : base.clone().add(Nw.clone().multiplyScalar(proj)),
              out, across, proj, zr.dot(Nw) >= 0 ? [SQUARE, FWD_NEAR] : [FWD_FAR, SQUARE]);
      }
    };
    const mouldV = (s, y0, y1, shape, sgn, topCut = SQUARE) => {
      const C = P(s);
      const along = new THREE.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(sgn);
      const base = new THREE.Vector3(C.x, floorY + y0, C.z)
        .add(along.clone().multiplyScalar(-caseW / 2));
      const zAxis = new THREE.Vector3().crossVectors(Nw, along).normalize();
      const up = zAxis.y >= 0;
      const downCut = topCut === FRAME_TOP ? FRAME_TOP_N : topCut;
      sweep(shape, up ? base : base.clone().setY(floorY + y1), Nw, along, y1 - y0,
            up ? [SQUARE, topCut] : [downCut, SQUARE]);
    };

    // A door's architrave: three pieces MITRED to each other at the top corners, so it
    // runs round the opening as one frame. No horns — the head stops dead on the jambs'
    // outer edges. (A window's head is different: it caps a stool whose horns run past
    // the casing, so it overhangs on purpose.)
    const mouldFrame = (lo, hi, shape) => {
      const half = cwf / 2, top = headY + caseW;
      mouldV(lo, 0, top, shape, +1, FRAME_TOP);
      mouldV(hi, 0, top, shape, -1, FRAME_TOP);
      // The head is swept from the TOP DOWN so its section runs the same way round as
      // the jambs': backband on the OUTSIDE of the frame, bead next to the opening. Swept
      // upward from the head line the profile comes out mirrored — backband against the
      // opening — and then no cut can make the bands continue across the corner, because
      // the two pieces do not present the same section to the joint. That is what makes
      // a geometrically exact mitre still read as misaligned.
      const A = P(lo - half), B = P(hi + half);
      const across = UP.clone().negate();
      const zAxis = new THREE.Vector3().crossVectors(Nw, across).normalize();
      const startPt = zAxis.dot(B.clone().sub(A)) >= 0 ? A : B;
      sweep(shape, new THREE.Vector3(startPt.x, floorY + top, startPt.z),
            Nw, across, A.distanceTo(B), [FRAME_TOP_N, FRAME_TOP]);
    };

    // 1) baseboard — minus doors + full-height built-ins (continuous under windows)
    // A sidelight glazed to the FINISHED FLOOR takes no baseboard across it — the board
    // would run over the bottom of the glass, the same way the battens were running over
    // the middle of it. One with a raised sill keeps its baseboard, which is why `sides`
    // carries the sill rather than this subtracting every sidelight.
    const lowSides = sides.filter((sd) => (sd[2] ?? 99) * ft < bbH).map(([a, b]) => [a, b]);
    for (const [a, b] of subtract(w.lo, w.hi, [...doors, ...tallX, ...lowSides], 0.12)) band(a, b, 0, bbH, 0.05);

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
      // A SIDELIGHT is glass, so a batten cannot cross it. The `wins` loop below stops a
      // batten at a window's sill, but sidelights are filed under `sides` (they carry
      // their own frame and take no casing), and `sides` is consulted only for jamb
      // clearance above — so a batten landing mid-sidelight was neither stopped nor
      // skipped and ran floor-to-head over the glass. That is what put five battens
      // across the foyer's screen.
      if (sides.some(([a, b]) => g > Math.min(a, b) && g < Math.max(a, b))) continue;
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

    // A COVED CEILING is independent of the entablature. A corniced room springs it off
    // the crown; a room with no entablature (the sitting and family rooms) springs it
    // off the plain wall the same distance below the ceiling, so every coved room reads
    // with the same curve. `coved` in the room's paneling turns it on, and is implied
    // for any wall that carries a cornice.
    // The band between the 7 ft head line and the ceiling is shared EQUALLY by the
    // ENTABLATURE and the COVE above it — that is the ratio the owner's photographed
    // corners show. Derived rather than hard-coded so it survives a change of ceiling
    // height: at 9'0" that was 12 in each, at 9'6" it is 15 in each.
    const CEIL_BAND = wallTop - headY;
    const COVE_H = CEIL_BAND / 2;
    const sweepCove = (s0, s1, springY) => {
      const H = wallTop - springY, Rc = H;
      if (H < 0.02) return;
      const A = P(s0), B = P(s1), L = A.distanceTo(B);
      if (L < 0.02) return;
      const up = new THREE.Vector3(0, 1, 0);
      const zAxis = new THREE.Vector3().crossVectors(Nw, up).normalize();
      const start = zAxis.dot(B.clone().sub(A)) >= 0 ? A : B;
      // A cove is a HOLLOW: tangent to the WALL where it springs and tangent to the
      // CEILING where it dies, so the control point sits at the intersection of those
      // two tangents — the wall/ceiling corner, (0.012, H). Putting it at (Rc, 0) is the
      // same quarter-round turned inside out — a bullnose bulging INTO the room — and
      // that is what shipped first, because at a glance in a render the two look alike.
      const cove = new THREE.Shape();
      cove.moveTo(0.012, 0);                      // springs off the field's face
      cove.quadraticCurveTo(0.012, H, Rc, H);     // the hollow
      cove.lineTo(0, H);                          // back along the ceiling to the wall
      cove.lineTo(0, 0);                          // down the wall plane
      cove.lineTo(0.012, 0);
      const cgeo = new THREE.ExtrudeGeometry(cove, { depth: L, bevelEnabled: false, curveSegments: 10 });
      const cmesh = new THREE.Mesh(cgeo, field);
      cmesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Nw, up, zAxis));
      cmesh.position.set(start.x, floorY + springY, start.z);
      cmesh.castShadow = true; cmesh.receiveShadow = true;
      scene.add(cmesh);
    };

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
      // The cove used to be whatever the entablature left over — 8.65 in against its
      // 15.4 — which is why it read as a gap rather than a designed curve. Now they
      // split the band; see CEIL_BAND above. The crown's projection scales with its
      // height or the profile stops being the same moulding.
      // ...so the entablature scales to whatever half the band is. Its own proportions
      // are fixed (0.39 m at full size) and ENT_K keeps them.
      const ENT_K = COVE_H / 0.39;
      const topperH = 0.03 * ENT_K, bedH = 0.04 * ENT_K, P5 = 0.127 * ENT_K;
      const friezeH = 0.16 * ENT_K, coveH = friezeH;   // frieze height == cove height (per spec)
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
      // A CORNICE BREAK is a span where the crown alone stops — a stair soffit cutting
      // across. Unlike a `tall` span it does not touch the baseboard, field, battens or
      // chair rail, which run on underneath (see the photos of the foyer: the
      // board-and-batten continues right under the stair). Plain field fills from the
      // head line to the ceiling over the break, the same as a `noCornice` wall.
      const brk = (w.corniceBreaks || []).map(([a, b]) => [Math.min(a, b), Math.max(a, b)]);
      for (const [a, b] of brk) band(a, b, headY, wallTop, 0.012, field);
      for (const [s0, s1] of subtract(w.lo, w.hi, [...tallX, ...brk], 0, 0.05)) {
        band(s0, s1, headY, friezeTop, 0.024);             // FRIEZE — sits on the opening head
        band(s0, s1, friezeTop, friezeTop + 0.018, 0.05);  // bed mold: lower bead
        band(s0, s1, friezeTop + 0.018, crownB, 0.058);    // bed mold: upper step
        // Above the crown the plaster curves into the ceiling rather than meeting it at
        // an arris. Inside this loop, so it inherits the cornice's spans for free: no
        // cove over the foyer's stair break, which is right — there is a stairwell void
        // up there and no ceiling to curve into.
        // Gated: a wall whose TOP rakes away — the short return around the under-stair
        // box, where the well wall's head falls from 10 ft to 4 — carries the crown but
        // cannot carry a cove, which would float above the wall it is supposed to die
        // into. `coved` is true for every ordinary corniced wall, so this changes
        // nothing elsewhere.
        if (w.coved) sweepCove(s0, s1, crownTop);
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
      // RAKED CROWN. Where the stair soffit comes down, the level cornice returns and
      // the crown climbs the rake beside the flight — the detail in the foyer photos.
      // Same profile as the level run; the only difference is the basis it is extruded
      // along. The level crown uses (Nw, up, along); a rake swaps `up` for the axis
      // perpendicular to the SLOPING direction within the wall plane, so the section
      // stays square to the moulding rather than shearing.
      for (const r of w.rakedCornice || []) {
        const s0 = r.pz0 ?? r.px0, s1 = r.pz1 ?? r.px1;
        const A = P(s0), B = P(s1);
        const y0 = floorY + r.y0 * ft, y1 = floorY + r.y1 * ft;
        const along = new THREE.Vector3(B.x - A.x, (y1 - y0) / 1, B.z - A.z).normalize();
        // perpendicular to the run, in the wall plane, pointing up
        const upR = new THREE.Vector3().crossVectors(along, Nw).normalize();
        if (upR.y < 0) { upR.negate(); }
        const zR = new THREE.Vector3().crossVectors(Nw, upR).normalize();
        // extrude from whichever end lies in +zR, so the run goes s0..s1
        const fwd = zR.dot(new THREE.Vector3(B.x - A.x, y1 - y0, B.z - A.z)) >= 0;
        const start = fwd ? A : B, startY = fwd ? y0 : y1;
        const L = Math.hypot(B.x - A.x, y1 - y0, B.z - A.z);
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(0, 0.016);
        shape.quadraticCurveTo(0, coveH, 0.08, coveH);
        shape.lineTo(P5, Hc - 0.012);
        shape.lineTo(P5, Hc);
        shape.lineTo(0, Hc);
        shape.lineTo(0, 0);
        const geo = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false });
        const crown = new THREE.Mesh(geo, crownMat);
        crown.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Nw, upR, zR));
        crown.position.set(start.x, startY, start.z);
        scene.add(crown);
      }
    } else {
      // With no entablature the field has to carry on from the head line to the
      // ceiling itself — the band that normally fills above the crown lives inside
      // the block above, so without this the wall is bare from 7'0" up.
      // A room with no entablature can still be coved (the sitting and family rooms are):
      // the field then stops at the cove's spring line instead of running to the ceiling.
      const fieldTop = w.coved ? wallTop - COVE_H : wallTop;
      for (const [s0, s1] of subtract(w.lo, w.hi, [...tallX, ...trans], 0, 0.05)) {
        band(s0, s1, headY, fieldTop, 0.012, field);
        if (w.coved) sweepCove(s0, s1, fieldTop);
      }
      for (const [a, b, th] of tall) band(a, b, th * ft, wallTop, 0.012, field);
    }

    // 4) window casing: moulded jambs + HEAD + a stool with mitred returns + apron
    for (const [a, b, sill, plainBelow] of wins) {
      const sy = sill * ft;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      mouldV(lo, sy, headY, casingShape, +1); mouldV(hi, sy, headY, casingShape, -1);
      // The head was missing on every window in the house — the same gap doors had,
      // fixed for doors and never carried across. Two verticals and a stool with
      // nothing over them reads as an unfinished opening. It returns past both jambs
      // and MITRES back to the wall at each end rather than stopping square.
      // HORN. Measured from the outboard edge of the CASING, not from the jamb — which
      // is the mistake that made these overhang: the casing is centred on the jamb, so
      // a horn of one casing width past the jamb is 2 in past the casing itself.
      // Millwork practice puts the stool horn 3/4-1 in beyond the casing's outer edge,
      // and a moulded (non-Craftsman) head caps it by about the same. Craftsman trim
      // overhangs 1-3 in, but that is flat stock reading as a lintel — this is a
      // cove-and-ovolo architrave, where a heavy overhang just looks slack.
      const HORN = 0.75 / 12;                  // 3/4 in past the casing edge
      const hOut = cwf / 2 + HORN;             // ...so, past the JAMB
      // Swept from the top down, so the head's section runs the same way round as the
      // jambs' — backband OUTERMOST, bead next to the glass. Swept upward from the head
      // line it comes out mirrored, with the heavy backband sitting right on the glass
      // and the bead at the top, which is the wrong way up for an architrave. (The same
      // inversion is what stopped the door's mitre corners reading as continuous.)
      mouldH(lo - hOut, hi + hOut, headY + caseW, casingShape, CASE_P, true);
      // STOOL: a bullnosed sill board, mitred back to the wall at each horn.
      mouldH(lo - hOut, hi + hOut, sy, stoolShape, STOOL_D, false);
      // APRON: a length of the CASING stock run horizontally under the stool, inverted,
      // and returned onto itself at both ends — which is what an apron is. It was the
      // last flat board in the composition.
      // Length: flush with the STOOL above it, so the two members die at the same plan
      // position and their returns stack into one clean corner. Millwork practice is
      // actually to stop the apron at the casing's outer edge and let the stool horn
      // run 3/4 in proud of it — that is the detail this replaces, by request; the
      // stepped corner it produces is correct but reads as a mistake here.
      // Where the wall below is open floor rather than a counter the apron hangs 25 in
      // up with nothing under it and reads as a stray panel, so `plainBelow` drops it
      // and the field and battens simply carry on to the stool.
      if (!plainBelow) mouldH(lo - hOut, hi + hOut, sy, apronShape, APRON_P, true);
    }
    // 5) door casing: the same moulded section as the windows, run as a MITRED
    //    ARCHITRAVE round the opening — head and jambs meeting at 45 deg at the top
    //    corners, no horns. It was a flat board with the head overhanging each jamb by
    //    a casing width, which is a window detail (it caps a stool) borrowed where it
    //    does not belong.
    for (const [a, b] of doors) {
      if (bare.some(([ba, bb]) => Math.abs(ba - a) < 0.01 && Math.abs(bb - b) < 0.01)) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      // Where a TRANSOM spans this door, its bar is already the head member across the
      // whole composition — a door with sidelights needs one continuous head, not a
      // short casing over the leaf and a longer bar in the same plane fighting it. The
      // jambs still run, they just stop at the head line with nothing mitred onto them.
      const spanned = trans.some(([ta, tb]) =>
        Math.min(ta, tb) <= lo + 0.01 && Math.max(ta, tb) >= hi - 0.01);
      if (spanned) {
        mouldV(lo, 0, headY, casingShape, +1); mouldV(hi, 0, headY, casingShape, -1);
      } else {
        mouldFrame(lo, hi, casingShape);
      }
    }
  }
}
