// Eureka Residence — BIM viewer built on That Open Engine (@thatopen/*).
//
// Pipeline: fetch floorplan.ifc -> IfcLoader converts it to Fragments (off the
// main thread via a web worker) -> the FragmentsModel is added to the 3D world.
// Clicking an element raycasts the model and shows its IFC properties.

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";

const BASE = import.meta.env.BASE_URL; // respects Vite `base` on GitHub Pages
const statusEl = document.getElementById("status");
const propsEl = document.getElementById("props");
const propsBody = document.getElementById("props-body");
const setStatus = (t) => { statusEl.textContent = t; statusEl.style.display = t ? "block" : "none"; };

async function main() {
  const container = document.getElementById("viewer");

  // --- world (scene + renderer + camera) ---------------------------------
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera = new OBC.SimpleCamera(components);
  components.init();

  world.scene.setup();
  world.scene.three.background = new THREE.Color(0xb0d4f1);
  await world.camera.controls.setLookAt(18, 14, 18, 0, 1.5, 0);

  const grids = components.get(OBC.Grids);
  grids.create(world);

  // --- fragments engine ---------------------------------------------------
  const fragments = components.get(OBC.FragmentsManager);
  // Self-hosted worker (copied into public/ by scripts/prepare-assets.mjs) so
  // there is no runtime CDN dependency. The default getWorker() fetches it
  // from unpkg, which we deliberately avoid.
  fragments.init(`${BASE}worker.mjs`);

  // Keep the fragments LOD/culling in sync with the camera.
  world.camera.controls.addEventListener("rest", () => fragments.core.update(true));
  world.camera.controls.addEventListener("update", () => fragments.core.update());

  // When a model is added, attach it to the camera + scene.
  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
  });

  // --- IFC loader ---------------------------------------------------------
  const ifcLoader = components.get(OBC.IfcLoader);
  // Self-hosted web-ifc WASM (copied into public/web-ifc by the build).
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: { path: `${BASE}web-ifc/`, absolute: true },
  });

  // --- load the model -----------------------------------------------------
  setStatus("Loading IFC model…");
  const res = await fetch(`${BASE}floorplan.ifc`);
  if (!res.ok) throw new Error(`Could not fetch floorplan.ifc (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // coordinate=false keeps the model's authored coordinates so the floor sits
  // on the grid (Y=0). With coordinate=true, base-coordination shifts the whole
  // model below the grid, which reads as "sunk/upside-down".
  const model = await ifcLoader.load(bytes, false, "Eureka Residence");
  await fragments.core.update(true);

  // Fragments' base-coordination places the model below the grid; lift it so
  // the floor rests on the grid plane (Y=0), then frame it. Shifting
  // model.object keeps raycasting consistent (fragments uses its world matrix).
  const box = new THREE.Box3().setFromObject(model.object);
  let modelBox = box;
  if (!box.isEmpty()) {
    model.object.position.y -= box.min.y;
    model.object.updateMatrixWorld(true);
    await fragments.core.update(true);
    modelBox = new THREE.Box3().setFromObject(model.object);
    world.camera.controls.fitToBox(modelBox, true);
  }
  setStatus("");

  // Debug handle (used by the headless smoke test; harmless in production).
  window.THREE = THREE;
  window.__eureka = { components, world, fragments, model, loaded: true };

  // --- selection + properties --------------------------------------------
  const HIGHLIGHT = {
    color: new THREE.Color(0xffa500),
    renderedFaces: FRAGS.RenderedFaces.TWO,
    opacity: 1,
    transparent: false,
  };
  let selected = null;

  async function clearSelection() {
    if (selected != null) { await model.resetHighlight([selected]); selected = null; }
    propsEl.style.display = "none";
  }

  function renderProps(title, rows) {
    propsBody.innerHTML = "";
    const h = propsEl.querySelector("h2");
    h.textContent = title;
    for (const [k, v] of rows) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span class="k"></span><span class="v"></span>`;
      row.querySelector(".k").textContent = k;
      row.querySelector(".v").textContent = v;
      propsBody.appendChild(row);
    }
    propsEl.style.display = "block";
  }

  const pointer = new THREE.Vector2();
  const dom = world.renderer.three.domElement;
  const raycastAt = (lx, ly) => {
    pointer.set(lx, ly);
    return model.raycast({ camera: world.camera.three, mouse: pointer, dom });
  };

  async function selectAt(lx, ly) {
    const hit = await raycastAt(lx, ly);
    await clearSelection();
    if (!hit) return;
    selected = hit.localId;
    await model.highlight([selected], HIGHLIGHT);
    await fragments.core.update(true);
    const [data] = await model.getItemsData([selected], {
      attributesDefault: true,
      relationsDefault: { attributes: true, relations: false },
    });
    const val = (a) => (a && typeof a === "object" && "value" in a ? a.value : a);
    const rows = [];
    const category = val(data?._category) ?? "Element";
    if (data?.Name != null) rows.push(["Name", val(data.Name)]);
    if (data?.LongName != null) rows.push(["Long name", val(data.LongName)]);
    if (data?.PredefinedType != null) rows.push(["Type", val(data.PredefinedType)]);
    rows.push(["IFC class", category]);
    rows.push(["Local ID", selected]);
    renderProps(String(category).replace(/^Ifc/, ""), rows);
  }

  // --- first-person teleport (double-tap / double-click) ------------------
  const FLOOR = modelBox.min.y + 0.2; // floor surface (slab top) in world Y
  const EYE = 1.6;                     // standing eye height above the floor (m)
  const _fwd = new THREE.Vector3();
  async function teleportTo(lx, ly) {
    const hit = await raycastAt(lx, ly);
    if (!hit) return;
    world.camera.three.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const y = FLOOR + EYE;
    const ex = hit.point.x, ez = hit.point.z;
    await clearSelection();
    world.camera.controls.setLookAt(
      ex, y, ez, ex + _fwd.x * 4, y, ez + _fwd.z * 4, true);
  }

  // pointer handling: drag = orbit, single tap = select, double tap = teleport
  let down = null, lastTap = 0, lastX = 0, lastY = 0;
  container.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  container.addEventListener("pointerup", async (e) => {
    if (down && (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4)) return;
    const rect = container.getBoundingClientRect();
    const lx = e.clientX - rect.left, ly = e.clientY - rect.top;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 25) {
      lastTap = 0;
      await teleportTo(lx, ly);
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
    await selectAt(lx, ly);
  });

  // Click empty space (Esc) to clear.
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") clearSelection(); });

  // --- preset POV views ---------------------------------------------------
  const viewsEl = document.getElementById("views");
  const addView = (label, fn) => {
    const btn = document.createElement("button");
    btn.className = "view-btn";
    btn.textContent = label;
    btn.addEventListener("click", fn);
    viewsEl.appendChild(btn);
  };
  addView("\u{1F3E0} Overview", () =>
    world.camera.controls.fitToBox(modelBox, true));
  {
    // One eye-level view per room: stand just inside the near wall looking
    // across the room toward the building centre (central rooms face North).
    const spaceMap = await model.getItemsOfCategories([/IFCSPACE/]);
    const ids = Object.values(spaceMap).flat();
    const boxes = await model.getBoxes(ids);
    const data = await model.getItemsData(ids, { attributesDefault: true });
    const c = modelBox.getCenter(new THREE.Vector3());
    const rc = new THREE.Vector3(), dir = new THREE.Vector3();
    ids.forEach((id, i) => {
      const bx = boxes[i];
      bx.getCenter(rc);
      const name = String(data[i]?.Name?.value ?? "Room");
      dir.set(c.x - rc.x, 0, c.z - rc.z);
      if (dir.lengthSq() < 0.25) dir.set(0, 0, -1);
      dir.normalize();
      const y = FLOOR + EYE;
      const ex = rc.x - dir.x * 1.5, ez = rc.z - dir.z * 1.5;
      const tx = rc.x + dir.x * 6, tz = rc.z + dir.z * 6;
      addView(name, () =>
        world.camera.controls.setLookAt(ex, y, ez, tx, y, tz, true));
    });
  }

  // --- compass ------------------------------------------------------------
  // The model is authored to true cardinal directions (IFC +X=East, +Y=North).
  // web-ifc maps IFC +Y -> three.js -Z, so "North" in the scene is (0,0,-1).
  // Rotate the compass rose so its N points along North's screen direction.
  const rose = document.getElementById("compass-rose");
  const camOrigin = new THREE.Vector3();
  const northPt = new THREE.Vector3();
  function updateCompass() {
    const cam = world.camera.three;
    cam.updateMatrixWorld();
    camOrigin.set(0, 0, 0).project(cam);
    northPt.set(0, 0, -1).project(cam); // one unit North in world space
    const dx = northPt.x - camOrigin.x;
    const dy = northPt.y - camOrigin.y; // NDC y is up
    // Angle to rotate "up" (the rose's default N) onto the North screen vector.
    const angle = Math.atan2(dx, dy);
    rose.style.transform = `rotate(${angle}rad)`;
  }
  world.camera.controls.addEventListener("update", updateCompass);
  world.camera.controls.addEventListener("rest", updateCompass);
  updateCompass();
}

main().catch((err) => {
  console.error(err);
  setStatus(`Error: ${err.message}`);
});
