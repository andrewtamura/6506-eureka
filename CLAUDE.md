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
  One trap when writing assertions: wall-finish meshes (the `loose` list) hang off `FLOOR`
  while placed items hang off `FLOOR + 0.02`, so a loose mesh reads **0.066 ft lower** than
  its authored height. The harness names this `LOOSE_DY`; a chair rail authored at 3.0 ft
  measures 2.934.
