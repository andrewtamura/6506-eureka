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
- Work on the branch the session is assigned — Claude Code pins one (`claude/<slug>`) and it
  is REUSED across merges, not cut fresh per change. commit → push → PR → squash-merge.
- **"PR and merge" is a standing instruction — just do it.** Do not plan it, propose it, or
  ask for approval first; the owner says this several times a session and the confirmation
  step is pure friction. The whole run is: open the PR against `main` (body from the commits
  already on the branch), squash-merge it with `expectedHeadSha` set to the FULL 40-char SHA
  from `git rev-parse HEAD` (never pad a short SHA — GitHub answers `409 Head branch was
  modified`, which looks like a race but is a fabricated SHA), re-point the branch per the
  next bullet, then clean up and reset per the bullet after it. Report the result, not the
  plan. Verify before merging only if the tree is dirty or checks have not been run on this
  exact commit — otherwise the work was already verified when it was committed.
- **Don't watch the deploy.** GitHub Pages fires on push to `main` and is rock solid; the
  owner will raise it if something breaks. Polling the workflow after a merge is noise —
  merge, clean up, and stop. (It also can't be confirmed properly from here anyway: the
  agent proxy blocks `github.io` with a 403 on the CONNECT tunnel, so the most a poll ever
  proves is that the workflow reported success.)
- **After a merge, reset for new work starting from `main`.** Delete the session's scratch
  artifacts — render PNGs, logs, one-off check harnesses, any `.scratch/` in the repo — and
  stop background dev servers, then re-point the branch at `origin/main` per the bullet
  below and confirm `git status` is clean. The next task starts from `main` with nothing
  left over. Note that this discards the scratchpad harnesses: they die with the container
  regardless, so anything worth keeping (e.g. a clearance check that took several passes to
  get right) has to be committed into the repo, not left in the scratchpad.
- **After a squash-merge, re-point the branch at the squash commit.** Commits left on it hold
  content that is already in `main` under a different SHA, so a later merge double-applies
  them — that hazard is why this step exists:
  ```
  git fetch origin
  git checkout -B <branch> origin/main
  git push -u origin <branch> --force-with-lease=<branch>:$(git rev-parse origin/<branch>)
  ```
  `checkout -B` moves only the LOCAL branch, so after the fetch `origin/<branch>` still points
  at the pre-merge commit — exactly the right lease value. Derive it like this rather than
  typing a SHA, or the lease is only as good as your memory of it.
- **Leave merged branches on the remote.** They are expected to pile up — that is fine and
  needs no cleanup, so don't treat it as outstanding work.
- **Don't run `git push origin --delete <branch>`** — GitHub blocks ref deletion for the
  credential these sessions use, returning `HTTP 403`. Both syntaxes fail (`--delete` and the
  `:<branch>` refspec); it is deletion specifically and not the branch (creating a ref with
  the same credential succeeds); and it is GitHub, not the agent proxy (`recentRelayFailures`
  stays empty, so don't go looking for an egress problem). `gh`/`hub` are not installed and
  the GitHub MCP server has no delete-branch tool. There is no route to it, and none needed.
- Regenerate IFC after `ifc/` changes: `/tmp/ifcvenv/bin/python ifc/generate_ifc.py`
  (IfcOpenShell venv). Then `npm run prepare-assets` — **not `npm run build`**. The dev
  server serves `src/` live, so a viewer-code edit needs no build step at all, and an
  `ifc/` edit needs only the manifest copy: 2.2 s against 14.4 s for the full Vite/PWA
  build. Chain them (`python ifc/generate_ifc.py && npm run prepare-assets`) rather than
  running three serial commands. `npm run build` is for shipping, not for iterating —
  but do remember one of the two, because the dev server reads `public/`, and skipping
  the copy has produced a stale-manifest false failure before.
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
- Verify changes headless (puppeteer with swiftshader) before merging. The kitchen and scullery have a
  committed harness — `node tools/kitchen-check.mjs` against a dev server on :5173 — which
  measures the BUILT MESHES rather than the manifest, and asserts the things that have
  actually gone wrong before: doorway approach zones, island aisles, cabinet module
  alignment, inset reveals, door widths. Extend it rather than starting a new one in the
  scratchpad, which is where it lived while being rebuilt from scratch three times.
- **Render with `node tools/shot.mjs <outdir> '[["name",[px,pz,ft],[px,pz,ft]]]'`** — views are
  plan feet plus a height above the floor. Two traps it already handles, both of which cost
  a wasted render each: take the floor datum from an item on THIS level (`SHOT_DATUM`, default
  `island`) or the camera lands outside the building, since the scene also holds the level-2
  and attic exhibits; and call `setPlanView(false)` for interiors, because the viewer opens in
  see-through-ceiling mode and would show straight through a ceiling or a skylight well.
  `waitUntil: 'networkidle2'` never fires — the viewer streams levels forever.
- **`?norender=1` holds frames off until the model is built.** The renderer runs in AUTO
  mode (a frame per update tick), and in HEADLESS software rendering every presented frame
  costs a synchronous GPU readback. Traced over a `?solo=ground` load: 99 animation frames,
  86 `GLES2::ReadPixels`, and **19.2 s of a 26 s load** blocked in
  `CommandBufferHelper::Finish` waiting on them. Both tools set the flag; it took the
  harness from 34 s to **20 s** and a render from 51 s to 34 s. Rendering resumes at the
  end of init, so screenshots are unaffected. It is a flag rather than the default because
  a real GPU presents without that readback — this is a headless cost, and a visitor
  should watch the model appear rather than stare at a blank canvas.
- **Panning cost is DRAW CALLS, and `src/consolidate.js` is what keeps it down.** The
  ground floor is authored as ~1750 separate little meshes (every stile, cove and
  baluster its own object, as the furniture rule requires), and three.js charges per
  OBJECT: 1857 draw calls a frame and ~20-26 ms inside `render()` before the GPU drew a
  pixel. A post-init pass merges the static millwork into one mesh per material and
  **hides** the originals — 333 calls, ~7 ms. Hiding rather than deleting is the whole
  trick: `Box3.expandByObject` and `Raycaster` both ignore `visible`, so
  `kitchen-check.mjs` still measures the authored parts and double-tap still picks
  doors, with no flag and no second code path. `tools/frame-check.mjs` guards it.
  Anything with a live transform (door pivots, sliding chairs) marks itself
  `userData.dynamic` and becomes its own merge anchor rather than being skipped.
  **A fragments model's own meshes are merged too** (`includeModels`), which is only
  possible because SELECTION HIGHLIGHTING WAS REMOVED — `model.highlight` recolours by
  giving an element its own material, and a merged copy would keep drawing the old
  colour. If highlighting ever comes back, this has to come out with it. Two things
  were checked first and are worth not re-deriving: the library does NOT touch its
  meshes after load (measured across hard panning, dollying and every level switch —
  1473 meshes, 366 visible, zero churn), and the `setVisible` calls that hide door and
  opening geometry all run during init, before the pass. Model-owned meshes group by
  material LOOK rather than material object (63 objects across 304 meshes are only 28
  distinct looks); OUR meshes deliberately do NOT, because several builders mutate a
  shared material in place — the ceilings' plan-view toggle, the lighting scenes — and
  collapsing two look-alikes would let such a change leak across.
  Tap-to-inspect still works: fragments raycasts against its own data, not the scene
  meshes. `frame-check` asserts that, because hiding them would otherwise have killed
  it silently.
  The pass runs a second time off `exhibitsReady` for the Second Floor and Attic —
  hung off it at the END of init, not where the promise is created: under `?solo` that
  promise resolves in 20 s, long before init finishes, and an earlier version merged
  the scene before the doors existed. Full scene: 879 draw calls down to 600.
- **The renderer runs ON DEMAND (`mode = 0`), not every tick.** It used to draw a frame
  per update tick forever — ~15 ms of CPU with nothing moving, which on a laptop means
  heat, then throttling, which makes everything feel sluggish including panning. Frames
  now come from `invalidate()`: the camera events, the two animation loops, the dials,
  new models, and any pointer/key event. Two deliberate safeguards, because the failure
  mode of missing a source is a viewer that looks FROZEN: a 500 ms heartbeat (so the
  worst case is a stale frame, not a dead one) and `?always=1` to force AUTO back. AUTO
  is kept during init on purpose — a visitor should watch the model appear.
- **Don't re-bake the shadow map when the camera stops.** `focusShadow` pins the shadow
  camera to the MODEL box, so panning cannot change the shadow — but `rest` used to fire
  `refreshShadow()` anyway, costing a whole extra scene pass into a 2048² map: **+5.1 ms,
  doubling the frame, at the exact moment you stop dragging**. It is gated on
  `levelsStreaming` now, since the `core.update` on that same listener CAN bring in new
  geometry while levels are still arriving. The dials still re-bake; they move the sun.
- **Exhibits stream on demand.** They cost ~130 s of solid CPU *after* the page is
  usable, competing with the panning the visitor is doing right then. The stream starts
  on the first click on an exhibit tab, or 20 s in, whichever comes first — the 20 s
  fallback is what keeps every existing tool working unchanged, since they just await
  `exhibitsReady`. `window.__eureka.loadExhibits()` starts it immediately.
- **`?perf=1` is the only way to see the GPU side.** The harness measures CPU exactly —
  `render()` is synchronous JS — and the GPU **not at all**: swiftshader queues fragment
  work and returns from `render()` before any of it runs, and it runs at
  `devicePixelRatio` 1 while a retina laptop runs at 2 with antialiasing (4x the pixels).
  So a fill-rate question CANNOT be answered from here; two measurements that said "no
  change" (1/16 the pixels, and 22 point lights switched off) are INCONCLUSIVE, not
  negative. `src/perf.js` puts fps, CPU ms, draw calls, triangles, programs, mesh and
  light counts, and the pixel ratio in the corner of the real browser, plus
  `EXT_disjoint_timer_query_webgl2` for true GPU ms where the machine offers it.
  `?dpr=<n>` overrides the pixel ratio so the fill-rate question is answered by looking.
  There is a **Performance HUD button** in the 6506 Eureka menu; `?perf=1` starts it
  open. It is built on FIRST use, because `setupPerf` wraps `renderer.render` to time
  it and an instrument nobody asked for should not sit in the hot path. Note the panel
  reports frames **drawn**, not animation-frame ticks — with render-on-demand the tick
  loop still runs at 60 Hz over a picture that is not moving, so counting ticks would
  report a confident and entirely fictional 60 fps.
- **On a phone there is NO GPU timer — benchmark instead.** Safari exposes no
  `EXT_disjoint_timer_query_webgl2`, so the HUD's `gpu` line reads `n/a` on the device
  the owner actually uses. The HUD's **benchmark** button is the answer: it forces the
  renderer to AUTO, spins the camera for 3 s, counts frames actually drawn and splits the
  frame into `cpu + other` — and achieved frame rate under continuous rendering includes
  GPU time by definition. It MUST restore the previous mode; leaving it in AUTO would
  silently undo render-on-demand, and `frame-check` asserts the restore (verified to fail
  when broken). Two A/Bs answer the open questions without a timer: `?dpr=1` against
  `?dpr=2` for fill rate, and the **dim other levels** button for lighting.
- **Every VISIBLE light is in every fragment shader, and the exhibits' fixtures count.**
  `applyFixture` sets `light.visible = factor > 0` precisely so dark fixtures drop out.
  With the exhibits loaded and lit, a phone reported **87 lights on** — the ground floor
  paying per-pixel for the Second Floor's and the Attic's fixtures. The HUD's lights
  control switches off every fixture not on the active level (49 → 25 locally) purely so
  the two benchmarks can be compared; it writes the lights directly and restores from a
  snapshot rather than going through `setFixtures`, so it cannot disturb that
  bookkeeping. Per-LEVEL culling is not the per-frame culling ruled out below: it is a
  rare, bucketed change costing one shader recompile on a level switch.
- **Fixture lighting is a RADIO: one model lit at a time.** The Lighting menu is one row
  per model (Auto / Lot / Ground / Second floor / Attic / All off) showing ● or ○, and
  `selectLighting` in `src/main.js` is the only way in — everything goes off, then
  exactly one thing comes on, so the buttons can never disagree with the scene. It is a
  RENDERING constraint as much as a UI one: every visible light is evaluated in every
  fragment shader, and the old default was "all of them" because `registerFixture` only
  dims a level some scene has already spoken for and nothing ever had — which is why a
  phone with the exhibits loaded reported 87 lights on. `selectLighting("auto")` is now
  called at init so the default is applied rather than merely displayed. `kitchen-check`
  drives the real control and counts what is lit per level.
- **Time-of-day presets live in the SUN menu (`#lighting`), not in Lighting (`#scenes`).**
  They move the sun, so they belong beside the dials; there are four (Morning, Afternoon,
  Evening, Night) and each also picks the lighting that goes with that hour. `SHOT_SCENE`
  in `tools/shot.mjs` searches BOTH containers for this reason — it looked only in
  `#scenes` and would silently have matched nothing. Note Night now lights the LOT only,
  so an interior night render needs `selectLighting('ground')` as well.
- **Breaking a cornice is NOT the same as a `tall` span.** `tallX` is subtracted from the
  baseboard, field, battens AND chair rail as well as the crown — right for a
  floor-to-ceiling built-in, wrong for a staircase, where the board-and-batten has to run
  on underneath. `corniceBreaks` (per side, plan-feet spans) suppresses the crown only and
  fills plain field from the head line to the ceiling, and `rakedCornice` sweeps the same
  crown profile up a slope beside the flight. Both are set in the room's
  `interior.paneling` and emitted per wall by `compute_paneling`.
  The foyer's numbers come from the BUILT stair, not from `stairLayout`'s
  eastOffset/northOffset signs, which are easy to get backwards: run 1 is against the
  EAST wall climbing south, run 2 against the WEST climbing north through the void, and
  run 2's soffit is `y = 7.94 + 0.769*(pz + 2.6)` ft, crossing the 8.28 ft crown top at
  pz -2.16. Measure the stair meshes rather than re-deriving this.
  One trap when asserting west-wall trim: filter on the member's px EXTENT (a west-wall
  run is only its ~5 in projection wide), or the SOUTH wall's crown — 11 ft of px ending
  at that very corner — is caught too and reports the level crown reaching pz -11.69.
- **A skylight is DAYLIGHT, not a lamp — and not a constant either.** Each scullery well
  carries a PointLight under its glazing, and both that light and the glazing's emissive
  are scaled by the sun's own `day` factor through `onTime` (`src/main.js`), so the well
  is lit at noon and exactly zero at midnight. Held constant, which is how it started,
  the wells glowed at 2 a.m. It is deliberately NOT registered as a fixture: the lamp
  scenes must not switch the sun off, and a skylight that went dark when you hit the
  lights would be wrong at noon. `kitchen-check` samples the time dial at 0 h and 12 h
  and asserts both ends — the two cannot both pass on a constant.
- **A skylight well's lining is positioned from the REAL ceiling, not its own height.**
  `ceilFt` is measured from the item's origin and placed furniture is lifted
  `FLOOR + 0.02`, so a lining drawn at `ceilFt` began 20 mm above the TOP of the 60 mm
  ceiling slab — and looking up the well you saw straight through that slot as a thin
  black line. `buildFurniture` passes `ceilingY` in; the lining starts 3 mm below the
  slab's underside and 3 mm INSIDE the opening (flush with the slab's cut edge the two
  faces are coplanar and z-fight). The harness measures it in world metres against the
  real ceiling, and that guard was confirmed to fail on the old geometry.
- **A phone is ~3.5x slower per draw call.** The device reported 304 calls in 22 ms
  (~72 us each) against ~20 us in this container. Scale any draw-call saving measured
  here up by about that much before deciding it is not worth doing.
- **`node tools/trace.mjs [--pan] [--full]`** is the committed version of the Chrome-trace
  recipe below. It kept getting rebuilt in the scratchpad.
- **Three things that look like the cause of sluggish panning and measurably are not** —
  all three were tried: `fragments.core.update(true)` on every camera `update` event
  (0.4 ms SYNCHRONOUS, so not it — which is the same lesson as the bullet above about
  not chasing `core.update`); material switching (deduplicating 275 materials to their
  129 distinct looks moved `render()` by 0.2 ms, and forcing ONE shared material made it
  *worse*); and per-frame light culling — switching off all 22 point lights moved the
  frame by 0.2 ms, and toggling a light's `visible` changes the light count in the
  shader and forces a PROGRAM RECOMPILE (18 → 29 programs), so it would trade a cost we
  do not have for a stutter we do not want. The other half of "sluggish" is not frame
  rate at all: `camera-controls` defaults to `draggingSmoothTime = 0.125`, so the camera
  trails the pointer by several frames.
- **How to find this class of problem: use a Chrome trace, not stacks or micro-benchmarks.**
  `page.tracing.start({ categories: ['devtools.timeline','gpu','toplevel'] })`, then sum
  `dur` by event name. Three cheaper instruments all pointed the wrong way first: a CPU
  profile blamed `(program)` (76%, which is just "native, not JS"); shrinking the viewport
  56x changed almost nothing (so not fill rate); and wrapping every WebGL call from the
  page measured 0.1 s (the readbacks are issued from fragments' worker on an OffscreenCanvas,
  invisible to a `HTMLCanvasElement.getContext` patch). Only the trace named `ReadPixels`.
- **Don't try to speed up fragments' `core.update` — avoid CALLING it.** Measured over a
  full load: 7 forced calls cost 48 s and 42 unforced ones cost 160 s, i.e. ~206 s of a
  290 s load is inside that one function, and the `force` flag barely matters because the
  pending queue gets processed either way. Only 6 of those 53 calls come from this repo;
  the rest are inside the library, so they cannot be thinned from outside. Two fixes that
  looked obvious and measured as *no change at all* — flipping the per-frame camera
  listener to unforced, and de-forcing the floor modules — were tried and reverted. The
  thing that worked was moving the work off the critical path (see the exhibits below).
- **`?solo=<level>` loads only that level.** The Second Floor and Attic sit beside the
  ground floor as display-only exhibits, and streaming them dominates load time: profiled
  cold, the ground floor is measurable at 21.8 s and everything else runs to 400 s. Both
  `tools/kitchen-check.mjs` and `tools/shot.mjs` use it, which is what took a full harness
  run from **344 s to 35 s**. Drop it (`CHECK_URL=http://localhost:5173/`) only when a
  change could affect the exhibits or the level switcher.
- **Exhibits stream in behind a finished page.** The Second Floor and Attic are
  display-only models parked beside the building, and building them takes minutes. The
  exhibit loop is deliberately NOT awaited: init finishes, the switcher gets a tab for
  every level, and `focusLevel` awaits `exhibitsReady` if you click one that has not
  arrived. Interactive at 52 s instead of 288 s. If you add anything that needs an
  exhibit's model at init time, hang it off `exhibitsReady` — the walker registration is
  the worked example.
- **Prebuilt fragments.** `scripts/build-fragments.mjs` runs the web-ifc conversion in Node
  at build time (0.7 s for the 1.3 MB exterior) and writes `public/<level>.frag`; the viewer
  fetches those and skips parsing. It is wired into `prepare-assets` and is incremental, so
  a no-op run costs ~1 s. Two things to keep in mind: `webIfcSettings.CIRCLE_SEGMENTS` there
  MUST match `ifcLoader.setup({ webIfc: ... })` in `src/main.js` or round furniture quietly
  goes coarse; and a missing `.frag` cannot be detected by `response.ok`, because a dev
  server's SPA fallback answers with index.html at status 200 — the loader checks the
  content-type instead, then falls back to parsing the IFC.
- **Iterate with `node tools/kitchen-check.mjs --from`.** A full run is ~5m45s, almost
  all of it booting Chromium and loading the ground model; the ~136 assertions after
  that are arithmetic on a cached JSON blob and replay in ~0.3 s. So measure once, then
  use `--from` for everything that does not move geometry — tuning a threshold, adding a
  `console.log` to find which mesh tripped a filter, checking a fix to the assertion
  itself. Half of all re-runs are that. Re-measure (plain `node tools/kitchen-check.mjs`)
  whenever a builder or a manifest actually changes, and always once before committing;
  `--from` prints a loud STALE banner naming any input newer than the measurement, so a
  cached pass can't be mistaken for a real one.
  **Never measure a member's SECTION from a bounding box.** `Box3.setFromObject` returns
  the box of the geometry's box after transform, so any mesh with a rotation of its own
  reports wider than it is — a 40 mm leg drawn as a 4-gon turned 45 deg measures 80 mm —
  and the item's own yaw inflates it again. This has now caught three assertions: the
  bentwood chair's "daintiness", the dining chair's raked back, and its leg section, the
  last of which nearly shipped a committed number twice the truth. VERTICAL extents are
  honest (yaw does not touch them); horizontal ones are an upper bound only. The harness
  records a per-mesh solid volume for exactly this — `meshes(item)[i].vol` — so a section
  is `sqrt(vol / length)` and a "how chunky" question is answered in volume.
  One trap when writing assertions: wall-finish meshes (the `loose` list) hang off `FLOOR`
  while placed items hang off `FLOOR + 0.02`, so a loose mesh reads **0.066 ft lower** than
  its authored height. The harness names this `LOOSE_DY`; a chair rail authored at 3.0 ft
  measures 2.934.
