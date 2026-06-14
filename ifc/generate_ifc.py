#!/usr/bin/env python3
"""Generate the Eureka residence IFC4 BIM model from per-room source files.

Structure (so working on one room only touches that room's file):
    model.json        global config + ordered room list
    rooms/<name>.json  one self-contained file per room: bounds, doors, windows,
                       and an optional `interior` block (see catalog.py)
    rooms/<name>.py    OPTIONAL hook exporting build(ctx, room) for bespoke
                       geometry that doesn't fit the declarative catalog
    builders.py        shared IFC primitives (walls, slabs, spaces, openings)
    catalog.py         interior-design item builders

Run:  python ifc/generate_ifc.py     ->  writes floorplan.ifc
"""

import os
import sys
import json
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # so `import builders` / `import catalog` work standalone

import ifcopenshell  # noqa: E402
from ifcopenshell.api import run  # noqa: E402
import builders as B  # noqa: E402
import catalog  # noqa: E402

ROOMS_DIR = os.path.join(HERE, "rooms")


def load_json(path):
    with open(path) as f:
        return json.load(f)


def run_hook(ctx, room):
    """If rooms/<stem>.py exists with build(ctx, room), run it for bespoke geometry."""
    hook = os.path.join(ROOMS_DIR, room["_stem"] + ".py")
    if not os.path.exists(hook):
        return
    spec = importlib.util.spec_from_file_location(room["_stem"] + "_hook", hook)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if hasattr(mod, "build"):
        mod.build(ctx, room)


def main():
    cfg = load_json(os.path.join(HERE, "model.json"))
    rooms = []
    for stem in cfg["rooms"]:
        r = load_json(os.path.join(ROOMS_DIR, stem + ".json"))
        r["_stem"] = stem
        rooms.append(r)

    # ---- file + units + contexts -------------------------------------------
    m = run("project.create_file", version="IFC4")
    project = run("root.create_entity", m, ifc_class="IfcProject", name=cfg["project"])
    units = [run("unit.add_si_unit", m, unit_type=t, prefix=None)
             for t in ("LENGTHUNIT", "AREAUNIT", "VOLUMEUNIT")]
    run("unit.assign_unit", m, units=units)
    mctx = run("context.add_context", m, context_type="Model")
    body = run("context.add_context", m, context_type="Model",
               context_identifier="Body", target_view="MODEL_VIEW", parent=mctx)

    # ---- spatial hierarchy --------------------------------------------------
    site = run("root.create_entity", m, ifc_class="IfcSite", name=cfg.get("site", "Site"))
    building = run("root.create_entity", m, ifc_class="IfcBuilding", name=cfg["building"])
    storey = run("root.create_entity", m, ifc_class="IfcBuildingStorey", name=cfg["storey"])
    run("aggregate.assign_object", m, products=[site], relating_object=project)
    run("aggregate.assign_object", m, products=[building], relating_object=site)
    run("aggregate.assign_object", m, products=[storey], relating_object=building)

    ctx = B.Ctx(m, body, storey, cfg)

    # ---- walls are global (shared edges merge); the rest is per-room --------
    B.build_walls(ctx, rooms)
    for r in rooms:
        B.add_slab(ctx, r)
        B.add_space(ctx, r)
        B.add_doors(ctx, r)
        B.add_windows(ctx, r)
        catalog.build_interior(ctx, r)
        run_hook(ctx, r)

    out = os.path.join(HERE, "floorplan.ifc")
    m.write(out)
    # Door hinge/swing manifest for the viewer's swinging-leaf overlays.
    with open(os.path.join(HERE, "doors.json"), "w") as f:
        json.dump(ctx.door_meta, f, indent=2)
    # Plank-floor manifest: the viewer re-renders these coverings as one
    # instanced mesh (name = which covering, rgb = plank colour).
    with open(os.path.join(HERE, "floors.json"), "w") as f:
        json.dump(ctx.plank_floors, f, indent=2)

    def n(cls):
        return len(m.by_type(cls))
    print(f"Wrote {out}")
    for cls in ("IfcWall", "IfcSlab", "IfcSpace", "IfcDoor", "IfcWindow",
                "IfcOpeningElement", "IfcFurniture", "IfcCovering", "IfcLightFixture"):
        if n(cls):
            print(f"  {cls:<18}: {n(cls)}")


if __name__ == "__main__":
    main()
