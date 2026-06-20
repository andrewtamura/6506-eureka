import puppeteer from "puppeteer";

const FT = 0.3048;
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
         "--no-sandbox", "--window-size=1400,1000"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERR:", m.text()); });
await page.goto("http://localhost:4317/", { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => window.__eureka && window.__eureka.loaded, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

// Find the exterior ("Site") model offset.
const ox = await page.evaluate(() => {
  const frags = window.__eureka.fragments;
  const models = frags.list ? [...frags.list.values()] : [...frags.models.values()];
  const site = models.find((m) => (m.modelId || m.id) === "Site");
  return site.object.position.x;
});

// Front door plan x=9.5, z=16.0833; world x=-planX*FT+ox, z=-planZ*FT.
const dx = -9.5 * FT + ox, dz = -16.0833 * FT;
const views = {
  front: { pos: [dx, 1.7, dz - 5.0], tgt: [dx, 0.45, dz + 0.6] },
  three4: { pos: [dx - 4.0, 2.2, dz - 4.2], tgt: [dx, 0.45, dz + 0.6] },
};

for (const [name, v] of Object.entries(views)) {
  await page.evaluate(async ({ pos, tgt }) => {
    await window.__eureka.world.camera.controls.setLookAt(...pos, ...tgt, false);
  }, v);
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `scratchpad/porch-${name}.png` });
  console.log("shot", name);
}
await browser.close();
