import puppeteer from "puppeteer";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
await page.goto("http://localhost:4317/", { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => window.__eureka && window.__eureka.loaded, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));
const info = await page.evaluate(async () => {
  const out = {};
  const frags = window.__eureka.fragments;
  const models = frags.list ? [...frags.list.values()] : (frags.models ? [...frags.models.values()] : []);
  out.modelCount = models.length;
  out.models = [];
  for (const m of models) {
    const o = m.object;
    let porch = null;
    try {
      const cats = await m.getItemsOfCategories([/IFCSLAB/, /IFCWALL/, /IFCBUILDINGELEMENTPROXY/]);
      const ids = Object.values(cats).flat();
      // get names
      const data = await m.getItemsData ? await m.getItemsData(ids, { attributesDefault: true }) : null;
    } catch (e) { porch = "err:" + e.message; }
    out.models.push({ id: m.modelId || m.id, pos: o ? [o.position.x, o.position.y, o.position.z] : null });
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
