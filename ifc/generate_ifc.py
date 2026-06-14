#!/usr/bin/env python3
"""
Generate an IFC4 BIM model of the Eureka residence floor plan.

The geometry is driven by ``floorplan_spec.json``, whose room rectangles were
recovered directly from the original Three.js bundle (wall centerlines, in feet).
This script turns that spec into a proper BIM model: an IfcSlab floor, 2x6
(5.5") IfcWalls at 9'-6", IfcSpaces per room, and IfcDoor / IfcWindow elements
cut into the walls via IfcOpeningElement voids.

Output: ``floorplan.ifc`` (IFC4, SI/metric).

Run:  python ifc/generate_ifc.py
Deps: ifcopenshell, numpy   (pip install ifcopenshell numpy)
"""

import json
import os
import numpy as np
import ifcopenshell
from ifcopenshell.api import run

FT = 0.3048  # feet -> metres
HERE = os.path.dirname(os.path.abspath(__file__))


def load_spec():
    with open(os.path.join(HERE, "floorplan_spec.json")) as f:
        return json.load(f)


def matrix(x=0.0, y=0.0, z=0.0):
    """4x4 placement matrix with a translation only (axis-aligned)."""
    m = np.eye(4)
    m[0, 3], m[1, 3], m[2, 3] = x, y, z
    return m


def union_intervals(intervals, tol=1e-4):
    """Merge overlapping/abutting 1-D intervals -> minimal list of segments."""
    ivs = sorted((min(a, b), max(a, b)) for a, b in intervals)
    out = []
    for a, b in ivs:
        if out and a <= out[-1][1] + tol:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out if b - a > tol]


def main():
    spec = load_spec()
    T = spec["wallThickness"] * FT          # wall thickness (m)
    H = spec["wallHeight"] * FT             # wall / ceiling height (m)
    SLAB_T = 0.2                            # floor slab thickness (m)
    rooms = spec["rooms"]

    # Orient the model to true cardinal directions using IFC's convention
    # (+X = East, +Y = North). The recovered plan has the Extension at the most
    # negative plan-x and the Scullery at the most negative plan-z, so:
    #   IFC_X = -plan_x  -> Extension on the East (+X), Kitchen/Dining on the West
    #   IFC_Y = +plan_z  -> Scullery on the South (-Y)
    # (Net effect vs. the un-mirrored layout is a 180 deg rotation about the
    # vertical axis, so the relative room arrangement is preserved.)
    XS, ZS = -1.0, 1.0
    for r in rooms:
        x1, x2 = XS * r["x1"], XS * r["x2"]
        z1, z2 = ZS * r["z1"], ZS * r["z2"]
        r["x1"], r["x2"] = min(x1, x2), max(x1, x2)
        r["z1"], r["z2"] = min(z1, z2), max(z1, z2)

    enclosed = rooms  # every room (incl. the Scullery) gets enclosing walls

    # ---- file + units + contexts -------------------------------------------
    m = run("project.create_file", version="IFC4")
    project = run("root.create_entity", m, ifc_class="IfcProject",
                  name="Eureka Residence")
    # Explicit SI units with NO prefix => metres. (The default would be
    # millimetres, which collides with edit_object_placement's metre-based
    # matrices and collapses the model.)
    length_unit = run("unit.add_si_unit", m, unit_type="LENGTHUNIT", prefix=None)
    area_unit = run("unit.add_si_unit", m, unit_type="AREAUNIT", prefix=None)
    volume_unit = run("unit.add_si_unit", m, unit_type="VOLUMEUNIT", prefix=None)
    run("unit.assign_unit", m, units=[length_unit, area_unit, volume_unit])
    ctx = run("context.add_context", m, context_type="Model")
    body = run("context.add_context", m, context_type="Model",
               context_identifier="Body", target_view="MODEL_VIEW", parent=ctx)

    # ---- spatial hierarchy --------------------------------------------------
    site = run("root.create_entity", m, ifc_class="IfcSite", name="Site")
    building = run("root.create_entity", m, ifc_class="IfcBuilding",
                   name="Eureka House")
    storey = run("root.create_entity", m, ifc_class="IfcBuildingStorey",
                 name="Ground Floor")
    run("aggregate.assign_object", m, products=[site], relating_object=project)
    run("aggregate.assign_object", m, products=[building], relating_object=site)
    run("aggregate.assign_object", m, products=[storey], relating_object=building)

    def rect_rep(xdim, ydim, height):
        """Body representation: a rectangle (centered on origin) extruded +Z.

        Uses IfcRectangleProfileDef (not ShapeBuilder's IfcIndexedPolyCurve),
        which every IFC geometry kernel tessellates reliably.
        """
        profile = m.create_entity(
            "IfcRectangleProfileDef", ProfileType="AREA",
            XDim=float(xdim), YDim=float(ydim),
            Position=m.create_entity(
                "IfcAxis2Placement2D",
                Location=m.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0))))
        solid = m.create_entity(
            "IfcExtrudedAreaSolid", SweptArea=profile, Depth=float(height),
            Position=m.create_entity(
                "IfcAxis2Placement3D",
                Location=m.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))),
            ExtrudedDirection=m.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)))
        return m.create_entity(
            "IfcShapeRepresentation", ContextOfItems=body,
            RepresentationIdentifier="Body", RepresentationType="SweptSolid",
            Items=[solid])

    def make_box_product(ifc_class, name, xdim, ydim, height, cx, cy, cz,
                         long_name=None, predefined=None):
        """Create a product with a centered rectangular extruded body."""
        kwargs = {"ifc_class": ifc_class, "name": name}
        if predefined:
            kwargs["predefined_type"] = predefined
        product = run("root.create_entity", m, **kwargs)
        if long_name is not None and hasattr(product, "LongName"):
            product.LongName = long_name
        rep = rect_rep(xdim, ydim, height)
        run("geometry.assign_representation", m, product=product, representation=rep)
        run("geometry.edit_object_placement", m, product=product,
            matrix=matrix(cx, cy, cz))
        return product

    # ---- walls (from unioned room edges, in metres) ------------------------
    h_edges = {}  # y(plan-z) -> [(x1, x2), ...]   horizontal walls (run along X)
    v_edges = {}  # x         -> [(y1, y2), ...]   vertical walls (run along Y)

    def key(v):
        return round(v, 4)

    for r in enclosed:
        x1, x2 = r["x1"] * FT, r["x2"] * FT
        y1, y2 = r["z1"] * FT, r["z2"] * FT
        h_edges.setdefault(key(y1), []).append((x1, x2))
        h_edges.setdefault(key(y2), []).append((x1, x2))
        v_edges.setdefault(key(x1), []).append((y1, y2))
        v_edges.setdefault(key(x2), []).append((y1, y2))

    walls = []  # {wall, orient, fixed, a, b}

    def add_wall(orient, fixed, a, b):
        length = b - a
        if orient == "H":          # runs along X at plan-y = fixed
            w = make_box_product("IfcWall", "Wall", length + T, T, H,
                                  (a + b) / 2, fixed, 0.0)
        else:                      # "V": runs along Y at x = fixed
            w = make_box_product("IfcWall", "Wall", T, length + T, H,
                                  fixed, (a + b) / 2, 0.0)
        run("spatial.assign_container", m, products=[w], relating_structure=storey)
        walls.append({"wall": w, "orient": orient, "fixed": fixed, "a": a, "b": b})

    for y, ivs in h_edges.items():
        for a, b in union_intervals(ivs):
            add_wall("H", y, a, b)
    for x, ivs in v_edges.items():
        for a, b in union_intervals(ivs):
            add_wall("V", x, a, b)

    # ---- floor slabs (one per room, incl. porch) ---------------------------
    for r in rooms:
        x1, x2 = r["x1"] * FT, r["x2"] * FT
        y1, y2 = r["z1"] * FT, r["z2"] * FT
        slab = make_box_product("IfcSlab", f"Slab - {r['name']}",
                                abs(x2 - x1), abs(y2 - y1), SLAB_T,
                                (x1 + x2) / 2, (y1 + y2) / 2, -SLAB_T,
                                predefined="FLOOR")
        run("spatial.assign_container", m, products=[slab], relating_structure=storey)

    # ---- spaces (one per room) ---------------------------------------------
    for r in rooms:
        x1, x2 = r["x1"] * FT, r["x2"] * FT
        y1, y2 = r["z1"] * FT, r["z2"] * FT
        inset = T / 2  # shrink to the interior wall face
        w = abs(x2 - x1) - 2 * inset
        d = abs(y2 - y1) - 2 * inset
        space = make_box_product("IfcSpace", r["name"], w, d, H,
                                 (x1 + x2) / 2, (y1 + y2) / 2, 0.0,
                                 long_name=r["longName"], predefined="INTERNAL")
        run("aggregate.assign_object", m, products=[space], relating_object=storey)

    # ---- doors & windows ----------------------------------------------------
    DOOR_H = 7.0 * FT          # 7'-0" doors (per spec)
    door_defs = [
        # (name, orient, fixed_ft, pos_ft, width_ft)   coords are in PLAN space;
        # the XS/ZS flip below maps them to the cardinal-oriented model.
        ("Foyer -> Family",     "V",  3.9167,  -6.0, 2.75),
        ("Foyer -> Sitting",    "V",  3.9167,   5.0, 2.75),
        ("Foyer -> Kitchen",    "V", 15.0833,  -5.0, 2.75),
        ("Foyer -> Dining",     "V", 15.0833,   6.0, 2.75),
        ("Foyer -> Vestibule",  "H", 10.1667,  9.5,  2.75),
        ("Family -> Extension", "V", -12.0,    -6.0, 2.5),
        # interior doors connecting adjacent rooms
        ("Family -> Sitting",   "H",  0.0,     -6.0, 2.75),
        ("Kitchen -> Dining",   "H",  2.0,     23.0, 2.75),
        # Scullery: one door into the Kitchen, one into the Family room
        ("Kitchen -> Scullery", "H", -11.9167, 21.0, 2.5),
        ("Family -> Scullery",  "H", -11.9167, 0.0,  2.5),
    ]
    win_defs = [
        # (name, orient, fixed_ft, pos_ft, width_ft, sill_ft, head_ft)
        # Exterior walls only (audited against the original model). Family/Foyer/
        # Vestibule are internally surrounded, so they get no windows.
        # NB: names use true cardinal directions (model is +X=East, +Y=North,
        # so a plan-west wall faces East after the orientation flip).
        ("Window - Sitting E",   "V", -12.0,     8.0,  4.0, 2.5, 6.5),
        ("Window - Kitchen W",   "V", 31.0,     -6.0,  4.0, 2.5, 6.5),
        ("Window - Dining W1",   "V", 31.0,      6.0,  4.0, 2.5, 6.5),
        ("Window - Dining W2",   "V", 31.0,     12.0,  4.0, 2.5, 6.5),
        ("Window - Dining N",    "H", 16.0833,  23.0,  4.0, 2.5, 6.5),
        ("Window - Extension E", "V", -22.9167, -4.0,  4.0, 2.5, 6.5),
        ("Window - Scullery S1", "H", -18.875,   3.0,  3.5, 2.5, 6.0),
        ("Window - Scullery S2", "H", -18.875,  11.0,  3.5, 2.5, 6.0),
        ("Window - Scullery S3", "H", -18.875,  18.0,  3.5, 2.5, 6.0),
        ("Window - Scullery S4", "H", -18.875,  24.0,  3.5, 2.5, 6.0),
    ]

    def find_wall(orient, fixed_m, pos_m):
        best = None
        for w in walls:
            if w["orient"] != orient:
                continue
            if abs(w["fixed"] - fixed_m) > 0.05:
                continue
            if w["a"] - 0.05 <= pos_m <= w["b"] + 0.05:
                return w
        return best

    def cut_opening(fill_class, name, orient, fixed_m, pos_m, width_m,
                    sill_m, head_m):
        host = find_wall(orient, fixed_m, pos_m)
        if host is None:
            print(f"  ! skip {name}: no wall at {orient} fixed={fixed_m:.3f} "
                  f"pos={pos_m:.3f}")
            return
        height = head_m - sill_m
        depth = T + 0.1  # punch fully through the wall
        # opening void
        opening = run("root.create_entity", m, ifc_class="IfcOpeningElement",
                      name=f"Opening - {name}")
        if orient == "H":
            rep = rect_rep(width_m, depth, height)
            cx, cy = pos_m, fixed_m
        else:
            rep = rect_rep(depth, width_m, height)
            cx, cy = fixed_m, pos_m
        run("geometry.assign_representation", m, product=opening, representation=rep)
        run("geometry.edit_object_placement", m, product=opening,
            matrix=matrix(cx, cy, sill_m))
        run("feature.add_feature", m, feature=opening, element=host["wall"])
        # filling (door/window panel)
        fill = run("root.create_entity", m, ifc_class=fill_class, name=name)
        if hasattr(fill, "OverallHeight"):
            fill.OverallHeight = float(height)
        if hasattr(fill, "OverallWidth"):
            fill.OverallWidth = float(width_m)
        panel_depth = 0.05
        if orient == "H":
            prep = rect_rep(width_m, panel_depth, height)
        else:
            prep = rect_rep(panel_depth, width_m, height)
        run("geometry.assign_representation", m, product=fill, representation=prep)
        run("geometry.edit_object_placement", m, product=fill,
            matrix=matrix(cx, cy, sill_m))
        run("feature.add_filling", m, opening=opening, element=fill)
        run("spatial.assign_container", m, products=[fill],
            relating_structure=storey)

    # Apply the same axis flips to openings. For an H wall (runs along x) the
    # `fixed` coord is the depth axis (z) and `pos` is x; for a V wall it's the
    # reverse.
    for name, orient, fixed, pos, width in door_defs:
        f = ZS * fixed if orient == "H" else XS * fixed
        p = XS * pos if orient == "H" else ZS * pos
        cut_opening("IfcDoor", name, orient, f * FT, p * FT,
                    width * FT, 0.0, DOOR_H)
    for name, orient, fixed, pos, width, sill, head in win_defs:
        f = ZS * fixed if orient == "H" else XS * fixed
        p = XS * pos if orient == "H" else ZS * pos
        cut_opening("IfcWindow", name, orient, f * FT, p * FT,
                    width * FT, sill * FT, head * FT)

    out = os.path.join(HERE, "floorplan.ifc")
    m.write(out)

    # ---- summary ------------------------------------------------------------
    def n(cls):
        return len(m.by_type(cls))
    print(f"Wrote {out}")
    print(f"  IfcWall   : {n('IfcWall')}")
    print(f"  IfcSlab   : {n('IfcSlab')}")
    print(f"  IfcSpace  : {n('IfcSpace')}")
    print(f"  IfcDoor   : {n('IfcDoor')}")
    print(f"  IfcWindow : {n('IfcWindow')}")
    print(f"  IfcOpeningElement : {n('IfcOpeningElement')}")


if __name__ == "__main__":
    main()
