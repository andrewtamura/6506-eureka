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
  const items = [], loose = [];
  window.__eureka.world.scene.three.traverse(o => {
    const it = o.userData && o.userData.item;
    if (!it) return;
    o.updateMatrixWorld(true);
    const bb = new B3().setFromObject(o); if (bb.isEmpty()) return;
    const parts = [];
    o.traverse(m => { if (!m.isMesh) return; const mb = new B3().setFromObject(m);
      parts.push([mb.min.x, mb.min.y, mb.min.z, mb.max.x, mb.max.y, mb.max.z]); });
    const mvols = [];   // filled alongside the volume pass below, one per mesh, in order
    // A rotated item's world AABB is not its size — a 1.5 ft square chair turned 45 deg
    // measures 2.1 ft on both axes. Take a bbox in the item's OWN frame as well, and the
    // solid volume of its geometry, which is the only honest way to say "dainty".
    const invM = o.matrixWorld.clone().invert(); const lb = new B3();
    let vol = 0;
    o.traverse(m => { if (!m.isMesh) return;
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
        o.traverse(m => { if (!m.isMesh) return; const mb = new B3().setFromObject(m);
          const a = (mb.max.x - mb.min.x) * (mb.max.z - mb.min.z);
          if (a > area) { area = a; best = mb.max.y; } }); return best; })() });
  });
  // wall-finish meshes carry no userData.item
  window.__eureka.world.scene.three.traverse(o => {
    if (!o.isMesh) return;
    let p = o.parent, owned = false; while (p) { if (p.userData && p.userData.item) { owned = true; break; } p = p.parent; }
    if (owned) return;
    const mb = new B3().setFromObject(o); if (mb.isEmpty()) return;
    // Vertex count too. A bounding box cannot tell a swept MOULDING from a plain box —
    // both measure the same — and "is this actually a profile" is precisely what a
    // check on trim needs to answer. A BoxGeometry has 24; an extruded cove/ovolo
    // section has hundreds.
    const pos = o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('position');
    loose.push([mb.min.x, mb.min.y, mb.min.z, mb.max.x, mb.max.y, mb.max.z, pos ? pos.count : 0]);
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
    d.pivot.traverse(o => { if (!o.isMesh) return; n++;
      const gg = o.geometry; gg.computeBoundingBox();
      const bb = gg.boundingBox.clone(); bb.applyMatrix4(o.matrixWorld);
      zmin = Math.min(zmin, bb.min.z); zmax = Math.max(zmax, bb.max.z);
      xmin = Math.min(xmin, bb.min.x); xmax = Math.max(xmax, bb.max.x); });
    doorLeaves.push({ name: d.name, parts: n, zmin, zmax, xmin, xmax });
  }
  return { items, loose, doorLeaves, lights };
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
raw.doorLeaves = (raw.doorLeaves || []).map(d => ({ name: d.name, parts: d.parts,
  pzLo: -d.zmax / FT, pzHi: -d.zmin / FT, pxLo: -d.xmax / FT, pxHi: -d.xmin / FT }));

const R = (v, n = 4) => +v.toFixed(n);
let fail = 0; const A = (ok, m) => { if (!ok) fail++; console.log((ok ? '  PASS  ' : '  FAIL  ') + m); };
const conv = (r, fy) => ({ ...r, pxLo: -r.max[0] / FT, pxHi: -r.min[0] / FT,
  pzLo: -r.max[2] / FT, pzHi: -r.min[2] / FT, yLo: (r.min[1] - fy) / FT, yHi: (r.max[1] - fy) / FT });
const P = raw.items.map(r => conv(r, r.floorY));
// The GROUND floor datum. items[0] may belong to another level — level2 furniture is in
// the same scene — so take it from a piece known to be in this room.
const FY = (P.find(r => r.type === 'island') || P[0]).floorY;
const L = raw.loose.map(a => ({ pxLo: -a[3] / FT, pxHi: -a[0] / FT, pzLo: -a[5] / FT, pzHi: -a[2] / FT,
  yLo: (a[1] - FY) / FT, yHi: (a[4] - FY) / FT, nv: a[6] || 0 }));
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

  // HEAD: the run, plus a RETURN at each end. A 45 deg mitre returns as far as the
  // member stands proud, so the return's length has to equal its projection — that
  // single relationship is what makes it a mitre rather than a stuck-on block.
  const atHead = onWall.filter(m => Math.abs(m.yLo - hy) < 0.06 && m.yHi < hy + 0.42);
  const hRun = atHead.filter(m => (m.pxHi - m.pxLo) > 1.5);
  const hRet = atHead.filter(m => (m.pxHi - m.pxLo) < 0.3);
  A(hRun.length === 3, `a moulded head over each window (${hRun.length})`);
  A(hRet.length === 6, `mitred returns at both ends of each head (${hRet.length})`);
  A(hRet.every(m => m.nv >= MOULDED), 'the returns carry the same section round the corner');
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
  A(sRet.length === 6, `mitred returns at both ends of each stool (${sRet.length})`);
  A(sRun.every(m => m.nv >= MOULDED), 'the stool is nosed, not a square board');
  if (sRun.length && sRet.length) {
    const proj = sRun[0].pzHi - sRun[0].pzLo;
    A(sRet.every(m => Math.abs((m.pxHi - m.pxLo) - proj) < 0.02),
      `and returns exactly its own projection (${R(proj, 3)} ft)`);
    A(proj > (jambs[0].pzHi - jambs[0].pzLo), 'the stool stands prouder than the casing');
  }

  const aprons = L.filter(m => m.pzLo < SWALL + 0.35 && Math.abs(m.yHi - sy) < 0.05
    && (m.yHi - m.yLo) > 0.3 && (m.yHi - m.yLo) < 0.5
    && (m.pxHi - m.pxLo) > 1.8 && (m.pxHi - m.pxLo) < 2.3);
  A(aprons.length === 3, `an apron under each window (${aprons.length})`);
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
    // The roof springs from the ceiling at the south eave and rises 0.45/ft north, so
    // the glazing must sit ABOVE the 9 ft ceiling or the well has no depth at all.
    A(k.yHi > 9.5, `glazing ${R((k.yHi - 9.0) * 12, 1)} in above the ceiling at its high edge`);
  });
}

// ============================================================ EXTENSION FIXTURES
// Laundry pair, WC toilet, and the bath's walk-in shower + vanity.
console.log('EXTENSION FIXTURES');
{ const LS = -11.688, BE = -22.688, BW = -17.687, BN = 3.771;   // interior faces
  const ext = P.filter(r => r.px < -11.9);

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

  // WC: toilet against the WEST wall (px -17.687), facing east into the room.
  { const t = ext.find(r => r.type === 'toilet');
    A(!!t, 'toilet in the WC');
    if (t) {
      A(Math.abs(t.pxHi - (-17.687)) < 0.08, `backs onto the WC's west wall (${R(t.pxHi,3)})`);
      A(t.pzLo > -11.72 && t.pzHi < -8.65, 'sits clear of both WC walls');
    } }

  // BATH: square walk-in at the north end. Pony wall + glass on the EAST half of the
  // opening, nothing on the WEST half — that gap IS the entrance.
  { const sh = ext.find(r => r.type === 'shower');
    A(!!sh, 'walk-in shower in the bath');
    if (sh) {
      const w = sh.pxHi - sh.pxLo, d = sh.pzHi - sh.pzLo;
      // 12 in shallower than it was built: 5 x 4 nominal, reading 0.3 over on each axis
      // because the tiled surround straddles the wall lines.
      A(Math.abs(w - 5.3) < 0.2 && Math.abs(d - 4.3) < 0.2, `${R(w,2)} x ${R(d,2)} ft`);
      // The tiled surround straddles the wall line by half its 0.3 ft thickness, so the
      // shower's box reads 0.15 past the interior face. That is the tile, not an error.
      A(Math.abs(sh.pzHi - BN) < 0.2, `set against the north wall (${R(sh.pzHi,2)} vs ${R(BN,2)})`);
      const mm = meshes(sh), open = sh.pzLo;                       // the opening line
      const atOpening = (m) => Math.abs((m.pzLo + m.pzHi) / 2 - open) < 0.3 && (m.pzHi - m.pzLo) < 0.5;
      const east = mm.filter(m => atOpening(m) && (m.pxLo + m.pxHi) / 2 < -20.19);
      const west = mm.filter(m => atOpening(m) && (m.pxLo + m.pxHi) / 2 > -20.19);
      A(east.length >= 2, `pony wall and glass close the EAST half (${east.length} members)`);
      A(west.length === 0, `the WEST half is open — that is the entrance (${west.length} members)`);
      const pony = east.filter(m => m.yLo < 0.1).sort((a, b) => b.yHi - a.yHi)[0];
      A(!!pony && pony.yHi > 3.0 && pony.yHi < 3.8, `pony wall stands ${R((pony ? pony.yHi : 0) * 12, 0)} in`);
      A(east.some(m => m.yLo > 3.0 && m.yHi > 8.9), 'glass carries on above it, to the ceiling');
      // FULL HEIGHT: the tiled enclosure runs floor to ceiling, not to 6'10".
      A(Math.abs(Math.max(...mm.map(m => m.yHi)) - 9.0) < 0.08,
        `enclosure tiled to ${R(Math.max(...mm.map(m => m.yHi)) * 12, 0)} in — the ceiling`);
      A(mm.filter(m => m.yHi > 8.9).length >= 3, 'back and both sides all reach it');
      // No curb: a walk-in should not have a threshold across its entrance.
      A(!mm.some(m => m.yHi < 0.4 && m.yHi > 0.15 && (m.pxHi - m.pxLo) > 1.0), 'curbless — no threshold across the opening');

      // VANITY on the east wall, directly south of the pony wall.
      const v = ext.find(r => r.type === 'vanity');
      A(!!v, 'vanity in the bath');
      if (v) {
        A(Math.abs(v.pxLo - BE) < 0.12, `backs onto the bath's east wall (${R(v.pxLo,3)})`);
        // Measured on the COUNTERTOP, which overhangs the cabinet by 0.075 each end.
        A(v.pzHi < open + 0.02 && v.pzHi > open - 0.45,
          `counter starts at the pony wall (${R(v.pzHi,3)} vs ${R(open,3)})`);
        const px0 = Math.min(...east.map(m => m.pxLo)), px1 = Math.max(...east.map(m => m.pxHi));
        A(v.pxLo >= px0 - 0.1 && v.pxHi <= px1 + 0.1, 'sits within the pony wall’s footprint — directly south of it');
        A(v.pxHi - v.pxLo > 1.7, `${R(v.pxHi - v.pxLo, 2)} ft deep`);
        A(v.pzHi - v.pzLo > 3.1, `${R(v.pzHi - v.pzLo, 2)} ft of counter — it was 2.4`);
        // Fewer fronts: two doors, not a nine-drawer grid. A front is a thin proud panel
        // on the cabinet face; the bar pulls are the same thickness but far shorter.
        // Below the counter only — the MIRROR is the same thin tall panel and counted
        // as a third front until this bound went in.
        const fronts = meshes(v).filter(m => (m.pxHi - m.pxLo) < 0.12 && m.yHi < 3.0
          && (m.yHi - m.yLo) > 1.0 && (m.pzHi - m.pzLo) > 0.5);
        A(fronts.length === 2, `two door fronts (${fronts.length}) — the 3x3 default is nine`);
        // The window casing runs 4 in past its jamb, so the counter has to stop short of it.
        A(v.pzLo > -3.795, `stops ${R((v.pzLo + 3.795) * 12, 1)} in clear of the window casing`);
      }

      // LIGHTING. The mirror had topped out at 65 in; sconces flank it and downlights
      // replace the generic per-room ceiling fixture.
      { const v2 = ext.find(r => r.type === 'vanity');
        if (v2) { const mir = meshes(v2).filter(m => m.yHi > 5.0 && (m.pxHi - m.pxLo) < 0.25)
            .sort((a, b) => b.yHi - a.yHi)[0];
          A(!!mir && Math.abs(mir.yHi - 6.5) < 0.08, `mirror tops out at ${R((mir ? mir.yHi : 0) * 12, 0)} in — it was 65`);
          A(!!mir && mir.yLo > 3.1, `its foot clears the counter by ${R((mir.yLo - 3.05) * 12, 1)} in`); }
        const sc = ext.filter(r => r.type === 'sconce' && r.pz > -8.3 && r.pz < 3.9);
        A(sc.length === 2, `two sconces at the mirror (${sc.length})`);
        if (sc.length === 2 && v2) {
          // It projects WEST off the east wall, so pxLo is the face and pxHi the globe.
          A(sc.every(m => Math.abs(m.pxLo - (-22.688)) < 0.1), 'both on the east wall beside it');
          A(sc.every(m => m.pxHi - m.pxLo < 0.9), `each projects ${R(Math.max(...sc.map(m => m.pxHi - m.pxLo)) * 12, 1)} in`);
          const pz = sc.map(m => m.pz).sort((a, b) => a - b);
          A(pz[0] < v2.pz && pz[1] > v2.pz, 'one either side of the vanity centre');
          A(sc.every(m => Math.abs(m.yLo + m.yHi) / 2 > 4.5), 'hung at mirror height');
        }
        const cans = ext.filter(r => r.type === 'recessed');
        A(cans.length === 4, `four downlights — three in the bath, one in the WC (${cans.length})`);
        A(cans.every(c => Math.abs(c.yHi - 9.0) < 0.06), 'all flush with the ceiling');
        A(cans.filter(c => c.pz > -8.3).length === 3 && cans.filter(c => c.pz < -8.3).length === 1,
          'three bath, one WC');
        // The generic per-room semi-flush hangs ~11 in below the ceiling. Nothing in
        // either room should now — that is what "remove the overhead lighting" means.
        const hung = L.filter(m => m.pxLo > -22.75 && m.pxHi < -17.6 && m.pzLo > -11.75 && m.pzHi < 3.85
          && (m.yLo + m.yHi) / 2 > 7.9 && (m.yLo + m.yHi) / 2 < 8.8
          && (m.pxHi - m.pxLo) < 1.5 && (m.pzHi - m.pzLo) < 1.5);
        A(hung.length === 0, `no ceiling fixture hanging in the bath or WC (${hung.length})`);
      }

      // WINDOW TRIM on the bath's east wall — the room had no trim program at all.
      { const BEW = -22.68785, DY = 0.066;      // interior face; loose meshes read DY low
        const onEast = (m) => m.pxLo > BEW - 0.05 && m.pxHi < BEW + 0.30
          && m.pzLo > -8.3 && m.pzHi < 3.9;
        const posts = L.filter(m => onEast(m) && (m.pzHi - m.pzLo) > 0.25 && (m.pzHi - m.pzLo) < 0.45
          && Math.abs(m.yLo - (3.0 - DY)) < 0.12 && m.yHi > 6.5);
        A(posts.length === 2, `a jamb casing each side of the bath window (${posts.length})`);
        A(posts.every(m => m.nv >= 100), 'both swept profiles, not boxes');
        const at = posts.map(m => R((m.pzLo + m.pzHi) / 2, 2)).sort((u, v2) => u - v2);
        A(JSON.stringify(at) === JSON.stringify([-6.96, -3.96]), `they land on the opening: ${at.join(', ')}`);
        const stool = L.filter(m => onEast(m) && (m.pzHi - m.pzLo) > 2.9
          && m.yHi > 3.0 - DY && m.yHi < 3.2);
        A(stool.length >= 1, `a stool at the sill (${stool.length})`);
        const apron = L.filter(m => onEast(m) && (m.pzHi - m.pzLo) > 2.8 && (m.pzHi - m.pzLo) < 3.3
          && m.yHi < 3.0 - DY + 0.02 && m.yLo > 2.4);
        A(apron.length >= 1, `an apron under it (${apron.length})`);
      }
    } }
}

// ============================================================ EAST EXTENSION
// Laundry / bath / WC / vestibule. An open leaf stands perpendicular to its wall, so
// the thin axis of its box IS the hinge jamb — which is what these measure.
console.log('EXTENSION');
{ const leaf = (re) => (raw.doorLeaves || []).find(d => re.test(d.name));
  const midPx = (d) => (d.pxLo + d.pxHi) / 2, midPz = (d) => (d.pzLo + d.pzHi) / 2;

  // WC door: 6 in of wall between the bath's east wall and the opening.
  { const d = leaf(/Bath -> WC/);
    A(!!d, 'WC door leaf found');
    if (d) {
      const face = -22.917 + 0.22915;                 // bath east wall, interior face
      A(Math.abs(midPx(d) - face - 0.5) < 0.03,
        `${R((midPx(d) - face) * 12, 1)} in of return from the bath's east wall`);
      A(d.pzHi <= -8.45 + 0.02, `swings into the WC (pz ${R(d.pzLo,2)}..${R(d.pzHi,2)})`);
    } }

  // LAUNDRY -> BATH. Was a 2'8" cased opening; the WC gave up depth so it could be a
  // proper 3 ft door. It is the only way into the bathroom, so both facts matter.
  { const d = leaf(/Laundry -> Bath/);
    A(!!d, 'laundry/bath door leaf found (it used to be a cased opening)');
    if (d) {
      A(Math.abs(midPz(d) - (-7.925)) < 0.06, `hinged on the SOUTH jamb (pz ${R(midPz(d),2)})`);
      A(midPx(d) < -17.46, `swings into the BATHROOM (px ${R(d.pxLo,2)}..${R(d.pxHi,2)})`);
      const swept = Math.abs(d.pxHi - d.pxLo);
      A(Math.abs(swept - 3.0) < 0.06, `${R(swept,2)} ft leaf — a full 3 ft door`);
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
    const posts = L.filter(m => onWall(m) && (m.pzHi - m.pzLo) < 0.45 && m.yLo < 0.05 && m.yHi > 6.5);
    A(posts.length === 4, `four casing jambs, two per opening (${posts.length})`);
    const at = posts.map(m => R((m.pzLo + m.pzHi) / 2, 2)).sort((u, v) => u - v);
    A(JSON.stringify(at) === JSON.stringify([-7.93, -4.93, -3.87, -0.87]),
      `jambs land on the openings: ${at.join(', ')}`);
    // Casing projects 0.045 m; the recessed field is 0.012. Without that the plain
    // field band above the head line — as wide as the wall — counted as a third head.
    const heads = L.filter(m => onWall(m) && (m.pzHi - m.pzLo) > 3.4 && m.yLo > 6.5
      && (m.pxHi - m.pxLo) > 0.10);
    A(heads.length === 2, `a head casing over each opening (${heads.length})`);
    if (heads.length) A(Math.abs(heads[0].yLo - (7.0 - DY)) < 0.05,
      `head sits on the 7 ft opening line (${R(heads[0].yLo + DY, 2)} ft)`);
    if (heads.length) A(Math.abs((heads[0].pzHi - heads[0].pzLo) - 3.66) < 0.05,
      `head returns over both jambs (${R(heads[0].pzHi - heads[0].pzLo, 2)} ft over a 3 ft opening)`);
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
    const jambs = onWall.filter(m => (m.pxHi - m.pxLo) < 0.5 && m.yLo < 0.1 && Math.abs(m.yHi - HEAD) < 0.06
      && (m.pzHi - m.pzLo) > 0.1 && (m.pzHi - m.pzLo) < 0.25);
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
      A(fr[0].parts === 11, `12-lite steel leaf: ${fr[0].parts} members (2 stiles, 2 rails, pane, 6 muntins)`);
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
  const REACH = { recessed: 12, pendant: 10, sconce: 8, undercabinet: 8.5, skylight: 16 };
  for (const [type, want] of Object.entries(REACH)) {
    const own = LI.filter(l => l.owner === type);
    if (!own.length) continue;
    const ft = own.map(l => l.distance / FT);
    A(ft.every(d => Math.abs(d - want) < 0.05),
      `${type} reaches ${want} ft (${[...new Set(ft.map(d => R(d, 2)))].join(', ')}) \u00d7${own.length}`);
  }
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

console.log(fail ? `\n${fail} FAILURES` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
