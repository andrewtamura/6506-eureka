# 6506 Eureka — project conventions

A web BIM viewer for the Eureka residence: an IFC model (authored with
IfcOpenShell in `ifc/`) rendered as Fragments by a That Open Engine viewer
(`src/`), deployed to GitHub Pages.

## Interior design elements → procedural three.js meshes (IMPORTANT)

**Always model furniture and interior-design elements as procedural three.js
meshes in the viewer — never as IFC box/cylinder proxies.** This includes:

- furniture (chairs, tables, sofas, beds, dressers, nightstands, rugs, …)
- built-in cabinetry (kitchen/bath cabinets, shelving, vanities)
- trim & molding (baseboards, crown, casing, wainscot)
- fixtures (lighting, plumbing fixtures, hardware)

Why: IFC's box/cylinder primitives can't represent rounded cushions, curved
backs, tapered/splayed legs, profiled molding, etc. — they read as crude blocks.
Procedural three.js geometry (`RoundedBoxGeometry`, `CylinderGeometry`,
`ExtrudeGeometry`, `LatheGeometry`, tapered/curved forms) gives a realistic look
while staying **lightweight (no model files) and scale-accurate** (authored in
real feet/metres). Model each piece from its actual construction (e.g. a chair =
tapered splayed legs → seat apron → cushion → raked back anchored to the seat),
not as floating slabs.

### How it's wired
- Build meshes in `src/furniture.js` (one builder function per `type`).
- The generator records placements to a manifest (`ifc/furniture.json`, carrying
  the plan→world mapping) for the soft `type`s in `catalog.VIEWER_TYPES` and
  **skips their IFC geometry**; `prepare-assets.mjs` copies the manifest to
  `public/`; the viewer (`buildFurniture`) places the meshes.
- Adding a piece = a builder in `furniture.js` + a `VIEWER_TYPES` entry + one
  line in a room's `ifc/rooms/<room>.json` `interior` block.

### Keep in the IFC/BIM model (NOT meshes)
Structure stays authored as IFC: walls, slabs, spaces, doors, windows, and their
openings. The viewer also renders the hardwood floor as an instanced mesh for
performance (`src/wood-floor.js`), driven by `ifc/floors.json`.

## Workflow
- Develop on a fresh branch cut from `main`; commit → push → PR → squash-merge;
  delete the branch after merge (avoids squash-rebase conflicts).
- Regenerate IFC after `ifc/` changes: `/tmp/ifcvenv/bin/python ifc/generate_ifc.py`
  (IfcOpenShell venv). Then `npm run build`.
- **Regenerating is destructive — restore what you didn't mean to change.** Some
  manifests are hand-authored and the generator does NOT reproduce them: notably
  `ifc/level2.furniture.json`, which a plain regen rewrites to near-empty, wiping all
  ~40 second-floor items (beds, vanities, showers, closets, partitions). The generator
  also rewrites all four `.ifc` files unconditionally, so the three you didn't touch
  churn on timestamps/GUIDs/entity order alone. Regenerate, then restore everything
  except the level(s) you actually changed, e.g. for an exterior-only change:
  ```
  /tmp/ifcvenv/bin/python ifc/generate_ifc.py
  git checkout -- ifc/attic.ifc ifc/ground.ifc ifc/level2.ifc ifc/level2.furniture.json
  ```
  Always check `git status` after a regen and confirm the diff is only what you intended.
- Verify changes headless (puppeteer with swiftshader) before merging.
