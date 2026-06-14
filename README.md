# Eureka Residence — BIM Viewer

A web BIM viewer for the Eureka residence floor plan, built on
[That Open Engine](https://thatopen.com) (`@thatopen/*`, the open-source
toolkit on top of Three.js). The floor plan is authored as a real **IFC** model
and rendered as **Fragments** in the browser, with click-to-inspect element
properties.

This replaces the original hand-built Three.js scene (preserved under
[`legacy/`](legacy/)) with a proper BIM pipeline:

```
floorplan_spec.json ──(IfcOpenShell)──▶ floorplan.ifc ──(web-ifc)──▶ Fragments ──▶ 3D viewer
   (room geometry)      generate_ifc.py    (IFC4 model)   IfcLoader    in browser    That Open Engine
```

---

## Repository layout

| Path | What it is |
|------|------------|
| `index.html`, `src/main.js` | The That Open Engine viewer (Vite app). |
| `vite.config.js` | Vite config (relative `base` so it works on a Pages subpath). |
| `scripts/prepare-assets.mjs` | Copies runtime assets into `public/` before dev/build. |
| `ifc/floorplan_spec.json` | Room rectangles (wall centerlines, in feet), recovered from the original bundle. |
| `ifc/generate_ifc.py` | IfcOpenShell generator: spec → `floorplan.ifc`. |
| `ifc/floorplan.ifc` | The generated IFC4 BIM model (committed; CI does not need Python). |
| `.github/workflows/deploy.yml` | Builds and publishes the viewer to GitHub Pages. |
| `legacy/index.html` | The original Three.js floor plan, kept for reference. |

The model contains 11 walls (5½″ / 2×6 framing, 9′-6″ ceilings), 8 floor slabs,
8 spaces (Family, Kitchen, Sitting, Dining, Foyer, Vestibule, Extension, Porch),
7 doors and 6 windows — all as semantic IFC elements with `IfcOpeningElement`
voids.

---

## Run it locally

Requires **Node 20+**.

```bash
npm install
npm run dev      # http://localhost:5173  (copies assets, then starts Vite)
```

Build the static site (output in `dist/`):

```bash
npm run build
npm run preview  # serve the production build locally
```

`npm run build` runs `scripts/prepare-assets.mjs` first, which copies into
`public/` (and therefore into `dist/`):

- `ifc/floorplan.ifc` → `floorplan.ifc`
- `web-ifc/*.wasm` (from `node_modules/web-ifc`) — self-hosted WASM
- `worker.mjs` (from `@thatopen/fragments`) — self-hosted Fragments worker

> **No runtime CDN.** The web-ifc WASM and the Fragments worker are self-hosted,
> so the published page works without reaching out to unpkg at runtime.

---

## Regenerating the IFC model

Only needed if you change `ifc/floorplan_spec.json` (or the generator). Requires
**Python 3.10+**.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r ifc/requirements.txt
python ifc/generate_ifc.py        # rewrites ifc/floorplan.ifc
```

The script authors an IFC4 (metric) model with IfcOpenShell and prints an
element summary. Commit the regenerated `ifc/floorplan.ifc` so CI can serve it.

---

## Publishing to GitHub Pages

The site auto-deploys on every push to `main` via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**One-time setup** (in the GitHub repo):

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Push to `main` (or run the workflow manually: **Actions → Deploy BIM viewer
   → Run workflow**, which works from any branch for previews).

The workflow installs deps, runs `npm run build`, and deploys `dist/`. The
published URL appears in the workflow run summary — typically
`https://<user>.github.io/6506-eureka/`. The viewer uses a relative `base`, so
it works at that subpath without extra config.

> CI needs no Python (the IFC is committed) and no headless browser
> (`PUPPETEER_SKIP_DOWNLOAD` is set).

---

## Tech stack

- [`@thatopen/components`](https://github.com/ThatOpen/engine_components) `~3.4` — world, IfcLoader, FragmentsManager
- [`@thatopen/fragments`](https://github.com/ThatOpen/engine_fragments) `~3.4` — Fragments engine + worker
- [`web-ifc`](https://github.com/ThatOpen/engine_web-ifc) `0.0.77` — IFC parsing (WASM)
- [`three`](https://threejs.org) `0.182`, `camera-controls`
- [Vite](https://vite.dev) — dev server & bundler
- [IfcOpenShell](https://ifcopenshell.org) — IFC authoring (Python)
