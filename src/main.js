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

  // When a model is added, attach it to the camera + scene and frame it.
  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
    const box = new THREE.Box3().setFromObject(model.object);
    if (!box.isEmpty()) world.camera.controls.fitToBox(box, true);
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
  const model = await ifcLoader.load(bytes, true, "Eureka Residence");
  await fragments.core.update(true);
  setStatus("");

  // Debug handle (used by the headless smoke test; harmless in production).
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
  let down = null;
  container.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  container.addEventListener("pointerup", async (e) => {
    // Ignore drags (orbiting the camera shouldn't select).
    if (down && (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4)) return;
    const rect = container.getBoundingClientRect();
    pointer.set(e.clientX - rect.left, e.clientY - rect.top);
    const hit = await model.raycast({
      camera: world.camera.three,
      mouse: pointer,
      dom: world.renderer.three.domElement,
    });
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
  });

  // Click empty space (Esc) to clear.
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") clearSelection(); });
}

main().catch((err) => {
  console.error(err);
  setStatus(`Error: ${err.message}`);
});
