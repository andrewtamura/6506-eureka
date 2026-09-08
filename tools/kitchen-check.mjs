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
import puppeteer from 'puppeteer';
const FT = 0.3048;
const b = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--no-sandbox', '--enable-unsafe-swiftshader', '--window-size=1200,800'], protocolTimeout: 900000 });
const page = await b.newPage(); await page.setViewport({ width: 1200, height: 800 });
page.on('pageerror', e => console.log(' [pageerror]', String(e).slice(0, 300)));
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
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
    items.push({ type: it.type, kind: it.kind || '', px: it.px, pz: it.pz, floorY: o.position.y,
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
    loose.push([mb.min.x, mb.min.y, mb.min.z, mb.max.x, mb.max.y, mb.max.z]);
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
  return { items, loose, doorLeaves };
});
await b.close();
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
  yLo: (a[1] - FY) / FT, yHi: (a[4] - FY) / FT }));
const meshes = r => (r ? r.parts : []).map(a => ({ pxLo: -a[3] / FT, pxHi: -a[0] / FT,
  pzLo: -a[5] / FT, pzHi: -a[2] / FT, yLo: (a[1] - FY) / FT, yHi: (a[4] - FY) / FT }));
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
{ const sb = battens.filter(m => m.pzHi < -11.9 && m.pzLo > -18.7);   // inside the room
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
// WINDOWS TRIMMED: casing posts, a stool and an apron at each opening
{ const sy = 4.0 - 0.066;                       // the wall finish sits 0.02 m below the furniture datum
  const trim = L.filter(m => m.pzLo < SWALL + 0.35 && m.pxLo > 0 && m.pxHi < 28
    && m.yHi > sy - 0.1 && m.yHi < sy + 0.2 && (m.pxHi - m.pxLo) > 2.4 && (m.pxHi - m.pxLo) < 3.2);
  A(trim.length === 3, `a stool at each of the three south windows (${trim.length})`);
  // A casing post is 4 in wide and runs SILL to HEAD. Battens are 1 in wide and start at
  // the baseboard, so width alone let 180 of them through — the check verified nothing.
  const posts = L.filter(m => m.pzLo < SWALL + 0.35
    && Math.abs(m.yLo - sy) < 0.12 && m.yHi > 6.7 && m.yHi < 7.1
    && (m.pxHi - m.pxLo) > 0.25 && (m.pxHi - m.pxLo) < 0.45);
  A(posts.length === 6, `two casing posts at each of the three windows (${posts.length})`);
  const aprons = L.filter(m => m.pzLo < SWALL + 0.35 && Math.abs(m.yHi - sy) < 0.05
    && (m.yHi - m.yLo) > 0.3 && (m.yHi - m.yLo) < 0.5
    && (m.pxHi - m.pxLo) > 1.8 && (m.pxHi - m.pxLo) < 2.3);
  A(aprons.length === 3, `an apron under each window (${aprons.length})`); }

// EAST WINDOW. Its casing runs 4 in past the opening, and a wall-centred window would
// have put that on top of the countertop's east return — which is why it sits north.
{ const EW = 0.1458, sy = 3.5 - 0.066, cf = SWALL + 2.0;
  const cased = L.filter(m => m.pxHi > EW - 0.05 && m.pxLo < EW + 0.35
    && m.yHi > sy - 0.1 && m.yHi < sy + 0.25 && (m.pzHi - m.pzLo) > 2.9 && (m.pzHi - m.pzLo) < 3.4);
  A(cased.length === 1, `east window has a stool (${cased.length})`);
  if (cased.length) A(cased[0].pzLo > cf + 0.05,
    `its casing clears the countertop's east return by ${R((cased[0].pzLo - cf) * 12, 1)} in`);
  const posts = L.filter(m => m.pxHi > EW - 0.05 && m.pxLo < EW + 0.35
    && Math.abs(m.yLo - sy) < 0.14 && m.yHi > 6.7 && m.yHi < 7.1
    && (m.pzHi - m.pzLo) > 0.25 && (m.pzHi - m.pzLo) < 0.45);
  A(posts.length === 2, `two casing posts on the east window (${posts.length})`); }

// ============================================================ CAFE NOOK (SW corner)
// The scullery is only 6'6" deep, so a bench + table + chair stack spans the room
// wall to wall. What has to be measured is therefore not "does it fit" but "can you
// still get from the kitchen portal to the back door" — hence the lane checks below.
console.log('CAFE NOOK');
{ const WWALL = 27.8542;                       // west wall interior face
  const bq = P.find(r => r.type === 'banquette');
  A(!!bq, 'banquette built');
  if (bq) {
    const bm = meshes(bq);
    console.log(`  banquette px ${R(bq.pxLo,3)}..${R(bq.pxHi,3)}  pz ${R(bq.pzLo,3)}..${R(bq.pzHi,3)}`);
    A(Math.abs(bq.pxHi - WWALL) < 0.02, `back on the WEST wall (${R(bq.pxHi,4)})`);
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
    A(Math.abs((bq.pzLo + bq.pzHi) / 2 - (-15.17)) < 0.5, `centred on the west window (off by ${R(Math.abs((bq.pzLo + bq.pzHi) / 2 + 15.17) * 12, 1)} in)`);
  }
  const tb = P.find(r => r.type === 'round_pedestal_table' && r.pz < -12);
  A(!!tb, 'cafe table built');
  if (tb && bq) {
    const dia = tb.pzHi - tb.pzLo;
    A(Math.abs(dia - 2.25) < 0.05, `${R(dia * 12, 1)} in round top`);
    A(Math.abs(tb.yHi - 2.5) < 0.03, `top at ${R(tb.yHi * 12, 1)} in`);
    const gap = bq.pxLo - tb.pxHi;
    A(gap > 0.1 && gap < 0.55, `${R(gap * 12, 1)} in between the table and the bench front`);
  }
  const ch = P.filter(r => r.type === 'upholstered_dining_chair' && r.pz < -12);
  A(ch.length === 2, `two chairs at the table (${ch.length})`);
  // Chairs must actually have found this table, not the dining-room one three rooms away.
  if (tb) for (const c of ch) {
    const d = Math.hypot((c.pxLo + c.pxHi) / 2 - tb.px, (c.pzLo + c.pzHi) / 2 - tb.pz);
    A(d > 1.3 && d < 2.1, `chair pulled up to this table (${R(d, 2)} ft from its centre)`);
  }
  // CIRCULATION. The kitchen -> scullery portal is 6 ft of opening at px 20.04..26.04 in
  // the north wall; the back door is at px 16.17..19.17 in the south wall. Sample across
  // the portal and measure how far south you can walk before meeting the nook.
  const nook = [bq, tb, ...ch].filter(Boolean).flatMap(meshes);
  let bestLane = 0, run = 0, minDepth = 99;
  for (let x = 20.04; x <= 26.04; x += 0.02) {
    const hit = nook.filter(m => m.pxLo < x && m.pxHi > x);
    const depth = hit.length ? NWALL - Math.max(...hit.map(m => m.pzHi)) : SWALL - NWALL;
    minDepth = Math.min(minDepth, Math.abs(depth));
    if (Math.abs(depth) > 5.0) { run += 0.02; bestLane = Math.max(bestLane, run); } else run = 0;
  }
  A(bestLane > 1.9, `${R(bestLane * 12, 1)} in of full-depth lane through the portal`);
  A(minDepth > 0.8, `at its tightest the portal still opens ${R(minDepth * 12, 1)} in before the nook`);
  // Along the north wall you must be able to cross the whole west end to reach the
  // galley — measure the shallowest point of that strip over the nook's own footprint.
  { let worst = 99;
    for (let x = 22.2; x <= 25.7; x += 0.02) {
      const hit = nook.filter(m => m.pxLo < x && m.pxHi > x);
      if (hit.length) worst = Math.min(worst, NWALL - Math.max(...hit.map(m => m.pzHi)));
    }
    A(worst > 1.9, `${R(worst * 12, 1)} in of clear strip along the north wall past the nook`); }
  // Nothing may reach the back door's swing zone.
  { const east = Math.min(...nook.map(m => m.pxLo));
    A(east > 19.17 + 0.5, `nook stops ${R((east - 19.17) * 12, 1)} in short of the back door`); }
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

// BACK DOOR: outswing, and glazed from the inside too
{ const d = (raw.doorLeaves || []).find(x => /back/i.test(x.name));
  A(!!d, 'back door leaf found');
  if (d) {
    A(d.pzHi <= -18.875 + 0.02, `swings OUT — leaf at pz ${R(d.pzLo,3)}..${R(d.pzHi,3)}, wall -18.875`);
    // 2 stiles + 2 rails + 1 pane + 1 vertical muntin + 3 horizontal = 9 members.
    A(d.parts === 9, `8-lite leaf: ${d.parts} members (2 stiles, 2 rails, pane, 4 muntins)`);
  } }

console.log(fail ? `\n${fail} FAILURES` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
