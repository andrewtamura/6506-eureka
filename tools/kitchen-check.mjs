// Kitchen + scullery verification harness.
//
// Measures the BUILT MESHES in a headless viewer rather than trusting the manifest —
// every piece is found through `obj.userData.item`, and cabinet fronts are measured
// individually so alignment and reveals can be asserted rather than eyeballed.
//
//   npm run dev            # or any server on :5173
//   node tools/kitchen-check.mjs
//
// Lives in the repo deliberately: it has caught real faults (blocked doorways, a
// 5'7" door, a cornice colliding with a portal) and had to be rebuilt from scratch
// three times when it lived in a scratch directory.
//   npm run dev                                   # or any server on :5173
//   node tools/kitchen-check.mjs                  # measure + assert  (~4-5 min)
//   node tools/kitchen-check.mjs --from           # re-assert the cached measurement (instant)
//
// MEASURE and ASSERT are separate. Booting Chromium and loading the ground model is
// essentially the whole runtime; the ~110 assertions after it are arithmetic on a plain
// object. Half of all re-runs change no geometry at all — a threshold is being tuned, or
// a console.log added to find which mesh tripped a filter — so `--from` replays the last
// measurement and skips the browser entirely. Re-measure whenever the geometry moves;
// the staleness banner below says when that is.
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
const FT = 0.3048;

const argv = process.argv.slice(2);
const valOf = (k, d) => { const i = argv.indexOf(k); const v = argv[i + 1];
  return i >= 0 && v && !v.startsWith('--') ? v : d; };
const CACHE = valOf('--out', '.kitchen-check.json');
const FROM = argv.includes('--from') ? valOf('--from', CACHE) : null;

// What the measurement actually depends on: the manifests the viewer fetches and the
// builders that turn them into meshes. NOT this file — editing an assertion does not
// invalidate a measurement, which is the whole point of the split.
const inputs = () => {
  const out = [];
  for (const [dir, ext] of [['public', '.json'], ['src', '.js']]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(ext))
      out.push({ file: `${dir}/${f}`, mtimeMs: statSync(`${dir}/${f}`).mtimeMs });
  }
  return out;
};

async function measure() {
const b = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--no-sandbox', '--enable-unsafe-swiftshader', '--window-size=1200,800'], protocolTimeout: 900000 });
const page = await b.newPage(); await page.setViewport({ width: 1200, height: 800 });
page.on('pageerror', e => console.log(' [pageerror]', String(e).slice(0, 300)));
// `?solo=ground` skips the Second Floor and Attic exhibits and the duplicate alt lot,
// none of which this harness measures. Profiled: 400 s to measurable without it, 34 s
// with it (plus the prebuilt .frag files, which skip the in-browser IFC conversion).
await page.goto(process.env.CHECK_URL || 'http://localhost:5173/?solo=ground&norender=1', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 180; i++) {
  if (await page.evaluate(() => !!document.querySelector('#scenes .view-btn')
    && !!document.querySelector('#level-switcher [data-id="ground"]') && !!window.__eureka)) break;
  await new Promise(r => setTimeout(r, 2000));
}
await page.evaluate(() => window.__eureka.setHour(12));
// The swinging-leaf overlay is built when the ground level is selected, so the door
// checks find nothing without this.
await page.evaluate(() => document.querySelector('#level-switcher [data-id="ground"]').click());
for (let i = 0; i < 60; i++) {
  const n = await page.evaluate(() => (window.__eureka.doors || []).length).catch(() => 0);
  if (n > 0) break;
  await new Promise(r => setTimeout(r, 2000));
}
// Without `?solo` the Second Floor and Attic stream in behind a finished page (see
// CLAUDE.md), so the collector would run before their lights exist and a full-scope run
// would quietly cover LESS than the solo one while looking like it covered more. That
// already happened once: 60 lights collected, zero of them the attic's.
if (!(process.env.CHECK_URL || '').includes('solo=') && process.env.CHECK_URL) {
  // Await the real signal. Counting `exhibits` does NOT work: the exterior exhibit is
  // placed too, so "length >= 2" is already true with the ATTIC still streaming — which
  // is exactly how a full-scope run reported 60 lights and none of the attic's.
  console.log('awaiting exhibitsReady (the attic streams in last)...');
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!window.__eureka.exhibitsReady).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  await page.evaluate(() => window.__eureka.exhibitsReady);
  const ids = await page.evaluate(() => (window.__eureka.exhibits || []).map(e => e.lvl && e.lvl.id));
  console.log(`  exhibits placed: ${ids.join(', ')}`);
}
const raw = await page.evaluate(() => {
  const B3 = window.__eureka.modelViews[0].box.constructor;
  // src/consolidate.js adds one merged render mesh per material and hides the
  // authored parts it swallowed. The merged meshes are a RENDERING artifact, not
  // members of anything, so every count and every volume below has to skip them —
  // otherwise an 8-lite door leaf reports 10 members and a merged trim run reads
  // as a cornice. The hidden originals are still measured: Box3.expandByObject has
  // no visibility check, which is exactly why they are hidden rather than deleted.
  const isPart = (m) => m.isMesh && !(m.userData && m.userData.merged);
  const items = [], loose = [];
  window.__eureka.world.scene.three.traverse(o => {
    const it = o.userData && o.userData.item;
    if (!it) return;
    o.updateMatrixWorld(true);
    const bb = new B3().setFromObject(o); if (bb.isEmpty()) return;
    const parts = [];
    o.traverse(m => { if (!isPart(m)) return; const mb = new B3().setFromObject(m);
      parts.push([mb.min.x, mb.min.y, mb.min.z, mb.max.x, mb.max.y, mb.max.z]); });
    const mvols = [];   // filled alongside the volume pass below, one per mesh, in order
    // A rotated item's world AABB is not its size — a 1.5 ft square chair turned 45 deg
    // measures 2.1 ft on both axes. Take a bbox in the item's OWN frame as well, and the
    // solid volume of its geometry, which is the only honest way to say "dainty".
    const invM = o.matrixWorld.clone().invert(); const lb = new B3();
    let vol = 0;
    o.traverse(m => { if (!isPart(m)) return;
      const gm = m.geometry; gm.computeBoundingBox();
      lb.union(gm.boundingBox.clone().applyMatrix4(invM.clone().multiply(m.matrixWorld)));
      const pos = gm.getAttribute('position'); if (!pos || pos.count > 60000) return;
      const idx = gm.getIndex(), n = idx ? idx.count : pos.count;
      const g3 = (i) => { const j = idx ? idx.getX(i) : i; return [pos.getX(j), pos.getY(j), pos.getZ(j)]; };
      let mv = 0;
      for (let i = 0; i + 2 < n; i += 3) { const a = g3(i), b = g3(i + 1), c = g3(i + 2);
        mv += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
             + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; }
      vol += mv; mvols.push(Math.abs(mv)); });
    items.push({ type: it.type, kind: it.kind || '', px: it.px, pz: it.pz, floorY: o.position.y,
      lw: lb.max.x - lb.min.x, ld: lb.max.z - lb.min.z, vol: Math.abs(vol), mvols,
      min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z], parts,
      top: (() => { let best = null, area = -1;
        o.traverse(m => { if (!isPart(m)) return; const mb = new B3().setFromObject(m);
          const a = (mb.max.x - mb.min.x) * (mb.max.z - mb.min.z);
          if (a > area) { area = a; best = mb.max.y; } }); return best; })() });
  });
  // wall-finish meshes carry no userData.item
  window.__eureka.world.scene.three.traverse(o => {
    if (!isPart(o)) return;
    let p = o.parent, owned = false; while (p) { if (p.userData && p.userData.item) { owned = true; break; } p = p.parent; }
    if (owned) return;
    const mb = new B3().setFromObject(o); if (mb.isEmpty()) return;
    // Vertex count too. A bounding box cannot tell a swept MOULDING from a plain box —
    // both measure the same — and "is this actually a profile" is precisely what a
    // check on trim needs to answer. A BoxGeometry has 24; an extruded cove/ovolo
    // section has hundreds.
    const pos = o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('position');
    // SOLID VOLUME too, the same divergence sum the item loop uses. A bounding box and a
    // vertex count cannot tell a concave cove from a convex bullnose of the same size —
    // and getting that backwards is exactly what shipped once. Their sections differ by
    // 3.6x: a fillet is R^2(1 - pi/4), a quarter-disc is pi*R^2/4.
    // Defensive: SOME mesh in the scene trips this sum, and one odd geometry must not
    // take the whole measurement down. A zero volume is not silent — the cove assertions
    // divide by it and fail loudly — so swallowing the throw cannot hide a real problem.
    let lv = 0;
    try {
      if (pos && pos.count <= 60000) {
        const gm = o.geometry, idx = gm.getIndex(), n = idx ? idx.count : pos.count;
        const gx = (i) => { const j = idx ? idx.getX(i) : i; return [pos.getX(j), pos.getY(j), pos.getZ(j)]; };
        for (let i = 0; i + 2 < n; i += 3) {
          const a = gx(i), b = gx(i + 1), c = gx(i + 2);
          if (!a || !b || !c) break;
          lv += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
               + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
        }
      }
    } catch (e) { lv = 0; }
    loose.push([mb.min.x, mb.min.y, mb.min.z, mb.max.x, mb.max.y, mb.max.z, pos ? pos.count : 0,
                Math.abs(lv)]);
  });
  // LIGHTS. Global, not folded into the item loop above: semiFlush and the attic
  // downlights hang off no userData.item, and they are the ones that were uncapped.
  // `distance` 0 is three.js's "no cutoff" — only Point and Spot lights have the
  // property at all, so the Ambient/Hemisphere/Directional scene lights in
  // lighting.js are filtered out rather than counted as failures.
  const lights = [];
  window.__eureka.world.scene.three.traverse(o => {
    if (!o.isPointLight && !o.isSpotLight) return;
    o.updateMatrixWorld(true);
    let p = o.parent, owner = '';
    while (p) { if (p.userData && p.userData.item) { owner = p.userData.item.type; break; } p = p.parent; }
    const w = o.getWorldPosition(new o.position.constructor());
    lights.push({ kind: o.isSpotLight ? 'spot' : 'point', owner,
      lamp: (o.userData && o.userData.lamp) || '',
      intensity: o.intensity, distance: o.distance, decay: o.decay,
      x: w.x, y: w.y, z: w.z });
  });
  const doorLeaves = [];
  for (const d of window.__eureka.doors || []) {
    d.pivot.updateMatrixWorld(true);
    let zmin = 1e9, zmax = -1e9, xmin = 1e9, xmax = -1e9, n = 0;
    // Each member's own SECTION and its height up the leaf, measured in the leaf's own
    // frame (the pivot sits on the floor). A screen door has to be checked on where its
    // lines land and how thick they are, not on how many pieces it has.
    const members = [];
    const baseY = d.pivot.position.y;
    d.pivot.traverse(o => { if (!isPart(o)) return; n++;
      const gg = o.geometry; gg.computeBoundingBox();
      const bb = gg.boundingBox.clone(); bb.applyMatrix4(o.matrixWorld);
      zmin = Math.min(zmin, bb.min.z); zmax = Math.max(zmax, bb.max.z);
      xmin = Math.min(xmin, bb.min.x); xmax = Math.max(xmax, bb.max.x);
      const p = gg.parameters || {};
      members.push({ w: p.width ?? 0, h: p.height ?? 0,
                     yc: (bb.min.y + bb.max.y) / 2 - baseY }); });
    doorLeaves.push({ name: d.name, parts: n, zmin, zmax, xmin, xmax, members });
  }
  // PROCEDURAL door leaves (the powder room's, the attic bathroom's). Not IFC doors, so
  // they are absent from __eureka.doors, and they hang off a furniture item's group, so
  // their meshes are buried in that item's `parts` rather than in `loose`. Measured in
  // WORLD metres, closed and open: a leaf is only judged on where it actually sweeps.
  const fdoors = [];
  for (const m of window.__eureka.furnitureDoors || []) {
    const d = m.userData.fdoor; if (!d || fdoors.some(f => f.d === d)) continue;
    const at = (ang) => {
      const keep = d.pivot.rotation.y; d.pivot.rotation.y = ang;
      d.pivot.updateMatrixWorld(true);
      const bb = new B3(); d.pivot.traverse(o => { if (isPart(o)) bb.expandByObject(o); });
      d.pivot.rotation.y = keep; d.pivot.updateMatrixWorld(true);
      return [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z];
    };
    fdoors.push({ d, openAngle: d.openAngle, shut: at(0), open: at(d.openAngle),
                  hinge: [d.pivot.position.x, d.pivot.position.y, d.pivot.position.z] });
  }
  fdoors.forEach(f => delete f.d);

  // LOOKING UP FROM THE POWDER ROOM. The requirement — "the stair steps are not
  // visible" — is about what is OVERHEAD, and no bounding box can answer it: the
  // stringers are sloped planks whose boxes span the whole flight, so a box test says
  // they reach the floor. So this raycasts, which is the same question the eye asks.
  // Each object is shot SEPARATELY inside a try: some mesh in the wider scene throws
  // inside three's intersectObjects, and one bad object must not take the pass down.
  // Raycaster ignores `visible`, so consolidate.js's hidden originals are still hit;
  // its merged copies are skipped as duplicates of them.
  const overhead = [];
  {
    const T = window.THREE, FTm = 0.3048;
    const fy = (() => { let v = null; window.__eureka.world.scene.three.traverse(o => {
      const it = o.userData && o.userData.item; if (it && it.type === 'island') v = o.position.y; }); return v; })();
    const bay = new T.Box3(new T.Vector3(-15.4 * FTm, fy - 0.5, -0.2 * FTm),
                           new T.Vector3(-11.0 * FTm, fy + 11 * FTm, 8.0 * FTm));
    // THE STAIRCASE'S OWN MESHES, and nothing else. The question is whether any part of
    // the STAIR shows from below, so the basin, the mirror and the WC are not answers to
    // it — shot against everything, the first hit over the WC is the WC, at 0.2 ft.
    const targets = [];
    let stairGroup = null;
    window.__eureka.world.scene.three.traverse(o => {
      const it = o.userData && o.userData.item;
      if (it && it.type === 'staircase') stairGroup = o;
    });
    if (stairGroup) stairGroup.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || !isPart(o)) return;
      if (!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      let bb; try { bb = new B3().setFromObject(o); } catch (e) { return; }
      if (!bb.isEmpty() && bb.intersectsBox(bay)) targets.push(o);
    });
    const rc = new T.Raycaster(); const up = new T.Vector3(0, 1, 0);
    for (let px = 11.9; px <= 14.6; px += 0.3) for (let pz = -0.8; pz >= -7.2; pz -= 0.3) {
      rc.set(new T.Vector3(-px * FTm, fy + 0.06, -pz * FTm), up); rc.far = 12;
      let best = null, hit = null;
      for (const t of targets) {
        let h; try { h = rc.intersectObject(t, false); } catch (e) { continue; }
        for (const q of h) if (best == null || q.distance < best) { best = q.distance; hit = q.object; }
      }
      overhead.push({ px: +px.toFixed(2), pz: +pz.toFixed(2),
                      y: best == null ? null : (best + 0.06) / FTm,
                      soffit: !!(hit && hit.userData && hit.userData.soffit) });
    }
  }

  // The ceiling plane, so the skylight wells can be checked against the thing they
  // actually have to meet rather than against their own nominal height.
  const ceilingY = window.__eureka.modelViews[0].box.max.y;
  // SKYLIGHTS FOLLOW THE SUN. A skylight is daylight, not a lamp: its well light and
  // its glazing's emissive must both be zero at midnight and full at noon. Held
  // constant — which is how this started — the wells glowed at 2 a.m. Sampled by
  // actually moving the time dial, because that is the thing that was wrong.
  const skySample = () => {
    const lit = [], emis = [];
    window.__eureka.world.scene.three.traverse((o) => {
      if (!o.userData || !o.userData.item || o.userData.item.type !== 'skylight') return;
      o.traverse((c) => {
        if (c.isLight) lit.push(c.intensity);
        if (c.isMesh && c.material && c.material.transparent) emis.push(c.material.emissiveIntensity);
      });
    });
    return { lit, emis };
  };
  const hourWas = 12;
  window.__eureka.setHour(0);   const night = skySample();
  window.__eureka.setHour(12);  const noon = skySample();
  window.__eureka.setHour(hourWas);
  // ONE MODEL'S FIXTURES AT A TIME. Every visible light is evaluated in every fragment
  // shader, so this is a rendering constraint as much as a UI one — and the default
  // used to be "all of them", because registerFixture only dims a level some scene has
  // spoken for. Drive the real control and count what is actually lit per level.
  const litPerLevel = () => {
    const n = {};
    for (const f of window.__eureka.fixtures || [])
      if (f.light.visible && f.light.intensity > 0) n[f.level] = (n[f.level] || 0) + 1;
    return n;
  };
  const lighting = {};
  for (const pick of ["auto", "exterior", "ground", "off"]) {
    window.__eureka.selectLighting(pick);
    lighting[pick] = { lit: litPerLevel(), says: window.__eureka.litModel() };
  }
  window.__eureka.selectLighting("auto");
  return { items, loose, doorLeaves, fdoors, overhead, lights, ceilingY, sky: { night, noon }, lighting };
});
await b.close();
  return raw;
}

let raw;
if (FROM) {
  if (!existsSync(FROM)) { console.log(`no cached measurement at ${FROM} — run without --from first`); process.exit(2); }
  const cached = JSON.parse(readFileSync(FROM, 'utf8'));
  raw = cached.raw;
  const was = new Map((cached.inputs || []).map(i => [i.file, i.mtimeMs]));
  // Changed since the measurement, or new since it — either way the cache no longer
  // describes what the viewer would build now.
  const moved = inputs().filter(i => !was.has(i.file) || i.mtimeMs > was.get(i.file) + 1).map(i => i.file);
  console.log(`(cached measurement from ${cached.takenAt} — no browser, geometry NOT re-checked)`);
  if (moved.length) {
    const bar = '!'.repeat(78);
    console.log(`\n${bar}\n!! STALE: ${moved.length} input(s) changed since this measurement was taken:`);
    for (const f of moved.slice(0, 8)) console.log(`!!   ${f}`);
    if (moved.length > 8) console.log(`!!   ...and ${moved.length - 8} more`);
    console.log('!! Every result below describes the OLD geometry. Re-run without --from.');
    console.log(`${bar}\n`);
  }
} else {
  const stamp = inputs();                       // taken BEFORE measuring, so an edit
  raw = await measure();                        // made mid-run still reads as stale
  writeFileSync(CACHE, JSON.stringify({ takenAt: new Date().toISOString(), inputs: stamp, raw }));
  console.log(`(measurement cached to ${CACHE} — re-assert it with --from)`);
}
// NOTE: this rebuilds the object field by field, so anything added to the collector
// has to be carried across here too or it silently vanishes — `members` did.
raw.doorLeaves = (raw.doorLeaves || []).map(d => ({ name: d.name, parts: d.parts,
  pzLo: -d.zmax / FT, pzHi: -d.zmin / FT, pxLo: -d.xmax / FT, pxHi: -d.xmin / FT,
  members: d.members || [] }));

const R = (v, n = 4) => +v.toFixed(n);
const R2 = (v) => +v.toFixed(3);
let fail = 0; const A = (ok, m) => { if (!ok) fail++; console.log((ok ? '  PASS  ' : '  FAIL  ') + m); };
const conv = (r, fy) => ({ ...r, pxLo: -r.max[0] / FT, pxHi: -r.min[0] / FT,
  pzLo: -r.max[2] / FT, pzHi: -r.min[2] / FT, yLo: (r.min[1] - fy) / FT, yHi: (r.max[1] - fy) / FT });
const P = raw.items.map(r => conv(r, r.floorY));
// The GROUND floor datum. items[0] may belong to another level — level2 furniture is in
// the same scene — so take it from a piece known to be in this room.
const FY = (P.find(r => r.type === 'island') || P[0]).floorY;
const L = raw.loose.map(a => ({ pxLo: -a[3] / FT, pxHi: -a[0] / FT, pzLo: -a[5] / FT, pzHi: -a[2] / FT,
  yLo: (a[1] - FY) / FT, yHi: (a[4] - FY) / FT, nv: a[6] || 0, vol: (a[7] || 0) / (FT * FT * FT) }));
// NOTE ON BOXES: pxLo/pxHi/pzLo/pzHi come from Box3.setFromObject, which returns the box
// OF THE GEOMETRY'S BOX after transform — so any mesh with its own rotation reports wider
// than it is (a 40 mm post turned 45 deg measures 80 mm), and the item's yaw inflates it
// again. Vertical extents are honest; horizontal ones are an upper bound only. Use `vol`
// for anything about a member's SECTION.
const meshes = r => (r ? r.parts : []).map((a, i) => ({ pxLo: -a[3] / FT, pxHi: -a[0] / FT,
  pzLo: -a[5] / FT, pzHi: -a[2] / FT, yLo: (a[1] - FY) / FT, yHi: (a[4] - FY) / FT,
  vol: (r.mvols || [])[i] }));
const pick = (t, k, pz) => P.find(r => r.type === t && (!k || r.kind === k) && (pz === undefined || Math.abs(r.pz - pz) < 0.01));
const east = P.filter(r => r.type === 'cabinet_run' && r.px < 20);
const drawers = east.find(r => r.kind === 'tall');
const middle  = east.find(r => r.kind === 'wall' && Math.abs(r.yLo - 3.08) < 0.05);
const upper   = east.find(r => r.kind === 'wall' && r.yLo > 6.5);
const west    = pick('cabinet_run', 'base', -7.2442);
const WALL = 15.3125, FR = 0.17, REV = 0.055, SET = 0.04;
const RUNS = [['drawers', drawers, WALL + 2.1, 1], ['middle', middle, WALL + 1.7667, 1],
              ['upper', upper, WALL + 1.7667, 1], ['west run', west, 30.7708 - 2.0, -1]];

// A FRONT is the door/drawer SLAB. The recessed panel behind it is thinner and deeper
// by design; the face frame sits in front of both at the carcass face.
const fronts = (r, face, sgn) => meshes(r).filter(m =>
  (m.pzHi - m.pzLo) > 0.3 && (m.yHi - m.yLo) > 0.25
  && (m.pxHi - m.pxLo) > 0.03 && (m.pxHi - m.pxLo) < 0.06
  && Math.abs((sgn > 0 ? m.pxHi : m.pxLo) - (face - sgn * SET)) < 0.012)
  .sort((u, v) => u.pzLo - v.pzLo);
// Fronts merged into modules by pz overlap — a drawer bank is three slabs at one span.
const modsOf = (r, face, sgn) => {
  const cl = [];
  for (const m of fronts(r, face, sgn)) {
    const last = cl[cl.length - 1];
    if (last && m.pzLo <= last.hi + 0.02) last.hi = Math.max(last.hi, m.pzHi);
    else cl.push({ lo: m.pzLo, hi: m.pzHi });
  }
  return cl;
};

console.log('FRAME CLEARANCE');
for (const [n, r, face, sgn] of RUNS) {
  if (!r) { A(false, `${n}: not built`); continue; }
  const stiles = meshes(r).filter(m => Math.abs((sgn > 0 ? m.pxHi : m.pxLo) - face) < 0.008
    && (m.yHi - m.yLo) > 0.25 && (m.pzHi - m.pzLo) < 0.3);
  const fr = fronts(r, face, sgn);
  A(stiles.length > 0 && fr.length > 0, `${n}: ${stiles.length} stiles, ${fr.length} fronts`);
  if (!fr.length) continue;
  const backs = fr.map(m => Math.abs((sgn > 0 ? m.pxHi : m.pxLo) - face));
  A(Math.min(...backs) > SET - 0.012 && Math.max(...backs) < SET + 0.012,
    `${n}: fronts set back ${R(Math.min(...backs) * 12, 2)} in behind the frame face`);
  const mods = modsOf(r, face, sgn);
  let minGap = Infinity;
  for (let i = 1; i < mods.length; i++) minGap = Math.min(minGap, mods[i].lo - mods[i - 1].hi);
  if (mods.length > 1) A(minGap > FR + 2 * REV - 0.02,
    `${n}: ${R(minGap * 12, 2)} in between adjacent fronts (stile ${R(FR * 12, 1)} + two ${R(REV * 12, 2)} in reveals)`);
}

console.log('DOOR WIDTHS');
{ // Only the middle and upper bands carry doors now; both drawer runs are exempt,
  // their banks being double width by direction.
  const doorRuns = RUNS.filter(([n]) => n === 'middle' || n === 'upper');
  const all = doorRuns.flatMap(([n, r, face, sgn]) => modsOf(r, face, sgn).map(m => [n, m.hi - m.lo]));
  const wide = all.filter(([, w]) => w > 1.95);
  A(!wide.length, `no door wider than 1.95 ft (widest ${R(Math.max(...all.map(x => x[1])), 3)})`
    + (wide.length ? ` — ${wide.map(([n, w]) => n + ' ' + R(w, 2))}` : '')); }

console.log('WEST RUN');
{ const WF = 30.7708 - 2.0;
  const banks = modsOf(west, WF, -1);
  for (const m of banks) console.log(`  bank pz ${R(m.lo,3)}..${R(m.hi,3)}  ${R(m.hi - m.lo,3)} ft`);
  const rowsOf = (bk) => { const ys = [];
    for (const f of fronts(west, WF, -1)) { if (f.pzLo < bk.lo - 0.02 || f.pzHi > bk.hi + 0.02) continue;
      const yc = (f.yLo + f.yHi) / 2; if (!ys.some(y => Math.abs(y - yc) < 0.15)) ys.push(yc); }
    return ys.length; };
  // Three fronts stacked = a pull-out bank; one = a door. The sink base carries a pair
  // of doors under its bowl, so both kinds are expected on this run.
  const stacks = banks.filter(m => rowsOf(m) === 3), singles = banks.filter(m => rowsOf(m) === 1);
  A(stacks.length === 2, `two pull-out banks — one north of the sink, one south of the dishwasher (${stacks.length})`);
  // The north bank spans its whole cabinet: one set of three drawers, not two banks of three.
  const nBank = stacks.filter(m => m.lo > -5.5);
  A(nBank.length === 1 && nBank[0].hi - nBank[0].lo > 2.2,
    `the bank north of the sink spans the cabinet — ${nBank.length ? R(nBank[0].hi - nBank[0].lo, 3) : '-'} ft wide`);
  A(singles.length === 2 && singles.every(m => m.lo > -8.6 && m.hi < -5.3),
    `a pair of doors in the sink base (${singles.length})`);
  A(stacks.every(m => (m.hi - m.lo) > 0.7), `narrowest drawer front ${R(Math.min(...stacks.map(m => m.hi - m.lo)) * 12, 1)} in — a 15 in base after frame and reveals`);
  // the run terminates 6 in clear of W2's south edge at pz -2.2709
  const stone = meshes(west).filter(m => Math.abs(m.yHi - 3.08) < 0.02 && (m.pzHi - m.pzLo) > 0.5
    && (m.pxHi - m.pxLo) > 2.05);          // the slab; the sink rim is shallower
  const north = Math.max(...stone.map(m => m.pzHi));
  A(Math.abs(north - (-2.7709)) < 0.02,
    `worktop ends at ${R(north,4)} — ${R((north + 2.2709) * -12, 1)} in clear of the north window`);
  // FARMHOUSE SINK: an apron standing proud of the frame, centred on W1
  const apron = meshes(west).filter(m => (m.yHi - m.yLo) > 0.7 && (m.yHi - m.yLo) < 1.0
    && (m.pzHi - m.pzLo) > 2.0 && m.pxLo < WF - 0.02);
  A(apron.length === 1, `one apron front (${apron.length})`);
  if (apron.length) {
    const ap = apron[0];
    A(Math.abs((ap.pzLo + ap.pzHi) / 2 - (-6.9792)) < 0.02, `sink centred on the window (${R((ap.pzLo + ap.pzHi) / 2, 4)})`);
    A(ap.pzHi - ap.pzLo > 2.7, `${R(ap.pzHi - ap.pzLo, 3)} ft wide — a large basin`);
    A(WF - ap.pxLo > 0.02, `apron stands ${R((WF - ap.pxLo) * 12, 2)} in proud of the face frame`);
    A(Math.abs(ap.yHi - 3.08) < 0.03, `apron top level with the worktop (${R(ap.yHi, 3)})`);
  }
  // no stone over the sink — the rim makes the surface there
  A(!stone.some(m => m.pzLo < -6.9 && m.pzHi > -7.1), 'worktop breaks at the sink'); }

console.log('BATTENS');
// A batten is narrow in BOTH horizontal directions; the recessed field band is equally
// thin in projection but runs the length of the wall.
const battens = L.filter(m => m.yLo > 0.7 && m.yLo < 0.95 && (m.yHi - m.yLo) > 1.5
  && (m.pxHi - m.pxLo) < 0.25 && (m.pzHi - m.pzLo) < 0.25);
A(!battens.filter(m => m.pzLo > -12 && m.pzHi < 2.1 && m.pxLo > 15.2 && m.pxHi < 31.1).length,
  'no battens on the kitchen walls');
// Bound px as well as pz. This filter was pz-only, so it swept the whole model at the
// scullery's depth and fired on the muntins of the family room's french door, standing
// open at px -1.6 and -8.3 — outside the room entirely. Same trap as the open back
// door leaf it was narrowed for once already: a swinging leaf is a tall thin vertical.
{ const sb = battens.filter(m => m.pzHi < -11.9 && m.pzLo > -18.7
    && m.pxLo > 0.1 && m.pxHi < 27.9);                                 // inside the room
  A(!sb.length, `no battens in the scullery either (${sb.length})`); }
A(battens.filter(m => m.pzLo > 2.0).length > 0, 'dining room keeps its battens');

console.log('PAIRED SWINGS');
for (const [n, r, face, sgn] of [['middle', middle, WALL + 1.7667, 1], ['upper', upper, WALL + 1.7667, 1]]) {
  const knobs = meshes(r).filter(m => (m.pzHi - m.pzLo) < 0.16 && (m.yHi - m.yLo) < 0.16
    && (sgn > 0 ? m.pxHi : -m.pxLo) > sgn * face + 0.05).map(m => (m.pzLo + m.pzHi) / 2).sort((u, v) => u - v);
  const uniq = []; for (const k of knobs) if (!uniq.some(u => Math.abs(u - k) < 0.05)) uniq.push(k);
  const gaps = []; for (let i = 1; i < uniq.length; i++) gaps.push(uniq[i] - uniq[i - 1]);
  const close = gaps.filter(g => g < FR + 0.45), far = gaps.filter(g => g >= FR + 0.45);
  console.log(`  ${n}: knob gaps ${gaps.map(g => R(g, 2))}`);
  A(uniq.length % 2 === 0, `${n}: an even number of doors to pair (${uniq.length})`);
  A(close.length === uniq.length / 2, `${n}: ${close.length} pairs meeting at a shared stile`);
  A(far.length === uniq.length / 2 - 1, `${n}: pairs separated from each other`);
  // No hinge is drawn: on inset work the knuckle sits in the reveal on the door's EDGE,
  // so a face-mounted leaf is simply wrong. The knob position shows the swing.
  const plates = meshes(r).filter(m => (m.yHi - m.yLo) > 0.22 && (m.yHi - m.yLo) < 0.32
    && (m.pzHi - m.pzLo) < 0.14 && (sgn > 0 ? m.pxHi : -m.pxLo) > sgn * face);
  A(!plates.length, `${n}: no face-mounted hinge plates (${plates.length})`);
}

console.log('STILL HOLDS');
const wide = r => meshes(r).filter(m => (m.pzHi - m.pzLo) > 0.4 && (m.yHi - m.yLo) > 0.3);
const fm = Math.max(...wide(middle).map(m => m.pxHi)), fd = Math.max(...wide(drawers).map(m => m.pxHi));
A(Math.abs((fd - fm) - 4 / 12) < 0.03, `middle and upper step back ${R((fd - fm) * 12, 2)} in from the drawers`);
A(pick('appliance', 'fridge').pxHi > fm + 0.25, 'fridge still proud');
A(pick('appliance', 'fridge').yHi > 6.9, 'fridge column to 7 ft');
const LINES = [-11.6875, -9.9792, -8.2709, -6.7709, -5.2709, -3.7709, -2.2709];
const mm = modsOf(middle, WALL + 1.7667, 1), mu = modsOf(upper, WALL + 1.7667, 1), md = modsOf(drawers, WALL + 2.1, 1);
A(mm.length === 4 && mu.length === 6, `middle 4 doors, upper 6 (${mm.length}/${mu.length})`);
A(md.length === 2, `lower drawers 3 left + 3 right (${md.length} banks)`);
A(![...mm, ...mu].flatMap(m => [m.lo, m.hi]).some(e => !LINES.some(l => Math.abs(e - l) < FR + REV + 0.02)),
  'middle and upper modules on the six lines');
// The cove crown is the only trim member that stands ~0.417 ft off the wall (P5 in
// src/wall-finish.js) — the field band projects 0.039 and the bed mould 0.19 — so a
// cornice mesh is the one that is thick in BOTH horizontal directions.
const cornice = L.filter(m => m.yLo > 6.9 && m.yLo < 8.7
  && Math.min(m.pxHi - m.pxLo, m.pzHi - m.pzLo) > 0.3
  && Math.max(m.pxHi - m.pxLo, m.pzHi - m.pzLo) > 1.0);
A(!cornice.filter(m => m.pzHi < 2.05 && m.pxLo > 15.0 && m.pxHi < 31.2).length,
  `no cornice on any kitchen wall (${cornice.filter(m => m.pzHi < 2.05 && m.pxLo > 15.0 && m.pxHi < 31.2).length})`);
// Positive control: without this the check above is purely negative and would pass just
// as happily if the detector stopped finding cornices at all.
A(cornice.filter(m => m.pzLo > 1.95).length > 0,
  `dining room still has its cornice — the detector works (${cornice.filter(m => m.pzLo > 1.95).length})`);
// Measured off the slab, not the group's largest footprint — breaking the counter at
// the sink made the carcass the biggest piece, which reads 2.9.
{ const slab = meshes(west).filter(m => (m.pxHi - m.pxLo) > 2.05 && (m.pzHi - m.pzLo) > 0.5);
  A(slab.length && Math.abs(Math.max(...slab.map(m => m.yHi)) - 3.08) < 0.03,
    `west worktop at ${R(Math.max(...slab.map(m => m.yHi)), 3)} ft`); }
const isl = pick('island', null, -5.9249);
{ const face = Math.max(...meshes(isl).filter(m => (m.pxHi - m.pxLo) > 0.4 && (m.yHi - m.yLo) > 0.3).map(m => m.pzHi));
  A(!meshes(isl).filter(m => (m.pxHi - m.pxLo) > 0.4 && (m.yHi - m.yLo) > 0.3 && m.pzHi > face + 0.015).length,
    'island fronts inset'); }
// Approach zones are measured from the ARCHITRAVE face, the proudest surface at the
// threshold — the strictest reading, and the check that caught two blocked doorways.
const JF = -10.9875, ZN = JF + 3.3334;
const fixed = P.filter(r => ['cabinet_run', 'island', 'appliance', 'open_shelves'].includes(r.type));
A(!fixed.some(r => Math.min(26.0417, r.pxHi) - Math.max(20.0417, r.pxLo) > 1e-4
  && Math.min(ZN, r.pzHi) - Math.max(JF, r.pzLo) > 1e-4), 'scullery approach clear');
for (const [nm, a, bx] of [['east', 16.08, 19.08], ['west', 27.0, 30.0]])
  A(!fixed.some(r => Math.min(bx, r.pxHi) - Math.max(a, r.pxLo) > 1e-4
    && Math.min(1.0625, r.pzHi) - Math.max(1.0625 - 3.3334, r.pzLo) > 1e-4), `${nm} dining approach clear`);
const g = { range: (-0.9623) - isl.pzHi, south: isl.pzLo - JF, west: west.pxLo - isl.pxHi, east: isl.pxLo - drawers.pxHi };
console.log('  aisles:', Object.fromEntries(Object.entries(g).map(([k, v]) => [k, R(v, 3)])));
A(Math.min(...Object.values(g)) > 3.35, `every island aisle at least 3'4-1/4" (min ${R(Math.min(...Object.values(g)), 3)})`);
A(!fixed.some(r => r.pzLo < -9.1 && r.px > 17.0 && r.px < 29.0 && !(r.type === 'cabinet_run' && r.px < 20)
  && !(r.type === 'cabinet_run' && r.px > 29) && !(r.type === 'appliance' && r.kind === 'dishwasher')),
  'south wall carries no cabinetry');
A(P.filter(r => r.type === 'counter_stool').length === 2, 'two counter stools');
A(P.filter(r => r.type === 'open_shelves').length === 2, 'two open-shelf bays');
// ============================================================ SCULLERY
console.log('SCULLERY');
const SWALL = -18.6458, NWALL = -12.1459;
const sc = P.filter(r => r.pz < -12);
const gBase = sc.find(r => r.type === 'cabinet_run' && r.kind === 'base');
const gUps  = sc.filter(r => r.type === 'cabinet_run' && r.kind === 'wall');
const app = k => sc.find(r => r.type === 'appliance' && r.kind === k);
const WINS = [[4.33, 6.33, 'S1'], [13.0, 15.0, 'S2'], [20.0833, 22.0833, 'S3']];
A(!!gBase, 'galley base run built');
if (gBase) {
  console.log(`  base px ${R(gBase.pxLo,3)}..${R(gBase.pxHi,3)}  pz ${R(gBase.pzLo,3)}..${R(gBase.pzHi,3)}`);
  A(Math.abs(gBase.pzLo - SWALL) < 0.02, `back on the SOUTH wall (${R(gBase.pzLo,4)})`);
  A(NWALL - gBase.pzHi > 4.2, `${R(NWALL - gBase.pzHi, 3)} ft of walkway north of the counter`);
  A(16.17 - gBase.pxHi > 0.5, `${R((16.17 - gBase.pxHi) * 12, 1)} in clear of the back door`);
  // The whole point of this wall: the worktop passes UNDER the windows, whose sills are
  // at 4.0 against a 3.08 top. Assert both the height and the continuity.
  const slab = meshes(gBase).filter(m => (m.pxHi - m.pxLo) > 0.5 && (m.pzHi - m.pzLo) > 2.05);
  const topY = slab.length ? Math.max(...slab.map(m => m.yHi)) : 0;
  A(Math.abs(topY - 3.08) < 0.03, `worktop at ${R(topY,3)} ft — clears the 4.0 ft sills by ${R((4.0-topY)*12,1)} in`);
  for (const [a, b, nm] of WINS.slice(0, 2))
    A(slab.some(m => m.pxLo < a + 0.05 && m.pxHi > b - 0.05), `worktop runs under window ${nm}`);
  // sink under the middle window
  const bowl = meshes(gBase).filter(m => m.yHi < 3.06 && m.yHi > 2.2 && (m.pzHi - m.pzLo) > 1.2
    && m.pxLo > 12.3 && m.pxHi < 15.7);
  A(bowl.length > 0, `sink set into the counter under window S2 (${bowl.length} members)`);
  // LOW CABINETS ARE DRAWERS — except the sink base, where the bowl sits exactly where
  // a top drawer would go, so that bay keeps doors.
  const face = SWALL + 2.0;
  const fronts = meshes(gBase).filter(m => (m.pxHi - m.pxLo) > 0.3 && (m.yHi - m.yLo) > 0.25
    && (m.pzHi - m.pzLo) > 0.03 && (m.pzHi - m.pzLo) < 0.06 && Math.abs(m.pzHi - (face - 0.04)) < 0.012)
    .sort((u, v) => u.pxLo - v.pxLo);
  const mods = [];
  for (const f of fronts) { const last = mods[mods.length - 1];
    if (last && f.pxLo <= last.hi + 0.02) { last.hi = Math.max(last.hi, f.pxHi); last.ys.push((f.yLo + f.yHi) / 2); }
    else mods.push({ lo: f.pxLo, hi: f.pxHi, ys: [(f.yLo + f.yHi) / 2] }); }
  const rowsOf = m => m.ys.filter((y, i) => m.ys.findIndex(z => Math.abs(z - y) < 0.15) === i).length;
  const stacks = mods.filter(m => rowsOf(m) === 3), singles = mods.filter(m => rowsOf(m) === 1);
  console.log(`  base modules: ${mods.map(m => `${R(m.lo,2)}-${R(m.hi,2)}x${rowsOf(m)}`).join(' ')}`);
  A(stacks.length === 4, `four banks of three drawers (${stacks.length})`);
  A(singles.length === 2 && singles.every(m => m.lo > 12.3 && m.hi < 15.7),
    `the sink base keeps a pair of doors (${singles.length})`);
  A(stacks.every(m => (m.hi - m.lo) > 1.0),
    `narrowest drawer front ${R(Math.min(...stacks.map(m => m.hi - m.lo)) * 12, 1)} in — the 8-1/2 in one is gone`);
}
for (const k of ['microwave', 'range', 'dishwasher', 'hood']) A(!!app(k), `${k} present`);
if (app('range') && app('hood')) {
  const rg = app('range'), hd = app('hood');
  A(Math.abs(rg.px - hd.px) < 0.02, 'hood centred over the range');
  A(WINS.every(([a, b]) => rg.pxHi < a || rg.pxLo > b),
    'range sits clear of every window, so its hood has wall to hang on');
  // CLEARANCE, measured off the cooktop slab rather than assumed from topFt.
  const ctop = meshes(rg).filter(m => m.yHi > 3.0 && m.yHi < 3.12 && (m.pxHi - m.pxLo) > 2.0)
    .sort((u, v) => (v.pxHi - v.pxLo) * (v.pzHi - v.pzLo) - (u.pxHi - u.pxLo) * (u.pzHi - u.pzLo))[0];
  A(!!ctop, 'cooktop surface found');
  if (ctop) {
    const clr = hd.yLo - ctop.yHi;
    A(clr >= 2.45, `hood bottom ${R(clr * 12, 1)} in above the cooking surface (24 in is the minimum)`);
    // CAPTURE AREA: the stainless liner, not the millwork box around it.
    const lin = meshes(hd).filter(m => m.yLo < hd.yLo + 0.05 && (m.pxHi - m.pxLo) > 2.0)
      .sort((u, v) => (v.pxHi - v.pxLo) * (v.pzHi - v.pzLo) - (u.pxHi - u.pxLo) * (u.pzHi - u.pzLo))[0];
    const ca = lin ? (lin.pxHi - lin.pxLo) * (lin.pzHi - lin.pzLo) : 0;
    const cta = (ctop.pxHi - ctop.pxLo) * (ctop.pzHi - ctop.pzLo);
    A(ca >= cta, `capture area ${R(ca,2)} sq ft vs a ${R(cta,2)} sq ft cooktop (+${R((ca/cta-1)*100,0)}%)`);
    A(lin && lin.pxHi - lin.pxLo >= rg.pxHi - rg.pxLo && lin.pzHi - lin.pzLo >= 2.05,
      'liner covers the cooktop in both width and depth');
  }
  // BOXED: millwork carried from the liner to the ceiling.
  A(hd.yHi > 8.9, `hood box runs to the ceiling (${R(hd.yHi,2)} ft)`);
  const boxParts = meshes(hd).filter(m => m.yLo > hd.yLo + 0.3 && (m.pxHi - m.pxLo) > 1.5);
  A(boxParts.length >= 3, `boxed and trimmed — ${boxParts.length} millwork members above the liner`);
}
// ONE band of uppers, stopping on the 7 ft head line — NOT run to the ceiling.
gUps.sort((u, v) => u.yLo - v.yLo);
A(gUps.length === 2, `two upper bands, run to the ceiling (${gUps.length})`);
if (gUps.length === 2) {
  A(Math.abs(gUps[0].yLo - 4.5) < 0.03 && Math.abs(gUps[1].yHi - 9.0) < 0.03,
    `uppers run ${R(gUps[0].yLo,2)} to ${R(gUps[1].yHi,2)} ft — to the ceiling`);
  A(Math.abs(gUps[0].yHi - gUps[1].yLo) < 0.03, 'the two bands meet with no void between them');
  const u = gUps[0];
  const fr = meshes(u).filter(m => (m.pzHi - m.pzLo) < 0.09 && (m.pxHi - m.pxLo) > 0.3);
  // The stool and casing run 4 in past each opening edge, so clearing the OPENING is
  // not enough — the uppers were landing on the trim.
  const CASE = 0.33;
  for (const [a, b, nm] of WINS)
    A(!fr.some(m => m.pxHi > a - CASE && m.pxLo < b + CASE), `uppers clear window ${nm} and its casing`);
  for (const [a, b, nm] of WINS) {
    const gap = fr.filter(m => m.pxHi <= a).map(m => a - m.pxHi).concat(fr.filter(m => m.pxLo >= b).map(m => m.pxLo - b));
    if (gap.length) A(Math.min(...gap) > CASE + 0.05,
      `nearest upper to ${nm} stands ${R(Math.min(...gap) * 12, 1)} in off the opening`);
  }
  if (app('hood')) for (const u2 of gUps) {
    const f2 = meshes(u2).filter(m => (m.pzHi - m.pzLo) < 0.09 && (m.pxHi - m.pxLo) > 0.3);
    A(!f2.some(m => m.pxHi > app('hood').pxLo + 0.05 && m.pxLo < app('hood').pxHi - 0.05),
      `uppers break over the hood (${R(u2.yLo,1)} ft band)`);
  }
}
// WINDOWS TRIMMED: SWEPT mouldings — a real cove-and-ovolo architrave, a nosed stool,
// and both mitred back to the wall. Not stacked boxes pretending to be a profile.
{ const sy = 4.0 - 0.066, hy = 7.0 - 0.066;   // wall finish sits 0.02 m below the furniture datum
  const onWall = L.filter(m => m.pzLo < SWALL + 0.35 && m.pxLo > 0 && m.pxHi < 28);
  // A BoxGeometry has 24 vertices. An extruded section with a cove and an ovolo has
  // hundreds — and a bounding box cannot tell the two apart, which is why the collector
  // records vertex counts. This is the assertion that "these are mouldings" rests on.
  const MOULDED = 100;

  // JAMBS: one swept member each, a casing width across, sill to head.
  const jambs = onWall.filter(m => Math.abs(m.yLo - sy) < 0.12 && Math.abs(m.yHi - hy) < 0.12
    && (m.pxHi - m.pxLo) > 0.25 && (m.pxHi - m.pxLo) < 0.45);
  A(jambs.length === 6, `a jamb casing each side of three windows (${jambs.length})`);
  A(jambs.every(m => m.nv >= MOULDED),
    `swept profiles, not boxes — ${Math.min(...jambs.map(m => m.nv))} vertices each (a box is 24)`);
  A(jambs.every(m => Math.abs((m.pxHi - m.pxLo) - 0.33) < 0.02), 'a 4 in casing');
  // HORN PROPORTION. Millwork practice measures the horn from the CASING's outboard
  // edge, not the jamb — 3/4 to 1 in past it for a stool, about the same for a moulded
  // head. Measuring from the jamb instead is what left these overhanging by 2 in.
  // (Craftsman trim does overhang 1-3 in, but that is flat stock reading as a lintel.)
  // Measured over the run AND its returns: the mitre is part of the member, so checking
  // the run alone reports the horn the code intended rather than the one you see —
  // which is exactly how returns hanging off both ends went unnoticed.
  const HORN = (run, ret, name) => {
    if (!run.length || !jambs.length) return;
    const caseEdge = 2.0 + (jambs[0].pxHi - jambs[0].pxLo);        // 2 ft window + both half-casings
    const near = ret.filter(m => Math.abs(m.pxLo - run[0].pxHi) < 0.02 || Math.abs(m.pxHi - run[0].pxLo) < 0.02);
    const lo = Math.min(run[0].pxLo, ...near.map(m => m.pxLo));
    const hi = Math.max(run[0].pxHi, ...near.map(m => m.pxHi));
    const past = ((hi - lo) - caseEdge) / 2 * 12;
    A(past > 0.5 && past < 1.25, `${name} horn ${R(past, 2)} in past the casing edge, returns included (3/4-1 in)`);
  };

  // HEAD: the run, plus a RETURN at each end. A 45 deg mitre returns as far as the
  // member stands proud, so the return's length has to equal its projection — that
  // single relationship is what makes it a mitre rather than a stuck-on block.
  const atHead = onWall.filter(m => Math.abs(m.yLo - hy) < 0.06 && m.yHi < hy + 0.42);
  const hRun = atHead.filter(m => (m.pxHi - m.pxLo) > 1.5);
  const hRet = atHead.filter(m => (m.pxHi - m.pxLo) < 0.3);
  A(hRun.length === 3, `a moulded head over each window (${hRun.length})`);
  HORN(hRun, hRet, 'head');
  A(hRet.length === 6, `mitred returns at both ends of each head (${hRet.length})`);
  A(hRet.every(m => m.nv >= MOULDED), 'the returns carry the same section round the corner');
  // DIRECTION of the mitre. It has to slope BACKWARDS — long point at the front, short
  // point at the wall — so the cut faces into the wall and the return tucks in behind
  // it. Cut the other way the run's long point is at the wall and the cut face aims out
  // into the room where you see it, which is what was here. Both are 45 deg and both
  // measure identically end-to-end, so only the depth at which the member reaches its
  // full length tells them apart: at the FRONT for a backward cut.
  if (hRun.length && hRet.length) {
    const r = hRun[0];
    // They share an END with the run, not a boundary: cutting backwards puts the run's
    // long point at the extremity, so the return tucks in BEHIND it and sits inside the
    // run's span. An adjacency test finds nothing, which is itself the tell.
    const ret = hRet.filter(m => Math.abs(m.pxLo - r.pxLo) < 0.02 || Math.abs(m.pxHi - r.pxHi) < 0.02);
    A(ret.length === 2 && ret.every(m => Math.abs((m.pzHi - m.pzLo) - (r.pzHi - r.pzLo)) < 0.02),
      'the return is the full section deep, seating on the wall behind the mitre');
  }
  if (hRun.length && hRet.length) {
    const proj = hRun[0].pzHi - hRun[0].pzLo;
    A(hRet.every(m => Math.abs((m.pxHi - m.pxLo) - proj) < 0.02),
      `each return runs back exactly as far as the head stands proud (${R(proj, 3)} ft) — a 45 deg mitre`);
  }

  // STOOL: same again, and it stands prouder than the casing, as a sill board does.
  const atSill = onWall.filter(m => Math.abs(m.yLo - sy) < 0.04 && m.yHi < sy + 0.16);
  const sRun = atSill.filter(m => (m.pxHi - m.pxLo) > 1.5);
  const sRet = atSill.filter(m => (m.pxHi - m.pxLo) < 0.3);
  A(sRun.length === 3, `a stool at each window (${sRun.length})`);
  HORN(sRun, sRet, 'stool');
  A(sRet.length === 6, `mitred returns at both ends of each stool (${sRet.length})`);
  A(sRun.every(m => m.nv >= MOULDED), 'the stool is nosed, not a square board');
  if (sRun.length && sRet.length) {
    const proj = sRun[0].pzHi - sRun[0].pzLo;
    A(sRet.every(m => Math.abs((m.pxHi - m.pxLo) - proj) < 0.02),
      `and returns exactly its own projection (${R(proj, 3)} ft)`);
    A(proj > (jambs[0].pzHi - jambs[0].pzLo), 'the stool stands prouder than the casing');
  }

  // APRON: casing stock run horizontally under the stool, inverted, returned onto
  // itself. Its length is the distance across the OUTSIDE EDGES of the side casings —
  // the long point of each mitre lands where the casing's outer edge meets it — which
  // is the rule that says it is an apron and not just a board of some length.
  const atApron = onWall.filter(m => Math.abs(m.yHi - sy) < 0.05 && m.yLo > sy - 0.45);
  const aRun = atApron.filter(m => (m.pxHi - m.pxLo) > 1.5);
  const aRet = atApron.filter(m => (m.pxHi - m.pxLo) < 0.3);
  A(aRun.length === 3, `an apron under each window (${aRun.length})`);
  A(aRet.length === 6, `returned onto itself at both ends (${aRet.length})`);
  A(aRun.every(m => m.nv >= MOULDED), 'a moulded section, not a flat board');
  A(aRun.every(m => Math.abs((m.yHi - m.yLo) - 0.33) < 0.02),
    'the same 4 in stock as the casing');
  // SPRUNG, like crown: the section seats on the wall behind AND the stool's soffit
  // above, with the moulded face sweeping diagonally between. That is what lets the
  // 45 deg mitre meet its return along the whole diagonal and turn the corner. A
  // flat-backed board has nothing to return INTO — its "mitre" can only ever read as a
  // block stuck on the end, which is what it did.
  // A sprung section projects LESS than it drops; a flat board would project about
  // nothing at all and a square one would match. Checking the ratio catches a
  // silent revert to either.
  if (aRun.length) {
    const drop = aRun[0].yHi - aRun[0].yLo, proj = aRun[0].pzHi - aRun[0].pzLo;
    A(proj > 0.10 && proj < drop * 0.75,
      `sprung — projects ${R(proj * 12, 1)} in over a ${R(drop * 12, 1)} in drop`);
  }
  // Per window, and against the STOOL directly above it — the two have to die at the
  // same plan position or the corner steps. Comparing extremes across all three windows
  // instead compared one apron to the whole wall.
  const ends = (r, ret) => {
    const near = ret.filter(m => Math.abs(m.pxLo - r.pxHi) < 0.02 || Math.abs(m.pxHi - r.pxLo) < 0.02);
    return [Math.min(r.pxLo, ...near.map(m => m.pxLo)), Math.max(r.pxHi, ...near.map(m => m.pxHi))];
  };
  for (const r of aRun) {
    const [lo, hi] = ends(r, aRet);
    const above = sRun.find(m => Math.abs((m.pxLo + m.pxHi) / 2 - (lo + hi) / 2) < 0.2);
    if (!above) { A(false, 'apron has a stool above it'); continue; }
    const [sLo, sHi] = ends(above, sRet);
    A(Math.abs(lo - sLo) < 0.02 && Math.abs(hi - sHi) < 0.02,
      `apron dies flush with the stool above it (${R(lo, 3)}..${R(hi, 3)} vs ${R(sLo, 3)}..${R(sHi, 3)})`);
  }
}

// EAST WINDOW. Its casing runs 4 in past the opening, and a wall-centred window would
// have put that on top of the countertop's east return — which is why it sits north.
{ const EW = 0.1458, sy = 3.5 - 0.066, cf = SWALL + 2.0;
  // The stool is the board itself; its horns now end in mitre steps, so it measures
  // shorter than the old square-cut slab that ran the full casing width past each jamb.
  // Anchored on the SILL LINE: the apron below runs the same length as the board.
  const cased = L.filter(m => m.pxHi > EW - 0.05 && m.pxLo < EW + 0.4
    && Math.abs(m.yLo - sy) < 0.04 && m.yHi < sy + 0.16
    && (m.pzHi - m.pzLo) > 2.4 && (m.pzHi - m.pzLo) < 3.4);
  A(cased.length === 1, `east window has a stool (${cased.length})`);
  if (cased.length) A(cased[0].pzLo > cf + 0.05,
    `its casing clears the countertop's east return by ${R((cased[0].pzLo - cf) * 12, 1)} in`);
  // One SWEPT member per jamb; its vertex count is what proves it is a moulding.
  const posts = L.filter(m => m.pxHi > EW - 0.05 && m.pxLo < EW + 0.4
    && Math.abs(m.yLo - sy) < 0.14 && m.yHi > 6.7 && m.yHi < 7.1
    && (m.pzHi - m.pzLo) > 0.25 && (m.pzHi - m.pzLo) < 0.45);
  A(posts.length === 2, `a jamb casing each side of the east window (${posts.length})`);
  A(posts.every(m => m.nv >= 100), 'both swept profiles, not boxes'); }

// ============================================================ DINING CHAIRS
// Cape Cod: painted frame, drop-in seat and an upholstered back in ticking stripe.
// The brief was "not clunky", so the thing to hold onto is the SLIMNESS — the chair it
// replaced was 2.0 cu ft of cushion on 120 mm and 110 mm sections.
console.log('DINING CHAIRS');
{ const CUFT = 1 / (FT * FT * FT);
  const dc = P.filter(r => r.type === 'upholstered_dining_chair');
  A(dc.length === 6, `six chairs round the dining table (${dc.length})`);
  if (dc.length) {
    const vols = dc.map(c => c.vol * CUFT);
    A(Math.max(...vols) - Math.min(...vols) < 0.01, 'all six are the same chair');
    A(vols[0] < 1.1, `${R(vols[0], 2)} cu ft each — against 2.0 for the chair it replaced`);
    const c = dc[0], mm = meshes(c);
    // The drop-in pad is the biggest FOOTPRINT in the seat band. Picking "widest, then
    // highest" instead found the back's bottom rail, which sits 0.7 in above the pad and
    // is a similar width — both assertions then passed while measuring the wrong member.
    const pad = mm.filter(m => m.yHi > 1.3 && m.yHi < 1.75)
      .sort((u, v) => ((v.pxHi - v.pxLo) * (v.pzHi - v.pzLo)) - ((u.pxHi - u.pxLo) * (u.pzHi - u.pzLo)))[0];
    A(!!pad && Math.abs(pad.yHi - 1.51) < 0.05, `seat at ${R((pad ? pad.yHi : 0) * 12, 1)} in`);
    A(!!pad && (pad.yHi - pad.yLo) < 0.24,
      `pad is ${R((pad ? (pad.yHi - pad.yLo) : 0) * 12, 1)} in thick — the chair it replaced had 4.7`);
    const top = Math.max(...mm.map(m => m.yHi));
    A(Math.abs(top - 2.95) < 0.12, `back tops out at ${R(top * 12, 1)} in — a dining back, not a throne`);
    A(c.lw / FT < 1.75 && c.ld / FT < 2.05,
      `stands ${R(c.lw / FT * 12, 1)} x ${R(c.ld / FT * 12, 1)} in on the floor`);
    // THE RAKE, which is the thing that was actually wrong: the back used to tip very
    // slightly forward. Measure the crest's horizontal set-back from the seat centre —
    // a distance, so it holds whatever direction the chair has been turned to face.
    const crest = mm.reduce((a, m) => (m.yHi > a.yHi ? m : a));
    const mid = (m) => [(m.pxLo + m.pxHi) / 2, (m.pzLo + m.pzHi) / 2];
    const [ax, az] = mid(crest), [bx, bz] = mid(pad);
    const setback = Math.hypot(ax - bx, az - bz);
    A(setback > 0.85 && setback < 1.25,
      `crest sits ${R(setback * 12, 1)} in behind the seat centre — a leaning back, not an upright one`);
    // STRUCTURE. The frame was undersized before and read as if it would come apart when
    // sat on. A square post's world box is never SMALLER than its section whatever yaw
    // the chair has been turned to, so the thinner horizontal extent is a safe floor.
    const legs = mm.filter(m => m.yLo < 0.05 && m.yHi > 1.0);
    A(legs.length === 4, `four legs to the floor (${legs.length})`);
    // Section from VOLUME / length, not from the box: a tapered post drawn as a 4-gon
    // turned 45 deg reports an 80 mm box for a 40 mm leg, and asserting on that would
    // have committed a number twice the truth.
    const side = Math.min(...legs.map(m => Math.sqrt(m.vol / ((m.yHi - m.yLo) * FT)) / FT));
    A(side * 12 > 1.25, `legs average ${R(side * 12, 2)} in square — 1.26 in was too spindly`);
    // Seat rails carry the sitter; their depth is the whole point.
    const rails = mm.filter(m => m.yLo > 1.05 && m.yHi < 1.40 && Math.max(m.pxHi - m.pxLo, m.pzHi - m.pzLo) > 1.1);
    A(rails.length >= 4, `${rails.length} seat rails`);
    A(Math.max(...rails.map(m => m.yHi - m.yLo)) > 0.21,
      `rails are ${R(Math.max(...rails.map(m => m.yHi - m.yLo)) * 12, 1)} in deep`);
    // H-stretcher: two side rails and a medial between them, low down.
    const str = mm.filter(m => m.yLo > 0.45 && m.yHi < 0.68);
    A(str.length === 3, `H-stretcher between the legs (${str.length} members)`);
    // No per-member "slim stock" check here: the back is RAKED, so every member in it has
    // an axis-aligned box far thicker than its section. Same trap the bentwood chair hit.
    // Total volume above is the rotation-proof way to say "not clunky".
  }
}

// ============================================================ CAFE NOOK (SW corner)
// The scullery is only 6'6" deep, so a bench + table + chair stack spans the room
// wall to wall. What has to be measured is therefore not "does it fit" but "can you
// still get from the kitchen portal to the back door" — hence the lane checks below.
console.log('CAFE NOOK');
{ const WWALL = 27.8542;                       // west wall interior face
  // The Kitchen -> Scullery opening's casing post projects 0.045 m onto this side, so
  // "full width" for the bench means south wall face to the architrave, not to the
  // north wall itself.
  const CASE = NWALL - 0.045 / FT;
  const bq = P.find(r => r.type === 'banquette');
  A(!!bq, 'banquette built');
  if (bq) {
    const bm = meshes(bq);
    console.log(`  banquette px ${R(bq.pxLo,3)}..${R(bq.pxHi,3)}  pz ${R(bq.pzLo,3)}..${R(bq.pzHi,3)}`);
    A(Math.abs(bq.pxHi - WWALL) < 0.02, `back on the WEST wall (${R(bq.pxHi,4)})`);
    A(Math.abs(bq.pzLo - SWALL) < 0.03, `south end dies into the south wall (${R(bq.pzLo,4)})`);
    A(Math.abs(bq.pzHi - CASE) < 0.03, `north end dies into the door architrave (${R(bq.pzHi,4)}, casing at ${R(CASE,4)})`);
    A(bq.pzHi < NWALL - 0.10, `stops ${R((NWALL - bq.pzHi) * 12, 1)} in short of the opening, not in it`);
    A(bq.pzHi - bq.pzLo > 6.3, `runs the full ${R(bq.pzHi - bq.pzLo, 3)} ft of the west end`);
    // The squab: the widest horizontal member topping out in the seat-height band.
    const squab = bm.filter(m => m.yHi > 1.3 && m.yHi < 1.8 && (m.pzHi - m.pzLo) > 3.5)
      .sort((u, v) => v.yHi - u.yHi)[0];
    A(!!squab && Math.abs(squab.yHi - 1.51) < 0.06,
      `seat at ${R((squab ? squab.yHi : 0) * 12, 1)} in`);
    const top = Math.max(...bm.map(m => m.yHi));
    A(Math.abs(top - 3.0) < 0.03, `back tops out at ${R(top * 12, 1)} in`);
    // The west window's apron hangs 0.12 m below its 3.5 ft sill. A back that ran to
    // the usual 38" would foul it, which is why this one stops at 36".
    const apronB = 3.5 - 0.12 / FT;
    A(top < apronB - 0.02, `tucks under the window apron (${R((apronB - top) * 12, 1)} in below it)`);
  }
  const tb = P.find(r => r.type === 'round_pedestal_table' && r.pz < -12);
  A(!!tb, 'cafe table built');
  if (tb && bq) {
    const dia = tb.pzHi - tb.pzLo;
    A(Math.abs(dia - 3.0) < 0.05, `${R(dia * 12, 1)} in round top`);
    A(Math.abs(tb.yHi - 2.5) < 0.03, `top at ${R(tb.yHi * 12, 1)} in`);
    const gap = bq.pxLo - tb.pxHi;
    A(gap > 0.15 && gap < 0.45, `${R(gap * 12, 1)} in between the table and the bench front`);
    // The table used to be centred on the west window. With the bench running the full
    // width the window is no longer the anchor, and the table is deliberately 10 in
    // south of it so the chair opposite is not standing in the kitchen opening.
    A(NWALL - tb.pzHi > 2.2, `${R((NWALL - tb.pzHi) * 12, 1)} in clear north of the table`);
    A(tb.pzLo - SWALL > 0.9, `${R((tb.pzLo - SWALL) * 12, 1)} in clear south of it`);
  }
  const ch = P.filter(r => r.type === 'bentwood_chair');
  A(ch.length === 2, `two bentwood chairs at the table (${ch.length})`);
  // Chairs must actually have found this table, not the dining-room one three rooms away.
  if (tb) for (const c of ch) {
    const d = Math.hypot((c.pxLo + c.pxHi) / 2 - tb.px, (c.pzLo + c.pzHi) / 2 - tb.pz);
    A(d > 1.6 && d < 2.4, `chair pulled up to this table (${R(d, 2)} ft from its centre)`);
  }
  if (ch.length === 2 && tb) {
    const c = ch.map(x => [(x.pxLo + x.pxHi) / 2, (x.pzLo + x.pzHi) / 2]);
    A(Math.hypot(c[0][0] - c[1][0], c[0][1] - c[1][1]) > 1.75,
      `${R(Math.hypot(c[0][0] - c[1][0], c[0][1] - c[1][1]) * 12, 1)} in between the two chairs`);
    // DIRECTLY OPPOSITE THE BENCH: both east of the table, and mirrored about the
    // table's east-west axis rather than swung round to one side of it.
    A(c.every(q => q[0] < tb.px - 0.8), 'both chairs east of the table, facing the bench');
    A(Math.abs((c[0][1] - tb.pz) + (c[1][1] - tb.pz)) < 0.12,
      `mirrored about the bench axis (offsets ${R(c[0][1] - tb.pz, 2)} / ${R(c[1][1] - tb.pz, 2)} ft)`);
  }
  // DAINTY, MEASURED. Bounding boxes cannot tell a bent hoop from a padded slab — a
  // TubeGeometry's box is the whole bend — so measure the SOLID VOLUME of the geometry.
  // That is exactly the property that changed: the upholstered dining chair is ~2.1 cu ft
  // of cushion and box apron, a No. 14 is round stock and air.
  const CUFT = 1 / (FT * FT * FT);
  for (const c of ch) {
    A(c.vol * CUFT < 0.5, `${R(c.vol * CUFT, 3)} cu ft of timber (the upholstered chair is ~2.1)`);
    // Footprint from the chair's OWN frame, so the two chairs' different angles to the
    // table do not change the answer.
    // A Thonet No. 14 is 16.5 x 20.5 in on the floor; hold the model to within an inch.
    A(c.lw / FT * 12 < 18.5 && c.ld / FT * 12 < 21.5,
      `stands ${R(c.lw / FT * 12, 1)} x ${R(c.ld / FT * 12, 1)} in on the floor (a No. 14 is 16.5 x 20.5)`);
    A(Math.abs(c.yHi - 2.92) < 0.25, `back at ${R(c.yHi * 12, 1)} in`);
  }
  // Cross-check against the dining chair. Threshold is /3, not /4: the dining chair was
  // itself re-modelled slimmer (2.0 -> 0.8 cu ft), so a tight ratio here would trip on a
  // change to a DIFFERENT chair. The absolute check above is the real guard.
  { const ref = P.find(r => r.type === 'upholstered_dining_chair');
    if (ref && ch.length) A(ch[0].vol < ref.vol / 3,
      `${R(ref.vol / ch[0].vol, 1)}x less timber than the dining-room chair`); }
  // CIRCULATION. The kitchen -> scullery portal is 6 ft of opening at px 20.04..26.04 in
  // the north wall. West of the nook is now bench, so the question is not "how wide a
  // full-depth lane" (nobody walks west) but how much of the opening you can step
  // through and still have room to stand — take 2.5 ft of depth as that threshold.
  const nook = [bq, tb, ...ch].filter(Boolean).flatMap(meshes);
  const depthAt = x => { const hit = nook.filter(m => m.pxLo < x && m.pxHi > x);
    return hit.length ? NWALL - Math.max(...hit.map(m => m.pzHi)) : NWALL - SWALL; };
  // Sitting the chairs opposite the bench puts one of them in front of the west half of
  // the opening — unavoidable in a 6'6" room whose only kitchen door is right here. So
  // the measure is no longer "how wide a walk-through" but "how much depth do you have
  // anywhere across the opening", and the bench's own 1.9 ft at the far west end is
  // excluded because that is the piece the doorway dies into.
  let best = 0, run = 0, minD = 99;
  for (let x = 20.0417; x <= 25.90; x += 0.02) {
    const d = Math.abs(depthAt(x)); minD = Math.min(minD, d);
    if (d > 5.0) { run += 0.02; best = Math.max(best, run); } else run = 0;
  }
  A(minD > 1.8, `${R(minD * 12, 1)} in of depth at the tightest point of the opening`);
  A(best > 1.2, `${R(best * 12, 1)} in of it is a clear walk-through, at the east jamb`);
  // The south chair backs toward the south wall — nothing asserts that elsewhere, and
  // sliding the table south to clear the doorway is exactly what would close this gap.
  if (ch.length) { const sc = ch.reduce((a, b) => (a.pzLo < b.pzLo ? a : b));
    A(sc.pzLo - SWALL > 0.5, `${R((sc.pzLo - SWALL) * 12, 1)} in behind the south chair`); }
  // Nothing may reach the back door's swing zone.
  { const east = Math.min(...nook.map(m => m.pxLo));
    A(east > 19.17 + 0.5, `nook stops ${R((east - 19.17) * 12, 1)} in short of the back door`); }
}

// ============================================================ SCULLERY DECORATION
console.log('WAINSCOT + LIGHTING');
{ const EW = 0.1459, WW = 27.8542;
  // Wall-finish meshes hang off FLOOR while placed items hang off FLOOR + 0.02, so a
  // loose mesh reads 0.066 ft lower than its authored height. The window-stool check
  // already carried a bare `- 0.066` for this; name it rather than sprinkle it.
  const LOOSE_DY = 0.066, CAP = 3.0 - LOOSE_DY;
  // WAINSCOT lives on the NORTH wall only. Its chair-rail cap is the tell: a member
  // topping out at 3.0 ft, thin in pz, running along the wall inside the room.
  const capOf = (pzLo, pzHi) => L.filter(m => Math.abs(m.yHi - CAP) < 0.03 && (m.yHi - m.yLo) < 0.35
    && m.pzLo > pzLo && m.pzHi < pzHi && (m.pxHi - m.pxLo) > 1.0 && m.pxLo > EW - 0.3 && m.pxHi < WW + 0.3);
  const nCap = capOf(NWALL - 0.35, NWALL + 0.05);
  A(nCap.length >= 2, `chair rail on the north wall, in ${nCap.length} runs (broken at the two doorways)`);
  // Two doorways at px 0.42-3.42 and 20.04-26.04 leave exactly two runs of wall.
  A(nCap.length === 2, `exactly two runs — one between each pair of openings (${nCap.length})`);
  if (nCap.length === 2) {
    const r = nCap.map(m => [R(m.pxLo,2), R(m.pxHi,2)]).sort((u,v) => u[0]-v[0]);
    console.log(`  chair rail px ${r[0][0]}-${r[0][1]} and ${r[1][0]}-${r[1][1]}`);
    A(r[0][0] > 3.42 - 0.02 && r[0][1] < 20.05, 'the long run dies at both door casings');
  }
  // ...and NOWHERE else. A dado that crept onto the south wall would sit behind the
  // galley and never be seen, so it has to be asserted rather than looked at.
  A(!capOf(SWALL - 0.05, SWALL + 0.35).length, 'no wainscot on the south wall');
  const sideCap = L.filter(m => Math.abs(m.yHi - CAP) < 0.03 && (m.yHi - m.yLo) < 0.35
    && (m.pzHi - m.pzLo) > 1.0 && m.pzLo > SWALL - 0.05 && m.pzHi < NWALL + 0.05
    && (m.pxLo < EW + 0.35 || m.pxHi > WW - 0.35));
  A(!sideCap.length, `no wainscot on the east or west walls (${sideCap.length})`);
  // Panel stiles: narrow verticals between the baseboard and the rail.
  const stiles = L.filter(m => Math.abs(m.yLo - (10 / 12 - LOOSE_DY)) < 0.06 && Math.abs(m.yHi - CAP) < 0.06
    && (m.pxHi - m.pxLo) < 0.45 && m.pzLo > NWALL - 0.35 && m.pzHi < NWALL + 0.05);
  A(stiles.length >= 8, `${stiles.length} panel stiles dividing the runs`);

  // LIGHTING. The generic per-room semi-flush must be GONE from this room — that is
  // the half of "replace the fixtures" a screenshot makes easy to miss.
  const sc = P.filter(r => r.pz < -12 && r.pz > -19);
  const has = t => sc.filter(r => r.type === t);
  A(has('pendant').length === 1, `one pendant (${has('pendant').length})`);
  A(has('sconce').length === 2, `two sconces (${has('sconce').length})`);
  A(has('undercabinet').length === 1, `under-cabinet run (${has('undercabinet').length})`);
  A(has('skylight').length === 3, `three skylights (${has('skylight').length})`);
  const tb = P.find(r => r.type === 'round_pedestal_table' && r.pz < -12);
  const pend = has('pendant')[0];
  if (pend && tb) A(Math.hypot(pend.px - tb.px, pend.pz - tb.pz) < 0.4,
    `pendant centred over the nook table (${R(Math.hypot(pend.px - tb.px, pend.pz - tb.pz) * 12, 1)} in off)`);
  // 30-36 in over the table top is the whole point of a table pendant; at 47 in it
  // reads as a room light that happens to be over the table.
  if (pend && tb) { const drop = Math.min(...meshes(pend).map(m => m.yLo)) - tb.yHi;
    A(drop > 2.4 && drop < 3.1, `hangs ${R(drop * 12, 1)} in above the table top`); }
  // Sconces: on the north wall, above the chair rail, and clear of their door casings.
  // Casings run 0.165 past each jamb, so measure to the casing edge, not the opening.
  for (const s of has('sconce')) {
    const mm = meshes(s);
    A(Math.abs(s.pz - NWALL) < 0.02, `sconce on the north wall (${R(s.pz,4)})`);
    A(Math.min(...mm.map(m => m.yLo)) > 3.0 + 0.5, `sits ${R((Math.min(...mm.map(m => m.yLo)) - 3.0) * 12, 1)} in above the chair rail`);
    const gap = Math.min(Math.abs(s.px - (3.42 + 0.165)), Math.abs(s.px - (20.0417 - 0.165)));
    A(gap > 1.0, `${R(gap * 12, 1)} in clear of the nearest door casing`);
    A(Math.max(...mm.map(m => NWALL - m.pzLo)) < 1.3, `projects ${R(Math.max(...mm.map(m => NWALL - m.pzLo)) * 12, 1)} in into the room`);
  }
  // Under-cabinet: above the worktop, below the uppers, and inside their footprint.
  const uc = has('undercabinet')[0];
  if (uc) { const mm = meshes(uc);
    const lo = Math.min(...mm.map(m => m.yLo)), hi = Math.max(...mm.map(m => m.yHi));
    A(lo > 3.08 + 0.9 && hi < 4.52, `tucked at ${R(lo * 12,1)}-${R(hi * 12,1)} in — under the 4.5 ft uppers, over the 3.08 ft worktop`);
    A(mm.every(m => m.pzHi < SWALL + 1.15), 'sits within the upper cabinets’ depth'); }
  // Skylights: on the three window lines, and their wells north of the uppers.
  const winPx = [5.33, 14.0, 21.0833];
  const sky = has('skylight').sort((u, v) => u.px - v.px);
  sky.forEach((k, i) => {
    A(Math.abs(k.px - winPx[i]) < 0.05, `skylight ${i + 1} on window line px ${winPx[i]} (${R(k.px,3)})`);
    // 2'0" x 4'0". The south edge is pinned by the galley uppers, so the only way to
    // enlarge these is northward — which is why the pair of clearances is asserted
    // rather than the size alone.
    A(Math.abs((k.pzHi - k.pzLo) - 4.0) < 0.05, `4 ft deep (${R(k.pzHi - k.pzLo, 2)})`);
    A(Math.abs((k.pxHi - k.pxLo) - 2.0) < 0.05, `2 ft wide, unchanged (${R(k.pxHi - k.pxLo, 2)})`);
    A(k.pzLo > SWALL + 1.1, `its well clears the galley uppers by ${R((k.pzLo - (SWALL + 1.1)) * 12, 1)} in`);
    A(NWALL - k.pzHi > 0.8, `${R((NWALL - k.pzHi) * 12, 1)} in of ceiling left at the north wall`);
    // THE WELL HAS TO MEET THE CEILING. The lining is drawn from `ceilFt` above the
    // item's own origin, and placed furniture is lifted FLOOR + 0.02 — so it used to
    // start 20 mm above the TOP of the 60 mm slab and you could see straight through
    // the slot, as a thin black line, looking up the well. Measured in world metres
    // against the real ceiling, not against the nominal height that caused the bug.
    const under = raw.ceilingY - 0.06;                 // ceilings.js slab thickness
    const wellLo = raw.items.find(r => r.type === 'skylight'
      && Math.abs(-r.max[0] / FT - k.pxLo) < 0.01).min[1];
    A(wellLo <= under + 0.0005,
      `its lining reaches the ceiling underside (${R((wellLo - under) * 1000, 1)} mm, must not be above it)`);
    A(wellLo > under - 0.02,
      `and does not dangle below it (${R((under - wellLo) * 1000, 1)} mm past)`);
    // The roof springs from the ceiling at the south eave and rises 0.45/ft north, so
    // the glazing must sit ABOVE the 9 ft ceiling or the well has no depth at all.
    A(k.yHi > 9.5, `glazing ${R((k.yHi - 9.0) * 12, 1)} in above the ceiling at its high edge`);
  });
}

// ============================================================ EXTENSION FIXTURES
// Laundry pair, the shower room's walk-in, and the WC's toilet + vanity.
console.log('EXTENSION FIXTURES');
{ const LS = -11.688, BE = -22.688, BW = -17.687, BN = 3.771;   // interior faces
  const ext = P.filter(r => r.px < -11.9);
  // The wall between the BATH and the WATER CLOSET compartment at its north end.
  // Derived, not written out: it was the literal -8.3, then the bath's own south
  // bound, and went stale each time the plan moved. North of it is the WC.
  const PART = JSON.parse(readFileSync('ifc/rooms/wc.json', 'utf8')).bounds.z1;

  // LAUNDRY: washer and dryer side by side, backs to the south wall.
  { const pair = ext.filter(r => r.type === 'appliance' && /washer|dryer/.test(r.kind)).sort((a, b) => a.px - b.px);
    A(pair.length === 2, `washer and dryer (${pair.length})`);
    if (pair.length === 2) {
      A(pair.every(m => Math.abs(m.pzLo - LS) < 0.06), 'both back onto the south wall');
      A(pair[1].pxLo - pair[0].pxHi > 0.02, `side by side, ${R((pair[1].pxLo - pair[0].pxHi) * 12, 1)} in apart`);
      A(pair[0].pxLo > -17.29 && pair[1].pxHi < -12.17, 'the pair fits between the side walls');
      A(Math.abs(Math.max(...pair.map(m => m.yHi)) - 3.0) < 0.1, `${R(Math.max(...pair.map(m => m.yHi)) * 12, 0)} in tall`);
      // BUILT IN: a worktop bridges the pair, and a wall cabinet hangs over it.
      const runs = ext.filter(r => r.type === 'cabinet_run');
      const base = runs.find(r => r.kind === 'base'), up = runs.find(r => r.kind === 'wall');
      A(!!base, 'a counter runs over the machines');
      if (base) {
        const top = Math.max(...meshes(base).map(m => m.yHi));
        A(Math.abs(top - 3.33) < 0.06, `worktop at ${R(top * 12, 1)} in — above a kitchen counter, as a laundry one is`);
        const clear = 3.25 - Math.max(...pair.map(m => m.yHi));
        A(clear > 0.1, `${R(clear * 12, 1)} in between the machine tops and the worktop`);
        A(base.pxHi - base.pxLo > 4.9, `spans the full ${R(base.pxHi - base.pxLo, 2)} ft wall to wall`);
        // The whole run is machine bay, so there should be no carcass under the worktop —
        // no toe kick, no doors. Only the counter and its splash.
        A(!meshes(base).some(m => m.yHi < 0.5 && m.yHi > 0.1), 'no toe kick — the bay is all machine');
      }
      const ups = runs.filter(r => r.kind === 'wall');
      A(ups.length === 2, `wall cabinets above, in two bands (${ups.length})`);
      if (ups.length && base) {
        const mm = ups.flatMap(meshes);
        const lo = Math.min(...mm.map(m => m.yLo)), hi = Math.max(...mm.map(m => m.yHi));
        A(Math.abs(lo - 4.75) < 0.08, `start at ${R(lo * 12, 0)} in`);
        A(Math.abs(hi - 9.0) < 0.08, `run to ${R(hi * 12, 0)} in — the ceiling`);
        // The break sits on the 7 ft head line, as it does in the scullery.
        const tops = ups.map(r => Math.max(...meshes(r).map(m => m.yHi))).sort((a, b) => a - b);
        A(Math.abs(tops[0] - 7.0) < 0.08, `the two bands meet on the head line (${R(tops[0], 2)})`);
        A(lo - Math.max(...meshes(base).map(m => m.yHi)) > 1.1,
          `${R((lo - Math.max(...meshes(base).map(m => m.yHi))) * 12, 1)} in of clear splash between counter and cabinet`);
        A(ups.every(r => Math.abs(r.pzLo - LS) < 0.08), 'hung on the south wall, over the machines');
      }
    } }

  // VESTIBULE: built-in bench on the east wall, running off the south wall. It has to
  // clear the entry door's swing and leave a walkable aisle to the family room door.
  { const b = ext.find(r => r.type === 'mudroom_bench');
    const VE = -17.229, VW = -12.229, VS = -4.171;      // vestibule interior faces
    A(!!b, 'built-in bench in the vestibule');
    if (b) {
      A(Math.abs(b.pxLo - VE) < 0.06, `backs onto the east wall (${R(b.pxLo,3)})`);
      A(Math.abs(b.pzLo - VS) < 0.06, `runs off the south wall (${R(b.pzLo,3)})`);
      A(Math.abs((b.pzHi - b.pzLo) - 5.0) < 0.06, `${R(b.pzHi - b.pzLo, 2)} ft long`);
      const mm = meshes(b);
      // FINISHED seat = the top of the cushion. The timber deck sits a squab lower,
      // which is the whole point of building it upholstered rather than laying a pad
      // on an 18 in deck and ending up at nearly 21.
      // Bounded to the SEAT band: the shelf and the boarded back also run the full
      // length, and unbounded this picked the shelf at 71 in as the "cushion".
      const wide = mm.filter(m => (m.pzHi - m.pzLo) > 4.0 && m.yHi > 1.2 && m.yHi < 1.8)
        .sort((u, v) => v.yHi - u.yHi);
      // Below the cushion ENTIRELY — the welt piping runs the same length and sits at
      // the squab's mid-height, so "first one lower" finds the piping, not the deck.
      const squab = wide[0], deck = wide.find(m => m.yHi <= squab.yLo + 0.01);
      A(!!squab && Math.abs(squab.yHi - 1.55) < 0.05, `finished seat at ${R(squab.yHi * 12, 1)} in — cushion top`);
      A(!!squab && Math.abs((squab.yHi - squab.yLo) - 0.20) < 0.04,
        `upholstered: a ${R((squab.yHi - squab.yLo) * 12, 1)} in squab, not a painted slab`);
      A(!!deck && Math.abs(deck.yHi - 1.35) < 0.05, `timber deck at ${R((deck ? deck.yHi : 0) * 12, 1)} in, under it`);
      // The squab is inset from the nosed timber seat — a cushion flush to the edge
      // reads as a second slab.
      A(!!deck && squab.pxLo > deck.pxLo + 0.02 && squab.pxHi < deck.pxHi - 0.02,
        `squab inset ${R((squab.pxLo - deck.pxLo) * 12, 1)} in behind the seat's nosed edge`);
      // SHOE CUBBIES: vertical boards running the full depth, stopping under the seat.
      const divs = mm.filter(m => (m.pzHi - m.pzLo) < 0.12 && (m.pxHi - m.pxLo) > 1.2
        && m.yLo > 0.25 && m.yHi < 1.3).sort((u, v) => u.pz - v.pz);
      A(divs.length === 5, `4 shoe cubbies — 2 gables + 3 dividers (${divs.length} boards)`);
      if (divs.length === 5) {
        const gaps = divs.slice(1).map((d, i) => d.pzLo - divs[i].pzHi);
        A(gaps.every(g => Math.abs(g - gaps[0]) < 0.02), `bays even at ${R(gaps[0] * 12, 1)} in`);
        A(gaps[0] > 0.9, `each bay ${R(gaps[0] * 12, 1)} in wide — a pair of shoes`);
      }
      // Opening: cubby floor up to the underside of the front seat rail. Shoes need
      // real height here, which is why the rail is slim and the floor sits on the plinth.
      if (divs.length) {
        const open = Math.min(...divs.map(d => d.yHi)) - Math.max(...divs.map(d => d.yLo));
        A(open > 0.66, `${R(open * 12, 1)} in of opening — clears a shoe`);
      }
      // Framing that is actually doing work: a front rail tying the tops of the gables.
      // Near the FRONT face specifically — the cubby back panel has the same section
       // and height, and would otherwise be counted as the rail.
      const frontRail = mm.filter(m => (m.pzHi - m.pzLo) > 4.0 && (m.pxHi - m.pxLo) < 0.12
        && m.yHi > 1.1 && m.yHi < 1.3 && m.pxHi > b.pxHi - 0.15);
      A(frontRail.length >= 1, `front seat rail across the cubby tops (${frontRail.length})`);
      A(Math.max(...mm.map(m => m.yHi)) > 5.7, `boarded back and shelf to ${R(Math.max(...mm.map(m => m.yHi)) * 12, 0)} in`);
      // Pegs: small brass members standing off the rail, around 55 in.
      const pegs = mm.filter(m => Math.abs((m.yLo + m.yHi) / 2 - 4.58) < 0.2
        && (m.pzHi - m.pzLo) < 0.2 && (m.pxHi - m.pxLo) < 0.45);
      A(pegs.length >= 5, `${pegs.length} peg members on the rail`);
      // CIRCULATION: the entry door pivots on the wall centreline pz 4.0 with a 3 ft
      // leaf, so its tip reaches pz 1.0 — the bench must stop short of that.
      A(b.pzHi < 1.0, `stops ${R((1.0 - b.pzHi) * 12, 1)} in clear of the open entry door`);
      A(VW - b.pxHi > 3.0, `${R(VW - b.pxHi, 2)} ft of aisle to the family room door`);
      // NO END CHEEKS. A cheek is the give-away shape: a full-depth panel standing the
      // whole height of the back at one end. Nothing in the bench should match that —
      // the shelf is full height but only 0.35 ft deep, the back only 0.06 ft.
      const cheeks = mm.filter(m => (m.yHi - m.yLo) > 5.0 && (m.pxHi - m.pxLo) > 1.2
        && (m.pzHi - m.pzLo) < 0.4);
      A(cheeks.length === 0, `no end cheeks — the bench is open at both ends (${cheeks.length})`);
      // and with the cheeks gone the plinth and peg rail run the FULL length, not the
      // length minus two cheek thicknesses.
      const rail = mm.filter(m => Math.abs((m.yLo + m.yHi) / 2 - 4.58) < 0.25 && (m.pzHi - m.pzLo) > 3.0)
        .sort((u, v) => (v.pzHi - v.pzLo) - (u.pzHi - u.pzLo))[0];
      A(!!rail && Math.abs((rail.pzHi - rail.pzLo) - 5.0) < 0.06,
        `peg rail runs the full 5 ft (${R(rail ? rail.pzHi - rail.pzLo : 0, 2)})`);
    } }

  // FULL-LENGTH MIRROR on the vestibule's SOUTH wall — a fit check on the way out.
  { const VE = -17.229, VW = -12.229, VS = -4.171;      // vestibule interior faces
    const mir = ext.find(r => r.type === 'wall_mirror');
    A(!!mir, 'full-length mirror in the vestibule');
    if (mir) {
      A(Math.abs(mir.pzLo - VS) < 0.08, `hung on the south wall (${R(mir.pzLo, 3)} vs ${VS})`);
      A(mir.pxHi - mir.pxLo > 2.0, `${R(mir.pxHi - mir.pxLo, 2)} ft wide`);
      // 18 in clears the arc a toe swings through, and matches the bench's finished
      // seat on the next wall. It costs nothing in what you can see: to catch your own
      // feet the glass only has to reach HALF your eye height (~32 in at 5'10"), so
      // "raise it" and "still full length" are not in tension here.
      A(Math.abs(mir.yLo - 1.5) < 0.08, `foot ${R(mir.yLo * 12, 0)} in off the floor — clear of toes`);
      // The top then lands on the 7 ft door-head line used across this level, so it
      // aligns with the heads of the two vestibule doors rather than floating.
      A(Math.abs(mir.yHi - 7.0) < 0.08, `tops out on the 7 ft head line (${R(mir.yHi * 12, 0)} in)`);
      A((mir.pzHi - mir.pzLo) < 0.3, `sits flat on the wall, ${R((mir.pzHi - mir.pzLo) * 12, 1)} in proud`);
      // It shares the south wall with the bench, which runs off that wall 1.5 ft deep.
      // The glass has to start past the bench or you are looking at the end of it.
      const b2 = ext.find(r => r.type === 'mudroom_bench');
      if (b2) A(mir.pxLo > b2.pxHi, `clear of the bench by ${R((mir.pxLo - b2.pxHi) * 12, 1)} in`);
      A(VW - mir.pxHi > 0.4, `${R((VW - mir.pxHi) * 12, 1)} in clear of the west wall`);
      // A mirror is glass in a frame, not a painted panel: the frame members stand
      // proud of the glass, so the deepest mesh is not the widest one.
      const mmm = meshes(mir);
      A(mmm.length >= 6, `framed: ${mmm.length} members (backing, glass, 2 stiles, 2 rails)`);
    } }

  // ONE OPEN BATH, AND A WATER CLOSET. The partition that split the wing's east rooms is
  // gone: shower (south end, under its transom) and vanity (under the north east window)
  // share one room, and the toilet is enclosed in a compartment across the north end.
  // Everything that can be is read from the room files — the window the vanity centres
  // on, the door and window that size the shower, the compartment wall — because every
  // literal here has gone stale on every move.
  const bathJ = JSON.parse(readFileSync('ifc/rooms/ext_bath.json', 'utf8'));
  const wcJ = JSON.parse(readFileSync('ifc/rooms/wc.json', 'utf8'));
  const lauJ = JSON.parse(readFileSync('ifc/rooms/ext_laundry.json', 'utf8'));
  const bathWin = bathJ.windows.find(w => w.name === 'Window - Bath E');
  const wcWinE = bathJ.windows.find(w => w.name === 'Window - WC E');
  const wcWinS = bathJ.windows.find(w => w.orient === 'H');
  const lauDoor = lauJ.doors.find(d => d.name === 'Laundry -> Bath');
  const vanSpec = bathJ.interior.furniture.find(f => f.type === 'vanity');
  const PARTS = PART - 0.22915;                   // the compartment wall's south face
  // Window trim on the east wall, per WINDOW: the jamb casings, the stool, the apron.
  // Loose (wall-finish) meshes read DY low; a jamb is 0.25-0.45 wide and runs sill to head.
  const BEW = -22.68785, DY = 0.066;
  const eastTrim = (win) => {
    const zLo = win.pos - win.width / 2 - 1.0, zHi = win.pos + win.width / 2 + 1.0;
    const on = (m) => m.pxLo > BEW - 0.05 && m.pxHi < BEW + 0.30 && m.pzLo > zLo && m.pzHi < zHi;
    const posts = L.filter(m => on(m) && (m.pzHi - m.pzLo) > 0.25 && (m.pzHi - m.pzLo) < 0.45
      && Math.abs(m.yLo - (3.0 - DY)) < 0.12 && m.yHi > 6.5);
    const minRun = win.width - 0.1;
    const stool = L.filter(m => on(m) && (m.pzHi - m.pzLo) > minRun && m.yHi > 3.0 - DY && m.yHi < 3.2);
    const apron = L.filter(m => on(m) && (m.pzHi - m.pzLo) > minRun && m.yHi < 3.0 - DY + 0.02 && m.yLo > 2.4);
    return { posts, stool, apron };
  };
  const bathTrim = eastTrim(bathWin), wcTrim = eastTrim(wcWinE);

  // THE COMPARTMENT: a WALL-HUNG toilet on the EAST wall facing west. The door is at the
  // west end of the compartment wall swinging in, so a toilet on the west wall would
  // stand in its swing; on the east wall the bowl's front is what the leaf's line has to
  // clear, and a wall-hung bowl (1.85 ft) buys the clearance a floor-standing one (2.0)
  // does not. 15 in each side of the centreline, 21 in in front to the west wall.
  { const t = ext.find(r => r.type === 'wall_toilet');
    A(!!t, 'a WALL-HUNG toilet in the water closet');
    A(!ext.some(r => r.type === 'toilet'), 'and no floor-standing one left in the wing');
    if (t) {
      A(t.pz > PART, `north of the compartment wall (${R(t.pz, 2)} vs ${R(PART, 3)})`);
      A(Math.abs(t.pxLo - BE) < 0.08, `flush plate on the EAST wall (${R(t.pxLo, 3)})`);
      A(t.pxHi - BE > 1.7 && t.pxHi - BE < 2.0, `bowl projects ${R((t.pxHi - BE) * 12, 1)} in from the wall`);
      A(BN - t.pz >= 1.25 - 0.01, `${R((BN - t.pz) * 12, 1)} in centreline to the north wall (15 min)`);
      A(t.pz - (PART + 0.22915) >= 1.25 - 0.01,
        `${R((t.pz - PART - 0.22915) * 12, 1)} in centreline to the compartment wall (15 min)`);
      A(BW - t.pxHi >= 1.75, `${R((BW - t.pxHi) * 12, 0)} in in front of the bowl to the west wall (21 min)`);
      const spec = wcJ.doors.find(d => d.name === 'Bath -> WC');
      const hingeE = spec.pos - spec.width / 2;                  // the leaf's line when open
      A(hingeE - t.pxHi >= 0.25,
        `bowl front ${R((hingeE - t.pxHi) * 12, 1)} in clear of the door's hinge line (3 in min)`);
      const low = meshes(t).filter(m => m.yLo < 0.7);
      A(low.length === 0, `clear floor under it — no pedestal (${low.length} members below 8 in)`);
      const clear = BN - (PART + 0.22915);
      A(clear >= 2.5, `the compartment is ${R(clear * 12, 1)} in clear (30 min)`);
    } }

  // SHOWER: south end, against the south wall on the transom's axis. 5 x 3 — a 60 x 36
  // alcove — and the 3 is FORCED: the glass line has to clear the laundry door's south
  // jamb and the east window's casing, and at 4 ft deep it crossed both. Both measured.
  { const sh = ext.find(r => r.type === 'shower');
    A(!!sh, 'walk-in shower — at the south end, under its transom');
    if (sh) {
      const w = sh.pxHi - sh.pxLo, d = sh.pzHi - sh.pzLo;
      // Reads 0.3 over on each axis: the tiled surround straddles the wall lines.
      A(Math.abs(w - 5.3) < 0.2 && Math.abs(d - 3.3) < 0.2, `${R(w, 2)} x ${R(d, 2)} ft — a 60 x 36 alcove`);
      A(Math.abs(sh.pzLo - LS) < 0.2, `set against the south wall (${R(sh.pzLo, 2)} vs ${R(LS, 2)})`);
      A(!!wcWinS && Math.abs(sh.px - wcWinS.pos) < 0.02,
        `centred on the transom's axis (${R(sh.px, 4)} vs ${wcWinS ? wcWinS.pos : '?'})`);
      const open = sh.pzHi;                                        // the glass line
      const jambS = lauDoor ? lauDoor.pos - lauDoor.width / 2 : NaN;
      A(!!lauDoor && open < jambS - 0.02,
        `glass line ${R((jambS - open) * 12, 1)} in clear of the laundry door's south jamb (${R(jambS, 3)})`);
      const casS = Math.min(...wcTrim.posts.map(m => m.pzLo));
      A(wcTrim.posts.length >= 2 && open < casS - 0.02,
        `...and ${R((casS - open) * 12, 1)} in clear of the east window's casing (${R(casS, 3)})`);
      const mm = meshes(sh);
      const atOpening = (m) => Math.abs((m.pzLo + m.pzHi) / 2 - open) < 0.3 && (m.pzHi - m.pzLo) < 0.5;
      const east = mm.filter(m => atOpening(m) && (m.pxLo + m.pxHi) / 2 < sh.px);
      const west = mm.filter(m => atOpening(m) && (m.pxLo + m.pxHi) / 2 > sh.px);
      A(east.length >= 2, `pony wall and glass close the EAST half (${east.length} members)`);
      A(west.length === 0, `the WEST half is open — the entrance, on the door's side (${west.length} members)`);
      const pony = east.filter(m => m.yLo < 0.1).sort((a, b) => b.yHi - a.yHi)[0];
      A(!!pony && pony.yHi > 3.0 && pony.yHi < 3.8, `pony wall stands ${R((pony ? pony.yHi : 0) * 12, 0)} in`);
      A(east.some(m => m.yLo > 3.0 && m.yHi > 8.9), 'glass carries on above it, to the ceiling');
      A(Math.abs(Math.max(...mm.map(m => m.yHi)) - 9.0) < 0.08,
        `enclosure tiled to ${R(Math.max(...mm.map(m => m.yHi)) * 12, 0)} in — the ceiling`);
      A(mm.filter(m => m.yHi > 8.9).length >= 3, 'back and both sides all reach it');
      A(!mm.some(m => m.yHi < 0.4 && m.yHi > 0.15 && (m.pxHi - m.pxLo) > 1.0), 'curbless — no threshold across the opening');
      A(!!wcWinS && wcWinS.sill >= 5.5, `the transom over it sills at ${wcWinS ? wcWinS.sill : '?'} ft`);
    } }

  // VANITY: on the east wall BETWEEN the two windows, centred on their midpoint, with a
  // mirror between the casings and a sconce each side of it. The counter is the default
  // height — nothing sits over it now.
  const v = ext.find(r => r.type === 'vanity');
  const mid = (bathWin.pos + wcWinE.pos) / 2;
  const casN = bathTrim.posts.length ? Math.min(...bathTrim.posts.map(m => m.pzLo)) : NaN;   // north window's south casing edge
  const casS = wcTrim.posts.length ? Math.max(...wcTrim.posts.map(m => m.pzHi)) : NaN;       // south window's north casing edge
  let mir = null;
  { A(!!v, 'vanity in the bath');
    if (v) {
      A(Math.abs(v.pz - mid) < 0.02, `centred on the wall BETWEEN the two east windows (${R(v.pz, 4)} vs ${R(mid, 4)})`);
      A(Math.abs(v.pxLo - BE) < 0.12, `backs onto the east wall (${R(v.pxLo, 3)})`);
      A(!isNaN(casN) && !isNaN(casS) && v.pzHi < casN - 1 / 12 && v.pzLo > casS + 1 / 12,
        `counter clears both casings (${R((casN - v.pzHi) * 12, 1)} in north, ${R((v.pzLo - casS) * 12, 1)} in south)`);
      A(v.pxHi - v.pxLo > 1.7, `${R(v.pxHi - v.pxLo, 2)} ft deep`);
      A(!!vanSpec && v.pzHi - v.pzLo > vanSpec.widthFt, `${R(v.pzHi - v.pzLo, 2)} ft of counter over a ${vanSpec ? vanSpec.widthFt : '?'} ft cabinet`);
      const mm = meshes(v);
      mir = mm.filter(m => m.yHi > 5.0 && (m.pxHi - m.pxLo) < 0.25).sort((a2, b2) => b2.yHi - a2.yHi)[0] || null;
      A(!!mir && Math.abs(mir.yHi - 6.5) < 0.08, `mirror tops out at ${R((mir ? mir.yHi : 0) * 12, 0)} in`);
      A(!!mir && mir.yLo > 3.1, `its foot clears the counter by ${R(((mir ? mir.yLo : 0) - 3.05) * 12, 1)} in`);
      A(!!mir && mir.pzLo > casS && mir.pzHi < casN, 'and it hangs between the two casings');
      const top = Math.max(...mm.filter(m => (m.pzHi - m.pzLo) > 2.5).map(m => m.yHi));
      A(Math.abs(top - 3.05) < 0.03, `counter at ${R(top * 12, 1)} in — the default, with nothing over it`);
      const fronts = mm.filter(m => (m.pxHi - m.pxLo) < 0.12 && m.yHi < 3.0
        && (m.yHi - m.yLo) > 1.0 && (m.pzHi - m.pzLo) > 0.5);
      A(fronts.length === 2, `two door fronts (${fronts.length}) — the 3x3 default is nine`);
    } }

  // LIGHTING. Sconces flank the MIRROR, inside the casings; downlights over the shower,
  // the room, the vanity and the north end, and one in the compartment.
  { const sc = ext.filter(r => r.type === 'sconce');
    A(sc.length === 2, `two sconces at the mirror (${sc.length})`);
    if (sc.length === 2 && mir) {
      A(sc.every(m => Math.abs(m.pxLo - BE) < 0.1), 'both on the east wall');
      A(sc.every(m => m.pxHi - m.pxLo < 0.9), `each projects ${R(Math.max(...sc.map(m => m.pxHi - m.pxLo)) * 12, 1)} in`);
      const pz = sc.map(m => m.pz).sort((a2, b2) => a2 - b2);
      A(pz[0] < mir.pzLo - 0.15 && pz[1] > mir.pzHi + 0.15 && pz[0] > casS + 0.15 && pz[1] < casN - 0.15,
        `one each side of the mirror, clear of it and of the casings (${R(casS, 2)} | ${R(pz[0], 2)} | mirror ${R(mir.pzLo, 2)}..${R(mir.pzHi, 2)} | ${R(pz[1], 2)} | ${R(casN, 2)})`);
      A(sc.every(m => Math.abs((m.yLo + m.yHi) / 2 - 5.0) < 0.5), 'hung at 5 ft');
    }
    const cans = ext.filter(r => r.type === 'recessed');
    A(cans.length === 5, `five downlights — four in the bath, one in the WC (${cans.length})`);
    A(cans.every(c => Math.abs(c.yHi - 9.0) < 0.06), 'all flush with the ceiling');
    const nB = cans.filter(c => c.pz < PART).length, nW = cans.filter(c => c.pz > PART).length;
    A(nB === 4 && nW === 1, `four bath, one WC (${nB}/${nW}) about the compartment wall at ${R(PART, 3)}`);
    A(cans.some(c => Math.abs(c.pz - mid) < 0.05 && c.px < -20.8), 'one of them over the vanity');
    const hung = L.filter(m => m.pxLo > -22.75 && m.pxHi < -17.6 && m.pzLo > -11.75 && m.pzHi < 3.85
      && (m.yLo + m.yHi) / 2 > 7.9 && (m.yLo + m.yHi) / 2 < 8.8
      && (m.pxHi - m.pxLo) < 1.5 && (m.pzHi - m.pzLo) < 1.5);
    A(hung.length === 0, `no ceiling fixture hanging in either room (${hung.length})`);
  }

  // WINDOW TRIM on the east wall, both windows: jambs, stool AND apron on each — nothing
  // sits under either now, so the apron is back on the north one.
  for (const [label, win, trim] of [['north', bathWin, bathTrim], ['south', wcWinE, wcTrim]]) {
    const want = [win.pos - win.width / 2, win.pos + win.width / 2].map(v2 => R(v2, 2));
    A(trim.posts.length === 2, `a jamb casing each side of the ${label} window (${trim.posts.length} of 2)`);
    A(trim.posts.every(m => m.nv >= 100), 'every one a swept profile, not a box');
    const at = trim.posts.map(m => R((m.pzLo + m.pzHi) / 2, 2)).sort((u, v2) => u - v2);
    A(at.length === 2 && at.every((v2, i) => Math.abs(v2 - want[i]) < 0.06), `they land on the opening: ${at.join(', ')}`);
    A(trim.stool.length >= 1, `a stool at the sill (${trim.stool.length})`);
    A(trim.apron.length >= 1 && trim.apron.some(m => m.nv >= 100), `a moulded apron under it (${trim.apron.length})`);
    if (trim.apron.length && trim.stool.length) {
      const a0 = trim.apron.sort((u, v2) => (v2.pzHi - v2.pzLo) - (u.pzHi - u.pzLo))[0];
      const s0 = trim.stool.sort((u, v2) => (v2.pzHi - v2.pzLo) - (u.pzHi - u.pzLo))[0];
      A(Math.abs(a0.pzLo - s0.pzLo) < 0.02 && Math.abs(a0.pzHi - s0.pzHi) < 0.02,
        `dies flush with the stool (${R(a0.pzLo, 2)}..${R(a0.pzHi, 2)})`);
    }
  }

  // THE ROUND WINDOW, from inside the water closet. The IFC hole is the generator's
  // business (ifc_check); what is asserted here is the FINISH round it: that no flat
  // field band runs across the glass — the 1-D program would happily plaster over a
  // circle centred on the head line, which is exactly what it did before the holed
  // panel existed — that the field over its span IS a holed panel (a swept shape, not a
  // 24-vertex box), and that a round casing sits centred on the glass. Loose meshes read
  // DY low, as everywhere.
  { const rw = wcJ.windows.find(w => w.round);
    A(!!rw, 'a round window authored in the WC');
    if (rw) {
      const cy = rw.centerFt - DY, Rr = rw.radiusFt;
      // The ring stands 0.1 ft proud of the panel INTO the room, so the north-wall test
      // has to reach that far off the face — at 0.05 it missed the ring entirely.
      // Along the wall the field bands run to the room's BOUNDS (-22.917 / -17.458), not
      // to its faces — a filter clipped at the faces silently dropped a band running
      // straight across the glass, and the negative control caught it.
      const onNorth = (m) => m.pzLo > BN - 0.2 && m.pzHi < BN + 0.4 && m.pxLo > -23.0 && m.pxHi < -17.3;
      const overDisc = L.filter(m => onNorth(m) && m.pxHi > rw.pos - Rr + 0.1 && m.pxLo < rw.pos + Rr - 0.1
        && m.yHi > cy - Rr + 0.1 && m.yLo < cy + Rr - 0.1);
      const boxes = overDisc.filter(m => m.nv <= 30);
      A(boxes.length === 0, `no flat band runs across the glass (${boxes.length} boxes cross the disc)`);
      const panel = overDisc.filter(m => m.nv > 60 && (m.pzHi - m.pzLo) < 0.08 && m.yLo < cy - Rr - 0.5 && m.yHi > cy + Rr + 0.3);
      A(panel.length >= 1, `the field over it is a holed panel, floor to ceiling (${panel.length}, ${panel[0] ? panel[0].nv : 0} verts)`);
      const ring = overDisc.filter(m => Math.abs((m.pxLo + m.pxHi) / 2 - rw.pos) < 0.03
        && Math.abs((m.yLo + m.yHi) / 2 - cy) < 0.05
        && (m.pxHi - m.pxLo) > 2 * Rr + 0.3 && (m.pxHi - m.pxLo) < 2 * Rr + 1.0);
      A(ring.length >= 1, `a ring casing centred on the glass, ${R(ring[0] ? ring[0].pxHi - ring[0].pxLo : 0, 2)} ft across`);
      A(ring.length >= 1 && Math.abs((ring[0].yHi - ring[0].yLo) - (ring[0].pxHi - ring[0].pxLo)) < 0.03, '...and round');
      A(ring.length >= 1 && ring[0].nv >= 200, `...a revolved casing profile, not a torus (${ring[0] ? ring[0].nv : 0} verts)`);
    } }
}

// ============================================================ EAST EXTENSION
// Laundry / bath / WC / vestibule. An open leaf stands perpendicular to its wall, so
// the thin axis of its box IS the hinge jamb — which is what these measure.
console.log('EXTENSION');
{ const leaf = (re) => (raw.doorLeaves || []).find(d => re.test(d.name));
  const midPx = (d) => (d.pxLo + d.pxHi) / 2, midPz = (d) => (d.pzLo + d.pzHi) / 2;

  // WC DOOR: at the WEST end of the compartment wall — on the aisle past the vanity —
  // hung on its EAST jamb and swinging IN, so the open leaf stands inside the compartment
  // between the door and the wall-hung bowl on the east wall, with its tip short of the
  // north wall. Every number is the room file's.
  { const d = leaf(/Bath -> WC/);
    A(!!d, 'WC door leaf found');
    if (d) {
      const wcJ2 = JSON.parse(readFileSync('ifc/rooms/wc.json', 'utf8'));
      const spec = wcJ2.doors.find(x => x.name === 'Bath -> WC');
      const eastJamb = spec.pos - spec.width / 2, westJamb = spec.pos + spec.width / 2, wall = wcJ2.bounds.z1;
      const BW2 = -17.687, BN2 = 3.771;
      A(Math.abs((BW2 - westJamb) - 0.5) < 0.03,
        `opening at the WEST end, ${R((BW2 - westJamb) * 12, 1)} in of casing return to the party wall`);
      A(Math.abs(midPx(d) - eastJamb) < 0.04, `hung on the EAST jamb (px ${R(midPx(d), 3)} vs ${R(eastJamb, 3)})`);
      A(d.pzLo >= wall - 0.02 && d.pzHi > wall + 2.0,
        `swings IN to the water closet (pz ${R(d.pzLo, 2)}..${R(d.pzHi, 2)}, wall at ${R(wall, 3)})`);
      A(d.pzHi < BN2 - 0.1, `its tip clears the north wall by ${R((BN2 - d.pzHi) * 12, 1)} in`);
      const t = P.find(r => r.type === 'wall_toilet');
      if (t) A(t.pxHi < eastJamb - 0.25, `the leaf's line clears the bowl by ${R((eastJamb - t.pxHi) * 12, 1)} in`);
    } }

  // LAUNDRY -> BATH is a POCKET DOOR. Its 3 ft in-swing used to stand in the middle of a
  // 5 ft room, a hand's width off the shower glass. Open, the leaf now lies INSIDE the
  // party wall south of its jamb — so what is asserted is that the open leaf's box sits
  // in the wall's plane and south of the opening, not out in either room.
  { const d = leaf(/Laundry -> Bath/);
    A(!!d, 'laundry/bath door leaf found');
    if (d) {
      const lau = JSON.parse(readFileSync('ifc/rooms/ext_laundry.json', 'utf8'));
      const spec = lau.doors.find(x => x.name === 'Laundry -> Bath');
      const jambS = spec.pos - spec.width / 2;
      A(spec.sliding === true, 'authored as a pocket door');
      A(Math.abs(midPx(d) - spec.fixed) < 0.12, `the open leaf lies in the wall's plane (px ${R(midPx(d), 3)} vs ${R(spec.fixed, 4)})`);
      A(d.pzHi < jambS + 0.25 && d.pzLo > -11.7,
        `...in the pocket south of the jamb (pz ${R(d.pzLo, 2)}..${R(d.pzHi, 2)}, jamb ${R(jambS, 3)})`);
      const wide = Math.abs(d.pzHi - d.pzLo);
      A(Math.abs(wide - spec.width) < 0.06, `${R(wide, 2)} ft leaf — a full 3 ft door`);
    } }

  // TWIN DOORS, side by side on the family room's east wall.
  { const v = leaf(/Family -> Ext Vestibule/), l = leaf(/Family -> Ext Laundry/);
    A(!!v && !!l, 'both extension doors open off the family room');
    if (v && l) {
      // Family room runs pz -11.917..0; a door hinged outside that opens off another room.
      for (const [n, d] of [['vestibule', v], ['laundry', l]])
        A(midPz(d) > -11.9 && midPz(d) < 0, `${n} door is on the family room's wall (pz ${R(midPz(d),2)})`);
      // Each door hangs on the jamb NEAREST its own room's far side: the vestibule on
      // its north jamb, the laundry on its north jamb too. So the pier is between the
      // vestibule's OTHER jamb (3 ft south of its hinge) and the laundry's hinge.
      A(Math.abs(midPz(v) - (-0.87)) < 0.06, `vestibule door hangs on its NORTH jamb (pz ${R(midPz(v),2)})`);
      A(Math.abs(midPz(l) - (-4.93)) < 0.06, `laundry door hangs on its north jamb (pz ${R(midPz(l),2)})`);
      const vSouth = midPz(v) - 3.0;                  // its other jamb, one door width away
      const pier = vSouth - midPz(l);
      A(pier > 0.9 && pier < 1.3, `${R(pier * 12, 1)} in of pier between the two openings`);
      A(Math.abs((vSouth + midPz(l)) / 2 - (-4.4)) < 0.08,
        `partition sits on the pier centreline (${R((vSouth + midPz(l)) / 2, 2)} vs -4.40)`);
      A(v.parts === 9, `vestibule door is an 8-lite leaf: ${v.parts} members`);
      // They serve different rooms, so they swing apart rather than into each other.
      A((midPx(v) > -12) !== (midPx(l) > -12),
        'they swing apart — one into the family room, one into the laundry');
    } }

  // DOOR TRIM on the family room's east wall — the two extension openings. Casing is
  // wall-finish geometry, so it lands in the `loose` list and reads LOOSE_DY low.
  { const EW = -11.77085, DY = 0.066;
    const onWall = (m) => m.pxLo > EW - 0.05 && m.pxHi < EW + 0.30 && m.pzLo > -11.95 && m.pzHi < 0.05;
    // Jambs run to the TOP of the head now, not to the head line: they mitre into it.
    const posts = L.filter(m => onWall(m) && (m.pzHi - m.pzLo) < 0.45 && m.yLo < 0.05 && m.yHi > 6.5);
    A(posts.length === 4, `four casing jambs, two per opening (${posts.length})`);
    A(posts.every(m => m.yHi > 7.2 - DY), 'each runs past the head line to mitre into the head');
    A(posts.every(m => m.nv >= 100), 'moulded, the same section as the windows');
    const at = posts.map(m => R((m.pzLo + m.pzHi) / 2, 2)).sort((u, v) => u - v);
    A(JSON.stringify(at) === JSON.stringify([-7.93, -4.93, -3.87, -0.87]),
      `jambs land on the openings: ${at.join(', ')}`);
    // Casing projects 0.045 m; the recessed field is 0.012. Without that the plain
    // field band above the head line — as wide as the wall — counted as a third head.
    // Casing projects 0.098 ft as a swept section (it was 0.148 as a flat band); the
    // recessed field is 0.039. Without a depth bound the plain field above the head
    // line — as wide as the wall — counted as a third head.
    const heads = L.filter(m => onWall(m) && (m.pzHi - m.pzLo) > 3.0 && m.yLo > 6.5
      && (m.pxHi - m.pxLo) > 0.05);
    A(heads.length === 2, `a head casing over each opening (${heads.length})`);
    if (heads.length) A(Math.abs(heads[0].yLo - (7.0 - DY)) < 0.05,
      `head sits on the 7 ft opening line (${R(heads[0].yLo + DY, 2)} ft)`);
    // NO HORNS. A door's architrave is mitred: the head stops dead on the jambs' outer
    // edges, 3 ft opening + one casing width each side = 3.33 ft. It used to overhang
    // by a further casing width each end (3.66), which is a WINDOW detail — a window
    // head caps a stool whose horns run past the casing, and a door has no stool.
    for (const h of heads) {
      const flank = posts.filter(p2 => Math.abs(p2.pzLo - h.pzLo) < 0.02 || Math.abs(p2.pzHi - h.pzHi) < 0.02);
      A(flank.length === 2,
        `head dies on its jambs' outer edges, no horns (${R(h.pzHi - h.pzLo, 2)} ft over a 3 ft opening)`);
    }
    const base = L.filter(m => onWall(m) && m.yLo < 0.02 && m.yHi > 0.7 && m.yHi < 0.85);
    A(base.length >= 2, `baseboard runs the wall in ${base.length} lengths`);
  }

  // The outside door carries a half-round light: slab with the arc cut out, a glazed
  // half-disc, three radial bars, and panel relief below. 10 members in all.
  { const d = leaf(/Ext Vestibule -> Outside/);
    A(!!d, 'vestibule outside door leaf found');
    if (d) A(d.parts === 10,
      `half-moon leaf: ${d.parts} members (pierced slab, glazed disc, 3 bars, 2 stiles, 2 rails, muntin)`);
  }
}

// FAMILY -> SCULLERY door. Both facts are measured: this is the third swing set from a
// sign convention in this model and the first two were wrong until someone looked.
{ const d = (raw.doorLeaves || []).find(x => /Family -> Scullery/i.test(x.name));
  A(!!d, 'family-room door leaf found');
  if (d) {
    A(d.pzLo > -11.95, `swings INTO the family room — leaf at pz ${R(d.pzLo,3)}..${R(d.pzHi,3)}, wall -11.9167`);
    const c = (d.pxLo + d.pxHi) / 2;
    A(Math.abs(c - 3.42) < 0.2, `hinged on the WEST jamb — leaf at px ${R(c,3)}, jambs 0.42 (E) and 3.42 (W)`);
    // 2 stiles + 2 rails + 1 pane + 1 vertical muntin + 3 horizontal = 9 members,
    // dividing the glazing 2 columns by 4 rows — the same count as the back door.
    A(d.parts === 9, `8-lite leaf: ${d.parts} members (2 stiles, 2 rails, pane, 4 muntins)`);
  } }

// FAMILY -> PATIO: the french pair. Both the IFC massing and the viewer split a door
// this wide into two leaves; what regressed before is the DIVISION, which used to run
// as one grid across the whole 6'8" opening with no meeting stile. A pair yields two
// entries under one name, so filter rather than find.
{ const ds = (raw.doorLeaves || []).filter(x => /Family -> Patio/i.test(x.name));
  A(ds.length === 2, `french pair: two leaves (${ds.length})`);
  for (const d of ds) A(d.parts === 9, `8-lite leaf: ${d.parts} members (2 stiles, 2 rails, pane, 4 muntins)`);
  if (ds.length === 2) {
    // Opening px -8.255..-1.585; each leaf hangs on its own jamb, so the two leaf
    // centres sit at opposite ends of it.
    const c = ds.map(d => (d.pxLo + d.pxHi) / 2).sort((u, v) => u - v);
    console.log(`  patio leaves at px ${R(c[0],3)} and ${R(c[1],3)}, jambs -8.255 / -1.585`);
    A(Math.abs(c[0] - (-8.255)) < 0.25 && Math.abs(c[1] - (-1.585)) < 0.25, 'hung on opposite jambs');
    // A pair has to swing together — one leaf in and one out would be nonsense.
    const side = ds.map(d => ((d.pzLo + d.pzHi) / 2) > -11.9167);
    A(side[0] === side[1], `both leaves swing ${side[0] ? 'INTO the family room' : 'out to the patio'}`);
  } }

// BACK DOOR: outswing, and glazed from the inside too
{ const d = (raw.doorLeaves || []).find(x => /back/i.test(x.name));
  A(!!d, 'back door leaf found');
  if (d) {
    A(d.pzHi <= -18.875 + 0.02, `swings OUT — leaf at pz ${R(d.pzLo,3)}..${R(d.pzHi,3)}, wall -18.875`);
    // 2 stiles + 2 rails + 1 pane + 1 vertical muntin + 3 horizontal = 9 members.
    A(d.parts === 9, `8-lite leaf: ${d.parts} members (2 stiles, 2 rails, pane, 4 muntins)`);
  } }

// ---- MAIN VESTIBULE ------------------------------------------------------------
{
  console.log('\nMAIN VESTIBULE');
  const VE = 4.146, VW = 14.854;            // vestibule/foyer side-wall interior faces
  const ves = P.filter(r => r.pz > 10.3 && r.pz < 15.9 && r.px > 4.0 && r.px < 15.0);

  // FRONT DOOR: a raised six-panel leaf, not the blank plank it used to render as.
  // The generator has always built the panelled massing; the viewer's swinging leaf
  // fell through to a single slab because `leafParts` only knew "<n>lite" and halfmoon.
  const fd = raw.doorLeaves.find(d => d.name === 'Front Door');
  A(!!fd, 'front door leaf found');
  if (fd) A(fd.parts > 20, `six-panel with bolection molding: ${fd.parts} members (a flat slab is 1)`);

  // TRANSOM and SIDELIGHT FRAMES are asserted in tools/ifc_check.py, not here.
  // They are IFC products, and fragments merges products sharing a material into one
  // mesh: a four-member frame arrives as a single box, and WHICH boxes merge changes
  // the moment anything nearby is added. These assertions were rewritten three times
  // chasing that before the checks moved to where the members are addressable.
  // What stays here is what the VIEWER draws — the wall-finish casing below.

  // DOOR CASING round the front door. The vestibule had no trim program at all, so the
  // opening was a raw reveal under a framed transom. Casing projects ~0.15 ft where the
  // plaster field projects 0.012, which is what tells the two apart.
  { const DY = 0.066, FACE = 15.854, HEAD = 7.0 - DY;
    const onWall = L.filter(m => m.pzHi > FACE - 0.02 && m.pzLo < FACE + 0.1 && m.pxLo > 7.2 && m.pxHi < 12.2);
    // The swept casing projects 0.098 ft where the old flat band projected 0.148, so a
    // `> 0.1` floor stopped matching it. Bounded against the field (0.039) below and the
    // open door leaf (0.394) above.
    const jambs = onWall.filter(m => (m.pxHi - m.pxLo) < 0.5 && m.yLo < 0.1 && Math.abs(m.yHi - HEAD) < 0.06
      && (m.pzHi - m.pzLo) > 0.06 && (m.pzHi - m.pzLo) < 0.25);
    A(jambs.length === 2, `two casing jambs on the front door (${jambs.length})`);
    if (jambs.length === 2) {
      const at = jambs.map(m => (m.pxLo + m.pxHi) / 2).sort((u, v) => u - v);
      A(Math.abs(at[0] - 8) < 0.1 && Math.abs(at[1] - 11) < 0.1,
        `landing on the jambs: ${at.map(v => R(v, 2)).join(', ')}`);
    }
    // No head casing: a transom spans this door, so wall-finish suppresses it and the
    // transom's BAR is the single head member (see ifc_check.py). Two in the same plane
    // is what the doubled trim was.
    const head = onWall.filter(m => (m.pxHi - m.pxLo) > 3.2 && Math.abs(m.yLo - HEAD) < 0.06
      && (m.pzHi - m.pzLo) > 0.1 && (m.pzHi - m.pzLo) < 0.2 && m.yHi < HEAD + 0.4);
    A(head.length === 0, `no doubled head casing under the transom bar (${head.length})`);
    // REGRESSION GUARD. With `noCornice` the field carries from the head line to the
    // ceiling, subtracting only full-height built-ins. Giving the vestibule a trim
    // program therefore PLASTERED OVER the transom — the glass went opaque and the only
    // sign was a render. Nothing thin (field depth 0.012) may cross the opening up there.
    // Depths on this wall, in FEET: field 0.039, transom glazing and frame 0.060,
    // casing 0.148. `band(..., 0.012, field)` in wall-finish.js is 0.012 METRES, and a
    // threshold written in the wrong unit made this guard vacuous — it passed with the
    // bug deliberately reintroduced. Widening it then caught the GLAZING instead, which
    // also crosses the opening. 0.05 is the only window that isolates the field.
    const plaster = L.filter(m => m.pzHi > FACE - 0.02 && m.pzLo < FACE + 0.1
      && (m.pzHi - m.pzLo) < 0.05 && m.yLo > HEAD - 0.05 && m.yHi > HEAD + 0.5
      && m.pxLo < 8.2 && m.pxHi > 10.8);
    A(plaster.length === 0, `the field is cut around the transom, not plastered over it (${plaster.length})`);
  }

  // The foyer door: a SINGLE 8-lite leaf flanked by sidelights, replacing the french
  // pair. It swings into the FOYER — the vestibule is 5 ft 6 in deep and a leaf opening
  // into it lands across the walk from the front door, which is where it first went.
  { const fr = raw.doorLeaves.filter(d => /Foyer -> Vestibule/.test(d.name));
    A(fr.length === 1, `one leaf, not a pair (${fr.length})`);
    if (fr.length === 1) {
      // steel12 -> 2 columns x 6 rows: 2 stiles, 2 rails, the pane, 1 vertical muntin
      // and 5 horizontal. More lites than the 8-lite joinery doors on purpose — slim
      // sections and many small panes is what makes it read as steel.
      // THE DOOR IS ONE PANEL OF THE SCREEN, not a door in a frame. Two things make it
      // read that way, and both are asserted on the BUILT leaf rather than on a lite
      // count — a count cannot tell you whether the lines land anywhere sensible.
      const mem = (fr[0].members || []).map(m => ({ w: m.w / FT, h: m.h / FT, yc: m.yc / FT }));
      // 1) the horizontals sit on the SIDELIGHTS' lines. add_glazed_frame divides
      //    sill..head by round((head-sill)/(liteFt*1.35)) = 3, giving 2.333 and 4.667;
      //    the leaf derives the same grid from `screen` in the door's spec, plus the
      //    sill line itself and the floor and head. With `steel12` it had five
      //    horizontals of its own at 1.41/2.50/3.58/4.67/5.75 ft and crossed none of them.
      const horiz = mem.filter(m => m.w > 1.0 && m.h < 0.25).map(m => R(m.yc, 2)).sort((a, b) => a - b);
      // Glazed to the FINISHED FLOOR, so the screen's datum is 0 and the three rows
      // divide the whole 7 ft: 2.333 and 4.667. There is no separate sill line any more
      // — it coincides with the floor rail, which is the point of dropping the curb.
      const want = [0, 2.333, 4.667];
      A(horiz.length === want.length + 1,
        `the leaf has one horizontal per screen line plus the head (${horiz.length})`);
      for (const y of want) A(horiz.some(h => Math.abs(h - y) < 0.05),
        `a horizontal on the screen's ${y} ft line (${horiz.join(', ')})`);
      // 2) every member is the MUNTIN section — an interior partition carries no
      //    structural framing, so there are no fat stiles or rails. The leaf used to
      //    have 0.05 m stiles and a 0.10 m bottom rail against 0.018 m muntins.
      const sect = mem.filter(m => m.w > 0.001 && m.h > 0.001)
        .map(m => R(Math.min(m.w, m.h), 3)).filter(v => v < 0.5);
      A(sect.length > 0 && Math.max(...sect) - Math.min(...sect) < 0.01,
        `every member is one section — no structural framing (${[...new Set(sect)].join(', ')} ft)`);
      A(fr[0].pxHi - fr[0].pxLo < 0.4 && fr[0].pzHi - fr[0].pzLo > 2.8,
        'standing open, perpendicular to its wall');
      A(fr[0].pzLo < 10.1667 - 2.8, `swings into the FOYER, reaching pz ${R(fr[0].pzLo, 2)}`);
    } }

  // BENCH on the EAST wall, MIRROR on the WEST wall — facing each other.
  { const b = ves.find(r => r.type === 'mudroom_bench');
    A(!!b, 'bench in the main vestibule');
    if (b) {
      A(Math.abs(b.pxLo - VE) < 0.06, `backs onto the east wall (${R(b.pxLo, 3)})`);
      const mm = meshes(b);
      A(mm.some(m => (m.pzHi - m.pzLo) > 4.0 && Math.abs(m.yHi - 1.55) < 0.05), 'cushioned seat at 18.6 in');
      const divs = mm.filter(m => (m.pzHi - m.pzLo) < 0.12 && (m.pxHi - m.pxLo) > 1.2
        && m.yLo > 0.25 && m.yHi < 1.3);
      A(divs.length === 5, `shoe cubbies below it (${divs.length} boards)`);
      const pegs = mm.filter(m => Math.abs((m.yLo + m.yHi) / 2 - 4.58) < 0.2
        && (m.pzHi - m.pzLo) < 0.2 && (m.pxHi - m.pxLo) < 0.45);
      A(pegs.length >= 5, `coat pegs on the rail (${pegs.length} members)`);
    } }
  { const mir = ves.find(r => r.type === 'wall_mirror');
    A(!!mir, 'full-length mirror in the main vestibule');
    if (mir) {
      A(Math.abs(mir.pxHi - VW) < 0.08, `hung on the west wall (${R(mir.pxHi, 3)})`);
      A(mir.pzHi - mir.pzLo > 3.0, `${R(mir.pzHi - mir.pzLo, 2)} ft wide`);
      A(Math.abs(mir.yLo - 1.5) < 0.08, `foot ${R(mir.yLo * 12, 0)} in off the floor`);
      A(Math.abs(mir.yHi - 7.0) < 0.08, `tops out on the 7 ft head line (${R(mir.yHi * 12, 0)} in)`);
      const b2 = ves.find(r => r.type === 'mudroom_bench');
      if (b2) A(mir.px > b2.px, 'bench and mirror face each other across the room');
    } }
}

// ---- LIGHT FALLOFF -------------------------------------------------------------
// three.js reads distance 0 as "no cutoff": with decay 2 the light still falls off by
// inverse square, but the tail never reaches zero, so every lamp keeps contributing
// across the room and into the next one. This section is the regression guard — the
// harness was mesh-only before it, which is why "the bath sconces wash the room" had
// to be caught by eye instead of here.
//
// NOTE ON SCOPE: this runs under `?solo=ground`, so it sees ground-floor lights only.
// The attic's 12 spots and level 2's semi-flushes need one run with
// CHECK_URL=http://localhost:5173/ — see CLAUDE.md on dropping `?solo`.
// FOYER TRIM. The foyer had no trim program at all until now — no `interior.paneling`,
// so compute_paneling skipped it. It carries the dining room's, with the crown broken
// around the staircase and a raked run climbing beside the upper flight.
// Measured from the BUILT wall-finish meshes (the `loose` list), which read LOOSE_DY low.
{
  console.log('\nFOYER TRIM');
  const DY = 0.066;
  const WWALL = 14.8541;                 // the foyer's west wall face, in plan feet
  // A west-wall member runs along z, so its px extent is only its projection (~5 in).
  // Without that last clause the SOUTH wall's crown — 11 ft of px, ending at this very
  // corner — is caught too, and reports the level crown reaching pz -11.69.
  const onWest = (m) => m.pxHi > WWALL - 0.55 && m.pxLo < WWALL + 0.05
    && (m.pxHi - m.pxLo) < 0.7 && m.pzLo > -12.1 && m.pzHi < 10.4;
  const west = L.filter(onWest);
  A(west.length > 0, `the foyer's west wall carries wall finish at all (${west.length} members)`);

  // 1) NO RAKED CROWN beside the flight. One was built here and then removed: it runs
  // pz -7.69..-2.20, which is entirely SOUTH of the under-stair box's end wall at
  // pz -0.40 — i.e. sealed inside the enclosure, invisible from the foyer, and (with a
  // powder room going in there) a raking crown inside a WC. That is also why no camera
  // could ever be got onto it. Asserted as an absence so it cannot come back unnoticed.
  // A raking moulding PROJECTS ~5 in from the wall; the big plain field panels are also
  // tall and long but are 0.04 ft of skim, which is what this filter separates.
  const proud = (m) => (m.pxHi - m.pxLo) > 0.2;
  const raked = west.filter(m => proud(m) && (m.yHi - m.yLo) > 3 && (m.pzHi - m.pzLo) > 4);
  A(raked.length === 0, `no raked crown sealed inside the under-stair box (${raked.length})`);

  // 2) the LEVEL crown runs the north end and STOPS SHORT of the stair. Asserted on the
  // southernmost crown member, not on "is there one south of X" — the level run is a
  // single span from the break to the north wall, so a "none past X" test would pass
  // just as happily with the break removed, and prove nothing.
  const crown = west.filter(m => proud(m) && m.yLo > 7.4 && m.yHi < 8.5 && (m.yHi - m.yLo) < 1);
  A(crown.length > 0, `the level cornice runs the north end (${crown.length} members)`);
  const southMost = crown.length ? Math.min(...crown.map(m => m.pzLo)) : -99;
  A(southMost > -3,
    `and stops short of the stair (southernmost at pz ${R(southMost,2)}; unbroken it would reach -11.92)`);

  // 3) ...but the BOARD-AND-BATTEN carries on underneath, which is the whole reason a
  // `tall` span was not used for the break: tallX kills the base and battens too.
  const baseRun = west.filter(m => m.yLo < 0.1 && m.yHi > 0.6 && m.yHi < 1.0
    && m.pzLo < -6 && m.pzHi > -4);
  A(baseRun.length > 0, `the baseboard runs straight under the stair (${baseRun.length} run)`);
  const battensUnder = west.filter(m => m.pzHi < -3 && m.yLo > 0.5 && m.yHi > 2.5 && (m.pzHi - m.pzLo) < 0.25);
  A(battensUnder.length > 0, `and so do the battens (${battensUnder.length})`);
}

// THE FOYER'S SCREEN WALL IS GLAZING, NOT PANELLING. Its north wall carries the steel
// screen, and the battens were running straight across the sidelights: the batten loop
// stops a batten at a sill only for members of `wins`, and compute_paneling files
// sidelights under `sides`, which is consulted only for jamb CLEARANCE. So a batten
// landing mid-sidelight was neither stopped nor skipped and ran floor-to-head over the
// glass. Asserted as an ABSENCE, so it is paired with a presence check on another wall —
// on its own it would pass just as happily if the trim program stopped running at all.
{
  console.log('\nFOYER SCREEN WALL');
  // A batten is a `post`: BATTEN_W = 0.0254 m across the wall (0.083 ft) by a 0.03 m
  // projection (0.098 ft), running baseboard to head. BOTH extents have to match or the
  // filter also catches field panels (0.012 m thick), casing jambs (0.33 ft) and the
  // screen's own mullions — which is exactly what it did at first, reporting five
  // "battens" that were nothing of the kind.
  const NFACE = 10.1667 - 0.22915;              // foyer z2 minus half a wall = 9.9375
  const WFACE = 15.0833 - 0.22915;
  const near = (v, want, tol = 0.03) => Math.abs(v - want) < tol;
  const tall = (m) => (m.yHi - m.yLo) > 3;
  // on an x-running wall the batten's width is in px and its projection in pz; on a
  // z-running wall the two swap.
  const battenX = (m) => tall(m) && near(m.pxHi - m.pxLo, 0.083) && near(m.pzHi - m.pzLo, 0.098);
  const battenZ = (m) => tall(m) && near(m.pzHi - m.pzLo, 0.083) && near(m.pxHi - m.pxLo, 0.098);
  const north = L.filter(m => battenX(m) && near((m.pzLo + m.pzHi) / 2, NFACE, 0.15)
    && m.pxLo > 3.8 && m.pxHi < 15.2);
  A(north.length === 0,
    `no battens across the glazed screen (${north.length}${north.length ? ' at px ' + north.map(m => R((m.pxLo + m.pxHi) / 2, 2)).join(', ') : ''})`);
  // The presence half: the SAME filter, on a wall that should be battened. Without this
  // the absence above would pass just as happily if the trim program stopped running —
  // and it is what shows the filter really does identify a batten.
  const west = L.filter(m => battenZ(m) && near((m.pxLo + m.pxHi) / 2, WFACE, 0.15)
    && m.pzLo > -12 && m.pzHi < 10.3);
  A(west.length > 0,
    `...and the same filter still finds them on the foyer's west wall (${west.length})`);

  // THE CROWN WRAPS THE UNDER-STAIR BOX. Coming south along the west wall it meets the
  // box's north face (an INSIDE corner), runs across it, turns an OUTSIDE corner onto the
  // east face and terminates. The box is built by the stair builder, so compute_paneling
  // cannot derive those two faces from the room's bounds — they are authored as
  // `extraWalls`. Measured on the crown band (springline 7.575 to top 8.184, LOOSE_DY low).
  const crownBand = (m) => m.yLo > 7.4 && m.yLo < 7.8 && m.yHi > 8.0 && m.yHi < 8.4;
  // Windows widened at the corner end of each: an OUTSIDE corner makes every member run
  // PAST the wall line by its own projection (see the mitre block below), so the north
  // run starts west of px 11.4833 and the return ends north of pz -0.40.
  const onBoxFace = L.filter(m => crownBand(m) && near((m.pzLo + m.pzHi) / 2, -0.30, 0.45)
    && m.pxLo > 11.0 && m.pxHi < 15.3 && (m.pxHi - m.pxLo) > 2.5);
  A(onBoxFace.length > 0, `the crown runs across the box's north face (${onBoxFace.length} runs)`);
  // > 0.6 ft of pz so this is the RUN and not the mitred return's wedge, which sits on
  // the same line, in the same band, and is exactly one projection long.
  const onReturn = L.filter(m => crownBand(m) && near((m.pxLo + m.pxHi) / 2, 11.28, 0.45)
    && m.pzLo > -1.4 && m.pzHi < 0.2 && (m.pzHi - m.pzLo) > 0.6);
  A(onReturn.length > 0, `...and returns round the outside corner (${onReturn.length} runs)`);
  // and the west wall's own crown now STOPS at the box rather than running behind it
  const westCrown = L.filter(m => crownBand(m) && near((m.pxLo + m.pxHi) / 2, 14.65, 0.35)
    && (m.pzHi - m.pzLo) > (m.pxHi - m.pxLo));
  const southMostW = westCrown.length ? Math.min(...westCrown.map(m => m.pzLo)) : -99;
  A(westCrown.length > 0 && southMostW > -0.9,
    `the west wall's crown stops at the box (southernmost pz ${R(southMostW, 2)}, box face -0.40)`);

  // THE OUTSIDE CORNER IS MITRED. The INSIDE corner at the west wall needs nothing —
  // each run's square end hides behind its neighbour. The OUTSIDE one at (px 11.4833,
  // pz -0.40) is the opposite: both runs turn AWAY from the room, so a square cut leaves
  // both end faces staring out with a P5-square notch between them. That is the fault the
  // owner saw. The fix is two things, and both are asserted here because either alone
  // still reads wrong: every member REACHES past the wall line by its own projection
  // (that is where the neighbour's front face is), and the crown is SHEARED so its long
  // point is at the FRONT, which is what makes the profile turn.
  const P5 = 0.127 * (((9.5 - 7.0) / 2 * FT) / 0.39) / FT;   // crown projection, plan feet
  const boxCrownN = onBoxFace.reduce((a, m) => (a && a.pxLo < m.pxLo ? a : m), null);
  const boxCrownE = onReturn.reduce((a, m) => (a && a.pzHi > m.pzHi ? a : m), null);
  A(boxCrownN && near(boxCrownN.pxLo, 11.4833 - P5, 0.03),
    `the north run reaches past the corner by its own projection (pxLo ${R(boxCrownN.pxLo, 3)}, want ${R(11.4833 - P5, 3)})`);
  A(boxCrownE && near(boxCrownE.pzHi, -0.40 + P5, 0.03),
    `...and the east return reaches the same point (pzHi ${R(boxCrownE.pzHi, 3)}, want ${R(-0.40 + P5, 3)})`);
  // THE SHEAR, which a bounding box CANNOT see — a square-cut run extended by P5 has
  // exactly the same one. Solid VOLUME separates them: the mitre eats a wedge off the
  // end, so a mitred run is lighter than a square cut of its own length. The section is
  // not derivable from the box (the profile is a cove, not a rectangle), so take it from
  // an unmitred crown run in the same room — the west wall's — as volume per foot. That
  // reference is also what proves the comparison is against a real crown section rather
  // than an arbitrary number.
  const refRun = westCrown.reduce((a, m) => (a && (a.pzHi - a.pzLo) > (m.pzHi - m.pzLo) ? a : m), null);
  const sectA = refRun ? refRun.vol / (refRun.pzHi - refRun.pzLo) : 0;   // sq ft of section
  // Every mitred end eats the SAME wedge — one section's worth of material over the
  // projection, less the section's own centroid — so the two runs cross-check each other
  // rather than each being compared to a number typed in here. The north run has ONE
  // mitred end (the outside corner); the east return has TWO (that corner and the mitred
  // return at its far end), so its loss must be exactly twice. A square-cut run shows no
  // loss at all, and a shear shorn the wrong way shows a different one.
  const lenN = boxCrownN ? boxCrownN.pxHi - boxCrownN.pxLo : 0;
  const lenE = boxCrownE ? boxCrownE.pzHi - boxCrownE.pzLo : 0;
  const lossN = sectA * lenN - (boxCrownN ? boxCrownN.vol : 0);
  const lossE = sectA * lenE - (boxCrownE ? boxCrownE.vol : 0);
  A(sectA > 0 && lossN > sectA * P5 * 0.3 && lossN < sectA * P5 * 0.95,
    `the north run's one mitred end eats a wedge (${R(lossN, 4)} cu ft off a square ${R(sectA * lenN, 4)})`);
  A(lossN > 0 && near(lossE, 2 * lossN, lossN * 0.08),
    `...and the east return's TWO mitred ends eat exactly two of them (${R(lossE, 4)} against ${R(2 * lossN, 4)})`);

  // THE FAR END OF THE RETURN IS MITRED BACK INTO THE WALL. It has no neighbour to carry
  // the profile on, so a square cap would show the section end-on as a flat face 8 ft up.
  // The wedge is the same section turned to look along the wall: one projection square in
  // plan, sitting on the run's line at its south end, thick at the wall and dying at the
  // front. Three things pin it down, because any one alone is weak — a plain block would
  // pass on position, and a full-length offcut would pass on position and vertex count:
  //   PLAN SIZE, P5 x P5 (a longer piece is a run, not a return);
  //   VERTEX COUNT, which says it carries the swept profile rather than being a box;
  //   VOLUME, which says it is a WEDGE. A square block of the same box would be
  //     sectA x P5; the wedge is that times the section's own centroid fraction, ~1/3.
  const wedge = L.filter(m => crownBand(m) && near((m.pxLo + m.pxHi) / 2, 11.28, 0.45)
    && near((m.pzHi - m.pzLo), P5, 0.06) && near((m.pxHi - m.pxLo), P5, 0.06)
    && near(m.pzLo, -0.90, 0.06));
  A(wedge.length === 1, `the return's far end dies into the wall on a mitred wedge (${wedge.length})`);
  if (wedge[0]) {
    const wv = wedge[0], block = sectA * P5;
    A(wv.nv > 24, `...carrying the crown's own profile, not a block (${wv.nv} vertices, a box is 24)`);
    A(wv.vol > block * 0.15 && wv.vol < block * 0.6,
      `...and it is a WEDGE, thick at the wall and dying at the front (${R(wv.vol, 4)} cu ft against ${R(block, 4)} for a full block)`);
  }

  // The glazing reaches the FINISHED FLOOR now, so a baseboard would run across the
  // bottom of the glass — the same fault as the battens, one band lower. `sides` carries
  // each sidelight's sill so only the floor-height ones are subtracted; a raised-sill
  // sidelight still keeps its baseboard.
  const SIDELIGHTS = [[4.646, 7.940], [11.060, 14.354]];
  const baseRuns = L.filter(m => m.yLo < 0.1 && (m.yHi - m.yLo) > 0.6 && (m.yHi - m.yLo) < 1.0
    && near((m.pzLo + m.pzHi) / 2, NFACE, 0.2) && m.pxLo > 3.8 && m.pxHi < 15.2);
  const across = baseRuns.filter(m =>
    SIDELIGHTS.some(([a, b]) => Math.min(m.pxHi, b) - Math.max(m.pxLo, a) > 0.1));
  A(across.length === 0, `no baseboard across the glazing (${across.length} of ${baseRuns.length} runs)`);
  A(baseRuns.length > 0, `...but the wall's end returns still have one (${baseRuns.length} runs)`);
}


// COVED CEILINGS. Both rooms that carry the cornice curve the plaster out of the wall
// and into the ceiling rather than meeting it at an arris. The cove REPLACES the flat
// band that used to fill crownTop..wallTop, so it inherits the cornice's spans — which
// is why the foyer gets none over the stair break.
{
  console.log('\nCOVED CEILINGS');
  // crownTop 8.28 ft and wallTop 9.0, both reading LOOSE_DY low. The giveaway against
  // the flat band it replaced is the PROJECTION: a cove is ~0.72 ft deep where the band
  // was 0.012 m of skim, and that is the smaller of its two plan extents whichever wall
  // it is on.
  // The entablature and the cove split the band between the 7 ft head line and the
  // ceiling, so both ends move with the ceiling height: at 9'6" the cove springs at
  // crownTop = 8.25 ft and dies at 9.5, each reading LOOSE_DY low.
  const isCove = (m) => m.yLo > 8.05 && m.yLo < 8.35 && m.yHi > 9.35
    && Math.min(m.pxHi - m.pxLo, m.pzHi - m.pzLo) > 0.5;
  // Centre-in-box, not overlap: the foyer's west wall and the dining room's east wall
  // are the same line (x 15.0833), so an overlap test hands each room the other's cove.
  const inRoom = (m, x0, x1, z0, z1) => {
    const cx = (m.pxLo + m.pxHi) / 2, cz = (m.pzLo + m.pzHi) / 2;
    return cx > x0 && cx < x1 && cz > z0 && cz < z1;
  };
  // All four coved rooms. The sitting and family rooms have NO entablature, so their
  // cove springs straight off the plain wall — at the same height, because COVE_H is
  // set to the corniced rooms' wallTop - crownTop so every coved room reads alike.
  // They share the z = 0 wall, which centre-in-box separates.
  const ROOMS = [['foyer', 3.9167, 15.0833, -11.9167, 10.1667],
                 ['dining', 15.0833, 31, 2, 16.0833],
                 ['sitting', -12, 3.9167, 0, 16.0833],
                 ['family', -12, 3.9167, -11.9167, 0]];
  for (const [name, x0, x1, z0, z1] of ROOMS) {
    const c = L.filter(m => isCove(m) && inRoom(m, x0, x1, z0, z1));
    A(c.length > 0, `${name}: the ceiling is coved (${c.length} runs off the crown)`);
    // THE assertion that distinguishes a cove from simply a deeper flat band: a
    // BoxGeometry has 24 vertices, a swept section has hundreds.
    A(c.length > 0 && c.every(m => m.nv > 100),
      `${name}: swept, not a thicker flat band (${[...new Set(c.map(m => m.nv))].join(', ')} verts; a box is 24)`);
    // ...and swept the RIGHT WAY ROUND. A hollow and a bullnose share a bounding box and
    // a vertex count; only the solid volume separates them. Section area / R^2 is
    // 1 - pi/4 = 0.215 for the fillet a cove is, and pi/4 = 0.785 for the quarter-disc
    // it is not. The first cut of this shipped the bullnose.
    for (const m of c) {
      const R = Math.min(m.pxHi - m.pxLo, m.pzHi - m.pzLo);
      const len = Math.max(m.pxHi - m.pxLo, m.pzHi - m.pzLo);
      const k = m.vol / (R * R * len);
      A(k > 0.13 && k < 0.32,
        `${name}: hollow, not a bullnose (section/R\u00b2 = ${R2(k)}; a cove is 0.215, a bullnose 0.785)`);
    }
  }
  // ...and specifically on the WEST wall, which is the one the stair breaks. Scoped to
  // that wall on purpose: the SOUTH wall's cove runs its full length and should, so an
  // unscoped "nothing south of pz -3" test just fails on it.
  // Identify the west wall by the cove's OUTER edge sitting on the wall face (14.854),
  // not by its centre: the centre moves whenever the cove's projection changes, and it
  // did — going from a 9'0" ceiling to 9'6" took the projection from 0.98 ft to 1.25 and
  // the centre slid right past a 14.3 threshold.
  // A WEST-wall member runs along z, so its px extent (just the projection) is smaller
  // than its pz extent. That last clause is orientation-based and therefore scale-free —
  // the SOUTH wall's cove also has its outer edge at px 15.08 and was caught without it,
  // reporting the west wall's cove reaching pz -11.69. Same trap as the crown's.
  const westCove = L.filter(m => isCove(m) && inRoom(m, 3.9167, 15.0833, -11.9167, 10.1667)
    && m.pxHi > 14.6 && (m.pxHi - m.pxLo) < (m.pzHi - m.pzLo));
  const southMostCove = westCove.length ? Math.min(...westCove.map(m => m.pzLo)) : 0;
  A(westCove.length > 0 && southMostCove > -3,
    `foyer: the west wall's cove stops at the stair like its cornice (southernmost pz ${R(southMostCove, 2)})`);
}

{
  const LI = raw.lights || [];
  console.log('\nLIGHT FALLOFF');
  A(LI.length > 0, `lights collected (${LI.length})`);
  const uncapped = LI.filter(l => !(l.distance > 0));
  A(uncapped.length === 0,
    `every light has a finite range (${uncapped.length} uncapped` +
    (uncapped.length ? `: ${[...new Set(uncapped.map(l => l.owner || l.kind))].join(', ')}` : '') + ')');
  A(LI.every(l => l.decay === 2), `all decay physically (${[...new Set(LI.map(l => l.decay))].join('/')})`);
  // Each builder's default, in plan feet. A stray edit to one of these shows up here
  // rather than three rooms later in a screenshot.
  // The skylight IS in here — it is daylight down the well, not a lamp — but what it is
  // NOT allowed to be is constant. See the day/night assertions below; the loop here
  // would skip a type with no lights at all, so neither check covers the other.
  const REACH = { recessed: 12, pendant: 10, sconce: 8, undercabinet: 8.5, skylight: 16, chandelier: 14 };
  for (const [type, want] of Object.entries(REACH)) {
    const own = LI.filter(l => l.owner === type);
    if (!own.length) continue;
    const ft = own.map(l => l.distance / FT);
    A(ft.every(d => Math.abs(d - want) < 0.05),
      `${type} reaches ${want} ft (${[...new Set(ft.map(d => R(d, 2)))].join(', ')}) \u00d7${own.length}`);
  }
  // ONE MODEL LIT AT A TIME. Asserted by driving the control and counting, not by
  // reading the button labels — the whole point is that the scene agrees with them.
  const LG = raw.lighting || {};
  const levels = (o) => Object.keys(o.lit || {}).filter((k) => o.lit[k] > 0);
  if (LG.ground) {
    A(levels(LG.ground).join() === 'ground',
      `lighting the ground floor lights ONLY the ground floor (${levels(LG.ground).join(', ') || 'nothing'})`);
    A(levels(LG.exterior).join() === 'exterior',
      `lighting the Lot lights ONLY the Lot (${levels(LG.exterior).join(', ') || 'nothing'})`);
    A(levels(LG.off).length === 0, `"All off" leaves nothing lit (${levels(LG.off).join(', ') || 'nothing'})`);
    A(Object.values(LG).every((o) => levels(o).length <= 1),
      `never more than one model lit at once (${Object.entries(LG).map(([k, o]) => `${k}:${levels(o).length}`).join(' ')})`);
  }

  // Daylight, so it tracks the sun rather than the lamp scenes.
  const sky = raw.sky || { night: { lit: [], emis: [] }, noon: { lit: [], emis: [] } };
  A(sky.noon.lit.length === 3, `three skylight wells are lit by the sun (${sky.noon.lit.length})`);
  A(sky.noon.lit.every(v => v > 0.5), `and lit at noon (${[...new Set(sky.noon.lit.map(v => R(v, 2)))].join(', ')})`);
  A(sky.night.lit.every(v => v === 0),
    `dark at midnight (${[...new Set(sky.night.lit.map(v => R(v, 3)))].join(', ') || 'none'}) — a well that glows at 2 a.m. is the bug this replaced`);
  A(sky.noon.emis.every(v => v > 0.3) && sky.night.emis.every(v => v === 0),
    `the glazing goes with it: ${[...new Set(sky.noon.emis.map(v => R(v, 2)))].join(', ')} at noon, ` +
    `${[...new Set(sky.night.emis.map(v => R(v, 3)))].join(', ') || 'none'} at midnight`);
  // The generic per-room fixture and the attic downlights own no furniture item, so
  // main.js tags them — do NOT identify them by "has no owner", which also catches
  // every landscape light on the lot. (Those are finite already, and deliberately
  // long: they are written in RAW METRES, not feet, so the street lamp's `14` is 46 ft,
  // not 14. That inconsistency with the ft-based builders is pre-existing.)
  const tagged = { semiFlush: 14, atticCan: 12, atticVanity: 8 };
  for (const [lamp, want] of Object.entries(tagged)) {
    const own = LI.filter(l => l.lamp === lamp);
    if (!own.length) continue;                        // attic lamps are absent under ?solo=ground
    const ft = own.map(l => l.distance / FT);
    A(ft.every(d => Math.abs(d - want) < 0.05),
      `${lamp} reaches ${want} ft (${[...new Set(ft.map(d => R(d, 2)))].join(', ')}) \u00d7${own.length}`);
  }
}

// THE UNDER-STAIR POWDER ROOM. Its walls belong to three different things — the foyer's
// west wall is IFC, the east (well) wall and the north end wall are the stair's own
// drywall panels — so nothing but this checks that the room they enclose is the size the
// fixtures were laid out for. Everything here is measured from the BUILT geometry.
{
  console.log('\nPOWDER ROOM');
  const near = (v, want, tol = 0.03) => Math.abs(v - want) < tol;
  const EAST = 11.6533, WEST = 14.8147;          // the two finished faces, plan feet
  const CLEAR = WEST - EAST;                     // 3.162 ft = 37.9 in
  const DOOR = [11.984, 14.484], HEAD = 7.0;

  // 1) THE ROOM, measured off the two BUILT faces rather than off the authored numbers.
  // They come from different modules — the well wall is the stair's drywall panel, the
  // west face is the foyer's trim program running on through under the stair — and every
  // clearance below is only worth something if the gap between them is real. A WC needs
  // 30 in of clear width; this is what says the bay has it.
  // Both faces are found by CONTAINING the bay, not by lying inside it: the well wall
  // runs the whole flight and the foyer's field band runs the whole west wall, from the
  // south end of the room to the dining opening. A filter scoped to the bay finds
  // neither. And the exposed face is the one at the SMALLER px on the west wall (px
  // increases west, so trim projects toward lower px) and the LARGER px on the east.
  const stair = pick('staircase');
  // yLo near the floor is what separates the WALL from run 2's east STRINGER, which sits
  // on the same line, is the same slim px section, and spans the same length — it just
  // starts at the landing, 4 ft up. Without that clause this found two.
  const well = meshes(stair).filter(m => near(m.pxLo, 11.4833, 0.05) && (m.pxHi - m.pxLo) < 0.3
    && m.yLo < 0.5 && m.yHi > 6 && m.pzLo < -6.5 && m.pzHi > -1.0);
  const westField = L.filter(m => near(m.pxLo, WEST, 0.03) && m.yLo < 3 && m.yHi > 5
    && m.pzLo < -7.0 && m.pzHi > -0.5);
  A(well.length === 1 && westField.length > 0,
    `the bay's two faces are built (well wall ${well.length}, west field ${westField.length})`);
  const east = well.length ? Math.max(...well.map(m => m.pxHi)) : NaN;
  const west = westField.length ? Math.min(...westField.map(m => m.pxLo)) : NaN;
  A(near(east, EAST, 0.03) && near(west, WEST, 0.03),
    `and where the layout assumed (east ${R(east, 3)} want ${EAST}, west ${R(west, 3)} want ${WEST})`);
  A(west - east > 30 / 12, `the bay is ${R((west - east) * 12, 1)} in clear — a WC needs 30 in`);

  // 2) THE DOOR. The hole is cut by the stair builder and the casing drawn by the trim
  // program, from two separately authored numbers; ifc_check asserts those agree, and
  // this asserts the built result. The CASING is the visible half: without it the opening
  // is a raw edge of drywall in a room whose every other opening is architraved.
  const casing = L.filter(m => m.yLo > -0.2 && m.yLo < 0.3 && m.yHi > HEAD - 0.5
    && (m.pxHi - m.pxLo) < 0.6 && near((m.pzLo + m.pzHi) / 2, -0.35, 0.25)
    && [DOOR[0], DOOR[1]].some(e => near((m.pxLo + m.pxHi) / 2, e, 0.25)));
  A(casing.length >= 2, `the opening is cased, both jambs (${casing.length} members)`);
  const head = L.filter(m => m.yLo > HEAD - 0.4 && m.yLo < HEAD + 0.3 && m.yHi < HEAD + 0.6
    && (m.pxHi - m.pxLo) > 2.0 && near((m.pzLo + m.pzHi) / 2, -0.35, 0.25));
  A(head.length >= 1, `...and across the head (${head.length})`);

  // 3) THE LEAF, and that it SWINGS OUT. An inswing is the thing this layout cannot have:
  // a 2 ft 6 in leaf hinged inside sweeps a quarter-disc off the hinge that covers the
  // whole north end of a 3 ft 2 in room, basin included. So the test is not "a door
  // exists" but "its swept box stays north of the wall" — which is the decision, and the
  // one thing a later edit could silently undo.
  const F = (raw.fdoors || []).map(f => ({ openAngle: f.openAngle,
    shut: { pxLo: -f.shut[3] / FT, pxHi: -f.shut[0] / FT, pzLo: -f.shut[5] / FT, pzHi: -f.shut[2] / FT,
            yLo: (f.shut[1] - FY) / FT, yHi: (f.shut[4] - FY) / FT },
    open: { pxLo: -f.open[3] / FT, pxHi: -f.open[0] / FT, pzLo: -f.open[5] / FT, pzHi: -f.open[2] / FT } }));
  const leaf = F.find(f => near((f.shut.pxLo + f.shut.pxHi) / 2, (DOOR[0] + DOOR[1]) / 2, 0.4)
    && near((f.shut.pzLo + f.shut.pzHi) / 2, -0.40, 0.4));
  A(!!leaf, `the opening has a leaf (${F.length} procedural leaves in the scene)`);
  if (leaf) {
    A(near(leaf.shut.pxHi - leaf.shut.pxLo, DOOR[1] - DOOR[0], 0.08),
      `it fills the opening shut (${R(leaf.shut.pxHi - leaf.shut.pxLo, 2)} ft against a ${R(DOOR[1] - DOOR[0], 2)} ft hole)`);
    A(near(leaf.shut.yHi - leaf.shut.yLo, HEAD, 0.1) && leaf.shut.yLo < 0.1,
      `full height, off the floor (${R(leaf.shut.yLo, 2)}..${R(leaf.shut.yHi, 2)} ft)`);
    A(leaf.open.pzHi > 0.5 && leaf.open.pzLo > -0.75,
      `it swings OUT into the foyer, clear of the room (open pz ${R(leaf.open.pzLo, 2)}..${R(leaf.open.pzHi, 2)}, wall at -0.40)`);
  }

  // 4) THE FIXTURES, against the clearances a WC actually needs. Measured from the BUILT
  // meshes: `at` in the manifest is an anchor, and where a toilet's bowl front lands
  // depends on the builder's own dimensions, not on that anchor.
  // Found by BEING IN THE ROOM rather than at a coordinate: these positions get tuned
  // (the WC has already moved once, to buy the 21 in below), and an assertion keyed to
  // the old number fails for the one reason that is not a defect.
  const inBay = (r) => r.px > EAST - 0.7 && r.px < WEST + 0.7 && r.pz < -0.4 && r.pz > -7.4;
  const wc = P.find(r => r.type === 'toilet' && inBay(r));
  const van = P.find(r => r.type === 'wall_basin' && inBay(r));
  A(!!wc && !!van, `a WC and a basin are in the room (${wc ? 'wc' : '-'}, ${van ? 'basin' : '-'})`);
  if (wc && van) {
    const wb = meshes(wc), vb = meshes(van);
    const wcPxLo = Math.min(...wb.map(m => m.pxLo)), wcPxHi = Math.max(...wb.map(m => m.pxHi));
    const wcFront = Math.max(...wb.map(m => m.pzHi));         // the bowl, facing north
    const vanFront = Math.min(...vb.map(m => m.pxLo));        // the cabinet's face, into the room
    const vanSouth = Math.min(...vb.map(m => m.pzLo));
    A(wcPxLo > EAST && wcPxHi < WEST,
      `the WC is inside the walls (px ${R(wcPxLo, 2)}..${R(wcPxHi, 2)} in ${R(EAST, 2)}..${R(WEST, 2)})`);
    // 15 in from the WC's centreline to anything either side is the code clearance, and
    // it is the number that decides this room works at all.
    const wcMid = (wcPxLo + wcPxHi) / 2;
    A(Math.min(wcMid - EAST, WEST - wcMid) > 15 / 12,
      `15 in each side of its centreline (${R(Math.min(wcMid - EAST, WEST - wcMid) * 12, 1)} in)`);
    // 21 in clear in FRONT of the bowl — and the basin is the thing that could eat it,
    // which is why the two are measured against each other rather than against the wall.
    A(vanSouth - wcFront > 21 / 12,
      `21 in clear in front of the bowl (${R((vanSouth - wcFront) * 12, 1)} in to the basin)`);
    A(vanFront > EAST + 1.5,
      `and the basin leaves a passage past it (${R((vanFront - EAST) * 12, 1)} in)`);
    // CLEAR OF THE DOORWAY, in both directions. A basin hard against the north wall is
    // the first thing your shoulder meets coming in: it blocked 7 in of a 30 in opening
    // and stood at the jamb. Both numbers are asserted because shrinking it only helps
    // one of them and sliding it south only helps the other.
    const vanNorth = Math.max(...vb.map(m => m.pzHi));
    A(-0.570 - vanNorth > 0.3,
      `the basin stands clear of the door opening (${R((-0.570 - vanNorth) * 12, 1)} in back from it)`);
    A(DOOR[1] - vanFront < 0.5,
      `and blocks little of it (${R((DOOR[1] - vanFront) * 12, 1)} in of a ${R((DOOR[1] - DOOR[0]) * 12, 0)} in opening)`);
  }

  // 5) THE CEILING. The requirement is "the stair steps are not visible", so the test is
  // what you HIT looking up, at every point on a grid across the room — not whether a
  // soffit mesh exists. A soffit that existed but sat above one step corner would pass
  // an existence test and fail in the room, which is the failure worth guarding.
  const OH = (raw.overhead || []).filter(o => o.px > EAST && o.px < WEST && o.pz < -0.6 && o.pz > -7.3);
  const openSky = OH.filter(o => o.y == null);
  const stepHits = OH.filter(o => o.y != null && !o.soffit);
  A(OH.length > 100, `the room was probed overhead (${OH.length} points)`);
  A(openSky.length === 0,
    `the stair is overhead everywhere in the room (${openSky.length} points see none of it — a gap at the edge of the sheet)`);
  A(stepHits.length === 0,
    `every point looks up at the SOFFIT, not the stair (${stepHits.length} points see something else` +
    `${stepHits.length ? ': ' + stepHits.slice(0, 3).map(o => `px ${o.px} pz ${o.pz} at ${R(o.y, 2)} ft`).join('; ') : ''})`);
  // ...and that the ceiling it gives is a usable one. These are the heights the layout
  // was chosen for, so they are the ones that must not quietly erode.
  // ONE plane fit, used for the heights here AND for the flatness test below. A windowed
  // MIN over nearby probes was the first version and reads systematically low — the grid
  // is 0.3 ft, so the window catches probes up to 0.2 ft further south, which on a
  // ceiling falling 0.82 ft per ft is an eighth of a foot of pessimism. That is fine for
  // a ">" test and useless for reporting a height, and it made every threshold here a
  // fudge factor. The fit is exact: the residual assertion below is what earns it.
  const pts = OH.filter(o => o.y != null);
  const nP = pts.length;
  const sx = pts.reduce((t, o) => t + o.pz, 0), sy = pts.reduce((t, o) => t + o.y, 0);
  const sxx = pts.reduce((t, o) => t + o.pz * o.pz, 0);
  const sxy = pts.reduce((t, o) => t + o.pz * o.y, 0);
  const bF = (nP * sxy - sx * sy) / (nP * sxx - sx * sx), aF = (sy - bF * sx) / nP;
  const hAt = (pz) => aF + bF * pz;
  // Keyed to where the fixtures ACTUALLY are, not to typed-in coordinates: these move
  // whenever the basin's length changes, and the whole point of the numbers is the
  // relationship between the ceiling and the fixture under it.
  A(hAt(-0.9) > 8.5, `8 ft 6 in of ceiling at the door (${R(hAt(-0.9), 2)} ft)`);
  if (wc && van) {
    const vb2 = meshes(van), wb2 = meshes(wc);
    const vanMid = (Math.min(...vb2.map(m => m.pzLo)) + Math.max(...vb2.map(m => m.pzHi))) / 2;
    const front = Math.max(...wb2.map(m => m.pzHi));           // the bowl, facing north
    const seatPz = (Math.min(...wb2.map(m => m.pzLo)) + front) / 2;
    A(hAt(vanMid) > 8.0, `and over the basin (${R(hAt(vanMid), 2)} ft at pz ${R(vanMid, 2)})`);
    // STANDING at the bowl is the binding number, not the seated one: seated, the top of
    // your head is about 50 in, so 65 in over the seat was never the complaint — 73.9 in
    // at the bowl, which is 6 ft 2 in, was.
    A(hAt(front) > 6.4,
      `${R(hAt(front) * 12, 0)} in standing at the bowl (pz ${R(front, 2)}) — the number that was 73.9`);
    A(hAt(seatPz) > 5.5, `and ${R(hAt(seatPz) * 12, 0)} in over the seat (${R(hAt(seatPz), 2)} ft)`);
  }
  // A FLAT sheet, which is what was asked for. Tested by FITTING A PLANE to every probe
  // and looking at the worst residual: a stepped profile, a fold, or a sheet that sloped
  // across the room as well as along it all show up as points off the fit. Differencing
  // neighbouring heights does NOT work here and was the first attempt — the probe grid
  // is 0.3 ft and the sampling window caught one row in some places and two in others,
  // which reported a "slope" wandering between 0.41 and 1.24 on a plane that is dead
  // flat. The fit is over pz only, so any fall ACROSS the room lands in the residual too.
  const resid = Math.max(...pts.map(o => Math.abs(o.y - hAt(o.pz))));
  A(nP > 100 && resid < 0.01,
    `it is ONE FLAT plane, not a stepped profile (falls ${R(bF, 3)} ft per ft going south, ` +
    `worst point ${R(resid, 4)} ft off the fit)`);

  // 6) FINISHED FLOORING, and the hardwood stopping for it. The tile is instanced hex, so
  // it is checked through the manifest the viewer drives it from; the hardwood is checked
  // by its coverings having been SPLIT, since a single un-split Foyer covering means the
  // planks are being drawn straight through the powder room under the tile.
  // 7) ONE LAMP, NOT TWO. The viewer gives every room without an authored fixture a generic
  // ceiling one, keyed off which room each fixture landed in — and it used to take the
  // FIRST room whose box contained it. This room lies entirely inside the foyer, so its
  // sconce was inside both boxes and got attributed to the foyer: the foyer silently lost
  // its own ceiling light, and this room gained a generic one, a 14 ft intensity-3.0 lamp
  // at the centre of a space 3 ft 2 in wide. That is most of why it read as blown out and
  // most of what was spilling into the foyer. Nesting is the thing to assert.
  const inRoom = (l) => -l.x / FT > EAST - 0.4 && -l.x / FT < WEST + 0.4
    && -l.z / FT < -0.4 && -l.z / FT > -7.4;
  const pwLights = (raw.lights || []).filter(inRoom);
  A(pwLights.length === 1,
    `exactly one lamp in the room (${pwLights.length}: ${pwLights.map(l => `${l.owner || l.lamp} ${R(l.distance / FT, 0)} ft`).join(', ')})`);
  A(pwLights.every(l => (l.owner || '') === 'sconce'),
    `...and it is the authored sconce, not a generic ceiling fixture`);

  const names = (f) => { try { return JSON.parse(readFileSync(`public/${f}`, 'utf8')).map(e => e.name); }
                         catch (e) { return []; } };
  const tiles = names('ground.tiles.json'), woods = names('ground.floors.json');
  A(tiles.some(t => /Powder/i.test(t)), `the floor is tiled (${tiles.filter(t => /Powder/i.test(t)).join(', ') || 'none'})`);
  const foyerFloors = woods.filter(t => /Foyer/i.test(t));
  A(foyerFloors.length > 1,
    `and the foyer's hardwood stops for it (${foyerFloors.length} coverings — one would mean planks under the tile)`);
}

// THE FOYER CHANDELIER. A semi-drop on the entry axis, which also takes the foyer off the
// viewer's generic per-room ceiling fixture — any authored fixture inside a room's IfcSpace
// suppresses it (main.js), which is the mechanism the powder room's nesting bug broke.
{
  console.log('\nFOYER CHANDELIER');
  const ch = P.find(r => r.type === 'chandelier');
  A(!!ch, `the foyer has a chandelier (${ch ? `at plan ${R(ch.px, 2)}, ${R(ch.pz, 2)}` : 'none'})`);
  if (ch) {
    A(Math.abs(ch.px - 9.5) < 0.05 && Math.abs(ch.pz - 6.17) < 0.05,
      `on the entry axis — mid-width, on the sitting/dining opening cross-axis (${R(ch.px, 2)}, ${R(ch.pz, 2)})`);
    const m = meshes(ch);
    const lo = Math.min(...m.map(q => q.yLo)), hi = Math.max(...m.map(q => q.yHi));
    // A SEMI-drop: the canopy is on the ceiling and the lowest point clears the head line.
    // If it ever grows into a long-drop it stops being the thing that was asked for, and
    // starts being something you walk into.
    A(hi > 9.3 && hi < 9.6, `canopy on the 9.5 ft ceiling (tops out at ${R(hi, 2)} ft)`);
    A(lo > 7.0, `and hangs clear of the 7 ft head line (lowest point ${R(lo, 2)} ft) — a semi-drop`);
    A(hi - lo < 2.6, `...a SHORT drop, not a stairwell pendant (${R(hi - lo, 2)} ft overall)`);
    // The arms are what make it a chandelier rather than a lamp on a stick.
    const span = Math.max(...m.map(q => q.pxHi)) - Math.min(...m.map(q => q.pxLo));
    A(span > 1.6 && span < 3.0, `six arms spreading ${R(span, 2)} ft across`);
  }
  // The generic fixture the foyer used to get sat over the stairwell void. It must be gone.
  const generic = (raw.lights || []).filter(l => l.lamp === 'semiFlush'
    && -l.x / FT > 3.9 && -l.x / FT < 15.1 && -l.z / FT > -11.9 && -l.z / FT < 10.2);
  A(generic.length === 0,
    `and the foyer's generic ceiling fixture is gone (${generic.length} left over the stairwell)`);
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
