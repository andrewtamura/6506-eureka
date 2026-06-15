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
  rug: 0x9c6b5a, sage: 0x8a9a86, slate: 0x4a5568,
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

const BUILDERS = { upholstered_dining_chair: buildChair, highback_chair: buildChair, round_pedestal_table: buildTable, rug: buildRug };
const CHAIRS = new Set(["upholstered_dining_chair", "highback_chair"]);
const SEAT_FRONT = 0.225;   // chair seat front is +0.225 m toward the table from its centre
const TUCK = 0.08;          // pushed-in: seat front this far under the table edge
const SIT = 0.22;           // pulled-out: this gap between seat front and table edge

export async function buildFurniture({ scene, floorY, baseUrl }) {
  let data;
  try { data = await (await fetch(`${baseUrl}furniture.json`)).json(); } catch (e) { return { chairMeshes: [] }; }
  const { ft = 0.3048, xs = -1, zs = 1, items = [] } = data || {};
  // plan (feet) -> three.js world: x = xs*px*ft, z = -(zs*pz*ft) (web-ifc maps IFC +Y -> -Z)
  const world = (px, pz) => [xs * px * ft, -(zs * pz * ft)];

  // Flat/static pieces first (rugs) so the table + chairs sit on top of them.
  for (const it of items) {
    if (it.type === "round_pedestal_table" || CHAIRS.has(it.type) || !BUILDERS[it.type]) continue;
    const [x, z] = world(it.px, it.pz);
    const obj = BUILDERS[it.type](it);
    obj.position.set(x, floorY, z);
    scene.add(obj);
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
