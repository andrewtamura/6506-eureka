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
const propsEl = document.getElementById("props-menu");
const propsBody = document.getElementById("props-body");
const propsTitle = document.getElementById("props-title");
const PROPS_HINT = '<div class="muted">Tap an element — a wall, the floor, a window — to see what it is.</div>';
const setStatus = (t) => { statusEl.textContent = t; statusEl.style.display = t ? "block" : "none"; };

async function main() {
  const container = document.getElementById("viewer");

  // Strip the engine's "That Open Company" watermark logo (an SVG-bearing div
  // the renderer appends into the container). Our own UI lives outside #viewer
  // and uses no SVGs, so any SVG div added here is the logo.
  const stripLogo = () =>
    container.querySelectorAll(":scope > div").forEach((d) => {
      if (d.querySelector("svg")) d.remove();
    });
  new MutationObserver(stripLogo).observe(container, { childList: true });

  // --- world (scene + renderer + camera) ---------------------------------
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera = new OBC.SimpleCamera(components);
  components.init();

  world.scene.setup();
  const scene = world.scene.three;
  await world.camera.controls.setLookAt(18, 14, 18, 0, 1.5, 0);

  // Wider field of view for an immersive interior feel (a 50–60° lens reads as
  // "looking through a tube" once you're standing in a room); a small near
  // plane keeps nearby walls from clipping when you're close to them.
  const cam3 = world.camera.three;
  cam3.fov = 75;
  cam3.near = 0.05;
  cam3.updateProjectionMatrix();

  const grids = components.get(OBC.Grids);
  grids.create(world);

  // --- time-of-day lighting ----------------------------------------------
  // Replace SimpleScene's default lights with our own sun + sky rig so the
  // Morning/Afternoon/Evening/Night presets fully control the look.
  const defaultLights = [];
  scene.traverse((o) => { if (o.isLight) defaultLights.push(o); });
  defaultLights.forEach((l) => l.removeFromParent());
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  const sky = new THREE.HemisphereLight(0xbfdcff, 0x9a8a7a, 0.8);
  scene.add(sun, sun.target, sky);
  const LIGHTING = {
    Morning:   { bg: 0xcfe3f5, sun: 0xffd9a0, si: 2.2, dir: [1, 0.45, 0.2],   sky: 0xbcd8f0, grd: 0x9a7a5a, hi: 0.6 },
    Afternoon: { bg: 0xb0d4f1, sun: 0xfff3e0, si: 3.2, dir: [-0.3, 1, 0.25],  sky: 0xbfdcff, grd: 0x9a8a7a, hi: 0.9 },
    Evening:   { bg: 0xf3c79a, sun: 0xff8a45, si: 2.0, dir: [-1, 0.35, -0.1], sky: 0xb08fb0, grd: 0x6a5a4a, hi: 0.5 },
    Night:     { bg: 0x0b1020, sun: 0x9fb6ff, si: 0.5, dir: [0.2, 1, -0.3],   sky: 0x22304a, grd: 0x0d1018, hi: 0.25 },
  };
  function applyLighting(name) {
    const p = LIGHTING[name];
    scene.background = new THREE.Color(p.bg);
    sun.color.set(p.sun); sun.intensity = p.si;
    sun.position.set(p.dir[0], p.dir[1], p.dir[2]).normalize().multiplyScalar(40);
    sky.color.set(p.sky); sky.groundColor.set(p.grd); sky.intensity = p.hi;
  }
  applyLighting("Afternoon");
  const lightEl = document.getElementById("lighting");
  const icons = { Morning: "\u{1F305}", Afternoon: "☀️", Evening: "\u{1F307}", Night: "\u{1F319}" };
  for (const name of Object.keys(LIGHTING)) {
    const btn = document.createElement("button");
    btn.className = "view-btn";
    btn.textContent = `${icons[name]} ${name}`;
    btn.addEventListener("click", () => applyLighting(name));
    lightEl.appendChild(btn);
  }

  // --- fragments engine ---------------------------------------------------
  const fragments = components.get(OBC.FragmentsManager);
  // Self-hosted worker (copied into public/ by scripts/prepare-assets.mjs) so
  // there is no runtime CDN dependency. The default getWorker() fetches it
  // from unpkg, which we deliberately avoid.
  fragments.init(`${BASE}worker.mjs`);

  // Keep the fragments geometry in sync with the camera. Force the upload to
  // finish on every change (not just on "rest") so hardwood planks and walls
  // don't visibly stream/pop in while the camera is still moving — the model is
  // small enough to draw in full. (update() without force streams progressively,
  // which is what caused the pop-in.)
  world.camera.controls.addEventListener("rest", () => fragments.core.update(true));
  world.camera.controls.addEventListener("update", () => fragments.core.update(true));

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
  // Render the whole house at full geometry instead of the DEFAULT view-based
  // LOD/culling, which made hardwood planks and walls pop in/out as the camera
  // moved. ALL_GEOMETRY still honours items we explicitly hide (IfcSpace
  // volumes, door panels) — it only stops the distance/frustum culling. The
  // model is small enough that drawing it all is cheap.
  await model.setLodMode(FRAGS.LodMode.ALL_GEOMETRY);
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
    propsTitle.textContent = "ℹ️ Selection";
    propsBody.innerHTML = PROPS_HINT;
    propsEl.classList.remove("open"); // collapse the menu when nothing is picked
  }

  function renderProps(title, rows) {
    propsBody.innerHTML = "";
    propsTitle.textContent = `ℹ️ ${title}`;
    for (const [k, v] of rows) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span class="k"></span><span class="v"></span>`;
      row.querySelector(".k").textContent = k;
      row.querySelector(".v").textContent = v;
      propsBody.appendChild(row);
    }
    propsEl.classList.add("open"); // expand the menu to reveal the picked element
  }

  const pointer = new THREE.Vector2();
  const dom = world.renderer.three.domElement;
  const raycastAt = (lx, ly) => {
    pointer.set(lx, ly);
    return model.raycast({ camera: world.camera.three, mouse: pointer, dom });
  };

  async function selectAt(lx, ly) {
    const hit = await raycastSurface(lx, ly);
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
    const category = String(val(data?._category) ?? "Element");
    // Plain-language label for the IFC class (the raw class name and internal
    // id aren't meaningful to a homeowner).
    // _category comes back uppercase (e.g. "IFCWALL"), so key by that.
    const FRIENDLY = {
      IFCWALL: "Wall", IFCWALLSTANDARDCASE: "Wall", IFCSLAB: "Floor",
      IFCDOOR: "Door", IFCWINDOW: "Window", IFCSPACE: "Room",
      IFCCOVERING: "Floor finish", IFCFURNISHINGELEMENT: "Furniture",
      IFCFURNITURE: "Furniture", IFCROOF: "Roof", IFCBEAM: "Beam",
      IFCCOLUMN: "Column", IFCMEMBER: "Frame", IFCPLATE: "Glass panel",
      IFCSTAIR: "Stair", IFCRAILING: "Railing", IFCBUILDINGELEMENTPROXY: "Fixture",
    };
    const key = category.toUpperCase();
    const rest = key.replace(/^IFC/, "");
    const kind = FRIENDLY[key] || (rest ? rest[0] + rest.slice(1).toLowerCase() : "Element");
    const rows = [["What it is", kind]];
    const display = data?.LongName != null ? String(val(data.LongName))
                  : data?.Name != null ? String(val(data.Name)) : "";
    if (display && display.toLowerCase() !== kind.toLowerCase())
      rows.push(["Name", display]);
    renderProps(kind, rows);
  }

  // --- interior camera: confine to a room so panning can't fly through walls
  const FLOOR = modelBox.min.y + 0.2; // floor surface (slab top) in world Y
  const EYE = 1.63;                    // eye height for a 5'8" person (~1.63 m)
  const LOOK_DIST = 0.05;              // orbit radius indoors: ~0 so you spin in place
  const ROOM_INSET = 0.55;             // keep the standing point this far from walls (m)
  const ctrls = world.camera.controls;
  const roomBoxes = [];                // { name, box } filled when POV views build
  const skipIds = new Set();           // door + opening ids to ignore when teleporting
  const floorIds = new Set();          // slab + floor-finish ids: the only teleport targets
  // Stand inside a room with a first-person feel. The orbit pivot sits just in
  // front of the eye (LOOK_DIST), so looking around rotates almost in place
  // instead of swinging the camera on a wide arc into the walls. The boundary
  // box is inset from the walls and pinned to head height, so dragging can
  // never push the camera into a wall or lift it toward the ceiling.
  function enterRoom() {
    // No boundary: the standing point is pre-clamped to a safe spot (see
    // clampToRoom) and pan/zoom are disabled, so the camera can only spin ~5 cm
    // in place and never translates into a wall. Avoiding boundaryEnclosesCamera
    // is what fixes the heading snapping — a boundary would yank the camera
    // position to satisfy the box, and against a 5 cm orbit radius that yank
    // recomputed (and reset) the look direction.
    ctrls.setBoundary(undefined);
    ctrls.boundaryEnclosesCamera = false;
    ctrls.azimuthRotateSpeed = -1;       // reverse drag for a first-person look feel
    ctrls.polarRotateSpeed = -1;
    ctrls.minPolarAngle = Math.PI * 0.30; // look up to ~54° above horizontal
    ctrls.maxPolarAngle = Math.PI * 0.70; // and ~54° below — no straight up/down
    ctrls.minDistance = LOOK_DIST;        // lock the orbit radius so pinch-zoom
    ctrls.maxDistance = LOOK_DIST;        // can't dolly the camera out of the room
    ctrls.truckSpeed = 0;                 // no two-finger pan (would exit the room)
  }
  function exitToOverview() {
    ctrls.boundaryEnclosesCamera = false;
    ctrls.setBoundary(undefined);
    ctrls.azimuthRotateSpeed = 1;        // normal orbit for the overview
    ctrls.polarRotateSpeed = 1;
    ctrls.minPolarAngle = 0;             // free orbit again
    ctrls.maxPolarAngle = Math.PI;
    ctrls.minDistance = 0;
    ctrls.maxDistance = Infinity;
    ctrls.truckSpeed = 2;
    ctrls.fitToBox(modelBox, true);
  }
  const roomAt = (x, z) => roomBoxes.find(
    (r) => x >= r.box.min.x && x <= r.box.max.x && z >= r.box.min.z && z <= r.box.max.z);

  // Pull a floor point to a safe standing spot inside its room: clamped to the
  // room box minus the wall inset (so you never stand in/behind a wall, even
  // when the tapped point is right at a doorway threshold). Falls back to the
  // nearest room when the point lands under a wall (between room boxes).
  function clampToRoom(ex, ez) {
    let r = roomAt(ex, ez);
    if (!r) {
      let best = Infinity;
      for (const rb of roomBoxes) {
        const mx = (rb.box.min.x + rb.box.max.x) / 2, mz = (rb.box.min.z + rb.box.max.z) / 2;
        const dd = (mx - ex) ** 2 + (mz - ez) ** 2;
        if (dd < best) { best = dd; r = rb; }
      }
    }
    if (!r) return { x: ex, z: ez };
    const b = r.box;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const minx = b.min.x + ROOM_INSET, maxx = b.max.x - ROOM_INSET;
    const minz = b.min.z + ROOM_INSET, maxz = b.max.z - ROOM_INSET;
    return {
      x: minx <= maxx ? Math.min(Math.max(ex, minx), maxx) : cx,
      z: minz <= maxz ? Math.min(Math.max(ez, minz), maxz) : cz,
    };
  }

  // Teleport target: nearest real surface, ignoring doors/openings so you can
  // step THROUGH a doorway (the opening's void box would otherwise block).
  async function raycastSurface(lx, ly) {
    pointer.set(lx, ly);
    const hits = await model.raycastAll({ camera: world.camera.three, mouse: pointer, dom });
    if (!hits || !hits.length) return null;
    const cam = world.camera.three.position;
    return hits
      .filter((h) => !skipIds.has(h.localId))
      .sort((a, b) => a.point.distanceTo(cam) - b.point.distanceTo(cam))[0] || null;
  }

  // Identify the walkable floor surfaces (structural slabs + floor finishes like
  // hardwood/tile/rugs). Ceiling coverings are excluded so teleport only ever
  // lands on a floor. Done once, up front.
  {
    const slabs = Object.values(await model.getItemsOfCategories([/IFCSLAB/])).flat();
    for (const id of slabs) floorIds.add(id);
    const covs = Object.values(await model.getItemsOfCategories([/IFCCOVERING/])).flat();
    if (covs.length) {
      const cdata = await model.getItemsData(covs, { attributesDefault: true });
      covs.forEach((id, i) => {
        const pt = cdata[i]?.PredefinedType;
        const v = String((pt && typeof pt === "object" && "value" in pt) ? pt.value : pt);
        if (v !== "CEILING") floorIds.add(id); // FLOORING (and anything not a ceiling)
      });
    }
  }

  // Debug marker: concentric rings dropped on the floor at the last double-tap
  // so we can see exactly where a tap lands. Green = it hit a floor (teleports),
  // red = it hit something else (no teleport).
  const tapMarker = new THREE.Group();
  tapMarker.visible = false;
  tapMarker.renderOrder = 999;
  for (const r of [0.12, 0.3, 0.5]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r - 0.025, r, 48),
      new THREE.MeshBasicMaterial({ color: 0x00e676, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthTest: false }));
    ring.rotation.x = -Math.PI / 2; // lay flat on the floor (XZ plane)
    ring.renderOrder = 999;
    tapMarker.add(ring);
  }
  const tapDot = new THREE.Mesh(
    new THREE.CircleGeometry(0.05, 24),
    new THREE.MeshBasicMaterial({ color: 0x00e676, transparent: true, opacity: 0.95,
      side: THREE.DoubleSide, depthTest: false }));
  tapDot.rotation.x = -Math.PI / 2; tapDot.renderOrder = 999;
  tapMarker.add(tapDot);
  world.scene.three.add(tapMarker);
  function showTapMarker(point, isFloor) {
    const col = isFloor ? 0x00e676 : 0xff5252;
    tapMarker.children.forEach((m) => m.material.color.setHex(col));
    tapMarker.position.set(point.x, FLOOR + 0.02, point.z);
    tapMarker.visible = true;
  }

  async function teleportTo(lx, ly) {
    const hit = await raycastSurface(lx, ly);
    if (!hit) return;
    showTapMarker(hit.point, floorIds.has(hit.localId)); // debug: where did the tap land?
    // Only floors are teleport targets — double-tapping a wall/window/etc. is a no-op.
    if (!floorIds.has(hit.localId)) return;
    // Keep the heading you were facing. Derive it from the controls' azimuth
    // (always well-defined) rather than the camera's 3D forward vector — the
    // latter collapses to nothing when you tap the floor while looking steeply
    // down (e.g. from the top-down overview), which used to snap you to north.
    const az = ctrls.azimuthAngle;
    const fx = -Math.sin(az), fz = -Math.cos(az); // horizontal forward for this azimuth
    const { x: ex, z: ez } = clampToRoom(hit.point.x, hit.point.z); // safe standing spot
    const y = FLOOR + EYE;
    await clearSelection();
    await ctrls.setLookAt(ex, y, ez, ex + fx * LOOK_DIST, y, ez + fz * LOOK_DIST, true);
    enterRoom();
  }

  // --- interactive doors (double-tap a door to swing it open/closed) ------
  const doorMeshes = []; // door panel meshes (for raycasting)
  const doors = [];      // { pivot, openAngle, target, current }
  const doorRaycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  function pickDoor(lx, ly) {
    _ndc.set((lx / dom.clientWidth) * 2 - 1, -(ly / dom.clientHeight) * 2 + 1);
    doorRaycaster.setFromCamera(_ndc, world.camera.three);
    const hits = doorRaycaster.intersectObjects(doorMeshes, false);
    return hits.length ? hits[0].object.userData.door : null;
  }
  // A door "unit" may have 1 leaf (single) or 2 (double); tapping any leaf
  // toggles the whole unit so both leaves swing together.
  const toggleDoor = (leaf) => { leaf.unit.open = !leaf.unit.open; };
  (function animateDoors() {
    for (const d of doors) {
      const target = d.unit.open ? d.openAngle : 0;
      if (Math.abs(d.current - target) > 1e-3) {
        d.current += (target - d.current) * 0.2; // ease toward target
        d.pivot.rotation.y = d.current;
      }
    }
    requestAnimationFrame(animateDoors);
  })();

  // pointer handling: drag = orbit, single tap = select,
  // double tap = open/close a door (if one is tapped) else teleport
  let down = null, lastTap = 0, lastX = 0, lastY = 0;
  container.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  container.addEventListener("pointerup", async (e) => {
    if (down && (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4)) return;
    const rect = container.getBoundingClientRect();
    const lx = e.clientX - rect.left, ly = e.clientY - rect.top;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 25) {
      lastTap = 0;
      const door = pickDoor(lx, ly);
      if (door) toggleDoor(door);
      else await teleportTo(lx, ly);
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
  addView("\u{1F3E0} Overview", () => exitToOverview());
  {
    // One eye-level view per room: stand at the room centre (always inside)
    // looking toward the building centre, and confine the camera to the room.
    const spaceMap = await model.getItemsOfCategories([/IFCSPACE/]);
    const ids = Object.values(spaceMap).flat();
    const boxes = await model.getBoxes(ids);
    const data = await model.getItemsData(ids, { attributesDefault: true });
    const c = modelBox.getCenter(new THREE.Vector3());
    const rc = new THREE.Vector3(), dir = new THREE.Vector3();
    ids.forEach((id, i) => {
      const box = boxes[i].clone();
      box.getCenter(rc);
      const name = String(data[i]?.Name?.value ?? "Room");
      roomBoxes.push({ name, box });
      dir.set(c.x - rc.x, 0, c.z - rc.z);
      if (dir.lengthSq() < 0.25) dir.set(0, 0, -1);
      dir.normalize();
      const y = FLOOR + EYE, cx = rc.x, cz = rc.z;
      const tx = cx + dir.x * LOOK_DIST, tz = cz + dir.z * LOOK_DIST;
      addView(name, async () => {
        await ctrls.setLookAt(cx, y, cz, tx, y, tz, true);
        enterRoom();
      });
    });
    // Hide the translucent IfcSpace volumes (they clutter the view and the
    // raycast hits them first, blocking teleport) and never raycast them.
    await model.setVisible(ids, false);
    for (const id of ids) skipIds.add(id);
    await fragments.core.update(true);
  }

  // --- build swinging door overlays ---------------------------------------
  // Hide the baked IFC door panels (can't cheaply animate them) and overlay our
  // own hinged leaves. Wide doors become double doors. Also hide the
  // IfcOpeningElement void boxes (rendered semi-opaque) so cased openings and
  // open doorways are fully see-through.
  {
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x9b7653 });
    const dmap = await model.getItemsOfCategories([/IFCDOOR/]);
    const ids = Object.values(dmap).flat();
    const boxes = await model.getBoxes(ids);
    const ddata = await model.getItemsData(ids, { attributesDefault: true });
    await model.setVisible(ids, false);
    const omap = await model.getItemsOfCategories([/IFCOPENINGELEMENT/]);
    const oids = Object.values(omap).flat();
    if (oids.length) await model.setVisible(oids, false);
    await fragments.core.update(true);
    for (const id of ids) skipIds.add(id);   // doors + openings: not teleport targets
    for (const id of oids) skipIds.add(id);

    // hinge/swing per door, from the generator's manifest (keyed by door name)
    const meta = {};
    try {
      for (const d of await (await fetch(`${BASE}doors.json`)).json()) meta[d.name] = d;
    } catch (e) { /* fall back to defaults */ }

    const ANG = Math.PI / 2;
    const DOUBLE = 1.2; // doors wider than this (m) split into double doors
    ids.forEach((id, i) => {
      const bx = boxes[i];
      const sx = bx.max.x - bx.min.x, sy = bx.max.y - bx.min.y, sz = bx.max.z - bx.min.z;
      const cx = (bx.min.x + bx.max.x) / 2, cz = (bx.min.z + bx.max.z) / 2;
      const alongX = sx >= sz;                 // door runs E-W (true) or N-S
      const W = alongX ? sx : sz;              // door width along the wall
      const th = Math.max(alongX ? sz : sx, 0.05); // leaf thickness
      const nm = String(ddata[i]?.Name?.value ?? "");
      const m = meta[nm] || {};
      const hingeMax = !!m.hingeMax;
      const sign = m.swingSign != null ? m.swingSign : (alongX ? -1 : 1);
      const unit = { open: false };
      const mkLeaf = (hx, hz, leafW, dirSign, openAngle) => {
        const pivot = new THREE.Group();
        pivot.position.set(hx, bx.min.y, hz);
        const geo = alongX
          ? new THREE.BoxGeometry(leafW, sy, th)
          : new THREE.BoxGeometry(th, sy, leafW);
        const panel = new THREE.Mesh(geo, doorMat);
        if (alongX) panel.position.set(dirSign * leafW / 2, sy / 2, 0);
        else panel.position.set(0, sy / 2, dirSign * leafW / 2);
        pivot.add(panel);
        world.scene.three.add(pivot);
        const leaf = { pivot, openAngle, current: 0, unit, name: nm };
        panel.userData.door = leaf;
        doors.push(leaf);
        doorMeshes.push(panel);
      };
      if (W > DOUBLE) {                         // double doors (french/patio)
        const half = W / 2;                     // sign picks which side they swing to
        if (alongX) {
          mkLeaf(bx.min.x, cz, half, +1, -sign * ANG);
          mkLeaf(bx.max.x, cz, half, -1, +sign * ANG);
        } else {
          mkLeaf(cx, bx.min.z, half, +1, -sign * ANG);
          mkLeaf(cx, bx.max.z, half, -1, +sign * ANG);
        }
      } else {                                  // single leaf
        const dir = hingeMax ? -1 : +1;         // extend away from the hinge jamb
        if (alongX) mkLeaf(hingeMax ? bx.max.x : bx.min.x, cz, W, dir, sign * ANG);
        else mkLeaf(cx, hingeMax ? bx.max.z : bx.min.z, W, dir, sign * ANG);
      }
    });
    window.__eureka.doors = doors; // for the headless smoke test
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
