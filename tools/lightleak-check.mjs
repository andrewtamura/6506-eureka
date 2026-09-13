// Does a lamp stay in its room?
//
//   node tools/lightleak-check.mjs
//
// Punctual lights in three are NOT occluded by geometry: a PointLight with no shadow map
// lights every fragment in range straight through whatever is in the way. That is fine
// almost everywhere here, because `reachFt` caps each lamp to roughly its own room — but
// it is not fine for the under-stair powder room, whose lamp sits about a foot from the
// door leaf in a room 3 ft 2 in wide. No range that lights that room fails to cross the
// wall, so with the door SHUT the lamp read into the foyer. The fix is a real shadow map
// on that one lamp, and this is what proves it.
//
// Measured in PIXELS, because the thing being asserted is what you can see. Rendered into
// a small WebGLRenderTarget and read back rather than screenshotted: deterministic under
// swiftshader, and 96x96 is fast in software.
//
// Two details that make the measurement mean something:
//   - the lamp is toggled with `intensity = 0`, NOT `visible`. Toggling visible changes
//     NUM_POINT_LIGHTS / NUM_POINT_LIGHT_SHADOWS, which is part of the program cache key,
//     so every sample would pay a full shader recompile and the "off" frame would not be
//     the same scene minus one lamp.
//   - every reading is a DIFFERENCE, lamp on minus lamp off, from the same camera. That
//     cancels the sun, the ambient floor, the background and tone mapping, so the number
//     is the lamp's contribution and nothing else.
//
// Three assertions, and two of them are positive controls — without those, "the foyer is
// dark" passes just as well for a camera pointed at nothing, or for a lamp that has
// blacked itself out inside its own globe.
import puppeteer from 'puppeteer';

const FT = 0.3048;
const URL = process.env.CHECK_URL || 'http://localhost:5173/?solo=ground&norender=1';
// The powder room, from ifc/rooms/powder.json bounds.
const ROOM = { px: [11.5683, 15.0833], pz: [-7.317, -0.485] };

let fail = 0;
const R = (v, n = 2) => Number(v).toFixed(n);
const A = (ok, msg) => { if (!ok) fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const b = await puppeteer.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--no-sandbox', '--enable-unsafe-swiftshader'],
  protocolTimeout: 900000,
});
const page = await b.newPage();
await page.setViewport({ width: 900, height: 600 });
page.on('pageerror', (e) => console.log(' [pageerror]', String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 180; i++) {
  if (await page.evaluate(() => !!window.__eureka && !!window.__eureka.selectLighting).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 4000));

const out = await page.evaluate(async ({ FT, ROOM }) => {
  const T = window.THREE, w = window.__eureka;
  const scene = w.world.scene.three, r3 = w.world.renderer.three;
  w.setPlanView(false);          // opaque ceilings; the viewer opens see-through
  w.setHour(0);                  // midnight, so the lamp is most of what is left
  w.selectLighting('ground');

  // The lamp: the point light nearest the powder room's centre. Deliberately NOT "the one
  // with castShadow" — this harness has to run on the BROKEN build too, to show it fails.
  const cx = -((ROOM.px[0] + ROOM.px[1]) / 2) * FT, cz = -((ROOM.pz[0] + ROOM.pz[1]) / 2) * FT;
  let lamp = null, best = 1e9;
  scene.traverse((o) => {
    if (!o.isPointLight) return;
    const p = o.getWorldPosition(new T.Vector3());
    const d = Math.hypot(p.x - cx, p.z - cz);
    if (d < best) { best = d; lamp = o; }
  });
  if (!lamp) return { err: 'no point light found near the powder room' };
  const lp = lamp.getWorldPosition(new T.Vector3());

  // The door: the procedural leaf whose pivot is nearest the lamp.
  const entries = [...new Set((w.furnitureDoors || []).map((m) => m.userData.fdoor))].filter(Boolean);
  let door = null; best = 1e9;
  for (const d of entries) {
    const p = d.pivot.getWorldPosition(new T.Vector3());
    const dist = p.distanceTo(lp);
    if (dist < best) { best = dist; door = d; }
  }
  if (!door) return { err: 'no procedural door leaf found' };
  const setDoor = (open) => {
    door.open = open; door.settling = false;
    door.current = open ? door.openAngle : 0;
    door.pivot.rotation.y = door.current;
    door.pivot.updateMatrixWorld(true);
    if (lamp.shadow) lamp.shadow.needsUpdate = true;   // the bake happens inside the next render
  };

  // A ground-floor datum from an item on THIS level (the scene also holds the level-2 and
  // attic exhibits, so modelBox would be the wrong floor).
  let floorY = 0;
  scene.traverse((o) => { if (o.userData && o.userData.item && o.userData.item.type === 'staircase') floorY = o.position.y; });

  const N = 96;
  const rt = new T.WebGLRenderTarget(N, N);
  const buf = new Uint8Array(N * N * 4);
  const cam = new T.PerspectiveCamera(45, 1, 0.05, 14);
  const W = (px, pz, ft) => new T.Vector3(-px * FT, floorY + ft * FT, -pz * FT);
  const aim = (e, t) => { cam.position.copy(W(...e)); cam.lookAt(W(...t)); cam.updateMatrixWorld(true); };
  const mean = () => {
    r3.setRenderTarget(rt); r3.render(scene, cam); r3.setRenderTarget(null);
    r3.readRenderTargetPixels(rt, 0, 0, N, N, buf);
    let s = 0;
    for (let i = 0; i < buf.length; i += 4) s += buf[i] + buf[i + 1] + buf[i + 2];
    return s / (buf.length / 4) / 3;
  };
  // The lamp is driven HARD for the measurement — far above its authored 0.5 — and put
  // back after. Whether a surface is shadowed is independent of how bright the lamp is,
  // so this changes nothing about what is being tested; it only lifts the signal off the
  // 8-bit floor. At the authored brightness the readings were 0.34 against 0.71 on a
  // 0-255 mean, i.e. about one grey level in three pixels, which is too close to
  // quantisation noise to set a threshold against.
  const base = lamp.intensity, PROBE = 6;
  const delta = () => {
    lamp.intensity = PROBE; const on = mean();
    lamp.intensity = 0;     const off = mean();
    lamp.intensity = base;  return on - off;
  };

  // The foyer camera looks DOWN AT THE FLOOR just outside the door, not at the box's
  // north face. That face points north, AWAY from the lamp, so N.L is negative and it
  // takes no light from the lamp whether or not anything is in the way — aimed there the
  // test reads ~0 on a build that leaks badly, which is exactly what the first version of
  // this harness did. The floor's normal is up and the lamp is above it, so the floor is
  // the surface the spill actually lands on, and it is what you see from the foyer.
  const FOYER = [[13.234, 3.0, 5.0], [13.234, 0.5, 0.0]];
  const INSIDE = [[13.234, -1.0, 4.6], [13.234, -4.2, 1.2]];

  setDoor(false); aim(...INSIDE); const shutRoom = delta();
  setDoor(false); aim(...FOYER);  const shutFoyer = delta();
  setDoor(true);  aim(...FOYER);  const openFoyer = delta();
  setDoor(false);

  const sh = lamp.shadow;
  return {
    shutRoom, shutFoyer, openFoyer,
    castShadow: !!lamp.castShadow,
    near: sh ? sh.camera.near : null,
    far: sh ? sh.camera.far : null,
    map: sh ? sh.mapSize.x : null,
    autoUpdate: sh ? sh.autoUpdate : null,
    bias: sh ? sh.bias : null,
    normalBias: sh ? sh.normalBias : null,
    reachFt: lamp.distance / FT,
    lampPx: -lp.x / FT, lampPz: -lp.z / FT,
    // The fixture must not occlude itself: nothing under the lamp's own group may cast.
    selfCasters: (() => {
      let n = 0;
      if (lamp.parent) lamp.parent.traverse((o) => { if (o.isMesh && o.castShadow) n++; });
      return n;
    })(),
  };
}, { FT, ROOM });

await b.close();

if (out.err) { console.log('  FAIL  ' + out.err); process.exit(1); }

console.log('\nLIGHT LEAK — the powder room lamp with the door shut');
console.log(`  lamp at plan (${R(out.lampPx)}, ${R(out.lampPz)}), reach ${R(out.reachFt, 1)} ft, ` +
            `castShadow ${out.castShadow}` +
            (out.castShadow ? `, map ${out.map}, near ${out.near}, far ${R(out.far, 3)}` : ''));
console.log(`  lamp contribution (on minus off, 0-255):  inside ${R(out.shutRoom)}  ` +
            `foyer/open ${R(out.openFoyer)}  foyer/shut ${R(out.shutFoyer)}`);

// 1) POSITIVE CONTROL. With the door shut the lamp must still light its own room. This is
// what catches the trap the whole change turns on: the light sits at the exact centre of
// its opal globe, so if the globe is left a shadow caster the fixture blacks ITSELF out
// and the room goes dark — at which point assertion 3 passes for entirely the wrong reason.
A(out.shutRoom > 5, `the lamp still lights its own room with the door shut (${R(out.shutRoom)})`);
// 2) POSITIVE CONTROL. The foyer camera must actually see the lamp when the door is open,
// or assertion 3 is measuring a wall the light never reached.
A(out.openFoyer > 3, `...and reaches the foyer when the door is open (${R(out.openFoyer)})`);
// 3) THE BUG. Shut, the foyer must not see it. Not zero: the leaf is authored 9 mm undersize
// at the head and the strike, which is a real door gap and reads as a thin line.
A(out.shutFoyer < 0.12 * out.openFoyer,
  `and is SHUT OUT of the foyer when the door is closed ` +
  `(${R(out.shutFoyer)} against ${R(out.openFoyer)} open — ${R(100 * out.shutFoyer / out.openFoyer, 1)}%)`);

// Structural backstops. Cheap, and each one names a specific way the fix silently rots.
if (out.castShadow) {
  A(out.autoUpdate === false, `baked on demand, not every frame (autoUpdate ${out.autoUpdate})`);
  // The default near plane is 0.5 m — further than BOTH occluders that matter (the leaf at
  // ~0.31 m and the lamp's own wall at ~0.23 m). Left at the default the cube records
  // neither and the leak survives, looking exactly like "point lights can't be occluded".
  A(out.near < 0.20, `near plane is closer than the door leaf (${out.near} m, default 0.5 would clip it)`);
  A(out.bias < 0 && out.normalBias > 0, `biased against acne (bias ${out.bias}, normalBias ${out.normalBias})`);
  // three overwrites shadow.camera.far with light.distance on every bake, so reachFt IS
  // the far plane. Asserted so a future "fix" that sets far by hand shows up here.
  A(Math.abs(out.far - out.reachFt * FT) < 1e-6,
    `far plane is the lamp's own reach (${R(out.far, 3)} m = ${R(out.reachFt, 1)} ft)`);
  A(out.selfCasters === 0,
    `the fixture does not occlude itself (${out.selfCasters} casters in its own group)`);
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
