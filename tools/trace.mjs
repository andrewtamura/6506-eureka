// Chrome trace, summed by event name — the instrument that found the ReadPixels
// problem, and the one CLAUDE.md tells you to reach for on any "why is this slow"
// question. It lived in the scratchpad and got rebuilt from scratch every time.
//
//   node tools/trace.mjs                # trace a cold load
//   node tools/trace.mjs --pan          # load, then trace a scripted orbit only
//   node tools/trace.mjs --pan --full   # ...over the whole scene, exhibits included
//
// Read the output with the container's limits in mind. GLES2::ReadPixels /
// CommandBufferHelper::Finish dominating is the HEADLESS present readback, not
// something a real browser pays — see CLAUDE.md. What transfers is the JS: render(),
// FunctionCall, FireAnimationFrame, and anything named in this repo's own code.
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAN = process.argv.includes('--pan');
const FULL = process.argv.includes('--full');
const OUT = process.env.TRACE_OUT || join(tmpdir(), 'eureka-trace.json');
const solo = FULL ? '' : 'solo=ground&';
const URL = process.env.CHECK_URL || `http://localhost:5173/?${solo}norender=1`;

const b = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--no-sandbox', '--enable-unsafe-swiftshader'], protocolTimeout: 1800000 });
const page = await b.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', e => console.log(' [pageerror]', String(e).slice(0, 200)));
mkdirSync(join(OUT, '..'), { recursive: true });

const categories = ['devtools.timeline', 'gpu', 'toplevel'];
const t0 = Date.now();
if (!PAN) await page.tracing.start({ path: OUT, categories });
await page.goto(URL, { waitUntil: 'domcontentloaded' });   // networkidle2 never fires here
for (let i = 0; i < 300; i++) {
  if (await page.evaluate(() => !!window.__eureka?.loaded)) break;
  await new Promise(r => setTimeout(r, 2000));
}
if (FULL) {
  for (let i = 0; i < 300; i++) {
    if (await page.evaluate(() => !!window.__eureka.exhibitsReady).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  await page.evaluate(() => window.__eureka.exhibitsReady);
}
console.log(`loaded in ${Math.round((Date.now() - t0) / 1000)} s`);

if (PAN) {
  await page.evaluate(() => window.__eureka.setPlanView?.(false));
  await new Promise(r => setTimeout(r, 2000));
  await page.tracing.start({ path: OUT, categories });
  await page.evaluate(async () => {
    const c = window.__eureka.world.camera.controls;
    for (let i = 0; i < 40; i++) { c.rotate(0.012, 0, false); await new Promise(r => requestAnimationFrame(r)); }
  });
}
await page.tracing.stop();
await b.close();

const ev = JSON.parse(readFileSync(OUT, 'utf8')).traceEvents;
const by = {};
for (const e of ev) if (e.dur) by[e.name] = (by[e.name] || 0) + e.dur;
const rows = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log(`\ntop events by total duration (${PAN ? 'pan' : 'load'}${FULL ? ', full scene' : ''}):`);
for (const [k, v] of rows) console.log(`  ${String(Math.round(v / 1000)).padStart(8)} ms  ${k}`);
console.log(`\ntrace written to ${OUT}`);
