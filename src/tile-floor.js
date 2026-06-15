// Tile floors rendered as ONE THREE.InstancedMesh (every brick / square in every
// tiled room is a single draw call), like the hardwood floor. Which coverings are
// patterned tile — and which pattern — comes from tiles.json (emitted by the
// generator): the IFC's flat tile covering is hidden and replaced by the mosaic.
//
// Patterns:
//   - "basketweave": white marble bricks woven in alternating pairs, with a small
//     charcoal dot at each junction (the entry vestibules).
//   - "checkerboard": black-and-white 12" squares laid on the diagonal (diamonds,
//     points N-S), anchored to a global grid so it runs continuously across rooms.
// Tones are off-white + charcoal (not pure black/white) with subtle per-tile
// variation so it reads as real stone/ceramic.
import * as THREE from "three";

const FT = 0.3048;
const TH = 0.012;             // tile relief height (m)
const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5; return x - Math.floor(x); };

// --- basketweave (marble) ---
const U = (4 / 12) * FT;      // 4" basketweave unit cell (a 2"x4" brick pair)
const BG = 0.005;             // grout line (m)
const DOT = 0.26 * U;         // charcoal accent dot (~1")
const MARBLE = [0.90, 0.88, 0.83];
const DOTCOL = [0.16, 0.16, 0.18];
const MSHADE = [0.95, 1.0, 1.05, 0.98, 1.03, 0.92];

function basketweave(tiles, b, fy) {
  const x1 = b.min.x, x2 = b.max.x, z1 = b.min.z, z2 = b.max.z;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const ni = Math.ceil((x2 - x1) / U), nj = Math.ceil((z2 - z1) / U);
  for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
    const ox = x1 + i * U, oz = z1 + j * U;
    const sf = MSHADE[Math.floor(hash(i * 13.1 + j * 7.7) * MSHADE.length) % MSHADE.length];
    const rgb = [MARBLE[0] * sf, MARBLE[1] * sf, MARBLE[2] * sf];
    const slabs = ((i + j) & 1) === 0
      ? [[ox, ox + U, oz, oz + U / 2], [ox, ox + U, oz + U / 2, oz + U]]
      : [[ox, ox + U / 2, oz, oz + U], [ox + U / 2, ox + U, oz, oz + U]];
    for (const [sx0, sx1, sz0, sz1] of slabs) {
      const ax = clamp(sx0 + BG, x1, x2), bx = clamp(sx1 - BG, x1, x2);
      const az = clamp(sz0 + BG, z1, z2), bz = clamp(sz1 - BG, z1, z2);
      if (bx - ax > 0.01 && bz - az > 0.01)
        tiles.push({ cx: (ax + bx) / 2, cz: (az + bz) / 2, w: bx - ax, d: bz - az, y: fy + TH / 2, h: TH, rot: 0, rgb });
    }
  }
  for (let i = 0; i <= ni; i++) for (let j = 0; j <= nj; j++) {
    const cx = clamp(x1 + i * U, x1, x2), cz = clamp(z1 + j * U, z1, z2);
    const ax = clamp(cx - DOT / 2, x1, x2), bx = clamp(cx + DOT / 2, x1, x2);
    const az = clamp(cz - DOT / 2, z1, z2), bz = clamp(cz + DOT / 2, z1, z2);
    if (bx - ax > 0.006 && bz - az > 0.006)
      tiles.push({ cx: (ax + bx) / 2, cz: (az + bz) / 2, w: bx - ax, d: bz - az, y: fy + TH / 2 + 0.002, h: TH + 0.004, rot: 0, rgb: DOTCOL });
  }
}

// --- black & white checkerboard, laid on the diagonal (diamonds, points N-S) ---
const T = 1.0 * FT;           // 12" tiles
const CG = 0.006;             // grout inset
const R = Math.SQRT1_2;       // cos/sin 45°
const WHITE = [0.92, 0.91, 0.86];   // warm off-white (not pure white)
const BLACK = [0.11, 0.11, 0.12];   // charcoal (not pure black)
const CSHADE = [0.93, 1.0, 1.07, 0.97, 1.04, 0.9]; // subtle per-tile tone variation

function checkerboard(tiles, b, fy) {
  const x1 = b.min.x, x2 = b.max.x, z1 = b.min.z, z2 = b.max.z;
  // global diagonal lattice: centre(i,j) = ((i-j), (i+j)) * T * cos45 (anchored at
  // world origin so adjacent rooms line up). u = (1,1)/√2, v = (-1,1)/√2.
  const toIJ = (x, z) => [(x * R + z * R) / T, (-x * R + z * R) / T];
  let imin = Infinity, imax = -Infinity, jmin = Infinity, jmax = -Infinity;
  for (const [x, z] of [[x1, z1], [x1, z2], [x2, z1], [x2, z2]]) {
    const [i, j] = toIJ(x, z);
    imin = Math.min(imin, i); imax = Math.max(imax, i);
    jmin = Math.min(jmin, j); jmax = Math.max(jmax, j);
  }
  const side = T - 2 * CG;
  for (let i = Math.floor(imin) - 1; i <= Math.ceil(imax) + 1; i++) {
    for (let j = Math.floor(jmin) - 1; j <= Math.ceil(jmax) + 1; j++) {
      const cx = (i - j) * T * R, cz = (i + j) * T * R;
      if (cx < x1 || cx > x2 || cz < z1 || cz > z2) continue;   // centre must be in the room
      const base = ((i + j) & 1) === 0 ? WHITE : BLACK;
      const sf = CSHADE[Math.floor(hash(i * 19.7 + j * 5.3) * CSHADE.length) % CSHADE.length];
      tiles.push({ cx, cz, w: side, d: side, y: fy + TH / 2, h: TH, rot: Math.PI / 4,
        rgb: [base[0] * sf, base[1] * sf, base[2] * sf] });
    }
  }
}

const PATTERNS = { basketweave, checkerboard };

export async function buildTileFloor({ scene, model, fragments, floorY, baseUrl }) {
  let manifest = [];
  try { manifest = await (await fetch(`${baseUrl}tiles.json`)).json(); } catch (e) { /* none */ }
  if (!manifest.length) return;

  const covs = Object.values(await model.getItemsOfCategories([/IFCCOVERING/])).flat();
  const cdata = await model.getItemsData(covs, { attributesDefault: true });
  const cboxes = await model.getBoxes(covs);
  const byName = new Map();
  covs.forEach((id, i) => byName.set(String(cdata[i]?.Name?.value ?? ""), { id, box: cboxes[i] }));
  const floors = manifest.map((e) => ({ ...byName.get(e.name), pattern: e.pattern }))
    .filter((f) => f.box && PATTERNS[f.pattern]);
  if (!floors.length) return;

  await model.setVisible(floors.map((f) => f.id), false);   // hide the flat IFC tile covering
  await fragments.core.update(true);

  const fy = floorY + 0.02;
  const groutMat = new THREE.MeshLambertMaterial({ color: 0xbdb9ad });
  const tiles = [];
  for (const fl of floors) {
    const b = fl.box;
    const base = new THREE.Mesh(new THREE.PlaneGeometry(b.max.x - b.min.x, b.max.z - b.min.z), groutMat);
    base.rotation.x = -Math.PI / 2;
    base.position.set((b.min.x + b.max.x) / 2, fy - 0.003, (b.min.z + b.max.z) / 2);
    base.receiveShadow = true; scene.add(base);
    PATTERNS[fl.pattern](tiles, b, fy);
  }

  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({}), tiles.length);
  inst.receiveShadow = true;
  const m = new THREE.Matrix4(), col = new THREE.Color(), pos = new THREE.Vector3();
  const scl = new THREE.Vector3(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
  tiles.forEach((t, i) => {
    q.setFromAxisAngle(Y, t.rot || 0);
    m.compose(pos.set(t.cx, t.y, t.cz), q, scl.set(t.w, t.h, t.d));
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, col.setRGB(t.rgb[0], t.rgb[1], t.rgb[2]));
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  scene.add(inst);
}
