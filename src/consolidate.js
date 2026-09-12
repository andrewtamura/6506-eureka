// Collapse the static procedural geometry into one mesh per material.
//
// WHY: the ground floor is authored as ~1750 separate little meshes — every
// stile, rail, cove and baluster its own object, which is exactly what CLAUDE.md
// asks for and exactly what a renderer charges for. three.js pays per OBJECT, so
// the scene issued 1857 draw calls a frame and spent ~20-26 ms inside render()
// walking the graph before the GPU drew a pixel. That is the whole reason
// panning felt sluggish, and it is a CPU cost, so it is the same on real
// hardware as in a headless container.
//
// Measured on ?solo=ground:
//     base              25.8 ms/frame   1857 draw calls
//     merged             6.3 ms/frame    310 draw calls
//     merged + frozen    5.0 ms/frame    310 draw calls
//
// Three things that look like the cause and measurably are NOT — don't chase
// them again: fragments.core.update(true) on every camera "update" event (0.4 ms
// synchronous, so not it); material switching (deduplicating 275 materials down
// to their 129 distinct looks moved render() by 0.2 ms, and forcing a single
// shared material made it WORSE); and the shadow map (sun.shadow.autoUpdate is
// already false, so it is baked on demand).
//
// The originals are HIDDEN, not deleted. That is what keeps this cheap:
// Box3.expandByObject has no visibility check, so tools/kitchen-check.mjs goes on
// measuring the real authored parts through userData.item and its `loose` list
// and needs no flag and no second code path; while projectObject returns early on
// an invisible subtree, so they cost nothing per frame.
import * as THREE from "three";

// A material whose look depends on per-vertex data we would have to carry across,
// or on draw order we would be changing.
const TEXTURE_KEYS = ["map", "normalMap", "aoMap", "alphaMap", "bumpMap", "emissiveMap",
                      "roughnessMap", "metalnessMap", "displacementMap", "lightMap"];
const mergeable = (m) =>
  m && !Array.isArray(m) && !TEXTURE_KEYS.some((k) => m[k]) &&
  // Transparent members are sorted against each other by object centre; merging
  // them would give the whole group ONE sort position. Cheap to leave out.
  !m.transparent && !(m.opacity < 1);

/**
 * @param scene    the THREE.Scene to consolidate in place
 * @param anchors  objects whose subtree must stay attached to THEM rather than to
 *                 the scene — the fragments model objects, which get repositioned
 *                 after load. A merged mesh is parented to its anchor and its
 *                 vertices baked relative to it, so a later move still carries it.
 */
// Two meshes can share a merged geometry only if they present the same material. For
// OUR meshes that means the same material OBJECT — several builders mutate a shared
// material in place (the ceilings' plan-view toggle, the lighting scenes), and merging
// two look-alike materials into one would let such a change leak across. A fragments
// model's materials are mutated by nobody now that highlighting is gone, so those can
// be grouped by LOOK instead, which is a much bigger collapse: 63 material objects
// across its 304 visible meshes turn out to be only 28 distinct looks.
const LOOK = (m) => JSON.stringify([m.type, m.color?.getHex(), m.roughness, m.metalness,
  m.transparent, m.opacity, m.side, m.emissive?.getHex(), m.map?.uuid ?? 0,
  m.flatShading, m.vertexColors, m.depthWrite]);

export function consolidateStatic({ scene, anchors = [], includeModels = false }) {
  const t0 = performance.now();
  const anchorSet = new Set(anchors);
  scene.updateMatrixWorld(true);
  // A fragments model USED to own its meshes in a way that ruled merging them out: it
  // recoloured them one at a time for selection highlighting, and a merged copy would
  // have kept drawing the old colour. With highlighting gone, the only question left is
  // whether the library still adds or reveals meshes after load — measured across hard
  // panning, dollying and every level switch, the set does not move at all (1473 meshes,
  // 366 visible, zero churn), and the setVisible calls that hide door and opening
  // geometry all run during init, before this pass. So `includeModels` merges them too.
  // Our own furniture parented under those models (the exterior lanterns, every
  // exhibit's furniture) is still distinguished, because it is grouped by material
  // OBJECT rather than by look — see LOOK above.
  const modelRoots = new Set(anchors);

  // group key: everything that changes how the mesh is DRAWN must match, or the
  // merge would quietly relight/reshadow its members. Layers matter especially —
  // the exterior massing sits on layer 2 to pick up the sky fill that interiors
  // must not get.
  const groups = new Map();
  const walk = (o, anchor, ours = true) => {
    if (o.userData?.merged) return;
    // entering a fragments model puts us on the library's turf; a userData.item group
    // inside it puts us back on ours
    if (modelRoots.has(o)) ours = false;
    else if (o.userData?.item) ours = true;
    // An animated subtree (a door leaf, a sliding chair) is not skipped — it
    // becomes its own anchor. Its parts don't move relative to IT, so merging
    // inside it is safe and the merged child rides the pivot exactly as the
    // originals did. That is the largest remaining block: 246 meshes.
    const a = (anchorSet.has(o) || o.userData?.dynamic) ? o : anchor;
    if (o.isMesh && !o.isInstancedMesh && o.visible && (ours || includeModels) &&
        mergeable(o.material) && o.geometry?.getAttribute("position")) {
      const mk = ours ? o.material.uuid : LOOK(o.material);
      const key = `${a.uuid}|${mk}|${+o.castShadow}${+o.receiveShadow}` +
                  `|${o.layers.mask}|${o.renderOrder}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { anchor: a, mesh: o, list: [] }));
      g.list.push(o);
    }
    for (const c of o.children) walk(c, a, ours);
  };
  walk(scene, scene);

  const inv = new THREE.Matrix4(), local = new THREE.Matrix4();
  let merged = 0, absorbed = 0;
  for (const { anchor, mesh: proto, list } of groups.values()) {
    if (list.length < 2) continue;                  // nothing to save
    inv.copy(anchor.matrixWorld).invert();
    const parts = [];
    let n = 0;
    for (const o of list) {
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      local.multiplyMatrices(inv, o.matrixWorld);
      g.applyMatrix4(local);
      if (!g.getAttribute("normal")) g.computeVertexNormals();
      parts.push(g);
      n += g.getAttribute("position").count;
    }
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let off = 0;
    for (const g of parts) {
      pos.set(g.getAttribute("position").array, off * 3);
      nor.set(g.getAttribute("normal").array, off * 3);
      off += g.getAttribute("position").count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    const m = new THREE.Mesh(geo, proto.material);
    m.castShadow = proto.castShadow;
    m.receiveShadow = proto.receiveShadow;
    m.layers.mask = proto.layers.mask;
    m.renderOrder = proto.renderOrder;
    m.matrixAutoUpdate = false;
    m.userData.merged = true;
    anchor.add(m);
    m.updateMatrix();
    for (const o of list) o.visible = false;
    merged++; absorbed += list.length;
  }

  // The authored meshes never move again, so stop three recomputing their world
  // matrices every frame. Worth ~6 ms/frame on its own, and 1.3 ms on top of the
  // merge. Skip the anchors: a fragments model IS still repositioned.
  let frozen = 0;
  const freeze = (o) => {
    // Never inside a fragments model: it streams geometry and writes its own
    // matrices, and freezing those would strand a mesh at a stale transform.
    if (modelRoots.has(o)) return;
    // A pivot/chair root still has its transform written every frame, and a
    // fragments model is still repositioned after load. Leave both, and their
    // children with them — there are few, and a merged child under a live parent
    // already carries matrixAutoUpdate = false of its own.
    if (o.userData?.dynamic || anchorSet.has(o)) return;
    if (o !== scene && o.matrixAutoUpdate && !o.isLight && !o.isCamera) {
      o.matrixAutoUpdate = false; frozen++;
    }
    for (const c of o.children) freeze(c);
  };
  freeze(scene);

  return { merged, absorbed, frozen, buildMs: Math.round(performance.now() - t0) };
}
