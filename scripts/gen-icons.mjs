// Regenerate the PWA icons from an inline SVG (rendered via puppeteer). This is
// a one-off authoring tool, not part of the build: it writes committed source
// PNGs into icons/, which prepare-assets.mjs then copies into public/icons/. A
// simple Georgian-house badge over the site's sky-blue theme; the maskable
// variant is full-bleed with a safe padding zone. Run: node scripts/gen-icons.mjs
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "icons");
mkdirSync(outDir, { recursive: true });

// `pad` is the fraction of inset before the badge (maskable needs a safe zone).
const svg = (pad) => {
  const r = pad < 0.1 ? 96 : 0;                 // rounded corners only for non-maskable
  const m = 512 * pad, s = 512 - 2 * m;          // badge box
  // house drawn in a 0..100 viewBox, mapped into the badge box
  const HX = (x) => m + (x / 100) * s, HY = (y) => m + (y / 100) * s;
  const house = `
    <polygon points="${HX(18)},${HY(46)} ${HX(50)},${HY(20)} ${HX(82)},${HY(46)}" fill="#1f2a44"/>
    <rect x="${HX(24)}" y="${HY(46)}" width="${s * 0.52}" height="${s * 0.32}" fill="#27355a"/>
    <rect x="${HX(44)}" y="${HY(58)}" width="${s * 0.12}" height="${s * 0.20}" fill="#cfe3f6"/>
    <rect x="${HX(30)}" y="${HY(52)}" width="${s * 0.09}" height="${s * 0.09}" fill="#9ec6ec"/>
    <rect x="${HX(61)}" y="${HY(52)}" width="${s * 0.09}" height="${s * 0.09}" fill="#9ec6ec"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cfe6fb"/><stop offset="1" stop-color="#8fbfe8"/>
    </linearGradient></defs>
    <rect width="512" height="512" rx="${r}" fill="${pad < 0.1 ? "#b0d4f1" : "#8fbfe8"}"/>
    <rect ${pad < 0.1 ? 'x="40" y="40" width="432" height="432" rx="64"' : 'width="512" height="512"'} fill="url(#sky)"/>
    ${house}
    <text x="256" y="${HY(92)}" font-family="Georgia, serif" font-weight="700"
      font-size="${s * 0.16}" fill="#1f2a44" text-anchor="middle">6506</text>
  </svg>`;
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
const shoot = async (file, size, pad) => {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{width:${size}px;height:${size}px;display:block}</style>${svg(pad)}`,
    { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 150));
  await page.screenshot({ path: resolve(outDir, file), omitBackground: false });
  console.log("wrote", file);
};
await shoot("icon-512.png", 512, 0.0);
await shoot("icon-192.png", 192, 0.0);
await shoot("icon-maskable-512.png", 512, 0.16);
await shoot("apple-touch-icon-180.png", 180, 0.0);
await browser.close();
