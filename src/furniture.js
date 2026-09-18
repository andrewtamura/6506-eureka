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
  leather: 0x8a6244, cane: 0xc9a870, beech: 0x6f4a2c,
  ticking: 0x3c5a78, chalk: 0xf8f5ef, flax: 0xd8cdb4,
};
const col = (name, fallback) => new THREE.Color(PALETTE[name] ?? fallback);
const fabricMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 });
const woodMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 });

// --- plan-axis orientation helpers (shared by the bed + bath fixtures) ---------
// Compass -> plan-delta unit vector. Plan px increases WEST, pz increases NORTH
// (East = low px). A fixture is built around its anchor with a FRONT direction A
// and a width direction P (perpendicular); fplace() converts an offset along A
// (`da`, front +) and along width (`ds`) plus sizes (`dl` along A, `dw` along
// width) into a plan-delta centre (opx,opz) and an axis-aligned footprint
// (sx = E-W, sz = N-S) — so a box built from it stays square to the walls.
const DIR = { N: [0, 1], S: [0, -1], E: [-1, 0], W: [1, 0] };
const OPP = { N: "S", S: "N", E: "W", W: "E" };
// Deterministic pseudo-random in [0,1) from one number — the same one-liner the floor
// builders use, so a tile's shade is stable across reloads rather than sparkling.
const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5; return x - Math.floor(x); };

function fplace(A, P, da, ds, dl, dw) {
  return [A[0] * da + P[0] * ds, A[1] * da + P[1] * ds,
          Math.abs(A[0]) * dl + Math.abs(P[0]) * dw,
          Math.abs(A[1]) * dl + Math.abs(P[1]) * dw];
}

// TICKING STRIPE, drawn rather than loaded — a wide bar and a hairline on a cream
// ground, which is the classic pair. One canvas is shared; callers clone it so each
// surface can set its own repeat and keep the stripe pitch physically constant
// whatever the panel size.
let _ticking = null;
function tickingTexture(ground, ink) {
  if (_ticking) return _ticking;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 4;
  const x = c.getContext("2d");
  const hex = (n) => "#" + n.toString(16).padStart(6, "0");
  x.fillStyle = hex(ground); x.fillRect(0, 0, 64, 4);
  x.fillStyle = hex(ink);
  x.fillRect(10, 0, 11, 4);                      // the wide bar
  x.fillRect(28, 0, 3, 4);                       // the hairline beside it
  _ticking = new THREE.CanvasTexture(c);
  _ticking.wrapS = _ticking.wrapT = THREE.RepeatWrapping;
  if (THREE.SRGBColorSpace) _ticking.colorSpace = THREE.SRGBColorSpace;
  return _ticking;
}

// A CAPE COD DINING CHAIR (front = +Z): a painted frame in real chair scantlings with a
// slip seat and an upholstered back, both in ticking stripe. Traditional joinery — the
// rear legs run on up to become the back stiles — but deliberately plain: square tapered
// legs, no turning, no carving, and a back that stops at 35" rather than towering.
//
// Sized off actual side-chair stock rather than by eye, because the first pass looked
// like it would come apart when sat on: 40 mm legs tapering to 28 mm at the floor
// (1 9/16" to 1 1/8"), 70 x 24 mm seat rails (2 3/4" x 7/8"), 38 mm stiles. It also
// carries the two things that actually stop a chair racking and that were missing
// entirely — glue blocks in the seat corners, and an H-stretcher between the legs.
function buildChair(p) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: col(p.frame || "chalk", 0xf8f5ef), roughness: 0.6 });
  const groundC = col(p.material || "oatmeal", 0xd9d2c4).getHex();
  const inkC = col(p.stripe || "ticking", 0x3c5a78).getHex();
  // Stripes run front-to-back on the seat and vertically up the back: on a box face the
  // texture's u maps to the horizontal axis in both cases, so one orientation does both.
  const fabric = (wMetres) => {
    const t = tickingTexture(groundC, inkC).clone();
    t.needsUpdate = true;
    t.repeat.set(Math.max(1, Math.round(wMetres / 0.135)), 1);   // ~135 mm per stripe pair
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
  };
  const box = (w, h, d, x, y, z, mat = paint, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); if (ry) m.rotation.y = ry;
    m.castShadow = true; g.add(m); return m;
  };

  const SH = 0.46, SW = 0.49, SD = 0.44;          // seat height / width / depth
  const BH = 0.90;                                 // top of the back, 35" off the floor
  const LEG = 0.040, LEGB = 0.028;                 // leg section at the seat / at the floor
  const RAIL = 0.070, RT = 0.024;                  // seat rail depth / thickness
  const PAD = 0.055;                               // slip seat, sitting on the rails
  const TOP = SH - 0.045;                          // top of the frame; the pad laps over it
  const INSET = LEG / 2 + 0.004;
  const XL = SW / 2 - INSET, ZL = SD / 2 - INSET;  // leg centres

  // Legs: square section tapering to the floor. A 4-sided cylinder turned 45 deg is a
  // true square prism; straight rather than splayed, since the splay is what dates it.
  const R = LEG / Math.SQRT2, RB = LEGB / Math.SQRT2;
  for (const ix of [-1, 1]) for (const iz of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(R, RB, TOP, 4), paint);
    m.rotation.y = Math.PI / 4; m.position.set(ix * XL, TOP / 2, iz * ZL);
    m.castShadow = true; g.add(m);
  }
  // Seat rails, deep enough to carry a seat: their whole point is bending stiffness.
  const ry = TOP - RAIL / 2;
  box(SW - 2 * INSET, RAIL, RT, 0, ry, ZL);
  box(SW - 2 * INSET, RAIL, RT, 0, ry, -ZL);
  for (const ix of [-1, 1]) box(RT, RAIL, SD - 2 * INSET, ix * XL, ry, 0);
  // Glue blocks across each seat corner — the joint that stops a chair racking.
  for (const ix of [-1, 1]) for (const iz of [-1, 1])
    box(0.085, RAIL - 0.018, 0.020, ix * (XL - 0.031), ry - 0.006, iz * (ZL - 0.031),
        paint, ix * iz > 0 ? -Math.PI / 4 : Math.PI / 4);
  // H-stretcher: side rails leg-to-leg with a medial rail between them.
  const SY = 0.165, ST = 0.026, SS = 0.020;
  for (const ix of [-1, 1]) box(SS, ST, SD - 2 * INSET, ix * XL, SY, 0);
  box(SW - 2 * INSET, ST, SS, 0, SY, 0);

  // Slip seat, lapping over the rails.
  const pad = new THREE.Mesh(new RoundedBoxGeometry(SW - 2 * INSET + 0.016, PAD, SD - 2 * INSET + 0.016, 2, 0.012),
                             fabric(SW));
  pad.position.set(0, SH - PAD / 2, 0); pad.castShadow = true; g.add(pad);

  // BACK, raked back 13.5 deg for about 4.5 in of set-back at the crest. Two notes,
  // both learned the hard way:
  //   - An earlier version used rotation.x = +0.105. A positive rotation about X tips
  //     the top toward +Z, which here is the FRONT — it was leaning very slightly INTO
  //     the table, which is exactly why it read as bolt upright.
  //   - A curved sweep was tried, with the panel in three stacked slabs following it.
  //     The slab seams caught the light and turned the ticking stripe into a plaid, so
  //     the back is one flat plane: a single panel, no joints to show.
  const back = new THREE.Group();
  back.position.set(0, TOP, -ZL);
  back.rotation.x = -0.235;
  const bh = BH - TOP;                             // stile length above the seat
  const TOPR = 0.080, BOTR = 0.050;
  const SR = 0.038 / Math.SQRT2;                   // stiles continue the rear legs
  for (const ix of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(SR * 0.82, SR, bh, 4), paint);
    m.rotation.y = Math.PI / 4; m.position.set(ix * XL, bh / 2, 0);
    m.castShadow = true; back.add(m);
  }
  const inner = SW - 2 * INSET - 0.038;
  const crossRail = (h, yc) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(inner, h, RT), paint);
    m.position.set(0, yc, 0); m.castShadow = true; back.add(m);
  };
  crossRail(TOPR, bh - TOPR / 2);                  // crest rail
  crossRail(BOTR, 0.055);                          // bottom rail, just above the seat
  const ph = bh - TOPR - 0.055 - BOTR / 2 - 0.01;
  const panel = new THREE.Mesh(new RoundedBoxGeometry(inner - 0.004, ph, 0.045, 2, 0.01), fabric(inner));
  panel.position.set(0, 0.055 + BOTR / 2 + ph / 2 + 0.005, 0.006);
  panel.castShadow = true; back.add(panel);
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
// A rug, optionally BOUND: a pile field with a contrasting border run round it. The border
// is opt-in (`borderFt`), so a plain rug stays one box and the dining room's is untouched.
//
// The binding sits a hair PROUDER than the field rather than flush. Flush, the two are
// coplanar and the border reads as paint on the pile; 4 mm is enough to catch a shadow line
// and have it read as a bound edge, which is what it is.
function buildRug(p) {
  const ft = 0.3048;
  const g = new THREE.Group();
  const T = 0.012;
  // Both planes ride this lift. The instanced wood planks stand ~0.04 above the slab, so a
  // rug laid at y = 0 disappears into the floor rather than onto it.
  const Y = 0.03;
  const W = (p.w ?? 8) * ft, D = (p.d ?? 6) * ft;
  const mat = new THREE.MeshStandardMaterial({ color: col(p.material || "rug", 0x9c6b5a), roughness: 1.0 });
  const slab = (w, d, y, m, x = 0, z = 0) => {
    const q = new THREE.Mesh(new THREE.BoxGeometry(w, y - Y + T, d), m);
    q.position.set(x, (Y + y) / 2, z); q.receiveShadow = true; g.add(q); return q;
  };
  const B = (p.borderFt ?? 0) * ft;
  if (B <= 0.004) { slab(W, D, Y, mat); return g; }
  const bm = new THREE.MeshStandardMaterial({ color: col(p.border || "rug", 0x9c6b5a), roughness: 1.0 });
  const YB = Y + 0.004;                              // the binding, proud of the pile
  slab(W - 2 * B, D - 2 * B, Y, mat);                // field, inset all round
  for (const sz of [-1, 1]) {                        // the two long sides
    slab(W, B, YB, bm, 0, sz * (D - B) / 2);
    slab(B, D - 2 * B, YB, bm, sz * (W - B) / 2, 0); // ...and the two ends, between them
  }
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
  // Faint baked glow only: the actual "lit" state (bright bulb + real light) is
  // driven by the exterior lighting scene (see addLandscapeLighting), so the
  // lanterns read as OFF by day and switch on at night.
  const glass = new THREE.MeshStandardMaterial({ color: 0xfff1c2, roughness: 0.15, transparent: true, opacity: 0.32, emissive: 0xffce82, emissiveIntensity: 0.1, depthWrite: false });
  const bulb = new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffdd99, emissiveIntensity: 0.22, roughness: 1 });
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

// Shared switchback-stair layout (plan FEET, offsets from the south-half centre).
// Both the ground-floor staircase and the second-floor stairwell derive every
// dimension from this, so the two stay in lockstep.
const FT = 0.3048;
function stairLayout(p) {
  const W = p.w ?? 11.17, D = p.d ?? 11.59;
  const f2f = p.floorToFloor ?? 10, n1 = p.run1Steps ?? 6, n2 = p.run2Steps ?? 9;
  const riser = f2f / (n1 + n2);
  const landD = p.landingDepth ?? 4, rw1 = p.runWidth ?? 4, rw2 = p.run2Width ?? rw1, m = p.margin ?? 0.6;
  const railH = p.railHeight ?? 2.92;
  const eastFirst = (p.firstRunSide ?? "east") === "east";
  const hw = W / 2, hd = D / 2;
  const eastClear = hw - m, westClear = -(hw - m);
  const southClear = -hd + m, northEdge = hd;
  const landingN = southClear + landD;
  const tread = Math.min(p.treadDepth ?? 0.92, ((northEdge - landingN) / (n2 - 1)) * 0.99);
  const going1 = (n1 - 1) * tread, going2 = (n2 - 1) * tread;
  const footNO1 = landingN + going1, landingH = n1 * riser;
  const run1Eo = eastFirst ? eastClear - rw1 / 2 : westClear + rw1 / 2;
  const run2Eo = eastFirst ? westClear + rw2 / 2 : eastClear - rw2 / 2;
  return {
    f2f, n1, n2, riser, landD, rw1, rw2, railH, hw, hd, eastClear, westClear, southClear,
    landingN, tread, going1, going2, footNO1, landingH, run1Eo, run2Eo,
    wEo1: run1Eo - Math.sign(run1Eo) * rw1 / 2, wEo2: run2Eo - Math.sign(run2Eo) * rw2 / 2,
  };
}

// Drawing helpers bound to a group, in plan (eastOffset, northOffset, height)
// feet -> group-local metres (the world flip keeps it aligned with the BIM).
function stairKit(g, mats) {
  const ft = FT;
  const V = (eo, no, y) => new THREE.Vector3(-eo * ft, y * ft, -no * ft);
  const boxAt = (eo, no, yc, wx, hy, dz, mat) => {
    const me = new THREE.Mesh(new THREE.BoxGeometry(wx * ft, hy * ft, dz * ft), mat);
    me.position.copy(V(eo, no, yc)); g.add(me); return me;
  };
  const bar = (a, b, t, mat, round = true) => {
    const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
    const geo = round ? new THREE.CylinderGeometry(t / 2 * ft, t / 2 * ft, len, 10)
                      : new THREE.BoxGeometry(t * ft, len, t * ft);
    const me = new THREE.Mesh(geo, mat);
    me.position.copy(a).addScaledVector(dir, 0.5);
    me.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.add(me); return me;
  };
  const slab = (a, b, wN, th, mat) => {
    const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
    const me = new THREE.Mesh(new THREE.BoxGeometry(th * ft, len, wN * ft), mat);
    me.position.copy(a).addScaledVector(dir, 0.5);
    me.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.add(me); return me;
  };
  const prismPanel = (pts, off, mat) => {              // closed thin prism (drywall panels)
    const A = pts.map(p => V(p[0], p[1], p[2]));
    const B = pts.map(p => V(p[0] + off[0], p[1] + off[1], p[2] + off[2]));
    const n = pts.length, pos = [];
    const tri = (p, q, r) => pos.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]); }
    for (let i = 1; i < n - 1; i++) { tri(A[0], A[i], A[i + 1]); tri(B[0], B[i + 1], B[i]); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const me = new THREE.Mesh(geo, mat); g.add(me); return me;
  };
  // one flight: painted risers + wood tread caps + two skirt stringers
  const flight = (L, eoC, footNO, dir, nR, baseH, rw) => {
    const { tread, riser } = L, going = (nR - 1) * tread;
    for (let i = 1; i <= nR; i++) {
      const frontNO = footNO + dir * (i - 1) * tread;
      boxAt(eoC, frontNO + dir * 0.03, baseH + (i - 0.5) * riser, rw, riser, 0.06, mats.white);
      if (i < nR) {
        const noC = footNO + dir * (i - 0.5) * tread;
        boxAt(eoC, noC - dir * 0.04, baseH + i * riser - 0.06, rw, 0.12, tread + 0.08, mats.woodT);
      }
    }
    for (const s of [-1, 1])
      slab(V(eoC + s * rw / 2, footNO, baseH + 0.2),
           V(eoC + s * rw / 2, footNO + dir * going, baseH + nR * riser + 0.2), 0.85, 0.1, mats.white);
  };
  // a traditional turned baluster (LatheGeometry silhouette) of height h (ft),
  // standing at (eo,no) on base y0. Thicker + shaped (vase/urn), not a stick.
  const BAL = [[0.58, 0], [0.58, 0.05], [0.30, 0.10], [0.50, 0.17], [0.95, 0.30],
               [0.55, 0.40], [0.26, 0.49], [0.26, 0.60], [0.42, 0.67], [0.30, 0.75],
               [0.52, 0.87], [0.42, 0.95], [0.58, 1.0]];
  const baluster = (eo, no, y0, h, mat) => {
    const r = 0.085 * ft, H = h * ft;
    const pts = BAL.map(([rr, hh]) => new THREE.Vector2(Math.max(0.002, rr * r), hh * H));
    const me = new THREE.Mesh(new THREE.LatheGeometry(pts, 14), mat);
    me.position.copy(V(eo, no, y0)); g.add(me); return me;
  };
  // a turned newel: square shaft (baseY -> topY) + a moulded cap + a ball finial.
  const newel = (eo, no, topY, mat, baseY = 0) => {
    const w = 0.3;
    boxAt(eo, no, (baseY + topY) / 2, w, topY - baseY, w, mat);          // shaft
    boxAt(eo, no, topY + 0.05, w + 0.14, 0.10, w + 0.14, mat);           // overhanging cap
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.13 * ft, 14, 12), mat);
    ball.position.copy(V(eo, no, topY + 0.20)); g.add(ball);             // ball finial
  };
  // a flight's well-side handrail (sloped rail + turned balusters)
  const rail = (L, wEo, footNO, dir, nR, baseH, balK) => {
    const { tread, riser, railH } = L, going = (nR - 1) * tread;
    const A = V(wEo, footNO, baseH + riser + railH);
    const B = V(wEo, footNO + dir * going, baseH + nR * riser + railH);
    bar(A, B, 0.19, mats.woodR);
    for (let k = 1; k <= balK; k++) {
      const no = footNO + dir * (k - 0.5) * tread, y0 = baseH + k * riser;
      baluster(wEo, no, y0, railH, mats.white);
    }
    return { A, B };
  };
  // a level guardrail run (top rail + newel posts + turned balusters)
  const guard = (L, ea, na, eb, nb) => {
    const len = Math.hypot(eb - ea, nb - na);
    bar(V(ea, na, L.railH), V(eb, nb, L.railH), 0.19, mats.woodR);
    newel(ea, na, L.railH, mats.woodR); newel(eb, nb, L.railH, mats.woodR);
    const nb2 = Math.max(2, Math.round(len / 0.45));
    for (let i = 1; i < nb2; i++) { const f = i / nb2; baluster(ea + (eb - ea) * f, na + (nb - na) * f, 0, L.railH, mats.white); }
  };
  return { g, V, boxAt, bar, slab, prismPanel, flight, rail, guard, newel, baluster };
}

function stairMats(p) {
  return {
    woodT: woodMat(col(p.material || "oak", 0xa9824f)),
    woodR: woodMat(col(p.railMaterial || "walnut", 0x6b4a2f)),
    white: new THREE.MeshStandardMaterial({ color: col("cabinet", 0xeae7df), roughness: 0.6 }),
    dry: new THREE.MeshStandardMaterial({ color: 0xeae7e0, roughness: 0.95, side: THREE.DoubleSide }),
  };
}

// A complete switchback (lower flight -> full-width landing -> upper flight one
// floor up), with handrails and the space under the upper run boxed in drywall.
// Built from the bottom of the flight at local y=0.
function addFullStair(K, L, mats, endWall = true, wellWall = true, underDoor = null) {
  const { landingN, southClear, eastClear, westClear, landD, landingH, f2f, footNO1,
          n1, n2, going2, riser, tread, railH, run1Eo, run2Eo, wEo1, wEo2, hw, rw1, rw2 } = L;
  const clearW = eastClear - westClear, landMidNO = (southClear + landingN) / 2;
  K.boxAt(0, landMidNO, landingH / 2, clearW, landingH, landD, mats.white);   // landing block
  K.boxAt(0, landMidNO, landingH - 0.06, clearW, 0.12, landD, mats.woodT);    // landing top
  K.flight(L, run1Eo, footNO1, -1, n1, 0, rw1);
  K.flight(L, run2Eo, landingN, +1, n2, landingH, rw2);
  K.newel(wEo1, footNO1, riser + railH, mats.woodR);             // foot of lower flight
  K.newel(wEo1, landingN, landingH + railH, mats.woodR);         // landing (lower)
  K.newel(wEo2, landingN, landingH + riser + railH, mats.woodR); // landing (upper)
  K.newel(wEo2, landingN + going2, f2f + railH, mats.woodR, f2f); // top of upper flight
  const r1 = K.rail(L, wEo1, footNO1, -1, n1, 0, n1 - 1);
  const r2 = K.rail(L, wEo2, landingN, +1, n2, landingH, n2 - 1);
  K.bar(r1.B, r2.A, 0.19, mats.woodR);                           // landing rail across the well
  // drywall under the upper run: a well-side wall (sloped soffit) + an end wall
  // closing the north face, so the under-stair is fully boxed in (the ground-floor
  // under-stair closet). Both are dropped where the stairwell interior must stay
  // open: wellWall=false leaves no interior wall under the run, endWall=false keeps
  // the top open where the flight reaches the floor above.
  const topNO = landingN + going2, t = 0.17, wallEdge = Math.sign(run2Eo) * hw;
  if (wellWall)
    K.prismPanel([[wEo2, landingN, 0], [wEo2, topNO, 0], [wEo2, topNO, f2f], [wEo2, landingN, landingH]],
                 [Math.sign(run2Eo) * t, 0, 0], mats.dry);        // well-side wall (sloped soffit)
  // A DRYWALL SOFFIT under the flight, so the boxed-in space has a CEILING instead of
  // the underside of the steps. One flat sheet, as it is built: drywall goes on furring
  // under the carriage and reads as a single raking plane, not as a stepped profile.
  //
  // Where that plane can sit is fixed by two DIFFERENT things, and which one binds
  // changes along the length — that is the whole difficulty:
  //   the STEP CORNERS, on riser/tread (the inside corner of every step), and
  //   the STRINGER's lower edge, on the flight's CHORD, which is steeper because the
  //     run is (n-1) treads while the rise is n risers (the top riser meets the floor
  //     above and carries no tread).
  // The stringer hangs lower at the landing end, the steps hang lower at the top, and
  // the two cross in between. A plane parallel to either one cuts through the other.
  // The lower envelope of two straight lines is CONCAVE, so the chord joining its two
  // END values lies at or below it everywhere between — which is what this uses, and
  // why no clearance sweep along the length is needed to be sure the steps are hidden.
  if (endWall && wellWall) {
    const mStep = riser / tread;                       // through the step corners
    const mChord = (n2 * riser) / going2;              // the stringer's own slope
    // The stringer is a 0.85 ft plank centred on the nosing line + 0.2; its lower edge
    // is half that width PERPENDICULAR to the line, which is (w/2)*hypot(1,m) in y.
    const strDrop = 0.2 - (0.85 / 2) * Math.hypot(1, mChord);
    const env = (u) => Math.min(landingH + u * mStep, landingH + strDrop + u * mChord);
    const CLEAR = 0.04;                                // the drywall hangs just clear
    const y0 = env(0) - CLEAR, y1 = env(going2) - CLEAR;
    const soffit = K.prismPanel(
      [[wEo2, landingN, y0], [wallEdge, landingN, y0], [wallEdge, topNO, y1], [wEo2, topNO, y1]],
      [0, 0, -0.05], mats.dry);                        // ~1/2 in board, measured vertically
    soffit.userData.soffit = true;                     // kitchen-check raycasts against this
  }
  if (endWall && !underDoor)
    K.prismPanel([[wEo2, topNO, 0], [wallEdge, topNO, 0], [wallEdge, topNO, f2f], [wEo2, topNO, f2f]],
                 [0, -t, 0], mats.dry);                           // end wall (encloses the under-stair)
  // ...or the same wall with a DOOR in it, into the powder room under the flight.
  // The HOLE is cut here because this builder owns the wall; the CASING, baseboard
  // break and field break around it belong to the trim program, driven by the same
  // span declared as a `doors` entry on the room's matching `extraWalls` record. The
  // two are authored separately and `ifc_check` asserts they agree — nothing else
  // would notice them drifting apart.
  else if (endWall) {
    const { eoLo, eoHi, headFt: dh } = underDoor;
    const lo = Math.min(wEo2, wallEdge), hi = Math.max(wEo2, wallEdge);
    const a = Math.max(lo, Math.min(eoLo, eoHi)), b = Math.min(hi, Math.max(eoLo, eoHi));
    // Two jambs and a head, each a closed prism like the wall they replace. The
    // REVEAL needs no geometry of its own: prismPanel closes its sides, so the faces
    // at eo = a, eo = b and y = dh are already the lining of the opening.
    const panel = (e0, e1, y0, y1) => {
      if (e1 - e0 < 0.01 || y1 - y0 < 0.01) return;
      K.prismPanel([[e0, topNO, y0], [e1, topNO, y0], [e1, topNO, y1], [e0, topNO, y1]],
                   [0, -t, 0], mats.dry);
    };
    panel(lo, a, 0, f2f);      // jamb, one side
    panel(b, hi, 0, f2f);      // jamb, the other
    panel(a, b, dh, f2f);      // head over the opening
    // THE LEAF, swinging OUT into the foyer. The room is 3 ft 2 in x 6 ft 9 in: a
    // 2 ft 6 in leaf swinging IN sweeps a quarter-disc of radius 2 ft 6 in off the
    // hinge, which is most of the end of the room and everything a basin could
    // occupy. An outswing is what a powder room this size actually gets. A plain
    // slab, like every other interior door here (main.js `leafParts`, no style).
    const lw = (b - a) - 0.03, lh = dh - 0.03, slabT = 0.05;
    const hingeE = underDoor.hingeHi ? b : a;
    const sgn = underDoor.hingeHi ? -1 : 1;          // the slab sits this way from the hinge
    const leaf = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(lw * FT, lh * FT, slabT * FT), mats.white);
    // K.V maps (eo, no, y) -> local metres and eo runs along -X, so an offset of +lw/2
    // in eo is -lw/2 in local x. The leaf's frame hangs off the hinge; rotating the
    // group about Y swings it.
    mesh.position.set(-sgn * (lw / 2) * FT, (lh / 2) * FT, 0);
    mesh.castShadow = true;
    leaf.add(mesh);
    // On the FOYER face, not on the wall centreline: an outswing leaf closes against
    // that face. It still passes inside the casing, which projects further (0.030 m).
    leaf.position.copy(K.V(hingeE, topNO + slabT / 2, 0));
    K.g.add(leaf);
    // A +Y rotation carries local +X toward world -Z, i.e. NORTH, into the foyer. The
    // slab lies along -sgn in local x, so the outswing sense flips with the hinge side.
    const swing = underDoor.swing ?? -sgn * 1.4;
    leaf.rotation.y = swing;                         // doors default OPEN
    const entry = { pivot: leaf, openAngle: swing, current: swing, open: true };
    mesh.userData.fdoor = entry;
    (K.g.userData.doors || (K.g.userData.doors = [])).push(entry);
  }
}

// Ground-floor switchback staircase up to the second floor.
function buildStaircase(p) {
  const L = stairLayout(p), g = new THREE.Group(), mats = stairMats(p), K = stairKit(g, mats);
  // `underDoor` is authored in PLAN feet like everything else in the house; the stair
  // draws in east-offsets from its own centre, so it is converted once, here.
  let ud = null;
  if (p.underDoor) {
    const d = p.underDoor, half = (d.widthFt ?? 2.5) / 2;
    ud = { eoLo: d.posFt - half - p.px, eoHi: d.posFt + half - p.px,
           headFt: d.headFt ?? 7.0, hingeHi: !!d.hingeHi, swing: d.swing };
  }
  addFullStair(K, L, mats, true, true, ud);
  return g;
}

// Second-floor stair hall. Shows: (1) the matching switchback rising to the ATTIC
// (identical to the foyer stair, stacked above), (2) the lower stair's upper run
// descending through the floor void to its landing below, and (3) the enclosing
// walls — the foyer's east + west walls extended up plus an end wall with a door
// in front of the first run (the south side is the exterior wall). Same layout as
// the ground stair, so everything stays synchronized.
function buildStairwell2(p) {
  const L = stairLayout(p), g = new THREE.Group(), mats = stairMats(p), K = stairKit(g, mats);
  const { landingN, southClear, eastClear, westClear, landD, landingH, f2f,
          n2, going2, riser, railH, run1Eo, run2Eo, wEo2, hw, hd, rw2 } = L;

  if (p.up !== false) addFullStair(K, L, mats, false, false);    // (1) up to the next level — stairwell interior left open (no under-stair walls)

  // (2) the lower run arriving at this level, descending to its landing below
  const dy = -f2f, clearW = eastClear - westClear, landMidNO = (southClear + landingN) / 2;
  K.boxAt(0, landMidNO, landingH + dy - 0.06, clearW, 0.12, landD, mats.woodT);
  K.flight(L, run2Eo, landingN, +1, n2, landingH + dy, rw2);
  K.rail(L, wEo2, landingN, +1, n2, landingH + dy, n2 - 1);
  K.newel(wEo2, landingN + going2, railH, mats.woodR);           // newel where the run reaches this floor (y=0)

  // (2b) GUARD RAIL around the whole floor opening so you can't step off the edge
  // into the void — a level run on each side at floor level. The north edge is left
  // OPEN over the descending run's top width so you can still walk onto the stairs.
  if (p.opening) {
    const o = p.opening;
    const eW = o.x1 - p.px, eE = o.x2 - p.px;   // opening edges in local east-offset
    const nS = o.z1 - p.pz, nN = o.z2 - p.pz;   // ...and north-offset
    const gLo = Math.min(run2Eo - rw2 / 2, run2Eo + rw2 / 2);   // stair-access gap = run width
    const gHi = Math.max(run2Eo - rw2 / 2, run2Eo + rw2 / 2);
    K.guard(L, eW, nS, eE, nS);                 // south edge (full)
    K.guard(L, eW, nS, eW, nN);                 // west edge (full)
    K.guard(L, eE, nS, eE, nN);                 // east edge (full)
    K.guard(L, eW, nN, gLo, nN);                // north edge, west of the stair access
    K.guard(L, gHi, nN, eE, nN);                // north edge, east of the stair access
  }

  // (3) enclose the hall: E + W foyer walls up, and an N wall split around a 3'
  // door in front of the first run. wallTop limits the height (lower in the attic,
  // where the door is dropped since there is no flight continuing up).
  const wt = 0.46;
  if (p.roof) {
    // Attic top: the stair hall stays OPEN — the E/W flanking walls are dropped so
    // the south dormer and stairwell read into the open attic room (the perimeter
    // knee wall + sloped ceiling enclose overhead; the floor opening is guarded
    // by the perimeter rail above). Leg 4 tops out here and spills onto the attic.
    return g;
  }
  // Second-floor hall: the foyer's E + W walls extend up. The north side stays
  // OPEN — Leg 2 tops out there and connects to the open second floor (so the
  // flight that reaches a floor is never walled off); the south is the exterior wall.
  const wallTop = p.wallTop ?? f2f;
  K.boxAt(-hw, 0, wallTop / 2, wt, wallTop, 2 * hd, mats.dry);    // east wall (x1)
  K.boxAt(+hw, 0, wallTop / 2, wt, wallTop, 2 * hd, mats.dry);    // west wall (x2)
  return g;
}

// A full attic bathroom tucked in the NW corner. The west + north sides are the
// existing knee walls + roof slope (the building envelope), so only the EAST and
// SOUTH partitions (facing the open attic) are built here — floor to the sloped
// ceiling, with a door for privacy. A walk-in shower sits under the low west
// slope; the toilet + vanity stand in the full-headroom zone. All plan feet.
function buildBathroom(p) {
  const ft = FT, g = new THREE.Group();
  const x1 = p.x1, x2 = p.x2, z1 = p.z1, z2 = p.z2;   // footprint (plan): x2=west, x1=east; z2=north, z1=south
  const px = (x1 + x2) / 2, pz = (z1 + z2) / 2;        // group origin (placed at world(px,pz))
  const V = (eo, no, y) => new THREE.Vector3(-eo * ft, y * ft, -no * ft);
  const F = p.roof.footprint, eaveFt = p.roof.eaveFt || 0, pit = p.roof.pitch ?? 0.5;
  // ceiling height: the hip slope from each eave, CAPPED flat at flatCeilFt (8.5 ft)
  // so the bathroom reads as a real room with a flat ceiling and sloped sides.
  const flatCeil = p.flatCeilFt || Infinity;
  const rz = (plx, plz) => Math.min(flatCeil,
    Math.max(0.4, eaveFt + pit * Math.min(plx - F.x1, F.x2 - plx, plz - F.z1, F.z2 - plz)));
  const wall = new THREE.MeshStandardMaterial({ color: 0xece9e1, roughness: 0.95, side: THREE.DoubleSide });
  const tile = new THREE.MeshStandardMaterial({ color: 0xd7dadc, roughness: 0.4 });
  const porc = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.25 }); // porcelain
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const woodv = woodMat(col(p.vanity || "walnut", 0x6b4a2f));
  const glass = new THREE.MeshStandardMaterial({ color: 0xafc4cc, roughness: 0.05, transparent: true, opacity: 0.28 });
  glass.depthWrite = false;
  const t = 0.54;                                       // 2x6 wall: 5.5" stud + 1/2" drywall each side ≈ 6.5"
  const doors = [];                                     // hinged leaves: double-tap to open/close

  // box centred at ABSOLUTE plan (plx,plz), height-centre yc; sizes ex(E-W) x hy(height) x nz(N-S) ft
  const box = (plx, plz, yc, ex, hy, nz, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(ex * ft, hy * ft, nz * ft), mat);
    m.position.copy(V(plx - px, plz - pz, yc)); g.add(m); return m;
  };
  const cyl = (plx, plz, yc, r, h, mat, seg = 20) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, h * ft, seg), mat);
    m.position.copy(V(plx - px, plz - pz, yc)); g.add(m); return m;
  };
  // thin closed prism through plan-coord points (wall panels with a sloped top)
  const prismPanel = (pts, off, mat) => {
    const A = pts.map(([x, z, y]) => V(x - px, z - pz, y));
    const B = pts.map(([x, z, y]) => V(x - px + off[0], z - pz + off[1], y + off[2]));
    const n = pts.length, pos = [];
    const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]); }
    for (let i = 1; i < n - 1; i++) { tri(A[0], A[i], A[i + 1]); tri(B[0], B[i + 1], B[i]); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const me = new THREE.Mesh(geo, mat); me.castShadow = true; g.add(me);
  };
  const M = 12;
  // a wall along plan z at x=fx, from za to zb, floor -> sloped ceiling
  const zWall = (fx, za, zb) => {
    const pts = [[fx, za, 0], [fx, zb, 0]];
    for (let i = 0; i <= M; i++) { const z = zb + (za - zb) * i / M; pts.push([fx, z, rz(fx, z)]); }
    prismPanel(pts, [t, 0, 0], wall);
  };
  // a wall along plan x at z=fz, from xa to xb, floor -> sloped ceiling
  const xWall = (fz, xa, xb) => {
    const pts = [[xa, fz, 0], [xb, fz, 0]];
    for (let i = 0; i <= M; i++) { const x = xb + (xa - xb) * i / M; pts.push([x, fz, rz(x, fz)]); }
    prismPanel(pts, [0, t, 0], wall);
  };

  // A complete door = jamb walls flanking the opening + a head panel + a hinged
  // slab that fills the opening (double-tap toggles). `axis` is the wall's run:
  // "z" (wall along plan z at x=line) or "x" (wall along plan x at z=line). The
  // opening is [oa, ob]; the wall fills [wa, wb] around it. `hinge` is "a" (at oa)
  // or "b" (at ob); `swing` is the open angle. The head is capped just under the
  // sloped ceiling at the opening so it never pokes through, and the leaf is sized
  // off the opening + head — so opening and slab always stay consistent.
  const DOOR_TH = 0.06, LEAF_CLEAR = 0.02, HEAD_REVEAL = 0.02;  // hairline reveals so a closed door reads flush
  const framedDoor = ({ axis, line, oa, ob, wa, wb, head = 6.85, hinge = "a", swing = 1.2, open = true, leafMat }) => {
    const ceil = axis === "z" ? Math.min(rz(line, oa), rz(line, ob)) : Math.min(rz(oa, line), rz(ob, line));
    const hd = Math.min(head, ceil - 0.1);                       // head stays under the ceiling
    const lw = (ob - oa) - LEAF_CLEAR, lh = hd - HEAD_REVEAL;    // leaf fills the opening, sits under the head
    const hx = hinge === "a" ? oa : ob, sgn = hinge === "a" ? -1 : 1;
    const leaf = new THREE.Group();
    if (axis === "z") {
      zWall(line, wa, oa); zWall(line, ob, wb);
      prismPanel([[line, oa, hd], [line, ob, hd], [line, ob, rz(line, ob)], [line, oa, rz(line, oa)]], [t, 0, 0], wall);
      const panel = new THREE.Mesh(new RoundedBoxGeometry(DOOR_TH, lh * ft, lw * ft, 2, 0.02), leafMat || woodMat(0x8a6a45));
      panel.position.set(0, (lh / 2) * ft, sgn * (lw / 2) * ft);
      leaf.add(panel); leaf.position.copy(V(line - px, hx - pz, 0));
    } else {
      xWall(line, wa, oa); xWall(line, ob, wb);
      prismPanel([[oa, line, hd], [ob, line, hd], [ob, line, rz(ob, line)], [oa, line, rz(oa, line)]], [0, t, 0], wall);
      const panel = new THREE.Mesh(new RoundedBoxGeometry(lw * ft, lh * ft, DOOR_TH, 2, 0.02), leafMat || woodMat(0x8a6a45));
      panel.position.set(sgn * (lw / 2) * ft, (lh / 2) * ft, 0);
      leaf.add(panel); leaf.position.copy(V(hx - px, line - pz, 0));
    }
    leaf.rotation.y = open ? swing : 0;
    g.add(leaf);
    const door = { pivot: leaf, openAngle: swing, current: open ? swing : 0, open };
    leaf.children[0].userData.fdoor = door; doors.push(door);
    return door;
  };

  // --- TWO-RECTANGLE bathroom: a WC in the NW corner + the main bathroom (shower +
  // vanity) to its south, each a clean rectangle. The perimeter 7 ft room walls are in
  // the IFC; here we add the internal partitions + fixtures.
  const usableFt = p.usableFt != null ? p.usableFt : 7.0;
  const du = Math.max(0, (usableFt - eaveFt) / pit);
  const kneeInset = p.kneeFt != null ? Math.max(0, (p.kneeFt - eaveFt) / pit) : 3.75;
  const wWall = F.x2 - kneeInset;                 // 3 ft knee/wet wall (vanity + W dormer above)
  const xW7 = F.x2 - du;                          // west 7 ft wall
  const zN7 = F.z2 - du, zS7 = F.z1 + du;         // north / south 7 ft walls
  const wcS = pz + 1.75;                          // WC south wall = W-dormer alcove N edge = bathroom N wall
  const wcEast = (p.nDormerWestFt != null) ? p.nDormerWestFt : (xW7 - 6.1);  // WC east wall = N-dormer alcove W edge

  // BATHROOM rectangle (shower + vanity): SW corner = where the two 7 ft walls meet;
  // opposite corner = (staircase W cheek = x1, WC-door wall = wcS). The EAST wall (x1)
  // is solid (the vanity + mirror + shower tile back onto it); the ENTRANCE is on the
  // NORTH wall (wcS): the entrance sits just off the NE corner (a short wall pier
  // between the corner and the opening), hinged on the corner-side (east) jamb and
  // swinging INTO the bathroom; short wall piers flank it on both sides up to the WC.
  zWall(x1, zS7, wcS);                             // EAST wall (solid)
  framedDoor({ axis: "x", line: wcS, oa: x1 + 0.9, ob: x1 + 3.567, wa: x1, wb: wcEast, hinge: "a", swing: 1.2 });  // entrance: off the corner, hinged on the corner-side jamb, opens INTO the bathroom (2'8")

  // WC rectangle (NW corner): WEST wall = xW7 (IFC; toilet hangs there), NORTH = zN7
  // (IFC), EAST = wcEast (new), SOUTH = wcS with the WC door. Its W + N edges sit under
  // the roof slopes, so the WC ceiling dips toward the eaves there.
  zWall(wcEast, wcS, zN7);                          // WC east partition
  framedDoor({ axis: "x", line: wcS, oa: wcEast + 0.9, ob: wcEast + 3.4, wa: wcEast, wb: xW7, hinge: "a", swing: -1.1 });  // WC door (2'6"), swings IN (north)

  // --- shower running the FULL east-west width along the south wall, full standing
  // headroom. Tiled on the W + S + E sides (E = the entry partition); the open N
  // side is glass: a hinged DOOR at the east end (by the entry) + a fixed panel.
  const shW = xW7, shE = x1;                           // FULL width, E-W
  const shS = zS7, shN = zS7 + 3.5;                    // 3.5 ft deep, S side on the 7 ft wall
  const shcz = (shS + shN) / 2, shd = shN - shS;
  box((shE + shW) / 2, shcz, 0.12, shW - shE, 0.24, shd, tile);              // pan/curb
  prismPanel([[shW, shS, 0], [shW, shN, 0], [shW, shN, rz(shW, shN)], [shW, shS, rz(shW, shS)]], [-0.1, 0, 0], tile); // west tiled wall
  prismPanel([[shE, shN, 0], [shE, shS, 0], [shE, shS, rz(shE, shS)], [shE, shN, rz(shE, shN)]], [0.1, 0, 0], tile);  // east tiled wall (entry partition)
  prismPanel([[shE, shS, 0], [shW, shS, 0], [shW, shS, rz(shW, shS)], [shE, shS, rz(shE, shS)]], [0, -0.1, 0], tile); // south tiled wall
  cyl(shE + 0.8, shS + 0.4, 5.5, 0.06, 0.5, chrome);                         // shower-head arm (off the S wall, E end)
  box(shE + 0.8, shS + 0.4, 5.8, 0.5, 0.12, 0.12, chrome);                   // shower head
  // OPEN walk-in at the WEST end (no door) + a fixed glass screen over the east of
  // the N side. (The old glass door sat behind the bathroom door at the east; this
  // clears it and leaves a doorless opening.)
  const shOpen = 3.0, shScreenW = (shW - shOpen) - shE;                      // walk-in opening (west) + screen (east)
  {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(shScreenW * ft, 6.6 * ft, 0.04 * ft), glass);
    pane.position.copy(V(((shE + (shW - shOpen)) / 2) - px, shN - pz, 3.3)); g.add(pane);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08 * ft, 6.6 * ft, 0.08 * ft), chrome);  // jamb post at the opening edge
    post.position.copy(V((shW - shOpen) - px, shN - pz, 3.3)); g.add(post);
  }

  // --- single vanity against the EAST wall (x1), backing onto it and facing west.
  // Sits N of the shower and S of the entrance, fully under the flat 8.5 ft ceiling.
  // Depth (E-W, 1.9 ft) projects west from x1; length (N-S, vd) runs along z.
  const vcx = x1 + 0.95, vcz = -0.75, vd = 3.5;                              // cabinet centre (E of x1) / length N-S
  box(vcx, vcz, 1.45, 1.9, 2.9, vd, woodv);                                  // vanity cabinet (1.9 deep E-W)
  box(vcx, vcz, 2.95, 2.1, 0.18, vd + 0.2, porc);                            // stone countertop
  cyl(vcx, vcz, 3.0, 0.5, 0.18, porc, 24);                                   // single basin
  cyl(vcx - 0.6, vcz, 3.15, 0.05, 0.6, chrome);                              // faucet (back, near the east wall)
  // mirror on the EAST wall, centred above the vanity
  box(x1 + 0.06, vcz, 4.2, 0.08, 2.2, 2.5, glass);

  // --- WALL-MOUNTED (wall-hung) toilet. The parts are shared with the `wall_toilet`
  // manifest builder (`wallToiletParts`); this room places them positionally.
  const bowlInt = new THREE.MeshStandardMaterial({ color: 0xcdd2d2, roughness: 0.2, side: THREE.DoubleSide });
  const plateM = new THREE.MeshStandardMaterial({ color: 0xedeef0, roughness: 0.4 });
  // (plx,plz) = bowl-centre plan position; rotY rotates the local +X = front about Y.
  const makeToilet = (plx, plz, rotY = 0) => {
    const grp = wallToiletParts({ porc, chrome, bowlInt, plateM });
    grp.rotation.y = rotY;
    grp.position.copy(V(plx - px, plz - pz, 0));
    g.add(grp);
  };
  // wall-hung on the WEST wall (the far-west 7 ft wall xW7), facing EAST into the WC
  // (rotY=0 -> back/plate on the west wall, bowl projects east into the room).
  makeToilet(xW7 - 0.7, (wcS + zN7) / 2, 0);

  g.userData.doors = doors;
  return g;
}

// A cute window-seat bench: a wood base + seat board, a seat cushion and a back
// bolster against the knee wall. The group origin sits at the knee-wall line
// (placed there by the manifest) and the bench extends south into the room.
function buildWindowBench(p) {
  const ft = FT, g = new THREE.Group();
  const w = (p.widthFt || 3.5) - 0.3;        // a touch narrower than the dormer
  const d = 1.5;                             // seat depth
  const sh = 1.5;                            // seat height (~18")
  const woodm = woodMat(col(p.wood || "walnut", 0x8a6a45));
  const cmat = new THREE.MeshStandardMaterial({ color: col(p.cushion || "linen", 0xd8dcd2), roughness: 0.95 });
  const base = new THREE.Mesh(new RoundedBoxGeometry(w * ft, (sh - 0.2) * ft, (d - 0.12) * ft, 2, 0.03), woodm);
  base.position.set(0, (sh - 0.2) / 2 * ft, (d / 2) * ft); g.add(base);          // base/apron
  const seat = new THREE.Mesh(new RoundedBoxGeometry((w + 0.12) * ft, 0.16 * ft, (d + 0.06) * ft, 2, 0.04), woodm);
  seat.position.set(0, (sh - 0.08) * ft, (d / 2) * ft); g.add(seat);             // seat board
  const cush = new THREE.Mesh(new RoundedBoxGeometry((w - 0.06) * ft, 0.18 * ft, (d - 0.18) * ft, 4, 0.09), cmat);
  cush.position.set(0, (sh + 0.06) * ft, (d / 2 + 0.02) * ft); g.add(cush);      // seat cushion
  const bol = new THREE.Mesh(new RoundedBoxGeometry((w - 0.06) * ft, 0.55 * ft, 0.4 * ft, 4, 0.14), cmat);
  bol.position.set(0, (sh + 0.34) * ft, 0.24 * ft); g.add(bol);                  // back bolster at the wall
  return g;
}

// A straight interior partition wall for laying out a level's rooms. The item's
// (px,pz) is the wall CENTRE (plan feet); `axis` is the run direction ("x" = E-W,
// "z" = N-S); `lenFt` its length. Floor-to-ceiling by default.
// Optional `door: { atFt, widthFt, headFt }` cuts an opening (with jambs + a head)
// and fills it with a wood door slab — atFt is the door CENTRE in plan coords
// along the run axis (a pz for an "z" wall, a px for an "x" wall).
function buildPartition(p) {
  const ft = FT, g = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xece9e1, roughness: 0.95, side: THREE.DoubleSide });
  const leafMat = woodMat(0x8a6a45);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbcd2d8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.32 });
  glassMat.depthWrite = false;
  const axis = p.axis, t = (p.thickFt ?? 0.4583) * ft, H = p.heightFt ?? 9.0;
  const len = p.lenFt || 1;
  const c0 = axis === "x" ? p.px : p.pz;               // wall centre along the run axis (plan ft)
  const a0 = c0 - len / 2, b0 = c0 + len / 2;          // wall extent along the axis (plan ft)
  // A RAKED TOP: `topFt` is [[s, ft], [s, ft]] at two points along the run (plan ft), the
  // same shape as a paneling record's `ceil` — a partition under the wing's shed ceiling
  // dies into a plane that falls 1:12, and a level box either pokes through it or leaves
  // a wedge of daylight. Linear between the two; `heightFt` still serves a level wall.
  const topFt = Array.isArray(p.topFt) && p.topFt.length === 2 ? p.topFt : null;
  const topAt = (s) => {
    if (!topFt) return H;
    const [[s0, h0], [s1, h1]] = topFt;
    const u = Math.abs(s1 - s0) < 1e-9 ? 0 : (s - s0) / (s1 - s0);
    return h0 + (h1 - h0) * u;
  };
  // one box for the run [s..e] (plan ft), between heights [y0..y1] ft. A piece whose top
  // is the wall top (y1 === H) under a raked `topFt` is a trapezoid instead: a Shape in
  // (along, height) extruded the wall's thickness. Shape x is the LOCAL run coordinate,
  // (c0 - plan)*ft, so for an "x" wall it is local x directly and for a "z" wall the
  // mesh is turned a quarter so shape x lands on local z.
  const seg = (s, e, y0, y1) => {
    if (e - s < 1e-4) return;
    if (!(topFt && y1 === H)) {
      if (y1 - y0 < 1e-4) return;
      const L = (e - s) * ft, off = (c0 - (s + e) / 2) * ft;   // local axis pos = (centre - plan)*ft
      const box = new THREE.Mesh(new THREE.BoxGeometry(axis === "x" ? L : t, (y1 - y0) * ft, axis === "x" ? t : L), wallMat);
      box.position.set(axis === "x" ? off : 0, (y0 + y1) / 2 * ft, axis === "x" ? 0 : off);
      box.castShadow = true; box.receiveShadow = true; g.add(box);
      return;
    }
    const t0 = Math.max(y0, topAt(s)), t1 = Math.max(y0, topAt(e));
    if (Math.max(t0, t1) - y0 < 1e-4) return;
    const us = (c0 - s) * ft, ue = (c0 - e) * ft;              // local run coords of the two ends
    const sh = new THREE.Shape();
    sh.moveTo(ue, y0 * ft); sh.lineTo(us, y0 * ft); sh.lineTo(us, t0 * ft); sh.lineTo(ue, t1 * ft); sh.closePath();
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false }), wallMat);
    if (axis === "x") mesh.position.set(0, 0, -t / 2);                       // extrude runs +z: centre it on the wall
    else { mesh.rotation.y = -Math.PI / 2; mesh.position.set(t / 2, 0, 0); } // shape x -> local z; extrude -> -x
    mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh);
  };
  // openings: p.doors (array) or a single p.door. Each has atFt (opening centre, plan
  // ft along the run), widthFt, headFt. The leaf can be specified two ways:
  //   (a) PLAIN ENGLISH (preferred): `hinge` = which END the hinge is on — a north-south
  //       (axis "z") wall uses "N"/"S"; an east-west (axis "x") wall uses "E"/"W". `opens`
  //       = which SIDE the leaf swings into — a "z" wall opens "E"/"W", an "x" wall opens
  //       "N"/"S". `openDeg` = open angle in degrees (default 80). All hinge/swing geometry
  //       (incl. the tricky rotation sign) is derived here, so callers never touch it.
  //   (b) LOW-LEVEL (legacy): `hinge` = "a"/"b" (low/high jamb) + `swing` = signed radians.
  //   `opening: true` cuts a cased opening (jambs + head) with NO door slab.
  // For a "z" wall oa=south/ob=north; for an "x" wall oa=east/ob=west (plan px grows west).
  const HI = axis === "z" ? "N" : "W";   // the ob (higher-coord) jamb is at this compass end
  // swing angle (signed) for a leaf hinged at jamb `hingeSide` ("a" low / "b" high)
  // opening toward compass side `opens`.
  const swingFor = (hingeSide, opens, openDeg) => {
    const sgn = hingeSide === "b" ? 1 : -1;
    const sign = axis === "z" ? (opens === "W" ? -sgn : sgn) : (opens === "N" ? sgn : -sgn);
    return sign * (openDeg ?? 80) * Math.PI / 180;
  };
  const list = (p.doors || (p.door ? [p.door] : [])).flatMap((d) => {
    const w = d.widthFt ?? 2.667, head = d.headFt ?? 6.85;
    // FRENCH/double: two half-width leaves hinged on the two jambs, meeting at the
    // centre and both swinging the same way (out); each a divided-light glass leaf.
    if (d.french) {
      const c = d.atFt, li = d.lites ?? 8, deg = d.openDeg ?? 80;
      return [
        { oa: c - w / 2, ob: c, w: w / 2, head, hinge: "a", glass: true, lites: li, swing: swingFor("a", d.opens, deg) },
        { oa: c, ob: c + w / 2, w: w / 2, head, hinge: "b", glass: true, lites: li, swing: swingFor("b", d.opens, deg) },
      ];
    }
    const o = { at: d.atFt, oa: d.atFt - w / 2, ob: d.atFt + w / 2, w, head, opening: !!d.opening, glass: !!d.glass, lites: d.lites, sliding: !!d.sliding };
    if (/^[NSEW]$/.test(d.hinge || "")) {                       // (a) plain-English form
      o.hinge = d.hinge === HI ? "b" : "a";                     // which jamb the hinge sits on
      o.swing = swingFor(o.hinge, d.opens, d.openDeg);
    } else {                                                    // (b) legacy form
      o.hinge = d.hinge || "a";
      o.swing = d.swing != null ? d.swing : 1.4;
    }
    // A POCKET DOOR (`sliding: true`) has no swing: `hinge` names the jamb the leaf is
    // built from, and the pocket is the wall BEYOND that jamb, into which the leaf
    // travels. `openAngle` becomes 1 so `current` is the fraction slid.
    if (o.sliding) o.swing = 1;
    return [o];
  }).sort((A, B) => A.oa - B.oa);
  if (!list.length) { seg(a0, b0, 0, H); return g; }
  const slabT = 0.05;
  const doorEntries = [];
  // A hinged wood leaf filling the opening: a pivot Group at the hinge jamb with
  // the slab offset half its width toward the opening centre, so rotating the
  // pivot about Y swings it into the room. Registered for the shared toggle/ease.
  // A thin box in the leaf's local frame: `uc` = position along the run axis from
  // the hinge (0), `yc` = height; `du` = size along the run, `dy` = height, `dz` = thickness.
  const leafBox = (leaf, uc, yc, du, dy, mat, dz = slabT) => {
    const geo = new THREE.BoxGeometry(axis === "x" ? du * ft : dz, dy * ft, axis === "x" ? dz : du * ft);
    const m = new THREE.Mesh(geo, mat); m.position.set(axis === "x" ? uc * ft : 0, yc * ft, axis === "x" ? 0 : uc * ft);
    m.castShadow = true; leaf.add(m); return m;
  };
  // A divided-light (french) glass leaf: stiles + rails frame, a glass pane, and
  // muntins splitting it into a 2-wide x (lites/2)-tall grid.
  const addGlassLeaf = (leaf, lw, lh, sgn, lites) => {
    const stile = 0.13, topR = 0.16, botR = 0.7, mun = 0.045, S = sgn;
    leafBox(leaf, S * (stile / 2), lh / 2, stile, lh, leafMat);              // hinge stile
    leafBox(leaf, S * (lw - stile / 2), lh / 2, stile, lh, leafMat);         // free stile
    leafBox(leaf, S * (lw / 2), lh - topR / 2, lw, topR, leafMat);           // top rail
    leafBox(leaf, S * (lw / 2), botR / 2, lw, botR, leafMat);                // bottom rail
    const gy0 = botR, gy1 = lh - topR, gH = gy1 - gy0, gW = lw - 2 * stile;
    leafBox(leaf, S * (lw / 2), (gy0 + gy1) / 2, gW, gH, glassMat, slabT * 0.4);   // glass pane
    leafBox(leaf, S * (lw / 2), (gy0 + gy1) / 2, mun, gH, leafMat);          // centre vertical muntin (2 cols)
    const rows = Math.max(1, Math.round(lites / 2));
    for (let k = 1; k < rows; k++) leafBox(leaf, S * (lw / 2), gy0 + gH * k / rows, gW, mun, leafMat); // horizontal muntins
  };
  const addLeaf = (o) => {
    const lw = o.w - 0.03, lh = o.head - 0.03;                 // ft
    const hx = o.hinge === "b" ? o.ob : o.oa;                  // hinge coord along the run axis
    const sgn = o.hinge === "b" ? 1 : -1;                      // slab sits this side of the hinge
    const leaf = new THREE.Group();
    if (o.glass) {
      addGlassLeaf(leaf, lw, lh, sgn, o.lites ?? 8);
    } else {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(axis === "x" ? lw * ft : slabT, lh * ft, axis === "x" ? slabT : lw * ft), leafMat);
      if (axis === "x") panel.position.set(sgn * (lw / 2) * ft, (lh / 2) * ft, 0);
      else              panel.position.set(0, (lh / 2) * ft, sgn * (lw / 2) * ft);
      panel.castShadow = true; leaf.add(panel);
    }
    const off = (c0 - hx) * ft;                                // pivot at the hinge, on the wall centreline
    leaf.position.set(axis === "x" ? off : 0, 0, axis === "x" ? 0 : off);
    g.add(leaf);
    const entry = { pivot: leaf, openAngle: o.swing, current: o.swing, open: true };
    if (o.sliding) {
      // The leaf extends `sgn` along the local run axis from its jamb, so the pocket is
      // the other way: it slides -sgn, stopping 2 in short of fully buried so a pull
      // shows — the same detail as main.js's IFC pocket doors, applied by the same ease.
      const dir = axis === "x" ? new THREE.Vector3(-sgn, 0, 0) : new THREE.Vector3(0, 0, -sgn);
      entry.slide = { from: leaf.position.clone(), axis: dir, dist: Math.max(0.1, (lw - 0.17) * ft) };
      leaf.position.copy(entry.slide.from).addScaledVector(dir, entry.slide.dist);   // doors default OPEN
    } else {
      leaf.rotation.y = o.swing;                                // doors default OPEN
    }
    leaf.children.forEach((m) => { m.userData.fdoor = entry; });   // any leaf mesh double-taps the door
    doorEntries.push(entry);
  };
  let cur = a0;
  for (const o of list) {
    seg(cur, o.oa, 0, H);        // jamb up to the opening
    seg(o.oa, o.ob, o.head, H);  // head over the opening
    if (!o.opening) addLeaf(o);  // cased opening (opening:true) skips the door slab
    cur = o.ob;
  }
  seg(cur, b0, 0, H);            // final jamb
  if (doorEntries.length) g.userData.doors = doorEntries;   // buildFurniture wires these into double-tap
  return g;
}

// A platform bed (default queen: 5.0 x 6.67 ft mattress). The anchor (px,pz) is
// the MATTRESS centre; `head` names the wall the HEADBOARD backs onto ("N"/"S"/
// "E"/"W") and the bed extends into the room away from it. Basic: frame, mattress,
// headboard, two pillows, a folded duvet at the foot.
function buildBed(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc));
    m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const woodm = woodMat(col(p.frame || "walnut", 0x6b4a2f));
  const sheet = new THREE.MeshStandardMaterial({ color: col(p.linen || "linen", 0xcfc6b4), roughness: 0.98 });
  const pillowM = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.98 });
  const duvetM = new THREE.MeshStandardMaterial({ color: col(p.duvet || "sage", 0x8a9a86), roughness: 0.98 });
  const L = p.lenFt ?? 6.67, W = p.widthFt ?? 5.0;
  const A = DIR[OPP[p.head || "S"]], P = [-A[1], A[0]];   // A = away from head wall (foot dir)
  const frameH = 0.7, matT = 0.75, headH = p.headFt ?? 3.4, headT = 0.3;   // headFt: low headboard fits under a sloped attic ceiling
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  q = pl(0, 0, L + 0.3, W + 0.3);  box(q[0], q[1], frameH / 2, q[2], q[3], frameH, woodm, 0.04);         // platform
  q = pl(0, 0, L, W);              box(q[0], q[1], frameH + matT / 2, q[2], q[3], matT, sheet, 0.06);     // mattress
  q = pl(-(L / 2 + headT / 2), 0, headT, W + 0.3); box(q[0], q[1], headH / 2, q[2], q[3], headH, woodm, 0.04); // headboard
  for (const s of [-1, 1]) {       // two pillows against the headboard
    q = pl(-(L / 2 - 1.05), s * (W / 4), 1.5, W / 2 - 0.25);
    box(q[0], q[1], frameH + matT + 0.16, q[2], q[3], 0.42, pillowM, 0.12);
  }
  q = pl(L / 2 - 1.5, 0, 2.4, W);  box(q[0], q[1], frameH + matT + 0.05, q[2], q[3], 0.14, duvetM, 0.05); // duvet fold
  return g;
}

// Full-height, full-depth built-in closet cabinetry along one wall. Anchor
// (px,pz) = footprint CENTRE; `faces` = the direction it opens into the room
// (back sits against the wall). `bays` (laid from one end) are objects:
//   { type: "drawtower" | "hang" | "drawhang" | "window", widthFt, sill?, head? }
// Every bay carries an upper cabinet on top; a "window" bay leaves the sill..head
// gap open (drawers below, uppers above, gables at the sides) so it frames a window.
function buildClosetRun(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const wood = woodMat(col(p.wood || "walnut", 0x6b4a2f));
  const backM = new THREE.MeshStandardMaterial({ color: 0x513923, roughness: 0.7 });
  const toeM = new THREE.MeshStandardMaterial({ color: 0x241b13, roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const rodM = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.3, metalness: 0.7 });
  const garM = new THREE.MeshStandardMaterial({ color: 0xcabfa8, roughness: 0.95 });
  const A = DIR[p.faces || "S"], P = [-A[1], A[0]];
  const D = p.depthFt ?? 2.0, TOP = p.heightFt ?? 8.6, TOE = 0.3, UP = 7.0, SILL = 2.5, HEAD = 6.0, CEIL = 9.0;
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  const bodyBox = (ds, w, y0, y1) => { q = pl(0, ds, D, w - 0.04); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, wood, 0.01); };
  const toeKick = (ds, w) => { q = pl(-0.12, ds, D - 0.24, w - 0.04); box(q[0], q[1], TOE / 2, q[2], q[3], TOE, toeM); };
  const drawerFaces = (ds, w, y0, y1, n) => {
    for (let i = 0; i < n; i++) {
      const yc = y0 + (y1 - y0) * (i + 0.5) / n;
      q = pl(D / 2 + 0.02, ds, 0.04, w - 0.1); box(q[0], q[1], yc, q[2], q[3], (y1 - y0) / n - 0.05, wood, 0.015);
      q = pl(D / 2 + 0.06, ds, 0.05, w * 0.45); box(q[0], q[1], yc, q[2], q[3], 0.05, chrome);   // bar pull
    }
  };
  const doorFaces = (ds, w, y0, y1) => {
    for (const s of [-1, 1]) {
      q = pl(D / 2 + 0.02, ds + s * (w / 4), 0.04, w / 2 - 0.08); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0 - 0.06, wood, 0.015);
      q = pl(D / 2 + 0.06, ds - s * 0.1, 0.06, 0.06);            box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], 0.06, chrome); // knob near centre
    }
  };
  const hangBlock = (ds, w, y0, y1) => {
    for (const s of [-1, 1]) { q = pl(0, ds + s * (w / 2 - 0.03), D, 0.06); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, wood); } // gables
    q = pl(-(D / 2 - 0.03), ds, 0.06, w - 0.08); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, backM);   // back panel
    q = pl(0, ds, D, w - 0.06); box(q[0], q[1], y1 - 0.04, q[2], q[3], 0.08, wood, 0.01);                       // top shelf
    const rY = y1 - 0.45;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * ft, 0.03 * ft, (w - 0.2) * ft, 12), rodM);
    rod.rotation.z = Math.PI / 2; q = pl(0.15, ds, 0, 0); rod.position.copy(V(q[0], q[1], rY)); g.add(rod);     // rod along the run
    const nG = Math.max(2, Math.round((w - 0.2) / 0.55)), gTop = rY - 0.12, gBot = y0 + 0.3;
    for (let i = 0; i < nG; i++) {
      const gs = -w / 2 + 0.35 + (nG > 1 ? i * (w - 0.7) / (nG - 1) : 0);
      q = pl(0.12, ds + gs, 0.55, 0.3); box(q[0], q[1], (gTop + gBot) / 2, q[2], q[3], gTop - gBot, garM, 0.05); // hanging garments
    }
  };
  const crown = (ds, w) => { q = pl(0, ds, D + 0.06, w); box(q[0], q[1], (TOP + CEIL) / 2, q[2], q[3], CEIL - TOP, wood, 0.01); };  // filler to ceiling
  const bay = {
    drawtower: (ds, w) => { toeKick(ds, w); bodyBox(ds, w, TOE, UP); drawerFaces(ds, w, TOE, UP, 7); bodyBox(ds, w, UP, TOP); doorFaces(ds, w, UP, TOP); },
    hang:      (ds, w) => { toeKick(ds, w); hangBlock(ds, w, TOE, UP); bodyBox(ds, w, UP, TOP); doorFaces(ds, w, UP, TOP); },
    drawhang:  (ds, w) => { toeKick(ds, w); bodyBox(ds, w, TOE, SILL); drawerFaces(ds, w, TOE, SILL, 3); hangBlock(ds, w, SILL, UP); bodyBox(ds, w, UP, TOP); doorFaces(ds, w, UP, TOP); },
    window:    (ds, w, sill, head) => {
      toeKick(ds, w); bodyBox(ds, w, TOE, sill); drawerFaces(ds, w, TOE, sill, 3);   // drawers below sill
      for (const s of [-1, 1]) { q = pl(0, ds + s * (w / 2 - 0.03), D, 0.06); box(q[0], q[1], (sill + head) / 2, q[2], q[3], head - sill, wood); } // jamb gables
      bodyBox(ds, w, head, TOP); doorFaces(ds, w, head, TOP);                        // uppers above head
    },
  };
  const L = p.lenFt, bays = p.bays || [];
  let cur = -L / 2;
  for (const b of bays) {
    const w = b.widthFt, ds = cur + w / 2;
    if (b.type === "window") bay.window(ds, w, b.sill ?? SILL, b.head ?? HEAD);
    else (bay[b.type] || bay.hang)(ds, w);
    crown(ds, w);
    cur += w;
  }
  return g;
}

// Bedside night table (matches the bed-frame wood): a drawer box on short tapered
// legs with a slim overhanging top and a bar pull. `faces` = the drawer-front dir.
function buildNightstand(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const wood = woodMat(col(p.wood || "walnut", 0x6b4a2f));
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const A = DIR[p.faces || "E"], P = [-A[1], A[0]];
  const W = p.widthFt ?? 1.6, D = p.depthFt ?? 1.5, legH = 0.5, bodyH = 1.15;
  const topY = legH + bodyH;
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  q = pl(0, 0, D, W);                     box(q[0], q[1], legH + bodyH / 2, q[2], q[3], bodyH, wood, 0.02);      // drawer box
  q = pl(0, 0, D + 0.12, W + 0.12);       box(q[0], q[1], topY + 0.03, q[2], q[3], 0.09, wood, 0.02);           // top overhang
  q = pl(D / 2 + 0.02, 0, 0.04, W - 0.2); box(q[0], q[1], legH + bodyH / 2, q[2], q[3], bodyH - 0.2, wood, 0.01); // drawer front
  q = pl(D / 2 + 0.06, 0, 0.05, 0.2);     box(q[0], q[1], legH + bodyH / 2, q[2], q[3], 0.05, chrome);          // bar pull
  for (const sa of [-1, 1]) for (const sp of [-1, 1]) {                                                          // four legs
    q = pl(sa * (D / 2 - 0.12), sp * (W / 2 - 0.12), 0.11, 0.11); box(q[0], q[1], legH / 2, q[2], q[3], legH, wood);
  }
  return g;
}

// Floor-standing toilet. Anchor (px,pz) = footprint centre; `faces` = the
// direction the bowl/seat point (the tank backs onto the opposite wall).
// WALL-HUNG TOILET parts, in a LOCAL frame: -X is the wall, +X the front, origin at the
// bowl's plan centre on the floor. A floating china bowl cantilevered off the wall (a
// revolved UPPER-bowl profile only — no pedestal, so the floor under it is clear, which
// is what a wall-hung buys: more room for a door to swing), an elongated seat, and the
// flush plate on the wall over a cistern concealed in it. Shared by `buildBathroom`,
// which places it positionally, and the `wall_toilet` manifest builder below.
function wallToiletParts({ porc, chrome, bowlInt, plateM }) {
  const ft = FT, grp = new THREE.Group();
  const oval = (rx, ry, cxs = 0) => { const s = new THREE.Shape(); s.absellipse(cxs * ft, 0, rx * ft, ry * ft, 0, Math.PI * 2); return s; };
  const prof = [[0.00, 0.86], [0.30, 0.88], [0.45, 1.00], [0.54, 1.20], [0.57, 1.40],
                [0.57, 1.48], [0.40, 1.49], [0.34, 1.34], [0.30, 1.15], [0.16, 1.05],
                [0.00, 1.03]].map(([r, y]) => new THREE.Vector2(r * ft, y * ft));
  const bowl = new THREE.Mesh(new THREE.LatheGeometry(prof, 44), porc);
  bowl.scale.x = 1.5; bowl.material.side = THREE.DoubleSide;
  bowl.position.set(0.35 * ft, 0, 0);                  // shift forward so the back tucks to the wall
  grp.add(bowl);
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.26 * ft, 24), bowlInt);
  water.rotation.x = -Math.PI / 2; water.scale.x = 1.5; water.position.set(0.37 * ft, 1.12 * ft, 0); grp.add(water);
  // elongated oval seat
  const seatSh = oval(0.62, 0.46, 0.05); seatSh.holes.push((() => { const h = new THREE.Path(); h.absellipse(0.09 * ft, 0, 0.34 * ft, 0.3 * ft, 0, Math.PI * 2); return h; })());
  const seat = new THREE.Mesh(new THREE.ExtrudeGeometry(seatSh, { depth: 0.06 * ft, bevelEnabled: false }), porc);
  seat.rotation.x = -Math.PI / 2; seat.position.set(0.35 * ft, 1.5 * ft, 0); grp.add(seat);
  // flush actuator plate on the wall, above the bowl
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.05 * ft, 1.0 * ft, 0.7 * ft, 3, 0.03), plateM);
  plate.position.set(-0.62 * ft, 3.1 * ft, 0); grp.add(plate);
  const btn = new THREE.Mesh(new THREE.BoxGeometry(0.03 * ft, 0.34 * ft, 0.4 * ft), chrome);
  btn.position.set(-0.585 * ft, 3.25 * ft, 0); grp.add(btn);
  grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return grp;
}
const WALL_TOILET_BACK = 0.645;   // wall face to bowl centre, ft (the plate's back face)

// Wall-hung toilet as a manifest item. Anchor (px,pz) = the WALL LINE at the bowl's
// centre (as `wall_basin`), `faces` = the way the bowl points into the room. The bowl
// front lands 1.85 ft off the wall, against 2.0 for the floor-standing `toilet` — and
// nothing on the floor, which is the clearance a tight water closet is after.
function buildWallToilet(p) {
  const ft = FT, g = new THREE.Group();
  const A = DIR[p.faces || "W"];
  const porc = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.25 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const bowlInt = new THREE.MeshStandardMaterial({ color: 0xcdd2d2, roughness: 0.2, side: THREE.DoubleSide });
  const plateM = new THREE.MeshStandardMaterial({ color: 0xedeef0, roughness: 0.4 });
  const grp = wallToiletParts({ porc, chrome, bowlInt, plateM });
  // Local +X (the front) has to point along A. V() maps plan (dx,dz) to world (-dx,.,-dz),
  // so A is world (-A[0], 0, -A[1]); a rotation th about Y sends +X to (cos th, 0, -sin th).
  grp.rotation.y = Math.atan2(A[1], -A[0]);
  // The anchor is the wall line; the bowl's centre sits BACK off it, along A.
  grp.position.set(-A[0] * WALL_TOILET_BACK * ft, 0, -A[1] * WALL_TOILET_BACK * ft);
  g.add(grp);
  return g;
}

function buildToilet(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; g.add(m); return m;
  };
  const porc = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.25 });
  const seatM = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4 });
  const A = DIR[p.faces || "E"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  q = pl(-0.85, 0, 0.5, 1.7);  box(q[0], q[1], 1.55, q[2], q[3], 1.3, porc, 0.05);   // cistern/tank (0.9..2.2)
  q = pl(-0.1, 0, 0.7, 0.75);  box(q[0], q[1], 0.35, q[2], q[3], 0.7, porc, 0.1);    // pedestal
  q = pl(0.15, 0, 1.5, 1.25);  box(q[0], q[1], 0.75, q[2], q[3], 1.1, porc, 0.22);   // bowl body
  q = pl(0.15, 0, 1.5, 1.3);   box(q[0], q[1], 1.32, q[2], q[3], 0.12, seatM, 0.2);  // seat
  return g;
}

// A small WALL-HUNG LAVATORY — no cabinet. What a powder room 3 ft 2 in wide actually
// gets, and the reason it is here rather than a narrowed vanity: in a corridor room
// every fixture is in series, so the basin's length along the wall is what fixes how far
// north the WC can sit, and a cabinet's counter was eating 21 in of it. This is 15.
//
// Modelled as it is made, not as a slab on a bracket: a china bowl with a raised rim and
// a recessed well, a splashback returning up the wall, the tap on the back ledge, and
// the exposed chromed trap and stops underneath — a wall-hung basin has no cupboard to
// hide them in, which is most of what it looks like from the doorway.
// Anchor (px,pz) = the WALL LINE at the basin's centre; `faces` = the way it looks into
// the room (so the wall is behind it).
function buildWallBasin(p) {
  const ft = FT, g = new THREE.Group();
  const A = DIR[p.faces || "E"], P = [-A[1], A[0]];
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const box = (da, ds, y, dl, dw, hy, mat, rad = 0) => {
    const [opx, opz, sx, sz] = pl(da, ds, dl, dw);
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(V(opx, opz, y)); m.castShadow = true; g.add(m); return m;
  };
  const cyl = (da, ds, y, r, h, mat, axis = "y") => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, h * ft, 16), mat);
    const [opx, opz] = pl(da, ds, 0, 0);
    if (axis === "a") m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-A[0], 0, -A[1]).normalize());
    m.position.copy(V(opx, opz, y)); g.add(m); return m;
  };
  const porc = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.25 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const W = p.widthFt ?? 1.25, D = p.depthFt ?? 0.92;   // 15 in along the wall, 11 in out
  const RIM = p.rimFt ?? 2.83;                          // rim height (34 in), the usual
  const RW = 0.14, WELL = 0.20, LEDGE = 0.22;           // rim width, well depth, tap ledge
  // THE BOWL, and the point of building it in pieces: the well has to be a real recess.
  // Drawn as one slab with a body under it — which is what this was first — the top is
  // a flat plane and the basin reads as a lump of stone with a tap behind it. So the rim
  // is FOUR bars, each running the full depth of the well, which makes them the rim seen
  // from above and the well's side walls seen from the doorway; the floor of the well is
  // a slab set down between them, and the underbowl hangs below that.
  box(RW / 2, 0, RIM - WELL / 2, RW, W, WELL, porc, 0.03);                  // rim, at the wall
  box(D - RW / 2, 0, RIM - WELL / 2, RW, W, WELL, porc, 0.03);              // rim, at the front
  for (const sg of [-1, 1])                                                  // rim, the two ends
    box(D / 2, sg * (W - RW) / 2, RIM - WELL / 2, D, RW, WELL, porc, 0.03);
  box(D / 2, 0, RIM - WELL - 0.015, D - 2 * RW, W - 2 * RW, 0.03, porc);     // floor of the well
  box(D / 2, 0, RIM - WELL - 0.16, D - 0.10, W - 0.13, 0.26, porc, 0.09);    // underbowl
  box(0.06, 0, RIM - WELL - 0.28, 0.12, W - 0.13, 0.50, porc, 0.04);        // hanger, back to the wall
  box(0.02, 0, RIM + 0.17, 0.05, W, 0.34, porc, 0.02);                      // splashback up the wall
  // Tap and waste on the back ledge, then the exposed chrome below.
  cyl(LEDGE * 0.5, 0, RIM + 0.16, 0.035, 0.32, chrome);                     // pillar tap
  box(LEDGE * 0.5 + 0.09, 0, RIM + 0.29, 0.18, 0.05, 0.03, chrome);         // spout
  cyl(D * 0.52, 0, RIM - WELL - 0.42, 0.055, 0.26, chrome);                 // tailpiece
  cyl(D * 0.52, 0, RIM - WELL - 0.58, 0.075, 0.16, chrome);                 // P-trap bend
  cyl(D * 0.30, 0, RIM - WELL - 0.63, 0.048, D * 0.44, chrome, "a");        // trap arm into the wall
  for (const sg of [-1, 1]) {                                               // angle stops
    cyl(0.10, sg * (W / 2 - 0.17), RIM - WELL - 0.68, 0.032, 0.22, chrome);
    box(0.10, sg * (W / 2 - 0.17), RIM - WELL - 0.56, 0.07, 0.07, 0.07, chrome, 0.02);
  }
  return g;
}

// Walk-in shower: a tiled pan with tiled back + two side walls, a fixed glass
// screen over half the open side (walk-in gap on the other half), and a
// wall-mounted head. Anchor (px,pz) = footprint centre; `opens` = the open
// (glass) side (the back tiles onto the opposite wall).
function buildShower(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft), mat);
    m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const tile = new THREE.MeshStandardMaterial({ color: 0xd7dadc, roughness: 0.4, side: THREE.DoubleSide });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xafc4cc, roughness: 0.05, transparent: true, opacity: 0.26 });
  glass.depthWrite = false;
  const A = DIR[p.opens || "N"], P = [-A[1], A[0]];   // A = open (glass) side
  // Enclosure height is a parameter: a walk-in tiled to the ceiling is a different
  // thing from one stopping at 6'10", and the glass over the pony wall follows it.
  // `wallFt` is the tiled walls' thickness, INSIDE the footprint. 0.3 is a tiled stud wall; a
  // shower whose end wall continues as a room partition wants the partition's 0.4583, or the
  // two read as one wall with a step in it.
  const Wd = p.widthFt ?? 3.6, Dp = p.depthFt ?? 3.2, H = p.heightFt ?? 6.8, wt = p.wallFt ?? 0.3;
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  // TILE MODULES on the enclosure walls, opt-in with `tileModule: {wFt, hFt}` — without it
  // the walls stay the plain slabs they were, so nothing else in the house changes. Tiles are
  // laid proud of the wall face and the substrate behind them reads as the grout, the same
  // trick wood-floor.js uses for its planks over a dark base. Every tile in the shower goes
  // into ONE InstancedMesh: ~2000 of them is a single draw call.
  const tmod = p.tileModule;
  const TW = tmod ? (tmod.wFt ?? 2 / 12) : 0, TILEH = tmod ? (tmod.hFt ?? 6 / 12) : 0;
  const TGAP = 0.008, TOUT = 0.022;                  // grout joint and tile relief, plan ft
  const tiles = [];
  // A tiled face. `nrm` is which axis the face's normal runs along ("A" for the back and
  // front walls, "P" for the two sides), `at` locates the face and `out` says which way it
  // looks. The lattice is GLOBAL to the shower, not to the region, so courses line up across
  // pieces split around a cutout instead of each piece starting its own grid.
  const tileWall = (nrm, at, out, u0, u1, y0, y1, skip) => {
    if (!tmod) return;
    for (let i = Math.floor(u0 / TW); i < Math.ceil(u1 / TW); i++)
      for (let j = Math.floor(y0 / TILEH); j < Math.ceil(y1 / TILEH); j++) {
        const ua = Math.max(i * TW, u0), ub = Math.min((i + 1) * TW, u1);
        const ya = Math.max(j * TILEH, y0), yb = Math.min((j + 1) * TILEH, y1);
        const uw = ub - ua - TGAP, yh = yb - ya - TGAP;
        if (uw < TW * 0.25 || yh < TILEH * 0.2) continue;        // a sliver, not a cut tile
        const uc = (ua + ub) / 2, yc = (ya + yb) / 2;
        if (skip && skip(uc, yc, ub - ua, yb - ya)) continue;
        const r = nrm === "A" ? pl(at + out * TOUT / 2, uc, TOUT, uw)
                              : pl(uc, at + out * TOUT / 2, uw, TOUT);
        const sf = 0.94 + 0.12 * hash(i * 12.9898 + j * 78.233);  // so the grid is not a printed sheet
        tiles.push({ x: -r[0] * ft, y: yc * ft, z: -r[1] * ft,
                     sx: r[2] * ft, sy: yh * ft, sz: r[3] * ft, sf });
      }
  };
  // Does a tile rect meet one of this wall's openings? Cutouts are {c, sill, head} across the
  // face; a tile touching one is simply not laid, which leaves the substrate showing as the
  // reveal — what a tiler actually does round an opening.
  const meets = (list) => (uc, yc, uw, yh) => list.some((o) =>
    Math.abs(uc - o.c) < (o.w + uw) / 2 - 1e-6 && yc + yh / 2 > o.sill + 1e-6 && yc - yh / 2 < o.head - 1e-6);
  // Curb ONLY across the walk-in opening — not a full pan — so the continuous hex
  // floor tile runs unbroken through the shower (this threshold is the single break).
  { const curbMat = new THREE.MeshStandardMaterial({ color: 0xcfd2d4, roughness: 0.5 });
    if (p.curb !== false) {
      const oW = p.ponyWalls ? (p.openFt ?? 4.0) : Wd / 2;
      const oC = p.ponyWalls ? 0 : Wd / 4;
      q = pl(Dp / 2, oC, 0.34, oW); box(q[0], q[1], 0.14, q[2], q[3], 0.28, curbMat);       // threshold curb
    } }
  // BACK WALL. Where the wall it backs onto carries a window, the tile is built AROUND the
  // opening — below, above and either side — instead of across it; `cutouts` come from
  // the generator, derived from the room's own window specs (ifc/catalog.py), in this
  // frame: `ds` along P from the centre, sill and head above the floor. One 5 x 9 ft
  // tiled box across the south wall is how the wing's transom came to be lost.
  const cuts = (p.cutouts || []).filter(c => !c.side && c.widthFt > 0 && c.headFt > c.sillFt);   // back-wall entries (ds); side entries above
  // The back wall's tile: one grid over the whole face, minus whatever the cutouts take.
  // Done here rather than per drawn piece so the courses run unbroken past an opening.
  tileWall("A", -(Dp / 2 - wt / 2), 1, -Wd / 2, Wd / 2, 0, H,
           meets(cuts.map(c => ({ c: c.ds, w: c.widthFt, sill: c.sillFt, head: c.headFt }))));
  if (!cuts.length) {
    q = pl(-(Dp / 2), 0, wt, Wd);  box(q[0], q[1], H / 2, q[2], q[3], H, tile);            // back wall
  } else {
    // pieces between the cutouts, full height; then a sill piece and a head piece per cutout
    const edges = cuts.map(c => [c.ds - c.widthFt / 2, c.ds + c.widthFt / 2]).sort((a, b) => a[0] - b[0]);
    let cur = -Wd / 2;
    for (const [a, b2] of edges) {
      if (a > cur + 0.01) { q = pl(-(Dp / 2), (cur + a) / 2, wt, a - cur); box(q[0], q[1], H / 2, q[2], q[3], H, tile); }
      cur = Math.max(cur, b2);
    }
    if (Wd / 2 > cur + 0.01) { q = pl(-(Dp / 2), (cur + Wd / 2) / 2, wt, Wd / 2 - cur); box(q[0], q[1], H / 2, q[2], q[3], H, tile); }
    for (const c of cuts) {
      if (c.sillFt > 0.01) { q = pl(-(Dp / 2), c.ds, wt, c.widthFt); box(q[0], q[1], c.sillFt / 2, q[2], q[3], c.sillFt, tile); }
      if (H > c.headFt + 0.01) { q = pl(-(Dp / 2), c.ds, wt, c.widthFt); box(q[0], q[1], (c.headFt + H) / 2, q[2], q[3], H - c.headFt, tile); }
    }
  }
  // SIDE WALLS, built around any cutout that names them: `{side: "E", da, widthFt, sillFt,
  // headFt}` — `side` a compass direction resolved against the across-axis like
  // `ponySide`, `da` the opening's centre along the depth from the shower's centre. The
  // upstairs shower took its east window inside when it grew to 6 ft; without this the
  // tile ran across the glass.
  for (const s of [-1, 1]) {
    const mine = (p.cutouts || []).filter(c => c.side && (Math.sign((DIR[c.side][0] * P[0] + DIR[c.side][1] * P[1])) || 1) === s
      && c.widthFt > 0 && c.headFt > c.sillFt);
    // This side's tile, over the whole face and minus its own cutouts — same reason as the
    // back wall: one grid per FACE, so a course is not restarted by a split in the substrate.
    tileWall("P", s * (Wd / 2 - wt / 2), -s, -Dp / 2, Dp / 2, 0, H,
             meets(mine.map(c => ({ c: c.da, w: c.widthFt, sill: c.sillFt, head: c.headFt }))));
    if (!mine.length) { q = pl(0, s * (Wd / 2), Dp, wt); box(q[0], q[1], H / 2, q[2], q[3], H, tile); continue; }
    const edges = mine.map(c => [c.da - c.widthFt / 2, c.da + c.widthFt / 2]).sort((a, b2) => a[0] - b2[0]);
    let cur = -Dp / 2;
    for (const [a, b2] of edges) {
      if (a > cur + 0.01) { q = pl((cur + a) / 2, s * (Wd / 2), a - cur, wt); box(q[0], q[1], H / 2, q[2], q[3], H, tile); }
      cur = Math.max(cur, b2);
    }
    if (Dp / 2 > cur + 0.01) { q = pl((cur + Dp / 2) / 2, s * (Wd / 2), Dp / 2 - cur, wt); box(q[0], q[1], H / 2, q[2], q[3], H, tile); }
    for (const c of mine) {
      if (c.sillFt > 0.01) { q = pl(c.da, s * (Wd / 2), c.widthFt, wt); box(q[0], q[1], c.sillFt / 2, q[2], q[3], c.sillFt, tile); }
      if (H > c.headFt + 0.01) { q = pl(c.da, s * (Wd / 2), c.widthFt, wt); box(q[0], q[1], (c.headFt + H) / 2, q[2], q[3], H - c.headFt, tile); }
    }
  }
  if (p.ponyWalls) {
    // Central walk-in opening flanked by half-height pony walls (glass above). A bench
    // runs the full depth along each side wall — front end butting into the pony wall —
    // and a product niche is recessed INTO each pony wall, above where the bench meets it.
    const bench = new THREE.MeshStandardMaterial({ color: 0xcfd2d4, roughness: 0.5 });
    const niche = new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.7 });
    const openW = p.openFt ?? 4.0, ponyW = (Wd - openW) / 2, ponyH = 3.4;
    const inner = Dp / 2 - wt / 2;                      // shower-side face of the front pony walls
    for (const s of [-1, 1]) {
      const c = s * (openW / 2 + ponyW / 2);
      q = pl(Dp / 2, c, wt, ponyW);         box(q[0], q[1], ponyH / 2, q[2], q[3], ponyH, tile);              // pony wall at the opening
      q = pl(Dp / 2, c, 0.05, ponyW - 0.1); box(q[0], q[1], (ponyH + H) / 2, q[2], q[3], H - ponyH, glass);   // glass above the pony wall
      // bench: full depth from the back wall face to the pony wall face (they connect)
      q = pl(0, s * (Wd / 2 - 0.7), 2 * inner, 1.4);  box(q[0], q[1], 0.75, q[2], q[3], 1.5, bench);          // bench spans back wall -> pony wall
      // niche recessed into the pony wall (dark pocket + shelf), above the bench top
      q = pl(inner, c, 0.1, ponyW * 0.6);   box(q[0], q[1], 2.45, q[2], q[3], 1.2, niche);                    // recessed product niche in the pony wall
      q = pl(inner, c, 0.16, ponyW * 0.6);  box(q[0], q[1], 2.45, q[2], q[3], 0.05, bench);                   // niche shelf
    }
  } else if (p.arch) {
    // ARCHED DOORLESS ENTRY: a full-height tiled front wall with ONE arched opening —
    // `widthFt` wide, jambs rising to `springFt`, a semicircle over them — centred on the
    // shower (or `offsetFt` along the across-axis). One swept shape, not boxes: the arch
    // is the outline itself, so there is no seam where a header would meet the jambs. The
    // opening is what you walk through; there is no glass, no pony wall and no curb.
    const ow = p.arch.widthFt ?? 2.5, spring = p.arch.springFt ?? 6.25, off = p.arch.offsetFt ?? 0;
    const r = ow / 2;
    // SEMICIRCULAR by default; `riseFt` below the half-width makes it SEGMENTAL — a flatter
    // arc through the same two jamb tops, for an opening too wide to carry a full
    // semicircle under the ceiling (a 6 ft arch springing at 6 ft 3 would apex at 9 ft 3).
    // A circular segment of chord `ow` and rise `rise` has radius (c^2 + rise^2) / 2 rise
    // with its centre `R - rise` below the springline.
    const rise = Math.min(p.arch.riseFt ?? r, r);
    const R = (r * r + rise * rise) / (2 * rise), cy = spring - (R - rise);
    const th = Math.atan2(spring - cy, r);                              // the jamb tops' angle off the centre
    const sh = new THREE.Shape();
    sh.moveTo(-Wd / 2 * ft, 0);
    sh.lineTo((off - r) * ft, 0); sh.lineTo((off - r) * ft, spring * ft);
    sh.absarc(off * ft, cy * ft, R * ft, Math.PI - th, th, true);      // over the top, jamb to jamb
    sh.lineTo((off + r) * ft, 0); sh.lineTo(Wd / 2 * ft, 0);
    sh.lineTo(Wd / 2 * ft, H * ft); sh.lineTo(-Wd / 2 * ft, H * ft); sh.lineTo(-Wd / 2 * ft, 0);
    const geo = new THREE.ExtrudeGeometry(sh, { depth: wt * ft, bevelEnabled: false, curveSegments: 24 });
    geo.translate(0, 0, -wt * ft / 2);                                  // straddle the front line like the box did
    const front = new THREE.Mesh(geo, tile); front.castShadow = true; front.receiveShadow = true;
    // Both faces of the arch wall: the inner one you see from in the shower, the outer one
    // that faces the room. A tile is skipped where it meets the opening — below the
    // springline that is the jamb line, above it the arc — so the last course stops short
    // and the swept shape behind it, which carries the true curve, reads as the cut border.
    const inArch = (uc, yc, uw, yh) => {
      for (const u of [uc - uw / 2, uc, uc + uw / 2]) for (const y of [yc - yh / 2, yc, yc + yh / 2]) {
        const du = u - off;
        if (y < spring ? Math.abs(du) < r : du * du + (y - cy) * (y - cy) < R * R) return true;
      }
      return false;
    };
    for (const [face, out] of [[Dp / 2 - wt / 2, -1], [Dp / 2 + wt / 2, 1]])
      tileWall("A", face, out, -Wd / 2, Wd / 2, 0, H, inArch);
    // Shape X runs along P (ds), Y up; V() maps plan (dx,dz) to world (-dx,.,-dz), so P is
    // world (-P[0], 0, -P[1]) and a turn th about Y sends local +X to (cos th, 0, -sin th).
    const Xw = { x: -P[0], z: -P[1] };
    front.rotation.y = Math.atan2(-Xw.z, Xw.x);
    const [fx, fz] = pl(Dp / 2, 0, 0, 0);
    front.position.copy(V(fx, fz, 0));
    g.add(front);
  } else if (p.ponyFt) {
    // ONE pony wall with glass over it, hard against the named side, leaving the rest of
    // the opening as the walk-in. `ponySide` is a compass direction resolved against the
    // across-axis, so it reads the same whichever way the shower opens.
    const d = DIR[p.ponySide || "E"];
    const sgn = Math.sign(d[0] * P[0] + d[1] * P[1]) || 1;
    const ponyH = 3.4, c = sgn * (Wd / 2 - p.ponyFt / 2);
    q = pl(Dp / 2, c, wt, p.ponyFt);
    box(q[0], q[1], ponyH / 2, q[2], q[3], ponyH, tile);                                    // pony wall
    q = pl(Dp / 2, c, 0.05, p.ponyFt - 0.08);
    box(q[0], q[1], (ponyH + H) / 2, q[2], q[3], H - ponyH, glass);                          // glass over it
  } else {
    q = pl(Dp / 2, -(Wd / 4), 0.05, Wd / 2); box(q[0], q[1], 3.3, q[2], q[3], 6.6, glass);  // fixed glass over half
  }
  const headSides = p.headSides || (p.headSide ? [p.headSide] : null);
  if (headSides) {
    // HEAD AND VALVES ON A SIDE WALL — or one set on EACH side wall for a two-person
    // shower (`headSides: ["E","W"]`). Compass directions resolved against the
    // across-axis like `ponySide`. The head sits HIGH (`headFt`, 6 ft 10 default — arm
    // at the top, head just under it), the valve trim and handle at hand height
    // (`valveFt`) on the same wall, so the plumbing is on the side walls and the back
    // wall, which carries the transom(s), stays clear.
    const hy = p.headFt ?? 6.8, vy = p.valveFt ?? 3.75, ha = p.headAtFt ?? 0;   // `headAtFt`: along the depth from the centre
    for (const side of headSides) {
      const d = DIR[side];
      const sgn = Math.sign(d[0] * P[0] + d[1] * P[1]) || 1;
      q = pl(ha, sgn * (Wd / 2 - 0.35), 0.14, 0.7);   box(q[0], q[1], hy, q[2], q[3], 0.14, chrome);        // arm off the side wall
      q = pl(ha, sgn * (Wd / 2 - 0.7), 0.55, 0.55);   box(q[0], q[1], hy - 0.1, q[2], q[3], 0.12, chrome);  // head
      // ON THE TILE'S INNER FACE, not on the wall's CENTRELINE. Wd/2 is where the side wall
      // is centred and it is `wt` thick, so the face you can actually see is wt/2 in from
      // there — measured from the centreline a 0.06 plate sat entirely inside the tile and
      // the valve was invisible from in the shower. Nothing caught it: a buried mesh still
      // has a bounding box, so counting parts passed.
      const face = Wd / 2 - wt / 2;
      q = pl(ha, sgn * (face - 0.03), 0.6, 0.06);   box(q[0], q[1], vy, q[2], q[3], 0.6, chrome);         // valve trim plate
      q = pl(ha, sgn * (face - 0.12), 0.08, 0.2);   box(q[0], q[1], vy, q[2], q[3], 0.08, chrome);        // handle
    }
  } else {
    // HEAD AND VALVE ON THE BACK WALL. Heights come from the same `headFt`/`valveFt` the
    // side-wall branch above uses, rather than the literal 5.5 ft that used to be here:
    // that is shoulder height on a six-foot person, which is why these read as plumbed
    // for a child. And each head now gets its OWN valve — this branch drew none at all,
    // so a two-head shower had two heads and nothing to turn them on with.
    const hy = p.headFt ?? 6.8, vy = p.valveFt ?? 3.75, bFace = Dp / 2 - wt / 2;
    const heads = p.heads ?? 1, hOff = heads === 2 ? Wd * 0.23 : 0;   // twin wall-mounted heads for a 2-person shower
    for (const hs of (heads === 2 ? [-hOff, hOff] : [0])) {
      q = pl(-(Dp / 2 - 0.35), hs, 0.7, 0.14);   box(q[0], q[1], hy, q[2], q[3], 0.14, chrome);        // head arm off back wall
      q = pl(-(Dp / 2 - 0.7), hs, 0.55, 0.55);   box(q[0], q[1], hy - 0.1, q[2], q[3], 0.12, chrome);  // shower head
      // Off the tile's inner face (Dp/2 is the back wall's centreline, `wt` thick) — see the
      // side-wall branch above, where measuring from the centreline buried the valve.
      q = pl(-(bFace - 0.03), hs, 0.06, 0.6);   box(q[0], q[1], vy, q[2], q[3], 0.6, chrome);         // valve trim plate
      q = pl(-(bFace - 0.12), hs, 0.2, 0.08);   box(q[0], q[1], vy, q[2], q[3], 0.08, chrome);        // handle
    }
  }
  if (tiles.length) {
    // One mesh for every tile on every wall. Shaded per instance off the tile material, so
    // the joints read without a second material or a texture.
    const tmat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28 });
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), tmat, tiles.length);
    const m4 = new THREE.Matrix4(), c3 = new THREE.Color(), base = new THREE.Color(0xd7dadc);
    tiles.forEach((t, i) => {
      m4.makeScale(t.sx, t.sy, t.sz); m4.setPosition(t.x, t.y, t.z);
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, c3.copy(base).multiplyScalar(t.sf));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    g.add(inst);
  }
  return g;
}

// Single vanity: a cabinet backing onto a wall, stone top, undermount basin,
// faucet, and a wall mirror above. Anchor (px,pz) = footprint centre; `faces` =
// the direction the basin faces (the cabinet backs onto the opposite wall).
function buildVanity(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; g.add(m); return m;
  };
  const cyl = (opx, opz, yc, r, h, mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, h * ft, 24), mat);
    m.position.copy(V(opx, opz, yc)); g.add(m); return m;
  };
  const woodv = woodMat(col(p.cabinet || "walnut", 0x6b4a2f));
  const porc = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.25 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const mirror = new THREE.MeshStandardMaterial({ color: 0xbfd0d6, roughness: 0.05, metalness: 0.3 });
  const sconceMat = new THREE.MeshStandardMaterial({ color: 0xfff4d8, emissive: 0xffd9a6, emissiveIntensity: 0.9, roughness: 0.5 });
  const toekick = new THREE.MeshStandardMaterial({ color: 0x241b13, roughness: 0.8 });
  const A = DIR[p.faces || "S"], P = [-A[1], A[0]];
  const Wd = p.widthFt ?? 3.0, Dp = p.depthFt ?? 1.8, sinks = p.sinks ?? 1;
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  // Custom cabinetry: recessed toe-kick, a body sitting on it, and a grid of
  // pullout drawer fronts (each proud, with a slim bar pull).
  // The COUNTER height is a parameter, and the cabinet derives from it: a vanity under a
  // window has to sit under the window's stool — the WC's east window has its sill at
  // 36 in, and the 36.6 in default drove the slab through the stool's underside. At 34 in
  // (a standard vanity height) the stool becomes the counter's back cap, which is the
  // detail a window over a counter actually gets. Default unchanged for every other one.
  const kbH = 0.33, counter = p.counterFt ?? 3.05, cabTop = counter - 0.15;
  q = pl(-0.13, 0, Dp - 0.28, Wd - 0.15); box(q[0], q[1], kbH / 2, q[2], q[3], kbH, toekick);          // recessed toe-kick
  q = pl(0, 0, Dp, Wd);                    box(q[0], q[1], kbH + (cabTop - kbH) / 2, q[2], q[3], cabTop - kbH, woodv, 0.02); // cabinet body
  // Front layout is a parameter. The default 3x3 is nine drawer fronts, which on a
  // single-sink cabinet reads as a busy grid rather than as joinery; a small vanity
  // wants two door fronts and nothing else.
  const nCols = p.cols ?? 3, nRows = p.rows ?? 3, colW = Wd / nCols, rowH = (cabTop - kbH) / nRows;
  for (let c = 0; c < nCols; c++) for (let r = 0; r < nRows; r++) {
    const ds = -Wd / 2 + (c + 0.5) * colW, yc = kbH + (r + 0.5) * rowH;
    q = pl(Dp / 2 + 0.02, ds, 0.04, colW - 0.07); box(q[0], q[1], yc, q[2], q[3], rowH - 0.07, woodv, 0.015);  // drawer front (proud)
    q = pl(Dp / 2 + 0.06, ds, 0.04, colW * 0.5);   box(q[0], q[1], yc + rowH / 2 - 0.14, q[2], q[3], 0.05, chrome); // slim bar pull
  }
  q = pl(0.05, 0, Dp + 0.1, Wd + 0.15); box(q[0], q[1], counter - 0.08, q[2], q[3], 0.16, porc, 0.02); // countertop
  // Two sinks flank a central gap (a window sits above it); one sink is centred.
  const off = sinks === 2 ? Wd / 2 - 1.25 : 0;
  const dsList = sinks === 2 ? [-off, off] : [0];
  for (const ds of dsList) {
    q = pl(0.05, ds, 0, 0);             cyl(q[0], q[1], counter - 0.03, 0.5, 0.16, porc);   // basin
    q = pl(-(Dp / 2 - 0.35), ds, 0, 0); cyl(q[0], q[1], counter + 0.15, 0.05, 0.6, chrome); // faucet
  }
  // A mirror over each sink (double) or one wide mirror (single); skip if `mirror:false`.
  // Mount proud of the wall's inner face (the cabinet back sits at the ~0.46 ft-thick
  // wall centreline, so -(Dp/2) would bury the mirror inside the wall).
  if (p.mirror !== false) {
    // Height, top and width are parameters. The 5.4 ft default tops the glass out at
    // 65 in, which is below eye level for anyone tall; a mirror wants its top nearer 6'6".
    const mw = p.mirrorWFt ?? (sinks === 2 ? 1.0 : Wd - 0.4);
    const mh = p.mirrorHFt ?? 2.2, mtop = p.mirrorTopFt ?? 5.4;
    for (const ds of dsList) { q = pl(-(Dp / 2 - 0.3), ds, 0.06, mw); box(q[0], q[1], mtop - mh / 2, q[2], q[3], mh, mirror); }
  }
  // Slim wall sconces outboard of the mirrors (at the vanity ends), proud of the wall.
  if (p.sconces) for (const s of [-1, 1]) { q = pl(-(Dp / 2 - 0.28), s * (Wd / 2 - 0.25), 0.08, 0.22); box(q[0], q[1], 5.0, q[2], q[3], 1.2, sconceMat); }
  return g;
}

// An upholstered sofa (3-seat by default). Anchor (px,pz) = footprint centre;
// `faces` = the direction the seat faces (the back rests on the opposite wall).
// `wFt` = width along the back wall, `dFt` = depth (front-to-back).
function buildSofa(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const frame = fabricMat(col(p.material || "upholstery", 0x5a6b80));
  const cush = fabricMat(col(p.cushion || "oatmeal", 0xd9d2c4));
  const leg = woodMat(col(p.legMaterial || "walnut", 0x6b4a2f));
  const W = p.wFt ?? 7.0, D = p.dFt ?? 3.0;
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];   // A = facing dir; back = -A
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  q = pl(0, 0, D, W);              box(q[0], q[1], 0.85, q[2], q[3], 0.9, frame, 0.08);            // base/apron
  q = pl(-(D / 2 - 0.4), 0, 0.8, W - 0.5);  box(q[0], q[1], 1.85, q[2], q[3], 1.9, frame, 0.12);   // backrest (at the back, -A)
  for (const s of [-1, 1]) { q = pl(0, s * (W / 2 - 0.35), D, 0.7); box(q[0], q[1], 1.35, q[2], q[3], 1.0, frame, 0.12); } // arms
  for (const s of [-1, 0, 1]) { q = pl(0.15, s * (W / 3), D - 0.9, W / 3 - 0.2); box(q[0], q[1], 1.35, q[2], q[3], 0.5, cush, 0.14); } // seat cushions
  for (const s of [-1, 0, 1]) { q = pl(-(D / 2 - 0.55), s * (W / 3), 0.5, W / 3 - 0.2); box(q[0], q[1], 1.95, q[2], q[3], 0.9, cush, 0.16); } // back cushions
  for (const sx of [-1, 1]) for (const sd of [-1, 1]) { q = pl(sd * (D / 2 - 0.3), sx * (W / 2 - 0.3), 0, 0); const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * ft, 0.04 * ft, 0.45 * ft, 8), leg); m.position.copy(V(q[0], q[1], 0.22)); g.add(m); } // legs
  return g;
}

// A wall media unit: a low console + a wall-mounted flat-screen above it.
// Anchor (px,pz) = centre; `faces` = the direction the screen faces (console backs
// onto the opposite wall).
function buildTV(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 2, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; g.add(m); return m;
  };
  const wood = woodMat(col(p.console || "darkwalnut", 0x3a2a1c));
  const screen = new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.35, metalness: 0.2 });
  const bezel = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.5 });
  const W = p.wFt ?? 5.0, D = p.dFt ?? 1.4, scrW = p.screenFt ?? 4.5;
  const scrH = scrW * 9 / 16;    // 16:9 panel: derive height from width (so screenFt sets a real TV size)
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  q = pl(0, 0, D, W);            box(q[0], q[1], 0.9, q[2], q[3], 1.8, wood, 0.03);        // console cabinet
  // Mount the panel proud of the wall face (the anchor sits ~0.45 ft off the wall,
  // so the old console-relative offset buried the panel inside the wall thickness).
  q = pl(-0.23, 0, 0.12, scrW + 0.15); box(q[0], q[1], 4.1, q[2], q[3], scrH + 0.15, bezel, 0.02); // TV bezel
  q = pl(-0.20, 0, 0.06, scrW);        box(q[0], q[1], 4.1, q[2], q[3], scrH, screen);        // screen face (just proud of the bezel)
  return g;
}

// A freestanding soaking tub. Anchor (px,pz) = footprint centre; wFt (E-W) x dFt (N-S)
// footprint, `heightFt` to the rim (1.95). `deckFt` > 0 sits it on a raised stone platform
// (a step-up spa deck). `filler` names the compass end the floor-mounted filler stands at.
//
// Modelled as a tub is made, not as a block: a HOLLOW shell — a rounded-rectangle ring
// extruded to the rim, so the inside walls are real faces seen from above — with a floor
// in the bottom, a rolled rim overhanging the shell, and a water surface 6 in below the
// rim. The first version was a rounded box with the "basin" a second rounded box standing
// proud of its top, which read from any angle as one pill lying on another.
function buildTub(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const acrylic = new THREE.MeshStandardMaterial({ color: 0xf6f7f5, roughness: 0.15, metalness: 0.05 });
  const water = new THREE.MeshStandardMaterial({ color: 0xcfe0e4, roughness: 0.1, transparent: true, opacity: 0.8 });
  water.depthWrite = false;
  const stone = new THREE.MeshStandardMaterial({ color: col(p.deckMaterial || "limestone", 0xcdc3b0), roughness: 0.75 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const W = p.wFt ?? 6.0, D = p.dFt ?? 2.8, H = p.heightFt ?? 1.95, deck = p.deckFt ?? 0;
  const t = 0.12, rimW = 0.22;                                  // shell wall, rolled rim width (ft)
  const r = Math.min(W, D) * 0.42;                              // corner radius: near-oval ends
  if (deck > 0) {                                               // raised deck (step up), 6" ledge around the tub
    const m = new THREE.Mesh(new RoundedBoxGeometry((W + 1.0) * ft, deck * ft, (D + 1.0) * ft, 5, 0.06 * ft), stone);
    m.position.copy(V(0, 0, deck / 2)); m.castShadow = true; m.receiveShadow = true; g.add(m);
  }
  // a rounded rectangle w x d (ft) with corner radius rr, centred on the origin, in metres
  const rrect = (w, d, rr) => {
    const sh = new THREE.Shape(), x0 = -w * ft / 2, y0 = -d * ft / 2, wm = w * ft, dm = d * ft, rm = Math.min(rr * ft, wm / 2, dm / 2);
    sh.moveTo(x0 + rm, y0); sh.lineTo(x0 + wm - rm, y0); sh.absarc(x0 + wm - rm, y0 + rm, rm, -Math.PI / 2, 0, false);
    sh.lineTo(x0 + wm, y0 + dm - rm); sh.absarc(x0 + wm - rm, y0 + dm - rm, rm, 0, Math.PI / 2, false);
    sh.lineTo(x0 + rm, y0 + dm); sh.absarc(x0 + rm, y0 + dm - rm, rm, Math.PI / 2, Math.PI, false);
    sh.lineTo(x0, y0 + rm); sh.absarc(x0 + rm, y0 + rm, rm, Math.PI, 1.5 * Math.PI, false);
    return sh;
  };
  // a horizontal slab of the shape (optionally ringed by a hole), `h` ft thick, base at `y` ft.
  // The shape's plane is turned to lie flat: shape x stays E-W, shape y becomes N-S, the
  // extrusion rises.
  const slab = (outer, hole, h, y, mat) => {
    if (hole) outer.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(outer, { depth: h * ft, bevelEnabled: false, curveSegments: 16 });
    const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.y = y * ft;
    m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  slab(rrect(W, D, r), rrect(W - 2 * t, D - 2 * t, r - t), H, deck, acrylic);                    // the shell, hollow
  slab(rrect(W - 2 * t, D - 2 * t, r - t), null, 0.2, deck, acrylic);                             // the floor inside it
  slab(rrect(W + 0.04, D + 0.04, r + 0.02), rrect(W - 2 * rimW, D - 2 * rimW, r - rimW), 0.1, deck + H - 0.05, acrylic); // rolled rim
  const ws = slab(rrect(W - 2 * t - 0.02, D - 2 * t - 0.02, r - t), null, 0.02, deck + H - 0.55, water); // water, 6 in down
  ws.castShadow = false;
  // Floor filler at one end: `filler` names the compass end it stands at (default "W", the
  // original). A tub run north-south wants it at a N/S end, or it stands in the basin's rim.
  const fs = p.filler || "W";
  const fx = fs === "W" ? -(W / 2 - 0.35) : fs === "E" ? (W / 2 - 0.35) : 0;
  const fz = fs === "N" ? (D / 2 - 0.35) : fs === "S" ? -(D / 2 - 0.35) : 0;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055 * ft, 0.055 * ft, 2.7 * ft, 16), chrome);
  post.position.copy(V(fx, fz, deck + 1.35)); post.castShadow = true; g.add(post);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * ft, 0.045 * ft, 0.55 * ft, 12), chrome);
  const toward = new THREE.Vector3(-(-fx) * ft, 0, -(-fz) * ft).normalize();                   // from the post toward the tub centre
  spout.position.copy(V(fx, fz, deck + 2.7)).addScaledVector(toward, 0.27 * ft);
  spout.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toward); spout.castShadow = true; g.add(spout);
  return g;
}

// A single sloped-top interior partition for the habitable attic: a wall along
// plan-z at x=`line`, from `za`..`zb`, its top following the hip-roof underside
// (so it never pokes through the roof), with an optional hinged door. Anchor (px,pz).
function buildAtticPartition(p) {
  const ft = FT, g = new THREE.Group();
  const px = p.px, pz = p.pz;
  const V = (eo, no, y) => new THREE.Vector3(-eo * ft, y * ft, -no * ft);
  const F = p.roof.footprint, eaveFt = p.roof.eaveFt || 0, pit = p.roof.pitch ?? 0.5, flatCeil = p.flatCeilFt || Infinity;
  const rz = (plx, plz) => Math.min(flatCeil, Math.max(0.4, eaveFt + pit * Math.min(plx - F.x1, F.x2 - plx, plz - F.z1, F.z2 - plz)));
  const wall = new THREE.MeshStandardMaterial({ color: 0xece9e1, roughness: 0.95, side: THREE.DoubleSide });
  const leafMat = woodMat(0x8a6a45);
  const t = 0.46, M = 14;
  const prismPanel = (pts, off, mat) => {
    const A = pts.map(([x, z, y]) => V(x - px, z - pz, y));
    const B = pts.map(([x, z, y]) => V(x - px + off[0], z - pz + off[1], y + off[2]));
    const n = pts.length, pos = [];
    const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]); }
    for (let i = 1; i < n - 1; i++) { tri(A[0], A[i], A[i + 1]); tri(B[0], B[i + 1], B[i]); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
    const me = new THREE.Mesh(geo, mat); me.castShadow = true; me.receiveShadow = true; g.add(me);
  };
  const zWall = (fx, za, zb) => {
    const pts = [[fx, za, 0], [fx, zb, 0]];
    for (let i = 0; i <= M; i++) { const z = zb + (za - zb) * i / M; pts.push([fx, z, rz(fx, z)]); }
    prismPanel(pts, [t, 0, 0], wall);
  };
  const line = p.line, za = p.za, zb = p.zb, d = p.door, doors = [];
  if (d) {
    const oa = d.atFt - d.widthFt / 2, ob = d.atFt + d.widthFt / 2;
    zWall(line, za, oa); zWall(line, ob, zb);
    const hd = Math.min(d.headFt ?? 6.85, Math.min(rz(line, oa), rz(line, ob)) - 0.1);
    prismPanel([[line, oa, hd], [line, ob, hd], [line, ob, rz(line, ob)], [line, oa, rz(line, oa)]], [t, 0, 0], wall);
    const lw = (ob - oa) - 0.03, lh = hd - 0.03;
    const hinge = d.hinge === "N" ? "b" : "a";                // z-wall: N = high (z) jamb (b), S = low jamb (a)
    const hx = hinge === "b" ? ob : oa, sgn = hinge === "b" ? 1 : -1;
    const swing = (d.opens === "W" ? -sgn : sgn) * (d.openDeg ?? 80) * Math.PI / 180;
    const leaf = new THREE.Group();
    const panel = new THREE.Mesh(new RoundedBoxGeometry(0.06, lh * ft, lw * ft, 2, 0.02), leafMat);
    panel.position.set(0, (lh / 2) * ft, sgn * (lw / 2) * ft); panel.castShadow = true;
    leaf.add(panel); leaf.position.copy(V(line - px, hx - pz, 0)); leaf.rotation.y = swing; g.add(leaf);
    const entry = { pivot: leaf, openAngle: swing, current: swing, open: true };
    panel.userData.fdoor = entry; doors.push(entry);
  } else zWall(line, za, zb);
  if (doors.length) g.userData.doors = doors;
  return g;
}

// Compact one-wall kitchenette (matches the cabinetry wood): a base run with a
// stone counter, undermount sink + faucet, a range (cooktop + oven front), a tall
// fridge at one end, and upper cabinets. Anchor (px,pz) = footprint centre;
// `faces` = the front (access) direction; the run backs onto the opposite wall.
function buildKitchenette(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const cyl = (opx, opz, yc, r, h, mat) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, h * ft, 16), mat); m.position.copy(V(opx, opz, yc)); g.add(m); return m; };
  const wood = woodMat(col(p.cabinet || "walnut", 0x6b4a2f));
  const stone = new THREE.MeshStandardMaterial({ color: 0xdad7cf, roughness: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.35, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26262a, roughness: 0.5 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const toeM = new THREE.MeshStandardMaterial({ color: 0x241b13, roughness: 0.8 });
  const A = DIR[p.faces || "E"], P = [-A[1], A[0]];
  const D = p.depthFt ?? 2.0, L = p.lenFt ?? 6.0, TOE = 0.3, CT = 3.0, baseTop = 2.9;
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  let q;
  if (p.lowerOnly) {
    // Lower cabinets ONLY (e.g. under a low dormer): a full-width counter, an
    // under-counter mini-fridge, a range (cooktop + oven), a sink, and cabinets.
    q = pl(-0.12, 0, D - 0.24, L - 0.04); box(q[0], q[1], TOE / 2, q[2], q[3], TOE, toeM);                       // toe kick (full width)
    q = pl(0, 0, D, L - 0.02); box(q[0], q[1], TOE + (baseTop - TOE) / 2, q[2], q[3], baseTop - TOE, wood, 0.01); // base body (full width)
    q = pl(0.05, 0, D + 0.12, L + 0.06); box(q[0], q[1], CT, q[2], q[3], 0.16, stone, 0.02);                     // FULL-WIDTH countertop
    const frW = 1.9, frDs = L / 2 - frW / 2 - 0.1;                          // under-counter MINI-fridge at the +ds end
    q = pl(D / 2 + 0.02, frDs, 0.04, frW - 0.06); box(q[0], q[1], (TOE + baseTop) / 2, q[2], q[3], baseTop - TOE - 0.05, steel, 0.02);
    q = pl(D / 2 + 0.06, frDs + frW / 2 - 0.18, 0, 0); box(q[0], q[1], (TOE + baseTop) / 2, q[2], q[3], baseTop - TOE - 0.5, chrome, 0.02); // handle
    const rW = 2.5, rDs = -L / 2 + rW / 2 + 0.1;                            // range: cooktop on the counter + oven front
    q = pl(0.05, rDs, 2.3, rW - 0.2); box(q[0], q[1], CT + 0.03, q[2], q[3], 0.05, dark, 0.02);
    q = pl(D / 2 + 0.02, rDs, 0.04, rW - 0.12); box(q[0], q[1], (TOE + CT) / 2 - 0.05, q[2], q[3], CT - TOE - 0.4, dark, 0.02);
    const sDs = 0.6;                                                        // sink + faucet
    q = pl(0.05, sDs, 1.4, 1.7); box(q[0], q[1], CT + 0.02, q[2], q[3], 0.05, dark, 0.03);
    q = pl(-0.15, sDs, 0, 0); cyl(q[0], q[1], CT + 0.35, 0.04, 0.7, chrome);
    for (const [a, b] of [[-L / 2 + rW + 0.1, sDs - 0.95], [sDs + 0.95, frDs - frW / 2 - 0.05]]) {  // cabinet fronts in the gaps
      const w = b - a; if (w < 0.6) continue; const n = Math.max(1, Math.round(w / 1.4));
      for (let i = 0; i < n; i++) {
        const ds = a + (i + 0.5) * w / n;
        q = pl(D / 2 + 0.02, ds, 0.04, w / n - 0.08); box(q[0], q[1], (TOE + baseTop) / 2, q[2], q[3], baseTop - TOE - 0.06, wood, 0.015);
        q = pl(D / 2 + 0.06, ds, 0.05, 0.05); box(q[0], q[1], baseTop - 0.25, q[2], q[3], 0.05, chrome);
      }
    }
    return g;
  }
  const frW = 2.2, frH = 5.8, frDs = L / 2 - frW / 2;                     // tall fridge at the +ds end
  q = pl(0, frDs, D, frW); box(q[0], q[1], frH / 2, q[2], q[3], frH, steel, 0.03);
  q = pl(D / 2 + 0.05, frDs + frW / 2 - 0.25, frH * 0.6, 0.05); box(q[0], q[1], frH * 0.6, q[2], q[3], 1.2, chrome); // handle
  const baseW = L - frW, baseC = -L / 2 + baseW / 2;                      // base run over the rest
  q = pl(-0.12, baseC, D - 0.24, baseW); box(q[0], q[1], TOE / 2, q[2], q[3], TOE, toeM);                    // toe kick
  q = pl(0, baseC, D, baseW); box(q[0], q[1], TOE + (baseTop - TOE) / 2, q[2], q[3], baseTop - TOE, wood, 0.01); // base body
  q = pl(0.05, baseC, D + 0.12, baseW + 0.06); box(q[0], q[1], CT, q[2], q[3], 0.16, stone, 0.02);           // countertop
  const nC = Math.max(2, Math.round(baseW / 1.4));                        // base door fronts
  for (let i = 0; i < nC; i++) {
    const ds = -L / 2 + (i + 0.5) * baseW / nC;
    q = pl(D / 2 + 0.02, ds, 0.04, baseW / nC - 0.08); box(q[0], q[1], (TOE + baseTop) / 2, q[2], q[3], baseTop - TOE - 0.06, wood, 0.015);
    q = pl(D / 2 + 0.06, ds, 0.05, 0.05); box(q[0], q[1], baseTop - 0.25, q[2], q[3], 0.05, chrome);
  }
  q = pl(0.05, baseC, 1.4, 1.4); box(q[0], q[1], CT + 0.02, q[2], q[3], 0.05, dark, 0.03);                   // undermount sink rim
  q = pl(-0.15, baseC, 0, 0); cyl(q[0], q[1], CT + 0.35, 0.04, 0.7, chrome);                                 // faucet
  const rangeDs = -L / 2 + 1.3;
  q = pl(0.05, rangeDs, 2.4, 2.3); box(q[0], q[1], CT + 0.03, q[2], q[3], 0.05, dark, 0.02);                 // cooktop
  q = pl(D / 2 + 0.02, rangeDs, 0.04, 2.2); box(q[0], q[1], (TOE + CT) / 2 - 0.05, q[2], q[3], CT - TOE - 0.4, dark, 0.02); // oven front
  const upD = 1.4, upDa = -D / 2 + upD / 2, upW = baseW - 0.2, upC = baseC;                                  // upper cabinets
  q = pl(upDa, upC, upD, upW); box(q[0], q[1], 6.05, q[2], q[3], 1.7, wood, 0.01);
  const nU = Math.max(2, Math.round(upW / 1.6));
  for (let i = 0; i < nU; i++) {
    const ds = -L / 2 + (i + 0.5) * upW / nU;
    q = pl(upDa + upD / 2 + 0.02, ds, 0.04, upW / nU - 0.08); box(q[0], q[1], 6.05, q[2], q[3], 1.6, wood, 0.015);
    q = pl(upDa + upD / 2 + 0.06, ds, 0.05, 0.05); box(q[0], q[1], 5.35, q[2], q[3], 0.05, chrome);
  }
  return g;
}

// A run of cabinetry — the one builder behind every fitted run in the house.
// `kind`: "base" (toe kick + body + stone counter), "wall" (uppers hung at 4.5')
// or "tall" (full-height pantry/broom). Anchor (px,pz) = footprint centre;
// `faces` = the front (access) direction, so the run backs onto the opposite wall.
// `gaps` are spans along the run left open for an appliance, given in feet from
// the run's centre as {a, b, counter}: `counter: true` keeps the countertop
// running over the gap (a dishwasher slides under it), false breaks it (a
// slide-in range brings its own top).
function buildCabinetRun(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const cyl = (opx, opz, yc, r, h, mat) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, h * ft, 16), mat); m.position.copy(V(opx, opz, yc)); g.add(m); return m; };
  const wood = woodMat(col(p.cabinet || "cabinet", 0xeae7df));
  const stone = new THREE.MeshStandardMaterial({ color: 0xdad7cf, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26262a, roughness: 0.5 });
  const toeM = new THREE.MeshStandardMaterial({ color: 0x241b13, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.6 });
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const kind = p.kind || "base";
  // PERIOD HARDWARE, unlacquered brass: a turned knob on doors and a bin pull on
  // drawers, in place of the chrome bar pulls these runs carried before. The bar is
  // half-sunk into the front, which is the bin pull's silhouette at this scale.
  const UP = new THREE.Vector3(0, 1, 0);
  const dirDs = new THREE.Vector3(-P[0], 0, -P[1]).normalize();
  const knob = (ds, y) => {
    let k = pl(D / 2 + 0.015, ds, 0.03, 0.11);
    box(k[0], k[1], y, k[2], k[3], 0.11, brass, 0.02);                       // rose
    k = pl(D / 2 + 0.075, ds, 0, 0);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.055 * ft, 14, 10), brass);
    m.position.copy(V(k[0], k[1], y)); g.add(m);                             // turned knob
  };
  // FARMHOUSE (apron-front) sink. The basin IS the cabinetry over its module: a fireclay
  // apron stands proud of the face frame from the counter line down, with the bowl set
  // into the run behind it and the rim making the worktop over its own width.
  const fire = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.25 });
  const farmhouseSink = (ds, w) => {
    const top = CT + 0.08;
    if ((p.sinkStyle ?? "farmhouse") === "dropin") {
      // A rimmed bowl set INTO the worktop: no apron, the cabinet front runs on below
      // it. Wanted on a secondary run, where an apron sink would compete with the one
      // in the main kitchen.
      const bd = D - 0.5, bl = w - 0.5, fl = top - 0.80;
      let k = pl(0.02, ds, bd + 0.16, bl + 0.16);
      box(k[0], k[1], top - 0.03, k[2], k[3], 0.07, dark, 0.015);            // rim on the stone
      for (const t of [-1, 1]) {
        k = pl(0.02 + t * (bd / 2 + 0.03), ds, 0.06, bl + 0.12);
        box(k[0], k[1], (fl + top - 0.06) / 2, k[2], k[3], top - 0.06 - fl, dark);
        k = pl(0.02, ds + t * (bl / 2 + 0.03), bd, 0.06);
        box(k[0], k[1], (fl + top - 0.06) / 2, k[2], k[3], top - 0.06 - fl, dark);
      }
      k = pl(0.02, ds, bd, bl); box(k[0], k[1], fl, k[2], k[3], 0.06, dark); // floor
      k = pl(-D / 2 + 0.18, ds, 0, 0); cyl(k[0], k[1], top + 0.5, 0.042, 1.0, brass);
      k = pl(-D / 2 + 0.18, ds, 0, 0); box(k[0], k[1], top + 0.98, 0.55, 0.07, 0.07, brass);
      return;
    }
    const APR = p.apronFt ?? 0.88;                 // apron height, ~10-1/2"
    const bot = top - APR;                         // rim level with the worktop
    const BD = D - 0.14, RW = 0.10;              // bowl footprint, rim width
    let k = pl(D / 2 + 0.03, ds, 0.06, w);
    box(k[0], k[1], (bot + top) / 2, k[2], k[3], APR, fire, 0.03);          // apron, 3/4" proud
    // Rim as a FRAME, not a slab — a slab across the opening left nothing to see into.
    for (const t of [-1, 1]) {
      k = pl(0.02 + t * (BD / 2 - RW / 2), ds, RW, w - 0.02);
      box(k[0], k[1], top - 0.04, k[2], k[3], 0.08, fire, 0.015);           // rim, front and back
      k = pl(0.02, ds + t * ((w - 0.02) / 2 - RW / 2), BD - 2 * RW, RW);
      box(k[0], k[1], top - 0.04, k[2], k[3], 0.08, fire, 0.015);           // rim, the two ends
    }
    // bowl walls and floor, hung under the rim
    const bw = BD - 2 * RW, bl = (w - 0.02) - 2 * RW, flo = bot + 0.10;
    for (const t of [-1, 1]) {
      k = pl(0.02 + t * (bw / 2 + 0.03), ds, 0.06, bl + 0.12);
      box(k[0], k[1], (flo + top - 0.08) / 2, k[2], k[3], top - 0.08 - flo, fire);
      k = pl(0.02, ds + t * (bl / 2 + 0.03), bw, 0.06);
      box(k[0], k[1], (flo + top - 0.08) / 2, k[2], k[3], top - 0.08 - flo, fire);
    }
    k = pl(0.02, ds, bw, bl); box(k[0], k[1], flo, k[2], k[3], 0.06, fire);  // floor
    k = pl(0.02, ds, 0.35, 0.35); box(k[0], k[1], flo + 0.035, k[2], k[3], 0.02, dark, 0.01); // waste
    // The cabinet UNDER the bowl. Without it the bay is open to the floor: the apron
    // stops 1'11" up and there has to be something below it.
    const cTop = flo - 0.02, sw = w + FR;                        // back out to the stiles
    k = pl(-0.12, ds, D - 0.24, sw - 0.04); box(k[0], k[1], TOE / 2, k[2], k[3], TOE, toeM);
    k = pl(0, ds, D, sw); box(k[0], k[1], (y0 + cTop) / 2, k[2], k[3], cTop - y0, wood, 0.01);
    k = pl(FACE, ds, FT_, sw); box(k[0], k[1], y0 + FR / 2, k[2], k[3], FR, wood, 0.006);   // bottom rail
    k = pl(FACE, ds, FT_, FR); box(k[0], k[1], (y0 + cTop) / 2, k[2], k[3], cTop - y0, wood, 0.006); // centre stile
    // A pair of doors, hinged outboard like the rest of the run.
    const dy0 = y0 + FR, dy1 = cTop - 0.02, dw2 = (w - FR) / 2;
    for (const t of [-1, 1]) {
      const dc = ds + t * (dw2 + FR) / 2;
      k = pl(DFACE, dc, FT_, dw2 - 2 * REV);
      box(k[0], k[1], (dy0 + dy1) / 2, k[2], k[3], (dy1 - dy0) - 2 * REV, wood, 0.01);
      k = pl(DFACE - 0.012, dc, 0.02, dw2 - 0.30);
      box(k[0], k[1], (dy0 + dy1) / 2, k[2], k[3], (dy1 - dy0) - 0.30, stone, 0.008);
      knob(dc + t * (dw2 / 2 - 0.16) * -1, dy1 - 0.35);          // knobs meet at the centre stile
    }
    // Tall gooseneck in the same brass as the pulls, set behind the bowl.
    k = pl(-D / 2 + 0.18, ds, 0, 0);
    cyl(k[0], k[1], top + 0.55, 0.045, 1.1, brass);
    k = pl(-D / 2 + 0.18, ds, 0, 0);
    box(k[0], k[1], top + 1.08, 0.62, 0.075, 0.075, brass);                 // spout
  };
  const binPull = (ds, y, len) => {
    let k = pl(D / 2 + 0.008, ds, 0.016, len + 0.07);
    box(k[0], k[1], y, k[2], k[3], 0.17, brass, 0.02);                       // backplate
    const c = pl(D / 2 + 0.005, ds, 0, 0);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.075 * ft, 0.075 * ft, len * ft, 16), brass);
    m.position.copy(V(c[0], c[1], y - 0.01));
    m.quaternion.setFromUnitVectors(UP, dirDs); g.add(m);                    // the cup, half sunk
  };
  const D = p.depthFt ?? (kind === "wall" ? 1.1 : kind === "tall" ? 2.1 : 2.0);
  const L = p.lenFt ?? 6.0;
  // Counter height is a parameter: a laundry worktop bridging front-load machines
  // sits higher than a kitchen one. baseTop tracks it so the carcass still stops
  // under the slab.
  const TOE = 0.3, CT = p.counterFt ?? 3.0, baseTop = CT - 0.1;
  // vertical envelope of the cabinet BODY for this kind
  const y0 = kind === "wall" ? (p.bottomFt ?? 4.5) : kind === "tall" ? TOE : TOE;
  const y1 = kind === "wall" ? (p.topFt ?? 7.0) : kind === "tall" ? (p.topFt ?? 7.0) : baseTop;
  // Solid segments = the run minus its gaps, walked along ds from one end.
  const gaps = (p.gaps || []).slice().sort((u, v) => u.a - v.a);
  const segs = []; let cur = -L / 2;
  for (const gp of gaps) { if (gp.a > cur) segs.push([cur, gp.a]); cur = Math.max(cur, gp.b); }
  if (cur < L / 2) segs.push([cur, L / 2]);
  let q;
  // `divideAt` splits a solid segment into door MODULES without cutting a gap in it.
  // Stacked runs given the same array divide on the same lines, which is what makes a
  // bank of drawers, glazed doors and over-cabinets read as one grid of vertical joints
  // instead of three independently-spaced bands. Values outside a segment are no-ops,
  // so every band can be handed the identical array.
  // A FARMHOUSE sink occupies a module of its own: the face frame breaks around it and
  // the apron takes the place of a front, so its edges join the module lines.
  const SKW = p.sinkWFt ?? 3.0;
  // Only an APRON sink takes over its module — it replaces the front and opens the bay.
  // A drop-in bowl sits in the worktop with ordinary cabinetry carrying on beneath it,
  // so it must not disturb the frame at all.
  const FARM = p.sinkAt !== undefined && (p.sinkStyle ?? "farmhouse") === "farmhouse";
  const sinkLo = FARM ? p.sinkAt - SKW / 2 : null;
  const sinkHi = FARM ? p.sinkAt + SKW / 2 : null;
  // The bowl's footprint whichever style it is — a DRAWER run still has to give the
  // sink base doors, because the bowl occupies exactly where the top drawer would go.
  const bowlLo = p.sinkAt === undefined ? null : p.sinkAt - SKW / 2;
  const bowlHi = p.sinkAt === undefined ? null : p.sinkAt + SKW / 2;
  const inSink = (c) => sinkLo !== null && c > sinkLo + 1e-4 && c < sinkHi - 1e-4;
  const cuts = [...(p.divideAt || []), ...(sinkLo === null ? [] : [sinkLo, sinkHi])]
    .slice().sort((u, v) => u - v);
  const modules = [];
  for (const [a, b] of segs) {
    let m = a;
    for (const d of cuts) if (d > a + 1e-4 && d < b - 1e-4) { modules.push([m, d, a, b]); m = d; }
    modules.push([m, b, a, b]);
  }
  // INSET construction. The face frame and the fronts share one plane at the carcass
  // face, so nothing stands proud of anything else — that is what makes it read as
  // inset rather than overlay, where the doors sit ON the frame. Openings are framed
  // by stiles at every module line and rails top and bottom (and between drawers),
  // and each front fills its opening less a hairline reveal.
  const FR = p.frameFt ?? 0.17;          // face-frame stock, ~2"
  const FT_ = 0.04;                      // frame / front thickness
  // Frame and front were dead flush and the same paint, so the joint rendered as
  // nothing. The front now sits back a shade and carries a wider reveal, which puts
  // it in its own shadow and lets the frame read as a grid. Still inset — the front
  // is WITHIN its opening, not lapped over the frame.
  const REV = p.revealFt ?? 0.055;       // reveal round each inset front
  const SET = p.setbackFt ?? 0.04;       // front face behind the frame face
  const FACE = D / 2 - FT_ / 2;          // centre plane of the FRAME
  const DFACE = FACE - SET;              // centre plane of the FRONTS
  const rows = p.drawers ? (Array.isArray(p.drawers) ? p.drawers
      : p.drawers === 3 ? [0.19, 0.19, 0.62]
      : Array(p.drawers).fill(1 / p.drawers)) : null;

  // A sink bay carries no carcass, no toe kick and no rails — it is an open box with
  // the bowl dropped into it. Only the flanking stiles remain.
  const solids = [];
  for (const [a, b] of segs) {
    if (sinkLo === null || sinkHi <= a + 1e-4 || sinkLo >= b - 1e-4) { solids.push([a, b]); continue; }
    if (sinkLo > a + 1e-4) solids.push([a, sinkLo]);
    if (sinkHi < b - 1e-4) solids.push([sinkHi, b]);
  }
  for (const [a, b] of solids) {
    const w = b - a, c = (a + b) / 2;
    if (w < 0.3) continue;
    if (kind !== "wall") { q = pl(-0.12, c, D - 0.24, w); box(q[0], q[1], TOE / 2, q[2], q[3], TOE, toeM); }   // toe kick
    q = pl(0, c, D, w); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, wood, 0.01);                       // carcass
    for (const t of [0, 1]) {                                                    // top and bottom rails
      q = pl(FACE, c, FT_, w); box(q[0], q[1], t ? y1 - FR / 2 : y0 + FR / 2, q[2], q[3], FR, wood, 0.006);
    }
  }
  for (const [a, b] of segs) {
    const w = b - a, c = (a + b) / 2;
    if (w < 0.3) continue;

    // --- face frame -------------------------------------------------------
    // `divideAt` gives the explicit module lines; within each of those a DOOR run
    // subdivides again to a sensible leaf width. The inset rewrite dropped that split
    // and left the west run with one 5'7-1/2" door, since it carries no `divideAt`.
    // A drawer run takes its module as given — the east bank's banks are deliberately
    // double width and must not split back into six.
    const divs = cuts.filter((d) => d > a + 1e-4 && d < b - 1e-4);
    const base = [a, ...divs, b], lines = [];
    for (let k = 0; k < base.length - 1; k++) {
      lines.push(base[k]);
      if (rows) continue;
      const sp = base[k + 1] - base[k], nd = Math.max(1, Math.round(sp / (p.doorWFt ?? 1.4)));
      for (let j = 1; j < nd; j++) lines.push(base[k] + sp * j / nd);
    }
    lines.push(b);
    for (const ln of lines) {                                                    // stiles, ends pulled inboard
      const sc = ln === a ? a + FR / 2 : ln === b ? b - FR / 2 : ln;
      q = pl(FACE, sc, FT_, FR); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, wood, 0.006);
    }

    // --- openings between consecutive stiles -------------------------------
    for (let i = 0; i < lines.length - 1; i++) {
      const oa = lines[i] + (lines[i] === a ? FR : FR / 2);
      const ob = lines[i + 1] - (lines[i + 1] === b ? FR : FR / 2);
      const ow = ob - oa, oc = (oa + ob) / 2;
      if (ow < 0.2) continue;
      const vy0 = y0 + FR, vy1 = y1 - FR;

      if (inSink(oc)) { farmhouseSink(p.sinkAt, (sinkHi - sinkLo) - FR); continue; }
      const overBowl = bowlLo !== null && Math.min(ob, bowlHi) - Math.max(oa, bowlLo) > 0.05;
      if (rows && !overBowl) {
        // A drawer stack: intermediate rails between the fronts, so each drawer sits
        // in its own framed opening.
        const tot = rows.reduce((u, v) => u + v, 0);
        const H = (vy1 - vy0) - (rows.length - 1) * FR;
        let top = vy1;
        for (let r = 0; r < rows.length; r++) {
          const h = H * rows[r] / tot, yc = top - h / 2;
          q = pl(DFACE, oc, FT_, ow - 2 * REV);
          box(q[0], q[1], yc, q[2], q[3], h - 2 * REV, wood, 0.01);              // drawer front
          if (h - 2 * REV > 0.5) {                                               // a shallow front stays a slab
            q = pl(DFACE - 0.012, oc, 0.02, ow - 0.30);
            box(q[0], q[1], yc, q[2], q[3], h - 0.28, stone, 0.008);             // recessed panel
          }
          binPull(oc, yc, Math.min(0.5, ow * 0.42));
          top -= h;
          if (r < rows.length - 1) {                                             // rail under this drawer
            q = pl(FACE, oc, FT_, ow); box(q[0], q[1], top - FR / 2, q[2], q[3], FR, wood, 0.006);
          }
        }
      } else {
        q = pl(DFACE, oc, FT_, ow - 2 * REV);
        box(q[0], q[1], (vy0 + vy1) / 2, q[2], q[3], (vy1 - vy0) - 2 * REV, wood, 0.01);   // door
        q = pl(DFACE - 0.012, oc, 0.02, ow - 0.30);
        box(q[0], q[1], (vy0 + vy1) / 2, q[2], q[3], (vy1 - vy0) - 0.30, stone, 0.008);    // raised panel field
        // Doors hang in PAIRS: alternate the latch side by module index so consecutive
        // doors are hinged outboard and their knobs meet at the shared stile, rather
        // than every door in the run swinging the same way.
        // No hinges are drawn: on inset work the knuckle sits in the reveal on the
        // door's edge, not as a plate on its face, so a face-mounted leaf was simply
        // wrong. The knob position is what shows the swing.
        const right = i % 2 === 0;
        const ky = kind === "wall" ? Math.min(vy0 + 1.1, (vy0 + vy1) / 2) : vy1 - 0.35;
        knob(right ? ob - 0.16 : oa + 0.16, ky);
      }
    }
  }
  if (kind === "wall" && p.crownFt) {
    // CROWN on a wall run: a SPRUNG moulding along the top front edge, returned round both
    // ends and MITRED at the corners — one profile, drawn once and swept three times. The
    // laundry's uppers wear it so their top reads as a finished cap under the transom
    // rather than a carcass edge. `crownFt` is its height; the top of the crown is where
    // the cabinet ENDS, so `topFt + crownFt` is the number that meets a sill.
    const H = p.crownFt, PJ = p.crownProjFt ?? 0.22;
    const prof = (() => {
      const sh = new THREE.Shape(), h = H * ft, pj = PJ * ft;
      sh.moveTo(0, 0); sh.lineTo(0, h); sh.lineTo(pj, h);                    // back against the face, flat top
      sh.lineTo(pj, h - 0.015);                                              // lip
      sh.quadraticCurveTo(pj * 0.55, h * 0.78, pj * 0.62, h * 0.52);         // COVE, sweeping in
      sh.quadraticCurveTo(pj * 0.74, h * 0.26, pj * 0.28, h * 0.10);         // OVOLO, back to the fillet
      sh.lineTo(pj * 0.28, 0); sh.lineTo(0, 0);
      return sh;
    })();
    const upV = new THREE.Vector3(0, 1, 0);
    const wdir = (v) => new THREE.Vector3(-v[0], 0, -v[1]).normalize();      // plan direction -> world
    // One piece: profile X along `xPlan` (its projection, outward), swept `len` ft along
    // local Z = X x up from the plan point `at` (da, ds) at height y1; the caps sheared to
    // 45 deg — z := -x at the near cap, len + x at the far — which is a mitre plane through
    // the corner, the long point at the front (see src/wall-finish.js on why that way).
    const piece = (xPlan, at, len, mitre) => {
      const geo = new THREE.ExtrudeGeometry(prof, { depth: len * ft, bevelEnabled: false, curveSegments: 8 });
      const pos = geo.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        if (mitre[0] && z < len * ft / 2) pos.setZ(i, -x);
        if (mitre[1] && z >= len * ft / 2) pos.setZ(i, len * ft + x);
      }
      geo.computeVertexNormals();
      const xw = wdir(xPlan), zw = new THREE.Vector3().crossVectors(xw, upV).normalize();
      const m = new THREE.Mesh(geo, wood); m.castShadow = true; m.receiveShadow = true;
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xw, upV, zw));
      const [opx, opz] = pl(at[0], at[1], 0, 0);
      m.position.copy(V(opx, opz, y1));
      g.add(m);
      return zw;
    };
    const Pw = wdir(P), Aw = wdir(A);
    for (const [a, b] of segs) {
      if (b - a < 0.3) continue;
      // FRONT: projection along A (out of the face), running the segment along P. Its Z
      // is X x up; start it at whichever end that points away from.
      const zF = new THREE.Vector3().crossVectors(Aw, upV);
      const fromA = zF.dot(Pw) > 0;                                            // Z runs +ds
      piece(A, [D / 2, fromA ? a : b], b - a, [true, true]);
      // RETURNS: projection outward along -+P at each end, running from the front back
      // to the wall along -A. Mitred at the front end only; square where it meets the wall.
      for (const [end, sgn] of [[a, -1], [b, +1]]) {
        const xPlan = [P[0] * sgn, P[1] * sgn];
        const zR = new THREE.Vector3().crossVectors(wdir(xPlan), upV);
        const toWall = zR.dot(Aw) < 0;                                         // Z runs toward the wall
        piece(xPlan, [toWall ? D / 2 : -D / 2, end], D, toWall ? [true, false] : [false, true]);
      }
    }
  }
  if (kind === "base") {
    // Countertop: full length, minus any gap that breaks it (a slide-in range).
    const brk = gaps.filter((x) => x.counter === false).sort((u, v) => u.a - v.a);
    const tops = []; let t = -L / 2;
    for (const gp of brk) { if (gp.a > t) tops.push([t, gp.a]); t = Math.max(t, gp.b); }
    if (t < L / 2) tops.push([t, L / 2]);
    for (const [a, b] of tops) {
      if (b - a < 0.2) continue;
      // The stone stops at the sink: a farmhouse basin sets INTO the run, its own rim
      // making the surface over its width.
      const kLo = p.sinkAt - ((sinkHi - sinkLo) - FR) / 2;  // matched to the apron, centred
      const kHi = p.sinkAt + ((sinkHi - sinkLo) - FR) / 2;
      const pieces = sinkLo === null ? [[a, b]]
        : [[a, Math.min(b, kLo)], [Math.max(a, kHi), b]].filter(([u, v]) => v - u > 0.2);
      for (const [u, v] of pieces)
        { q = pl(0.05, (u + v) / 2, D + 0.12, (v - u) + 0.06); box(q[0], q[1], CT, q[2], q[3], 0.16, stone, 0.02); }
    }
    if (p.sinkAt !== undefined && !FARM) farmhouseSink(p.sinkAt, SKW);   // drop-in, set into the stone
  }
  return g;
}

// OPEN SHELVES on slim brass brackets — the "no upper cabinets" answer for a blank bay
// above a counter. Thin painted shelves, a small brass gallery rail on each to stop
// plates and books sliding, and brass angle brackets under the ends. Anchor (px,pz) =
// the WALL FACE at the run's centre (not the depth centre cabinet_run uses), and
// `faces` = the direction the shelves look into the room. `shelvesFt` are the TOP
// surfaces, bottom-up.
//
// An earlier version used 1-3/8" stock on four-course stepped corbels with a moulded
// plate rail over. It read chunky and farmhouse, so the stock is now 5/8", the corbels
// are gone, and the brass is what carries the detail.
function buildOpenShelves(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  // Millwork white for the boards; the same brass as the range surround's pot rail and
  // pot filler, so the metal reads as one material through the room.
  const mill = new THREE.MeshStandardMaterial({ color: 0xefece4, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.6 });
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  // World directions of the two plan axes, derived from `faces` rather than assumed:
  // V() maps plan (dx,dz) to world (-dx, ., -dz), and pl() puts da along A, ds along P.
  const UP = new THREE.Vector3(0, 1, 0);
  const dirDa = new THREE.Vector3(-A[0], 0, -A[1]).normalize();
  const dirDs = new THREE.Vector3(-P[0], 0, -P[1]).normalize();
  // A brass rod of length `len` centred at (da,ds,y), lying along one of those axes.
  const rod = (da, ds, y, len, r, dir) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, len * ft, 12), brass);
    const c = pl(da, ds, 0, 0);
    m.position.copy(V(c[0], c[1], y));
    m.quaternion.setFromUnitVectors(UP, dir);
    g.add(m); return m;
  };

  const L = p.lenFt ?? 2.6, D = p.depthFt ?? 0.70;
  const T = p.shelfTFt ?? 0.055;                        // 5/8" stock
  const shelves = p.shelvesFt ?? [4.45, 5.5, 6.55];
  const BE = p.bracketInsetFt ?? 0.16;                  // bracket centre in from each end
  const RH = p.railHFt ?? 0.21, RR = p.railRFt ?? 0.011; // gallery rail height / rod radius
  let q;

  // A slim brass angle bracket: a short leg flat against the wall, an arm under the
  // shelf. Square brass stock, ~5/8" — no corbel, nothing stepped.
  const bracket = (ds, y) => {
    const B = 0.05, W = 0.055, leg = 0.30, arm = D - 0.10, top = y - T;
    q = pl(B / 2, ds, B, W); box(q[0], q[1], top - leg / 2, q[2], q[3], leg, brass);          // wall leg
    q = pl(arm / 2 + 0.02, ds, arm, W); box(q[0], q[1], top - B / 2, q[2], q[3], B, brass);   // arm under the shelf
  };

  for (const y of shelves) {
    q = pl(D / 2, 0, D, L); box(q[0], q[1], y - T / 2, q[2], q[3], T, mill, 0.008);            // the shelf
    for (const s of [-1, 1]) bracket(s * (L / 2 - BE), y);
    // GALLERY RAIL: a brass rod along the front edge on two short posts, with a stub
    // return at each end so it reads as a gallery rather than a floating bar.
    for (const s of [-1, 1]) {
      const ds = s * (L / 2 - 0.06);
      rod(D - 0.05, ds, y + RH / 2, RH, RR, UP);                       // post
      rod(D - 0.10, ds, y + RH - RR, 0.12, RR, dirDa);                 // return, back toward the wall
    }
    rod(D - 0.05, 0, y + RH - RR, L - 0.12, RR, dirDs);                // the front rail
  }
  return g;
}

// Kitchen island: cabinetry on the working side, a stone top with a seating
// overhang on `faces`. Anchor (px,pz) = footprint centre; `lenFt` runs across
// the front, `depthFt` front-to-back.
function buildIsland(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const wood = woodMat(col(p.cabinet || "cabinet", 0xeae7df));
  const stone = new THREE.MeshStandardMaterial({ color: 0xdad7cf, roughness: 0.3 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.6 });
  const toeM = new THREE.MeshStandardMaterial({ color: 0x241b13, roughness: 0.8 });
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const UP = new THREE.Vector3(0, 1, 0);
  const dirDs = new THREE.Vector3(-P[0], 0, -P[1]).normalize();
  const L = p.lenFt ?? 5.0, D = p.depthFt ?? 3.0, OVER = p.overhangFt ?? 0.9;
  const TOE = 0.3, CT = 3.0, baseTop = 2.9;
  // The carcass is set BACK from the seating face by the overhang, so knees fit.
  const bodyD = D - OVER;
  let q;
  q = pl(-OVER / 2 - 0.12, 0, bodyD - 0.24, L - 0.04); box(q[0], q[1], TOE / 2, q[2], q[3], TOE, toeM);
  q = pl(-OVER / 2, 0, bodyD, L); box(q[0], q[1], TOE + (baseTop - TOE) / 2, q[2], q[3], baseTop - TOE, wood, 0.01);
  q = pl(0, 0, D + 0.12, L + 0.12); box(q[0], q[1], CT, q[2], q[3], 0.16, stone, 0.02);       // top, incl. overhang
  // Drawer fronts on the BACK (working) side, INSET in a face frame like the wall runs:
  // frame and fronts share one plane at the carcass face, with a brass bin pull on each.
  const n = Math.max(2, Math.round(L / 1.4));
  const FR = p.frameFt ?? 0.17, FTK = 0.04;
  const REV = p.revealFt ?? 0.055, SET = p.setbackFt ?? 0.04;
  const FACE = -OVER / 2 - bodyD / 2 + FTK / 2;          // centre plane of the FRAME
  // The island's fronts look the OTHER way along da, so the setback is +SET here.
  const DFACE = FACE + SET;                              // centre plane of the FRONTS
  const fy0 = TOE, fy1 = baseTop;
  for (const t of [0, 1]) {                                                    // rails
    q = pl(FACE, 0, FTK, L); box(q[0], q[1], t ? fy1 - FR / 2 : fy0 + FR / 2, q[2], q[3], FR, wood, 0.006);
  }
  for (let i = 0; i <= n; i++) {                                               // stiles
    const raw = -L / 2 + i * L / n;
    const sc = i === 0 ? raw + FR / 2 : i === n ? raw - FR / 2 : raw;
    q = pl(FACE, sc, FTK, FR); box(q[0], q[1], (fy0 + fy1) / 2, q[2], q[3], fy1 - fy0, wood, 0.006);
  }
  for (let i = 0; i < n; i++) {
    const a = -L / 2 + i * L / n, b = a + L / n;
    const oa = a + (i === 0 ? FR : FR / 2), ob = b - (i === n - 1 ? FR : FR / 2);
    const oc = (oa + ob) / 2, ow = ob - oa, oy = (fy0 + FR + fy1 - FR) / 2, oh = (fy1 - FR) - (fy0 + FR);
    q = pl(DFACE, oc, FTK, ow - 2 * REV);
    box(q[0], q[1], oy, q[2], q[3], oh - 2 * REV, wood, 0.01);                 // drawer front
    q = pl(DFACE + 0.012, oc, 0.02, ow - 0.30);
    box(q[0], q[1], oy, q[2], q[3], oh - 0.28, stone, 0.008);                  // recessed panel
    const len = Math.min(0.5, ow * 0.42);
    q = pl(FACE - 0.028, oc, 0.016, len + 0.07);
    box(q[0], q[1], oy, q[2], q[3], 0.17, brass, 0.02);                        // bin pull backplate
    const c2 = pl(FACE - 0.025, oc, 0, 0);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.075 * ft, 0.075 * ft, len * ft, 16), brass);
    m.position.copy(V(c2[0], c2[1], oy - 0.01));
    m.quaternion.setFromUnitVectors(UP, dirDs); g.add(m);
  }
  return g;
}

// A COUNTER STOOL for island seating. buildChair is a dining chair with its seat
// hardcoded at 0.47 m (18-1/2"), which against a 37" worktop leaves 19" of thigh
// room — unusable. This is the counter-height cousin: `seatFt` (25" by default,
// the standard rise for a 36-37" top) drives everything, so the same builder
// serves a bar-height top by changing one number.
// Front = +Z, matching buildChair — which in plan is SOUTH, so a stool facing
// into an island from the south side wants `rot: 180`.
function buildCounterStool(p) {
  const fab = fabricMat(col(p.material, 0xd9d2c4));
  const oak = woodMat(col(p.legMaterial || "lightoak", 0xb38f63));
  const g = new THREE.Group();
  const seatTop = (p.seatFt ?? 2.083) * FT;                 // 25" to the cushion top
  const sw = (p.seatWFt ?? 1.35) * FT, sd = (p.seatDFt ?? 1.25) * FT;
  const cush = 0.10, apronY = seatTop - cush - 0.05;
  // Apron: the rail the legs frame into, just under the cushion.
  const apron = new THREE.Mesh(new THREE.BoxGeometry(sw - 0.06, 0.07, sd - 0.06), oak);
  apron.position.set(0, apronY, 0); g.add(apron);
  // Legs: square stock tapering to the floor, splayed out at the foot. A stool this
  // tall needs the splay for stability, and more of it than a dining chair has.
  const legH = apronY - 0.035;
  const legGeo = new THREE.CylinderGeometry(0.028, 0.017, legH, 4);
  const corner = [];
  for (const ix of [-1, 1]) for (const iz of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(ix * (sw / 2 - 0.05), apronY - 0.035, iz * (sd / 2 - 0.05));
    const leg = new THREE.Mesh(legGeo, oak);
    leg.position.y = -legH / 2; leg.rotation.y = Math.PI / 4;
    pivot.add(leg);
    pivot.rotation.z = -ix * 0.085; pivot.rotation.x = iz * 0.085;
    g.add(pivot); corner.push(pivot);
  }
  // Stretchers: a rail between each pair of legs at footrest height, which is what
  // makes a tall stool read as a stool rather than as a chair on stilts.
  const strY = seatTop * 0.42, inset = 0.055;
  for (const iz of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, sw - 2 * inset, 8), oak);
    r.rotation.z = Math.PI / 2; r.position.set(0, strY, iz * (sd / 2 - inset)); g.add(r);
  }
  for (const ix of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, sd - 2 * inset, 8), oak);
    r.rotation.x = Math.PI / 2; r.position.set(ix * (sw / 2 - inset), strY, 0); g.add(r);
  }
  const seat = new THREE.Mesh(new RoundedBoxGeometry(sw, cush, sd, 3, 0.035), fab);
  seat.position.set(0, seatTop - cush / 2, 0); g.add(seat);
  // A LOW back — enough to lean on without standing above the worktop line, so the
  // stools do not read as a pair of chairbacks blocking the island.
  const backH = (p.backFt ?? 0.95) * FT;
  for (const ix of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.045, backH, 0.045), oak);
    st.position.set(ix * (sw / 2 - 0.05), seatTop + backH / 2 - 0.02, -(sd / 2 - 0.055));
    st.rotation.x = 0.07; g.add(st);                        // slight rake
  }
  const rail = new THREE.Mesh(new RoundedBoxGeometry(sw - 0.04, 0.17, 0.075, 4, 0.03), fab);
  rail.position.set(0, seatTop + backH - 0.09, -(sd / 2 - 0.02));
  rail.rotation.x = 0.07; g.add(rail);
  return g;
}

// A BENTWOOD CAFE CHAIR (Thonet No. 14). Almost all air: round steam-bent beech about
// an inch thick, a caned seat and nothing upholstered. The back hoop and BOTH REAR
// LEGS are a single continuous bend — that is how the chair is actually made, and
// drawing them as one tube is what stops it reading as a stick figure. Front = +Z
// (buildFurniture turns it to face the table).
function buildBentwoodChair(p) {
  const g = new THREE.Group();
  const beech = woodMat(col(p.material || "beech", 0x6f4a2c));
  const cane = new THREE.MeshStandardMaterial({ color: col(p.seat || "cane", 0xc9a870), roughness: 0.9 });
  const R = 0.014;                      // 1.1" round stock — the whole daintiness lever
  const SEAT = 0.45, SR = 0.21;         // seat height / radius — a No. 14 seat is 42 cm
  const tube = (pts, r = R) =>
    new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(
      pts.map(a => new THREE.Vector3(...a)), false, "catmullrom", 0.4), 64, r, 8, false), beech);

  // 1) The single bend. Rear legs rise from UNDER the seat (x +-0.135 at the floor,
  //    well inside the 0.21 seat radius), carry on past it and flare out into the
  //    crown. Legs planted outside the seat disc would leave nothing for the support
  //    ring to touch, which is exactly how the first pass went wrong.
  g.add(tube([
    [-0.135, 0, -0.185], [-0.125, 0.22, -0.175], [-0.118, SEAT, -0.168],
    [-0.135, 0.65, -0.200], [-0.115, 0.86, -0.245], [0, 0.89, -0.255],
    [0.115, 0.86, -0.245], [0.135, 0.65, -0.200], [0.118, SEAT, -0.168],
    [0.125, 0.22, -0.175], [0.135, 0, -0.185],
  ]));
  // 2) The inner curl inside the hoop — the No. 14's other signature bend.
  g.add(tube([
    [-0.126, SEAT + 0.06, -0.172], [-0.107, 0.700, -0.205], [-0.055, 0.778, -0.222],
    [0, 0.735, -0.226],
    [0.055, 0.778, -0.222], [0.107, 0.700, -0.205], [0.126, SEAT + 0.06, -0.172],
  ], R * 0.85));
  // 3) Seat: a bent rim with a caned panel dropped into it.
  const rim = new THREE.Mesh(new THREE.TorusGeometry(SR - R, R, 8, 40), beech);
  rim.rotation.x = Math.PI / 2; rim.position.y = SEAT - R; g.add(rim);
  const pan = new THREE.Mesh(new THREE.CylinderGeometry(SR - R, SR - R * 1.4, 0.012, 40), cane);
  pan.position.y = SEAT - R - 0.004; g.add(pan);
  // 4) Front legs: round stock tucked under the rim, splaying out to the floor.
  for (const ix of [-1, 1]) g.add(tube([
    [ix * 0.150, SEAT - R, 0.130], [ix * 0.163, 0.21, 0.144], [ix * 0.175, 0, 0.158],
  ], R * 0.92));
  // 5) The support ring under the seat, which is what ties the four legs together.
  //    Radius 0.207 puts it on the leg centrelines at this height (front legs pass
  //    0.205 from the axis there, rear legs 0.209) rather than floating inside them.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.207, R * 0.8, 8, 36), beech);
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.355; g.add(ring);
  return g;
}

// A BUILT-IN MUDROOM BENCH (front = the `faces` side): plinth, seat slab, a boarded
// back carrying a peg rail, a shelf over it, and a cheek closing each end. Sized off the
// real thing — seat at 18", pegs at 55", shelf at 70" — so it reads as joinery rather
// than a box against a wall.
function buildMudroomBench(p) {
  const ft = FT, g = new THREE.Group();
  const A = DIR[p.faces || "W"], P = [-A[1], A[0]];
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const box = (da, ds, y, dl, dw, hy, mat, rad = 0) => {
    const [opx, opz, sx, sz] = pl(da, ds, dl, dw);
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, y));
    m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const paint = new THREE.MeshStandardMaterial({ color: col(p.paint || "chalk", 0xf8f5ef), roughness: 0.6 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.6 });
  const fabric = fabricMat(col(p.cushion || "upholstery", 0x5a6b80));
  const welt = fabricMat(col(p.cushion || "upholstery", 0x5a6b80).multiplyScalar(0.82));
  const L = p.lenFt ?? 5.0, D = p.depthFt ?? 1.5;
  // SEAT is the FINISHED height — the top of the cushion, which is what you sit on.
  // The timber deck below it therefore sits a cushion-thickness lower, the way an
  // upholstered bench is actually built; a squab laid on an 18 in deck would put the
  // finished seat at nearly 21 in.
  const SEAT = p.seatFt ?? 1.55, CU = p.cushionFt ?? 0.20;
  const DECK = SEAT - CU;                              // timber seat the squab lies on
  const PL = 0.30, RAIL = p.railFt ?? 4.58, SHELF = p.shelfFt ?? 5.85;
  const bk = -D / 2;                                   // the wall plane, in front-offsets
  // End cheeks are OFF by default: they close the bench in at both ends and make a
  // 5 ft bench read as a booth. Everything sized `L - 2 * CH` (plinth, peg rail, the
  // peg span) then runs the full length on its own.
  const CH = p.cheeks ? 0.09 : 0;
  const TK = 0.06;                                     // carcase board (3/4 in ply)
  const CDECK = PL + TK;                               // cubby floor, laid on the plinth
  const UNDER = DECK - 0.12;                           // underside of the timber seat
  const RAILH = 0.12;                                  // front seat rail

  // --- carcase: what actually holds the seat up --------------------------------
  box(bk + (D - 0.16) / 2, 0, PL / 2, D - 0.16, L, PL, paint);                    // plinth, set back as a toe
  box(0, 0, CDECK - TK / 2, D, L, TK, paint);                                     // cubby floor on the plinth
  box(bk + 0.02, 0, (CDECK + UNDER) / 2, 0.04, L, UNDER - CDECK, paint);          // back panel behind the cubbies
  // Gables and dividers carry the seat and make the shoe cubbies. These are NOT the
  // cheek walls that were removed: those ran the full height to the shelf and closed
  // the bench in; these stop under the seat, so the bench stays open above it.
  const nC = Math.max(1, p.cubbies ?? 4);
  const bay = (L - (nC + 1) * TK) / nC;
  for (let i = 0; i <= nC; i++) {
    const ds = -L / 2 + TK / 2 + i * (bay + TK);
    box(0, ds, (CDECK + UNDER) / 2, D, TK, UNDER - CDECK, paint);
  }
  box(D / 2 - TK / 2, 0, UNDER - RAILH / 2, TK, L, RAILH, paint);                 // front seat rail, tying the tops

  box(0.02, 0, DECK - 0.06, D + 0.04, L, 0.12, paint, 0.015);                     // timber seat, nosed proud
  // --- squab: foam in a welted cover, not a slab ------------------------------
  const cw = L - 0.10, cd = D - 0.10;
  box(0.02, 0, DECK + CU / 2, cd, cw, CU, fabric, 0.055);                         // the cushion itself
  const WL = 0.035, WH = 0.05;                                                     // piped seam round the perimeter
  box(0.02 + cd / 2, 0, DECK + CU / 2, WL, cw, WH, welt);
  box(0.02 - cd / 2, 0, DECK + CU / 2, WL, cw, WH, welt);
  for (const sg of [-1, 1]) box(0.02, sg * cw / 2, DECK + CU / 2, cd, WL, WH, welt);

  box(bk + 0.03, 0, (DECK + SHELF) / 2, 0.06, L, SHELF - DECK, paint);            // boarded back
  const nB = Math.max(2, Math.round(L / 1.05));                                   // battens on the boarding
  for (let i = 0; i <= nB; i++) {
    const w = 0.09, ds = -L / 2 + (i * L) / nB + (i === 0 ? w / 2 : i === nB ? -w / 2 : 0);
    box(bk + 0.075, ds, (DECK + SHELF) / 2, 0.03, w, SHELF - DECK, paint);
  }
  box(bk + 0.10, 0, RAIL, 0.09, L - 2 * CH, 0.34, paint);                          // peg rail
  box(bk + 0.35 / 2, 0, SHELF + 0.04, 0.35, L, 0.08, paint, 0.01);                 // shelf
  if (p.cheeks)
    for (const sg of [-1, 1]) box(0, sg * (L / 2 - CH / 2), (SHELF + 0.08) / 2, D, CH, SHELF + 0.08, paint);

  // Shaker pegs on the rail, angled out along the facing direction.
  const outward = new THREE.Vector3(-A[0], 0, -A[1]).normalize();
  const nH = p.hooks ?? 5, span = L - 2 * CH - 0.5;
  for (let i = 0; i < nH; i++) {
    const ds = -span / 2 + (span * i) / (nH - 1);
    let q = pl(bk + 0.22, ds, 0, 0);
    const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.026 * ft, 0.036 * ft, 0.30 * ft, 12), brass);
    peg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
    peg.position.copy(V(q[0], q[1], RAIL)); g.add(peg);
    q = pl(bk + 0.375, ds, 0, 0);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045 * ft, 12, 9), brass);
    knob.position.copy(V(q[0], q[1], RAIL)); g.add(knob);
  }
  return g;
}

// A RECESSED DOWNLIGHT: trim ring and lens flush with the ceiling, nothing below it.
// The housing is deliberately not modelled — it would sit above the ceiling slab where
// nothing can see it.
function buildRecessed(p) {
  const ft = FT, g = new THREE.Group();
  const CEIL = (p.ceilFt ?? 9.0) * ft, R = ((p.diaFt ?? 0.5) / 2) * ft;
  const trim = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.5 });
  const lens = new THREE.MeshStandardMaterial({ color: 0xfff6e4, emissive: 0xffe3ae,
    emissiveIntensity: 1.1, roughness: 0.4 });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.035 * ft, 24), trim);
  ring.position.y = CEIL - 0.018 * ft; g.add(ring);
  const l = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.8, R * 0.8, 0.02 * ft, 24), lens);
  l.position.y = CEIL - 0.042 * ft; g.add(l);
  // `reachFt` caps the light's range. A distance of 0 is three.js's "no cutoff": the
  // tail never reaches zero, so one can keeps lighting the next room. 12 ft clears a
  // floor 9 ft below with a pool around it.
  const light = new THREE.PointLight(0xfff0db, p.intensity ?? 1.5, (p.reachFt ?? 12) * ft, 2);
  light.position.y = CEIL - 0.12 * ft; g.add(light);
  g.userData.fixtures = [{ light, emissive: lens }];
  return g;
}

// A built-in CAFE BANQUETTE: a painted plinth and seat box carrying a buttoned
// leather squab, with a stile-and-rail panelled back board against the wall. Built
// the way one actually is — the box is joinery, the back is a panelled wall board,
// and only the two cushions are upholstery — so it reads as cabinetry with a seat
// on it rather than as a sofa pushed against a wall.
// Anchor (px,pz) = footprint centre (as for a cabinet run); `faces` = the room side.
// The back stops at 36" so it tucks under a window stool and its apron.
function buildBanquette(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const box = (da, ds, yc, dl, dw, hy, mat, rad = 0) => {
    const [opx, opz, sx, sz] = pl(da, ds, dl, dw);
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc));
    m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const paint = new THREE.MeshStandardMaterial({ color: col(p.joinery || "cabinet", 0xeae7df), roughness: 0.55 });
  const hide = new THREE.MeshStandardMaterial({ color: col(p.cushion || "leather", 0x8a6244), roughness: 0.55 });
  const stud = new THREE.MeshStandardMaterial({ color: hide.color.clone().multiplyScalar(0.62), roughness: 0.45 });

  const L = p.lenFt ?? 4.5, D = p.depthFt ?? 1.9;
  const PL = 0.29, DECK = 1.21, SEAT = 0.30;      // plinth / seat-deck / squab thickness
  const BACKH = p.backFt ?? 3.0;                  // 36" to the top of the back board
  const bk = -D / 2;                              // the wall plane, in front-offset terms

  box(bk + (D - 0.22) / 2, 0, PL / 2, D - 0.22, L - 0.12, PL, paint);         // plinth (toe kick)
  box(0, 0, (PL + DECK) / 2, D, L, DECK - PL, paint);                          // seat box
  box(D / 2 - 0.03, 0, DECK - 0.045, 0.10, L, 0.09, paint, 0.02);            // nosing over the box front

  // Back: a thin sheet on the wall with the frame standing proud of it, so the
  // panels are real recesses rather than lines drawn on a slab.
  const bh = BACKH - DECK, fda = bk + 0.095;
  box(bk + 0.025, 0, DECK + bh / 2, 0.05, L, bh, paint);                       // panel ground
  box(fda, 0, DECK + 0.15, 0.09, L, 0.30, paint);                              // bottom rail
  box(fda, 0, BACKH - 0.25, 0.09, L, 0.50, paint);                             // capping rail
  const nP = Math.max(2, Math.round(L / 1.6));
  for (let i = 0; i <= nP; i++) {
    const wd = (i === 0 || i === nP) ? 0.22 : 0.16;
    const ds = -L / 2 + (i * L) / nP + (i === 0 ? wd / 2 : i === nP ? -wd / 2 : 0);
    box(fda, ds, DECK + bh / 2, 0.09, wd, bh, paint);                          // stiles
  }

  const cd = D - 0.20;
  box(bk + 0.14 + cd / 2, 0, DECK + SEAT / 2, cd, L - 0.10, SEAT, hide, 0.06); // squab
  // The back cushion is loose, so it stops short of the capping rail and leaves a 6"
  // band of the painted back showing — without it the leather reads as one slab.
  const bcT = 0.34, bcTop = BACKH - 0.50;
  box(bk + 0.14 + bcT / 2, 0, (DECK + SEAT + bcTop) / 2, bcT, L - 0.10, bcTop - DECK - SEAT, hide, 0.09);

  // Buttoning: two staggered rows of sunk studs, which is what stops a leather back
  // cushion reading as a plain block.
  const nb = Math.max(2, Math.round(L / 0.9));
  for (let r = 0; r < 2; r++) {
    const y = DECK + SEAT + 0.26 + r * 0.38, cols = r === 0 ? nb : nb - 1;
    if (y > bcTop - 0.16) break;
    for (let i = 0; i < cols; i++) {
      const [opx, opz] = pl(bk + bcT + 0.12, -L / 2 + (L * (i + 1)) / (cols + 1), 0, 0);
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.035 * ft, 10, 8), stud);
      m.position.copy(V(opx, opz, y)); g.add(m);
    }
  }
  return g;
}

// Chimney-breast RANGE SURROUND, purely decorative: 1" reveal panels either side of
// the range and a moulded lintel over, with the hood liner concealed in the lintel's
// underside, a tiled back and a brass pot rail. It carries nothing, so the jambs are
// sheet stock rather than piers — which leaves the full flanking width to real
// cabinets, placed separately as their own cabinet_run entries.
// Anchor (px,pz) = footprint centre; `faces` = the room side. `widthFt` is how far the
// LINTEL spans (the whole composition, cabinets included); `openWFt` is the clear
// opening the range stands in; `jambTFt` is the reveal thickness.
function buildRangeSurround(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const wood = woodMat(col(p.cabinet || "cabinet", 0xeae7df));
  const stone = new THREE.MeshStandardMaterial({ color: 0xdad7cf, roughness: 0.3 });
  const tile = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.25 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08d3f, roughness: 0.3, metalness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.35, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26262a, roughness: 0.5 });
  const A = DIR[p.faces || "S"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const W = p.widthFt ?? 6.62, OW = p.openWFt ?? 3.04, D = p.depthFt ?? 1.4;
  const OH = p.openHFt ?? 5.6, LH = p.lintelHFt ?? 0.9, T = p.jambTFt ?? 1 / 12;
  // `backDepthFt` carries the breast BEHIND the recess back, out to the real wall. The
  // recess backs onto the hutch bump-out, but the breast can be wider than the bump-out,
  // and without this its ends would float in front of the wall either side of it.
  const SD = p.backDepthFt ?? 0;
  const BACK = -D / 2, FRONT = D / 2;
  const MD = D + SD, MDA = -SD / 2;      // mass depth, and the da that lands its back on the wall
  let q;
  // --- reveal panels forming the recess cheeks ----------------------------
  for (const side of [-1, 1]) {
    q = pl(MDA, side * (OW / 2 + T / 2), MD, T); box(q[0], q[1], OH / 2, q[2], q[3], OH, wood);
    q = pl(FRONT + 0.01, side * (OW / 2 + T / 2), 0.02, T + 0.02);        // eased front edge
    box(q[0], q[1], OH / 2, q[2], q[3], OH, wood);
  }
  // --- recess back: solid out to the wall, faced in tile ------------------
  if (SD > 0) { q = pl(BACK - SD / 2, 0, SD, OW); box(q[0], q[1], OH / 2, q[2], q[3], OH, wood); }
  q = pl(BACK + 0.03, 0, 0.04, OW); box(q[0], q[1], OH / 2, q[2], q[3], OH, tile);   // face sits proud of the bump-out, so no coplanar z-fight
  // Pot rail runs the FULL backsplash, end to end across the alcove.
  const railW = p.railWFt ?? (OW - 0.4), railY = p.railYFt ?? 3.9;
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * ft, 0.045 * ft, railW * ft, 14), brass);
  q = pl(BACK + 0.34, 0, 0, 0);
  rail.position.copy(V(q[0], q[1], railY)); rail.rotation.z = Math.PI / 2;
  rail.castShadow = true; g.add(rail);
  // Brackets at the ends plus enough between to keep any unsupported span <= 3 ft.
  const nBr = Math.max(2, Math.ceil(railW / 3) + 1);
  for (let i = 0; i < nBr; i++) {
    const ds = -railW / 2 + 0.12 + (railW - 0.24) * i / (nBr - 1);
    q = pl(BACK + 0.17, ds, 0.34, 0.07); box(q[0], q[1], railY, q[2], q[3], 0.07, brass);
  }
  // --- lintel, concealed hood liner, mantel shelf -------------------------
  q = pl(MDA, 0, MD, W); box(q[0], q[1], OH + LH / 2, q[2], q[3], LH, wood, 0.01);                     // lintel band
  q = pl(FRONT + 0.03, 0, 0.06, W - 0.1); box(q[0], q[1], OH + 0.1, q[2], q[3], 0.2, wood, 0.02);      // moulding at the head
  // VENT: recessed UP into the lintel, not hung below it. A dark pocket inside the
  // lintel band (which runs OH..OH+LH) with a slim grille flush at the recess ceiling,
  // so from the room it reads as a slot in the soffit rather than a visible box.
  const hoodW = p.hoodWFt ?? Math.min(OW - 0.7, 2.4);
  q = pl(BACK + 0.65, 0, 1.3, hoodW); box(q[0], q[1], OH + 0.19, q[2], q[3], 0.34, dark, 0.01);        // pocket, inside the lintel
  q = pl(BACK + 0.65, 0, 1.24, hoodW - 0.06); box(q[0], q[1], OH + 0.025, q[2], q[3], 0.05, steel);    // grille, flush with the head
  // POT FILLER: wall-mounted articulating filler on the backsplash, centred on the
  // opening (which is the range centre). Set ABOVE the pot rail so the two do not
  // collide on the same backsplash — see the note in the plan.
  if (p.potFiller) {
    // FOLDED (parked): both segments lie ALONG the backsplash rather than reaching out
    // over the burners, so the whole thing projects ~0.3' instead of ~1.5'.
    const py = p.potFillerYFt ?? 4.6, A1 = 1.05, A2 = 0.95;
    const along = (ds, len, da) => {                                    // a run parallel to the wall
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * ft, 0.05 * ft, len * ft, 12), brass);
      const w = pl(da, ds, 0, 0); m.position.copy(V(w[0], w[1], py));
      m.rotation.z = Math.PI / 2; m.castShadow = true; g.add(m); return m;
    };
    q = pl(BACK + 0.06, 0, 0.12, 0.42); box(q[0], q[1], py, q[2], q[3], 0.42, brass, 0.05);            // escutcheon
    along(A1 / 2, A1, BACK + 0.14);                                                                    // first segment, out along the wall
    q = pl(BACK + 0.20, A1, 0.14, 0.14); box(q[0], q[1], py, q[2], q[3], 0.14, brass, 0.03);            // elbow
    along(A1 - A2 / 2, A2, BACK + 0.27);                                                               // second segment, folded back
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * ft, 0.045 * ft, 0.4 * ft, 12), brass);
    q = pl(BACK + 0.27, A1 - A2, 0, 0); spout.position.copy(V(q[0], q[1], py - 0.2));
    spout.castShadow = true; g.add(spout);                                                             // down-spout at the folded end
    q = pl(BACK + 0.14, -0.24, 0.1, 0.1); box(q[0], q[1], py + 0.14, q[2], q[3], 0.26, brass, 0.03);    // valve handle
  }
  // Mantel projects FORWARD only — no side overhang. At W + 0.12 its ends reached past
  // the breast into the dining openings, below their 7' heads, clipping the casings.
  q = pl(0.06, 0, D + 0.12, W); box(q[0], q[1], OH + LH + 0.08, q[2], q[3], 0.16, stone, 0.02);        // mantel shelf
  // The breast carries on above the mantel to the ceiling, so the flue reads as a
  // chimney rather than stopping in mid-air, and finishes against it with a cornice.
  const CEIL = p.ceilFt ?? 9.0, b0 = OH + LH + 0.16;
  if (CEIL > b0 + 0.3) {
    q = pl(MDA, 0, MD, W); box(q[0], q[1], (b0 + CEIL) / 2, q[2], q[3], CEIL - b0, wood, 0.01);
    q = pl(MDA + 0.05, 0, MD + 0.1, W + 0.1); box(q[0], q[1], CEIL - 0.16, q[2], q[3], 0.32, wood, 0.02); // cornice
  }
  return g;
}


// A cased opening turned into a deep, panelled PORTAL. The wall THICKENS across the
// whole bay (floor to ceiling), the opening gets full-depth jamb + head linings with a
// recessed panel worked into each, and an architrave stands proud on the room face.
// Anchor (px,pz) = centre of the PROJECTING mass footprint; `faces` = the room the
// portal presents to. `depthFt` is that projecting mass alone; `revealDFt` is the FULL
// lining depth (front-aligned), running back THROUGH the existing wall to its far face,
// so the reveal reads as one continuous passage rather than two stacked thicknesses.
// `openOffFt` shifts the opening off the bay centre (the bays here are not symmetric).
function buildCasedPortal(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  // Same palette as the wall-finish trim program (src/wall-finish.js), so the portal
  // reads as part of the same millwork rather than a bolted-on object.
  const mill = new THREE.MeshStandardMaterial({ color: 0xefece4, roughness: 0.8 });
  const field = new THREE.MeshStandardMaterial({ color: 0xdcd7cb, roughness: 0.85 });
  const A = DIR[p.faces || "S"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const W = p.widthFt ?? 4.4, D = p.depthFt ?? 2.75;
  const RD = p.revealDFt ?? (D + 0.4583);         // full lining depth, front-aligned
  const OW = p.openWFt ?? 3.0, OH = p.openHFt ?? 7.0, OFF = p.openOffFt ?? 0;
  const CEIL = p.ceilFt ?? 9.0;
  const CW = p.caseWFt ?? 0.33, CT = p.caseTFt ?? 0.15;      // architrave width / projection
  const BB = p.baseFt ?? 10 / 12, BT = p.baseTFt ?? 0.09;    // baseboard height / projection
  // A slimmer projection than the 1.9" wall base (src/wall-finish.js): at full depth the
  // two returns pinched the 3' opening to 2'8" at the floor. 0.09' keeps 2'10" clear.
  const SW = p.stileFt ?? 0.25, PR = p.proudFt ?? 0.035;     // reveal panel frame
  const FRONT = D / 2, RBACK = FRONT - RD;        // reveal spans da [RBACK .. FRONT]
  const RDA = FRONT - RD / 2;                     // reveal centre along da
  const a0 = -W / 2, a1 = W / 2;                  // bay extent across (ds)
  const o0 = OFF - OW / 2, o1 = OFF + OW / 2;     // opening edges (ds)
  let q;
  // --- 1) piers flanking the opening, floor to ceiling --------------------
  for (const [s0, s1] of [[a0, o0], [o1, a1]]) {
    const w = s1 - s0; if (w < 1e-4) continue;
    q = pl(0, (s0 + s1) / 2, D, w); box(q[0], q[1], CEIL / 2, q[2], q[3], CEIL, mill);
  }
  // --- 2) mass over the opening, head to ceiling --------------------------
  q = pl(0, OFF, D, OW); box(q[0], q[1], (OH + CEIL) / 2, q[2], q[3], CEIL - OH, mill);
  // --- 3) panelled jamb reveals ------------------------------------------
  // A proud stile at each end of the reveal and a rail top and bottom, so the field
  // between them reads as a recessed panel. Frame projects PR into the opening; the
  // panel field sits just behind it in the slightly deeper field tone.
  for (const s of [-1, 1]) {
    const face = OFF + s * OW / 2;
    const at = (proud) => face - s * proud / 2;          // centre of a band `proud` thick
    q = pl(RDA, at(BT), RD, BT); box(q[0], q[1], BB / 2, q[2], q[3], BB, mill);            // baseboard through the reveal
    const y0 = BB, y1 = OH, dsF = at(PR);
    q = pl(FRONT - SW / 2, dsF, SW, PR); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, mill);  // stile at the room face
    q = pl(RBACK + SW / 2, dsF, SW, PR); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, mill);  // stile at the far face
    const rl = RD - 2 * SW;
    q = pl(RDA, dsF, rl, PR); box(q[0], q[1], y0 + SW / 2, q[2], q[3], SW, mill);          // bottom rail
    q = pl(RDA, dsF, rl, PR); box(q[0], q[1], y1 - SW / 2, q[2], q[3], SW, mill);          // top rail
    q = pl(RDA, at(PR * 0.25), rl, PR * 0.25);
    box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0 - 2 * SW, field);                   // recessed panel field
  }
  // --- 4) panelled soffit (head lining), same frame turned on its side -----
  {
    const at = (proud) => OH - proud / 2;
    q = pl(FRONT - SW / 2, OFF, SW, OW); box(q[0], q[1], at(PR), q[2], q[3], PR, mill);    // rail at the room face
    q = pl(RBACK + SW / 2, OFF, SW, OW); box(q[0], q[1], at(PR), q[2], q[3], PR, mill);    // rail at the far face
    const rl = RD - 2 * SW;
    for (const s of [-1, 1]) { q = pl(RDA, OFF + s * (OW / 2 - SW / 2), rl, SW);
      box(q[0], q[1], at(PR), q[2], q[3], PR, mill); }                                     // stiles down the sides
    q = pl(RDA, OFF, rl, OW - 2 * SW);
    box(q[0], q[1], at(PR * 0.25), q[2], q[3], PR * 0.25, field);                          // recessed panel field
  }
  // --- 5) architrave on the room face -------------------------------------
  const legH = OH + CW;
  for (const s of [-1, 1]) { q = pl(FRONT + CT / 2, OFF + s * (OW / 2 + CW / 2), CT, CW);
    box(q[0], q[1], legH / 2, q[2], q[3], legH, mill, 0.01); }                             // legs
  q = pl(FRONT + CT / 2, OFF, CT, OW); box(q[0], q[1], OH + CW / 2, q[2], q[3], CW, mill, 0.01);  // head band
  q = pl(FRONT + (CT + 0.05) / 2, OFF, CT + 0.05, OW + 2 * CW + 0.1);
  box(q[0], q[1], legH + 0.05, q[2], q[3], 0.1, mill, 0.02);                               // cap mould over the head
  // --- 6) cornice, matching buildRangeSurround's so the two run continuously.
  // Its band is CEIL-0.16 +/- 0.16 and it oversails the breast front by 0.1' (`MDA + 0.05`
  // over a mass `MD + 0.1` deep) -- same numbers here, or the two cornices step at the
  // joint where the portal meets the breast.
  q = pl(0.05, 0, D + 0.1, W); box(q[0], q[1], CEIL - 0.16, q[2], q[3], 0.32, mill, 0.02);
  return g;
}

// A single appliance. `kind`: range | fridge | dishwasher | hood | washer | dryer.
// Anchor (px,pz) = footprint centre; `faces` = the side you stand on.
function buildAppliance(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (opx, opz, yc, sx, sz, hy, mat, rad = 0) => {
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft) : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat); m.position.copy(V(opx, opz, yc)); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const cylX = (opx, opz, yc, r, h, mat, axis) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, h * ft, 20), mat);
    m.position.copy(V(opx, opz, yc)); if (axis) m.rotation.x = Math.PI / 2; g.add(m); return m;
  };
  const steel = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.35, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26262a, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.1, metalness: 0.2 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const kind = p.kind || "range";
  let q;
  if (kind === "range") {
    // `topFt` is where the COOKTOP lands; the body is derived from it, so an
    // integrated range can sit flush with the counters either side of it (3.08)
    // instead of the 0.6" step a hardcoded body height left.
    const W = p.widthFt ?? 2.5, D = p.depthFt ?? 2.1, H = (p.topFt ?? 3.03) - 0.08;
    q = pl(0, 0, D, W); box(q[0], q[1], H / 2, q[2], q[3], H, steel, 0.02);                   // body
    q = pl(0.05, 0, D + 0.1, W + 0.04); box(q[0], q[1], H + 0.04, q[2], q[3], 0.08, dark, 0.02); // cooktop
    // Burner grates: `burners`/2 across the width in two rows front-to-back, so 4
    // gives the usual 2x2 and 6 gives 3x2. Width and depth are set INDEPENDENTLY —
    // one shared size capped at 0.62 left six burners covering barely 62% of a 36"
    // top, reading as small pads. Widths now butt edge to edge like a pro range.
    const cols = Math.max(1, Math.round((p.burners ?? 4) / 2));
    const gw = (W - 0.04) / cols, gd = 0.8;
    for (const t of [-1, 1]) for (let i = 0; i < cols; i++) {
      const ds = -W / 2 + 0.02 + gw * (i + 0.5);
      q = pl(t * 0.45, ds, gd, gw - 0.02); box(q[0], q[1], H + 0.11, q[2], q[3], 0.05, dark, 0.02);
    }
    // An INTEGRATED range has no backguard at all — nothing rises above the cooktop —
    // and carries its controls on a strip across the FRONT, one knob per burner.
    if (p.style === "integrated") {
      const nk = p.knobs ?? p.burners ?? 4;
      const sy = H - 0.30;                                                   // control strip centre
      q = pl(D / 2 + 0.02, 0, 0.04, W - 0.08); box(q[0], q[1], sy, q[2], q[3], 0.46, dark, 0.02);
      for (let i = 0; i < nk; i++) {
        const ds = -W / 2 + (W / nk) * (i + 0.5);
        const k = new THREE.Mesh(new THREE.CylinderGeometry(0.062 * ft, 0.072 * ft, 0.12 * ft, 14), chrome);
        const w2 = pl(D / 2 + 0.10, ds, 0, 0);
        k.position.copy(V(w2[0], w2[1], sy)); k.rotation.x = Math.PI / 2;
        k.castShadow = true; g.add(k);
      }
      q = pl(D / 2 + 0.02, 0, 0.04, W - 0.12); box(q[0], q[1], (H - 0.55) / 2 + 0.18, q[2], q[3], H - 0.9, glass, 0.02); // oven window
      q = pl(D / 2 + 0.07, 0, 0.06, W - 0.2); box(q[0], q[1], H - 0.68, q[2], q[3], 0.09, chrome);                       // handle
      return g;
    }
    // A FREESTANDING range (as opposed to a slide-in) is defined visually by its
    // raised backguard carrying the controls; it sits within the body footprint, so
    // the range can still stand flush against the wall behind it.
    if (p.style === "freestanding") {
      q = pl(-D / 2 + 0.06, 0, 0.12, W); box(q[0], q[1], H + 0.42, q[2], q[3], 0.72, steel, 0.02);
      // Panel + knobs face the COOK, on the backguard's room side (its front plane is
      // at da = -D/2 + 0.12). Putting them at -D/2 would bury them in the wall behind.
      q = pl(-D / 2 + 0.125, 0, 0.03, W - 0.3); box(q[0], q[1], H + 0.5, q[2], q[3], 0.34, dark, 0.02);
      for (const i of [-1, 1]) { q = pl(-D / 2 + 0.14, i * (W / 2 - 0.22), 0.05, 0.12);
        box(q[0], q[1], H + 0.5, q[2], q[3], 0.12, chrome); }
    }
    q = pl(D / 2 + 0.02, 0, 0.04, W - 0.12); box(q[0], q[1], H * 0.42, q[2], q[3], H * 0.5, glass, 0.02); // oven window
    q = pl(D / 2 + 0.07, 0, 0.06, W - 0.2); box(q[0], q[1], H * 0.72, q[2], q[3], 0.09, chrome);          // handle
    return g;
  }
  if (kind === "hood") {
    const W = p.widthFt ?? 2.8, D = p.depthFt ?? 1.9, y0 = p.bottomFt ?? 4.9, ceil = p.ceilFt ?? 9.0;
    if (!p.boxed) {
      q = pl(0, 0, D, W); box(q[0], q[1], y0 + 0.28, q[2], q[3], 0.56, steel, 0.03);          // canopy
      q = pl(0, 0, D * 0.55, W * 0.42); box(q[0], q[1], (y0 + 0.56 + ceil) / 2, q[2], q[3], ceil - y0 - 0.56, steel, 0.02); // chimney
      return g;
    }
    // BOXED hood: the working liner is stainless and everything above it is millwork —
    // a moulded shelf reading as a mantel, a plain box carried to the ceiling, a crown
    // where it meets it, and a corbel at each side of the liner.
    const mill = new THREE.MeshStandardMaterial({ color: 0xefece4, roughness: 0.8 });
    const LIN = p.linerFt ?? 0.34;                       // stainless canopy depth
    q = pl(0, 0, D, W); box(q[0], q[1], y0 + LIN / 2, q[2], q[3], LIN, steel, 0.02);   // capture area
    const shY = y0 + LIN;                                 // moulded shelf on the liner
    q = pl(0.03, 0, D + 0.14, W + 0.14); box(q[0], q[1], shY + 0.10, q[2], q[3], 0.20, mill, 0.03);
    q = pl(0.01, 0, D + 0.06, W + 0.06); box(q[0], q[1], shY + 0.24, q[2], q[3], 0.08, mill, 0.02);
    const bx0 = shY + 0.28, bx1 = ceil - 0.30;            // the box itself
    q = pl(-0.05, 0, D - 0.22, W - 0.14); box(q[0], q[1], (bx0 + bx1) / 2, q[2], q[3], bx1 - bx0, mill, 0.015);
    q = pl(-0.02, 0, D - 0.10, W - 0.02);                 // crown at the ceiling
    box(q[0], q[1], ceil - 0.19, q[2], q[3], 0.22, mill, 0.025);
    q = pl(-0.03, 0, D - 0.04, W + 0.04); box(q[0], q[1], ceil - 0.04, q[2], q[3], 0.08, mill, 0.02);
    for (const t of [-1, 1]) {                            // corbels flanking the liner
      q = pl(D / 2 - 0.18, t * (W / 2 - 0.08), 0.30, 0.14);
      box(q[0], q[1], shY - 0.13, q[2], q[3], 0.26, mill, 0.03);
    }
    return g;
  }
  if (kind === "fridge") {
    const W = p.widthFt ?? 3.0, D = p.depthFt ?? 2.5, H = p.heightFt ?? 6.0;
    q = pl(0, 0, D, W); box(q[0], q[1], H / 2, q[2], q[3], H, steel, 0.03);
    for (const s of [-1, 1]) {                                                                 // French doors + handles
      q = pl(D / 2 + 0.03, s * W / 4, 0.05, W / 2 - 0.06); box(q[0], q[1], H * 0.66, q[2], q[3], H * 0.62, steel, 0.02);
      q = pl(D / 2 + 0.09, s * 0.12, 0.06, 0.07); box(q[0], q[1], H * 0.66, q[2], q[3], 1.5, chrome);
    }
    q = pl(D / 2 + 0.03, 0, 0.05, W - 0.06); box(q[0], q[1], H * 0.17, q[2], q[3], H * 0.3, steel, 0.02);  // freezer drawer
    q = pl(D / 2 + 0.09, 0, 0.06, W - 0.5); box(q[0], q[1], H * 0.27, q[2], q[3], 0.07, chrome);
    return g;
  }
  if (kind === "microwave") {
    // A microwave DRAWER unit filling a base bay: the drawer itself is the top ~11",
    // with a plain panel below it, since a bay left part-empty reads as a hole.
    const W = p.widthFt ?? 2.0, D = p.depthFt ?? 2.0;
    const y0 = p.baseFt ?? 0.3, y1 = p.topFt ?? 2.73, MH = p.drawerHFt ?? 0.95;
    q = pl(0, 0, D, W); box(q[0], q[1], (y0 + y1) / 2, q[2], q[3], y1 - y0, steel, 0.02);
    const mc = y1 - MH / 2;
    q = pl(D / 2 + 0.03, 0, 0.05, W - 0.06); box(q[0], q[1], mc, q[2], q[3], MH - 0.06, dark, 0.02);   // drawer face
    q = pl(D / 2 + 0.08, 0, 0.06, W - 0.5); box(q[0], q[1], y1 - 0.14, q[2], q[3], 0.07, chrome);      // bar handle
    q = pl(D / 2 + 0.06, W / 2 - 0.22, 0.04, 0.3);
    box(q[0], q[1], mc - 0.1, q[2], q[3], 0.3, steel, 0.01);                                           // controls
    q = pl(D / 2 + 0.03, 0, 0.05, W - 0.06);
    box(q[0], q[1], (y0 + y1 - MH) / 2, q[2], q[3], y1 - MH - y0 - 0.05, steel, 0.02);                 // panel below
    return g;
  }
  if (kind === "washer" || kind === "dryer") {
    // Front loaders: body, control panel across the top, and a porthole. The door disc
    // is oriented off `faces` rather than assuming a wall axis, so a pair can sit on any
    // wall without the portholes ending up edge-on.
    const W = p.widthFt ?? 2.25, D = p.depthFt ?? 2.5, H = p.topFt ?? 3.0;
    const disc = (da, ds, yc, r, t, mat) => {
      const c = pl(da, ds, 0, 0);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r * ft, r * ft, t * ft, 28), mat);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(-A[0], 0, -A[1]).normalize());
      m.position.copy(V(c[0], c[1], yc)); m.castShadow = true; g.add(m); return m;
    };
    q = pl(0, 0, D, W);                      box(q[0], q[1], H / 2, q[2], q[3], H, steel, 0.02);
    q = pl(D / 2 + 0.02, 0, 0.05, W - 0.10); box(q[0], q[1], H - 0.24, q[2], q[3], 0.40, dark, 0.02);  // control panel
    disc(D / 2 + 0.03, 0, H * 0.42, W * 0.40, 0.07, steel);        // door ring
    disc(D / 2 + 0.07, 0, H * 0.42, W * 0.32, 0.05,
         kind === "dryer" ? dark : glass);                          // porthole (the dryer's reads solid)
    for (const sx of [-1, 1]) for (const sd of [-1, 1]) {           // levelling feet
      q = pl(sd * (D / 2 - 0.12), sx * (W / 2 - 0.12), 0.10, 0.10);
      box(q[0], q[1], 0.05, q[2], q[3], 0.10, dark);
    }
    return g;
  }
  if (kind === "dishwasher") {
    const W = p.widthFt ?? 2.0, D = p.depthFt ?? 2.0, H = 2.85;
    q = pl(0, 0, D, W); box(q[0], q[1], H / 2, q[2], q[3], H, steel, 0.02);
    q = pl(D / 2 + 0.06, 0, 0.06, W - 0.16); box(q[0], q[1], H - 0.28, q[2], q[3], 0.09, chrome);
    return g;
  }
  // washer / dryer: front-load pair with a round door
  const W = p.widthFt ?? 2.3, D = p.depthFt ?? 2.4, H = 3.0;
  q = pl(0, 0, D, W); box(q[0], q[1], H / 2, q[2], q[3], H, steel, 0.03);
  q = pl(D / 2 + 0.04, 0, 0.08, W - 0.3); box(q[0], q[1], H * 0.52, q[2], q[3], W - 0.3, dark, 0.06);   // door surround
  const dq = pl(D / 2 + 0.1, 0, 0.05, W - 0.6);
  box(dq[0], dq[1], H * 0.52, dq[2], dq[3], W - 0.6, glass, 0.08);                                        // porthole
  q = pl(D / 2 + 0.03, 0, 0.05, W - 0.2); box(q[0], q[1], H - 0.18, q[2], q[3], 0.22, dark, 0.02);       // control panel
  return g;
}

// ---------------------------------------------------------------- LIGHT FIXTURES
// Procedural, per CLAUDE.md — lighting is an interior-design element, never an IFC
// box proxy. Each builder hangs `userData.fixtures` on its group: the caller
// (buildFurniture -> main.js) wires those into the time-of-day lighting scenes, and
// uses their presence to suppress the viewer's generic per-room ceiling fixture.
const BRASS = () => new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.6 });
const GLOW = (c = 0xffdda0, i = 1.0) =>
  new THREE.MeshStandardMaterial({ color: 0xf9f4e8, emissive: c, emissiveIntensity: i, roughness: 0.45 });

// A hanging pendant: ceiling canopy, slim rod, spun cone shade with a brass rim.
function buildPendant(p) {
  const ft = FT, g = new THREE.Group();
  const brass = BRASS(), shade = GLOW(0xffe0a8, 0.9);
  shade.side = THREE.DoubleSide;
  const CEIL = (p.ceilFt ?? 9.0) * ft, BOT = (p.dropFt ?? 6.4) * ft, SH = (p.shadeFt ?? 1.15) * ft;
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.035, 20), brass);
  can.position.y = CEIL - 0.018; g.add(can);
  const rodTop = CEIL - 0.035, rodBot = BOT + SH * 0.60;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, Math.max(rodTop - rodBot, 0.02), 10), brass);
  rod.position.y = (rodTop + rodBot) / 2; g.add(rod);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(SH / 2, SH * 0.60, 28, 1, true), shade);
  cone.position.y = BOT + SH * 0.30; g.add(cone);                       // wide end down
  const rim = new THREE.Mesh(new THREE.TorusGeometry(SH / 2, 0.011, 8, 32), brass);
  rim.rotation.x = Math.PI / 2; rim.position.y = BOT; g.add(rim);
  const bulbMat = GLOW(0xffca73, 1.2);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), bulbMat);
  bulb.position.y = BOT + 0.07; g.add(bulb);
  // Hangs to ~6.4 ft over a table: 10 ft of reach lights the table and a ring of floor
  // around it, and stops there rather than washing the whole room. See buildRecessed.
  const light = new THREE.PointLight(0xfff0db, p.intensity ?? 3.2, (p.reachFt ?? 10) * ft, 2);
  light.position.y = BOT - 0.04; g.add(light);
  g.userData.fixtures = [{ light, emissive: shade }];
  return g;
}

// A wall sconce. Two styles, because three rooms share this builder and they do not want
// the same fixture:
//
//   "globe"     (default) backplate, brass arm out from the wall, opal globe. The bath
//               pair flanking a mirror and the powder room's shadow-casting lamp are both
//               this, and both are tuned — hence the default, so neither moves when the
//               other style is added.
//   "halfshade" a half-cone shade sitting DIRECTLY on the backplate, no arm. Projects
//               about 4 in against the globe's 12, which is the whole point of it.
//
// `faces` is the room side it looks into, so the fixture is laid along that direction
// rather than assuming a wall axis.
function buildSconce(p) {
  const ft = FT, g = new THREE.Group();
  const A = DIR[p.faces || "S"], P = [-A[1], A[0]];
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const at = (da, ds, y) => { const q = fplace(A, P, da, ds, 0, 0); return V(q[0], q[1], y); };
  const brass = BRASS(), opal = GLOW(0xffdda0, p.glow ?? 1.1);
  const Y = p.atFt ?? 5.5, ARM = p.armFt ?? 0.46, R = (p.globeFt ?? 0.52) / 2;
  const half = (p.style || "globe") === "halfshade";
  const PW = p.plateFt ?? (half ? 0.40 : 0.46);
  const PH = p.plateHFt ?? (half ? 0.95 : 0.62);           // slim it down to flank a mirror
  const outward = new THREE.Vector3(-A[0], 0, -A[1]).normalize();       // plan A -> world
  // The half-cone is swept about `outward`, so its flat chord lies in the wall plane
  // whichever wall it is on — the same reason the globe's arm is aimed rather than built
  // along a world axis.
  const face = Math.atan2(outward.x, outward.z);
  const PD = half ? 0.06 : 0.10;                           // how far the backplate stands off
  const [opx, opz, sx, sz] = fplace(A, P, PD / 2, 0, PD, PW);
  const plate = new THREE.Mesh(new RoundedBoxGeometry(sx * ft, PH * ft, sz * ft, 3, 0.03), brass);
  plate.position.copy(V(opx, opz, Y)); g.add(plate);                    // backplate
  let opal2 = opal;
  if (half) {
    // Open top and bottom so it washes the wall both ways, and DoubleSide because it hangs
    // ABOVE eye level: single-sided, you look up into it and see straight through to the
    // wall. The shade is the emissive the lighting scenes drive, so it is what gets handed
    // to userData.fixtures below.
    const SR = p.shadeFt ?? 0.30, ST = p.shadeTopFt ?? 0.22, SH = p.shadeHFt ?? 0.58;
    opal2 = GLOW(0xffdda0, p.glow ?? 1.1);
    opal2.side = THREE.DoubleSide;
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(ST * ft, SR * ft, SH * ft, 16, 1, true, -Math.PI / 2, Math.PI), opal2);
    shade.rotation.y = face;
    shade.position.copy(at(PD, 0, Y)); g.add(shade);
    const cap = new THREE.Mesh(                                          // brass top, so it
      new THREE.CylinderGeometry(ST * ft, ST * ft, 0.03 * ft, 16, 1, false, -Math.PI / 2, Math.PI), brass);
    cap.rotation.y = face;                                               // reads as a shade
    cap.position.copy(at(PD, 0, Y + SH / 2)); g.add(cap);                // and not a cone
  } else {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, ARM * ft, 10), brass);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
    arm.position.copy(at(0.10 + ARM / 2, 0, Y)); g.add(arm);
    const globe = new THREE.Mesh(new THREE.SphereGeometry(R * ft, 20, 14), opal);
    globe.position.copy(at(0.10 + ARM + R * 0.7, 0, Y)); g.add(globe);
  }
  // 8 ft, which is what the bath pair was tuned to by eye: a fixture sitting 3 in off a
  // wall washes the whole room from one small globe if you let its tail run. See buildRecessed.
  const light = new THREE.PointLight(0xffe7c0, p.intensity ?? 1.5, (p.reachFt ?? 8) * ft, 2);
  light.position.copy(at(half ? PD + 0.15 : 0.10 + ARM + R * 0.7, 0, Y)); g.add(light);
  // OPT-IN SHADOW CASTING, for the one lamp that needs it. Punctual lights in three are
  // not occluded by geometry, so a lamp lights everything in range THROUGH whatever is in
  // the way; `reachFt` is this project's only containment and it is a range cap, not a
  // wall. That is fine everywhere but the under-stair powder room, whose lamp sits about a
  // foot from a door leaf in a room 3 ft 2 in wide — no range that lights the room fails
  // to cross the wall, so it read straight into the foyer with the door shut.
  if (p.castShadow) {
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
    // The DEFAULT near plane is 0.5 m and would clip BOTH occluders that matter here —
    // the leaf at ~0.31 m and this fixture's own wall at ~0.23 m — so the cube would
    // record neither and the leak would survive looking exactly like "it didn't work".
    light.shadow.camera.near = 0.05;
    // shadow.camera.far is NOT ours to set: WebGLShadowMap.render overwrites it with
    // light.distance on every bake. `reachFt` IS the far plane.
    light.shadow.bias = -0.002;      // normalised depth; the sun's -0.0004 is the precedent
    light.shadow.normalBias = 0.02;  // metres, well under the 52 mm drywall it has to not leak through
    // Baked on demand like the sun (lighting.js), never per frame. It must start dirty:
    // a first lit frame with no map still reports one shadow to the shader and binds an
    // empty cube. Re-baked when a door settles — see buildFurniture's ease loop.
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = true;
    // THE FIXTURE MUST NOT OCCLUDE ITSELF. The light is at the globe's centre and main.js
    // makes every opaque mesh a caster, so without this the globe encloses the lamp and
    // the room goes black; the arm, 55 mm away, would blot out a quarter of the sphere.
    // Walked rather than named: the half-shade branch has no `arm` or `globe`, and a
    // ReferenceError here would take out the ONE shadow-casting lamp in the house.
    g.traverse((m) => { if (m.isMesh) m.userData.noShadow = true; });
  }
  g.userData.fixtures = [{ light, emissive: opal2 }];
  return g;
}

// A BUILT-IN HOT TUB, set into a well in the rear deck. The deck slabs around it and
// the coping-level surround it sits in are IFC (add_deck punches the hole); this is the
// vessel that drops into that hole, which is a fixture and so has to be a procedural
// mesh — CLAUDE.md's furniture rule — not an IFC box proxy.
//
// Heights come from the well it fills, in feet above GRADE (the exterior manifest's
// datum is grade, not a floor): `rimFt` is the surround, one riser below the deck, and
// `deckFt` the deck itself. The tub is dug from there — a spa is ~3 ft of water, so on
// a 30 in deck the shell floor lands below grade, which is what a built-in spa does.
//
// Built as a basin rather than a block: four shell walls and a floor, so looking in you
// see a hollow with water in it. One solid rounded box with a water plane laid on top
// reads as a puddle on a plinth, which is what the first pass at the wall basin did.
function buildHotTub(p) {
  const ft = FT, g = new THREE.Group();
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const acrylic = new THREE.MeshStandardMaterial({ color: 0xeef2f1, roughness: 0.18, metalness: 0.05 });
  const water = new THREE.MeshStandardMaterial({ color: 0x3f7f86, roughness: 0.12, metalness: 0.1 });
  const coping = new THREE.MeshStandardMaterial({ color: col("limestone", 0xbfb6a6), roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.25, metalness: 0.8 });
  const box = (dx, dz, yc, sx, sz, hy, mat, rad = 0) => {
    if (sx <= 0.002 || sz <= 0.002 || hy <= 0.002) return null;
    const geo = rad > 0 ? new RoundedBoxGeometry(sx * ft, hy * ft, sz * ft, 3, rad * ft)
                        : new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(V(dx, dz, yc)); m.castShadow = true; m.receiveShadow = true;
    g.add(m); return m;
  };
  const W = p.wFt ?? 7.0, D = p.dFt ?? 7.0;
  // `rimFt` is the ENTRY SILL — the top of the coping you step over — and the deck is
  // flush with it. Everything else is dug from there: a spa is about 3 ft of water, so
  // on a 30 in deck the shell floor lands below grade, which is what a built-in does.
  const rim = p.rimFt ?? 2.5;
  const DEEP = p.depthFt ?? 3.0;                // water depth, sill to floor
  const CP = p.copingFt ?? 0.42, CT = 0.14;     // coping width and thickness
  const T = 0.18, floorY = rim - DEEP;          // shell thickness; floor sits below grade
  const shellTop = rim - CT;                    // the coping caps the shell, flush on top
  const iw = W - 2 * T, id = D - 2 * T;         // inside the shell
  box(0, 0, floorY - T / 2, W, D, T, acrylic);                       // shell floor
  for (const s of [-1, 1]) {
    box(s * (W - T) / 2, 0, (floorY + shellTop) / 2, T, D, shellTop - floorY, acrylic, 0.04);
    box(0, s * (D - T) / 2, (floorY + shellTop) / 2, iw, T, shellTop - floorY, acrylic, 0.04);
  }
  // The moulded seat: a bench right round the inside, which is most of what makes a spa
  // read as a spa rather than as a tank.
  const SEAT = p.seatFt ?? 1.15, seatY = rim - (p.seatDropFt ?? 1.45);
  for (const s of [-1, 1]) {
    box(s * (iw - SEAT) / 2, 0, (floorY + seatY) / 2, SEAT, id, seatY - floorY, acrylic, 0.05);
    box(0, s * (id - SEAT) / 2, (floorY + seatY) / 2, iw - 2 * SEAT, SEAT, seatY - floorY, acrylic, 0.05);
  }
  box(0, 0, rim - 0.40, iw - 0.03, id - 0.03, 0.06, water);          // water, 5 in below the rim
  // Coping: a stone band lapping the shell, out over the deck and back in over the water,
  // so the acrylic edge is never the thing you see. It sits BELOW the sill line rather
  // than on top of it — its top face IS the sill, level with the decking, so there is no
  // lip to catch a foot on the way in.
  for (const s of [-1, 1]) {
    box(s * (W + CP - 0.2) / 2, 0, rim - CT / 2, CP, D + CP * 2 - 0.4, CT, coping, 0.03);
    box(0, s * (D + CP - 0.2) / 2, rim - CT / 2, W - CP + 0.2, CP, CT, coping, 0.03);
  }
  // Jets in the seat backs, and a spill-over spout on the south wall.
  const nj = p.jets ?? 4;
  for (let i = 0; i < nj; i++) {
    const f = (i + 0.5) / nj;
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.055 * ft, 0.055 * ft, 0.05 * ft, 12), chrome);
      m.position.copy(V(s * (iw / 2 - 0.02), -id / 2 + id * f, seatY + 0.42));
      m.rotation.z = Math.PI / 2; g.add(m);
    }
  }
  return g;
}

// A SEMI-DROP CHANDELIER: a short stem rather than a chain, for a flat ceiling. Canopy,
// stem, a turned body, a ring of scrolled arms carrying candles, and a finial below.
//
// The arms are what make it read as a chandelier rather than a lamp on a stick, and they
// are swept along a BEZIER rather than assembled from cylinders: a real cast arm leaves
// the body going DOWN and OUT, flattens, and turns back UP to present the candle level —
// one curve, which a chain of straight segments cannot do without showing its joints.
// `ceilFt` is the canopy (at the ceiling), `dropFt` the bottom of the body; the candles
// sit above that, so the drop quoted in the room file is the lowest point of the fixture.
function buildChandelier(p) {
  const ft = FT, g = new THREE.Group();
  const brass = BRASS();
  const flameMat = GLOW(0xffca73, p.glow ?? 1.0);
  const waxMat = new THREE.MeshStandardMaterial({ color: 0xf3ebd9, roughness: 0.8 });
  const CEIL = (p.ceilFt ?? 9.5) * ft, BOT = (p.dropFt ?? 7.5) * ft;
  const N = p.armsN ?? 6, SPREAD = ((p.spreadFt ?? 2.1) / 2) * ft;   // candle ring radius
  const cyl = (r0, r1, h, y, mat, seg = 16) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), mat);
    m.position.y = y; m.castShadow = true; g.add(m); return m;
  };
  cyl(0.085, 0.085, 0.035, CEIL - 0.018, brass, 20);                  // canopy at the ceiling
  // The stem runs from the canopy to the TOP of the body. Everything below is derived
  // from BOT so the room file quotes one number and the parts arrange themselves.
  const bodyH = 0.26, bodyTop = BOT + 0.34 + bodyH;
  cyl(0.013, 0.013, Math.max(CEIL - 0.035 - bodyTop, 0.02), (CEIL - 0.035 + bodyTop) / 2, brass, 10);
  // THE BODY, a turned urn — a LatheGeometry silhouette, like the stair's balusters, not
  // a stack of cylinders. Profile is (radius, height) up from the bottom of the urn.
  const URN = [[0.06, 0], [0.13, 0.06], [0.17, 0.16], [0.15, 0.30], [0.09, 0.42],
               [0.07, 0.56], [0.10, 0.72], [0.08, 0.86], [0.05, 1.0]];
  const urn = new THREE.Mesh(new THREE.LatheGeometry(
    URN.map(([r, h]) => new THREE.Vector2(Math.max(0.004, r * 0.62), h * bodyH)), 20), brass);
  urn.position.y = BOT + 0.34; urn.castShadow = true; g.add(urn);
  // Finial under the urn — the thing that stops a chandelier looking cut off.
  const FIN = [[0.10, 0], [0.16, 0.12], [0.10, 0.30], [0.13, 0.46], [0.06, 0.72], [0.02, 1.0]];
  const fin = new THREE.Mesh(new THREE.LatheGeometry(
    FIN.map(([r, h]) => new THREE.Vector2(Math.max(0.004, r * 0.62), (1 - h) * 0.34)), 16), brass);
  fin.position.y = BOT; fin.castShadow = true; g.add(fin);
  const CANDLE = 0.13, CUP = BOT + 0.30;              // candle base height, on the arm ends
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    // Down and OUT of the body, then back up to the candle — one quadratic, so the arm
    // has the sagging S a cast arm has rather than an elbow.
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(dx * 0.035, BOT + 0.30, dz * 0.035),
      new THREE.Vector3(dx * SPREAD * 0.66, BOT + 0.05, dz * SPREAD * 0.66),
      new THREE.Vector3(dx * SPREAD, CUP, dz * SPREAD));
    const arm = new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.0125, 8, false), brass);
    arm.castShadow = true; g.add(arm);
    const put = (mesh, y) => { mesh.position.set(dx * SPREAD, y, dz * SPREAD);
                               mesh.castShadow = true; g.add(mesh); };
    put(new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.022, 0.03, 14), brass), CUP + 0.015); // bobeche
    put(new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.023, CANDLE, 12), waxMat), CUP + 0.03 + CANDLE / 2);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 10), flameMat);
    flame.position.set(dx * SPREAD, CUP + 0.03 + CANDLE + 0.022, dz * SPREAD); g.add(flame);
  }
  // Reach matches the generic semiFlush this replaces (main.js): a foyer 22 ft long is lit
  // from one fixture, so the tail has to run further than a pendant over a table.
  const light = new THREE.PointLight(0xfff0db, p.intensity ?? 3.0, (p.reachFt ?? 14) * ft, 2);
  light.position.y = CUP + 0.10; g.add(light);
  g.userData.fixtures = [{ light, emissive: flameMat }];
  return g;
}

// UNDER-CABINET task lighting: a shallow brass channel with a warm lens on the
// underside of a wall run, washing the worktop below. `gaps` uses the same offsets
// along the run as the cabinet_run it hides under, so it breaks at the hood and the
// window bays without the positions being restated.
function buildUnderCabinet(p) {
  const ft = FT, g = new THREE.Group();
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const box = (da, ds, y, dl, dw, hy, mat) => {
    const [opx, opz, sx, sz] = fplace(A, P, da, ds, dl, dw);
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft), mat);
    m.position.copy(V(opx, opz, y)); g.add(m); return m;
  };
  const brass = BRASS(), lens = GLOW(0xffd79a, 1.0);
  const L = p.lenFt ?? 8, D = p.depthFt ?? 1.1, Y = p.atFt ?? 4.5;
  const gaps = (p.gaps || []).map((q) => [Math.min(q.a, q.b), Math.max(q.a, q.b)]).sort((u, v) => u[0] - v[0]);
  const runs = []; let cur = -L / 2;
  for (const [a, b] of gaps) { if (a > cur) runs.push([cur, Math.min(a, L / 2)]); cur = Math.max(cur, b); }
  if (cur < L / 2) runs.push([cur, L / 2]);
  const fixtures = [];
  for (const [a, b] of runs) {
    const len = b - a - 0.25; if (len < 0.6) continue;                  // skip stubs
    const ds = (a + b) / 2;
    box(-D / 2 + 0.30, ds, Y - 0.055, 0.34, len, 0.055, brass);         // channel, set back from the face
    box(-D / 2 + 0.30, ds, Y - 0.075, 0.26, len - 0.10, 0.018, lens);   // lens
    const q = fplace(A, P, -D / 2 + 0.30, ds, 0, 0);
    // Already capped before the rest of the fixtures were — this only moves it onto the
    // same `reachFt` idiom. 8.5 ft is the 2.6 m it used to pass in raw world units, so
    // the strip looks exactly as it did.
    const light = new THREE.PointLight(0xffe3ae, p.intensity ?? 0.9, (p.reachFt ?? 8.5) * ft, 2);
    light.position.copy(V(q[0], q[1], Y - 0.16)); g.add(light);
    fixtures.push({ light, emissive: lens });
  }
  g.userData.fixtures = fixtures;
  return g;
}

// A SKYLIGHT over a flat ceiling under a sloping roof: a well from the ceiling
// opening up to the roof plane, glazed at the top. The scullery's shedhip springs
// from the ceiling line at the south eave and rises `pitch` per foot northward, so
// the well is a WEDGE — shallow at its south edge, deeper at its north. That is what
// a skylight in a sloped roof actually looks like, and it is why these sit a couple
// of feet off the south wall rather than literally over the windows.
function buildSkylight(p, ctx = {}) {
  const ft = FT, g = new THREE.Group();
  const W = (p.widthFt ?? 2.0) * ft, D = (p.depthFt ?? 2.5) * ft;
  const CEIL = (p.ceilFt ?? 9.0), PITCH = p.pitch ?? 0.45, DATUM = p.datumPz ?? -18.875;
  const roofY = (pz) => (CEIL + PITCH * (pz - DATUM)) * ft;
  const plaster = new THREE.MeshStandardMaterial({ color: 0xf6f3ec, roughness: 0.95, side: THREE.DoubleSide });
  // The glazing is emissive so it reads as bright sky rather than a grey panel — but
  // that has to FOLLOW THE SUN. Held at a constant 0.85 it went on glowing at midnight,
  // which is what made the skylight boxes look lit from inside at night. The viewer
  // scales it by the daylight factor (see `skylightGlass` below and onTime in main.js);
  // this is just the full-daylight value.
  const glass = new THREE.MeshStandardMaterial({ color: 0xeaf3fb, emissive: 0xdfeeff, emissiveIntensity: 0.85,
    roughness: 0.1, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  glass.userData.skyBase = 0.85;
  const quad = (a, b, c, d, mat) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, mat));
  };
  // local: +x is one side of the width, +z is SOUTH (world z = -pz)
  // The LINING starts at the ceiling's UNDERSIDE, not at the nominal ceiling height.
  // `CEIL` is measured from this item's origin, and placed furniture is lifted
  // FLOOR + 0.02 to keep it off the floor plane — so a lining drawn at CEIL * ft began
  // 20 mm ABOVE the top of the 60 mm ceiling slab, and looking up the well you saw
  // straight through that slot: the thin black line. Take the real ceiling from the
  // caller instead of trusting the nominal height, and drop 3 mm past the underside so
  // the joint cannot reopen if either datum shifts again.
  const SLAB = 0.06;                                   // ceilings.js slab thickness
  const originY = p.y != null ? p.y : (ctx.floorY ?? 0);
  const yC = ctx.ceilingY != null ? (ctx.ceilingY - SLAB - originY - 0.003) : CEIL * ft;
  // ...and set the lining 3 mm INSIDE the opening. Flush with the slab's cut edge the
  // two faces are coplanar and z-fight; inside it, the lining is simply what you see.
  const IN = 0.003;
  const x0 = -W / 2 + IN, x1 = W / 2 - IN, zS = D / 2 - IN, zN = -D / 2 + IN;
  const yS = roofY((p.pz ?? 0) - (p.depthFt ?? 2.5) / 2), yN = roofY((p.pz ?? 0) + (p.depthFt ?? 2.5) / 2);
  quad([x0, yC, zS], [x1, yC, zS], [x1, yS, zS], [x0, yS, zS], plaster);   // south jamb
  quad([x0, yC, zN], [x1, yC, zN], [x1, yN, zN], [x0, yN, zN], plaster);   // north jamb
  quad([x0, yC, zS], [x0, yC, zN], [x0, yN, zN], [x0, yS, zS], plaster);   // side jambs
  quad([x1, yC, zS], [x1, yC, zN], [x1, yN, zN], [x1, yS, zS], plaster);
  // Glazing spans the FULL opening, so it laps the lining's 3 mm inset and sits on it
  // the way real glazing sits on a curb.
  quad([-W / 2, yS, D / 2], [W / 2, yS, D / 2], [W / 2, yN, -D / 2], [-W / 2, yN, -D / 2], glass);
  // Sun down the well. This is DAYLIGHT, not a lamp, and the distinction is the whole
  // point: it is driven by the sun's own daylight factor (see onTime in main.js), so it
  // is full at noon and exactly zero at night. The version this replaces was a constant
  // — which is why the wells glowed at midnight and the scullery was lit by three
  // fixtures no switch controlled. Sitting just under the glazing, inside the wedge, it
  // lights all four faces of the lining and spills onto the floor below, which is what
  // a skylight does. Capped like the lamps (see buildRecessed): with no cutoff a
  // daylight shaft lights the whole floor; 16 ft fills the room under the well and
  // stops at its walls.
  const light = new THREE.PointLight(0xeaf2ff, p.intensity ?? 2.2, (p.reachFt ?? 16) * ft, 2);
  light.position.set(0, (yS + yN) / 2 - 0.06, 0);
  light.userData.sunBase = p.intensity ?? 2.2;
  light.intensity = 0;                // until the first onTime says otherwise
  g.add(light);
  // NOT registered as a fixture: the lamp scenes must not switch the sun off, and a
  // skylight that went dark when you hit the lights would be wrong at noon.
  g.userData.fixtures = [];
  g.userData.skylightGlass = glass;   // the viewer scales its emissive with the sun
  g.userData.skylightLight = light;   // ...and this with it
  return g;
}

// A wall-hung FULL-LENGTH mirror — the one you check yourself in on the way out.
// Built the way a real one is: a frame around a glass panel that sits BEHIND the
// frame face on a thin backing board, so the frame throws a shadow line onto the
// glass. A single flat plane on the wall reads as a sticker, not a mirror.
// `at` is the centre of its (thin) footprint and `faces` the way it looks into the
// room, same convention as the bench.
function buildWallMirror(p) {
  const ft = FT, g = new THREE.Group();
  const A = DIR[p.faces || "N"], P = [-A[1], A[0]];
  const V = (dx, dz, y) => new THREE.Vector3(-dx * ft, y * ft, -dz * ft);
  const pl = (da, ds, dl, dw) => fplace(A, P, da, ds, dl, dw);
  const box = (da, ds, y, dl, dw, hy, mat) => {
    const [opx, opz, sx, sz] = pl(da, ds, dl, dw);
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx * ft, hy * ft, sz * ft), mat);
    m.position.copy(V(opx, opz, y));
    m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const paint = new THREE.MeshStandardMaterial({ color: col(p.paint || "chalk", 0xf8f5ef), roughness: 0.6 });
  // NOT the vanity mirror's recipe (0xbfd0d6 / metalness 0.3 / roughness 0.05). There is
  // no environment map in this scene, so a dark low-roughness metal has nothing to
  // reflect and renders near-black: at vanity size, over a lit counter, that passes; at
  // 2 x 5.5 ft on a wall facing AWAY from the window it reads as a slate panel. A pale,
  // slightly rougher surface stands in for "reflecting an averagely-lit room", which is
  // what a mirror this size actually shows.
  const glass = new THREE.MeshStandardMaterial({ color: 0xe4ecef, roughness: 0.10, metalness: 0.0 });
  const W = p.widthFt ?? 2.2, H = p.heightFt ?? 5.5, B = p.bottomFt ?? 0.9;
  const FR = p.frameFt ?? 0.11, D = p.depthFt ?? 0.12;
  const cy = B + H / 2, bk = -D / 2;                   // bk = the wall plane, in front-offsets

  box(bk + 0.02, 0, cy, 0.04, W, H, paint);                          // backing board
  box(bk + 0.07, 0, cy, 0.03, W - 2 * FR, H - 2 * FR, glass);        // glass, set behind the face
  for (const sg of [-1, 1])                                          // stiles, full height
    box(bk + D / 2, sg * (W - FR) / 2, cy, D, FR, H, paint);
  for (const sg of [-1, 1])                                          // rails, between the stiles
    box(bk + D / 2, 0, cy + sg * (H - FR) / 2, D, W - 2 * FR, FR, paint);
  return g;
}

// A SMALL ORNAMENTAL STREET TREE: a trunk, a vase of limbs, and ONE canopy.
//
// The crown is a SINGLE solid of revolution — a `LatheGeometry` swept from a crown
// profile — rather than a cluster of foliage puffs. A puff cluster is the obvious way to
// draw a canopy and it reads as a bunch of separate bushes balanced on a stick; one bulb
// with a proper crown silhouette reads as a tree at every distance, and it is one mesh
// instead of nineteen.
//
// The profile is what does the work: it leaves the fork at nothing, flares fast, carries
// its widest point BELOW the middle and rounds over to a soft apex. Widest at the middle
// is a ball on a stick; widest at the top is a mushroom.
//
// Opaque, and the materials are MODULE-LEVEL and shared by all four trees, which is what
// lets consolidate.js merge them away — alpha-mapped foliage is the obvious way to draw
// leaves and the wrong one, since it refuses to merge transparents and the draw calls
// would then be permanent. Nothing here mutates a material in place (see CLAUDE.md on why
// our meshes are deliberately not grouped by material LOOK).
const TREE_BARK = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.92 });
const TREE_LEAF = new THREE.MeshStandardMaterial({ color: 0x5f7f47, roughness: 0.95 });
// A second, deeper and cooler green for the columnar form, so the west frontage reads as a
// different species from the north one and not just a different shape. Module-level and
// shared by all three, which is what lets consolidate.js collapse them.
const TREE_LEAF_DARK = new THREE.MeshStandardMaterial({ color: 0x3f5c40, roughness: 0.95 });
const _UP = new THREE.Vector3(0, 1, 0);
// (radius, height) up the crown, both as fractions of its spread and its own height.
const CROWN_PROFILE = [
  [0.00, 0.00], [0.40, 0.05], [0.68, 0.12], [0.86, 0.21], [0.96, 0.31],
  [1.00, 0.42], [0.98, 0.54], [0.92, 0.65], [0.80, 0.76], [0.60, 0.87],
  [0.34, 0.95], [0.00, 1.00],
];
// The COLUMNAR crown: a flame rather than a ball. Swelling fast off nothing, widest at 40%
// and drawn to a point — over a canopy two and a half times its own width that reads as a
// spire. The profile is the whole difference between the two forms; the sweep is the same.
const SPIRE_PROFILE = [
  [0.00, 0.00], [0.45, 0.05], [0.72, 0.12], [0.92, 0.25], [1.00, 0.40],
  [0.98, 0.55], [0.88, 0.70], [0.70, 0.82], [0.45, 0.92], [0.00, 1.00],
];

function buildStreetTree(p) {
  const ft = FT, g = new THREE.Group();
  const H = (p.heightFt ?? 16) * ft;              // overall height
  const S = (p.spreadFt ?? 12) * ft;              // crown spread
  // Deterministic per-tree variation, from the same one-liner the floor builders use so a
  // tree's growth is stable across reloads rather than sparkling. Mirrored pairs share a
  // seed, so the pair reads as matched.
  const seed = p.seed ?? 0;
  const rnd = (k) => hash(seed * 97.3 + k * 13.7 + 5.1);

  /** A tapering limb from `a` along `dir` for `len`, `r0` at the butt to `r1` at the tip. */
  const limb = (a, dir, len, r0, r1) => {
    const d = dir.clone().normalize();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 7), TREE_BARK);
    m.quaternion.setFromUnitVectors(_UP, d);
    m.position.copy(a).addScaledVector(d, len / 2);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return a.clone().addScaledVector(d, len);
  };

  // --- trunk: a root flare, then the shaft to the first fork. The caliper is DERIVED from
  // the tree's height (0.0072 of it, so 11 ft gives a 1.9 in stem and 16 ft a 2.8 in one) —
  // written absolutely it stayed a mature tree's trunk when the canopy came down to a
  // ten-year-old's. It tapers UPWARD: r0 is the butt and r1 the tip, and the first version
  // had those the wrong way round, so the trunk quietly grew fatter as it rose.
  const rBase = H * 0.0072, rFork = rBase * 0.72;
  const FORK = H * 0.28, FLARE = H * 0.022;
  limb(new THREE.Vector3(0, 0, 0), _UP, FLARE, rBase * 1.26, rBase);
  const fork = limb(new THREE.Vector3(0, FLARE, 0), _UP, FORK - FLARE, rBase, rFork);

  // --- COLUMNAR: foliage carried almost to the ground off a single stem, so there are no
  // limbs to draw — anything above the crown's underside is inside it and never seen. The
  // stem is what the eye reads below that, and it starts at 20% of the height rather than
  // the ornamental's 38%, which is what stops a spire reading as a lollipop.
  if ((p.form || "round") === "columnar") {
    const y0 = H * 0.20, CHc = H - y0, maxRc = S / 2;
    const spire = new THREE.Mesh(
      new THREE.LatheGeometry(SPIRE_PROFILE.map(([r, t]) => new THREE.Vector2(r * maxRc, t * CHc)), 24),
      TREE_LEAF_DARK);
    spire.position.y = y0;
    spire.scale.set(0.94 + rnd(30) * 0.12, 0.94 + rnd(31) * 0.14, 0.94 + rnd(32) * 0.12);
    spire.rotation.y = rnd(33) * Math.PI * 2;
    spire.castShadow = true; spire.receiveShadow = true;
    g.add(spire);
    return g;
  }

  // --- the limbs, splaying out of the fork and up into the canopy. They are short on
  // purpose: everything above the crown's underside is inside the bulb and would never be
  // seen, so a second order of branching is geometry nobody looks at.
  const N = 4, a0 = rnd(0) * Math.PI * 2;
  for (let i = 0; i < N; i++) {
    const az = a0 + (i / N) * Math.PI * 2 + (rnd(i + 1) - 0.5) * 0.5;
    const lean = 0.48 + rnd(i + 10) * 0.20;
    const dir = new THREE.Vector3(Math.sin(az) * Math.sin(lean), Math.cos(lean),
                                  Math.cos(az) * Math.sin(lean));
    limb(fork, dir, H * (0.24 + rnd(i + 20) * 0.06), rFork * 0.82, rFork * 0.42);
  }

  // --- THE CANOPY: one lathe, springing from the fork and carrying to the full height.
  const y0 = H * 0.38, CH = H - y0, maxR = S / 2;
  const crown = new THREE.Mesh(
    new THREE.LatheGeometry(CROWN_PROFILE.map(([r, t]) => new THREE.Vector2(r * maxR, t * CH)), 32),
    TREE_LEAF);
  crown.position.y = y0;
  // A touch of per-tree girth and a turn on it, so four trees off one profile are not four
  // copies of the same object.
  crown.scale.set(0.94 + rnd(30) * 0.14, 0.92 + rnd(31) * 0.18, 0.94 + rnd(32) * 0.14);
  crown.rotation.y = rnd(33) * Math.PI * 2;
  crown.castShadow = true; crown.receiveShadow = true;
  g.add(crown);
  return g;
}

const BUILDERS = { wall_basin: buildWallBasin, chandelier: buildChandelier, hot_tub: buildHotTub, mudroom_bench: buildMudroomBench, wall_mirror: buildWallMirror, recessed: buildRecessed, pendant: buildPendant, sconce: buildSconce, undercabinet: buildUnderCabinet, skylight: buildSkylight, street_tree: buildStreetTree,
  range_surround: buildRangeSurround, cased_portal: buildCasedPortal, cabinet_run: buildCabinetRun, open_shelves: buildOpenShelves, counter_stool: buildCounterStool, banquette: buildBanquette, island: buildIsland, appliance: buildAppliance, upholstered_dining_chair: buildChair, highback_chair: buildChair, bentwood_chair: buildBentwoodChair, round_pedestal_table: buildTable, rug: buildRug, builtin_hutch: buildBuiltinHutch, porch_pendant: buildPorchPendant, staircase: buildStaircase, stairwell2: buildStairwell2, bathroom: buildBathroom, window_bench: buildWindowBench, partition: buildPartition, bed: buildBed, nightstand: buildNightstand, closet_run: buildClosetRun, attic_partition: buildAtticPartition, kitchenette: buildKitchenette, toilet: buildToilet, wall_toilet: buildWallToilet, shower: buildShower, vanity: buildVanity, sofa: buildSofa, tv: buildTV, tub: buildTub };
// Re-export a few individual builders so the viewer can drop single procedural
// pieces (e.g. patio furniture on the alt roof deck) without going through the
// furniture.json manifest.
export { buildChair, buildRug, buildSofa };
const CHAIRS = new Set(["upholstered_dining_chair", "highback_chair", "bentwood_chair"]);
const SEAT_FRONT = 0.225;   // chair seat front is +0.225 m toward the table from its centre
const TUCK = 0.08;          // pushed-in: seat front this far under the table edge
const SIT = 0.22;           // pulled-out: this gap between seat front and table edge

export async function buildFurniture({ scene, parent = scene, floorY, ceilingY, baseUrl,
                                      manifestFile = "furniture.json",
                                      // called whenever this module MOVES something, so the viewer can
                                      // render on demand instead of drawing frames nobody asked for
                                      invalidate = () => {} }) {
  let data;
  try { data = await (await fetch(`${baseUrl}${manifestFile}`)).json(); } catch (e) { return { chairMeshes: [], doorMeshes: [], fixtures: [], ceilingOpenings: [] }; }
  const { ft = 0.3048, xs = -1, zs = 1, items = [] } = data || {};
  // plan (feet) -> three.js world: x = xs*px*ft, z = -(zs*pz*ft) (web-ifc maps IFC +Y -> -Z)
  const world = (px, pz) => [xs * px * ft, -(zs * pz * ft)];

  const doorEntries = [];   // { pivot, openAngle, current, open } — eased open/close
  const shadowLights = [];  // lamps with an on-demand shadow map, re-baked when a door settles
  const doorMeshes = [];    // hinged leaf meshes for raycast picking (userData.fdoor -> entry)
  const fixtures = [];      // { light, emissive, x, z } -> the viewer's lighting scenes
  const ceilingOpenings = [];  // skylight wells: the ceiling has to be cut for them
  const skylightGlass = [];    // skylight glazing materials: the viewer drives their emissive with the sun
  const skylightLights = [];   // ...and the daylight coming down each well, with the same factor
  // The skylight lining has to start at the REAL ceiling underside, not at its nominal
  // height above this item's origin — see buildSkylight.
  const ctx = { floorY, ceilingY };

  // Flat/static pieces first (rugs) so the table + chairs sit on top of them.
  for (const it of items) {
    if (it.type === "round_pedestal_table" || CHAIRS.has(it.type) || !BUILDERS[it.type]) continue;
    const [x, z] = world(it.px, it.pz);
    const obj = BUILDERS[it.type](it, ctx);
    obj.position.set(x, it.y != null ? it.y : floorY, z);   // per-item height (e.g. a hung pendant)
    obj.userData.item = it;                                 // debug handle: the manifest entry behind this group
    if (it.rot) obj.rotation.y = (it.rot * Math.PI) / 180;  // e.g. a built-in facing into the room
    parent.add(obj);
    if (obj.userData.fixtures) for (const f of obj.userData.fixtures) {
      fixtures.push({ ...f, x, z });
      if (f.light.castShadow) shadowLights.push(f.light);
    }
    if (it.type === "skylight") {
      const hw = ((it.widthFt ?? 2.0) * ft) / 2, hd = ((it.depthFt ?? 2.5) * ft) / 2;
      ceilingOpenings.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });
      if (obj.userData.skylightGlass) skylightGlass.push(obj.userData.skylightGlass);
      if (obj.userData.skylightLight) skylightLights.push(obj.userData.skylightLight);
    }
    if (obj.userData.doors) for (const d of obj.userData.doors) {  // collect hinged leaves (e.g. bathroom)
      doorEntries.push(d);
      d.pivot.traverse((m) => { if (m.isMesh && m.userData.fdoor) doorMeshes.push(m); });
    }
  }

  // Tables, so chairs can be positioned relative to their nearest table.
  const tables = [];
  for (const it of items) {
    if (it.type !== "round_pedestal_table") continue;
    const [x, z] = world(it.px, it.pz);
    const obj = buildTable(it); obj.position.set(x, floorY, z);
    obj.userData.item = it; scene.add(obj);
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
    root.userData.item = it;                       // debug handle / measurable from a harness
    scene.add(root);
    const entry = { root, inPos, outPos, current: inPos.clone(), out: false };
    entry.toggle = () => { entry.out = !entry.out; };
    chairs.push(entry);
    root.traverse((m) => { if (m.isMesh) { m.userData.chair = entry; chairMeshes.push(m); } });
  }

  // These two subtrees have LIVE transforms, so consolidate.js must leave them
  // alone — baking a chair's matrix would nail it to the table, and a door's
  // would freeze it at whatever angle it happened to be open.
  for (const c of chairs) c.root.userData.dynamic = true;
  for (const d of doorEntries) d.pivot.userData.dynamic = true;

  // Slide chairs between tucked-in and pulled-out, and swing doors open/closed
  // (both eased).
  (function animate() {
    for (const c of chairs) {
      const target = c.out ? c.outPos : c.inPos;
      if (c.current.distanceToSquared(target) > 1e-6) {
        c.current.lerp(target, 0.2);
        c.root.position.copy(c.current);
        invalidate();
      }
    }
    // A hinged leaf turns by `current`; a POCKET leaf (entry.slide) treats it as a fraction
    // of its travel — one ease, one toggle, both kinds.
    const applyDoor = (d) => {
      if (d.slide) d.pivot.position.copy(d.slide.from).addScaledVector(d.slide.axis, d.slide.dist * (d.current / d.openAngle));
      else d.pivot.rotation.y = d.current;
    };
    for (const d of doorEntries) {
      const target = d.open ? d.openAngle : 0;
      if (Math.abs(d.current - target) > 1e-3) {
        d.current += (target - d.current) * 0.2;
        applyDoor(d);
        d.settling = true;
        invalidate();
      } else if (d.settling) {
        // SETTLED. A swinging leaf is the only geometry that moves inside a lamp's reach,
        // so this is the one moment an on-demand shadow map goes stale. Re-baked here
        // rather than on every eased frame: a bake is ~6 x every visible caster (the scene
        // runs frustumCulled = false), which is not something to do 25 times a swing.
        // The `invalidate()` is load-bearing — the branch above does not run on the frame
        // the door settles, so without it the re-bake would wait for the 500 ms heartbeat.
        d.settling = false;
        d.current = target; applyDoor(d);
        for (const l of shadowLights) l.shadow.needsUpdate = true;
        invalidate();
      }
    }
    requestAnimationFrame(animate);
  })();

  // the stairwell floor void (world rect), so the ground floor can open its
  // ceiling over it (look up through the stair into the storey above).
  let stairwellOpening = null;
  const st = items.find((it) => it.type === "staircase" && it.opening);
  if (st) {
    const o = st.opening, [ax, az] = world(o.x1, o.z1), [bx, bz] = world(o.x2, o.z2);
    stairwellOpening = { minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minZ: Math.min(az, bz), maxZ: Math.max(az, bz) };
  }
  return { chairMeshes, stairwellOpening, doorMeshes, fixtures, ceilingOpenings, skylightGlass, skylightLights };
}
