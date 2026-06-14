// Compass rose that always points to model north. The model is authored to true
// cardinal directions (IFC +X=East, +Y=North); web-ifc maps IFC +Y -> three.js
// -Z, so "North" in the scene is (0,0,-1). We rotate the rose so its N aligns
// with where North projects on screen.
import * as THREE from "three";

// Wire a compass rose (#compass-rose) to a camera + its controls.
export function setupCompass(camera, controls) {
  const rose = document.getElementById("compass-rose");
  if (!rose) return;
  const origin = new THREE.Vector3();
  const north = new THREE.Vector3();
  const update = () => {
    camera.updateMatrixWorld();
    origin.set(0, 0, 0).project(camera);
    north.set(0, 0, -1).project(camera); // one unit North in world space
    const angle = Math.atan2(north.x - origin.x, north.y - origin.y); // NDC y is up
    rose.style.transform = `rotate(${angle}rad)`;
  };
  controls.addEventListener("update", update);
  controls.addEventListener("rest", update);
  update();
}
