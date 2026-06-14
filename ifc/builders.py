"""Shared IFC building blocks used by the orchestrator and the per-room catalog.

Everything here is stable infrastructure: geometry primitives, the spatial
context, and builders for walls / slabs / spaces / openings. Per-room *data*
lives in ``rooms/<name>.json``; bespoke per-room *geometry* lives in an optional
``rooms/<name>.py`` hook. Interior-design items are built by ``catalog.py``.

Coordinate convention: room data is authored in PLAN feet. ``Ctx.X``/``Ctx.Y``
convert plan coordinates to IFC metres, applying the cardinal-orientation flip
(IFC +X = East, +Y = North) once, in one place.
"""

import numpy as np
import ifcopenshell
from ifcopenshell.api import run

FT = 0.3048  # feet -> metres


def matrix(x=0.0, y=0.0, z=0.0):
    """4x4 translation-only placement matrix."""
    m = np.eye(4)
    m[0, 3], m[1, 3], m[2, 3] = x, y, z
    return m


def union_intervals(intervals, tol=1e-4):
    """Merge overlapping/abutting 1-D intervals into minimal segments."""
    ivs = sorted((min(a, b), max(a, b)) for a, b in intervals)
    out = []
    for a, b in ivs:
        if out and a <= out[-1][1] + tol:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out if b - a > tol]


class Ctx:
    """Carries the IFC file, the model context, the storey, global parameters
    and the running list of walls (so openings can find their host)."""

    def __init__(self, model, body, storey, cfg):
        self.model = model
        self.body = body
        self.storey = storey
        o = cfg.get("orientation", {"xs": 1, "zs": 1})
        self.xs, self.zs = o["xs"], o["zs"]
        self.T = cfg["wallThickness"] * FT          # wall thickness (m)
        self.H = cfg["wallHeight"] * FT             # wall / ceiling height (m)
        self.slab_t = cfg["slabThickness"]          # floor slab thickness (m)
        self.door_h_ft = cfg["doorHeight"]          # door head height (ft)
        self.walls = []                              # [{wall, orient, fixed, a, b}]
        self.styles = {}                             # rgb tuple -> IfcSurfaceStyle (cached)

    # plan feet -> IFC metres (with the cardinal flip)
    def X(self, plan_x):
        return self.xs * plan_x * FT

    def Y(self, plan_z):
        return self.zs * plan_z * FT


def rect_rep(ctx, xdim, ydim, height):
    """Body representation: a rectangle (centered on origin) extruded +Z."""
    m = ctx.model
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
        "IfcShapeRepresentation", ContextOfItems=ctx.body,
        RepresentationIdentifier="Body", RepresentationType="SweptSolid",
        Items=[solid])


def surface_style(ctx, rgb):
    """Get (cached) an IfcSurfaceStyle for an (r,g,b) colour in 0..1."""
    key = tuple(round(c, 3) for c in rgb)
    if key in ctx.styles:
        return ctx.styles[key]
    m = ctx.model
    style = run("style.add_style", m, name=None)
    run("style.add_surface_style", m, style=style, ifc_class="IfcSurfaceStyleShading",
        attributes={"SurfaceColour": {"Name": None, "Red": float(rgb[0]),
                                      "Green": float(rgb[1]), "Blue": float(rgb[2])},
                    "Transparency": 0.0})
    ctx.styles[key] = style
    return style


def assign_color(ctx, rep, rgb):
    run("style.assign_representation_styles", ctx.model,
        shape_representation=rep, styles=[surface_style(ctx, rgb)])


def make_box(ctx, ifc_class, name, xdim, ydim, height, cx, cy, cz,
             long_name=None, predefined=None, color=None):
    """Create a product with a centered rectangular extruded body at (cx,cy,cz).

    If ``color`` (r,g,b in 0..1) is given, the body is shaded that colour.
    """
    m = ctx.model
    kwargs = {"ifc_class": ifc_class, "name": name}
    if predefined:
        kwargs["predefined_type"] = predefined
    product = run("root.create_entity", m, **kwargs)
    if long_name is not None and hasattr(product, "LongName"):
        product.LongName = long_name
    rep = rect_rep(ctx, xdim, ydim, height)
    if color is not None:
        assign_color(ctx, rep, color)
    run("geometry.assign_representation", m, product=product, representation=rep)
    run("geometry.edit_object_placement", m, product=product, matrix=matrix(cx, cy, cz))
    return product


def ifc_bounds(ctx, b):
    """Room bounds (plan feet dict) -> (x1, x2, y1, y2) in IFC metres, ordered."""
    xs = [ctx.X(b["x1"]), ctx.X(b["x2"])]
    ys = [ctx.Y(b["z1"]), ctx.Y(b["z2"])]
    return min(xs), max(xs), min(ys), max(ys)


def add_wall(ctx, orient, fixed, a, b):
    length = b - a
    if orient == "H":            # runs along X at y = fixed
        w = make_box(ctx, "IfcWall", "Wall", length + ctx.T, ctx.T, ctx.H,
                     (a + b) / 2, fixed, 0.0)
    else:                        # "V": runs along Y at x = fixed
        w = make_box(ctx, "IfcWall", "Wall", ctx.T, length + ctx.T, ctx.H,
                     fixed, (a + b) / 2, 0.0)
    run("spatial.assign_container", ctx.model, products=[w], relating_structure=ctx.storey)
    ctx.walls.append({"wall": w, "orient": orient, "fixed": fixed, "a": a, "b": b})


def build_walls(ctx, rooms):
    """Build the global wall network from the union of all room edges (so shared
    walls are single elements)."""
    h_edges, v_edges = {}, {}
    key = lambda v: round(v, 4)
    for r in rooms:
        if not r.get("walls", True):
            continue
        x1, x2, y1, y2 = ifc_bounds(ctx, r["bounds"])
        h_edges.setdefault(key(y1), []).append((x1, x2))
        h_edges.setdefault(key(y2), []).append((x1, x2))
        v_edges.setdefault(key(x1), []).append((y1, y2))
        v_edges.setdefault(key(x2), []).append((y1, y2))
    for y, ivs in h_edges.items():
        for a, b in union_intervals(ivs):
            add_wall(ctx, "H", y, a, b)
    for x, ivs in v_edges.items():
        for a, b in union_intervals(ivs):
            add_wall(ctx, "V", x, a, b)


def add_slab(ctx, r):
    x1, x2, y1, y2 = ifc_bounds(ctx, r["bounds"])
    slab = make_box(ctx, "IfcSlab", f"Slab - {r['name']}",
                    abs(x2 - x1), abs(y2 - y1), ctx.slab_t,
                    (x1 + x2) / 2, (y1 + y2) / 2, -ctx.slab_t, predefined="FLOOR")
    run("spatial.assign_container", ctx.model, products=[slab], relating_structure=ctx.storey)
    return slab


def add_space(ctx, r):
    x1, x2, y1, y2 = ifc_bounds(ctx, r["bounds"])
    inset = ctx.T / 2  # interior wall face
    sp = make_box(ctx, "IfcSpace", r["name"],
                  abs(x2 - x1) - 2 * inset, abs(y2 - y1) - 2 * inset, ctx.H,
                  (x1 + x2) / 2, (y1 + y2) / 2, 0.0,
                  long_name=r.get("longName", r["name"]), predefined="INTERNAL")
    run("aggregate.assign_object", ctx.model, products=[sp], relating_object=ctx.storey)
    return sp


def find_wall(ctx, orient, fixed_m, pos_m):
    for w in ctx.walls:
        if w["orient"] != orient or abs(w["fixed"] - fixed_m) > 0.05:
            continue
        if w["a"] - 0.05 <= pos_m <= w["b"] + 0.05:
            return w
    return None


def cut_opening(ctx, fill_class, name, orient, fixed_ft, pos_ft, width_ft,
                sill_ft, head_ft):
    """Cut an opening (door/window) into the host wall and add its filling.

    All inputs are in PLAN feet; the flip to IFC metres happens here.
    """
    m = ctx.model
    if orient == "H":
        fixed_m, pos_m = ctx.Y(fixed_ft), ctx.X(pos_ft)
    else:
        fixed_m, pos_m = ctx.X(fixed_ft), ctx.Y(pos_ft)
    width_m, sill_m, head_m = abs(width_ft * FT), sill_ft * FT, head_ft * FT
    host = find_wall(ctx, orient, fixed_m, pos_m)
    if host is None:
        print(f"  ! skip {name}: no wall at {orient} fixed={fixed_m:.3f} pos={pos_m:.3f}")
        return None
    height, depth = head_m - sill_m, ctx.T + 0.1
    opening = run("root.create_entity", m, ifc_class="IfcOpeningElement",
                  name=f"Opening - {name}")
    if orient == "H":
        rep = rect_rep(ctx, width_m, depth, height); cx, cy = pos_m, fixed_m
    else:
        rep = rect_rep(ctx, depth, width_m, height); cx, cy = fixed_m, pos_m
    run("geometry.assign_representation", m, product=opening, representation=rep)
    run("geometry.edit_object_placement", m, product=opening, matrix=matrix(cx, cy, sill_m))
    run("feature.add_feature", m, feature=opening, element=host["wall"])
    fill = run("root.create_entity", m, ifc_class=fill_class, name=name)
    if hasattr(fill, "OverallHeight"):
        fill.OverallHeight = float(height)
    if hasattr(fill, "OverallWidth"):
        fill.OverallWidth = float(width_m)
    pd = 0.05
    prep = rect_rep(ctx, width_m, pd, height) if orient == "H" else rect_rep(ctx, pd, width_m, height)
    run("geometry.assign_representation", m, product=fill, representation=prep)
    run("geometry.edit_object_placement", m, product=fill, matrix=matrix(cx, cy, sill_m))
    run("feature.add_filling", m, opening=opening, element=fill)
    run("spatial.assign_container", m, products=[fill], relating_structure=ctx.storey)
    return fill


def add_doors(ctx, r):
    for d in r.get("doors", []):
        cut_opening(ctx, "IfcDoor", d["name"], d["orient"], d["fixed"], d["pos"],
                    d["width"], 0.0, ctx.door_h_ft)


def add_windows(ctx, r):
    for w in r.get("windows", []):
        cut_opening(ctx, "IfcWindow", w["name"], w["orient"], w["fixed"], w["pos"],
                    w["width"], w["sill"], w["head"])
