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
const URL = process.env.CHECK_URL || 'http://localhost:5173/?solo=ground&norender=1';

// Budgets. Headroom is deliberate: these catch a STRUCTURAL regression (someone
// adds 800 unmerged meshes, or the consolidate pass silently stops running), not
// a few parts here or there.
const MAX_CALLS = 500;     // 333 as merged; 1857 before
const MAX_MESHES = 450;    // visible, drawable meshes (360 as merged, 1960 before)
const MIN_ABSORBED = 1500; // authored meshes the merge actually swallowed (1734)

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
await page.evaluate(() => document.querySelector('#level-switcher [data-id="ground"]')?.click());
await new Promise(r => setTimeout(r, 8000));
await page.evaluate(() => window.__eureka.setPlanView?.(false));
await new Promise(r => setTimeout(r, 2000));

const m = await page.evaluate(() => {
  const w = window.__eureka.world, s = w.scene.three, r3 = w.renderer.three, cam = w.camera.three;
  let visible = 0, hidden = 0, dynamic = 0;
  s.traverse(o => { if (!o.isMesh) return; o.visible ? visible++ : hidden++;
    if (o.userData?.dynamic) dynamic++; });
  for (let i = 0; i < 3; i++) r3.render(s, cam);
  const t = performance.now();
  for (let i = 0; i < 12; i++) r3.render(s, cam);

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
  return { ms: +((performance.now() - t) / 12).toFixed(1), calls: r3.info.render.calls,
           visible, hidden, pickable, ...window.__eureka.consolidated };
});
await b.close();

console.log(`\nFRAME COST  (${URL})`);
console.log(`  draw calls per frame     ${m.calls}`);
console.log(`  visible meshes           ${m.visible}   (hidden originals: ${m.hidden})`);
console.log(`  merged meshes            ${m.merged}  absorbing ${m.absorbed}`);
console.log(`  frozen transforms        ${m.frozen}`);
console.log(`  consolidate pass         ${m.buildMs} ms at init`);
console.log(`  render()                 ${m.ms} ms/frame  (swiftshader; indicative only)`);

if (REPORT) process.exit(0);
let bad = 0;
const A = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) bad++; };
console.log('');
A(m.calls <= MAX_CALLS, `${m.calls} draw calls per frame (budget ${MAX_CALLS})`);
A(m.visible <= MAX_MESHES, `${m.visible} drawable meshes (budget ${MAX_MESHES})`);
A(m.absorbed >= MIN_ABSORBED, `the merge absorbed ${m.absorbed} authored meshes (at least ${MIN_ABSORBED})`);
A(m.hidden >= MIN_ABSORBED, `the originals are still in the scene, hidden (${m.hidden}) — kitchen-check measures them`);
A(m.frozen > 1000, `static transforms frozen (${m.frozen})`);
A(m.pickable && m.pickable.hit,
  `a hidden door leaf is still pickable (${m.pickable ? m.pickable.hiddenParts : 0} hidden parts) — double-tap still opens doors`);
console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
