// Kitchen verification harness.
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
  return { items, loose };
});
await b.close();

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
const west    = pick('cabinet_run', 'base', -6.9942);
const WALL = 15.3125, FR = 0.17, REV = 0.03, SET = 0.02;
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
  A(Math.min(...backs) > 0.014 && Math.max(...backs) < 0.028,
    `${n}: fronts set back ${R(Math.min(...backs) * 12, 2)} in behind the frame face`);
  const mods = modsOf(r, face, sgn);
  let minGap = Infinity;
  for (let i = 1; i < mods.length; i++) minGap = Math.min(minGap, mods[i].lo - mods[i - 1].hi);
  if (mods.length > 1) A(minGap > FR + 2 * REV - 0.02,
    `${n}: ${R(minGap * 12, 2)} in between adjacent fronts (stile ${R(FR * 12, 1)} + two ${R(REV * 12, 2)} in reveals)`);
}

console.log('DOOR WIDTHS');
{ const doorRuns = RUNS.filter(([n]) => n !== 'drawers');   // drawer banks are double width by direction
  const all = doorRuns.flatMap(([n, r, face, sgn]) => modsOf(r, face, sgn).map(m => [n, m.hi - m.lo]));
  const wide = all.filter(([, w]) => w > 1.95);
  A(!wide.length, `no door wider than 1.95 ft (widest ${R(Math.max(...all.map(x => x[1])), 3)})`
    + (wide.length ? ` — ${wide.map(([n, w]) => n + ' ' + R(w, 2))}` : ''));
  A(modsOf(west, 30.7708 - 2.0, -1).length === 5, `west run subdivides to 4 doors + 1`); }

console.log('BATTENS');
// A batten is narrow in BOTH horizontal directions; the recessed field band is equally
// thin in projection but runs the length of the wall.
const battens = L.filter(m => m.yLo > 0.7 && m.yLo < 0.95 && (m.yHi - m.yLo) > 1.5
  && (m.pxHi - m.pxLo) < 0.25 && (m.pzHi - m.pzLo) < 0.25);
A(!battens.filter(m => m.pzLo > -12 && m.pzHi < 2.1 && m.pxLo > 15.2 && m.pxHi < 31.1).length,
  'no battens on the kitchen walls');
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
A(![...mm, ...mu].flatMap(m => [m.lo, m.hi]).some(e => !LINES.some(l => Math.abs(e - l) < 0.22)),
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
A(Math.abs((west.top - FY) / FT - 3.08) < 0.03, `west worktop at ${R((west.top - FY) / FT, 3)} ft`);
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
console.log(fail ? `\n${fail} FAILURES` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
