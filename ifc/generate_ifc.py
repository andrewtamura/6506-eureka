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


def compute_paneling(ctx, rooms):
    """For rooms whose `interior.paneling` is set, emit the wall data the viewer
    needs to build a full trim program: wall extent + door/window openings (found
    across all rooms on the shared wall lines). Heads are uniform (ctx.head_ft)."""
    half = ctx.T / B.FT / 2  # half wall thickness, in plan feet
    for room in rooms:
        if not (room.get("interior") or {}).get("paneling"):
            continue
        b = room["bounds"]
        x1, x2 = sorted([b["x1"], b["x2"]])
        z1, z2 = sorted([b["z1"], b["z2"]])

        def gather(orient, fixed):
            doors, wins, tall = [], [], []
            for r in rooms:
                for d in r.get("doors", []):
                    if d["orient"] == orient and abs(d["fixed"] - fixed) < 0.3:
                        w = abs(d["width"]); span = [round(d["pos"] - w / 2, 3), round(d["pos"] + w / 2, 3)]
                        # full-height built-in openings (a taller head) break the
                        # cornice rather than seating it on the head line.
                        (tall.append(span + [d["headFt"]]) if d.get("headFt") else doors.append(span))
                for wd in r.get("windows", []):
                    if wd["orient"] == orient and abs(wd["fixed"] - fixed) < 0.3:
                        w = abs(wd["width"])
                        wins.append([round(wd["pos"] - w / 2, 3), round(wd["pos"] + w / 2, 3), wd["sill"]])
            return doors, wins, tall

        for orient, fixed, lo, hi, face, normal in [
            ("H", z1, x1, x2, z1 + half, [0, 1]),
            ("H", z2, x1, x2, z2 - half, [0, -1]),
            ("V", x1, z1, z2, x1 + half, [1, 0]),
            ("V", x2, z1, z2, x2 - half, [-1, 0]),
        ]:
            doors, wins, tall = gather(orient, fixed)
            ctx.paneling.append({
                "along": "x" if orient == "H" else "z",
                "at": round(face, 4), "normal": normal,
                "lo": round(lo, 3), "hi": round(hi, 3),
                "doors": doors, "windows": wins, "tall": tall,
            })


def emit_stairwells(ctx, rooms, up=True, wall_top=None, roof=None):
    """Re-emit each room's staircase as a viewer "stairwell2" item so an upper
    level can draw the run arriving + its enclosure, in sync with the stair below.
    `up`=False omits the flight continuing to the next level (top of the run);
    `wall_top` overrides the enclosing-wall height; `roof` (footprint + eave +
    pitch) makes the enclosure walls follow the sloped ceiling up to the roofline."""
    for r in rooms:
        for it in (r.get("interior") or {}).get("furniture", []):
            if it.get("type") != "staircase":
                continue
            rec = {k: v for k, v in it.items() if k != "at"}
            rec.update(type="stairwell2", px=it["at"][0], pz=it["at"][1], up=up)
            if wall_top is not None:
                rec["wallTop"] = wall_top
            if roof is not None:
                rec["roof"] = roof
            if r.get("floorOpening"):
                rec["opening"] = r["floorOpening"]
            ctx.furniture.append(rec)


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


def new_file(cfg, storey_name):
    """A fresh IFC file with units, model context, and a minimal spatial tree."""
    m = run("project.create_file", version="IFC4")
    project = run("root.create_entity", m, ifc_class="IfcProject", name=cfg["project"])
    units = [run("unit.add_si_unit", m, unit_type=t, prefix=None)
             for t in ("LENGTHUNIT", "AREAUNIT", "VOLUMEUNIT")]
    run("unit.assign_unit", m, units=units)
    mctx = run("context.add_context", m, context_type="Model")
    body = run("context.add_context", m, context_type="Model",
               context_identifier="Body", target_view="MODEL_VIEW", parent=mctx)
    site = run("root.create_entity", m, ifc_class="IfcSite", name=cfg.get("site", "Site"))
    building = run("root.create_entity", m, ifc_class="IfcBuilding", name=cfg["building"])
    storey = run("root.create_entity", m, ifc_class="IfcBuildingStorey", name=storey_name)
    run("aggregate.assign_object", m, products=[site], relating_object=project)
    run("aggregate.assign_object", m, products=[building], relating_object=site)
    run("aggregate.assign_object", m, products=[storey], relating_object=building)
    return m, body, storey


def build_level(cfg, rooms_cache, level):
    """Build one level into its own IFC + manifests. Returns the viewer index
    entry. `kind` is: full (walls + slabs + spaces + openings + interior),
    shell (exterior perimeter walls + slabs only), exterior (lot + massing), or
    attic (floor + knee walls + a sloped ceiling that follows the roof)."""
    lid, kind = level["id"], level["kind"]
    m, body, storey = new_file(cfg, level.get("storey", lid))
    ctx = B.Ctx(m, body, storey, cfg)
    rooms = [rooms_cache[s] for s in level.get("rooms", [])]

    if kind == "full":
        B.build_walls(ctx, rooms)
        for r in rooms:
            B.add_slab(ctx, r)
            B.add_space(ctx, r)
            B.add_doors(ctx, r)
            B.add_windows(ctx, r)
            catalog.build_interior(ctx, r)
            run_hook(ctx, r)
        compute_paneling(ctx, rooms)
    elif kind == "shell":
        B.add_shell(ctx, rooms)
        if level.get("upperWindows"):     # second-floor windows, synced to the exterior
            B.add_shell_windows(ctx, rooms)
        emit_stairwells(ctx, rooms, up=True)              # 2nd-floor hall: run up to the attic
    elif kind == "attic":
        # Habitable attic: shaped to the exterior roof (single source of truth
        # for type + pitch) rather than drawn as a full-height storey.
        ref = level["roofRef"]
        src = next(l for l in cfg["levels"] if l["id"] == ref["from"])
        g = src["roofGroups"][ref["group"]]
        B.add_attic(ctx, rooms, {"type": g.get("type", "hip"),
                                 "pitch": g.get("pitch", 0.5),
                                 "kneeFt": level.get("kneeFt", 4.0),
                                 "eaveWallFt": g.get("eaveWallFt", 0.0),
                                 "dormers": g.get("dormers"),
                                 "shedDormer": g.get("shedDormer")})
        # top of the stair: enclose Leg 4 with walls that rise to the hip-roof
        # underside (same footprint + pitch the attic ceiling is built from).
        fpx = [v for r in rooms for v in (r["bounds"]["x1"], r["bounds"]["x2"])]
        fpz = [v for r in rooms for v in (r["bounds"]["z1"], r["bounds"]["z2"])]
        emit_stairwells(ctx, rooms, up=False, roof={
            "footprint": {"x1": min(fpx), "x2": max(fpx), "z1": min(fpz), "z2": max(fpz)},
            "eaveFt": g.get("eaveWallFt", 0.0), "pitch": g.get("pitch", 0.5)})
    elif kind == "exterior":
        B.add_lot(ctx, cfg["lot"], rooms)
        # Solid massing blocks (per building part, at their storey heights) +
        # roofs — closed, so the interior is never visible from any angle. A
        # crawlspace band raises the whole thing off grade.
        crawl = level.get("crawlspaceFt", 0) * B.FT
        B.add_massing(ctx, level["roofGroups"], rooms_cache, crawl)
        B.add_fenestration(ctx, level["roofGroups"], rooms_cache, crawl)
        B.add_deck(ctx, cfg["lot"], rooms_cache, crawl)
        B.add_lot_wall(ctx, cfg["lot"], rooms_cache, crawl)
        B.add_picket_fence(ctx, cfg["lot"], rooms_cache)

    ifc_name = f"{lid}.ifc"
    m.write(os.path.join(HERE, ifc_name))
    names = {k: f"{lid}.{k}.json" for k in ("doors", "floors", "tiles", "furniture", "paneling")}
    dump = lambda k, data: json.dump(data, open(os.path.join(HERE, names[k]), "w"), indent=2)
    dump("doors", ctx.door_meta)
    dump("floors", ctx.plank_floors)
    dump("tiles", ctx.tile_floors)
    dump("furniture", {"ft": B.FT, "xs": ctx.xs, "zs": ctx.zs, "items": ctx.furniture})
    dump("paneling", {"ft": B.FT, "xs": ctx.xs, "zs": ctx.zs, "baseboardFt": 10 / 12,
                      "headFt": ctx.head_ft, "entablatureFt": 0.9, "casingFt": 0.33, "walls": ctx.paneling})

    counts = {c: len(m.by_type(c)) for c in ("IfcWall", "IfcSlab", "IfcSpace", "IfcDoor", "IfcWindow", "IfcCovering", "IfcFurniture")}
    print(f"  {lid:<9} ({kind}) -> {ifc_name}: " + ", ".join(f"{c[3:]}={n}" for c, n in counts.items() if n))
    return {"id": lid, "storey": level.get("storey", lid), "kind": kind,
            "label": level.get("label", level.get("storey", lid)),
            "ifc": ifc_name, "manifests": names}


def main():
    cfg = load_json(os.path.join(HERE, "model.json"))
    # Load every room referenced by any level once.
    stems = {s for lvl in cfg["levels"] for s in lvl.get("rooms", [])}
    rooms_cache = {}
    for stem in stems:
        r = load_json(os.path.join(ROOMS_DIR, stem + ".json"))
        r["_stem"] = stem
        rooms_cache[stem] = r

    print("Generating levels:")
    index = [build_level(cfg, rooms_cache, lvl) for lvl in cfg["levels"]]
    with open(os.path.join(HERE, "levels.json"), "w") as f:
        json.dump({"levels": index}, f, indent=2)
    print(f"Wrote levels.json ({len(index)} levels)")


if __name__ == "__main__":
    main()
