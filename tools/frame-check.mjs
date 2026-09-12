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
const MAX_FRAG_LOOSE = FULL ? 250 : 120;// model-owned meshes still drawing separately

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
  // merge a fragments model's own meshes. Assert that it actually does: count the
  // visible, unmerged meshes still owned by a model. Before, every one of them drew
  // separately because each carried its own material so it could be recoloured.
  const fragRoots = new Set();
  for (const [, m] of window.__eureka.fragments.list) if (m.object) fragRoots.add(m.object);
  let fragLoose = 0;
  const fwalk = (o, inFrag) => {
    const f = inFrag || fragRoots.has(o);
    if (o.isMesh && f && o.visible && !o.userData.merged) fragLoose++;
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

  return { ms: frameMs, calls: drawCalls, triangles: tris, fragLoose, inspect,
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
console.log(`  model-owned meshes still drawing separately  ${m.fragLoose}`);
console.log(`  perf HUD                 ${hud.button ? (hud.before.exists ? 'built at startup' : 'built on first use') : 'NO BUTTON'}`);

if (REPORT) process.exit(0);
let bad = 0;
const A = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) bad++; };
console.log('');
A(m.calls <= MAX_CALLS, `${m.calls} draw calls per frame (budget ${MAX_CALLS})`);
A(m.visible <= MAX_MESHES, `${m.visible} drawable meshes (budget ${MAX_MESHES})`);
A(m.absorbed >= MIN_ABSORBED, `the merge absorbed ${m.absorbed} authored meshes (at least ${MIN_ABSORBED})`);
A(m.hidden >= MIN_ABSORBED, `the originals are still in the scene, hidden (${m.hidden}) — kitchen-check measures them`);
A(m.frozen > 1000, `static transforms frozen (${m.frozen})`);
A(hud.button, `the UI has a performance HUD button`);
A(hud.button && !hud.before.exists, `the HUD is built on first use, not at startup — no render() wrapper nobody asked for`);
A(hud.button && hud.on.shown && /draw calls/.test(hud.on.text) && /Hide/.test(hud.on.label),
  `the button shows the HUD and says so (${hud.button ? hud.on.label : '—'})`);
A(hud.button && !hud.off.shown && !/Hide/.test(hud.off.label),
  `and hides it again (${hud.button ? hud.off.label : '—'})`);
A(m.inspect && m.inspect.hit,
  `tap-to-inspect still resolves an element (${m.inspect ? (m.inspect.error || 'localId ' + m.inspect.id) : 'no result'}) — fragments picks against its own data, not the hidden meshes`);
A(m.fragLoose <= MAX_FRAG_LOOSE,
  `fragments geometry is merged too (${m.fragLoose} model-owned meshes still drawing, budget ${MAX_FRAG_LOOSE})`);
A(demand.mode === 0, `renderer is in MANUAL mode — frames drawn on demand, not every tick`);
A(demand.idleFrames <= 8, `idle costs only the safety heartbeat (${demand.idleFrames} frames in 2 s)`);
A(demand.movingFrames >= 10, `panning still draws (${demand.movingFrames} frames over 30 camera steps)`);
A(m.pickable && m.pickable.hit,
  `a hidden door leaf is still pickable (${m.pickable ? m.pickable.hiddenParts : 0} hidden parts) — double-tap still opens doors`);
console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
