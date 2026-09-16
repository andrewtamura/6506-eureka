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

        def gather(orient, fixed, lo, hi):
            # Openings are collected from EVERY room sharing this wall line, then clipped
            # to THIS segment. Without the clip a long wall split between two rooms gives
            # both records the full opening list, so the viewer draws every casing, stool
            # and apron twice, co-located, and subtract() emits field spans running past
            # the end of the wall into the neighbour.
            def inside(a, b):
                return min(b, hi) - max(a, lo) > 0.05
            doors, wins, tall, trans, sides, bare, rounds = [], [], [], [], [], [], []
            for r in rooms:
                for d in r.get("doors", []):
                    if d["orient"] == orient and abs(d["fixed"] - fixed) < 0.3:
                        w = abs(d["width"]); span = [round(d["pos"] - w / 2, 3), round(d["pos"] + w / 2, 3)]
                        if not inside(*span):
                            continue
                        # full-height built-in openings (a taller head) break the
                        # cornice rather than seating it on the head line.
                        (tall.append(span + [d["headFt"]]) if d.get("headFt") else doors.append(span))
                        # A door set in a STEEL SCREEN is framed by the screen's own
                        # mullions. The painted 4 in architrave would sit on top of slim
                        # dark sections and wreck the whole point of them.
                        if d.get("noCasing"):
                            bare.append(span)
                for wd in r.get("windows", []):
                    if wd.get("blind"):
                        continue   # no opening inside, so no interior casing/stool/apron
                    if wd.get("round"):
                        # A ROUND window has no span for the rectangular program — no
                        # sill, no stool, no apron. The viewer cuts the field round it
                        # and rings it with the casing profile: [pos, centre, radius].
                        if wd["orient"] == orient and abs(wd["fixed"] - fixed) < 0.3:
                            rr = wd.get("radiusFt", 1.0)
                            if inside(wd["pos"] - rr, wd["pos"] + rr):
                                rounds.append([wd["pos"], wd["centerFt"], rr])
                        continue
                    if wd.get("sidelight") or wd.get("bare"):
                        # Same deal as a transom, one band lower: its own frame, no
                        # casing/stool/apron, but still a hole the field must be cut
                        # around — this one in the band BELOW the head line.
                        # `bare` is the same record with NO frame either: a window inside
                        # a tiled shower gets a tiled reveal, not wood casing, a stool and
                        # an apron poking through the tile.
                        if wd["orient"] == orient and abs(wd["fixed"] - fixed) < 0.3:
                            sw = abs(wd["width"])
                            sspan = [round(wd["pos"] - sw / 2, 3), round(wd["pos"] + sw / 2, 3)]
                            if inside(*sspan):
                                # the sill too: a sidelight glazed to the FLOOR must not
                                # have a baseboard run across it, and one with a raised
                                # sill still should.
                                # ...and the HEAD: a bare opening can rise past the head
                                # line (the shower's transom does), and the band above
                                # that line has to be cut round it too.
                                sides.append(sspan + [wd["sill"], wd["head"] if (wd.get("transom") or wd.get("bare")) else ctx.head_ft])
                        continue
                    if wd.get("transom"):
                        # A transom carries its own frame (add_transom_frame) and sits on
                        # a door head, so the window program would both double the casing
                        # and hang a stool and apron off it — which no transom has. It
                        # still has to be SUBTRACTED from the field above the head line,
                        # though: dropping it entirely got the glass plastered over.
                        if wd["orient"] == orient and abs(wd["fixed"] - fixed) < 0.3:
                            tw = abs(wd["width"])
                            tspan = [round(wd["pos"] - tw / 2, 3), round(wd["pos"] + tw / 2, 3)]
                            if inside(*tspan):
                                # sill and head both: a transom that dips BELOW the head
                                # line (the laundry's, 6.5..7.75) has to be cut out of the
                                # field under that line as well as the band over it.
                                trans.append(tspan + [wd["sill"], wd["head"]])
                        continue
                    if wd["orient"] == orient and abs(wd["fixed"] - fixed) < 0.3:
                        w = abs(wd["width"])
                        span = [round(wd["pos"] - w / 2, 3), round(wd["pos"] + w / 2, 3)]
                        if not inside(*span):
                            continue
                        # `plainBelow` drops the apron under this window, leaving plain
                        # board-and-batten wall below the stool. Wanted where a window
                        # sits over open floor rather than over a counter, since a 2 ft 8 in
                        # board floating 25 in off the floor reads as a stray panel.
                        # ...and the HEAD, for a window that stops BELOW the head line: the
                        # casing program assumed every window heads on that line, and
                        # framed a blank panel of wall over the glass of one that did not
                        # (the second floor's south transoms head at 6.10 under a 7 ft
                        # line). Authored heads above the line are the line, as
                        # add_windows cuts them, unless the window is a transom.
                        hd = wd["head"] if (wd.get("transom") or wd["head"] < ctx.head_ft - 1e-6) else ctx.head_ft
                        wins.append(span + [wd["sill"], bool(wd.get("plainBelow")), hd])
            return doors, wins, tall, trans, sides, bare, rounds

        # plan px increases WEST and pz increases NORTH, so x1 is the EAST wall and
        # z1 the SOUTH one. `noCornice` names the sides where the entablature is
        # suppressed — a room can carry the trim program without carrying the crown
        # on every wall.
        pan = room["interior"]["paneling"]
        # `noCornice` is either True for the whole room or a list of sides.
        nc = pan.get("noCornice")
        all_sides = nc is True
        no_cornice = set() if all_sides else {sd.upper() for sd in (nc or [])}
        no_battens = pan.get("battens") is False
        # `noBattens` is the PER-SIDE form, shaped like `noCornice` / `wainscot` /
        # `coved`: True for the room, or a list of sides. Named this way rather than
        # letting `battens` take a list, because `battens: ["N"]` reads as "battens ON
        # the north wall" — the opposite of what it would mean. `battens: false` is
        # untouched, so the rooms already using it are unaffected.
        nb = pan.get("noBattens")
        all_nb = nb is True
        nb_sides = set() if all_nb else {sd.upper() for sd in (nb or [])}
        # `wainscot` follows the same shape as `noCornice`: True for the whole room,
        # or a list of sides. A dado is normally a per-wall decision.
        ws = pan.get("wainscot")
        all_ws = ws is True
        wainscot = set() if all_ws else {sd.upper() for sd in (ws or [])}
        # `corniceBreaks` suppresses the CROWN ONLY over named spans of a side, in plan
        # feet: {"W": [[-11.92, -2.16]]}. The existing way to break a cornice is a `tall`
        # span, but tallX is subtracted from the baseboard, field, battens AND chair rail
        # too — right for a floor-to-ceiling built-in, wrong for a staircase, where the
        # board-and-batten has to run on underneath. Plain field fills from the head line
        # to the ceiling over the break, exactly as a `noCornice` wall does.
        breaks = pan.get("corniceBreaks") or {}
        # `rakedCornice` is the other half of the same detail: where a stair soffit cuts
        # across, the crown returns and climbs the rake. Per side, a list of
        # {pz0,y0,pz1,y1} (or px0/px1 on an N/S wall) in plan feet.
        raked = pan.get("rakedCornice") or {}
        # `coved` turns on the coved ceiling. It is IMPLIED by a cornice (the crown
        # springs it), so this only has to be set for a room with `noCornice` that is
        # coved anyway — the sitting and family rooms.
        cv = pan.get("coved")
        all_cv = cv is True
        coved = set() if all_cv else {sd.upper() for sd in (cv or [])}
        for orient, fixed, lo, hi, face, normal, side in [
            ("H", z1, x1, x2, z1 + half, [0, 1], "S"),
            ("H", z2, x1, x2, z2 - half, [0, -1], "N"),
            ("V", x1, z1, z2, x1 + half, [1, 0], "E"),
            ("V", x2, z1, z2, x2 - half, [-1, 0], "W"),
        ]:
            doors, wins, tall, trans, sides, bare, rounds = gather(orient, fixed, lo, hi)
            ctx.paneling.append({
                "along": "x" if orient == "H" else "z",
                "at": round(face, 4), "normal": normal, "side": side,
                "lo": round(lo, 3), "hi": round(hi, 3),
                "doors": doors, "windows": wins, "tall": tall, "transoms": trans,
                "sidelights": sides, "bareDoors": bare, "rounds": rounds,
                "noCornice": all_sides or side in no_cornice,
                "noBattens": no_battens or all_nb or side in nb_sides,
                "wainscot": all_ws or side in wainscot,
                # The chair rail's height, when the wall carries a wainscot. wall-finish has
                # read this per wall all along and NOTHING has ever set it, so every wainscot
                # in the house has quietly taken its 3.0 default — fine for the scullery, wrong
                # for a bathroom where the rail is meant to land on the countertop.
                "chairRailFt": pan.get("chairRailFt"),
                "coved": not (all_sides or side in no_cornice) or all_cv or side in coved,
                "corniceBreaks": [[round(a, 3), round(b, 3)] for a, b in breaks.get(side, [])],
                "rakedCornice": raked.get(side, []),
            })

        # EXTRA WALLS: faces the four-sided derivation cannot see, because they belong to
        # something the VIEWER builds — the under-stair box, whose north face and short
        # east return both want the crown. Same record shape, with no openings, so
        # wall-finish treats them like any other wall and needs no change.
        for ew in pan.get("extraWalls", []):
            ctx.paneling.append({
                "along": ew["along"], "at": round(ew["at"], 4),
                "normal": ew["normal"], "side": ew.get("side", "X"),
                "lo": round(min(ew["lo"], ew["hi"]), 3),
                "hi": round(max(ew["lo"], ew["hi"]), 3),
                # An opening in a wall the VIEWER builds still wants the trim program's
                # casing, baseboard break and field break, which all key off `doors` —
                # so the span is authored here in plan feet and the viewer cuts the
                # matching hole. ifc_check asserts the two agree; nothing else would.
                "doors": [[round(min(d), 3), round(max(d), 3)] for d in ew.get("doors", [])],
                "windows": [], "tall": [], "transoms": [],
                "sidelights": [], "bareDoors": [],
                "noCornice": bool(ew.get("noCornice", False)),
                "noBattens": bool(ew.get("noBattens", True)),
                "wainscot": bool(ew.get("wainscot", False)),
                "chairRailFt": ew.get("chairRailFt", pan.get("chairRailFt")),
                "coved": bool(ew.get("coved", True)),
                # an OUTSIDE corner at that end: the run reaches past the wall line by
                # its own projection and the crown is mitred to turn.
                "mitreLo": bool(ew.get("mitreLo", False)),
                "mitreHi": bool(ew.get("mitreHi", False)),
                # a MITRED RETURN at that end: nothing carries the profile on, so the
                # crown is mitred on the spot and a wedge turns it back into the wall.
                "returnLo": bool(ew.get("returnLo", False)),
                "returnHi": bool(ew.get("returnHi", False)),
                "corniceBreaks": [], "rakedCornice": [],
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
            # `slab: false` for a room carved out of another one — the under-stair
            # powder room sits inside the foyer, which already has the slab under it,
            # and a second one there is two coplanar boxes fighting over the underside.
            if r.get("slab", True):
                B.add_slab(ctx, r)
            B.add_space(ctx, r)
            B.add_doors(ctx, r)
            B.add_windows(ctx, r)
            catalog.build_interior(ctx, r)
            run_hook(ctx, r)
        compute_paneling(ctx, rooms)
    elif kind == "shell":
        # A SLOPED CEILING under a shed roof group (model.json `slopedCeiling`): the wing's
        # second floor has no flat ceiling, its plaster is the roof's underside, 8 ft at
        # the east eave rising 1:12 to the primary. The plane is derived from the roof
        # group (one formula with the massing), the wing's perimeter walls are raked to
        # it, an IfcCovering is laid on it, and the trim program is told where it is.
        sloped = level.get("slopedCeiling")
        rake = None
        if sloped:
            sgrp = None
            for lv in cfg["levels"]:
                sgrp = (lv.get("roofGroups") or {}).get(sloped["group"]) or sgrp
            rake = B.shed_ceiling(ctx, sgrp, rooms_cache)
        B.add_shell(ctx, rooms, rake=rake)
        if level.get("upperWindows"):     # second-floor windows, synced to the exterior
            B.add_shell_windows(ctx, rooms)
        if rake:
            B.add_wing_ceiling(ctx, *rake)
        emit_stairwells(ctx, rooms, up=True)              # 2nd-floor hall: run up to the attic
        # Per-level floor override: rooms not listed get hardwood (like the ground
        # floor); listed rooms get tile so the primary en-suite runs one continuous
        # pattern across its shared footprint rooms without touching the ground floor.
        overrides = level.get("floorOverrides") or {}
        for r in rooms:
            ov = overrides.get(r["_stem"])
            if ov and (ov.get("material") or "").lower() == "tile":
                B.add_tile_finish(ctx, r, ov["pattern"])
            else:
                B.add_hardwood_finish(ctx, r)             # hardwood floor, same as the ground floor
        # A SHELL'S TRIM PROGRAM. The level's rooms are the ground floor's boxes, laid out
        # upstairs by hand in the furniture manifest, so a per-room paneling run would
        # case the ground floor's windows and partitions that do not exist up here. The
        # level authors ONE finished room instead: a roof group's box, carrying the upper
        # windows second_floor_windows puts in its walls (the same specs add_shell_windows
        # cut) and the doors the viewer's partitions make. `bare` and `plainBelow` mark
        # windows by name — a hole in a tiled shower wall, a window over a counter.
        pan = level.get("paneling")
        if pan:
            grp = None
            for lv in cfg["levels"]:
                grp = (lv.get("roofGroups") or {}).get(pan["group"]) or grp
            gb = [rooms_cache[s]["bounds"] for s in grp["rooms"]]
            x1, x2 = min(b["x1"] for b in gb), max(b["x2"] for b in gb)
            z1, z2 = min(b["z1"] for b in gb), max(b["z2"] for b in gb)
            _, specs = B.second_floor_windows(rooms)
            wins = []
            for w in specs:
                on = ((w["orient"] == "V" and abs(w["fixed"] - x1) < 1e-6 and z1 <= w["pos"] <= z2)
                      or (w["orient"] == "V" and abs(w["fixed"] - x2) < 1e-6 and z1 <= w["pos"] <= z2)
                      or (w["orient"] == "H" and abs(w["fixed"] - z1) < 1e-6 and x1 <= w["pos"] <= x2)
                      or (w["orient"] == "H" and abs(w["fixed"] - z2) < 1e-6 and x1 <= w["pos"] <= x2))
                if not on:
                    continue
                rec = dict(w)
                if w["name"] in pan.get("bare", []):
                    rec["bare"] = True
                if w["name"] in pan.get("plainBelow", []):
                    rec["plainBelow"] = True
                wins.append(rec)
            room = {"_stem": f"{pan['group']}-shell", "bounds": {"x1": x1, "x2": x2, "z1": z1, "z2": z2},
                    "windows": wins, "doors": list(pan.get("doors", [])),
                    "interior": {"paneling": dict(pan.get("program", {"baseboard": 10, "noCornice": True, "battens": False}))}}
            n0 = len(ctx.paneling)
            compute_paneling(ctx, [room])
            if rake:
                # Each wall under the sloped ceiling carries `ceil`: the ceiling height (ft)
                # at its two ends, in the wall's own along-coordinate. Constant on a wall
                # running along z (the plane rakes in x), so the viewer's field panels are
                # trapezoids on the north and south walls and plain bands on the east.
                sbox, z_of = rake
                for w in ctx.paneling[n0:]:
                    if w["along"] == "x":
                        under = sbox["z1"] - 0.5 <= w["at"] <= sbox["z2"] + 0.5
                        ends = (z_of(w["lo"]), z_of(w["hi"]))
                    else:
                        under = sbox["x1"] - 0.5 <= w["at"] <= sbox["x2"] + 0.5
                        ends = (z_of(w["at"]), z_of(w["at"]))
                    if under:
                        w["ceil"] = [[w["lo"], round(ends[0], 4)], [w["hi"], round(ends[1], 4)]]
    elif kind == "attic":
        # Habitable attic: shaped to the exterior roof (single source of truth
        # for type + pitch) rather than drawn as a full-height storey.
        ref = level["roofRef"]
        src = next(l for l in cfg["levels"] if l["id"] == ref["from"])
        g = src["roofGroups"][ref["group"]]
        B.add_attic(ctx, rooms, {"type": g.get("type", "hip"),
                                 "pitch": g.get("pitch", 0.5),
                                 "kneeFt": level.get("kneeFt", 4.0),
                                 "usableHeadroomFt": level.get("usableHeadroomFt", 7.0),
                                 "flatCeilFt": level.get("flatCeilFt"),
                                 "eaveWallFt": g.get("eaveWallFt", 0.0),
                                 # the bathroom claims the whole west end (to the eaves), so
                                 # drop the knee walls west of its partition line.
                                 "bathCutFt": (level.get("bathroom") or {}).get("cutFt"),
                                 "dormers": g.get("dormers"),
                                 "shedDormer": g.get("shedDormer"),
                                 "hipDormers": g.get("hipDormers")})
        # top of the stair: enclose Leg 4 with walls that rise to the hip-roof
        # underside (same footprint + pitch the attic ceiling is built from).
        fpx = [v for r in rooms for v in (r["bounds"]["x1"], r["bounds"]["x2"])]
        fpz = [v for r in rooms for v in (r["bounds"]["z1"], r["bounds"]["z2"])]
        roof_fp = {"footprint": {"x1": min(fpx), "x2": max(fpx), "z1": min(fpz), "z2": max(fpz)},
                   "eaveFt": g.get("eaveWallFt", 0.0), "pitch": g.get("pitch", 0.5)}
        emit_stairwells(ctx, rooms, up=False, roof=roof_fp)
        for r in rooms:
            B.add_attic_floor_finish(ctx, r)              # hardwood inside the knee walls, subfloor beyond
        # a full bathroom partitioned off the NW corner (viewer-rendered: partition
        # walls + door + fixtures); the rest of the attic stays open.
        bath = level.get("bathroom")
        if bath:
            _dm = g.get("dormers") or {}
            _nbays = B.aligned_front_bays(rooms, _dm.get("count", 3)) or []
            # westmost north-dormer alcove west edge (plan x): the WC's east wall lands here.
            n_dormer_west = (max(_nbays) + _dm.get("widthFt", 3.5) / 2) if _nbays else None
            ctx.furniture.append({"type": "bathroom", "px": (bath["x1"] + bath["x2"]) / 2,
                                  "pz": (bath["z1"] + bath["z2"]) / 2, "roof": roof_fp,
                                  "kneeFt": level.get("kneeFt", 4.0),
                                  "usableFt": level.get("usableHeadroomFt", 7.0),
                                  "flatCeilFt": level.get("flatCeilFt"),
                                  "nDormerWestFt": n_dormer_west,
                                  "x1": bath["x1"], "x2": bath["x2"], "z1": bath["z1"], "z2": bath["z2"]})
        # Split the open attic into rooms: a partition makes the EAST wing one bedroom,
        # positioned just west of the easternmost (final) north dormer so that dormer
        # sits inside the bedroom; the bathroom already occupies the WEST wing; the
        # roomy central (stair) bay gets a kitchenette.
        Fp = roof_fp["footprint"]
        PART = 3.9167                                    # aligned with the level-2 east landing wall; keeps the east dormer inside
        ctx.furniture.append({"type": "attic_partition", "px": PART, "pz": (Fp["z1"] + Fp["z2"]) / 2,
                              "line": PART, "za": Fp["z1"], "zb": Fp["z2"], "roof": roof_fp,
                              "flatCeilFt": level.get("flatCeilFt"),
                              "door": {"atFt": -3.9, "widthFt": 2.667, "hinge": "S", "opens": "E", "headFt": 6.85}})
        ctx.furniture.append({"type": "bed", "px": -4.10, "pz": 7.20, "head": "N", "widthFt": 5.0, "lenFt": 6.67})  # east-wing bedroom: east edge + headboard exactly on the 6ft usable-headroom lines (NE corner), facing south
        ctx.furniture.append({"type": "kitchenette", "px": 9.5, "pz": -10.5, "faces": "N", "lenFt": 10.9, "depthFt": 2.0, "lowerOnly": True})  # in the south shed dormer: full-width lower run
        # cute window-seat benches under each north dormer, against the 3 ft knee wall
        dm_spec = g.get("dormers")
        if dm_spec:
            bays = B.aligned_front_bays(rooms, dm_spec.get("count", 3))
            if bays:
                z2 = roof_fp["footprint"]["z2"]
                kinset = (level.get("kneeFt", 4.0) - g.get("eaveWallFt", 0.0)) / g.get("pitch", 0.5)
                knee_z = round(z2 - kinset, 3)
                for cx in bays:
                    ctx.furniture.append({"type": "window_bench", "px": round(cx, 3), "pz": knee_z,
                                          "widthFt": dm_spec.get("widthFt", 3.5)})
    elif kind == "exterior":
        B.add_lot(ctx, cfg["lot"], rooms,
                  cut=B.approach_arc_lines(cfg["lot"].get("frontage") or {},
                                           rooms_cache, cfg["lot"], ctx.T / B.FT / 2))
        # Solid massing blocks (per building part, at their storey heights) +
        # roofs — closed, so the interior is never visible from any angle. A
        # crawlspace band raises the whole thing off grade.
        crawl = level.get("crawlspaceFt", 0) * B.FT
        # THE PATIO IS ONE INCH UNDER THE FINISHED FLOOR, in PLAN FEET. Authored as a drop
        # rather than as a height above grade: written absolutely, raising `crawlspaceFt` would
        # leave the patio behind and turn the threshold into a step, with nothing to catch it.
        _patio = (level.get("crawlspaceFt", 0)
                  - ((cfg["lot"].get("frontage") or {}).get("doubleWalk") or {}).get("patioDropIn", 0) / 12.0)
        B.add_massing(ctx, level["roofGroups"], rooms_cache, crawl,
                      deck_arc=B.approach_arc_lines(cfg["lot"].get("frontage") or {},
                                                    rooms_cache, cfg["lot"], ctx.T / B.FT / 2),
                      porch_base=_patio * B.FT)
        B.add_fenestration(ctx, level["roofGroups"], rooms_cache, crawl)
        B.add_deck(ctx, cfg["lot"], rooms_cache, crawl)
        B.add_lot_wall(ctx, cfg["lot"], rooms_cache, crawl)
        B.add_picket_fence(ctx, cfg["lot"], rooms_cache)
        B.add_yard_fence(ctx, cfg["lot"], rooms_cache, crawl)
        B.add_side_porch(ctx, cfg["lot"], rooms_cache, crawl)
        B.add_wing_elevation(ctx, cfg["lot"], rooms_cache, crawl, level["roofGroups"])
        # Corner-lot street frontage: retaining wall on the north/west property
        # lines plus the sidewalk, park strip and curb falling away beyond them.
        B.add_street_frontage(ctx, cfg["lot"], rooms_cache,
                              terrace=level.get("crawlspaceFt", 0))
        # `crawl` is in METRES (it is a z for the massing); add_front_approach works in plan
        # feet, so hand it the authored figure rather than the converted one.
        # ...and the flights climb to the PATIO, not to the house, so their top tread lands
        # flush with it rather than standing an inch proud mid-route.
        B.add_front_approach(ctx, cfg["lot"], rooms_cache, terrace=_patio)
        B.add_driveway(ctx, cfg["lot"], rooms_cache)
        # Last, because it dies on three things already built: the driveway's west edge,
        # the rear deck's grade paver and the side porch's.
        B.add_garden_walk(ctx, cfg["lot"], rooms_cache)

    ifc_name = f"{lid}.ifc"
    m.write(os.path.join(HERE, ifc_name))
    names = {k: f"{lid}.{k}.json" for k in ("doors", "floors", "subfloor", "tiles", "furniture", "paneling")}
    dump = lambda k, data: json.dump(data, open(os.path.join(HERE, names[k]), "w"), indent=2)
    dump("doors", ctx.door_meta)
    dump("floors", ctx.plank_floors)
    dump("subfloor", ctx.subfloors)
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
