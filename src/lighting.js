// Time-of-day lighting rig. Replaces SimpleScene's default lights with a sun +
// sky pair so the Morning/Afternoon/Evening/Night presets fully control the look.
import * as THREE from "three";

// Sun directions are the real solar azimuth/altitude for El Cerrito, CA
// (lat 37.9°N) at each time of day (≈equinox). The building's north is +z in
// plan, which maps to world -Z, so in WORLD axes East = +X, South = +Z, Up = +Y,
// and dir = (cos·alt·sin·az, sin·alt, -cos·alt·cos·az) with az measured from
// north. The sun stays in the southern sky (+Z) and never goes overhead.
const PRESETS = {
  // ~8am, sun low in the ESE  (alt 23°, az 110°)
  Morning:   { bg: 0xcfe3f5, sun: 0xffd9a0, si: 2.2, dir: [0.87, 0.39, 0.31],  sky: 0xbcd8f0, grd: 0x9a7a5a, hi: 0.6 },
  // ~2pm, sun high in the SW   (alt 43°, az 223°)
  Afternoon: { bg: 0xb0d4f1, sun: 0xfff3e0, si: 3.2, dir: [-0.50, 0.68, 0.53], sky: 0xbfdcff, grd: 0x9a8a7a, hi: 0.9 },
  // ~5pm, sun low in the W     (alt 12°, az 261°)
  Evening:   { bg: 0xf3c79a, sun: 0xff8a45, si: 2.0, dir: [-0.97, 0.20, 0.16], sky: 0xb08fb0, grd: 0x6a5a4a, hi: 0.5 },
  // dim moonlight, low in the E
  Night:     { bg: 0x0b1020, sun: 0x9fb6ff, si: 0.5, dir: [0.80, 0.45, 0.25],  sky: 0x22304a, grd: 0x0d1018, hi: 0.25 },
};

// Set up the lighting rig on a three.js scene. Returns { apply, names, focusShadow }.
export function setupLighting(scene) {
  // Drop SimpleScene's built-in lights first (collect then remove — removing
  // during traverse would mutate the tree mid-walk).
  const existing = [];
  scene.traverse((o) => { if (o.isLight) existing.push(o); });
  existing.forEach((l) => l.removeFromParent());

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  // The sun casts shadows so recesses read with depth (cabinet voids, overhangs,
  // furniture contact). The shadow frustum is sized to the model by focusShadow().
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  const sky = new THREE.HemisphereLight(0xbfdcff, 0x9a8a7a, 0.8);
  scene.add(sun, sun.target, sky);

  const focus = new THREE.Vector3();   // point the sun + shadow frustum aim at
  let dist = 40, current = null;

  const apply = (name) => {
    const p = PRESETS[name];
    if (!p) return;
    current = name;
    scene.background = new THREE.Color(p.bg);
    sun.color.set(p.sun); sun.intensity = p.si;
    sun.position.copy(focus).add(
      new THREE.Vector3(p.dir[0], p.dir[1], p.dir[2]).normalize().multiplyScalar(dist));
    sky.color.set(p.sky); sky.groundColor.set(p.grd); sky.intensity = p.hi;
  };

  // Aim the sun + size its (orthographic) shadow camera to cover the model.
  const focusShadow = (center, radius) => {
    focus.copy(center);
    sun.target.position.copy(center);
    dist = Math.max(40, radius * 2.5);
    const c = sun.shadow.camera;
    c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
    c.near = 0.5; c.far = dist + radius * 2; c.updateProjectionMatrix();
    if (current) apply(current);   // reposition the sun relative to the new focus
  };

  return { apply, names: Object.keys(PRESETS), focusShadow };
}
