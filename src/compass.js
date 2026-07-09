// Compass rose that always points to model north. The model is authored to true
// cardinal directions (IFC +X=East, +Y=North); web-ifc maps IFC +Y -> three.js
// -Z, so "North" in the scene is (0,0,-1). We rotate the rose so its N aligns
// with where North projects on screen.
import * as THREE from "three";

// Wire a compass rose (#compass-rose) to a camera + its controls.
export function setupCompass(camera, controls) {
  const rose = document.getElementById("compass-rose");
  if (!rose) return;
  const at = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const north = new THREE.Vector3();
  const update = () => {
    camera.updateMatrixWorld();
    // Measure North's screen direction AT the look-at target (screen centre), not
    // at the world origin. The levels are laid out in a row along X, so a model can
    // sit far from the origin; projecting the distant origin lets perspective skew
    // the apparent North (differently for +X vs −X models). Anchoring at the target
    // keeps the rose accurate for every level.
    controls.getTarget(at);
    origin.copy(at).project(camera);
    north.copy(at).add(new THREE.Vector3(0, 0, -1)).project(camera); // one unit North in world space
    const angle = Math.atan2(north.x - origin.x, north.y - origin.y); // NDC y is up
    rose.style.transform = `rotate(${angle}rad)`;
  };
  controls.addEventListener("update", update);
  controls.addEventListener("rest", update);
  update();
}
