// Shared first-person "walk" teleporter. Double-tapping a registered walkable
// surface — in ANY model (the ground floor's slabs/finishes, or the exterior
// lot/deck/porch/steps) — glides the camera to a standing eye-height POV at
// that spot, keeping the heading you currently face. The same code (and the
// same `onEnter` POV controls) drives every model, so walking behaves
// identically indoors and out.
import * as THREE from "three";

export function createWalker({ camera, glide, clearSelection, onEnter, eye = 1.63, lookDist = 0.05 }) {
  const ctrls = camera.controls;
  const three = camera.three;
  const targets = [];      // { model, walkable:(localId)=>bool, place:(hit)=>{x,y,z} }
  const _dir = new THREE.Vector3();

  // Register a model's walkable surfaces. `walkable` filters raycast hits to
  // floor-like ids; `place` maps a hit to the standing point (so the interior
  // can clamp inside a room while the exterior stands exactly where tapped).
  const register = (model, walkable, place) => targets.push({ model, walkable, place });

  // Glide to the nearest walkable surface under (lx, ly). Returns true if it
  // found somewhere to stand (so the caller can fall through otherwise).
  async function teleport(lx, ly, pointer, dom) {
    const cam = three.position;
    let best = null, bestD = Infinity;
    for (const t of targets) {
      pointer.set(lx, ly);
      const hits = await t.model.raycastAll({ camera: three, mouse: pointer, dom });
      if (!hits) continue;
      for (const h of hits) {                       // nearest WALKABLE hit -> steps through doorways
        if (!t.walkable(h.localId)) continue;
        const d = h.point.distanceTo(cam);
        if (d < bestD) { bestD = d; best = { t, h }; }
      }
    }
    if (!best) return false;
    // Keep the heading you currently SEE (the camera's horizontal facing), not
    // the controls' settling target azimuth — reading that snapped the heading.
    three.getWorldDirection(_dir); _dir.y = 0;
    let fx, fz;
    if (_dir.lengthSq() > 1e-3) { _dir.normalize(); fx = _dir.x; fz = _dir.z; }
    else { const az = ctrls.azimuthAngle; fx = -Math.sin(az); fz = -Math.cos(az); }
    const s = best.t.place(best.h);
    await clearSelection();
    // Cartesian glide (no azimuth-angle interpolation -> no long-way flip).
    await glide(s.x, s.y, s.z, s.x + fx * lookDist, s.y, s.z + fz * lookDist);
    onEnter();
    return true;
  }

  return { register, teleport, eye, lookDist };
}
