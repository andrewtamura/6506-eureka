// Tile floors rendered as instanced mosaics (one draw call per pattern per room),
// like the hardwood floor. Which coverings are patterned tile — and which pattern
// — comes from tiles.json (emitted by the generator): the flat IFC tile covering
// is hidden and replaced by the mosaic.
//
// Each room's mosaic is CLIPPED to its covering box (the wall centerlines) with
// clipping planes, so it ends in a straight edge under door openings and meets
// the neighbouring floor cleanly at the threshold.
//
// Patterns:
//   - "basketweave": white marble bricks woven in pairs + charcoal dot junctions.
//   - "checkerboard": black/white 12" squares on the diagonal (diamonds, N-S).
//   - "hexagon": white hex honeycomb with a repeating charcoal accent (1-in-7).
import * as THREE from "three";

const FT = 0.3048;
const TH = 0.012;             // tile relief height (m)
const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5; return x - Math.floor(x); };

// --- basketweave (marble) ---
const U = (4 / 12) * FT;
const BG = 0.005;
const DOT = 0.26 * U;
const MARBLE = [0.90, 0.88, 0.83];
const DOTCOL = [0.16, 0.16, 0.18];
const MSHADE = [0.95, 1.0, 1.05, 0.98, 1.03, 0.92];

function basketweave(boxes, b) {
  const x1 = b.min.x, x2 = b.max.x, z1 = b.min.z, z2 = b.max.z;
  const ni = Math.ceil((x2 - x1) / U), nj = Math.ceil((z2 - z1) / U);
  for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
    const ox = x1 + i * U, oz = z1 + j * U;
    const sf = MSHADE[Math.floor(hash(i * 13.1 + j * 7.7) * MSHADE.length) % MSHADE.length];
    const rgb = [MARBLE[0] * sf, MARBLE[1] * sf, MARBLE[2] * sf];
    const slabs = ((i + j) & 1) === 0
      ? [[ox, ox + U, oz, oz + U / 2], [ox, ox + U, oz + U / 2, oz + U]]
      : [[ox, ox + U / 2, oz, oz + U], [ox + U / 2, ox + U, oz, oz + U]];
    for (const [sx0, sx1, sz0, sz1] of slabs)
      boxes.push({ cx: (sx0 + sx1) / 2, cz: (sz0 + sz1) / 2, w: sx1 - sx0 - 2 * BG, d: sz1 - sz0 - 2 * BG, y: TH / 2, h: TH, rot: 0, rgb });
  }
  for (let i = 0; i <= ni; i++) for (let j = 0; j <= nj; j++)
    boxes.push({ cx: x1 + i * U, cz: z1 + j * U, w: DOT, d: DOT, y: TH / 2 + 0.002, h: TH + 0.004, rot: 0, rgb: DOTCOL });
}

// --- black & white checkerboard on the diagonal (diamonds, points N-S) ---
const T = 1.0 * FT;
const CG = 0.006;
const R = Math.SQRT1_2;
const WHITE = [0.92, 0.91, 0.86];
const BLACK = [0.11, 0.11, 0.12];
const CSHADE = [0.93, 1.0, 1.07, 0.97, 1.04, 0.9];

function checkerboard(boxes, b) {
  const x1 = b.min.x, x2 = b.max.x, z1 = b.min.z, z2 = b.max.z;
  const toIJ = (x, z) => [(x * R + z * R) / T, (-x * R + z * R) / T];
  let imin = Infinity, imax = -Infinity, jmin = Infinity, jmax = -Infinity;
  for (const [x, z] of [[x1, z1], [x1, z2], [x2, z1], [x2, z2]]) {
    const [i, j] = toIJ(x, z);
    imin = Math.min(imin, i); imax = Math.max(imax, i);
    jmin = Math.min(jmin, j); jmax = Math.max(jmax, j);
  }
  const side = T - 2 * CG;
  for (let i = Math.floor(imin) - 1; i <= Math.ceil(imax) + 1; i++)
    for (let j = Math.floor(jmin) - 1; j <= Math.ceil(jmax) + 1; j++) {
      const cx = (i - j) * T * R, cz = (i + j) * T * R;   // global diagonal lattice
      const base = ((i + j) & 1) === 0 ? WHITE : BLACK;   // (clip planes trim the edges)
      const sf = CSHADE[Math.floor(hash(i * 19.7 + j * 5.3) * CSHADE.length) % CSHADE.length];
      boxes.push({ cx, cz, w: side, d: side, y: TH / 2, h: TH, rot: Math.PI / 4,
        rgb: [base[0] * sf, base[1] * sf, base[2] * sf] });
    }
}

// --- white hexagon mosaic with a REPEATING charcoal accent (baths / utility) ---
const HEX_FF = (2.5 / 12) * FT;
const HEXR = HEX_FF / Math.sqrt(3);
const HEX_COL = Math.sqrt(3) * HEXR;
const HEX_ROW = 1.5 * HEXR;
const HEXWHITE = [0.90, 0.89, 0.85];
const HEXBLACK = [0.11, 0.11, 0.12];

function hexagon(hexes, b) {
  const x1 = b.min.x, x2 = b.max.x, z1 = b.min.z, z2 = b.max.z;
  // Anchor the honeycomb to a GLOBAL grid (origin 0,0) so the pattern runs
  // continuously across adjacent rooms (the box clip trims each room's edge).
  const r0 = Math.floor(z1 / HEX_ROW) - 1, r1 = Math.ceil(z2 / HEX_ROW) + 1;
  for (let r = r0; r <= r1; r++) {
    const z = r * HEX_ROW, xoff = (r & 1) ? HEX_COL / 2 : 0;
    const c0 = Math.floor((x1 - xoff) / HEX_COL) - 1, c1 = Math.ceil((x2 - xoff) / HEX_COL) + 1;
    for (let c = c0; c <= c1; c++) {
      const x = xoff + c * HEX_COL;
      const q = c - Math.floor(r / 2);                       // axial column
      // a regular field accent: an isolated charcoal hex every 3rd row and 3rd
      // column (each surrounded by white) — evenly spaced, repeating, ~1-in-9.
      const accent = (((r % 3) + 3) % 3 === 0) && (((q % 3) + 3) % 3 === 0);
      const base = accent ? HEXBLACK : HEXWHITE;
      const sf = MSHADE[Math.floor(hash(c * 3.7 + r * 9.1) * MSHADE.length) % MSHADE.length];
      hexes.push({ cx: x, cz: z, rgb: [base[0] * sf, base[1] * sf, base[2] * sf] });
    }
  }
}

const PATTERNS = { basketweave, checkerboard };

// inward-facing clip planes at the covering box faces (= wall centerlines)
function clipPlanes(b) {
  const P = (nx, nz, px, pz) =>
    new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(nx, 0, nz), new THREE.Vector3(px, 0, pz));
  return [P(1, 0, b.min.x, 0), P(-1, 0, b.max.x, 0), P(0, 1, 0, b.min.z), P(0, -1, 0, b.max.z)];
}

export async function buildTileFloor({ scene, model, fragments, floorY, baseUrl }) {
  let manifest = [];
  try { manifest = await (await fetch(`${baseUrl}tiles.json`)).json(); } catch (e) { /* none */ }
  if (!manifest.length) return;

  const covs = Object.values(await model.getItemsOfCategories([/IFCCOVERING/])).flat();
  const cdata = await model.getItemsData(covs, { attributesDefault: true });
  const cboxes = await model.getBoxes(covs);
  const byName = new Map();
  covs.forEach((id, i) => byName.set(String(cdata[i]?.Name?.value ?? ""), { id, box: cboxes[i] }));
  const known = (p) => PATTERNS[p] || p === "hexagon";
  const floors = manifest.map((e) => ({ ...byName.get(e.name), pattern: e.pattern }))
    .filter((f) => f.box && known(f.pattern));
  if (!floors.length) return;

  await model.setVisible(floors.map((f) => f.id), false);   // hide the flat IFC tile covering
  await fragments.core.update(true);

  const fy = floorY + 0.02;
  const groutMat = new THREE.MeshLambertMaterial({ color: 0xbdb9ad });
  const col = new THREE.Color();

  for (const fl of floors) {
    const b = fl.box;
    const base = new THREE.Mesh(new THREE.PlaneGeometry(b.max.x - b.min.x, b.max.z - b.min.z), groutMat);
    base.rotation.x = -Math.PI / 2;
    base.position.set((b.min.x + b.max.x) / 2, fy - 0.003, (b.min.z + b.max.z) / 2);
    base.receiveShadow = true; scene.add(base);

    const planes = clipPlanes(b);
    if (fl.pattern === "hexagon") {
      const hexes = []; hexagon(hexes, b);
      const geo = new THREE.CylinderGeometry(HEXR * 0.92, HEXR * 0.92, TH, 6); // pointy-top hex prism
      const mat = new THREE.MeshLambertMaterial({ clippingPlanes: planes });
      const inst = new THREE.InstancedMesh(geo, mat, hexes.length);
      inst.receiveShadow = true;
      const m = new THREE.Matrix4();
      hexes.forEach((h, i) => {
        m.makeTranslation(h.cx, fy + TH / 2, h.cz); inst.setMatrixAt(i, m);
        inst.setColorAt(i, col.setRGB(h.rgb[0], h.rgb[1], h.rgb[2]));
      });
      inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      scene.add(inst);
    } else {
      const boxes = []; PATTERNS[fl.pattern](boxes, b);
      const mat = new THREE.MeshLambertMaterial({ clippingPlanes: planes });
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, boxes.length);
      inst.receiveShadow = true;
      const m = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
      const q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
      boxes.forEach((t, i) => {
        q.setFromAxisAngle(Y, t.rot || 0);
        m.compose(pos.set(t.cx, fy + t.y, t.cz), q, scl.set(t.w, t.h, t.d));
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, col.setRGB(t.rgb[0], t.rgb[1], t.rgb[2]));
      });
      inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      scene.add(inst);
    }
  }
}
