// Render views of the model from a headless viewer.
//
//   node tools/shot.mjs <outdir> <views.json>
//   node tools/shot.mjs <outdir> '[["name",[px,pz,ft],[px,pz,ft]]]'
//
// A view is [name, eye, target]; eye/target are PLAN coordinates in feet plus a
// height above the floor. Lives in the repo for the same reason kitchen-check.mjs
// does: it was rewritten from scratch three times in the scratchpad, and hit the
// same networkidle2 hang twice because two copies drifted apart.
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
const FT = 0.3048, W = (px, pz) => [-px * FT, -pz * FT];
const [outDir, spec] = process.argv.slice(2);
const views = JSON.parse(spec.trim().startsWith('[') ? spec : readFileSync(spec, 'utf8'));
const level = process.env.SHOT_LEVEL || 'ground';

const b = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--no-sandbox', '--enable-unsafe-swiftshader'], protocolTimeout: 900000 });
const page = await b.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', e => console.log(' [pageerror]', String(e).slice(0, 200)));
// domcontentloaded + poll, NOT networkidle2 — the viewer streams levels forever and
// never goes idle, so networkidle2 just times out.
// Only the level being photographed is loaded — see `?solo` in src/main.js.
// norender holds frames off during the build; rendering resumes at the end of init,
// well before any screenshot is taken.
// SHOT_SOLO=0 drops `?solo`, which is the only way to photograph the alt lot: it is a
// second full copy of the exterior, loaded well after init and skipped entirely under
// solo. Costs the full ~5 min load, so keep it for shots that actually need it.
const solo = process.env.SHOT_SOLO === '0' ? '' : `solo=${level}&`;
await page.goto(`http://localhost:5173/?${solo}norender=1`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 180; i++) {
  if (await page.evaluate(() => !!document.querySelector('#level-switcher .view-btn, #level-switcher [data-id]') && !!window.__eureka)) break;
  await new Promise(r => setTimeout(r, 2000));
}
await page.evaluate(() => window.__eureka.setHour(12));
await page.evaluate((l) => document.querySelector(`#level-switcher [data-id="${l}"]`)?.click(), level);
await new Promise(r => setTimeout(r, solo ? 8000 : 60000));
// Take the floor datum from a piece known to be on THIS level — the scene also holds
// the level-2 and attic exhibits, and the first userData.item you meet may be one of
// them, which puts the camera outside the building looking down.
// SHOT_DATUM=grade pins the datum at y=0, which is what the exterior/lot level wants:
// it carries no furniture at all, so the search below falls through to whatever item it
// meets first — a ground-floor exhibit parked beside the building — and aims the camera
// at that instead of at the lot.
const floorY = process.env.SHOT_DATUM === 'grade' ? 0 : await page.evaluate((t) => {
  let y = null;
  window.__eureka.world.scene.three.traverse(o => { if (y === null && o.userData?.item?.type === t) y = o.position.y; });
  if (y === null) window.__eureka.world.scene.three.traverse(o => { if (y === null && o.userData?.item) y = o.position.y; });
  return y ?? 0;
}, process.env.SHOT_DATUM || 'island');
// Interior shots want the ceiling solid overhead; the viewer opens in see-through
// overview mode, which would show straight through it (and through the skylight wells).
if (process.env.SHOT_PLAN !== '1') await page.evaluate(() => window.__eureka.setPlanView?.(false));
// Models are not necessarily loaded at the plan origin — the viewer gives each model
// view its own transform, and the exterior/lot one sits well off in +x. Plan coords
// would aim the camera at empty sky without this, which is exactly what they did.
const off = await page.evaluate((l) => {
  const v = (window.__eureka.modelViews || []).find(m => m.id === l);
  const o = v && (v.obj || v.object); if (!o) return [0, 0, 0];
  o.updateMatrixWorld(true);
  return [o.matrixWorld.elements[12], o.matrixWorld.elements[13], o.matrixWorld.elements[14]];
}, level);
for (const [name, e, t] of views) {
  const [ex0, ez0] = W(e[0], e[1]), [tx0, tz0] = W(t[0], t[1]);
  const [ex, ez] = [ex0 + off[0], ez0 + off[2]], [tx, tz] = [tx0 + off[0], tz0 + off[2]];
  await page.evaluate((a) => window.__eureka.world.camera.controls.setLookAt(...a, false),
    [ex, floorY + off[1] + e[2] * FT, ez, tx, floorY + off[1] + t[2] * FT, tz]);
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('shot', name);
}
await b.close();
