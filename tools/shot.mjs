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
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 180; i++) {
  if (await page.evaluate(() => !!document.querySelector('#level-switcher .view-btn, #level-switcher [data-id]') && !!window.__eureka)) break;
  await new Promise(r => setTimeout(r, 2000));
}
await page.evaluate(() => window.__eureka.setHour(12));
await page.evaluate((l) => document.querySelector(`#level-switcher [data-id="${l}"]`)?.click(), level);
await new Promise(r => setTimeout(r, 8000));
// Take the floor datum from a piece known to be on THIS level — the scene also holds
// the level-2 and attic exhibits, and the first userData.item you meet may be one of
// them, which puts the camera outside the building looking down.
const floorY = await page.evaluate((t) => {
  let y = null;
  window.__eureka.world.scene.three.traverse(o => { if (y === null && o.userData?.item?.type === t) y = o.position.y; });
  if (y === null) window.__eureka.world.scene.three.traverse(o => { if (y === null && o.userData?.item) y = o.position.y; });
  return y ?? 0;
}, process.env.SHOT_DATUM || 'island');
// Interior shots want the ceiling solid overhead; the viewer opens in see-through
// overview mode, which would show straight through it (and through the skylight wells).
if (process.env.SHOT_PLAN !== '1') await page.evaluate(() => window.__eureka.setPlanView?.(false));
for (const [name, e, t] of views) {
  const [ex, ez] = W(e[0], e[1]), [tx, tz] = W(t[0], t[1]);
  await page.evaluate((a) => window.__eureka.world.camera.controls.setLookAt(...a, false),
    [ex, floorY + e[2] * FT, ez, tx, floorY + t[2] * FT, tz]);
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('shot', name);
}
await b.close();
