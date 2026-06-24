// Soft / curved furniture rendered as procedural three.js meshes (the IFC
// box/cylinder primitives can't do rounded cushions, curved backs, tapered
// splayed legs). Lightweight — built from geometry, no model files. Placement
// comes from furniture.json (emitted by the generator), which carries the
// plan->world mapping so a plan point lands in the same spot as the BIM model.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const PALETTE = {
  oatmeal: 0xd9d2c4, linen: 0xcfc6b4, upholstery: 0x5a6b80,
  lightoak: 0xb38f63, oak: 0xa9824f, walnut: 0x6b4a2f, darkwalnut: 0x3a2a1c,
  rug: 0x9c6b5a, sage: 0x8a9a86, slate: 0x4a5568, cabinet: 0xeae7df,
};
const col = (name, fallback) => new THREE.Color(PALETTE[name] ?? fallback);
const fabricMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 });
const woodMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 });

// An upholstered dining chair (front = +Z): tapered splayed legs into an apron,
// a soft seat cushion, and a raked upholstered back anchored to the seat.
function buildChair(p) {
  const fab = fabricMat(col(p.material, 0xd9d2c4));
  const oak = woodMat(col(p.legMaterial || "lightoak", 0xb38f63));
  const g = new THREE.Group();
  const seatTop = 0.47, sw = 0.47, sd = 0.45;
  const apron = new THREE.Mesh(new THREE.BoxGeometry(sw - 0.06, 0.07, sd - 0.06), oak);
  apron.position.set(0, seatTop - 0.10, 0); g.add(apron);
  const legGeo = new THREE.CylinderGeometry(0.026, 0.016, 0.40, 4); // tapers to the floor
  for (const ix of [-1, 1]) for (const iz of [-1, 1]) {
    const pivot = new THREE.Group();                 // pivot at the seat corner; foot splays out
    pivot.position.set(ix * (sw / 2 - 0.06), seatTop - 0.07, iz * (sd / 2 - 0.06));
    const leg = new THREE.Mesh(legGeo, oak);
    leg.position.y = -0.18; leg.rotation.y = Math.PI / 4;
    pivot.add(leg);
    pivot.rotation.z = -ix * 0.10; pivot.rotation.x = iz * 0.10;
    g.add(pivot);
  }
  const seat = new THREE.Mesh(new RoundedBoxGeometry(sw, 0.12, sd, 3, 0.04), fab);
  seat.position.set(0, seatTop - 0.05, 0); g.add(seat);
  const back = new THREE.Mesh(new RoundedBoxGeometry(sw, 0.42, 0.11, 4, 0.05), fab);
  back.position.set(0, seatTop + 0.21, -(sd / 2 - 0.07));
  back.rotation.x = -0.13;                            // rake
  g.add(back);
  return g;
}

// A round pedestal table: smooth round top + tapered column + flared foot.
function buildTable(p) {
  const wood = woodMat(col(p.material || "darkwalnut", 0x3a2a1c));
  const dia = (p.diameter ?? 5) * 0.3048;            // ft -> m
  const h = (p.h ?? 2.5) * 0.3048;
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2, dia / 2, 0.05, 48), wood);
  top.position.y = h - 0.025; g.add(top);
  const col0 = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.10, h - 0.1, 24), wood);
  col0.position.y = (h - 0.1) / 2 + 0.05; g.add(col0);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(dia * 0.22, dia * 0.24, 0.06, 32), wood);
  foot.position.y = 0.03; g.add(foot);
  return g;
}

// A flat rectangular area rug (w x d in feet). Returned as a Group so its
// y-offset survives when buildFurniture positions the group on the floor.
function buildRug(p) {
  const ft = 0.3048;
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: col(p.material || "rug", 0x9c6b5a), roughness: 1.0 });
  const m = new THREE.Mesh(new THREE.BoxGeometry((p.w ?? 8) * ft, 0.012, (p.d ?? 6) * ft), mat);
  m.position.y = 0.03; // sit on top of the instanced wood planks (which rise ~0.04 above the slab)
  g.add(m);
  return g;
}

// A built-in butler's-pantry hutch (front = +Z): a face-framed carcass with a
// base bank of drawers + a raised-panel door + a heating register, a counter,
// and three glass-front upper doors with interior shelves. Authored in real
// feet (p.w width, p.d depth, p.h height); sits flush with the door casings.
function buildBuiltinHutch(p) {
  const ft = 0.3048;
  const W = (p.w ?? 6.59) * ft, D = (p.d ?? 1.5) * ft, H = (p.h ?? 7) * ft;
  const paint = new THREE.MeshStandardMaterial({ color: col(p.material || "cabinet", 0xeae7df), roughness: 0.55 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xc6d7da, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.25, depthWrite: false });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.6 });
  const grille = new THREE.MeshStandardMaterial({ color: 0x2f2f2f, roughness: 0.6, metalness: 0.3 });
  const g = new THREE.Group();
  const zF = D / 2;                                   // front face plane (local +Z)
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const knob = (x, y, z = zF) => add(new THREE.SphereGeometry(0.012, 10, 8), brass, x, y, z + 0.006);

  // dimensions: the counter height and the upper-cabinet height are the fixed
  // drivers; the open void above the counter is whatever's left between them.
  // The carcass is 16" deep (the niche depth); it sits flush with the casings
  // and its back is hidden by the kitchen bump-out.
  const counterTop = (32 / 12) * ft;                // counter 32" above the floor (fixed)
  const counterY = counterTop - 0.06, baseBot = 0.10;
  const dep = (16 / 12) * ft;                        // 16" carcass / niche depth
  const zB = zF - dep, zM = zF - dep / 2;            // back plane / depth midpoint
  const upTop = H;                                   // uppers reach the headline (room cornice seats above)
  const upBot = upTop - (32 / 12) * ft;              // 32"-tall uppers (fixed); the open void is the ~20" remainder
  const dark = new THREE.MeshStandardMaterial({ color: 0xcfccc3, roughness: 0.7 });

  // carcass: full-height side gables frame the niche; back panel, bottom, top, toe kick
  add(box(W, H, 0.018), paint, 0, H / 2, zB + 0.009);                          // back panel
  for (const sx of [-1, 1]) add(box(0.02, H, dep), paint, sx * (W / 2 - 0.01), H / 2, zM); // gables
  add(box(W, 0.02, dep), paint, 0, 0.01, zM);                                  // bottom
  add(box(W, 0.02, dep), paint, 0, H - 0.01, zM);                              // top
  add(box(W - 0.04, 0.10, 0.04), dark, 0, 0.05, zF - 0.07);                    // recessed toe kick
  // 16"-deep white countertop with a 1" front overhang
  add(box(W, 0.045, dep + 0.025), paint, 0, counterTop - 0.0225, zM + 0.0125);
  // the open void above the counter: a recessed beadboard backsplash at the back
  // of the niche (set 16" back from the face) so the space reads as an empty void
  { const niH = upBot - counterTop, niW = W - 0.06, niY = (counterTop + upBot) / 2;
    add(box(niW, niH, 0.01), paint, 0, niY, zB + 0.02);
    const groove = new THREE.MeshStandardMaterial({ color: 0xbdb9b0, roughness: 0.9 });
    const n = Math.max(5, Math.round(niW / 0.09));
    for (let i = 1; i < n; i++) add(box(0.004, niH, 0.006), groove, -niW / 2 + i * (niW / n), niY, zB + 0.027); }

  // base: symmetric drawer banks flanking a single door over the register
  const IW = W - 0.05, st = 0.03, avail = IW - 2 * st;
  const cw = [0.37 * avail, 0.26 * avail, 0.37 * avail];          // left bank / center / right bank
  const cx = [-IW / 2 + cw[0] / 2, 0, IW / 2 - cw[2] / 2];
  const drawerStack = (colx, colw, n) => {
    const dh = (counterY - baseBot) / n;
    for (let i = 0; i < n; i++) {
      const cy = baseBot + dh * (i + 0.5);
      add(box(colw - 0.015, dh - 0.012, 0.02), paint, colx, cy, zF - 0.01);
      knob(colx, cy);
    }
  };
  drawerStack(cx[0], cw[0], 4);   // left bank: 4 drawers
  drawerStack(cx[2], cw[2], 4);   // right bank: 4 drawers (symmetric)
  // center: a single raised-panel cabinet door over the heating register
  { const regH = 0.26, doorH = (counterY - baseBot) - regH;
    const regY = baseBot + regH / 2;                                   // register at the bottom
    add(box(cw[1] - 0.04, regH - 0.04, 0.012), grille, cx[1], regY, zF - 0.006);
    for (let i = 0; i < 5; i++) add(box(cw[1] - 0.06, 0.006, 0.014), paint, cx[1], regY - regH / 2 + 0.04 + i * ((regH - 0.08) / 4), zF - 0.004);
    const doorY = baseBot + regH + doorH / 2;
    add(box(cw[1] - 0.015, doorH - 0.012, 0.02), paint, cx[1], doorY, zF - 0.01);
    add(box(cw[1] - 0.10, doorH - 0.10, 0.012), paint, cx[1], doorY, zF + 0.004); // raised panel
    knob(cx[1] - cw[1] / 2 + 0.05, doorY); }

  // uppers: three flush glass doors (frame + glass + muntins) with shelves
  const uAvail = IW - 4 * st, udw = uAvail / 3, fh = upTop - upBot, fy = (upBot + upTop) / 2;
  for (let i = 0; i < 3; i++) {
    const ux = -IW / 2 + st + udw * (i + 0.5) + st * i;
    add(box(udw, 0.04, 0.022), paint, ux, upBot + 0.02, zF - 0.011);   // bottom rail
    add(box(udw, 0.04, 0.022), paint, ux, upTop - 0.02, zF - 0.011);   // top rail
    add(box(0.035, fh, 0.022), paint, ux - udw / 2 + 0.018, fy, zF - 0.011); // stiles
    add(box(0.035, fh, 0.022), paint, ux + udw / 2 - 0.018, fy, zF - 0.011);
    add(box(udw - 0.06, fh - 0.06, 0.006), glass, ux, fy, zF - 0.012);  // glass pane
    add(box(0.012, fh - 0.06, 0.008), paint, ux, fy, zF - 0.012);       // vertical muntin
    for (const my of [fy - fh / 6, fy + fh / 6]) add(box(udw - 0.06, 0.012, 0.008), paint, ux, my, zF - 0.012);
    add(box(udw - 0.05, 0.015, dep - 0.04), paint, ux, (upBot + upTop) / 2, zM); // single shelf
    knob(ux + udw / 2 - 0.05, fy);
  }

  // (no cabinet crown: the uppers meet the headline and the room cornice seats on top)
  return g;
}

// A large flanking entry lantern, hung from a wall bracket beside the front
// door (front of house = -Z). Local origin sits at the bracket's wall mount;
// the gooseneck arm scrolls out over the terrace and the lantern hangs below.
// Dark-bronze frame, warm translucent glass, a glowing bulb, peaked cap +
// finials. Authored in metres ("large": ~10" wide x 14" tall body).
function buildPorchPendant(p) {
  const g = new THREE.Group();
  const bronze = new THREE.MeshStandardMaterial({ color: 0x2e2a22, roughness: 0.45, metalness: 0.75 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xfff1c2, roughness: 0.15, transparent: true, opacity: 0.32, emissive: 0xffce82, emissiveIntensity: 0.45, depthWrite: false });
  const bulb = new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffdd99, emissiveIntensity: 1.8, roughness: 1 });
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (rx) m.rotation.x = rx; g.add(m); return m; };

  const reach = 0.36, hz = -0.04 - reach;          // arm projection; lantern z (out front)
  // wall mount: backplate + top boss
  add(new THREE.BoxGeometry(0.11, 0.22, 0.04), bronze, 0, -0.02, -0.02);
  add(new THREE.SphereGeometry(0.032, 12, 10), bronze, 0, 0.07, -0.03);
  // gooseneck arm reaching out over the terrace, then a short drop to the lantern
  add(new THREE.CylinderGeometry(0.018, 0.018, reach, 12), bronze, 0, 0.07, -0.04 - reach / 2, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.016, 0.016, 0.12, 10), bronze, 0, 0.01, hz);

  // lantern body centred below the arm end
  const cy = -0.42, W = 0.26, H = 0.36;
  add(new THREE.BoxGeometry(W, H, W), glass, 0, cy, hz);              // glazed cage
  for (const sx of [-1, 1]) for (const sz of [-1, 1])               // corner posts
    add(new THREE.BoxGeometry(0.02, H + 0.02, 0.02), bronze, sx * W / 2, cy, hz + sz * W / 2);
  for (const yy of [cy + H / 2, cy - H / 2])                         // top + bottom rails
    add(new THREE.BoxGeometry(W + 0.03, 0.035, W + 0.03), bronze, 0, yy, hz);
  const cap = add(new THREE.ConeGeometry(W * 0.82, 0.15, 4), bronze, 0, cy + H / 2 + 0.075, hz);
  cap.rotation.y = Math.PI / 4;                                      // square peaked roof
  add(new THREE.SphereGeometry(0.024, 12, 10), bronze, 0, cy + H / 2 + 0.17, hz);  // top finial
  add(new THREE.ConeGeometry(0.032, 0.07, 10), bronze, 0, cy - H / 2 - 0.05, hz, Math.PI); // bottom finial
  add(new THREE.SphereGeometry(0.055, 14, 12), bulb, 0, cy, hz);     // warm bulb
  return g;
}

// A switchback (half-turn) staircase filling the south half of the foyer: a
// lower flight against one side rises to a full-width landing at the back wall,
// then an upper flight on the opposite side rises to the second floor. Open
// treads (wood) over painted risers + skirt stringers, with a continuous wood
// handrail on the inner (well) side of each flight — newel posts + balusters.
// Authored in plan FEET relative to the south-half centre; the world flip in
// buildFurniture keeps it aligned with the BIM walls (so rot must stay 0).
function buildStaircase(p) {
  const ft = 0.3048;
  const W = p.w ?? 11.17, D = p.d ?? 11.59;            // south-half footprint (plan feet)
  const f2f = p.floorToFloor ?? 10, n1 = p.run1Steps ?? 6, n2 = p.run2Steps ?? 9;
  const riser = f2f / (n1 + n2);                        // equal risers across both flights
  const landD = p.landingDepth ?? 4, rw = p.runWidth ?? 4.5, m = p.margin ?? 0.6;
  const railH = p.railHeight ?? 2.92;                   // handrail height above the nosings
  const eastFirst = (p.firstRunSide ?? "east") === "east";

  const hw = W / 2, hd = D / 2;
  const eastClear = hw - m, westClear = -(hw - m);
  const southClear = -hd + m, northEdge = hd;           // N edge = the soft divider (no wall)
  const landingN = southClear + landD;                  // landing's north edge
  let tread = Math.min(p.treadDepth ?? 0.92, ((northEdge - landingN) / (n2 - 1)) * 0.99);
  const going1 = (n1 - 1) * tread, going2 = (n2 - 1) * tread;
  const footNO1 = landingN + going1;                    // lower-flight foot (floor), N of landing
  const landingH = n1 * riser;
  const run1Eo = eastFirst ? eastClear - rw / 2 : westClear + rw / 2;
  const run2Eo = eastFirst ? westClear + rw / 2 : eastClear - rw / 2;
  const wEo1 = run1Eo - Math.sign(run1Eo) * rw / 2;     // inner (well) edge of each flight
  const wEo2 = run2Eo - Math.sign(run2Eo) * rw / 2;

  const g = new THREE.Group();
  const woodT = woodMat(col(p.material || "oak", 0xa9824f));
  const woodR = woodMat(col(p.railMaterial || "walnut", 0x6b4a2f));
  const white = new THREE.MeshStandardMaterial({ color: col("cabinet", 0xeae7df), roughness: 0.6 });
  // plan (eastOffset, northOffset, height) feet -> group-local metres (world flip)
  const V = (eo, no, y) => new THREE.Vector3(-eo * ft, y * ft, -no * ft);
  const boxAt = (eo, no, yc, wx, hy, dz, mat) => {
    const me = new THREE.Mesh(new THREE.BoxGeometry(wx * ft, hy * ft, dz * ft), mat);
    me.position.copy(V(eo, no, yc)); g.add(me); return me;
  };
  const bar = (a, b, t, mat, round = true) => {           // a member spanning a->b
    const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
    const geo = round ? new THREE.CylinderGeometry(t / 2 * ft, t / 2 * ft, len, 10)
                      : new THREE.BoxGeometry(t * ft, len, t * ft);
    const me = new THREE.Mesh(geo, mat);
    me.position.copy(a).addScaledVector(dir, 0.5);
    me.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.add(me); return me;
  };
  const slab = (a, b, wN, th, mat) => {                  // a flat board along a->b (skirt)
    const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
    const me = new THREE.Mesh(new THREE.BoxGeometry(th * ft, len, wN * ft), mat);
    me.position.copy(a).addScaledVector(dir, 0.5);
    me.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.add(me); return me;
  };

  // landing: a solid full-width block at the back wall, with a wood top
  const clearW = eastClear - westClear, landMidNO = (southClear + landingN) / 2;
  boxAt(0, landMidNO, landingH / 2, clearW, landingH, landD, white);
  boxAt(0, landMidNO, landingH - 0.06, clearW, 0.12, landD, woodT);

  // one flight: painted risers + wood tread caps + two skirt stringers
  function flight(eoC, footNO, dir, nR, baseH, going) {
    for (let i = 1; i <= nR; i++) {
      const frontNO = footNO + dir * (i - 1) * tread;        // riser face of step i
      boxAt(eoC, frontNO + dir * 0.03, baseH + (i - 0.5) * riser, rw, riser, 0.06, white);
      if (i < nR) {                                          // tread cap (last level is landing/floor)
        const noC = footNO + dir * (i - 0.5) * tread;
        boxAt(eoC, noC - dir * 0.04, baseH + i * riser - 0.06, rw, 0.12, tread + 0.08, woodT);
      }
    }
    for (const s of [-1, 1]) {                               // skirt stringers, both sides
      const sx = eoC + s * rw / 2;
      slab(V(sx, footNO, baseH + 0.2), V(sx, footNO + dir * going, baseH + nR * riser + 0.2), 0.85, 0.1, white);
    }
  }
  flight(run1Eo, footNO1, -1, n1, 0, going1);                // lower flight -> landing
  flight(run2Eo, landingN, +1, n2, landingH, going2);        // upper flight -> second floor

  // handrail on the inner (well) side of each flight: rail + newels + balusters
  function rail(wEo, footNO, dir, nR, baseH, going, balK) {
    const A = V(wEo, footNO, baseH + riser + railH);
    const B = V(wEo, footNO + dir * going, baseH + nR * riser + railH);
    bar(A, B, 0.17, woodR);                                  // sloped handrail
    for (let k = 1; k <= balK; k++) {                        // balusters at each tread
      const no = footNO + dir * (k - 0.5) * tread, y0 = baseH + k * riser;
      bar(V(wEo, no, y0), V(wEo, no, y0 + railH), 0.05, white);
    }
    return { A, B };
  }
  // newel posts (square): foot of lower flight, both landing posts, top of upper flight
  bar(V(wEo1, footNO1, 0), V(wEo1, footNO1, riser + railH), 0.22, woodR, false);
  bar(V(wEo1, landingN, 0), V(wEo1, landingN, landingH + railH), 0.22, woodR, false);
  bar(V(wEo2, landingN, 0), V(wEo2, landingN, landingH + riser + railH), 0.22, woodR, false);
  bar(V(wEo2, landingN + going2, f2f), V(wEo2, landingN + going2, f2f + railH), 0.22, woodR, false);
  const r1 = rail(wEo1, footNO1, -1, n1, 0, going1, n1 - 1);
  const r2 = rail(wEo2, landingN, +1, n2, landingH, going2, n2 - 1);
  bar(r1.B, r2.A, 0.17, woodR);                              // landing rail across the well
  return g;
}

const BUILDERS = { upholstered_dining_chair: buildChair, highback_chair: buildChair, round_pedestal_table: buildTable, rug: buildRug, builtin_hutch: buildBuiltinHutch, porch_pendant: buildPorchPendant, staircase: buildStaircase };
const CHAIRS = new Set(["upholstered_dining_chair", "highback_chair"]);
const SEAT_FRONT = 0.225;   // chair seat front is +0.225 m toward the table from its centre
const TUCK = 0.08;          // pushed-in: seat front this far under the table edge
const SIT = 0.22;           // pulled-out: this gap between seat front and table edge

export async function buildFurniture({ scene, parent = scene, floorY, baseUrl, manifestFile = "furniture.json" }) {
  let data;
  try { data = await (await fetch(`${baseUrl}${manifestFile}`)).json(); } catch (e) { return { chairMeshes: [] }; }
  const { ft = 0.3048, xs = -1, zs = 1, items = [] } = data || {};
  // plan (feet) -> three.js world: x = xs*px*ft, z = -(zs*pz*ft) (web-ifc maps IFC +Y -> -Z)
  const world = (px, pz) => [xs * px * ft, -(zs * pz * ft)];

  // Flat/static pieces first (rugs) so the table + chairs sit on top of them.
  for (const it of items) {
    if (it.type === "round_pedestal_table" || CHAIRS.has(it.type) || !BUILDERS[it.type]) continue;
    const [x, z] = world(it.px, it.pz);
    const obj = BUILDERS[it.type](it);
    obj.position.set(x, it.y != null ? it.y : floorY, z);   // per-item height (e.g. a hung pendant)
    if (it.rot) obj.rotation.y = (it.rot * Math.PI) / 180;  // e.g. a built-in facing into the room
    parent.add(obj);
  }

  // Tables, so chairs can be positioned relative to their nearest table.
  const tables = [];
  for (const it of items) {
    if (it.type !== "round_pedestal_table") continue;
    const [x, z] = world(it.px, it.pz);
    const obj = buildTable(it); obj.position.set(x, floorY, z); scene.add(obj);
    tables.push({ x, z, radius: (it.diameter ?? 5) * ft / 2 });
  }

  const chairs = [];        // { root, inPos, outPos, current, out, toggle }
  const chairMeshes = [];   // leaf meshes for raycast picking (userData.chair -> entry)
  const tmp = new THREE.Vector3();
  for (const it of items) {
    if (!CHAIRS.has(it.type)) continue;
    const root = BUILDERS[it.type](it);
    const [cx, cz] = world(it.px, it.pz);
    // nearest table; slide the chair radially between tucked-in and pulled-out
    let near = null, best = Infinity;
    for (const t of tables) { const d = (t.x - cx) ** 2 + (t.z - cz) ** 2; if (d < best) { best = d; near = t; } }
    let inPos, outPos;
    if (near) {
      let dx = cx - near.x, dz = cz - near.z;     // outward radial direction
      const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
      const dIn = near.radius - TUCK + SEAT_FRONT, dOut = near.radius + SIT + SEAT_FRONT;
      inPos = new THREE.Vector3(near.x + dx * dIn, floorY, near.z + dz * dIn);
      outPos = new THREE.Vector3(near.x + dx * dOut, floorY, near.z + dz * dOut);
      root.rotation.y = Math.atan2(-dx, -dz);      // chair front (+Z) faces the table
    } else {
      inPos = new THREE.Vector3(cx, floorY, cz); outPos = inPos.clone();
    }
    root.position.copy(inPos);                     // default: pushed in
    scene.add(root);
    const entry = { root, inPos, outPos, current: inPos.clone(), out: false };
    entry.toggle = () => { entry.out = !entry.out; };
    chairs.push(entry);
    root.traverse((m) => { if (m.isMesh) { m.userData.chair = entry; chairMeshes.push(m); } });
  }

  // Slide chairs between tucked-in and pulled-out (eased), like the doors.
  (function animate() {
    for (const c of chairs) {
      const target = c.out ? c.outPos : c.inPos;
      if (c.current.distanceToSquared(target) > 1e-6) {
        c.current.lerp(target, 0.2);
        c.root.position.copy(c.current);
      }
    }
    requestAnimationFrame(animate);
  })();

  return { chairMeshes };
}
