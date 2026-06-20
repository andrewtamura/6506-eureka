import puppeteer from "puppeteer";

const URL = "http://localhost:4317/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1400,1000"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

// ---- 1. first (online) load: register SW + let it precache everything ----
await page.goto(URL, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => window.__eureka && window.__eureka.loaded, { timeout: 60000 });
console.log("online load OK");

await page.evaluate(() => navigator.serviceWorker.ready);
// poll Cache Storage until the heavy assets are precached
const cached = await page.evaluate(async () => {
  const need = ["index", "worker.mjs", "exterior.ifc", "web-ifc.wasm", "levels.json"];
  for (let i = 0; i < 120; i++) {
    const keys = await caches.keys();
    const urls = [];
    for (const k of keys) for (const r of await (await caches.open(k)).keys()) urls.push(r.url);
    const hit = (n) => urls.some((u) => u.includes(n));
    if (need.every(hit)) return { ok: true, count: urls.length };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false };
});
console.log("precache:", JSON.stringify(cached));

// ---- 2. go OFFLINE and reload from scratch ----
const failures = [];
page.on("requestfailed", (r) => failures.push(r.url()));
await page.setOfflineMode(true);
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
const ok = await page.waitForFunction(() => window.__eureka && window.__eureka.loaded, { timeout: 60000 })
  .then(() => true).catch(() => false);
console.log("OFFLINE reload loaded:", ok);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: "scratchpad/offline.png" });
if (failures.length) console.log("offline request failures:", failures.slice(0, 10));
else console.log("no failed requests while offline");

await browser.close();
process.exit(ok && cached.ok ? 0 : 1);
