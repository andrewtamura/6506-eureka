// Time-of-day lighting driven by a single "hour" (0–24). The sun's azimuth and
// altitude are the real solar position for El Cerrito, CA (lat 37.9°N, ≈equinox)
// at that hour; sun/sky colours and intensity track the height of the sun, so a
// scrub from night → dawn → midday → dusk reads naturally.
//
// World axes: the building's north is +z in plan -> world -Z, so East = +X,
// South = +Z, Up = +Y, and the sun direction is
//   (cos·alt·sin·az, sin·alt, -cos·alt·cos·az)  (az measured clockwise from N).
import * as THREE from "three";

const DEG = Math.PI / 180;
const LAT = 37.9 * DEG;     // El Cerrito, CA
let decl = 0;              // solar declination (radians); set by the season dial
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => new THREE.Color(c1).lerp(new THREE.Color(c2), t);

export function setupLighting(scene) {
  // Drop SimpleScene's built-in lights first.
  const existing = [];
  scene.traverse((o) => { if (o.isLight) existing.push(o); });
  existing.forEach((l) => l.removeFromParent());

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  // Bake the shadow on demand (not every frame): geometry + sun are static per
  // hour, so a frozen shadow stays correct and doesn't flicker while panning.
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  // Sky fill is for the OUTDOORS only: the exterior massing is lit by the dome of
  // sky, but interiors should not be (a flat hemisphere paints every interior wall
  // the same tone). Put the hemisphere on layer 2 and tag only the exterior model
  // with that layer (see main.js); interiors then get just the sun (through windows),
  // the interior fixtures, and a faint floor light below so corners aren't pure black.
  const sky = new THREE.HemisphereLight(0xbfdcff, 0x9a8a7a, 0.8);
  sky.layers.set(2);
  const fill = new THREE.AmbientLight(0xaab6c6, 0.12);   // minimal interior black-floor (no GI to bounce light)
  scene.add(sun, sun.target, sky, fill);

  const focus = new THREE.Vector3();   // sun + shadow frustum aim point
  let dist = 40, hour = 14;

  // Set the lighting for a given hour of the day (0–24).
  const setTime = (h) => {
    hour = h;
    const H = (h - 12) * 15 * DEG;                       // hour angle
    const altSin = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H);
    const alt = Math.asin(clamp(altSin, -1, 1));
    let az = Math.acos(clamp((Math.sin(decl) - altSin * Math.sin(LAT)) / (Math.cos(alt) * Math.cos(LAT) || 1e-6), -1, 1));
    if (H > 0) az = 2 * Math.PI - az;                    // afternoon -> western sky

    const day = clamp(altSin * 1.8, 0, 1);               // 0 below horizon, 1 when well up
    const warm = clamp(1 - Math.max(altSin, 0) * 3.2, 0, 1); // warm/orange near the horizon

    // Keep the sun a few degrees up for sane shadows even at sunrise/sunset.
    const altDir = Math.max(alt, 5 * DEG);
    const dir = new THREE.Vector3(
      Math.cos(altDir) * Math.sin(az), Math.sin(altDir), -Math.cos(altDir) * Math.cos(az));
    sun.position.copy(focus).add(dir.normalize().multiplyScalar(dist));
    sun.intensity = clamp(Math.max(altSin, 0) * 3.4, 0, 3.4) + 0.05;
    sun.color.copy(mix(0xfff1da, 0xff7a30, warm));       // neutral high, warm low

    // Exterior sky fill (full strength — outdoor faces should read in shade too).
    sky.intensity = lerp(0.45, 1.0, day);
    sky.color.copy(mix(0x33425e, 0xbfdcff, day));
    sky.groundColor.copy(mix(0x121723, 0x9a8a7a, day));
    // Faint interior floor: low enough that fixtures + window light carry the look.
    fill.intensity = lerp(0.05, 0.14, day);
    fill.color.copy(mix(0x2a3340, 0xaab6c6, day));

    scene.background = altSin <= 0
      ? mix(0x0b1020, 0xf0c39a, clamp(altSin * 9 + 1, 0, 1))  // night -> dawn/dusk glow at the horizon
      : mix(0xf3c79a, 0xaed2f0, day);                         // warm horizon -> daytime blue
    sun.shadow.needsUpdate = true;
  };

  // Aim the sun + size its (orthographic) shadow camera to cover the model.
  const focusShadow = (center, radius) => {
    focus.copy(center);
    sun.target.position.copy(center);
    dist = Math.max(40, radius * 2.5);
    const c = sun.shadow.camera;
    c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
    c.near = 0.5; c.far = dist + radius * 2; c.updateProjectionMatrix();
    setTime(hour);                       // reposition the sun relative to the new focus
  };
  const refreshShadow = () => { sun.shadow.needsUpdate = true; };

  // Set the solar declination for the time of YEAR (degrees: +23.44 at the
  // summer solstice, 0 at the equinoxes, -23.44 at the winter solstice) and
  // re-place the sun at the current hour.
  const setSeason = (declDeg) => { decl = declDeg * DEG; setTime(hour); };

  return { setTime, setSeason, focusShadow, refreshShadow };
}
