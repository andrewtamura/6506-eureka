// Guard the cost of a FRAME, the way kitchen-check.mjs guards the geometry.
//
//   node tools/frame-check.mjs            # assert
//   node tools/frame-check.mjs --report   # just print the numbers
//
// Panning felt sluggish because the ground floor issued 1857 draw calls a frame
// and spent ~20-26 ms inside WebGLRenderer.render() — pure JS walking the scene
// graph, before the GPU drew a pixel. src/consolidate.js collapses the static
// millwork to one mesh per material; this harness stops that silently regressing
// when someone adds a few hundred more little meshes.
//
// It asserts DRAW CALLS, not milliseconds, as the primary check: the call count
// is deterministic and identical on any machine, while swiftshader's ms are not.
// render() ms is reported and only loosely bounded.
//
// NOTE the two traps tools/shot.mjs documents and this shares: `?solo=ground` (the
// exhibits stream forever otherwise) and `?norender=1` (in headless every presented
// frame costs a synchronous GPU readback). Neither affects what is measured here —
// rendering is driven explicitly, off the auto loop.
import puppeteer from 'puppeteer';

const REPORT = process.argv.includes('--report');
// --full drops ?solo and waits for the exhibits, which is the case that actually
// regressed: consolidateStatic runs at the end of init, but the Second Floor and Attic
// stream in ~130 s LATER, so without a second pass their geometry is never merged and
// the scene the owner really pans costs 879 draw calls instead of 333.
const FULL = process.argv.includes('--full');
const URL = process.env.CHECK_URL ||
  (FULL ? 'http://localhost:5173/?norender=1' : 'http://localhost:5173/?solo=ground&norender=1');

// Budgets. Headroom is deliberate: these catch a STRUCTURAL regression (someone
// adds 800 unmerged meshes, or the consolidate pass silently stops running), not
// a few parts here or there.
const MAX_CALLS = FULL ? 680 : 420;      // ground: 333 merged / 1857 before. full: 613 / 879 before
const MAX_MESHES = FULL ? 700 : 420;    // meshes in the scene and drawable
const MIN_ABSORBED = FULL ? 2500 : 1400;// authored meshes the merge swallowed
// Mergeable (opaque, single-material) model meshes still drawing on their own — the ones the
// consolidate pass could have taken and did not. It reads 76 on the full scene, and 76 is not
// a regression: MEASURED ACROSS TWO BUILDS DIFFERING BY ~500 PRODUCTS (balustraded quarter
// arcs, then a circular ring) it did not move by one, while `merged` sat at 113 in both. So
// it does not scale with the model's geometry, which is exactly what makes it worth asserting
// — if the pass stopped running, every mesh it absorbs would land in this bucket instead.
// An earlier 40 came from a probe taken BEFORE the level switch this harness performs, which
// is not the moment it measures; that was the wrong number, not a real failure.
const MAX_FRAG_LOOSE = FULL ? 110 : 60;

const b = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--no-sandbox', '--enable-unsafe-swiftshader'], protocolTimeout: 900000 });
const page = await b.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', e => console.log(' [pageerror]', String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 180; i++) {
  if (await page.evaluate(() => !!window.__eureka?.consolidated)) break;
  await new Promise(r => setTimeout(r, 2000));
}
if (FULL) {
  for (let i = 0; i < 300; i++) {
    if (await page.evaluate(() => !!window.__eureka.exhibitsReady).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  await page.evaluate(() => window.__eureka.exhibitsReady);
  await new Promise(r => setTimeout(r, 15000));   // the exhibit consolidate pass
}
await page.evaluate(() => document.querySelector('#level-switcher [data-id="ground"]')?.click());
await new Promise(r => setTimeout(r, 8000));
await page.evaluate(() => window.__eureka.setPlanView?.(false));
await new Promise(r => setTimeout(r, 2000));

const m = await page.evaluate(async () => {
  const w = window.__eureka.world, s = w.scene.three, r3 = w.renderer.three, cam = w.camera.three;
  const dom0 = r3.domElement;
  let visible = 0, hidden = 0, dynamic = 0;
  s.traverse(o => { if (!o.isMesh) return; o.visible ? visible++ : hidden++;
    if (o.userData?.dynamic) dynamic++; });
  for (let i = 0; i < 3; i++) r3.render(s, cam);
  const t = performance.now();
  for (let i = 0; i < 12; i++) r3.render(s, cam);
  // Snapshot BOTH numbers here. The probes below move the camera and stall on a
  // readPixels, so reading them at return time reported a 4.8 SECOND frame and a
  // draw-call count taken from two feet in front of a door.
  const frameMs = +((performance.now() - t) / 12).toFixed(1);
  const drawCalls = r3.info.render.calls;
  const tris = r3.info.render.triangles;

  // Double-tapping a door raycasts against the AUTHORED meshes, which
  // consolidate.js has hidden. three's Raycaster has no visibility check, so that
  // still works — but it is load-bearing enough to test end to end rather than
  // assume: aim the camera at a door leaf and ask the viewer's own pickDoor().
  let pickable = null;
  // Not every leaf gets merged — a group of one saves nothing — so take the first
  // leaf that actually HAS hidden parts, which is the case under test.
  let leaf = null, parts = [];
  for (const d of window.__eureka.doors || []) {
    const p = [];
    d.pivot.traverse(o => { if (o.isMesh && !o.visible) p.push(o); });
    if (p.length > parts.length) { leaf = d; parts = p; }
  }
  if (leaf && window.__eureka.pickDoor) {
    const target = parts.sort((a, b) =>
      b.geometry.getAttribute('position').count - a.geometry.getAttribute('position').count)[0];
    if (target) {
      target.geometry.computeBoundingBox();
      const c = target.geometry.boundingBox.getCenter(cam.position.clone()).applyMatrix4(target.matrixWorld);
      const n = cam.position.clone().sub(c).normalize();
      w.camera.controls.setLookAt(c.x + n.x * 2.5, c.y + 1, c.z + n.z * 2.5, c.x, c.y, c.z, false);
      cam.updateMatrixWorld(true);
      const p = c.clone().project(cam);
      const dom = r3.domElement;
      pickable = { hiddenParts: parts.length,
        hit: !!window.__eureka.pickDoor((p.x * 0.5 + 0.5) * dom.clientWidth,
                                        (-p.y * 0.5 + 0.5) * dom.clientHeight) };
    }
  }
  // Selection highlighting is gone from the viewer, which is what lets consolidate
  // merge a fragments model's own meshes. Assert that it actually does — but count only
  // the meshes it COULD have merged.
  //
  // A raw count of unmerged model meshes is not that. Most of them carry a MATERIAL ARRAY:
  // that is fragments batching several materials into one mesh, which `mergeable` rejects
  // outright and which consolidate has never touched. Their number tracks how much geometry
  // the model holds, not whether the pass ran — putting balustrades on the front approach
  // added 13 of them and moved the frame by ONE draw call, which failed a budget that was
  // meant to catch someone adding 800 unmerged meshes. Transparent members are left out on
  // purpose too (merging them gives the group one sort position).
  //
  // What is left — opaque, single-material, still drawing on its own — is the real signal:
  // those are singleton groups the pass looked at and had nothing to pair with. If the pass
  // stopped running, every mesh it currently absorbs would land in exactly this bucket.
  const fragRoots = new Set();
  for (const [, m] of window.__eureka.fragments.list) if (m.object) fragRoots.add(m.object);
  let fragLoose = 0, fragBatched = 0, fragTrans = 0, fragMerged = 0;
  const fwalk = (o, inFrag) => {
    const f = inFrag || fragRoots.has(o);
    if (o.isMesh && f && o.visible) {
      const mat = o.material;
      if (o.userData.merged) fragMerged++;
      else if (Array.isArray(mat)) fragBatched++;
      else if (!mat || mat.transparent || mat.opacity < 1) fragTrans++;
      else fragLoose++;
    }
    for (const c of o.children) fwalk(c, f);
  };
  fwalk(s, false);

  // Tapping an element still names it in the properties panel, and that goes through
  // model.raycast. If fragments picked against the SCENE meshes, hiding them behind a
  // merged copy would have killed tap-to-inspect outright — so prove it still hits.
  let inspect = null;
  try {
    const model = window.__eureka.model;
    const dom = r3.domElement;
    const mouse = new window.THREE.Vector2(dom.clientWidth / 2, dom.clientHeight / 2);
    const hit = await model.raycast({ camera: cam, mouse, dom });
    inspect = { hit: !!hit, id: hit ? hit.localId : null };
  } catch (e) { inspect = { hit: false, error: String(e).slice(0, 120) }; }

  return { ms: frameMs, calls: drawCalls, triangles: tris, inspect,
           fragLoose, fragBatched, fragTrans, fragMerged,
           visible, hidden, pickable, ...window.__eureka.consolidated,
           absorbed: (window.__eureka.consolidated?.absorbed || 0) +
                     (window.__eureka.consolidatedExhibits?.absorbed || 0),
           merged: (window.__eureka.consolidated?.merged || 0) +
                   (window.__eureka.consolidatedExhibits?.merged || 0) };
});
// The performance HUD toggle. Built on first use, so this also proves the lazy
// construction path works — and that the button reports the state it is actually in,
// which it did not at first (build-then-flip hid it on the very first click).
const hud = await page.evaluate(async () => {
  const btn = document.getElementById('perf-toggle');
  if (!btn) return { button: false };
  const panel = () => [...document.querySelectorAll('div')]
    .find(e => /draw calls/.test(e.textContent || ''));
  const shown = () => { const p = panel(); return !!p && p.style.display !== 'none'; };
  const before = { exists: !!panel(), label: btn.textContent };
  window.__eureka.togglePerf(true);
  await new Promise(r => setTimeout(r, 1400));
  const on = { shown: shown(), label: btn.textContent, text: (panel() || {}).textContent || '' };
  window.__eureka.togglePerf(false);
  const off = { shown: shown(), label: btn.textContent };
  return { button: true, before, on, off };
});

// The HUD's benchmark drives the renderer into AUTO on purpose — it is the only way to
// see GPU cost on a browser with no timer query — so the thing that MUST hold is that it
// puts the mode back. Leaving it in AUTO would silently undo render-on-demand and
// nothing else here would notice. Also check the lights control restores exactly what it
// switched off.
const BENCH_S = 4;
const bench = await page.evaluate(async ({ BENCH_S, FULL }) => {
  window.__eureka.togglePerf(true);
  await new Promise(r => setTimeout(r, 300));
  const perf = window.__eureka.perf;
  const modeBefore = window.__eureka.world.renderer.mode;
  // 4 s, not 2: the full ground scene draws at roughly 1 fps under swiftshader, so a
  // 2 s window asserting "at least 2 frames" sits right on the edge and fails
  // intermittently. The assertion is about measuring DRAWN frames, not about speed.
  const r = await perf.benchmark(BENCH_S);
  const modeAfter = window.__eureka.world.renderer.mode;
  // Light a level OTHER than the one being viewed, which is the only situation the dim
  // control exists for. Left at the default it has nothing to do and the assertion below
  // compared 6 against 6: fixture lighting is a RADIO, `auto` lights the lot's lanterns,
  // and a daylit photocell holds even those off — so every one of those 6 was the sun,
  // a fill or a skylight well, none of which are fixtures and none of which this touches.
  if (FULL) window.__eureka.selectLighting('level2');
  const before = perf.lightsOn();
  const dim = perf.dimOtherLevels();
  const undim = perf.dimOtherLevels();
  if (FULL) window.__eureka.selectLighting('auto');
  window.__eureka.togglePerf(false);
  return { modeBefore, modeAfter, ...r, lights: { before, dimmed: dim.lightsOn, restored: undim.lightsOn } };
}, { BENCH_S, FULL });

// RENDER ON DEMAND. Measured against the real update loop, not by calling render()
// ourselves: idle should cost only the safety heartbeat, and moving the camera should
// cost real frames. The failure mode of this feature is a viewer that looks frozen, so
// it is worth asserting in both directions.
const demand = await page.evaluate(async () => {
  const r = window.__eureka.world.renderer;
  const n = () => window.__eureka.world.renderer.three.info.render.frame;
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const mode = r.mode;
  const a = n(); await wait(2000); const idle = n() - a;          // untouched
  const b2 = n();
  const c = window.__eureka.world.camera.controls;
  for (let i = 0; i < 30; i++) { c.rotate(0.01, 0, false); await new Promise(rr => requestAnimationFrame(rr)); }
  const moving = n() - b2;
  return { mode, idleFrames: idle, movingFrames: moving };
});
// THE LANDSCAPE RAIL, THE FULLSCREEN BUTTON, AND THE PORTRAIT COLLISION. Run LAST of the
// measurements: it flips the viewport to portrait and back, which would otherwise disturb
// the draw-call, door-pick and HUD numbers taken above.
//
// The safe-area insets themselves cannot be asserted here — desktop Chrome reports
// env(safe-area-inset-*) as 0 and puppeteer cannot fake a notch — so what is measured is
// the LAYOUT they are applied to, which is where a regression would actually show.
const ui = await page.evaluate(async () => {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const hdr = document.querySelector('[data-menu] .menu-header');
  const label = hdr && hdr.querySelector('.ml');
  // Immersive is driven by applying the class directly: headless Chrome HAS the Fullscreen
  // API, so the fallback path would otherwise never be exercised here at all.
  const fsBtn = document.getElementById('fullscreen-toggle');
  document.body.classList.add('immersive');
  const hidden = ['ui-left', 'bottom-bar', 'status']
    .map(id => cs(document.getElementById(id))?.display);
  const btnStill = cs(fsBtn)?.display;
  document.body.classList.remove('immersive');
  return { labelDisplay: cs(label)?.display, fsBtn: !!fsBtn,
           handle: typeof window.__eureka.toggleFullscreen,
           supported: window.__eureka.fullscreenSupported, hidden, btnStill };
});

const rect = (sel) => page.evaluate((q) => {
  const e = document.querySelector(q);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
}, sel);
const overlaps = (a, b) => !!a && !!b &&
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

await page.evaluate(() => document.querySelector('[data-menu].open .menu-header')?.click());
const land = await (async () => {
  const vp = page.viewport();
  const railR = await rect('#ui-left');
  await page.evaluate(() => document.querySelector('[data-menu] .menu-header')?.click());
  await new Promise(r => setTimeout(r, 200));
  const bodyR = await rect('[data-menu].open .menu-body');
  await page.evaluate(() => document.querySelector('[data-menu].open .menu-header')?.click());
  const fsR = await rect('#fullscreen-toggle');
  const label = await page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-menu] .menu-header .ml')).display);
  return { vp, railR, bodyR, fsR, label };
})();
// ...then portrait, where the button is top-right and the menus are a row along the top.
// ON ITS OWN PAGE, not by resizing this one: flipping the measured page's viewport and
// back threw `Attempted to use detached Frame` and took the whole harness down after the
// numbers were in. The portrait layout is static CSS in index.html, so it needs neither
// the model nor `window.__eureka` — only the markup, which is there at DOMContentLoaded.
const port = await (async () => {
  const p2 = await b.newPage();
  try {
    await p2.setViewport({ width: 390, height: 844 });
    await p2.goto(URL, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 600));
    const r2 = (q) => p2.evaluate((sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    }, q);
    return { rowR: await r2('#ui-left'), fsR: await r2('#fullscreen-toggle') };
  } finally { await p2.close(); }
})();

await b.close();

console.log(`\nFRAME COST  (${URL})`);
console.log(`  draw calls per frame     ${m.calls}`);
console.log(`  visible meshes           ${m.visible}   (hidden originals: ${m.hidden})`);
console.log(`  merged meshes            ${m.merged}  absorbing ${m.absorbed}`);
console.log(`  frozen transforms        ${m.frozen}`);
console.log(`  consolidate pass         ${m.buildMs} ms at init`);
console.log(`  render()                 ${m.ms} ms/frame  (swiftshader; indicative only)`);
console.log(`  renderer mode            ${demand.mode === 0 ? 'MANUAL (on demand)' : 'AUTO'}`);
console.log(`  frames drawn: idle 2 s   ${demand.idleFrames}   while panning  ${demand.movingFrames}`);
console.log(`  model-owned meshes: ${m.fragMerged} merged, ${m.fragBatched} batched by fragments, ` +
            `${m.fragTrans} transparent, ${m.fragLoose} mergeable and still loose`);
console.log(`  perf HUD                 ${hud.button ? (hud.before.exists ? 'built at startup' : 'built on first use') : 'NO BUTTON'}`);
console.log(`  benchmark                ${bench.fps.toFixed(1)} fps flat out, ${bench.frameMs.toFixed(1)} ms/frame = ${bench.cpuMs.toFixed(1)} cpu + ${bench.other.toFixed(1)} other`);
console.log(`  lights                   ${bench.lights.before} on -> ${bench.lights.dimmed} dimmed -> ${bench.lights.restored} restored`);


if (REPORT) process.exit(0);
let bad = 0;
const A = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) bad++; };
console.log('');
A(m.calls <= MAX_CALLS, `${m.calls} draw calls per frame (budget ${MAX_CALLS})`);
A(m.visible <= MAX_MESHES, `${m.visible} drawable meshes (budget ${MAX_MESHES})`);
A(m.absorbed >= MIN_ABSORBED, `the merge absorbed ${m.absorbed} authored meshes (at least ${MIN_ABSORBED})`);
A(m.hidden >= MIN_ABSORBED, `the originals are still in the scene, hidden (${m.hidden}) — kitchen-check measures them`);
A(m.frozen > 1000, `static transforms frozen (${m.frozen})`);
A(ui.labelDisplay === 'none' && land.railR && land.railR.w < 80,
  `landscape shows an icon rail, not the labelled stack (${Math.round(land.railR?.w)} px wide, labels ${ui.labelDisplay})`);
A(land.bodyR && land.bodyR.w > 150,
  `and an open menu's body escapes the chip (${Math.round(land.bodyR?.w)} px — a backdrop-filter on .menu clips it to ~44)`);
A(ui.fsBtn && ui.handle === 'function', `the fullscreen button exists and is exposed (${ui.handle})`);
A(ui.hidden.every(d => d === 'none') && ui.btnStill !== 'none',
  `immersive hides the chrome and keeps the way back (${ui.hidden.join('/')}, button ${ui.btnStill})`);
// THE RAIL IS ON THE RIGHT, where the sensor housing is not.
A(land.railR && land.railR.x > land.vp.width / 2 && land.vp.width - land.railR.right < 24,
  `the rail is pinned to the right edge (x ${Math.round(land.railR?.x)} of ${land.vp.width}, ` +
  `${Math.round(land.vp.width - (land.railR?.right ?? 0))} px clear of it)`);
// ...and the body opens INWARD. Set `right` without clearing the base rule's `left` and it
// stretches the whole width instead — which still looks like a menu, just the wrong one.
A(land.bodyR && land.railR && land.bodyR.right <= land.railR.x + 2 && land.bodyR.w > 150,
  `an open menu opens inward, left of the rail (body ends at ${Math.round(land.bodyR?.right)}, ` +
  `rail starts at ${Math.round(land.railR?.x)})`);
A(land.fsR && land.vp.height - land.fsR.bottom < 24 && !overlaps(land.fsR, land.railR),
  `the fullscreen button sits bottom-right, clear of the rail ` +
  `(${Math.round(land.vp.height - (land.fsR?.bottom ?? 0))} px off the bottom)`);
// PORTRAIT: the row and the button overlapped on the build this replaces — the button is
// top-right at a higher z-index and the row ran the full width, so it covered the last chip.
A(port.rowR && port.fsR && !overlaps(port.rowR, port.fsR),
  `portrait: the icon row stops clear of the button ` +
  `(row ends ${Math.round(port.rowR?.right)}, button starts ${Math.round(port.fsR?.x)})`);
A(hud.button, `the UI has a performance HUD button`);
A(hud.button && !hud.before.exists, `the HUD is built on first use, not at startup — no render() wrapper nobody asked for`);
A(hud.button && hud.on.shown && /draw calls/.test(hud.on.text) && /Hide/.test(hud.on.label),
  `the button shows the HUD and says so (${hud.button ? hud.on.label : '—'})`);
A(hud.button && !hud.off.shown && !/Hide/.test(hud.off.label),
  `and hides it again (${hud.button ? hud.off.label : '—'})`);
A(bench.modeAfter === bench.modeBefore,
  `the benchmark puts the renderer mode back (${bench.modeBefore} -> ${bench.modeAfter}) — leaving it in AUTO would undo render-on-demand`);
A(bench.frames >= 2 && bench.fps > 0,
  `the benchmark measures frames actually drawn (${bench.frames} in ${BENCH_S} s)`);
A(bench.lights.restored === bench.lights.before,
  `the lights control restores exactly what it switched off (${bench.lights.before} -> ${bench.lights.dimmed} -> ${bench.lights.restored})`);
// Second-floor fixtures are lit above (the viewer is on the ground floor), so this is
// the control doing its job: every light it switched off belongs to another level.
if (FULL) A(bench.lights.dimmed < bench.lights.before,
  `dimming the other levels removes real lights (${bench.lights.before} -> ${bench.lights.dimmed})`);
A(m.inspect && m.inspect.hit,
  `tap-to-inspect still resolves an element (${m.inspect ? (m.inspect.error || 'localId ' + m.inspect.id) : 'no result'}) — fragments picks against its own data, not the hidden meshes`);
A(m.fragLoose <= MAX_FRAG_LOOSE,
  `fragments geometry is merged too (${m.fragLoose} mergeable model meshes still loose, budget ` +
  `${MAX_FRAG_LOOSE}; ${m.fragMerged} merged, ${m.fragBatched} batched by fragments)`);
A(m.fragMerged >= (FULL ? 12 : 6),
  `...and the pass really ran on them (${m.fragMerged} merged model meshes)`);
A(demand.mode === 0, `renderer is in MANUAL mode — frames drawn on demand, not every tick`);
A(demand.idleFrames <= 8, `idle costs only the safety heartbeat (${demand.idleFrames} frames in 2 s)`);
A(demand.movingFrames >= 10, `panning still draws (${demand.movingFrames} frames over 30 camera steps)`);
A(m.pickable && m.pickable.hit,
  `a hidden door leaf is still pickable (${m.pickable ? m.pickable.hiddenParts : 0} hidden parts) — double-tap still opens doors`);
console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
