// Eureka Residence — BIM viewer built on That Open Engine (@thatopen/*).
//
// Pipeline: fetch floorplan.ifc -> IfcLoader converts it to Fragments (off the
// main thread via a web worker) -> the FragmentsModel is added to the 3D world.
// Clicking an element raycasts the model and shows its IFC properties.

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import { setupLighting } from "./lighting.js";
import { setupCompass } from "./compass.js";
import { buildWoodFloor } from "./wood-floor.js";
import { buildSubfloor } from "./subfloor.js";
import { buildTileFloor } from "./tile-floor.js";
import { buildFurniture, buildChair, buildRug, buildSofa } from "./furniture.js";
import { buildWallFinish } from "./wall-finish.js";
import { buildCeilings } from "./ceilings.js";
import { createWalker } from "./pov.js";

const BASE = import.meta.env.BASE_URL; // respects Vite `base` on GitHub Pages
// Cache-buster for the model assets. The JS bundle is content-hashed so it busts
// itself, but the IFC + JSON manifests keep fixed filenames across deploys, so a
// browser/CDN can serve a stale model under a fresh app shell. Appending the
// build hash as a query string makes every deploy fetch the current geometry.
const VER = typeof __BUILD_HASH__ !== "undefined" && __BUILD_HASH__ !== "dev" ? `?v=${__BUILD_HASH__}` : "";
const statusEl = document.getElementById("status");
const propsEl = document.getElementById("props-menu");
const propsBody = document.getElementById("props-body");
const propsTitle = document.getElementById("props-title");
const PROPS_HINT = '<div class="muted">Tap an element — a wall, the floor, a window — to see what it is.</div>';
const setStatus = (t) => { statusEl.textContent = t; statusEl.style.display = t ? "block" : "none"; };

// Recessed LED downlights for the attic + bathroom: a flush trim ring with a
// bright emissive lens set into the (flat 8.5 ft) ceiling, plus a downlight
// below. Parented to the attic model (local plan coords: x->-x, z->-z, y up;
// floor at local y=0). Also a wall-mounted vanity light over the bathroom mirror.
function addAtticLighting(parent, onFixture) {
  const FT = 0.3048, eave = 2.5, pit = 0.6667, flatCeil = 8.5;
  const F = { x1: -12, x2: 31, z1: -11.9167, z2: 16.0833 };      // attic footprint (plan ft)
  // ceiling height capped flat at 8.5 ft (sloping down only near the eaves)
  const ceilH = (px, pz) => Math.min(flatCeil, eave + pit * Math.min(px - F.x1, F.x2 - px, pz - F.z1, F.z2 - pz));
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xe9e9e9, roughness: 0.5, metalness: 0.2 });
  const lensMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d6, emissiveIntensity: 0.28, roughness: 0.3 });
  // recessed can flush with the ceiling at plan (px,pz). The light is a SpotLight
  // aimed straight DOWN (like a real downlight) so it pools on the floor instead of
  // spraying sideways onto nearby walls (which read as a wrong "reflection").
  const can = (px, pz, intensity = 4.5, yFt = null) => {
    const cy = yFt != null ? yFt : ceilH(px, pz);   // yFt overrides for dormer pockets (higher than the main slope)
    const g = new THREE.Group();
    g.position.set(-px * FT, cy * FT, -pz * FT);
    const trim = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.03, 20), trimMat);
    trim.position.y = -0.015; g.add(trim);                       // ring flush at ceiling
    const lm = lensMat.clone();
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.012, 20), lm);
    lens.position.y = -0.03; g.add(lens);                        // glowing lens just below
    const light = new THREE.SpotLight(0xfff2d6, intensity, 0, Math.PI / 4.4, 0.7, 2);
    light.position.y = -0.05;
    light.target.position.set(0, -3, 0);                         // aim straight down
    g.add(light); g.add(light.target);
    parent.add(g);
    onFixture && onFixture(light, lm);
  };
  // wall-mounted vanity bar on the east bathroom wall, above the mirror (faces W into the room)
  const vanityBar = (px, pz, y, lenZ, intensity = 1.8) => {
    const g = new THREE.Group();
    g.position.set(-px * FT, y * FT, -pz * FT);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, lenZ * FT), trimMat); g.add(bar);
    const lm = lensMat.clone();
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, (lenZ - 0.3) * FT), lm);
    lens.position.x = -0.03; g.add(lens);                        // lens faces -localX = WEST = into the bathroom
    // SpotLight aimed DOWN-and-into-the-bathroom (west) so it lights the vanity, not
    // the stairwell wall on the east side of this wall. (-localX = west = into room.)
    const light = new THREE.SpotLight(0xfff2d6, intensity, 0, Math.PI / 4, 0.8, 2);
    light.position.set(-0.05, -0.05, 0);
    light.target.position.set(-1.0, -2.0, 0);                    // down + west into the bathroom
    g.add(light); g.add(light.target);
    parent.add(g);
    onFixture && onFixture(light, lm);
  };

  // Recessed downlights laid out for the three attic ROOMS (see the attic furniture:
  // EAST-wing bedroom px -12..3.9167, CENTRAL hall px 3.9167..15.1 with the kitchenette
  // + stair, WEST-wing bathroom px 15.1..31). Brighter + wider coverage than the old
  // single ridge row so every room actually reads.
  const CAN = 8.5;
  // EAST-wing BEDROOM: a spread over the usable floor, incl. one over the NE-corner bed.
  can(-8, 10, CAN); can(-1, 9, CAN); can(-8, 1, CAN); can(-1, 1, CAN); can(-4, -7, CAN);
  // CENTRAL hall: stair-landing cans + two cans in the SOUTH shed dormer over the
  // kitchenette (explicit ~5.9 ft = dormer plate; ceilH would place them at the low main slope).
  can(6.5, -3, CAN); can(11, 8.5, CAN);
  can(6.5, -10.5, CAN, 5.9); can(12.5, -10.5, CAN, 5.9);
  // WEST-wing BATHROOM: brighter cans (+ one for the west end) and a brighter vanity bar.
  can(18, 1.0, CAN); can(22, 6.8, CAN); can(27, -4, CAN);
  vanityBar(15.5, -0.75, 6.0, 2.4, 2.4);
}

// Landscape / exterior lighting, built on the exterior massing and tagged
// "exterior" so a scene switches it on as a group (starts OFF for the daytime
// landing view). Three pieces: an elegant post-top STREET LAMP on a poured
// concrete base at the NW lot corner; a STRING-LIGHT post in the middle of the
// west side yard fanning catenary strands to the house at 10' above grade; and a
// row of facade UPLIGHTS across the north (front) elevation. Plan feet: px grows
// WEST, pz grows NORTH; parent-local (x,y,z) = (-px, height, -pz)·FT, grade y=0.
function addLandscapeLighting(parent, onFixture) {
  const FT = 0.3048;
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b5ac, roughness: 0.96, metalness: 0.0 });
  const metalDark = new THREE.MeshStandardMaterial({ color: 0x20211f, roughness: 0.5, metalness: 0.7 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.85, metalness: 0.05 });
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.7 });
  const mesh = (geo, mat, y) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; return m; };
  const P = (px, pz, y) => new THREE.Vector3(-px * FT, y * FT, -pz * FT);   // parent-local point

  // 1) Post-top street lamp at the NW lot corner, on a poured concrete base.
  {
    const g = new THREE.Group(); g.position.copy(P(44.5, 23.5, 0)); parent.add(g);
    g.add(mesh(new THREE.CylinderGeometry(0.5 * FT, 0.64 * FT, 1.3 * FT, 20), concrete, 0.65 * FT));   // poured base
    g.add(mesh(new THREE.CylinderGeometry(0.28 * FT, 0.32 * FT, 0.5 * FT, 16), metalDark, 1.45 * FT)); // base collar
    g.add(mesh(new THREE.CylinderGeometry(0.11 * FT, 0.17 * FT, 9.5 * FT, 16), metalDark, (1.3 + 9.5 / 2) * FT)); // tapered pole
    const lampGlass = new THREE.MeshStandardMaterial({ color: 0xfff1cf, emissive: 0xffb14a, emissiveIntensity: 0.7, roughness: 0.3, transparent: true, opacity: 0.9 });
    g.add(mesh(new THREE.CylinderGeometry(0.34 * FT, 0.46 * FT, 1.1 * FT, 6), lampGlass, 11.55 * FT));  // hex glass lantern
    g.add(mesh(new THREE.CylinderGeometry(0.10 * FT, 0.52 * FT, 0.55 * FT, 6), metalDark, 12.4 * FT));  // roof cap
    g.add(mesh(new THREE.SphereGeometry(0.09 * FT, 10, 8), metalDark, 12.85 * FT));                     // finial
    const light = new THREE.PointLight(0xffd39a, 18, 14, 2); light.position.y = 11.55 * FT; g.add(light);
    onFixture && onFixture(light, lampGlass);
  }

  // 2) String-light post in the middle of the west side yard, fanning catenary
  //    strands to the house's west wall. The strands leave the post at 10' and
  //    rise to meet the wall at 12' above grade.
  {
    const postPx = 46, postPz = -3.9, hFt = 10, wallFt = 12;
    const g = new THREE.Group(); g.position.copy(P(postPx, postPz, 0)); parent.add(g);
    g.add(mesh(new THREE.CylinderGeometry(0.2 * FT, 0.24 * FT, 10.6 * FT, 12), wood, 5.3 * FT));
    g.add(mesh(new THREE.ConeGeometry(0.26 * FT, 0.4 * FT, 12), wood, 10.8 * FT));                      // post cap
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff3d4, emissive: 0xffca73, emissiveIntensity: 1.2, roughness: 0.35 });
    const A = P(postPx, postPz, hFt);
    const mids = [];
    for (const tz of [-11, -3, 5, 13]) {              // fan to 4 points on the house west wall (px≈31)
      const B = P(30.6, tz, wallFt);
      const sag = 1.4 * FT, pts = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16, p = A.clone().lerp(B, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); }
      const curve = new THREE.CatmullRomCurve3(pts);
      parent.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.012, 5, false), wireMat));
      for (let i = 1; i < 16; i += 2) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), bulbMat); b.position.copy(pts[i]); parent.add(b); }
      mids.push(curve.getPoint(0.5));
    }
    for (const idx of [0, 2]) {                        // a couple of warm lights to wash the yard (high → soft)
      const light = new THREE.PointLight(0xffe0b0, 5, 9, 2); light.position.copy(mids[idx]); light.position.y += 0.1; parent.add(light);
      onFixture && onFixture(light, bulbMat);
    }
    const pl = new THREE.PointLight(0xffe0b0, 4, 8, 2); pl.position.copy(A); parent.add(pl); onFixture && onFixture(pl, bulbMat);
  }


  // 4) Front-step puddle lights: little warm downlights tucked just under the
  //    splayed cheek-wall caps, spilling pools onto the treads. Porch geometry
  //    mirrors add_porch: 5 flaring steps from the terrace front (pz 19.08) down
  //    to the foot (pz 22.88); cheek half-width curves 4.5'→6.5'; cap top ramps
  //    from 4.7' at the terrace to 2.2' at the foot.
  {
    const doorPx = 9.5, base = 2.5, ph = 2.2, tread = 0.95;
    const zTf = 16.0833 + 3.0, run = 4 * tread;                 // terrace front -> cascade foot
    const wcurve = (t) => 4.5 + (6.5 - 4.5) * Math.pow(t, 1.8); // cheek half-width along the run
    const lensMat = new THREE.MeshStandardMaterial({ color: 0xffe9c8, emissive: 0xffcf94, emissiveIntensity: 0.9, roughness: 0.35 });
    for (const s of [-1, 1]) {                                  // left + right cheek walls
      for (const t of [0.18, 0.5, 0.82]) {
        const pz = zTf + t * run, px = doorPx - s * wcurve(t), y = (base + ph - base * t) - 0.5;
        const g = new THREE.Group(); g.position.copy(P(px, pz, y)); parent.add(g);
        const lm = lensMat.clone();
        g.add(mesh(new THREE.CylinderGeometry(0.08 * FT, 0.08 * FT, 0.035, 10), lm, 0)); // small flush lens
        const light = new THREE.SpotLight(0xffe0b0, 2.6, 2.2, Math.PI / 6, 0.7, 2);
        light.position.set(0, 0, 0);
        light.target.position.set(0, -1, 0.12);               // down, spilling a pool onto the tread
        g.add(light); g.add(light.target);
        onFixture && onFixture(light, lm);
      }
    }
  }

  // 5) Entry lanterns: give the two flanking porch pendants real, scene-switched
  //    light (they carry only a faint baked glow otherwise) — a warm filament in
  //    each lantern cage plus a soft wash over the stoop. Bulb position mirrors
  //    buildPorchPendant: below + forward of the wall mount (px 5.6 / 13.4).
  {
    const flame = new THREE.MeshStandardMaterial({ color: 0xfff2cf, emissive: 0xffcf82, emissiveIntensity: 1.2, roughness: 1 });
    for (const px of [5.6, 13.4]) {
      const g = new THREE.Group();
      g.position.set(-px * FT, 2.7127 - 0.42, -16.0833 * FT - 0.40); parent.add(g);
      const fm = flame.clone();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), fm));
      const light = new THREE.PointLight(0xffdca0, 2.2, 4.5, 2); g.add(light);
      onFixture && onFixture(light, fm);
    }
  }

  // 6) Rear deck / patio: string lights strung from the house's south wall to the
  //    top of the CMU garden wall, plus warm cap lights along that wall — lighting
  //    the outdoor room off the family-room patio doors.
  {
    const houseS = -11.9167, wallS = -23.2, hHouse = 9, hWall = 7;
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff3d4, emissive: 0xffca73, emissiveIntensity: 1.2, roughness: 0.35 });
    const mids = [];
    for (const px of [-19, -13, -7, -1]) {             // strands span the deck (family/extension bay)
      const A = P(px, houseS, hHouse), B = P(px, wallS, hWall);
      const sag = 1.3 * FT, pts = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16, p = A.clone().lerp(B, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); }
      const curve = new THREE.CatmullRomCurve3(pts);
      parent.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.012, 5, false), wireMat));
      for (let i = 1; i < 16; i += 2) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), bulbMat); b.position.copy(pts[i]); parent.add(b); }
      mids.push(curve.getPoint(0.5));
    }
    for (const idx of [0, 3]) { const light = new THREE.PointLight(0xffe0b0, 5, 9, 2); light.position.copy(mids[idx]); parent.add(light); onFixture && onFixture(light, bulbMat); }
    const capMat = new THREE.MeshStandardMaterial({ color: 0xfff0cc, emissive: 0xffcf85, emissiveIntensity: 1.0, roughness: 0.5 });
    for (const px of [-18, -6, 6, 18]) {               // post-cap lights on the CMU wall top
      const g = new THREE.Group(); g.position.copy(P(px, wallS, hWall)); parent.add(g);
      const cm = capMat.clone();
      g.add(mesh(new THREE.CylinderGeometry(0.1 * FT, 0.12 * FT, 0.14 * FT, 10), metalDark, 0.07 * FT)); // cap fixture
      g.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), cm, 0.22 * FT));                                 // glowing globe
      const light = new THREE.PointLight(0xffe0b0, 2, 3.5, 2); light.position.y = 0.22 * FT; g.add(light);
      onFixture && onFixture(light, cm);
    }
  }

}

// A new one-story attached extension on the EAST side of the ALTERNATIVE lot, with
// a full roof deck on top. Footprint (plan ft): px ∈ [-38, -11.5] — west wall on
// the primary's east wall (px -12; nudged 0.5' in so faces don't z-fight), east
// wall 15' off the east property line (px -53 → -38); pz ∈ [-11.9167, 10.0833] —
// south wall aligned with the primary's south wall, north wall set back 6' from
// the primary's north wall (pz 16.0833). One story to the primary's 2nd-floor line
// (deck at 12.5' = 2.5' crawl + 10' story), matching the primary foundation +
// water-table belt. Parented to the alt model (local x=-px·FT, z=-pz·FT, grade
// y=0); its massing materials join the day sky-fill so they match the primary.
function addAltExtension(parent, extFillMats) {
  const FT = 0.3048;
  const mat = (r, g, b, rough = 0.92) => {
    const m = new THREE.MeshStandardMaterial({ roughness: rough, metalness: 0 });
    m.color.setRGB(r, g, b); m.side = THREE.DoubleSide; return m;
  };
  const wallMat = mat(0.87, 0.86, 0.83), foundMat = mat(0.55, 0.54, 0.52), trimMat = mat(0.93, 0.92, 0.88);
  const roofMat = mat(0.19, 0.19, 0.21, 0.9);    // dark flat-roof membrane (mostly hidden behind the parapet)
  for (const m of [wallMat, foundMat, trimMat]) { m.userData._fillBase = m.color.clone(); extFillMats.add(m); }
  // (roofMat is kept OUT of the day sky-fill so the low membrane reads dark, not pale.)
  const g = new THREE.Group(); parent.add(g);
  const box = (x0, x1, z0, z1, y0, y1, m) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0) * FT, (y1 - y0) * FT, Math.abs(z1 - z0) * FT), m);
    b.position.set(-(x0 + x1) / 2 * FT, (y0 + y1) / 2 * FT, -(z0 + z1) / 2 * FT);
    b.castShadow = true; b.receiveShadow = true; b.frustumCulled = false; g.add(b); return b;
  };
  const PX0 = -38, PX1 = -11.5, PZ0 = -11.9167, PZ1 = 10.0833;
  const CRAWL = 2.5, ROOF = 12.5, WP = 0.06 / FT, WH = 0.15 / FT;   // one story: roof/deck at 12.5'
  box(PX0, PX1, PZ0, PZ1, 0, CRAWL, foundMat);                                          // crawlspace / foundation
  box(PX0 - WP, PX1 + WP, PZ0 - WP, PZ1 + WP, CRAWL - WH, CRAWL + 0.05 / FT, trimMat);   // water-table belt
  box(PX0, PX1, PZ0, PZ1, CRAWL, ROOF, wallMat);                                        // single-story walls
  // FLAT roof behind a decorated PARAPET — matching the primary's flat-roof
  // treatment (a raised parapet capped with a projecting coping, a cornice band,
  // and a dentil course, all in the same white trim), with a partial roof DECK on
  // top (see below). The single-story parapet stays well below the primary's ~25'
  // eave so the wing reads as a low, subordinate echo of its classical detailing.
  const PARA = ROOF + 2.5, pt = 0.5;                    // parapet top (15'); parapet-wall thickness (ft)
  box(PX0, PX1, PZ0, PZ1, ROOF, ROOF + 0.2, roofMat);   // flat roof membrane
  box(PX0, PX0 + pt, PZ0, PZ1, ROOF, PARA, wallMat);    // parapet — east
  box(PX0, PX1, PZ0, PZ0 + pt, ROOF, PARA, wallMat);    // parapet — south
  box(PX0, PX1, PZ1 - pt, PZ1, ROOF, PARA, wallMat);    // parapet — north
  // (No west parapet: the primary's tall east wall bounds the deck on that side and
  //  keeps the 2nd-floor egress door clear onto the deck.)
  // Decorate the 3 exterior parapet faces (E/S/N; the west abuts the primary).
  // `band` runs a continuous horizontal trim member (coping / cornice) along a face,
  // projecting `pr` ft proud; `dentils` studs a face with evenly spaced small blocks.
  const band = (face, y0, y1, pr) => {
    if (face === "E") box(PX0 - pr, PX0 + 0.12, PZ0 - pr, PZ1 + pr, y0, y1, trimMat);
    if (face === "S") box(PX0 - pr, PX1, PZ0 - pr, PZ0 + 0.12, y0, y1, trimMat);
    if (face === "N") box(PX0 - pr, PX1, PZ1 - 0.12, PZ1 + pr, y0, y1, trimMat);
  };
  const dentils = (face, y0, y1, pr) => {
    const step = 0.85, bw = 0.4;
    if (face === "E") {
      const lo = Math.min(PZ0, PZ1), n = Math.floor(Math.abs(PZ1 - PZ0) / step);
      for (let i = 0; i < n; i++) { const c = lo + (i + 0.5) * step; box(PX0 - pr, PX0 + 0.06, c - bw / 2, c + bw / 2, y0, y1, trimMat); }
    } else {
      const outer = face === "S" ? PZ0 - pr : PZ1 + pr, inner = face === "S" ? PZ0 + 0.06 : PZ1 - 0.06;
      const lo = Math.min(PX0, PX1), hi = Math.max(PX0, PX1), n = Math.floor((hi - lo - 1.0) / step);
      for (let i = 0; i < n; i++) { const c = lo + 0.5 + (i + 0.5) * step; box(c - bw / 2, c + bw / 2, outer, inner, y0, y1, trimMat); }
    }
  };
  for (const f of ["E", "S", "N"]) {
    band(f, PARA - 0.25, PARA + 0.3, 0.55);      // projecting coping cap
    band(f, PARA - 1.0, PARA - 0.55, 0.35);      // cornice band
    dentils(f, PARA - 1.7, PARA - 1.15, 0.22);   // dentil course beneath the cornice
  }
  // Roof DECK on the private SOUTH half (~50% coverage), kept away from the north
  // wall. It's bounded by the parapet on the east + south and by the primary's wall
  // on the west; a guard railing along its north edge separates it from the plain
  // membrane on the north half of the roof.
  const deckMat = mat(0.60, 0.47, 0.34, 0.8), railMat = mat(0.40, 0.30, 0.20, 0.7);
  const Zdeck = PZ0 + 0.66 * (PZ1 - PZ0);               // deck north edge at 66% coverage (still short of the north wall)
  const dxa = PX0 + pt, dxb = PX1;                       // inside the east parapet → primary's wall
  box(dxa, dxb, PZ0 + pt, Zdeck, ROOF + 0.05, ROOF + 0.25, deckMat);   // deck floor (over the membrane)
  const rTop = PARA, T = 0.25, P = 0.28;                 // railing top matched to the parapet height
  box(dxa, dxb, Zdeck - T / 2, Zdeck + T / 2, rTop - 0.18, rTop, railMat);  // top rail
  const nP = Math.max(2, Math.round((dxb - dxa) / 6));
  for (let i = 0; i <= nP; i++) {                        // evenly spaced posts
    const t = dxa + (dxb - dxa) * i / nP;
    box(t - P / 2, t + P / 2, Zdeck - P / 2, Zdeck + P / 2, ROOF, rTop, railMat);
  }
}

// Patio furniture + an outdoor rug on the alt extension's south roof deck (deck
// top ≈ 12.75'). Reuses the procedural furniture builders (sofa / chair / rug).
// A lounge grouping: a sofa backed to the house facing east, two accent chairs
// opposite facing back west, and a low coffee table between them, all on the rug.
// Parented to the alt model; plan px WEST, pz NORTH → local x=-px·FT, z=-pz·FT.
function addAltDeckFurniture(parent) {
  const FT = 0.3048;
  const g = new THREE.Group(); parent.add(g);
  const deckY = 12.75;                                  // deck floor top (ft)
  const P = (px, pz, y) => new THREE.Vector3(-px * FT, y * FT, -pz * FT);
  const place = (obj, px, pz, yaw = 0) => { obj.position.copy(P(px, pz, deckY)); obj.rotation.y = yaw; g.add(obj); return obj; };
  place(buildRug({ w: 15, d: 9, material: "slate" }), -23, -4.5);                                  // outdoor rug
  place(buildSofa({ wFt: 7, dFt: 3, faces: "E", material: "sage", cushion: "oatmeal", legMaterial: "walnut" }), -19.5, -4.5); // sofa, back to the house
  place(buildChair({ material: "oatmeal", legMaterial: "walnut" }), -27.5, -2.5, -Math.PI / 2);    // accent chair (faces the sofa)
  place(buildChair({ material: "oatmeal", legMaterial: "walnut" }), -27.5, -6.5, -Math.PI / 2);    // accent chair (faces the sofa)
  // low coffee table (teak top on four legs) between the sofa and chairs
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.5 });
  const ct = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(3.4 * FT, 0.14 * FT, 1.9 * FT), wood); top.position.y = 1.3 * FT; ct.add(top);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16 * FT, 1.25 * FT, 0.16 * FT), wood);
    leg.position.set(sx * 1.5 * FT, 0.62 * FT, sz * 0.8 * FT); ct.add(leg);
  }
  place(ct, -23.5, -4.5, 0);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
}

// Concrete driveway filling the 15' east setback of the alt lot: it runs the full
// north-south length of the lot, in the strip between the extension's east wall
// (px -38) and the east property line (px -53). A raised charcoal border frames
// the concrete field on its three inner sides, and where it reaches the north
// (street) perimeter the raised street curb is broken by a curb cut — a flush
// apron that ramps down to the street. Parented to the alt model; plan px WEST,
// pz NORTH → local x=-px·FT, z=-pz·FT, grade y=0.
function addAltDriveway(parent) {
  const FT = 0.3048;
  const g = new THREE.Group(); parent.add(g);
  const box = (x0, x1, z0, z1, y0, y1, m, shadow = false) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0) * FT, (y1 - y0) * FT, Math.abs(z1 - z0) * FT), m);
    b.position.set(-(x0 + x1) / 2 * FT, (y0 + y1) / 2 * FT, -(z0 + z1) / 2 * FT);
    b.castShadow = shadow; b.receiveShadow = true; b.frustumCulled = false; g.add(b); return b;
  };
  const concrete = new THREE.MeshStandardMaterial({ color: 0xc4c3bf, roughness: 0.95 });   // light concrete grey
  const border = new THREE.MeshStandardMaterial({ color: 0x4a4850, roughness: 0.9 });      // charcoal banding
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x37373a, roughness: 1.0 });     // street
  // setback strip: extension east wall (WX) → inner face of the east boundary wall
  // (EX = east line -53 + 8" CMU); south inner wall face (SZ) → north property line
  // (NZ). The slab sits nearly flush with grade; reserve the last stretch
  // (apronZ→NZ) for the flush street apron of the curb cut.
  const WX = -38, EX = -52.33, SZ = -23.208, NZ = 26.125, BW = 1.0, apronZ = NZ - 3.5;
  const fW = WX - BW, fE = EX + BW, fS = SZ + BW;       // concrete field, inset by the border
  box(fW, fE, fS, apronZ, 0, 0.12, concrete);           // concrete field (near-flush, ~1.5")
  box(WX, fW, SZ, apronZ, 0, 0.18, border);             // decorative border — west (along the extension wall)
  box(EX, fE, SZ, apronZ, 0, 0.18, border);             // decorative border — east (along the property wall)
  box(WX, EX, SZ, fS, 0, 0.18, border);                 // decorative border — south
  // Curb cut at the north (street) perimeter: a short strip of street sits beyond
  // the property line, a raised 6" street curb runs the frontage WEST of the drive,
  // and across the driveway the curb is cut away to a flush apron a car can cross.
  box(-20, -53, NZ, NZ + 8, -0.06, 0.03, asphalt);          // street beyond the north line
  box(WX, EX, apronZ, NZ + 0.4, 0, 0.05, concrete, false);  // flush apron (the cut) lapping to the street
  box(WX, -20, NZ - 0.2, NZ + 0.5, 0.03, 0.5, concrete, true);  // raised street curb west of the opening
}

// Six-lite divided windows on the east extension's three exterior walls
// (east/south/north), white-trimmed. Modest and secondary next to the primary's
// tall formal windows. Footprint px ∈ [-38,-11.5], pz ∈ [-11.9167,10.0833]; one
// story (floor 2.5' → roof 12.5'), one quiet row of six-lite windows. Local coords:
// x=-px·FT, z=-pz·FT, grade y=0.
function addAltExtensionWindows(parent, extFillMats) {
  const FT = 0.3048;
  const glass = new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.5 }); glass.color.setRGB(0.42, 0.52, 0.60);
  const white = new THREE.MeshStandardMaterial({ roughness: 0.7 }); white.color.setRGB(0.93, 0.92, 0.88);
  if (extFillMats) { white.userData._fillBase = white.color.clone(); extFillMats.add(white); }  // white trim joins the day sky-fill
  const g = new THREE.Group(); parent.add(g);
  const box = (cx, cy, cz, sx, sy, sz, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(cx, cy, cz); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; g.add(m);
  };
  const W = 3.2, wM = W * FT, fb = 0.35 * FT;
  // one six-lite window at sill height `sill` (ft): `axis` = wall-normal ('x' east,
  // 'z' south/north); face at `wall`; `along` = position along the wall (local z for
  // east, local x for s/n). Head is `hgt` above the sill.
  const win = (axis, wall, along, out, sill, hgt) => {
    const yc = (sill + sill + hgt) / 2 * FT, hM = hgt * FT;
    if (axis === "x") {   // east wall: thin in x; width along z, height along y
      box(wall + out * 0.02, yc, along, 0.05, hM + fb, wM + fb, white);   // frame
      box(wall + out * 0.05, yc, along, 0.04, hM, wM, glass);             // glazing
      box(wall + out * 0.07, yc, along, 0.05, hM, 0.04, white);           // vertical muntin (2 cols)
      for (const t of [-1, 1]) box(wall + out * 0.07, yc + t * hM / 6, along, 0.05, 0.04, wM, white); // 2 horiz (3 rows)
    } else {              // south/north wall: thin in z; width along x, height along y
      box(along, yc, wall + out * 0.02, wM + fb, hM + fb, 0.05, white);
      box(along, yc, wall + out * 0.05, wM, hM, 0.04, glass);
      box(along, yc, wall + out * 0.07, 0.04, hM, 0.05, white);
      for (const t of [-1, 1]) box(along, yc + t * hM / 6, wall + out * 0.07, wM, 0.04, 0.05, white);
    }
  };
  const eX = 38 * FT, sZ = 11.9167 * FT, nZ = -10.0833 * FT;
  // Single story: sill 5.0' → head 8.4', comfortably below the 12.5' roof.
  const rows = [{ sill: 5.0, hgt: 3.4 }];
  for (const { sill, hgt } of rows) {
    for (const pz of [-6, 5]) win("x", eX, -pz * FT, +1, sill, hgt);              // EAST (2)
    for (const px of [-32, -24.75, -17.5]) win("z", sZ, -px * FT, +1, sill, hgt); // SOUTH (3)
    for (const px of [-32, -24.75, -17.5]) win("z", nZ, -px * FT, -1, sill, hgt); // NORTH (3)
  }
}

// Re-draw the 2nd-floor east window (moved 4' south of "Upper - East" at pz 10.0417
// → pz 6.0417) plus a new exterior egress DOOR 6" further south, on the primary's
// east wall (px -12 → local x = 12·FT) facing the roof deck (+x). Both sit at the
// 2nd-floor line (12.5'); the door threshold is level with the deck. Parented to the
// alt model (local x=-px·FT, z=-pz·FT, grade y=0).
function addAltDeckAccess(parent, extFillMats) {
  const FT = 0.3048;
  const wallX = 12 * FT, F2 = 12.5;                 // east-wall local x; 2nd-floor level (ft)
  const glass = new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.5 }); glass.color.setRGB(0.42, 0.52, 0.60);
  const trim = new THREE.MeshStandardMaterial({ roughness: 0.7 }); trim.color.setRGB(0.93, 0.92, 0.88);
  const wood = new THREE.MeshStandardMaterial({ roughness: 0.6 }); wood.color.setRGB(0.36, 0.26, 0.18);
  // Join the white TRIM to the day sky-fill so it reads as bright as the other
  // windows' trim; the door slab (wood) and glass stay out so they keep their own
  // (darker / see-through) look.
  if (extFillMats) { trim.userData._fillBase = trim.color.clone(); extFillMats.add(trim); }
  const g = new THREE.Group(); parent.add(g);
  // slab on the east wall: zW/y in FEET (z = north/south span, y0..y1 vertical), proud
  // of the wall by `out` ft toward the deck (+x), thickness `th` ft.
  const slab = (pzc, zW, y0, y1, out, th, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(th * FT, (y1 - y0) * FT, zW * FT), mat);
    m.position.set(wallX + out * FT, (y0 + y1) / 2 * FT, -pzc * FT);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; g.add(m); return m;
  };
  // WINDOW at pz 6.0417 (sill 2.5' / head 6' above the 2nd floor)
  const wz = 6.0417, ws = F2 + 2.5, wh = F2 + 6.0;
  slab(wz, 2.6, ws - 0.15, wh + 0.15, 0.05, 0.5, trim);            // frame/surround (recessed)
  slab(wz, 2.2, ws, wh, 0.18, 0.1, glass);                        // glazing (proud)
  slab(wz, 0.14, ws, wh, 0.2, 0.12, trim);                        // vertical muntin
  slab(wz, 2.2, (ws + wh) / 2 - 0.07, (ws + wh) / 2 + 0.07, 0.2, 0.12, trim);  // horizontal muntin
  // DOOR: window south edge = 6.0417-1.25=4.79; 6' gap → door north edge -1.21; 3' wide → centre -2.71
  const dz = -2.71, dh = F2 + 6.83;
  slab(dz, 3.5, F2, dh + 0.2, 0.05, 0.5, trim);                   // casing
  slab(dz, 3.0, F2, dh, 0.16, 0.16, wood);                       // door slab
  slab(dz, 2.4, F2 + 3.6, dh - 0.4, 0.26, 0.06, glass);          // upper lite
  slab(dz - 1.15, 0.28, F2 + 2.7, F2 + 3.3, 0.3, 0.1, trim);     // lever handle (near the south stile)
}

async function main() {
  const container = document.getElementById("viewer");

  // Show which build is live (git hash + date) so a cached/stale asset is
  // obvious. The values are injected by Vite `define` at build time.
  {
    const buildEl = document.getElementById("build-info");
    const hash = typeof __BUILD_HASH__ !== "undefined" ? __BUILD_HASH__ : "dev";
    const date = typeof __BUILD_DATE__ !== "undefined" ? __BUILD_DATE__ : "";
    if (buildEl) {
      buildEl.innerHTML =
        `build <a href="https://github.com/andrewtamura/6506-eureka/commit/${hash}" ` +
        `target="_blank" rel="noopener" style="color:#2563c9;text-decoration:none">${hash}</a>` +
        (date ? ` · ${date}` : "");
    }
  }

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

  // Cast real shadows so the ceiling/walls/floor block the sun (daylight only
  // enters through windows + open doors) and recesses read with depth.
  world.renderer.three.shadowMap.enabled = true;
  world.renderer.three.shadowMap.type = THREE.PCFSoftShadowMap;
  world.renderer.three.localClippingEnabled = true;   // clip tile mosaics to their room box

  const grids = components.get(OBC.Grids);
  grids.create(world);

  // --- time-of-day dial --------------------------------------------------
  // A circular 24-hour dial that reflects the cyclic nature of time: drag the
  // sun knob around the ring. Noon is at top, midnight at the bottom; the sun
  // rises on the left (dawn) and sets on the right (dusk) — its daily arc. The
  // top half of the ring is tinted day, the bottom half night.
  const { setTime, setSeason, focusShadow, refreshShadow, onTime } = setupLighting(scene);
  const lightEl = document.getElementById("lighting");
  const caption = (t) => {
    const d = document.createElement("div");
    d.textContent = t;
    d.style.cssText = "flex-basis:100%;font-size:11px;color:#889;font-weight:600;margin:4px 0 -2px";
    return d;
  };
  const fmtHour = (h) => {
    const hr = Math.floor(h) % 24, mn = Math.round((h - Math.floor(h)) * 60) % 60;
    const ap = hr < 12 ? "AM" : "PM", h12 = ((hr + 11) % 12) + 1;
    return `${h12}:${String(mn).padStart(2, "0")} ${ap}`;
  };
  const NS = "http://www.w3.org/2000/svg";
  const SZ = 150, C = SZ / 2, RR = 56;
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  };
  const dial = el("svg", { viewBox: `0 0 ${SZ} ${SZ}` });
  dial.style.cssText = "width:150px;height:150px;touch-action:none;cursor:grab";
  dial.appendChild(el("path", { d: `M ${C - RR} ${C} A ${RR} ${RR} 0 0 1 ${C + RR} ${C}`, fill: "none", stroke: "#bcd8f0", "stroke-width": "8", "stroke-linecap": "round" })); // day (top)
  dial.appendChild(el("path", { d: `M ${C + RR} ${C} A ${RR} ${RR} 0 0 1 ${C - RR} ${C}`, fill: "none", stroke: "#3a4763", "stroke-width": "8", "stroke-linecap": "round" })); // night (bottom)
  for (const [t, x, y, a] of [["12p", C, C - RR - 5, "middle"], ["6p", C + RR + 6, C + 3, "start"], ["12a", C, C + RR + 13, "middle"], ["6a", C - RR - 6, C + 3, "end"]])
    dial.appendChild(el("text", { x, y, "text-anchor": a, "font-size": "9", fill: "#889" }, t));
  const knob = el("circle", { r: "8", fill: "#f5b942", stroke: "#fff", "stroke-width": "2" });
  const label = el("text", { x: C, y: C + 4, "text-anchor": "middle", "font-size": "13", fill: "#445", "font-weight": "600" });
  dial.append(knob, label);
  lightEl.appendChild(caption("Time of day"));
  lightEl.appendChild(dial);

  let hour = 14;
  const place = (h) => {
    const a = ((h - 12) / 24) * 2 * Math.PI;             // 0 at noon (top), clockwise
    knob.setAttribute("cx", C + RR * Math.sin(a));
    knob.setAttribute("cy", C - RR * Math.cos(a));
    label.textContent = fmtHour(h);
  };
  const apply = (h) => { hour = ((h % 24) + 24) % 24; setTime(hour); place(hour); };
  const fromPointer = (e) => {
    const r = dial.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * SZ - C, py = (e.clientY - r.top) / r.height * SZ - C;
    let a = Math.atan2(px, -py); if (a < 0) a += 2 * Math.PI;  // 0 at top, clockwise
    apply(12 + a / (2 * Math.PI) * 24);
  };
  let dragging = false;
  dial.addEventListener("pointerdown", (e) => { dragging = true; dial.setPointerCapture(e.pointerId); fromPointer(e); });
  dial.addEventListener("pointermove", (e) => { if (dragging) fromPointer(e); });
  dial.addEventListener("pointerup", () => { dragging = false; });
  const now = new Date();                                // seed both dials to the load moment
  apply(now.getHours() + now.getMinutes() / 60);         // current local time of day

  // --- season dial -------------------------------------------------------
  // A second ring for the time of YEAR: drag the knob to move the sun's seasonal
  // arc. Summer (high sun) sits at top, winter (low) at bottom, and the equinoxes
  // (spring / autumn) at the sides — so declination = 23.44°·cos(angle from top).
  const TILT = 23.44;                                   // Earth's axial tilt (deg)
  // The dial's top (angle 0) is the summer solstice (~Jun 21, day 172); turning
  // clockwise advances through the year. Centre label shows that month + day.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const fmtDate = (a) => {
    let doy = Math.round((172 + a / (2 * Math.PI) * 365 - 1)) % 365;   // 0-based day of year
    if (doy < 0) doy += 365;
    let d = doy, mi = 0;
    while (d >= MDAYS[mi]) { d -= MDAYS[mi]; mi++; }
    return `${MONTHS[mi]} ${d + 1}`;
  };
  const sdial = el("svg", { viewBox: `0 0 ${SZ} ${SZ}` });
  sdial.style.cssText = "width:150px;height:150px;touch-action:none;cursor:grab";
  sdial.appendChild(el("path", { d: `M ${C - RR} ${C} A ${RR} ${RR} 0 0 1 ${C + RR} ${C}`, fill: "none", stroke: "#8fc46a", "stroke-width": "8", "stroke-linecap": "round" })); // warm seasons (top)
  sdial.appendChild(el("path", { d: `M ${C + RR} ${C} A ${RR} ${RR} 0 0 1 ${C - RR} ${C}`, fill: "none", stroke: "#9fc1e0", "stroke-width": "8", "stroke-linecap": "round" })); // cool seasons (bottom)
  for (const [t, x, y, a] of [["Summer", C, C - RR - 5, "middle"], ["Fall", C + RR + 6, C + 3, "start"], ["Winter", C, C + RR + 13, "middle"], ["Spring", C - RR - 6, C + 3, "end"]])
    sdial.appendChild(el("text", { x, y, "text-anchor": a, "font-size": "9", fill: "#889" }, t));
  const sknob = el("circle", { r: "8", fill: "#6fae3a", stroke: "#fff", "stroke-width": "2" });
  const slabel = el("text", { x: C, y: C + 4, "text-anchor": "middle", "font-size": "12", fill: "#445", "font-weight": "600" });
  sdial.append(sknob, slabel);
  lightEl.appendChild(caption("Season"));
  lightEl.appendChild(sdial);

  const placeSeason = (a) => {
    sknob.setAttribute("cx", C + RR * Math.sin(a));
    sknob.setAttribute("cy", C - RR * Math.cos(a));
    slabel.textContent = fmtDate(a);
  };
  const applySeason = (a) => {
    a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    setSeason(TILT * Math.cos(a));      // +tilt at top (summer), -tilt at bottom (winter)
    placeSeason(a);
    refreshShadow();
  };
  const seasonFromPointer = (e) => {
    const r = sdial.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * SZ - C, py = (e.clientY - r.top) / r.height * SZ - C;
    let a = Math.atan2(px, -py); if (a < 0) a += 2 * Math.PI;  // 0 at top, clockwise
    applySeason(a);
  };
  let sdragging = false;
  sdial.addEventListener("pointerdown", (e) => { sdragging = true; sdial.setPointerCapture(e.pointerId); seasonFromPointer(e); });
  sdial.addEventListener("pointermove", (e) => { if (sdragging) seasonFromPointer(e); });
  sdial.addEventListener("pointerup", () => { sdragging = false; });
  // seed to today's date, mapped to the dial angle via the SAME simplified 365-day
  // calendar fmtDate reads back (so the centre label matches the browser's date).
  const doyNow = MDAYS.slice(0, now.getMonth()).reduce((s, d) => s + d, 0) + now.getDate() - 1;
  applySeason(2 * Math.PI * (doyNow - 171) / 365);   // applySeason normalises the angle

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
  world.camera.controls.addEventListener("rest", () => { fragments.core.update(true); refreshShadow(); });
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
    // Tessellate circles finely so round furniture (pedestal tables, columns)
    // reads as round, not as a coarse polygon.
    webIfc: { CIRCLE_SEGMENTS: 48 },
  });

  // --- load the levels ----------------------------------------------------
  // The scene is a ROW of views running WESTWARD from the exterior lot:
  // [ Attic | Level 2 | Ground | Exterior+lot ] (West -> East). The Ground floor
  // is the primary, fully-interactive model at the origin; the other levels load
  // as offset "exhibits" beside it. The exterior loads first and is the landing.
  setStatus("Loading model…");
  const levelsCfg = (await (await fetch(`${BASE}levels.json${VER}`)).json()).levels;
  const groundLevel = levelsCfg.find((l) => l.id === "ground") || levelsCfg[0];
  const groundManifests = groundLevel.manifests;
  // coordinate=false keeps authored coordinates so the floor sits on the grid.
  const loadIfc = async (file, name) => {
    const r = await fetch(`${BASE}${file}${VER}`);
    if (!r.ok) throw new Error(`Could not fetch ${file} (${r.status})`);
    const m = await ifcLoader.load(new Uint8Array(await r.arrayBuffer()), false, name);
    // ALL_VISIBLE: no view-based hiding, so geometry doesn't pop as you pan.
    await m.setLodMode(FRAGS.LodMode.ALL_VISIBLE);
    await fragments.core.update(true);
    return m;
  };
  const model = await loadIfc(groundLevel.ifc, groundLevel.storey);

  // Lift the ground floor so its slab rests on the grid plane (Y=0). `viewBox`
  // grows to include the exhibit levels so the plan view frames the whole row.
  const box = new THREE.Box3().setFromObject(model.object);
  let modelBox = box, viewBox = box;
  const framePlan = (transition) => {
    const c = viewBox.getCenter(new THREE.Vector3()), s = viewBox.getSize(new THREE.Vector3());
    // Look straight down with a tiny +Z eye offset (breaks the gimbal) so the
    // view is oriented North-up / East-right: world X (E-W) runs HORIZONTALLY
    // on screen, which is the axis the row of levels is laid out along.
    world.camera.controls.setLookAt(c.x, viewBox.max.y + Math.max(s.x, s.z) * 1.1, c.z + 0.001, c.x, viewBox.min.y, c.z, false);
    world.camera.controls.fitToBox(viewBox, transition);
  };
  // Bounding box of just the "building" meshes of an object — tall geometry,
  // skipping flat ground planes (the lot) — so framing centres on the house,
  // not the lot it sits on.
  const buildingBox = (obj) => {
    const bb = new THREE.Box3();
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o);
      if (!b.isEmpty() && b.max.y - b.min.y > 0.5) bb.union(b);
    });
    return bb.isEmpty() ? new THREE.Box3().setFromObject(obj) : bb;
  };
  // Glide to a 3/4 view of a model: from the front (North = world -Z), a little
  // to the East and elevated, so the model reads as a building with sky around.
  const frameModel = (box, transition) => {
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const d = Math.hypot(s.x, s.y, s.z) * 1.15;
    world.camera.controls.setLookAt(
      c.x + d * 0.42, c.y + d * 0.40, c.z - d * 0.92, c.x, c.y, c.z, transition);
  };
  if (!box.isEmpty()) {
    model.object.position.y -= box.min.y;
    model.object.updateMatrixWorld(true);
    await fragments.core.update(true);
    modelBox = new THREE.Box3().setFromObject(model.object);
    viewBox = modelBox.clone();
  }

  // --- the level row + default camera --------------------------------------
  // The levels run WESTWARD from the exterior lot: the exterior sits at the East
  // end (+X) and Ground / Level 2 / Attic march West. Ground stays the only
  // interactive model (selection/teleport target it). The exterior loads FIRST
  // and the camera lands on it straight away — so the viewer never shows the
  // ground plan and never re-snaps once the rest of the row streams in behind it.
  const GAP = 9;                                        // spacing between views (m)
  let westX = modelBox.min.x, eastX = modelBox.max.x;   // -X / +X frontiers
  let exteriorModel = null;                             // captured for the walk-the-lot POV
  const exhibitModels = [];                             // {lvl, model} for each placed exhibit (walk targets)
  const povCeilingMats = [];                            // attic ceiling materials: opaque in POV, translucent in overview
  const extFillMats = new Set();                        // exterior massing materials: get a day-tracked emissive sky fill
  const extWindowMats = new Set();                      // exterior window glass: warm "interior-on" glow for the night scene
  const fixtures = [];                                  // interior light fixtures for scenes: { light, level, base, emiss, emBase }
  const registerFixture = (light, level, emiss) => fixtures.push(
    { light, level, base: light.intensity, emiss, emBase: emiss ? emiss.emissiveIntensity : 0 });
  const exhibitCeilingMats = [];                        // second-floor flat ceilings: same opaque-POV / translucent-overview toggle
  const furnitureDoorMeshes = [];                       // procedural door leaves (e.g. attic bathroom): double-tap to toggle
  const modelViews = [{ id: groundLevel.id, label: groundLevel.label || groundLevel.storey, box: buildingBox(model.object) }];
  const labelViews = [{ label: groundLevel.label || groundLevel.storey, box: modelBox }];
  const placeExhibit = async (lvl, toEast) => {
    const m = await loadIfc(lvl.ifc, lvl.storey);
    if (lvl.id === "exterior") exteriorModel = m;
    // The smaller models can finish tessellating a frame after load(), so their
    // bounds read empty for a moment; poll until the geometry lands.
    let b0 = new THREE.Box3().setFromObject(m.object);
    for (let tries = 0; b0.isEmpty() && tries < 40; tries++) {
      await new Promise((r) => setTimeout(r, 50));
      await fragments.core.update(true);
      b0 = new THREE.Box3().setFromObject(m.object);
    }
    if (b0.isEmpty()) { console.warn(`exhibit ${lvl.id}: no geometry, skipping`); return null; }
    m.object.position.y -= b0.min.y;                    // slab on the grid
    m.object.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(m.object);
    const dx = toEast ? (eastX + GAP - b.min.x) : (westX - GAP - b.max.x);
    m.object.position.x += dx;
    m.object.updateMatrixWorld(true);
    if (toEast) eastX = b.max.x + dx; else westX = b.min.x + dx;
    m.object.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true;
      // Tag the exterior massing (layer 2) to mark it as "outdoors". NOTE: this does
      // NOT isolate the sky hemisphere to it — ambient/hemisphere lights are gated by
      // the CAMERA's layers, not per-object, so a layer-2-only light is simply inert.
      // The outdoor sky fill is instead the per-material emissive floor added below.
      if (lvl.id === "exterior") o.layers.enable(2);
      for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!mat) continue;
        // Exterior sky fill: collect each OPAQUE massing material so a day-tracked
        // emissive floor can lift its shaded faces (no GI + global-only ambient means
        // a shaded facade otherwise renders near-black despite light-coloured walls).
        // Skip glass/transparent so it doesn't glow.
        if (lvl.id === "exterior" && mat.color && mat.emissive && !(mat.transparent && mat.opacity < 1) && !extFillMats.has(mat)) {
          mat.userData._fillBase = mat.color.clone();
          extFillMats.add(mat);
        }
        // Exterior window glass: collect it so the night scene can give it a warm
        // "interior lights on" glow. Includes translucent glass (dormers, transom)
        // AND the OPAQUE bluish pane material used for the main ground/upper windows
        // (b noticeably > r picks glass while skipping the neutral walls/roof/trim).
        if (lvl.id === "exterior" && mat.color && mat.emissive && !extWindowMats.has(mat) &&
            ((mat.transparent && mat.opacity < 1) || (mat.color.b > mat.color.r + 0.05 && mat.color.b < 0.72))) {
          extWindowMats.add(mat);
        }
        // Render both faces so downward-facing surfaces (the roof soffit / eave
        // overhang undersides) are visible when looking up — otherwise back-face
        // culling makes the roof read as see-through from below.
        mat.side = THREE.DoubleSide;
        // Same transparent-glass fix as the ground model: drop depthWrite so a
        // translucent surface (exterior glass, the attic's slope) reads through.
        if (mat.transparent && mat.opacity < 1) mat.depthWrite = false;
        // The attic's translucent ceiling soffit (light + transparent) — collect it
        // so it can go OPAQUE in the first-person POV (you look up and see the
        // sloped ceiling) while staying see-through in the dollhouse overview.
        // (color.r > 0.7 picks the light drywall ceiling — authored sRGB ~0.93,
        // which lands at ~0.85 in linear space — while excluding the bluish window
        // glass (~0.43) and the dark roof underside (~0.15) which stay see-through.)
        if (lvl.id === "attic" && mat.transparent && mat.opacity < 0.95 && mat.color && mat.color.r > 0.7) {
          mat.userData._planOpacity = mat.opacity;
          povCeilingMats.push(mat);
        }
        mat.needsUpdate = true;
      }
    });
    modelViews.push({ id: lvl.id, label: lvl.label || lvl.storey, box: buildingBox(m.object) });
    labelViews.push({ label: lvl.label || lvl.storey, box: new THREE.Box3().setFromObject(m.object) });
    viewBox.expandByObject(m.object);
    // Procedural furniture for this exhibit level (parented so it inherits the
    // grid/west offset). The exterior is handled separately below; ground has
    // its own full build. floorY=0 = this level's finish floor (slab top).
    if (lvl.id !== "exterior" && lvl.manifests?.furniture) {
      const ef = await buildFurniture({ scene, parent: m.object, floorY: 0, baseUrl: BASE, manifestFile: lvl.manifests.furniture + VER });
      if (ef?.doorMeshes) furnitureDoorMeshes.push(...ef.doorMeshes);
    }
    // hardwood floor (instanced planks), same as the ground floor; floorY is this
    // level's finish (the model sits with its slab top at object.position.y).
    if (lvl.id !== "exterior" && lvl.manifests?.floors)
      await buildWoodFloor({ scene, model: m, fragments, floorY: m.object.position.y, baseUrl: BASE, manifestFile: lvl.manifests.floors + VER });
    // patterned tile mosaic (e.g. the primary en-suite hex floor); empty manifest is a no-op.
    if (lvl.id !== "exterior" && lvl.manifests?.tiles)
      await buildTileFloor({ scene, model: m, fragments, floorY: m.object.position.y, baseUrl: BASE, manifestFile: lvl.manifests.tiles + VER });
    // plywood subfloor (4x8 sheets) — the attic's low-headroom zone beyond the
    // finished floor; empty manifest (other levels) is a no-op.
    if (lvl.id !== "exterior" && lvl.manifests?.subfloor)
      await buildSubfloor({ scene, model: m, fragments, floorY: m.object.position.y, baseUrl: BASE, manifestFile: lvl.manifests.subfloor + VER });
    // Attic interior lighting: recessed LED downlights (ridge + bath/WC) plus a
    // vanity light over the bathroom mirror. Daylight (dormers) does the rest.
    if (lvl.id === "attic") addAtticLighting(m.object, (light, emiss) => registerFixture(light, "attic", emiss));
    // Second floor is an open shell with no IfcSpaces -> give it ONE flat ceiling
    // over its whole footprint, plus a central semi-flush fixture in EACH room (the
    // only nighttime light source per room). Ceiling toggles opaque (POV) /
    // translucent (overview), like the others.
    if (lvl.id === "level2") {
      const FT = 0.3048;
      const WALL = 0.4583 * FT;                          // land the ceiling on the perimeter wall centerline
      const bb = new THREE.Box3().setFromObject(m.object);
      const x0 = bb.min.x + WALL / 2, x1 = bb.max.x - WALL / 2, z0 = bb.min.z + WALL / 2, z1 = bb.max.z - WALL / 2;
      const cy = m.object.position.y + ceilHt;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.06, z1 - z0), newCeilMat());
      slab.position.set((x0 + x1) / 2, cy - 0.03, (z0 + z1) / 2);
      slab.castShadow = true; slab.receiveShadow = true;
      scene.add(slab); exhibitCeilingMats.push(slab.material);
      // One central fixture per room. Centres in plan feet (px grows WEST, pz grows
      // NORTH); world x/z = this exhibit's model origin minus plan*FT. Intensity is
      // scaled loosely to room size for even, realistic residential light.
      const wx = (px) => m.object.position.x - px * FT;
      const wz = (pz) => m.object.position.z - pz * FT;
      const L2_ROOMS = [
        ["NW bedroom",       23.04,  11.04, 3.2],
        ["SW bedroom",       23.04,  -6.46, 3.2],
        ["Primary bedroom",  -4.0,   -3.0,  3.4],
        ["Walk-in closet",   -4.04,  11.04, 2.6],
        ["En-suite",        -17.46,  -4.0,  3.0],
        ["En-suite WC",     -17.46,  -9.7,  2.2],
        ["West bath",        25.54,   2.5,  2.8],
        ["Family room",       9.5,   11.04, 3.4],
        ["E-W landing",       9.5,    2.8,  3.0],
        ["East hall",         1.42,   2.5,  2.2],
        ["West alcove",      17.58,   2.5,  2.2],
      ];
      for (const [, px, pz, inten] of L2_ROOMS) semiFlush(wx(px), cy - 0.04, wz(pz), inten, "level2");
    }
    exhibitModels.push({ lvl, model: m });             // register as a walk target after the walker exists
    return buildingBox(m.object);
  };
  // Exterior first, at the East end → frame it immediately (the landing view).
  const exteriorLvl = levelsCfg.find((l) => l.id === "exterior");
  if (exteriorLvl) {
    const bld = await placeExhibit(exteriorLvl, true);
    if (bld) frameModel(bld, false);
    // Exterior sky fill: add a per-material emissive floor (a fraction of each
    // material's own colour) that scales with daylight, so shaded outdoor faces
    // read as the light masonry they are by day and still go dark at night. This
    // is isolated to the exterior massing — global ambient/hemisphere lights can't
    // be, since they're gated by the camera's layers rather than per-object.
    onTime((day) => {
      const k = 0.34 * day;
      for (const mat of extFillMats) {
        if (!mat.userData._fillBase) continue;
        mat.emissive.copy(mat.userData._fillBase).multiplyScalar(k);
      }
    });

    // Alternative exterior lot: a full duplicate of the exterior model dropped to
    // the SOUTH (world +Z), a scratch lot for trying a different eastern addition.
    // It gets the same day sky-fill, night window glow, and landscape lighting, so
    // it reads identically; the switcher's Lot slot toggles between the two lots.
    try {
      const FT = 0.3048;
      const alt = await loadIfc(exteriorLvl.ifc, "Exterior (alt)");
      let ab = new THREE.Box3().setFromObject(alt.object);
      for (let t = 0; ab.isEmpty() && t < 40; t++) {
        await new Promise((r) => setTimeout(r, 50)); await fragments.core.update(true);
        ab = new THREE.Box3().setFromObject(alt.object);
      }
      const eb = new THREE.Box3().setFromObject(exteriorModel.object);
      // identical geometry → matching the original's transform places it exactly on
      // top of it; then shift SOUTH by TWO lot-depths + a margin, leaving a gap
      // between the two big enough to drop a third identical model in.
      alt.object.position.copy(exteriorModel.object.position);
      alt.object.position.z += 2 * (eb.max.z - eb.min.z) + 4;
      alt.object.updateMatrixWorld(true);
      alt.object.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; o.layers.enable(2);
        for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (!mat || !mat.color || !mat.emissive) continue;
          const glass = (mat.transparent && mat.opacity < 1) || (mat.color.b > mat.color.r + 0.05 && mat.color.b < 0.72);
          if (!glass && !extFillMats.has(mat)) { mat.userData._fillBase = mat.color.clone(); extFillMats.add(mat); }
          if (glass && !extWindowMats.has(mat)) extWindowMats.add(mat);
          mat.side = THREE.DoubleSide;
          if (mat.transparent && mat.opacity < 1) mat.depthWrite = false;
        }
      });
      // Remove the EASTERN EXTENSION (the ext_bath/wc/laundry wing) from the alt so
      // it's a clean slate for a different addition. The extension sits at local
      // x = -px·FT for px ∈ [-22.92,-12] → x ∈ [~3.7, 7], z = -pz·FT for pz ∈
      // [-11.92, 4] → z ∈ [~-1.2, 3.6]; the primary block is all at x < 3.66, so a
      // center-in-box test cleanly isolates the extension's massing/roof/windows.
      try {
        const ids = await alt.getLocalIds();
        const boxes = await alt.getBoxes(ids);
        const uni = new THREE.Box3();
        for (const b of boxes) if (b && !b.isEmpty()) uni.union(b);
        const wbb = new THREE.Box3().setFromObject(alt.object);
        const off = new THREE.Vector3().subVectors(wbb.min, uni.min); // getBoxes-space → world
        const pos = alt.object.position, c = new THREE.Vector3();
        const X0 = 12 * FT - 0.3, X1 = 22.9167 * FT + 0.8, Z0 = -4 * FT - 0.6, Z1 = 11.9167 * FT + 0.6;
        const hide = [];
        for (let i = 0; i < ids.length; i++) {
          const b = boxes[i]; if (!b || b.isEmpty()) continue;
          b.getCenter(c);
          const lx = c.x + off.x - pos.x, lz = c.z + off.z - pos.z;   // → local model space
          if (lx >= X0 && lx <= X1 && lz >= Z0 && lz <= Z1) hide.push(ids[i]);
        }
        if (hide.length) { await alt.setVisible(hide, false); await fragments.core.update(true); }
      } catch (e) { console.warn("alt: could not hide extension", e); }
      // Build the NEW east extension (one story + roof deck) on the alt lot.
      addAltExtension(alt.object, extFillMats);
      addAltExtensionWindows(alt.object, extFillMats);   // 6-lite windows on the 3 exterior walls
      // Deck access: hide the whole 2nd-floor east window ("Upper - East" @ pz
      // 10.0417 on the east wall px-12 — glass AND its frame/muntins are separate
      // items, so hide everything in a tight box around it) and re-draw it 4' south
      // + an egress door 6' further south (see addAltDeckAccess).
      try {
        const aids = await alt.getLocalIds(), abx = await alt.getBoxes(aids);
        const u = new THREE.Box3(); for (const b of abx) if (b && !b.isEmpty()) u.union(b);
        const o2 = new THREE.Vector3().subVectors(new THREE.Box3().setFromObject(alt.object).min, u.min);
        const p2 = alt.object.position, cc = new THREE.Vector3();
        const hideW = [];   // tight box around the original window: x≈3.66, z≈-3.06 (pz10.04), 2nd-floor y
        for (let i = 0; i < aids.length; i++) {
          const b = abx[i]; if (!b || b.isEmpty()) continue; b.getCenter(cc);
          const lx = cc.x + o2.x - p2.x, ly = cc.y + o2.y - p2.y, lz = cc.z + o2.z - p2.z;
          if (lx > 3.35 && lx < 4.05 && lz > -3.55 && lz < -2.55 && ly > 4.2 && ly < 6.0) hideW.push(aids[i]);
        }
        if (hideW.length) { await alt.setVisible(hideW, false); await fragments.core.update(true); }
      } catch (e) { console.warn("alt: window move failed", e); }
      addAltDeckAccess(alt.object, extFillMats);
      addAltDeckFurniture(alt.object);   // patio lounge set + outdoor rug on the roof deck
      addAltDriveway(alt.object);        // concrete driveway in the east setback + curb cut
      modelViews.push({ id: "exterior-alt", label: "Alternative Lot", box: buildingBox(alt.object) });
      labelViews.push({ label: "Alternative Lot", box: new THREE.Box3().setFromObject(alt.object) });
      addLandscapeLighting(alt.object, (light, emiss) => registerFixture(light, "exterior", emiss));
      window.__altPos = { x: alt.object.position.x, y: alt.object.position.y, z: alt.object.position.z }; // render-harness handle
      apply(hour);   // re-fire the day sky-fill so the alt's added materials match the primary
    } catch (err) { console.warn("alt exterior failed", err); }
  }
  setStatus("");

  // Window glass arrives from the IFC styles as a transparent material with
  // depthWrite ON, which makes a pane write the depth buffer and occlude what's
  // behind it — so some windows render as flat opaque blue instead of see-
  // through (and it's view-order dependent, so only some looked wrong). Turn off
  // depthWrite on transparent materials so all glass reads through consistently.
  model.object.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m && m.transparent && m.opacity < 1) { m.depthWrite = false; m.needsUpdate = true; }
    }
  });

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
    propsTitle.textContent = "Selection";
    propsBody.innerHTML = PROPS_HINT;
    propsEl.classList.remove("open"); // collapse the menu when nothing is picked
  }

  function renderProps(title, rows) {
    propsBody.innerHTML = "";
    propsTitle.textContent = title;
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
  let setPlanView = () => {};          // assigned once ceilings exist (POV opaque / plan transparent)
  let setActiveLevel = () => {};       // assigned once the level switcher is built (highlights the current level)
  const EYE = 1.63;                    // eye height for a 5'8" person (~1.63 m)
  const LOOK_DIST = 0.05;              // orbit radius indoors: ~0 so you spin in place
  const ROOM_INSET = 0.55;             // keep the standing point this far from walls (m)
  const ctrls = world.camera.controls;
  let inPov = false;                   // true while standing in a first-person POV
  const roomBoxes = [];                // { name, box } filled when POV views build
  const skipIds = new Set();           // door + opening ids to ignore when teleporting
  const floorIds = new Set();          // slab + floor-finish ids: the only teleport targets
  const extFloorIds = new Set();       // exterior slabs (lot / deck / porch / steps): walk targets
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
    ctrls.minDistance = LOOK_DIST;        // lock the orbit radius: you spin in place,
    ctrls.maxDistance = LOOK_DIST;        // and a zoom-out gesture exits to overview (below)
    ctrls.truckSpeed = 0;                 // no two-finger pan (would exit the room)
    setPlanView(false);                   // inside a room: opaque ceiling overhead
    inPov = true;
  }
  function overviewControls() {
    inPov = false;
    setPlanView(true);                    // see-through ceilings (dollhouse from above)
    ctrls.boundaryEnclosesCamera = false;
    ctrls.setBoundary(undefined);
    ctrls.azimuthRotateSpeed = 1;        // normal orbit
    ctrls.polarRotateSpeed = 1;
    ctrls.minPolarAngle = 0;             // free orbit
    ctrls.maxPolarAngle = Math.PI;
    ctrls.minDistance = 0;
    ctrls.maxDistance = Infinity;
    ctrls.truckSpeed = 2;
  }
  function exitToOverview() {
    overviewControls();
    framePlan(true);                      // return to the top-down plan view
  }
  // Pinch/scroll to zoom OUT while in a POV -> glide back to an orbital 3/4 view
  // of whichever model you were standing in (the natural "back out" gesture).
  const _tmp = new THREE.Vector3();
  function exitPov() {
    if (!inPov) return;
    overviewControls();                   // re-enable free orbit (clears inPov)
    const cam = world.camera.three.position;
    let best = null, bd = Infinity;       // the model the camera is currently over
    for (const v of modelViews) {
      const c = v.box.getCenter(_tmp);
      const d = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    frameModel(best ? best.box : viewBox, true);
    setActiveLevel(best ? best.id : null);   // keep the switcher in sync with the backed-out view
  }
  let pinch0 = 0;
  dom.addEventListener("wheel", (e) => { if (inPov && e.deltaY > 0) exitPov(); }, { passive: true });
  dom.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2)
      pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                          e.touches[0].clientY - e.touches[1].clientY);
  }, { passive: true });
  dom.addEventListener("touchmove", (e) => {
    if (!inPov || e.touches.length !== 2 || !pinch0) return;
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                         e.touches[0].clientY - e.touches[1].clientY);
    if (d < pinch0 - 40) { pinch0 = 0; exitPov(); }   // fingers pinched together = zoom out
  }, { passive: true });
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
    // Exterior walk targets: every exterior IfcSlab (lot, deck, porch, steps).
    // The house body / roofs are IfcBuildingElementProxy / IfcRoof, so they're
    // excluded and you can't climb a wall.
    if (exteriorModel) {
      // every exterior IfcSlab (lot, deck, porch, steps) is a walk target; the
      // house body / roofs are proxies / IfcRoof, so you can't climb a wall.
      const es = Object.values(await exteriorModel.getItemsOfCategories([/IFCSLAB/])).flat();
      for (const id of es) extFloorIds.add(id);
    }
  }

  // Index the rooms up front — before any tap can fire — so teleport clamping
  // is ready from the very first double-tap. Records each IfcSpace box, hides
  // the translucent space volumes, and excludes them from raycasting.
  {
    const ids = Object.values(await model.getItemsOfCategories([/IFCSPACE/])).flat();
    const boxes = await model.getBoxes(ids);
    const data = await model.getItemsData(ids, { attributesDefault: true });
    ids.forEach((id, i) => {
      roomBoxes.push({ id, name: String(data[i]?.Name?.value ?? "Room"), box: boxes[i].clone() });
    });
    await model.setVisible(ids, false);
    for (const id of ids) skipIds.add(id);
    await fragments.core.update(true);
  }

  // --- realistic hardwood floor (one instanced mesh; see wood-floor.js) ---
  await buildWoodFloor({ scene, model, fragments, floorY: FLOOR, baseUrl: BASE, manifestFile: groundManifests.floors + VER });
  await buildTileFloor({ scene, model, fragments, floorY: FLOOR, baseUrl: BASE, manifestFile: groundManifests.tiles + VER });

  // --- soft furniture as procedural meshes (see furniture.js) -------------
  const furniture = await buildFurniture({ scene, floorY: FLOOR + 0.02, baseUrl: BASE, manifestFile: groundManifests.furniture + VER });
  if (furniture?.doorMeshes) furnitureDoorMeshes.push(...furniture.doorMeshes);
  // Exterior fixtures (entry pendant lanterns) parent to the exterior model so
  // they inherit its offset; heights come per-item from the manifest.
  if (exteriorModel && exteriorLvl)
    await buildFurniture({ scene, parent: exteriorModel.object, floorY: 0, baseUrl: BASE, manifestFile: exteriorLvl.manifests.furniture + VER });

  // --- board-and-batten wall finish + baseboards (see wall-finish.js) -----
  await buildWallFinish({ scene, floorY: FLOOR, ceilingY: modelBox.max.y, baseUrl: BASE, manifestFile: groundManifests.paneling + VER });

  // --- ceilings (block the sun; opaque in POV, transparent in plan) -------
  const baseSetPlanView = buildCeilings({ scene, rooms: roomBoxes, ceilingY: modelBox.max.y, opening: furniture?.stairwellOpening }).setPlanView;
  // Also toggle the attic's sloped ceiling: opaque overhead in the first-person
  // POV (so you can see it), translucent in the dollhouse overview (so you can
  // see into the attic from outside/above).
  setPlanView = (plan) => {
    baseSetPlanView(plan);
    for (const mat of [...povCeilingMats, ...exhibitCeilingMats]) {
      mat.transparent = plan;
      mat.opacity = plan ? (mat.userData._planOpacity ?? 0.45) : 1.0;
      mat.depthWrite = !plan;
      mat.needsUpdate = true;
    }
  };
  window.__eureka.setPlanView = setPlanView;   // debug handle (headless render harness)
  window.__eureka.setHour = apply;             // debug handle: set time of day (0-24)
  window.__eureka.fixtures = fixtures;         // debug handle: interior light fixtures (scene control)
  window.__eureka.exhibits = exhibitModels;    // debug handle: [{lvl, model}] placed exhibits (render harness)

  // --- interior light fixtures: a semi-flush ceiling fixture (canopy + short stem
  // + glowing shade) with a downlight in EACH room, for sample lighting. The attic
  // has its own pendants; the ground floor is lit here and the second floor when
  // its exhibit streams in (it has no IfcSpaces, so it reuses the ground layout).
  const ceilHt = modelBox.max.y - FLOOR;               // floor-to-ceiling height
  const groundPos = model.object.position;
  const fxMetal = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.5, metalness: 0.6 });
  const fxShade = new THREE.MeshStandardMaterial({ color: 0xfff6e6, emissive: 0xffe7b8, emissiveIntensity: 1.2, roughness: 0.45 });
  const newCeilMat = () => new THREE.MeshStandardMaterial({ color: 0xf2efe9, roughness: 0.95, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  const semiFlush = (x, ceilY, z, intensity, level) => {
    const g = new THREE.Group(); g.position.set(x, ceilY, z);
    const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 16), fxMetal); canopy.position.y = -0.02; g.add(canopy);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8), fxMetal); stem.position.y = -0.09; g.add(stem);
    const shadeMat = fxShade.clone();                    // per-fixture so scenes can dim/kill its glow
    const shade = new THREE.Mesh(new THREE.SphereGeometry(0.12, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), shadeMat); shade.rotation.x = Math.PI; shade.position.y = -0.17; g.add(shade);
    const light = new THREE.PointLight(0xfff0db, intensity, 0, 2); light.position.y = -0.27; g.add(light);
    scene.add(g);
    registerFixture(light, level, shadeMat);
  };
  const roomCenters = roomBoxes.map((r) => ({ x: (r.box.min.x + r.box.max.x) / 2, z: (r.box.min.z + r.box.max.z) / 2,
                                              sx: r.box.max.x - r.box.min.x, sz: r.box.max.z - r.box.min.z }));
  for (const c of roomCenters) semiFlush(c.x, modelBox.max.y - 0.04, c.z, 3.0, "ground");   // ground floor: one per room

  // Opaque blockers (ceiling, walls, floor, furniture) cast shadow so the sun
  // can't pass through them; transparent glass does NOT cast, so windows let
  // daylight into the interior. (Run before toggling the ceiling transparent so
  // the ceiling is registered as a shadow caster.)
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;   // keep walls/geometry from popping out as you pan in a room
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.castShadow = !mats.some((m) => m && m.transparent && m.opacity < 0.95);
    o.receiveShadow = true;
  });
  const _sz = modelBox.getSize(new THREE.Vector3());
  focusShadow(modelBox.getCenter(new THREE.Vector3()), Math.max(_sz.x, _sz.z) * 0.6);
  setPlanView(true);   // the viewer opens in the overview

  // Stream in the remaining levels (Level 2, Attic) to the West — display-only
  // exhibits beside the ground floor. The exterior is already loaded + framed.
  for (const lvl of levelsCfg) {
    if (lvl.id === groundLevel.id || lvl.id === exteriorLvl?.id) continue;
    try { await placeExhibit(lvl, false); }
    catch (err) { console.warn(`exhibit ${lvl.id} failed`, err); }
  }
  {
    // Title each view with a flat label laid on the grid in FRONT of it (North =
    // world -Z), set well clear of the building and oriented to read upright from
    // the default 3/4 view (camera North of the house, looking South at its front).
    for (const v of labelViews) {
      const c = v.box.getCenter(new THREE.Vector3());
      const cnv = document.createElement("canvas");
      cnv.width = 1024; cnv.height = 192;
      const g = cnv.getContext("2d");
      // a light rounded "pill" so the title reads over the grid OR a dark wall cap
      const pad = 28, r = 60;
      g.fillStyle = "rgba(247,249,251,0.92)";
      g.beginPath();
      g.moveTo(pad + r, pad); g.arcTo(cnv.width - pad, pad, cnv.width - pad, cnv.height - pad, r);
      g.arcTo(cnv.width - pad, cnv.height - pad, pad, cnv.height - pad, r);
      g.arcTo(pad, cnv.height - pad, pad, pad, r); g.arcTo(pad, pad, cnv.width - pad, pad, r);
      g.closePath(); g.fill();
      g.fillStyle = "#1f2a37"; g.font = "bold 116px system-ui, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(v.label, cnv.width / 2, cnv.height / 2);
      const tex = new THREE.CanvasTexture(cnv);
      tex.anisotropy = 4; tex.colorSpace = THREE.SRGBColorSpace;
      const W = 4.0, H = W * cnv.height / cnv.width;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(W, H),
        // depth-tested (no special visibility): walls occlude it, so a title is
        // only seen when it's actually in view, never through the house.
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      mesh.position.set(c.x, 0.02, v.box.min.z - (H + 3.0));  // set well North (−Z), in front of the model
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(-1, 0, 0),   // text +X (right) -> world -X  (reads L->R from the front view)
        new THREE.Vector3(0, 0, 1),    // text +Y (up)    -> world +Z  (toward the house / screen up)
        new THREE.Vector3(0, 1, 0)));  // normal          -> world +Y  (laid flat on the grid)
      mesh.frustumCulled = false;
      mesh.updateMatrixWorld(true);
      scene.add(mesh);
      viewBox.expandByObject(mesh);   // keep the titles inside the framed row
    }

    viewBox.expandByScalar(1.0);   // headroom so the titles never touch the frame edge
    await fragments.core.update(true);
    refreshShadow();
  }

  // Glide the camera to a new pose by interpolating the eye + look-at point as
  // straight-line (Cartesian) points, snapping each frame. Because we never
  // interpolate the controls' azimuth ANGLE, there's no angle to wrap and thus
  // no long-way "flip" — the view just slides over. ~0.28s, eased.
  const _p0 = new THREE.Vector3(), _t0 = new THREE.Vector3();
  const _p1 = new THREE.Vector3(), _t1 = new THREE.Vector3();
  const _pp = new THREE.Vector3(), _tt = new THREE.Vector3();
  function glideTo(px, py, pz, tx, ty, tz, dur = 280) {
    ctrls.getPosition(_p0); ctrls.getTarget(_t0);
    _p1.set(px, py, pz); _t1.set(tx, ty, tz);
    const start = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / dur);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
        _pp.lerpVectors(_p0, _p1, e); _tt.lerpVectors(_t0, _t1, e);
        ctrls.setLookAt(_pp.x, _pp.y, _pp.z, _tt.x, _tt.y, _tt.z, false);
        if (k < 1) requestAnimationFrame(step); else resolve();
      };
      step();
    });
  }
  // Shared walk-the-model teleporter: double-tap a walkable surface in any
  // model to glide to an eye-height POV there (see pov.js). Indoors it clamps
  // to a safe spot inside the room (constant floor height); outdoors it stands
  // exactly where tapped (at the surface's own height — deck, lawn, steps).
  const walker = createWalker({
    camera: world.camera, glide: glideTo, clearSelection, onEnter: enterRoom,
    eye: EYE, lookDist: LOOK_DIST,
  });
  walker.register(model, (id) => floorIds.has(id),
    (hit) => { const { x, z } = clampToRoom(hit.point.x, hit.point.z); return { x, y: FLOOR + EYE, z }; });
  if (exteriorModel) walker.register(exteriorModel, (id) => extFloorIds.has(id),
    (hit) => ({ x: hit.point.x, y: hit.point.y + EYE, z: hit.point.z }));
  // Upper levels (Second Floor, Attic): double-tap their floor to stand there in
  // POV. Only the floor slabs are walkable, so the raycast steps past the roof /
  // ceiling / window glass ("blue boxes") — those stay in place but never block
  // the teleport. Stand exactly where tapped (the slab's own world height).
  for (const { lvl, model: em } of exhibitModels) {
    if (lvl.id === "exterior") continue;               // already registered above
    const fids = new Set(Object.values(await em.getItemsOfCategories([/IFCSLAB/])).flat());
    walker.register(em, (id) => fids.has(id),
      (hit) => ({ x: hit.point.x, y: hit.point.y + EYE, z: hit.point.z }));
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
  // Pick a procedural (furniture) door leaf — e.g. the attic bathroom doors.
  function pickFurnitureDoor(lx, ly) {
    if (!furnitureDoorMeshes.length) return null;
    _ndc.set((lx / dom.clientWidth) * 2 - 1, -(ly / dom.clientHeight) * 2 + 1);
    doorRaycaster.setFromCamera(_ndc, world.camera.three);
    const hits = doorRaycaster.intersectObjects(furnitureDoorMeshes, false);
    return hits.length ? hits[0].object.userData.fdoor : null;
  }
  // Pick an actionable chair (double-tap slides it in/out of the table).
  function pickChair(lx, ly) {
    const meshes = furniture?.chairMeshes;
    if (!meshes || !meshes.length) return null;
    _ndc.set((lx / dom.clientWidth) * 2 - 1, -(ly / dom.clientHeight) * 2 + 1);
    doorRaycaster.setFromCamera(_ndc, world.camera.three);
    const hits = doorRaycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object.userData.chair : null;
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
      if (door) { toggleDoor(door); return; }
      const fdoor = pickFurnitureDoor(lx, ly);
      if (fdoor) { fdoor.open = !fdoor.open; return; }
      const chair = pickChair(lx, ly);
      if (chair) { chair.toggle(); return; }
      await walker.teleport(lx, ly, pointer, dom);
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
    await selectAt(lx, ly);
  });

  // Click empty space (Esc) to clear.
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") clearSelection(); });

  // --- level views: a persistent switcher + a menu preset per model --------
  // Glide the orbit camera to a 3/4 view of a given level and mark it active.
  // Shared by the always-visible #level-switcher, the 📷 Camera views menu, and
  // the pinch/scroll "back out" gesture, so they all stay in sync.
  const focusLevel = async (id, transition = true) => {
    const mv = modelViews.find((v) => v.id === id);
    if (!mv) return;
    await clearSelection();
    overviewControls();
    frameModel(mv.box, transition);
    setActiveLevel(id);
  };

  // Persistent segmented control: one tab per model (levels.json order — Exterior,
  // Ground, Second Floor, Attic), short-labelled, current level highlighted. This
  // is the fast path for hopping between the level orbit views without digging
  // into a menu (which was painful, especially on the far-out exterior view).
  const switcherEl = document.getElementById("level-switcher");
  const SHORT = { exterior: "Lot", ground: "Ground", level2: "2nd", attic: "Attic" };
  setActiveLevel = (id) => {
    for (const b of switcherEl.querySelectorAll("[data-id]")) b.classList.toggle("active", b.dataset.id === id);
  };
  const makeTab = (id, label, title) => {
    const t = document.createElement("button");
    t.className = "level-tab"; t.dataset.id = id; t.title = title || label; t.textContent = label;
    t.addEventListener("click", () => focusLevel(id, true));
    return t;
  };
  const hasAlt = modelViews.some((v) => v.id === "exterior-alt");
  for (const lvl of levelsCfg) {
    const mv = modelViews.find((v) => v.id === lvl.id);
    if (!mv) continue;
    if (lvl.id === "exterior" && hasAlt) {
      // Lot slot gets an up/down toggle: the default exterior lot (top) and the
      // alternative lot (bottom), stacked within the left-to-right switcher.
      const col = document.createElement("div");
      col.className = "level-col";
      col.appendChild(makeTab("exterior", "Lot", "Default exterior lot"));
      col.appendChild(makeTab("exterior-alt", "Alt", "Alternative exterior lot (south)"));
      switcherEl.appendChild(col);
    } else {
      switcherEl.appendChild(makeTab(mv.id, SHORT[mv.id] || mv.label, mv.label));
    }
  }

  // 📷 Camera views menu: same presets, full labels (routes through focusLevel).
  const viewsEl = document.getElementById("views");
  const addView = (label, fn) => {
    const btn = document.createElement("button");
    btn.className = "view-btn";
    btn.textContent = label;
    btn.addEventListener("click", fn);
    viewsEl.appendChild(btn);
  };
  for (const lvl of levelsCfg) {
    const mv = modelViews.find((v) => v.id === lvl.id);
    if (!mv) continue;
    addView(mv.label, () => focusLevel(mv.id, true));
  }
  if (hasAlt) addView("Alternative Lot", () => focusLevel("exterior-alt", true));
  window.__eureka.focusLevel = focusLevel;     // debug handle: frame a level (render harness)
  window.__eureka.modelViews = modelViews;     // debug handle: [{id,label,box}] (render harness)

  // --- lighting scenes: presets that drive the sun (time of day) and the interior
  // light fixtures (on / off / dimmed) together, plus per-level fixture toggles.
  const scenesEl = document.getElementById("scenes");
  const addScene = (label, fn) => {
    const btn = document.createElement("button");
    btn.className = "view-btn";
    btn.textContent = label;
    btn.addEventListener("click", fn);
    scenesEl.appendChild(btn);
  };
  // Set every fixture on `level` ("all" = every level) to `factor`x its nominal
  // brightness (0 = off, 1 = full, ~0.5 = dimmed); the glowing shade tracks it too.
  const setFixtures = (level, factor) => {
    for (const f of fixtures) {
      if (level !== "all" && f.level !== level) continue;
      f.light.intensity = f.base * factor;
      f.light.visible = factor > 0;                 // fully drop dark fixtures (skip them in the shader)
      if (f.emiss) f.emiss.emissiveIntensity = f.emBase * factor;
    }
  };
  // Landscape lights (street lamp, side-yard string lights, facade uplights) live on
  // the exterior massing, tagged "exterior"; a warm window glow fakes "interior lights
  // on" from outside. Both start OFF for the daytime landing view.
  const setWindowGlow = (on) => {
    for (const m of extWindowMats) {
      m.emissive.setRGB(on ? 0.95 : 0, on ? 0.7 : 0, on ? 0.34 : 0);
      m.emissiveIntensity = on ? 1.5 : 1; m.needsUpdate = true;   // strong "lit from inside" warm glow
    }
  };
  if (exteriorModel) addLandscapeLighting(exteriorModel.object, (light, emiss) => registerFixture(light, "exterior", emiss));
  setFixtures("exterior", 0);

  // Morning: early sun, fixtures off (daylight). Evening: low sun, fixtures on but
  // dimmed for a warm glow. Night: sun down, landscape lights on + windows aglow.
  scenesEl.appendChild(caption("Time of day"));
  addScene("🌅 Morning", () => { apply(7.5); setFixtures("all", 0); setWindowGlow(false); });
  addScene("🌆 Evening", () => { apply(19.3); setFixtures("all", 0.6); setWindowGlow(false); });
  addScene("🌙 Night", () => { apply(21); setFixtures("all", 0.75); setFixtures("exterior", 1); setWindowGlow(true); });
  // Per-level fixture toggles (sun unchanged).
  for (const [label, id] of [["Ground floor", "ground"], ["Second floor", "level2"], ["Attic", "attic"]]) {
    scenesEl.appendChild(caption(label));
    addScene("On", () => setFixtures(id, 1));
    addScene("Off", () => setFixtures(id, 0));
  }
  scenesEl.appendChild(caption("Landscape"));
  addScene("On", () => { setFixtures("exterior", 1); setWindowGlow(true); });
  addScene("Off", () => { setFixtures("exterior", 0); setWindowGlow(false); });

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
      for (const d of await (await fetch(`${BASE}${groundManifests.doors}${VER}`)).json()) meta[d.name] = d;
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
      const unit = { open: true };               // doors default to open
      const mkLeaf = (hx, hz, leafW, dirSign, openAngle) => {
        const pivot = new THREE.Group();
        pivot.position.set(hx, bx.min.y, hz);
        pivot.rotation.y = openAngle;            // start in the open position
        const geo = alongX
          ? new THREE.BoxGeometry(leafW, sy, th)
          : new THREE.BoxGeometry(th, sy, leafW);
        const panel = new THREE.Mesh(geo, doorMat);
        if (alongX) panel.position.set(dirSign * leafW / 2, sy / 2, 0);
        else panel.position.set(0, sy / 2, dirSign * leafW / 2);
        pivot.add(panel);
        world.scene.three.add(pivot);
        const leaf = { pivot, openAngle, current: openAngle, unit, name: nm };
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

  // --- compass (see compass.js) -------------------------------------------
  setupCompass(world.camera.three, world.camera.controls);
}

main().catch((err) => {
  console.error(err);
  setStatus(`Error: ${err.message}`);
});
