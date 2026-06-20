"""Shared IFC building blocks used by the orchestrator and the per-room catalog.

Everything here is stable infrastructure: geometry primitives, the spatial
context, and builders for walls / slabs / spaces / openings. Per-room *data*
lives in ``rooms/<name>.json``; bespoke per-room *geometry* lives in an optional
``rooms/<name>.py`` hook. Interior-design items are built by ``catalog.py``.

Coordinate convention: room data is authored in PLAN feet. ``Ctx.X``/``Ctx.Y``
convert plan coordinates to IFC metres, applying the cardinal-orientation flip
(IFC +X = East, +Y = North) once, in one place.
"""

import math
import numpy as np
import ifcopenshell
from ifcopenshell.api import run

FT = 0.3048  # feet -> metres


def matrix(x=0.0, y=0.0, z=0.0, rot=0.0):
    """4x4 placement matrix: translation to (x,y,z), plus an optional rotation
    ``rot`` (radians) about the vertical (Z) axis — used to orient furniture."""
    m = np.eye(4)
    if rot:
        c, s = math.cos(rot), math.sin(rot)
        m[0, 0], m[0, 1] = c, -s
        m[1, 0], m[1, 1] = s, c
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


def subtract_intervals(lo, hi, holes, margin=0.0, minlen=0.3):
    """Solid spans of [lo,hi] left after removing the (optionally margined)
    ``holes``. Spans shorter than ``minlen`` are dropped."""
    merged = union_intervals([(a - margin, b + margin) for a, b in holes]) if holes else []
    spans, cur = [], lo
    for a, b in merged:
        a, b = max(a, lo), min(b, hi)
        if a > cur:
            spans.append((cur, a))
        cur = max(cur, b)
    if cur < hi:
        spans.append((cur, hi))
    return [(a, b) for a, b in spans if b - a > minlen]


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
        self.H = cfg["wallHeight"] * FT             # interior floor-to-ceiling (m)
        # Floor-to-floor story height for the structure (ceiling + floor/joist
        # zone); drives the exterior massing & upper-floor placement.
        self.story = cfg.get("storyHeight", cfg["wallHeight"]) * FT
        self.slab_t = cfg["slabThickness"]          # floor slab thickness (m)
        self.door_h_ft = cfg["doorHeight"]          # door head height (ft)
        # Uniform head height for ALL doors and windows above the finish floor.
        self.head_ft = cfg.get("headHeight", cfg["doorHeight"])
        self.walls = []                              # [{wall, orient, fixed, a, b}]
        self.door_meta = []                          # [{name, hingeMax, swingSign}] for the viewer
        self.plank_floors = []                       # [{name, rgb}] plank floors the viewer re-renders
        self.tile_floors = []                         # [{name, pattern}] tiled floors the viewer re-renders
        self.furniture = []                          # [{type, px, pz, rot, ...}] viewer-rendered furniture
        self.paneling = []                           # [{along, at, normal, base, field}] wall finishes
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


def surface_style(ctx, rgb, transparency=0.0):
    """Get (cached) an IfcSurfaceStyle for an (r,g,b) colour in 0..1.

    transparency 0=opaque .. 1=fully transparent (uses IfcSurfaceStyleRendering
    so viewers render see-through glass).
    """
    key = tuple(round(c, 3) for c in rgb) + (round(transparency, 2),)
    if key in ctx.styles:
        return ctx.styles[key]
    m = ctx.model
    col = {"Name": None, "Red": float(rgb[0]), "Green": float(rgb[1]), "Blue": float(rgb[2])}
    style = run("style.add_style", m, name=None)
    if transparency > 0:
        run("style.add_surface_style", m, style=style, ifc_class="IfcSurfaceStyleRendering",
            attributes={"SurfaceColour": col, "Transparency": float(transparency),
                        "ReflectanceMethod": "GLASS"})
    else:
        run("style.add_surface_style", m, style=style, ifc_class="IfcSurfaceStyleShading",
            attributes={"SurfaceColour": col, "Transparency": 0.0})
    ctx.styles[key] = style
    return style


def assign_color(ctx, rep, rgb, transparency=0.0):
    run("style.assign_representation_styles", ctx.model,
        shape_representation=rep, styles=[surface_style(ctx, rgb, transparency)])


def positioned_solid(ctx, xdim, ydim, height, cx, cy, cz):
    """An extruded rectangular solid whose own Position carries (cx,cy,cz).

    Lets many solids live in one product's representation (e.g. floor planks).
    """
    m = ctx.model
    profile = m.create_entity(
        "IfcRectangleProfileDef", ProfileType="AREA", XDim=float(xdim), YDim=float(ydim),
        Position=m.create_entity("IfcAxis2Placement2D",
                                 Location=m.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0))))
    return m.create_entity(
        "IfcExtrudedAreaSolid", SweptArea=profile, Depth=float(height),
        Position=m.create_entity("IfcAxis2Placement3D",
                                 Location=m.create_entity("IfcCartesianPoint",
                                                          Coordinates=(float(cx), float(cy), float(cz)))),
        ExtrudedDirection=m.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)))


def style_item(ctx, solid, rgb):
    """Colour a single representation item (so each plank can differ)."""
    ctx.model.create_entity("IfcStyledItem", Item=solid, Styles=[surface_style(ctx, rgb)])


def multi_solid_product(ctx, ifc_class, name, solids, predefined=None):
    """Create one product whose Body representation holds many (pre-styled) solids."""
    m = ctx.model
    kwargs = {"ifc_class": ifc_class, "name": name}
    if predefined:
        kwargs["predefined_type"] = predefined
    product = run("root.create_entity", m, **kwargs)
    rep = m.create_entity("IfcShapeRepresentation", ContextOfItems=ctx.body,
                          RepresentationIdentifier="Body", RepresentationType="SweptSolid",
                          Items=solids)
    run("geometry.assign_representation", m, product=product, representation=rep)
    run("geometry.edit_object_placement", m, product=product, matrix=matrix(0, 0, 0))
    return product


def make_box(ctx, ifc_class, name, xdim, ydim, height, cx, cy, cz,
             long_name=None, predefined=None, color=None, rot=0.0, transparency=0.0):
    """Create a product with a centered rectangular extruded body at (cx,cy,cz).

    If ``color`` (r,g,b in 0..1) is given, the body is shaded that colour.
    ``transparency`` (0..1) makes it see-through (e.g. glass).
    ``rot`` (radians) rotates the box about the vertical axis (for furniture).
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
        assign_color(ctx, rep, color, transparency=transparency)
    run("geometry.assign_representation", m, product=product, representation=rep)
    run("geometry.edit_object_placement", m, product=product, matrix=matrix(cx, cy, cz, rot))
    return product


def circle_rep(ctx, diameter, height):
    """Body representation: a circle (centered on origin) extruded +Z."""
    m = ctx.model
    profile = m.create_entity(
        "IfcCircleProfileDef", ProfileType="AREA", Radius=float(diameter) / 2.0,
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
        RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[solid])


def make_cylinder(ctx, ifc_class, name, diameter, height, cx, cy, cz,
                  predefined=None, color=None, rot=0.0):
    """Create a product with a centered circular extruded body at (cx,cy,cz)
    (round table tops, pedestals, columns...)."""
    m = ctx.model
    kwargs = {"ifc_class": ifc_class, "name": name}
    if predefined:
        kwargs["predefined_type"] = predefined
    product = run("root.create_entity", m, **kwargs)
    rep = circle_rep(ctx, diameter, height)
    if color is not None:
        assign_color(ctx, rep, color)
    run("geometry.assign_representation", m, product=product, representation=rep)
    run("geometry.edit_object_placement", m, product=product, matrix=matrix(cx, cy, cz, rot))
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


def perimeter_segments(rects):
    """Outline of the union of axis-aligned rectangles (each (x1,x2,y1,y2) in
    metres). Returns boundary wall segments ("V", x, ylo, yhi) / ("H", y, xlo,
    xhi): an edge of a cell that has the union on exactly one side."""
    xs = sorted({round(v, 6) for r in rects for v in (r[0], r[1])})
    ys = sorted({round(v, 6) for r in rects for v in (r[2], r[3])})
    inside = lambda cx, cy: any(r[0] < cx < r[1] and r[2] < cy < r[3] for r in rects)
    nx, ny = len(xs) - 1, len(ys) - 1
    cell = [[inside((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2) for j in range(ny)] for i in range(nx)]
    vert, horiz = {}, {}                                   # fixed-line -> [intervals]
    for i in range(nx + 1):                                # vertical boundaries at x = xs[i]
        for j in range(ny):
            left = cell[i - 1][j] if i - 1 >= 0 else False
            right = cell[i][j] if i < nx else False
            if left != right:
                vert.setdefault(xs[i], []).append((ys[j], ys[j + 1]))
    for j in range(ny + 1):                                # horizontal boundaries at y = ys[j]
        for i in range(nx):
            below = cell[i][j - 1] if j - 1 >= 0 else False
            above = cell[i][j] if j < ny else False
            if below != above:
                horiz.setdefault(ys[j], []).append((xs[i], xs[i + 1]))
    out = []
    for x, ivs in vert.items():
        out += [("V", x, a, b) for a, b in union_intervals(ivs)]
    for y, ivs in horiz.items():
        out += [("H", y, a, b) for a, b in union_intervals(ivs)]
    return out


def add_shell(ctx, rooms):
    """Exterior shell only: a floor slab per room footprint + the perimeter walls
    of their union (no interior partitions, spaces, doors, or windows)."""
    rects = [ifc_bounds(ctx, r["bounds"]) for r in rooms]
    for r in rooms:
        add_slab(ctx, r)
    for orient, fixed, a, b in perimeter_segments(rects):
        add_wall(ctx, orient, fixed, a, b)


def add_attic(ctx, rooms, roof):
    """Attic level shaped to the ACTUAL roof rather than a full-height box: a
    floor slab over the primary footprint and a sloped ceiling that follows the
    SAME hip + pitch as the exterior roof (so the two stay in sync). `roof` carries
    {type, pitch, kneeFt, eaveWallFt, dormers, shedDormer}.

    With `eaveWallFt`=0 the roof springs straight off the attic floor and short
    inset knee walls fence off the unusable low triangles. With `eaveWallFt`>0
    (a raised plate / story-and-a-half) the roof springs from full-height
    perimeter walls of that height — which become the knee walls — so the ceiling
    is `eaveWallFt` at the walls and the usable floor reaches wall to wall."""
    CEIL = (0.93, 0.92, 0.90)   # drywall ceiling soffit
    KNEE = (0.87, 0.86, 0.83)   # painted knee / perimeter wall (matches the massing)
    rects = [ifc_bounds(ctx, r["bounds"]) for r in rooms]
    x1, x2 = min(r[0] for r in rects), max(r[1] for r in rects)
    y1, y2 = min(r[2] for r in rects), max(r[3] for r in rects)
    pitch = roof.get("pitch", 0.5)
    knee = roof.get("kneeFt", 4.0) * FT
    eave = roof.get("eaveWallFt", 0.0) * FT           # raised plate above the attic floor
    t = ctx.T

    for r in rooms:                                   # floor over the whole footprint
        add_slab(ctx, r)

    # sloped ceiling = the hip underside, springing from the eave (z = eave).
    # _roof_slab gives it a real thickness so the soffit reads from below.
    surf, slopes, eave_loop = _hip_surface(x1, x2, y1, y2, eave, pitch)
    cv, cf = _roof_slab(surf, slopes, eave_loop, 0.10)
    # Translucent so the 3/4 exhibit view reads INTO the room (floor + walls show
    # through) — i.e. you can see the habitable volume under the slope.
    add_brep(ctx, "Attic ceiling", cv, cf, CEIL, ifc_class="IfcCovering",
             predefined="CEILING", transparency=0.55)

    if eave > 0:
        # raised plate: full-height perimeter walls (these ARE the knee walls)
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        for nm, bx, by, xd, yd in [
            ("Plate wall S", cx, y1, abs(x2 - x1) + t, t),
            ("Plate wall N", cx, y2, abs(x2 - x1) + t, t),
            ("Plate wall W", x1, cy, t, abs(y2 - y1) + t),
            ("Plate wall E", x2, cy, t, abs(y2 - y1) + t),
        ]:
            w = make_box(ctx, "IfcWall", nm, xd, yd, eave, bx, by, 0.0, color=KNEE)
            run("spatial.assign_container", ctx.model, products=[w], relating_structure=ctx.storey)
    else:
        # inset knee walls where the bare hip ceiling first reaches `knee`
        dk = knee / pitch
        kx1, kx2, ky1, ky2 = x1 + dk, x2 - dk, y1 + dk, y2 - dk
        cx, cy = (kx1 + kx2) / 2, (ky1 + ky2) / 2
        for nm, bx, by, xd, yd in [
            ("Knee wall S", cx, ky1, abs(kx2 - kx1) + t, t),
            ("Knee wall N", cx, ky2, abs(kx2 - kx1) + t, t),
            ("Knee wall W", kx1, cy, t, abs(ky2 - ky1) + t),
            ("Knee wall E", kx2, cy, t, abs(ky2 - ky1) + t),
        ]:
            kw = make_box(ctx, "IfcWall", nm, xd, yd, knee, bx, by, 0.0, color=KNEE)
            run("spatial.assign_container", ctx.model, products=[kw], relating_structure=ctx.storey)

    if roof.get("dormers"):
        add_dormers(ctx, x1, x2, y1, y2, pitch, roof["dormers"], base_z=eave, style="interior")
    if roof.get("shedDormer"):
        add_shed_dormer(ctx, x1, x2, y1, y2, pitch, roof["shedDormer"], base_z=eave, style="interior")


def _prism(poly, vec):
    """Closed solid from a planar polygon `poly` (list of 3-D pts, metres) swept by
    `vec`. Returns (verts, faces): the two caps + a quad per edge. add_brep orients
    every face, and a prism over a convex polygon is convex, so it renders solid."""
    n = len(poly)
    b = [(float(p[0]), float(p[1]), float(p[2])) for p in poly]
    t = [(p[0] + vec[0], p[1] + vec[1], p[2] + vec[2]) for p in b]
    verts = b + t
    faces = [list(range(n)), [i + n for i in range(n)]]
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, j + n, i + n])
    return verts, faces


def add_dormers(ctx, x1, x2, y1, y2, pitch, spec, base_z=0.0, style="interior"):
    """Gable dormers on the NORTH slope (north = +Y, the front), in a near-full-
    width `count`-bay rhythm spread across the facade (NOT stacked on the inner
    windows). Windows continue the graduated fenestration (the attic = smallest
    tier). Each dormer is built from open surfaces — a front gable wall with a
    glazed opening, two cheek walls, and a little gable roof — so the headroom
    POCKET reads as habitable space; the same builder serves the attic exhibit
    (`base_z`=0, light soffit) and the exterior massing (`base_z`=eave elevation,
    charcoal shingle).

    Because the roof HIPS at its ends, the two outer dormers are pulled IN just
    enough to keep the configured `plate` (their outer cheek needs plate <= pitch *
    run from the side eave), with the rest spaced evenly between them — a wide
    spread that still keeps full standing height. Geometry per dormer (world
    metres, +base_z): the front wall stands at the north eave line (yN) from the
    eave up to `plate`; the gable roof rises to ridge zR and dies into the main
    slope at y_p (cheeks)/y_r (ridge)."""
    WALL = (0.87, 0.86, 0.83)                       # painted dormer wall / cheeks
    ROOF = (0.30, 0.30, 0.33) if style == "exterior" else (0.93, 0.92, 0.90)
    GLASS = (0.42, 0.52, 0.60)                       # muted blue-grey glazing
    # RECESS the dormer back from the wall plane: slide its face inboard by
    # `recessFt` and lift its base up the slope by pitch*recess, so a band of main
    # roof shows in front and the dormer reads as set into the roof (not the wall).
    recess = spec.get("recessFt", 0.0) * FT
    yN = y2 - recess
    base_z = base_z + pitch * recess
    wd = spec.get("widthFt", 3.5) * FT
    ww = spec.get("window", {}).get("widthFt", 2.0) * FT
    wh = spec.get("window", {}).get("heightFt", 2.5) * FT
    count = spec.get("count", 3)
    ty, tx, tz = 0.12, 0.10, 0.10                     # member thicknesses (m)

    # near-full-width bays: pull the outer dormers in just enough to keep the
    # configured plate (outer cheek run from the side eave >= plate / pitch), then
    # spread the rest evenly between them. Fall back to even bays + a shrunk plate
    # only if the footprint is too narrow even for that.
    plate = spec.get("plateFt", 6.0) * FT
    m_req = plate / pitch + 0.20 * FT                  # run from a side eave to the outer cheek
    c_w, c_e = x1 + m_req + wd / 2, x2 - m_req - wd / 2
    if count == 1:
        bays = [(x1 + x2) / 2]
    elif c_e > c_w:
        bays = [c_w + i * (c_e - c_w) / (count - 1) for i in range(count)]
    else:                                             # too narrow: even bays, plate shrunk to fit
        span = x2 - x1
        bays = [x1 + (i + 0.5) * span / count for i in range(count)]
        cap = min(min(cx - wd / 2 - x1, x2 - (cx + wd / 2)) for cx in bays) * pitch
        plate = min(plate, cap - 0.20 * FT)
    whead = plate - 0.40 * FT                          # leave a band under the gable
    wsill = max(0.8 * FT, whead - wh)

    def prism(name, poly, vec, color, cls="IfcWall", tr=0.0):
        v, f = _prism([(p[0], p[1], p[2] + base_z) for p in poly], vec)
        add_brep(ctx, name, v, f, color, ifc_class=cls, transparency=tr)

    def box(name, xa, xb, za, zb, color, cls="IfcWall", cy=None, dy=ty, tr=0.0):
        if xb - xa <= 1e-6 or zb - za <= 1e-6:
            return
        p = make_box(ctx, cls, name, xb - xa, dy, zb - za,
                     (xa + xb) / 2, yN if cy is None else cy, za + base_z, color=color, transparency=tr)
        run("spatial.assign_container", ctx.model, products=[p], relating_structure=ctx.storey)

    for k, cx in enumerate(bays, 1):
        xL, xR = cx - wd / 2, cx + wd / 2
        xWL, xWR = cx - ww / 2, cx + ww / 2
        zR = plate + (wd / 2) * pitch                 # dormer ridge (dormer pitch = main)
        y_p = yN - plate / pitch                      # cheek eaves die into main slope
        y_r = yN - zR / pitch                         # dormer ridge dies into main slope
        nm = f"Dormer {k}"
        # front gable wall: a frame around the opening, then the gable triangle
        box(f"{nm} jamb W", xL, xWL, 0.0, plate, WALL)
        box(f"{nm} jamb E", xWR, xR, 0.0, plate, WALL)
        box(f"{nm} sill", xWL, xWR, 0.0, wsill, WALL)
        box(f"{nm} head", xWL, xWR, whead, plate, WALL)
        prism(f"{nm} gable", [(xL, yN, plate), (xR, yN, plate), (cx, yN, zR)], (0, ty, 0), WALL)
        # glazing, set just proud of the wall face (north = +Y)
        box(f"{nm} window", xWL, xWR, wsill, whead, GLASS,
            cls="IfcWindow", cy=yN + ty / 2, dy=0.05, tr=0.45)
        # cheek walls (vertical, sitting on the main slope)
        prism(f"{nm} cheek W", [(xL, yN, 0.0), (xL, yN, plate), (xL, y_p, plate)], (tx, 0, 0), WALL)
        prism(f"{nm} cheek E", [(xR, yN, 0.0), (xR, yN, plate), (xR, y_p, plate)], (-tx, 0, 0), WALL)
        # gable roof (two slopes meeting at the dormer ridge)
        prism(f"{nm} roof W", [(xL, yN, plate), (cx, yN, zR), (cx, y_r, zR), (xL, y_p, plate)],
              (0, 0, tz), ROOF, cls="IfcRoof")
        prism(f"{nm} roof E", [(xR, yN, plate), (cx, yN, zR), (cx, y_r, zR), (xR, y_p, plate)],
              (0, 0, tz), ROOF, cls="IfcRoof")


def add_shed_dormer(ctx, x1, x2, y1, y2, pitch, spec, base_z=0.0, style="interior"):
    """A single wide dormer centred on the ridge centre line of the SOUTH slope
    (south = -Y), sized to maximise full-height attic floor WITHOUT touching the
    ridge or the hips. Its width is the central ridge length (footprint long side -
    short side) less a small `marginFt` each end, so the cheeks stay off the hips.

    `roof` selects the cap:
      * "shed" (default): a single low-slope plane from a `plateFt` front wall up
        to where it dies into the main slope `ridgeMarginFt` below the ridge.
      * "flat": a horizontal roof at `plateFt` above the eave, behind a `parapetFt`
        PARAPET that rises past it. The parapet front gets a decorative cap +
        cornice + dentil course. The flat roof runs back until the main slope
        rises to meet it (plate / pitch), leaving the ridge + upper slope intact.
    Serves the attic exhibit (`base_z`=0, light soffit) and exterior massing
    (`base_z`=eave, charcoal/membrane)."""
    WALL = (0.87, 0.86, 0.83)
    ROOF = (0.30, 0.30, 0.33) if style == "exterior" else (0.93, 0.92, 0.90)
    GLASS = (0.42, 0.52, 0.60)
    TRIM = (0.93, 0.92, 0.88)                          # white parapet trim
    # RECESS back from the wall plane: face slides inboard by recessFt, base lifts
    # pitch*recess up the slope, so main roof shows in front of the dormer.
    recess = spec.get("recessFt", 0.0) * FT
    yS = y1 + recess                                   # south eave (min Y), recessed in
    base_z = base_z + pitch * recess
    half = min(x2 - x1, y2 - y1) / 2.0                 # ridge inset = half the short span
    ridge_len = (x2 - x1) - 2 * half                   # the simple (un-hipped) central run
    cx = (x1 + x2) / 2.0
    margin = spec.get("marginFt", 0.5) * FT
    W_s = max(2.0 * FT, ridge_len - 2 * margin)
    xa, xb = cx - W_s / 2, cx + W_s / 2
    flat = spec.get("roof", "shed") == "flat"
    P = spec.get("plateFt", 7.0) * FT                  # front-wall / flat-roof height (rel. eave)
    ty, tx, tz = 0.12, 0.10, 0.10
    win = spec.get("window", {})
    nwin = win.get("count", 3)
    ww = win.get("widthFt", 2.0) * FT
    wh = win.get("heightFt", 2.5) * FT
    wsill = win.get("sillFt", 2.5) * FT

    def prism(name, poly, vec, color, cls="IfcWall", tr=0.0):
        v, f = _prism([(p[0], p[1], p[2] + base_z) for p in poly], vec)
        add_brep(ctx, name, v, f, color, ifc_class=cls, transparency=tr)

    def box(name, xaa, xbb, za, zb, color, cls="IfcWall", cy=None, dy=ty, tr=0.0):
        if xbb - xaa <= 1e-6 or zb - za <= 1e-6:
            return
        p = make_box(ctx, cls, name, xbb - xaa, dy, zb - za,
                     (xaa + xbb) / 2, yS if cy is None else cy, za + base_z, color=color, transparency=tr)
        run("spatial.assign_container", ctx.model, products=[p], relating_structure=ctx.storey)

    if flat:
        parapet = spec.get("parapetFt", 2.0) * FT
        Hp = P + parapet                               # parapet top
        d_flat = P / pitch                             # flat roof meets the main slope here
        y_back = yS + d_flat
        whead = min(P - 0.3 * FT, wsill + wh)
        wall_top = Hp                                  # front wall rises to the parapet top
        # cheeks: vertical walls up to the parapet at the front, tapering to the
        # flat-roof line where they meet the main slope
        prism("Shed dormer cheek W", [(xa, yS, 0.0), (xa, yS, Hp), (xa, y_back, P)], (tx, 0, 0), WALL)
        prism("Shed dormer cheek E", [(xb, yS, 0.0), (xb, yS, Hp), (xb, y_back, P)], (-tx, 0, 0), WALL)
        # the flat roof itself (horizontal slab at the plate height)
        prism("Shed dormer roof", [(xa, yS, P), (xb, yS, P), (xb, y_back, P), (xa, y_back, P)],
              (0, 0, tz), ROOF, cls="IfcRoof")
        # --- decorate the parapet: projecting coping cap, cornice band, dentils ---
        box("Parapet coping", xa - 0.14, xb + 0.14, Hp - 0.06, Hp + 0.08, TRIM, cy=yS - 0.07, dy=ty + 0.28)
        box("Parapet cornice", xa - 0.07, xb + 0.07, Hp - 0.26, Hp - 0.12, TRIM, cy=yS - 0.05, dy=ty + 0.16)
        step = 0.20
        n = max(1, int(round(W_s / step)))
        for i in range(n):
            dcx = xa + (i + 0.5) * W_s / n
            box(f"Parapet dentil {i}", dcx - 0.05, dcx + 0.05, Hp - 0.42, Hp - 0.28,
                TRIM, cy=yS - 0.04, dy=ty + 0.10)
        # continue the coping + cornice along BOTH cheeks: a raking band from the
        # front parapet (Hp) down to where the cheek meets the main slope (y_back, P)
        # — so the trim wraps the sides and dies into the main roof pitch.
        for sx, sgn in ((xa, -1.0), (xb, 1.0)):        # west cheek projects -x, east +x
            prism("Parapet coping side", [(sx, yS, Hp + 0.07), (sx, y_back, P + 0.07),
                  (sx, y_back, P - 0.07), (sx, yS, Hp - 0.07)], (0.22 * sgn, 0, 0), TRIM)
            prism("Parapet cornice side", [(sx, yS, Hp - 0.12), (sx, y_back, P - 0.12),
                  (sx, y_back, P - 0.22), (sx, yS, Hp - 0.22)], (0.13 * sgn, 0, 0), TRIM)
    else:
        d_back = half - spec.get("ridgeMarginFt", 2.0) * FT
        d_back = max(d_back, P / pitch + 0.5 * FT)
        z_back = pitch * d_back
        y_back = yS + d_back
        whead = min(P - 0.4 * FT, wsill + wh)
        wall_top = P
        prism("Shed dormer cheek W", [(xa, yS, 0.0), (xa, yS, P), (xa, y_back, z_back)], (tx, 0, 0), WALL)
        prism("Shed dormer cheek E", [(xb, yS, 0.0), (xb, yS, P), (xb, y_back, z_back)], (-tx, 0, 0), WALL)
        prism("Shed dormer roof", [(xa, yS, P), (xb, yS, P), (xb, y_back, z_back), (xa, y_back, z_back)],
              (0, 0, tz), ROOF, cls="IfcRoof")

    # front wall (faces south): full-width sill + head bands, a window ribbon between
    box("Shed dormer sill", xa, xb, 0.0, wsill, WALL)
    box("Shed dormer head", xa, xb, whead, wall_top, WALL)
    edge = xa
    for i in range(nwin):
        c = xa + (i + 0.5) * W_s / nwin
        wl, wr = c - ww / 2, c + ww / 2
        box(f"Shed dormer jamb {i}", edge, wl, wsill, whead, WALL)
        box(f"Shed dormer window {i + 1}", wl, wr, wsill, whead, GLASS,
            cls="IfcWindow", cy=yS - ty / 2, dy=0.05, tr=0.45)
        edge = wr
    box("Shed dormer jamb end", edge, xb, wsill, whead, WALL)


def add_lot(ctx, lot, rooms):
    """A flat lot plane sized lot.widthFt x lot.depthFt (E-W x N-S), positioned so
    the building sits `westMarginFt` inside the west line (west = +plan x) and the
    scullery `scullerySouthFt` off the south line (south = min plan z)."""
    pxs = [v for r in rooms for v in (r["bounds"]["x1"], r["bounds"]["x2"])]
    pzs = [v for r in rooms for v in (r["bounds"]["z1"], r["bounds"]["z2"])]
    west = max(pxs) + lot["westMarginFt"]                  # west lot line (plan x)
    east = west - lot["widthFt"]
    south = min(pzs) - lot["scullerySouthFt"]              # south lot line (plan z)
    north = south + lot["depthFt"]
    cx, cz = (west + east) / 2, (south + north) / 2
    lotmesh = make_box(ctx, "IfcSlab", "Lot",
                       lot["widthFt"] * FT, lot["depthFt"] * FT, 0.1,
                       ctx.X(cx), ctx.Y(cz), -0.11, predefined="BASESLAB", color=(0.46, 0.55, 0.34))
    run("spatial.assign_container", ctx.model, products=[lotmesh], relating_structure=ctx.storey)
    return lotmesh


def _newell_normal(loop):
    """Unnormalised face normal of a 3-D polygon loop (Newell's method)."""
    n = [0.0, 0.0, 0.0]
    L = len(loop)
    for i in range(L):
        a, b = loop[i], loop[(i + 1) % L]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    return n


def add_brep(ctx, name, verts, faces, color, predefined=None, ifc_class="IfcRoof", transparency=0.0):
    """Create a product whose body is a faceted-BREP closed solid from `verts`
    (metres) and `faces` (vertex-index loops). Each face loop is auto-oriented
    so its normal points away from the solid centroid (outward) — valid for the
    convex roof solids here, so the renderer never culls a face."""
    m = ctx.model
    cen = [sum(v[k] for v in verts) / len(verts) for k in range(3)]
    pts = [m.create_entity("IfcCartesianPoint", Coordinates=(float(v[0]), float(v[1]), float(v[2]))) for v in verts]
    ifc_faces = []
    for f in faces:
        loop = [verts[i] for i in f]
        nrm = _newell_normal(loop)
        fc = [sum(p[k] for p in loop) / len(loop) for k in range(3)]
        outward = sum((fc[k] - cen[k]) * nrm[k] for k in range(3)) >= 0
        idx = list(f) if outward else list(f)[::-1]
        poly = m.create_entity("IfcPolyLoop", Polygon=[pts[i] for i in idx])
        bound = m.create_entity("IfcFaceOuterBound", Bound=poly, Orientation=True)
        ifc_faces.append(m.create_entity("IfcFace", Bounds=[bound]))
    shell = m.create_entity("IfcClosedShell", CfsFaces=ifc_faces)
    brep = m.create_entity("IfcFacetedBrep", Outer=shell)
    rep = m.create_entity("IfcShapeRepresentation", ContextOfItems=ctx.body,
                          RepresentationIdentifier="Body", RepresentationType="Brep", Items=[brep])
    if color is not None:
        assign_color(ctx, rep, color, transparency=transparency)
    kwargs = {"ifc_class": ifc_class, "name": name}
    if predefined:
        kwargs["predefined_type"] = predefined
    product = run("root.create_entity", m, **kwargs)
    run("geometry.assign_representation", m, product=product, representation=rep)
    run("geometry.edit_object_placement", m, product=product, matrix=matrix(0, 0, 0))
    run("spatial.assign_container", m, products=[product], relating_structure=ctx.storey)
    return product


def _roof_slab(surf, slopes, eave_loop, t):
    """Thicken a roof top surface into a closed slab of vertical thickness `t`:
    the given surface becomes the soffit, the roofing is it raised by `t`, and a
    vertical fascia closes the eave boundary. So the roof reads as a real
    assembly (not a knife edge) and its top sits above the wall — which keeps the
    wall from bleeding through the roof in plan. add_brep orients every face."""
    n = len(surf)
    verts = [tuple(v) for v in surf] + [(v[0], v[1], v[2] + t) for v in surf]
    faces = []
    for f in slopes:
        faces.append(list(f))                       # soffit (underside)
        faces.append([i + n for i in f])            # roofing (top)
    for a, b in zip(eave_loop, eave_loop[1:] + eave_loop[:1]):
        faces.append([a, b, b + n, a + n])          # fascia at the eave edge
    return verts, faces


def _filled_block(surf, slopes, eave_loop, z0):
    """Filled solid from a flat bottom at `z0` up to the given top surface — a
    sloped-ceiling massing the matching roof slab sits directly on (no floating
    gap between a flat ceiling and the pitched roof). add_brep orients faces."""
    verts = [tuple(v) for v in surf]
    base = []
    for i in eave_loop:
        base.append(len(verts)); verts.append((surf[i][0], surf[i][1], z0))
    faces = [list(f) for f in slopes]                       # sloped top
    faces.append(list(base))                                 # flat bottom
    m = len(eave_loop)
    for k in range(m):                                       # walls
        faces.append([eave_loop[k], eave_loop[(k + 1) % m], base[(k + 1) % m], base[k]])
    return verts, faces


def _hip_surface(x1, x2, y1, y2, eave, pitch, oh=0.0):
    """Hip-roof top surface: returns (verts, slope_faces, eave_loop). Ridge runs
    along the longer side; equal-pitch hips inset the ridge by half the short
    span. An overhang `oh` (m) extends every eave past the walls, dropping the
    eave edge by oh*pitch (the slopes simply continue)."""
    if oh:
        x1 -= oh; x2 += oh; y1 -= oh; y2 += oh
        eave -= oh * pitch
    w, d = x2 - x1, y2 - y1
    if w >= d:
        half = d / 2.0; hr = eave + half * pitch; yc = (y1 + y2) / 2.0
        surf = [(x1, y1, eave), (x2, y1, eave), (x2, y2, eave), (x1, y2, eave),
                (x1 + half, yc, hr), (x2 - half, yc, hr)]
        slopes = [[0, 1, 5, 4], [2, 3, 4, 5], [1, 2, 5], [3, 0, 4]]
    else:
        half = w / 2.0; hr = eave + half * pitch; xc = (x1 + x2) / 2.0
        surf = [(x1, y1, eave), (x2, y1, eave), (x2, y2, eave), (x1, y2, eave),
                (xc, y1 + half, hr), (xc, y2 - half, hr)]
        slopes = [[0, 1, 4], [2, 3, 5], [1, 2, 5, 4], [3, 0, 4, 5]]
    return surf, slopes, [0, 1, 2, 3]


def _shed_surface(x1, x2, y1, y2, eave, pitch, high, oh=0.0):
    """Mono-pitch (shed) top surface; `high` ('x1'|'x2'|'y1'|'y2') is the raised
    eave that abuts the taller structure, sloping down to the opposite side. An
    overhang `oh` (m) extends ONLY the low (downslope) eave; the high side and
    flanks stay flush. Returns (verts, slope_faces, eave_loop)."""
    if oh:
        if high == "x1":
            x2 += oh
        elif high == "x2":
            x1 -= oh
        elif high == "y1":
            y2 += oh
        else:
            y1 -= oh
        eave -= oh * pitch
    if high in ("x1", "x2"):
        run_len = x2 - x1; rise = run_len * pitch
        z = (lambda x: eave + rise - (x - x1) / run_len * rise) if high == "x1" \
            else (lambda x: eave + (x - x1) / run_len * rise)
        surf = [(x1, y1, z(x1)), (x2, y1, z(x2)), (x2, y2, z(x2)), (x1, y2, z(x1))]
    else:
        run_len = y2 - y1; rise = run_len * pitch
        z = (lambda y: eave + rise - (y - y1) / run_len * rise) if high == "y1" \
            else (lambda y: eave + (y - y1) / run_len * rise)
        surf = [(x1, y1, z(y1)), (x2, y1, z(y1)), (x2, y2, z(y2)), (x1, y2, z(y2))]
    return surf, [[0, 1, 2, 3]], [0, 1, 2, 3]


def _shedhip_surface(x1, x2, y1, y2, eave, pitch, high, hip, oh=0.0):
    """Shed top surface whose two flanking ends are HIPPED (sloped inward by
    `hip`) instead of gabled. `high` is the raised eave (abutting the taller
    structure). An overhang `oh` (m) extends the low eave and the two hipped
    ends (not the high side). Returns (verts, slope_faces, eave_loop)."""
    if oh:
        if high in ("y1", "y2"):
            x1 -= oh; x2 += oh                       # both hipped ends
            if high == "y2": y1 -= oh                # low eave
            else: y2 += oh
        else:
            y1 -= oh; y2 += oh                       # both hipped ends
            if high == "x2": x1 -= oh                # low eave
            else: x2 += oh
        eave -= oh * pitch
    base = [(x1, y1, eave), (x2, y1, eave), (x2, y2, eave), (x1, y2, eave)]  # 0,1,2,3
    if high in ("y1", "y2"):
        hi = eave + (y2 - y1) * pitch
        yh = y1 if high == "y1" else y2
        surf = base + [(x1 + hip, yh, hi), (x2 - hip, yh, hi)]               # 4,5
        if high == "y2":   # high at y2, slopes to y1; hips at x1 / x2
            slopes = [[4, 5, 1, 0], [3, 0, 4], [1, 2, 5], [3, 2, 5, 4]]
        else:              # high at y1, slopes to y2
            slopes = [[4, 5, 2, 3], [0, 3, 4], [2, 1, 5], [0, 1, 5, 4]]
    else:
        hi = eave + (x2 - x1) * pitch
        xh = x1 if high == "x1" else x2
        surf = base + [(xh, y1 + hip, hi), (xh, y2 - hip, hi)]               # 4,5
        if high == "x2":   # high at x2, slopes to x1; hips at y1 / y2
            slopes = [[4, 5, 3, 0], [0, 1, 4], [3, 2, 5], [1, 2, 5, 4]]
        else:              # high at x1, slopes to x2
            slopes = [[4, 5, 2, 1], [1, 0, 4], [2, 3, 5], [0, 3, 5, 4]]
    return surf, slopes, [0, 1, 2, 3]


def _high_edge(part, ref):
    """Which edge ('x1'|'x2'|'y1'|'y2') of rectangle `part` faces rectangle
    `ref` — i.e. the high side of a shed that abuts the taller structure."""
    pcx, pcy = (part[0] + part[1]) / 2, (part[2] + part[3]) / 2
    rcx, rcy = (ref[0] + ref[1]) / 2, (ref[2] + ref[3]) / 2
    if abs(rcx - pcx) >= abs(rcy - pcy):
        return "x1" if rcx < pcx else "x2"
    return "y1" if rcy < pcy else "y2"


def add_massing(ctx, groups, rooms_cache, crawl=0.0):
    """Build the exterior as solid massing blocks (so the interior is never
    visible) capped with roofs: a two-storey primary under a hip, a two-storey
    extension under a shed sloping away from the primary, and a one-storey
    scullery under a hipped shed. Storey heights come from `groups[*].storeys`
    (less an optional `trimFt`). `crawl` (m) raises every block off grade on a
    foundation band, and a front porch + stairs bridge grade to the threshold."""
    WALL = (0.87, 0.86, 0.83)   # light massing
    ROOF = (0.30, 0.30, 0.33)   # charcoal shingle
    FOUND = (0.55, 0.54, 0.52)  # crawlspace / foundation
    TRIM = (0.93, 0.92, 0.88)   # near-white classical trim

    def union(ids):
        rects = [ifc_bounds(ctx, rooms_cache[s]["bounds"]) for s in ids]
        return (min(r[0] for r in rects), max(r[1] for r in rects),
                min(r[2] for r in rects), max(r[3] for r in rects))

    rects = {k: union(g["rooms"]) for k, g in groups.items()}
    prim = rects.get("primary")
    rt = (5.5 + 2.0) / 12 * FT                      # assembly depth: 2x6 rafters + >=2"
    for key, g in groups.items():
        x1, x2, y1, y2 = rects[key]
        eave = g.get("storeys", 1) * ctx.story - g.get("trimFt", 0) * FT + g.get("eaveWallFt", 0) * FT
        cx, cy, w, d = (x1 + x2) / 2, (y1 + y2) / 2, abs(x2 - x1), abs(y2 - y1)
        if crawl > 0:                              # foundation band, grade -> floor
            cb = make_box(ctx, "IfcSlab", f"Crawlspace - {key}", w, d, crawl, cx, cy, 0.0,
                          predefined="BASESLAB", color=FOUND)
            run("spatial.assign_container", ctx.model, products=[cb], relating_structure=ctx.storey)

        ez = crawl + eave                          # roof springs from the (raised) wall top
        oh = g.get("overhangFt", 0) * FT
        pitch = g.get("pitch", 0.5)
        t = g["type"]
        high = _high_edge(rects[key], prim) if t != "hip" else None
        if t == "hip":
            surf = lambda o: _hip_surface(x1, x2, y1, y2, ez, pitch, o)
        elif t == "shed":
            surf = lambda o: _shed_surface(x1, x2, y1, y2, ez, pitch, high, o)
        else:  # "shedhip"
            surf = lambda o: _shedhip_surface(x1, x2, y1, y2, ez, pitch, high, abs(y2 - y1), o)

        if t == "hip":
            # main block: flat ceiling with an attic under the hip
            block = make_box(ctx, "IfcBuildingElementProxy", f"Massing - {key}",
                             w, d, eave, cx, cy, crawl, color=WALL)
            run("spatial.assign_container", ctx.model, products=[block], relating_structure=ctx.storey)
            # cornice band just under the eaves (only the main block)
            ch, cp = 0.30, 0.12
            corn = make_box(ctx, "IfcBuildingElementProxy", f"Cornice - {key}",
                            w + 2 * cp, d + 2 * cp, ch, cx, cy, ez - ch, color=TRIM)
            run("spatial.assign_container", ctx.model, products=[corn], relating_structure=ctx.storey)
        else:
            # lean-to wing: sloped ceiling, so the shed roof sits directly on top
            mv, mf = _filled_block(*surf(0.0), crawl)
            add_brep(ctx, f"Massing - {key}", mv, mf, WALL, ifc_class="IfcBuildingElementProxy")

        rv, rf = _roof_slab(*surf(oh), rt)
        add_brep(ctx, f"Roof - {key}", rv, rf, ROOF, predefined=("HIP_ROOF" if t == "hip" else "SHED_ROOF"))

        if t == "hip" and g.get("dormers"):           # mirror the attic dormers onto the massing
            add_dormers(ctx, x1, x2, y1, y2, pitch, g["dormers"], base_z=ez, style="exterior")
        if t == "hip" and g.get("shedDormer"):
            add_shed_dormer(ctx, x1, x2, y1, y2, pitch, g["shedDormer"], base_z=ez, style="exterior")

        if crawl > 0:                              # water-table belt at the crawlspace top
            wh, wp = 0.15, 0.06
            wt = make_box(ctx, "IfcBuildingElementProxy", f"Water table - {key}",
                          w + 2 * wp, d + 2 * wp, wh, cx, cy, crawl - wh + 0.05, color=TRIM)
            run("spatial.assign_container", ctx.model, products=[wt], relating_structure=ctx.storey)

    if crawl > 0:
        add_porch(ctx, rooms_cache, crawl)


def add_porch(ctx, rooms_cache, base, width_ft=9.0):
    """A grand HYBRID front stoop: a painted floor on a stucco skirt, with a
    cascade of steps that flare gently wider toward the bottom, FLANKED by solid
    splayed stucco cheek walls (white-capped) that follow the flare down into the
    yard. No thin handrail — the cheek walls are the rail. Built in IFC coords
    (the porch projects to +Y / outward from the front door; metres)."""
    fd = None
    for r in rooms_cache.values():
        for d in r.get("doors", []):
            if "Front Door" in d.get("name", ""):
                fd = d
        if fd:
            break
    if not fd or base <= 0:
        return
    BASE_C, FLOOR_C = (0.84, 0.82, 0.78), (0.74, 0.73, 0.70)
    CAP_C = (0.95, 0.95, 0.93)                          # white cheek-wall caps
    ix, fy = ctx.X(fd["pos"]), ctx.Y(fd["fixed"])      # IFC X (door) / Y (front wall)
    PWh, TD = width_ft / 2 * FT, 3.0 * FT              # terrace half-width, depth
    nst, tread = 5, 0.95 * FT                          # 5 gentle risers; deep treads
    riser, Wbot = base / nst, 13.0                     # bottom flare width (ft, reduced)
    ins, ft_t = 0.04, 0.06
    wt, ph, cap = 0.5 * FT, 2.2 * FT, 0.08             # cheek-wall thickness/parapet/cap
    zTf = fy + TD                                      # terrace front (cascade springs from here)
    zFt = zTf + (nst - 1) * tread                      # cascade foot (where steps land)
    xL, xR = ix - PWh, ix + PWh

    def box(name, x0, x1, y0, y1, z0, h, cls="IfcSlab", color=FLOOR_C):
        if abs(x1 - x0) <= 1e-6 or abs(y1 - y0) <= 1e-6 or h <= 1e-6:
            return
        b = make_box(ctx, cls, name, abs(x1 - x0), abs(y1 - y0), h,
                     (x0 + x1) / 2, (y0 + y1) / 2, z0, color=color)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    # the flare follows a gentle curve: the cascade edge eases outward (slow near
    # the threshold, sweeping wider toward the foot) instead of a straight splay.
    Whalf = Wbot / 2 * FT                               # foot half-width (m)
    def wcurve(t):                                      # half-width along run, t in [0,1]
        return PWh + (Whalf - PWh) * (t ** 1.8)

    # terrace landing (stucco skirt + painted floor) at the threshold
    box("Porch skirt", xL + ins, xR - ins, fy, zTf, 0.0, base - ft_t, color=BASE_C)
    box("Porch floor", xL, xR, fy, zTf, base - ft_t, ft_t, color=FLOOR_C)
    # curved cascade: each tread projects further out and widens along the curve
    for j in range(1, nst):
        half = wcurve(j / (nst - 1))                    # leading-edge half-width
        box(f"Porch step {j}", ix - half, ix + half,
            zTf + (j - 1) * tread, zTf + j * tread + 0.06, 0.0, base - j * riser, color=FLOOR_C)

    # curved cheek walls: a solid stucco rail per side whose inner face tracks the
    # curved step edge (sampled in many short segments so it reads as a smooth
    # sweep), top ramping from the terrace parapet down to a low parapet at the
    # foot. A thin white cap rides each segment.
    run_len = zFt - zTf                                 # cascade run (Y span)
    M = 12                                              # curve subdivisions
    def seg_brep(name, p0, p1, color, cls, b0=0.0, b1=0.0):   # p = (x_in, y, top); b = bottom
        (xi0, y0, t0), (xi1, y1, t1), s = p0, p1, (1 if (p1[0] + p0[0]) / 2 > ix else -1)
        xo0, xo1 = xi0 + s * wt, xi1 + s * wt
        v = [(xi0, y0, b0), (xi1, y1, b1), (xo1, y1, b1), (xo0, y0, b0),
             (xi0, y0, t0), (xi1, y1, t1), (xo1, y1, t1), (xo0, y0, t0)]
        f = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
             [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
        add_brep(ctx, name, v, f, color, ifc_class=cls)

    def cheekwall(s):                                   # s = -1 (left) / +1 (right)
        side = "L" if s < 0 else "R"
        # segment list: a straight back run from the house wall to the terrace
        # front, then the curved cascade run. p = (x_in, y, top).
        segs = [((ix + s * PWh, fy, base + ph), (ix + s * PWh, zTf, base + ph))]
        for k in range(M):
            t0, t1 = k / M, (k + 1) / M
            segs.append(((ix + s * wcurve(t0), zTf + t0 * run_len, base + ph - base * t0),
                         (ix + s * wcurve(t1), zTf + t1 * run_len, base + ph - base * t1)))
        for k, (p0, p1) in enumerate(segs):
            seg_brep(f"Porch cheek wall {side} {k}", p0, p1, BASE_C, "IfcWall")
            # white cap riding this segment's sloped top (uniform-thickness slab)
            cp0, cp1 = (p0[0], p0[1], p0[2] + cap), (p1[0], p1[1], p1[2] + cap)
            seg_brep(f"Porch cheek cap {side} {k}", cp0, cp1, CAP_C,
                     "IfcBuildingElementProxy", b0=p0[2], b1=p1[2])

    cheekwall(-1)
    cheekwall(+1)



def add_deck(ctx, lot, rooms_cache, base):
    """A raised rear deck off the family-room patio doors, level with the finished
    floor (= `base`, 30" above grade). It runs the south face from the extension's
    east wall out to the south lot line, then wraps west along the scullery's south
    wall to the scullery's west wall. Two flights of steps are INSET (notched into
    the platform, so the runs never project past the deck): the west flight spans
    the full scullery section and rises from the scullery's west wall; the east
    flight runs along the extension's south wall and rises from a bottom tread
    aligned with the extension's east wall. A 32" railing guards the east drop."""
    if base <= 0:
        return
    DECK = (0.60, 0.47, 0.34)                       # warm deck wood
    RAIL = (0.40, 0.30, 0.20)                       # darker rail wood
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    xlo = lambda b: min(b["x1"], b["x2"]); xhi = lambda b: max(b["x1"], b["x2"])
    zlo = lambda b: min(b["z1"], b["z2"])
    south = min(zlo(v) for v in B.values()) - lot["scullerySouthFt"]   # south lot line (plan z)
    wall_t = 8 / 12                                 # 8" CMU lot wall on the south line
    deck_south = south + wall_t                     # deck stops at the wall's inner face (8" in)
    ext_east = min(xlo(B[k]) for k in ("ext_bath", "wc", "ext_vestibule", "ext_laundry") if k in B)
    house_south = zlo(B["family"])                  # family / extension south wall (plan z)
    scu = B["scullery"]
    scu_east, scu_west, scu_south = xlo(scu), xhi(scu), zlo(scu)

    def slab(name, x1, x2, z1, z2, z0, h, cls="IfcSlab", color=DECK):
        w, d = abs(x2 - x1), abs(z2 - z1)
        if w <= 1e-6 or d <= 1e-6 or h <= 1e-6:
            return
        b = make_box(ctx, cls, name, w * FT, d * FT, h,
                     ctx.X((x1 + x2) / 2), ctx.Y((z1 + z2) / 2), z0, color=color)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    # --- inset stairs: 4 risers up the 30" drop, runs contained in the platform
    nst, tread = 4, 0.92
    riser, run_len = base / nst, nst * 0.92
    ew = 4.5                                         # east flight width (out from the wall)
    e_z1, e_z2 = house_south - ew, house_south       # east flight z-band (along the wall)

    # --- platform (full height), notched where the two flights descend --------
    # main section, minus the NE notch for the east flight (x: ext_east..+run):
    slab("Deck", ext_east, scu_east, deck_south, e_z1, 0.0, base)            # south of the east flight
    slab("Deck", ext_east + run_len, scu_east, e_z1, e_z2, 0.0, base)            # wall strip west of the notch
    # scullery section, minus the west notch (full depth, x: scu_west-run..scu_west):
    slab("Deck - scullery", scu_east, scu_west - run_len, scu_south, deck_south, 0.0, base)

    # --- the inset step treads (grade -> deck), lowest tread at the outer wall -
    for k in range(nst):
        h = (k + 1) * riser                          # k=0 lowest (one riser up), k=nst-1 == deck
        # east: rises west from the extension's east wall, along the south wall
        slab(f"Deck step E{k}", ext_east + k * tread, ext_east + (k + 1) * tread, e_z1, e_z2, 0.0, h)
        # west: full-width, rises east from the scullery's west wall
        slab(f"Deck step W{k}", scu_west - (k + 1) * tread, scu_west - k * tread, deck_south, scu_south, 0.0, h)

    # --- 32" railing: guards the east drop AND wraps the stair's south side ---
    # so you can't fall off the east edge or into the inset stairwell. Kept just
    # inboard of the east edge so it sits ON the deck, never floating past it.
    RH = 32 / 12 * FT                                # 32" guard height (m)

    def rail(along, fixed, a, b, nm):
        y0 = base
        lo, hi = min(a, b), max(a, b)
        cuts = [lo] + [lo + (i + 1) * 0.5 for i in range(int((hi - lo) / 0.5))] + [hi]
        if along == "z":                             # runs in z at plan x = fixed
            slab(nm + " cap", fixed - 0.08, fixed + 0.08, lo, hi, y0 + RH - 0.1, 0.1, "IfcRailing", RAIL)
            for zc in cuts:
                w = 0.16 if zc in (lo, hi) else 0.07
                slab(nm + " post", fixed - w / 2, fixed + w / 2, zc - w / 2, zc + w / 2, y0, RH, "IfcRailing", RAIL)
        else:                                        # runs in x at plan z = fixed
            slab(nm + " cap", lo, hi, fixed - 0.08, fixed + 0.08, y0 + RH - 0.1, 0.1, "IfcRailing", RAIL)
            for xc in cuts:
                w = 0.16 if xc in (lo, hi) else 0.07
                slab(nm + " post", xc - w / 2, xc + w / 2, fixed - w / 2, fixed + w / 2, y0, RH, "IfcRailing", RAIL)

    xr = ext_east + 0.2                              # inboard of the east edge (sits on the deck)
    zr = e_z1 - 0.1                                  # just south of the stairwell, on the deck
    rail("z", xr, deck_south, zr, "Deck rail E")     # along the east drop, up to the stair corner
    rail("x", zr, xr, ext_east + run_len, "Deck rail S")  # turns west to guard the stairwell's south side


def add_lot_wall(ctx, lot, rooms_cache, base):
    """An 8" CMU boundary wall, full-stucco (smooth, uniform), 84" above grade,
    along the SOUTH and EAST lot lines and placed entirely inside the property
    (its outer face sits on the line, the 8" thickness runs inward). The south
    leg spans the SE corner to the scullery's west wall; the east leg runs 35'
    north from that corner. Foundation is not modelled."""
    STUCCO = (0.90, 0.88, 0.84)                     # smooth off-white stucco
    t = 8 / 12                                       # 8" CMU thickness (ft)
    H = 84 / 12 * FT                                 # 84" above grade (m)
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    pxs = [v for r in B.values() for v in (r["x1"], r["x2"])]
    pzs = [v for r in B.values() for v in (r["z1"], r["z2"])]
    west = max(pxs) + lot["westMarginFt"]            # same lot lines as add_lot
    east = west - lot["widthFt"]                     # east lot line (min plan x)
    south = min(pzs) - lot["scullerySouthFt"]        # south lot line (min plan z)
    scu_west = max(B["scullery"]["x1"], B["scullery"]["x2"])

    def wall(name, x1, x2, z1, z2):
        b = make_box(ctx, "IfcWall", name, abs(x2 - x1) * FT, abs(z2 - z1) * FT, H,
                     ctx.X((x1 + x2) / 2), ctx.Y((z1 + z2) / 2), 0.0, color=STUCCO)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    # south leg: outer (south) face on the south line; 8" runs north (inside)
    wall("Lot wall - south", east, scu_west, south, south + t)
    # east leg: outer (east) face on the east line; 8" runs west (inside)
    wall("Lot wall - east", east, east + t, south, south + 35)


def add_picket_fence(ctx, lot, rooms_cache):
    """A waist-high (36") white picket fence continuing the boundary where the CMU
    wall stops: along the south lot line from the scullery's west wall to the SW
    corner, then north along the west lot line to the plane of the house's north
    exterior wall. Pointed pickets on two rails between posts. (IfcRailing, so it
    isn't a walk-POV surface.)"""
    WHITE = (0.95, 0.95, 0.93)
    Tp, Wp, oc = 1 / 12, 3.5 / 12, 6 / 12            # picket thickness / width / on-centre (ft)
    ht, hs = 36 / 12 * FT, (36 - 4) / 12 * FT         # 36" tall, 4" pointed tip
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    pxs = [v for r in B.values() for v in (r["x1"], r["x2"])]
    pzs = [v for r in B.values() for v in (r["z1"], r["z2"])]
    west = max(pxs) + lot["westMarginFt"]            # west lot line (plan x)
    south = min(pzs) - lot["scullerySouthFt"]        # south lot line (plan z)
    scu_west = max(B["scullery"]["x1"], B["scullery"]["x2"])  # CMU south wall ends here
    north = max(pzs)                                 # house north exterior wall plane
    house_west = max(pxs)                            # house's west exterior wall (NW corner at z=north)

    def box(name, xc, zc, xd, zd, z0, h):
        b = make_box(ctx, "IfcRailing", name, xd * FT, zd * FT, h, ctx.X(xc), ctx.Y(zc), z0, color=WHITE)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    def post(xc, zc):
        box("Fence post", xc, zc, 0.30, 0.30, 0.0, ht + 0.1 * FT)
        box("Fence post cap", xc, zc, 0.46, 0.46, ht + 0.1 * FT, 0.12 * FT)

    def picket(axis, c, fixed):                      # a pointed picket (pentagon prism)
        prof = [(c - Wp / 2, 0.0), (c + Wp / 2, 0.0), (c + Wp / 2, hs), (c, ht), (c - Wp / 2, hs)]
        f1, f2 = fixed - Tp / 2, fixed + Tp / 2
        if axis == "x":                              # run along x, thin in z
            fr = [(ctx.X(p), ctx.Y(f1), v) for p, v in prof]
            bk = [(ctx.X(p), ctx.Y(f2), v) for p, v in prof]
        else:                                        # run along z, thin in x
            fr = [(ctx.X(f1), ctx.Y(p), v) for p, v in prof]
            bk = [(ctx.X(f2), ctx.Y(p), v) for p, v in prof]
        faces = [[0, 1, 2, 3, 4], [9, 8, 7, 6, 5],
                 [0, 1, 6, 5], [1, 2, 7, 6], [2, 3, 8, 7], [3, 4, 9, 8], [4, 0, 5, 9]]
        add_brep(ctx, "Fence picket", fr + bk, faces, WHITE, ifc_class="IfcRailing")

    def run_fence(axis, fixed, a, b):
        lo, hi = min(a, b), max(a, b)
        for zc in (8 / 12 * FT, 26 / 12 * FT):       # bottom + top rails
            if axis == "x":
                box("Fence rail", (lo + hi) / 2, fixed, hi - lo, Tp * 1.5, zc, 2 / 12 * FT)
            else:
                box("Fence rail", fixed, (lo + hi) / 2, Tp * 1.5, hi - lo, zc, 2 / 12 * FT)
        c = lo + oc / 2
        while c < hi - 1e-6:                          # pickets
            picket(axis, c, fixed)
            c += oc
        n = max(1, round((hi - lo) / 6))              # posts every ~6'
        for i in range(n + 1):
            pc = lo + (hi - lo) * i / n
            post(pc, fixed) if axis == "x" else post(fixed, pc)

    def gate_trellis(xg, zf, gw=3.5):
        """A garden gate (picket panel) under a white trellis arbor, centred at
        xg on the north leg (z = zf)."""
        gl, gr = xg - gw / 2, xg + gw / 2            # gate jambs
        ad, ah = 1.0, 84 / 12 * FT                   # arbor half-depth (z) / height
        for px in (gl, gr):                          # 4 arbor posts (4x4, 84")
            for pz in (zf - ad, zf + ad):
                box("Trellis post", px, pz, 0.33, 0.33, 0.0, ah)
        for pz in (zf - ad, zf + ad):                # top beams (along x), front + back
            box("Trellis beam", xg, pz, gw + 0.8, 0.22, ah - 0.25 * FT, 0.25 * FT)
        for i in range(6):                           # rafters (along z) — the trellis slats
            box("Trellis rafter", gl + gw * i / 5, zf, 0.14, 2 * ad + 0.5, ah, 0.14 * FT)
        for pz in (zf - ad * 0.45, zf + ad * 0.45):  # crossing slats -> lattice
            box("Trellis slat", xg, pz, gw + 0.2, 0.1, ah + 0.14 * FT, 0.08 * FT)
        for zc in (8 / 12 * FT, 30 / 12 * FT):       # gate rails
            box("Gate rail", xg, zf, gw - 0.1, Tp * 1.6, zc, 2 / 12 * FT)
        c = gl + 0.28                                # gate pickets
        while c < gr - 0.2:
            picket("x", c, zf)
            c += oc

    # The west side of the lot is the SIDE YARD; the fence encloses it.
    run_fence("x", south, scu_west, west)            # south: end of CMU -> SW corner
    run_fence("z", west, south, north)               # west (side yard): SW corner -> north wall plane
    # north leg: extend east from the west line to the house's NW corner, with a
    # gated trellis arbor in the middle of the leg.
    xg = (house_west + west) / 2
    run_fence("x", north, house_west, xg - 1.75)     # house -> gate
    run_fence("x", north, xg + 1.75, west)           # gate -> west corner
    gate_trellis(xg, north)



def add_entry(ctx, px, pz, dw_ft, base):
    """Classical pedimented door surround over the (North-facing) front door:
    flanking pilasters (with plinths + capitals) carrying a dentilled entablature
    and a shallow triangular pediment, a transom over the door, a keystone in the
    frieze, and a tablet in the tympanum. `px,pz` are the door's plan coords,
    `dw_ft` its width. Pieces are a shallow relief projecting from the wall face
    (+Y, the street side) so the surround sits nearly flat against the wall."""
    TRIM = (0.93, 0.92, 0.88)
    GLASS = (0.42, 0.52, 0.60)
    ix, fy = ctx.X(px), ctx.Y(pz)
    out = 1.0 if ctx.zs > 0 else -1.0      # outward (away from the house)
    dh = ctx.door_h_ft                      # door head (ft above the threshold)
    PIL_D, ENT_D, PED_D = 0.10, 0.14, 0.12  # shallow relief depths (m)

    def place(name, cxp, w_ft, dep, z_lo, z_hi, color=TRIM):
        if z_hi - z_lo <= 0 or w_ft <= 0:
            return
        b = make_box(ctx, "IfcBuildingElementProxy", name, w_ft * FT, dep, z_hi - z_lo,
                     ctx.X(cxp), fy + out * dep / 2, z_lo, color=color)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    # --- rectangular transom over the door: a stained-glass house-number panel --
    spring = base + dh * FT                 # door head = transom sill line
    NUM = "6506"
    glaz_w = dw_ft                           # glazed opening width (ft)
    glaz_h = 1.6                             # transom height (ft)
    glaz_h_m = glaz_h * FT
    cz0 = spring + glaz_h_m / 2               # field centre (m)
    INK = (0.10, 0.14, 0.34)                 # dark navy numbers
    NAVY = (0.13, 0.18, 0.44)                # roundel rings / side fans
    CREAM = (0.92, 0.89, 0.73)               # roundel ground
    LEAD = (0.14, 0.13, 0.12)                # dark lead came backing
    MOS = [(0.46, 0.55, 0.33), (0.63, 0.70, 0.43), (0.80, 0.67, 0.30), (0.87, 0.80, 0.49),
           (0.56, 0.43, 0.29), (0.34, 0.54, 0.54), (0.72, 0.62, 0.36)]  # green/gold/brown/teal

    def tile(cxf, wf, zlo, zhi, dep, color, name="Entry transom", cls="IfcWindow", tr=0.0):
        if zhi - zlo <= 0 or wf <= 0:
            return
        b = make_box(ctx, cls, name, wf * FT, dep, zhi - zlo,
                     ctx.X(cxf), fy + out * dep / 2, zlo, color=color, transparency=tr)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    def poly(pts, dep, color, name="Entry glass", tr=0.0):   # flat slab from an (x_ft, z_m) loop
        ya, yb = fy, fy + out * dep
        n = len(pts)
        verts = [(ctx.X(x), ya, z) for x, z in pts] + [(ctx.X(x), yb, z) for x, z in pts]
        faces = [list(range(n)), list(range(2 * n - 1, n - 1, -1))]
        for i in range(n):
            faces.append([i, (i + 1) % n, n + (i + 1) % n, n + i])
        add_brep(ctx, name, verts, faces, color, ifc_class="IfcWindow", transparency=tr)

    def circ(cx, cz, rx, rzf, n=30):                 # full ellipse loop (rx, rzf ft)
        return [(cx + rx * math.cos(2 * math.pi * k / n), cz + rzf * FT * math.sin(2 * math.pi * k / n))
                for k in range(n)]

    def rnd(a, b, s):                                # deterministic pseudo-random in [0,1)
        n = ((a * 73856093) ^ (b * 19349663) ^ (s * 83492791)) & 0x7fffffff
        return ((n * 2654435761) % 1009) / 1009.0

    # 1) dark lead backing. Everything is kept FLAT: pieces are thin sheets with
    #    tiny (~1.5 mm) ordered depth steps — enough to layer + read the cames,
    #    not so much that the panel looks like stacked 3D discs.
    tile(px, glaz_w, spring, spring + glaz_h_m, 0.002, LEAD, "Entry leading")
    # 2) irregular leaded mosaic field: jitter a grid of shared vertices (rim
    #    vertices pinned to the edge) into irregular quarries, inset toward each
    #    centroid so the gaps read as cames; earthy green/gold/brown/teal glass
    ncol, nrow = 12, 6
    xl = px - glaz_w / 2
    V = {}
    for i in range(ncol + 1):
        for j in range(nrow + 1):
            jx = 0.0 if i in (0, ncol) else (rnd(i, j, 1) - 0.5) * 0.7
            jz = 0.0 if j in (0, nrow) else (rnd(i, j, 2) - 0.5) * 0.7
            V[(i, j)] = (xl + (i + jx) / ncol * glaz_w, spring + (j + jz) / nrow * glaz_h_m)
    for i in range(ncol):
        for j in range(nrow):
            q = [V[(i, j)], V[(i + 1, j)], V[(i + 1, j + 1)], V[(i, j + 1)]]
            gx, gz = sum(p[0] for p in q) / 4.0, sum(p[1] for p in q) / 4.0
            pp = [(p[0] + (gx - p[0]) * 0.12, p[1] + (gz - p[1]) * 0.12) for p in q]
            poly(pp, 0.005, MOS[int(rnd(i, j, 3) * 997) % len(MOS)], "Entry quarry", tr=0.4)
    # 3) a single central roundel: concentric navy/cream rings framing the number
    for k, (rx, rzf, c) in enumerate([(0.82, 0.64, NAVY), (0.76, 0.58, CREAM),
                                      (0.69, 0.51, NAVY), (0.63, 0.45, CREAM)]):
        poly(circ(px, cz0, rx, rzf), 0.013 + 0.0015 * k, c, "Entry roundel", tr=0.35)
    # 5) the house number in rounded serif-style numerals (strokes + arcs), like
    #    the reference photo — drawn opaque on the medallion's cream ground
    DW, DH, s = 0.24, 0.42, 0.075           # digit width / height / stroke (ft)
    sz, dnum, gap = s * FT, 0.022, 0.085
    total = len(NUM) * DW + (len(NUM) - 1) * gap
    x_left, z_bot = px - total / 2, cz0 - DH / 2 * FT

    def vbar(dl, nx, n0, n1):               # vertical stroke (normalised cell coords)
        tile(dl + nx * DW, s, z_bot + n0 * DH * FT, z_bot + n1 * DH * FT, dnum, INK, "Entry number")

    def hbar(dl, nz, nx0, nx1):             # horizontal stroke
        zc = z_bot + nz * DH * FT
        tile(dl + (nx0 + nx1) / 2 * DW, (nx1 - nx0) * DW, zc - sz / 2, zc + sz / 2, dnum, INK, "Entry number")

    def narc(dl, ncx, ncy, nrx, nry, a0, a1, n=20):   # thick elliptical stroke band
        cxf, czm, rx, rzf = dl + ncx * DW, z_bot + ncy * DH * FT, nrx * DW, nry * DH
        rxi, rzi = max(0.01, rx - s), max(0.01, rzf - s)
        a0r, a1r = math.radians(a0), math.radians(a1)
        ang = [a0r + (a1r - a0r) * k / n for k in range(n + 1)]
        outer = [(cxf + rx * math.cos(t), czm + rzf * FT * math.sin(t)) for t in ang]
        inner = [(cxf + rxi * math.cos(t), czm + rzi * FT * math.sin(t)) for t in reversed(ang)]
        poly(outer + inner, dnum, INK, "Entry number")

    GLYPH = {
        "0": lambda dl: narc(dl, 0.5, 0.5, 0.42, 0.46, 0, 360),
        "5": lambda dl: (hbar(dl, 0.9, 0.12, 0.84), vbar(dl, 0.17, 0.5, 0.9),
                         hbar(dl, 0.52, 0.12, 0.6), narc(dl, 0.46, 0.28, 0.42, 0.30, 95, -150)),
        "6": lambda dl: (narc(dl, 0.5, 0.30, 0.40, 0.30, 0, 360),
                         narc(dl, 0.52, 0.52, 0.42, 0.45, 60, 205)),
    }
    for i, ch in enumerate(NUM):
        GLYPH[ch](x_left + i * (DW + gap))
    # 6) slim white wood rim around the transom (a shallow casing, not chunky)
    CW2 = 0.30
    tile(px, glaz_w + 2 * CW2, spring + glaz_h_m, spring + glaz_h_m + CW2 * FT, 0.04, TRIM, "Entry transom rail")
    tile(px, glaz_w + 2 * CW2, spring - CW2 * FT, spring, 0.04, TRIM, "Entry transom bar")
    for sx in (-1, 1):
        tile(px + sx * (glaz_w + CW2) / 2, CW2, spring, spring + glaz_h_m, 0.04, TRIM, "Entry transom stile")

    pil_w = 0.8                             # pilaster shaft width (ft)
    cap_w = pil_w + 0.4                      # plinth / capital wider than the shaft
    ent_h = 0.8                             # entablature height (ft)
    pil_off = dw_ft / 2 + 0.2 + pil_w / 2   # flank the door with a small reveal
    pil_h = dh + glaz_h + 0.3               # entablature underside clears the transom
    eW = 2 * (pil_off + pil_w / 2) + 0.6    # entablature / pediment width, with a cornice overhang (ft)
    ent_lo, ent_hi = base + pil_h * FT, base + (pil_h + ent_h) * FT

    for s in (-1, 1):                       # flanking pilasters with plinth + capital
        cxp = px + s * pil_off
        place("Entry pilaster", cxp, pil_w, PIL_D, base, base + pil_h * FT)
        place("Entry pilaster plinth", cxp, cap_w, PIL_D + 0.03, base, base + 0.6 * FT)
        place("Entry pilaster capital", cxp, cap_w, PIL_D + 0.05, base + (pil_h - 0.6) * FT, base + pil_h * FT)
        # fluting: three slender reeds up the shaft, between plinth and capital
        for ri in (-1, 0, 1):
            place("Entry pilaster flute", cxp + ri * 0.22, 0.1, PIL_D + 0.025,
                  base + 0.7 * FT, base + (pil_h - 0.7) * FT)

    place("Entry entablature", px, eW, ENT_D, ent_lo, ent_hi)

    # dentil course in the upper entablature, just under the cornice
    pitch_ft, dent_ft = 0.46, 0.23
    n = max(3, int(eW / pitch_ft))
    for i in range(n):
        place("Entry dentil", px + (i - (n - 1) / 2) * pitch_ft, dent_ft, ENT_D + 0.04,
              ent_hi - 0.13, ent_hi - 0.01)

    # keystone bridging the transom head up into the frieze, centred over the door
    place("Entry keystone", px, 0.7, ENT_D + 0.06, spring + glaz_h_m, ent_hi + 0.05)

    # shallow pediment on the entablature (height scaled to its width), with a
    # tablet in the tympanum
    z0, ph, half = ent_hi, (eW * 0.22) * FT, eW / 2 * FT
    y0, y1 = fy, fy + out * PED_D
    L, R, P = (ix - half, ix + half, ix)
    verts = [(L, y0, z0), (R, y0, z0), (P, y0, z0 + ph),
             (L, y1, z0), (R, y1, z0), (P, y1, z0 + ph)]
    faces = [[2, 1, 0], [3, 4, 5], [0, 1, 4, 3], [0, 3, 5, 2], [1, 2, 5, 4]]
    add_brep(ctx, "Entry pediment", verts, faces, TRIM, ifc_class="IfcBuildingElementProxy")
    place("Entry tympanum tablet", px, 1.4, PED_D + 0.04, z0 + 0.08, z0 + 0.08 + 0.4 * ph)

    # Flanking entry pendants: two large hanging lanterns just outside the
    # pilasters, hung from a wall bracket up near the entablature. Lighting
    # fixtures are procedural three.js meshes (never IFC box/cyl proxies), so we
    # record placements to the furniture manifest and skip IFC geometry here.
    # set each lantern in the gap between the pilaster capital (~2.7' out) and the
    # flanking front window (~6.6' out), pulled a touch toward the door surround.
    lamp_off = 3.9                            # offset from the door centre (ft)
    mount_z = base + (dh - 0.6) * FT          # bracket height (hung lower than the head)
    for s in (-1, 1):
        ctx.furniture.append({"type": "porch_pendant", "px": px + s * lamp_off,
                              "pz": pz, "y": round(mount_z, 4)})


def second_floor_windows(rooms):
    """(front_z, specs) for the second-floor windows. The North (front) row stacks
    one upper over each ground-floor front opening (already the even 5-bay
    rhythm); the West wall gets four equally-spaced uppers across its length. All
    graduated to 2.5' wide, sill 2.5' / head 6' above the second floor. Shared by
    the exterior massing's upper row and the second-floor shell so they stay in
    sync."""
    front_z = max(r["bounds"]["z2"] for r in rooms)   # North wall
    west_x = max(r["bounds"]["x2"] for r in rooms)     # West wall
    specs = []
    # North: one upper over each ground-floor front opening (windows + door)
    for r in rooms:
        for o in r.get("windows", []) + r.get("doors", []):
            if not o.get("opening") and o["orient"] == "H" and abs(o["fixed"] - front_z) < 1e-3:
                specs.append({"name": f"Upper - {o['name']}", "orient": "H", "fixed": front_z,
                              "pos": o["pos"], "width": 2.5, "sill": 2.5, "head": 6.0})
    # West: four equally-spaced uppers, inset from the corners so the end
    # windows aren't tight to them
    west_rooms = [r for r in rooms if abs(r["bounds"]["x2"] - west_x) < 1e-3]
    if west_rooms:
        margin = 1.0   # end windows ~3' off the corners (2.5' wide, so edge at z1+3)
        z1 = min(r["bounds"]["z1"] for r in west_rooms) + margin
        z2 = max(r["bounds"]["z2"] for r in west_rooms) - margin
        n = 4
        for i in range(n):
            specs.append({"name": f"Upper - West {i + 1}", "orient": "V", "fixed": west_x,
                          "pos": z1 + (i + 0.5) * (z2 - z1) / n,
                          "width": 2.5, "sill": 2.5, "head": 6.0})
    return front_z, specs


def add_shell_windows(ctx, rooms):
    """Cut the second-floor window openings into a shell, kept in sync with the
    exterior massing's upper row (same walls, positions, and size)."""
    _, specs = second_floor_windows(rooms)
    for w in specs:
        cut_opening(ctx, "IfcWindow", w["name"], w["orient"], w["fixed"], w["pos"],
                    w["width"], w["sill"], w["head"], leaf=True)


def add_fenestration(ctx, groups, rooms_cache, base=0.0):
    """Low-fidelity windows + exterior door openings on the massing faces. The
    per-room windows/doors are reused: an opening is exterior when one side of
    its wall is inside a room and the other is open air. Windows become glass
    panels at the authored sill/head, each with a classical trim surround;
    exterior doors become dark opening panels (floor to door head). The primary's
    front (North) face also gets a symmetric upper-floor window row aligned over
    the ground openings, plus a pedimented entry surround at the front door."""
    GLASS = (0.42, 0.52, 0.60)   # muted blue-grey glazing
    DOOR = (0.18, 0.16, 0.15)    # dark opening
    TRIM = (0.93, 0.92, 0.88)    # white window trim (casing / sill / muntins)
    DEPTH = 0.08                  # panel thickness (m)
    EPS = 0.35                    # plan feet just past the wall face
    CW = 0.5                      # casing board width (ft)

    grp_rooms = [s for g in groups.values() for s in g["rooms"]]
    rects = [rooms_cache[s]["bounds"] for s in grp_rooms]
    rects = [(b["x1"], b["x2"], b["z1"], b["z2"]) for b in rects]

    def inside(px, pz):
        return any(x1 - 1e-6 < px < x2 + 1e-6 and z1 - 1e-6 < pz < z2 + 1e-6 for x1, x2, z1, z2 in rects)

    def is_exterior(orient, fixed, pos):
        if orient == "V":
            return inside(fixed + EPS, pos) != inside(fixed - EPS, pos)
        return inside(pos, fixed + EPS) != inside(pos, fixed - EPS)

    def panel(ifc_class, name, orient, fixed, pos, w, sill_m, head_m, color):
        h = head_m - sill_m
        if h <= 0.05:
            return
        if orient == "V":   # wall runs along Z; width spans Y, thin in X
            p = make_box(ctx, ifc_class, name, DEPTH, abs(w) * FT, h,
                         ctx.X(fixed), ctx.Y(pos), sill_m, color=color)
        else:               # wall runs along X; width spans X, thin in Y
            p = make_box(ctx, ifc_class, name, abs(w) * FT, DEPTH, h,
                         ctx.X(pos), ctx.Y(fixed), sill_m, color=color)
        run("spatial.assign_container", ctx.model, products=[p], relating_structure=ctx.storey)

    def door_leaf(name, orient, fixed, pos, w_ft, z0, z1, style="panel", paint=None):
        """An architectural stile-and-rail door leaf, built from boxes on the
        wall face (the solid massing sits behind it). A backing slab carries the
        IfcDoor; frame members + panels/glazing add relief on top.
          - "panel"  -> a raised six-panel door (2 cols x 3 rows).
          - "8lite"  -> a divided-light glazed door (2 cols x 4 rows = 8 lites).
        Depths step outward (slab < panel/glass < frame < muntin) so panels read
        raised and the muntin grid sits proud of the glass. `paint` overrides the
        default stained-wood colour (e.g. "white" for a painted door)."""
        WOOD = {"white": (0.92, 0.92, 0.89)}.get(paint, (0.38, 0.24, 0.13))
        w, H = abs(w_ft), z1 - z0
        if H <= 0.1 or w <= 0:
            return
        STILE, TRAIL, BRAIL, MUN = 0.46, 0.46, 0.92, 0.10        # member sizes (ft)
        DSLAB, DPANE, DFRAME, DMUN = 0.09, 0.12, 0.15, 0.17      # depths (m)
        TRAILm, BRAILm = TRAIL * FT, BRAIL * FT                  # rails in metres (z-axis)

        def dbox(apos, alen, zlo, zhi, dep, color, cls="IfcBuildingElementProxy", nm=None):
            if zhi - zlo <= 0 or alen <= 0:
                return
            nm = nm or f"{name} part"
            if orient == "H":   # wall runs along X; member spans X, thin in Y
                b = make_box(ctx, cls, nm, alen * FT, dep, zhi - zlo,
                             ctx.X(apos), ctx.Y(fixed), zlo, color=color)
            else:               # wall runs along Z; member spans Y, thin in X
                b = make_box(ctx, cls, nm, dep, alen * FT, zhi - zlo,
                             ctx.X(fixed), ctx.Y(apos), zlo, color=color)
            run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

        # backing slab (the IfcDoor itself) covers the whole opening
        dbox(pos, w, z0, z1, DSLAB, WOOD, cls="IfcDoor", nm=name)
        fw = w - 2 * STILE                                       # inner field width (ft)
        # glazed doors (8-lite, patio) get thin rails so the glass runs top to
        # bottom; the panel door seats its panels on a heavier bottom rail.
        botm = (0.42 if style in ("8lite", "patio") else BRAIL) * FT  # bottom rail (m)
        fz0, fz1 = z0 + botm, z1 - TRAILm                        # inner field height (m)
        # frame relief (proud): stiles + top + bottom rails
        dbox(pos - (w - STILE) / 2, STILE, z0, z1, DFRAME, WOOD)
        dbox(pos + (w - STILE) / 2, STILE, z0, z1, DFRAME, WOOD)
        dbox(pos, fw, fz1, z1, DFRAME, WOOD)                     # top rail
        dbox(pos, fw, z0, fz0, DFRAME, WOOD)                     # bottom rail
        mh = MUN * FT / 2                                        # half muntin/rail thickness (m)
        if style == "8lite":
            # two columns of glass, each split into four lites top-to-bottom
            dbox(pos, fw, fz0, fz1, DPANE, GLASS)                # glazed field
            dbox(pos, MUN, fz0, fz1, DMUN, WOOD)                 # 1 vertical -> 2 cols
            for j in range(1, 4):                                # 3 horizontal -> 4 rows
                zc = fz0 + j * (fz1 - fz0) / 4
                dbox(pos, fw, zc - mh, zc + mh, DMUN, WOOD)
        elif style == "patio":
            # two leaves, each a single large glass pane (no muntins), meeting
            # at a centre post
            CP = 0.5                                             # centre meeting post (ft)
            dbox(pos, CP, fz0, fz1, DFRAME, WOOD)
            pane = (fw - CP) / 2                                 # one leaf's glass (ft)
            off = (CP + pane) / 2                                # pane centre from middle
            for cc in (pos - off, pos + off):
                dbox(cc, pane, fz0, fz1, DPANE, GLASS)
        else:                                                    # raised panelled door
            front = style == "front"
            MIDm = 0.5 * FT                                      # intermediate rail height (m)
            usable = fz1 - fz0 - 2 * MIDm
            # classic six-panel proportions: short top, tall middle, medium
            # bottom (the front door); plain thirds for ordinary panel doors.
            f0, f1, _ = (0.22, 0.44, 0.34) if front else (1 / 3, 1 / 3, 1 / 3)
            r1 = fz0 + usable * f0
            r2 = r1 + MIDm + usable * f1
            dbox(pos, MUN, fz0, fz1, DFRAME, WOOD)               # center mullion -> 2 cols
            dbox(pos, fw, r1, r1 + MIDm, DFRAME, WOOD)           # lower mid rail
            dbox(pos, fw, r2, r2 + MIDm, DFRAME, WOOD)           # upper mid rail
            colw = (fw - MUN) / 2                                # one panel column (ft)
            ins = 0.12                                           # panel inset (ft)
            # the front door shades its recessed panels darker and its molding
            # lighter so the paneling reads even in flat light.
            panelc = (0.74, 0.74, 0.72) if (front and paint == "white") else \
                     (0.30, 0.19, 0.10) if front else WOOD
            moldc = (0.99, 0.99, 0.97) if (front and paint == "white") else \
                    (0.49, 0.33, 0.19) if front else WOOD
            rows = ((fz0, r1), (r1 + MIDm, r2), (r2 + MIDm, fz1))
            for zlo, zhi in rows:
                for cc in (pos - (colw + MUN) / 2, pos + (colw + MUN) / 2):
                    mw = colw - 2 * ins                          # panel width (ft)
                    dbox(cc, mw, zlo + ins * FT, zhi - ins * FT, DPANE, panelc)  # raised panel
                    if front:
                        # applied bolection molding: a thin proud lip framing
                        # each raised panel (a classic front-door detail)
                        lip, pz0, pz1 = 0.06, zlo + ins * FT, zhi - ins * FT
                        dbox(cc, mw, pz1 - lip * FT, pz1, DMUN, moldc)          # top
                        dbox(cc, mw, pz0, pz0 + lip * FT, DMUN, moldc)          # bottom
                        dbox(cc - (mw - lip) / 2, lip, pz0, pz1, DMUN, moldc)   # left
                        dbox(cc + (mw - lip) / 2, lip, pz0, pz1, DMUN, moldc)   # right

    def window(name, orient, fixed, pos, w, sill_m, head_m, trim="full", muntins=True):
        """A glass panel with a classical surround + divided-light muntins. Trim
        styles distinguish the floors / facades:
          - "full" (side/rear ground): casing, a projecting sill + apron, and a
            projecting header cornice.
          - "lintel" (front ground): a flat lintel band + central keystone over a
            projecting sill + apron.
          - "upper": casing + a projecting sill (nothing below it) + a small
            cornice — lighter than the ground floor.
        A board/box runs along the wall axis (X for an H wall, Z for a V) and is
        centred on the wall face."""
        panel("IfcWindow", name, orient, fixed, pos, w, sill_m, head_m, GLASS)
        h = head_m - sill_m

        def tbox(nm, apos, alen, zlo, zhi, dep, color=TRIM):
            if zhi - zlo <= 0 or alen <= 0:
                return
            if orient == "H":   # wall along X; board spans X, `dep` is the Y depth
                b = make_box(ctx, "IfcBuildingElementProxy", nm, alen * FT, dep, zhi - zlo,
                             ctx.X(apos), ctx.Y(fixed), zlo, color=color)
            else:               # wall along Z; board spans Y, `dep` is the X depth
                b = make_box(ctx, "IfcBuildingElementProxy", nm, dep, alen * FT, zhi - zlo,
                             ctx.X(fixed), ctx.Y(apos), zlo, color=color)
            run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

        head_top = head_m + CW * FT
        # jambs + head casing are common to every style
        tbox(f"Casing - {name}", pos - (w + CW) / 2, CW, sill_m, head_top, 0.12)
        tbox(f"Casing - {name}", pos + (w + CW) / 2, CW, sill_m, head_top, 0.12)
        sill_bot = sill_m - 0.12
        if trim == "upper":
            # casing + a projecting sill (nothing below it) + a small cornice
            tbox(f"Casing - {name}", pos, w + 2 * CW, head_m, head_top, 0.12)
            tbox(f"Sill - {name}", pos, w + 2 * CW + 0.2, sill_m - 0.10, sill_m, 0.15)
            tbox(f"Header - {name}", pos, w + 2 * CW + 0.25, head_top, head_top + 0.08, 0.15)
        elif trim == "lintel":
            # flat lintel band + central keystone, over a projecting sill + apron
            lh = head_m + 0.6 * FT
            tbox(f"Lintel - {name}", pos, w + 2 * CW + 0.2, head_m, lh, 0.13)
            tbox(f"Keystone - {name}", pos, 0.55, head_m, lh + 0.28 * FT, 0.16)
            tbox(f"Sill - {name}", pos, w + 2 * CW + 0.3, sill_bot, sill_m, 0.18)
            tbox(f"Apron - {name}", pos, w, sill_bot - 0.22, sill_bot, 0.12)
        else:
            # full surround: head casing + projecting sill + apron + cornice
            tbox(f"Casing - {name}", pos, w + 2 * CW, head_m, head_top, 0.12)
            tbox(f"Sill - {name}", pos, w + 2 * CW + 0.3, sill_bot, sill_m, 0.18)
            tbox(f"Apron - {name}", pos, w, sill_bot - 0.22, sill_bot, 0.12)
            tbox(f"Header - {name}", pos, w + 2 * CW + 0.4, head_top, head_top + 0.12, 0.20)
        # divided lights: muntin grid sized to ~square panes (a picture window
        # can opt out for a single clear sheet)
        if not muntins:
            return
        cols = max(2, round(w / 1.3))
        rows = max(2, round((h / FT) / 1.4))
        for i in range(1, cols):
            tbox(f"Muntin - {name}", pos - w / 2 + i * (w / cols), 0.06, sill_m + 0.02, head_m - 0.02, 0.10)
        for j in range(1, rows):
            zc = sill_m + j * (h / rows)
            tbox(f"Muntin - {name}", pos, w, zc - 0.025, zc + 0.025, 0.10)

    prim = groups.get("primary")
    front_z = max((rooms_cache[s]["bounds"]["z2"] for s in prim["rooms"]), default=None) if prim else None
    for g in groups.values():
        for s in g["rooms"]:
            r = rooms_cache[s]
            for win in r.get("windows", []):
                o, f, p = win["orient"], win["fixed"], win["pos"]
                if not is_exterior(o, f, p):
                    continue
                # front ground-floor windows get a flat lintel + keystone head
                front = g is prim and o == "H" and front_z is not None and abs(f - front_z) < 1e-3
                window(win["name"], o, f, p, win["width"],
                       base + win["sill"] * FT, base + win["head"] * FT,
                       trim="lintel" if front else "full", muntins=win.get("muntins", True))
            for d in r.get("doors", []):
                if d.get("opening"):          # interior cased opening, skip
                    continue
                o, f, p = d["orient"], d["fixed"], d["pos"]
                if not is_exterior(o, f, p):
                    continue
                door_leaf(d["name"], o, f, p, d["width"], base, base + ctx.door_h_ft * FT,
                          d.get("doorStyle", "panel"), d.get("paint"))

    # Symmetric upper-floor window row + pedimented entry on the primary's front
    # (North) face. The front line is the primary's max plan z; place an upper
    # window over each ground-floor front opening (the two windows AND the door).
    # The upper windows are graduated — shorter and narrower than the ground
    # floor (a classic Georgian/Colonial device) — for a balanced, tapering grid.
    if prim:
        # Second-floor windows (front + west) — shared with the level2 shell.
        _, specs = second_floor_windows([rooms_cache[s] for s in prim["rooms"]])
        for w in specs:
            window(w["name"], w["orient"], w["fixed"], w["pos"], w["width"],
                   base + ctx.story + w["sill"] * FT, base + ctx.story + w["head"] * FT, trim="upper")
        door = next((o for s in prim["rooms"] for o in rooms_cache[s].get("doors", [])
                     if "Front Door" in o.get("name", "")), None)
        if door:
            add_entry(ctx, door["pos"], front_z, door["width"], base)

    add_kitchen_feature(ctx, rooms_cache, base)


def add_kitchen_feature(ctx, rooms_cache, base):
    """Make the kitchen picture window special: a standing-seam copper hood —
    shaped like the scullery's shed-with-hips, with 45° hipped ends — above the
    window cornice, and a white planter box (greenery on top) hung on the wall
    below, its top 6" beneath the glass."""
    kw = next((w for r in rooms_cache.values() for w in r.get("windows", [])
               if "Kitchen W (picture)" in w.get("name", "")), None)
    if kw is None:
        return
    COPPER, GREEN, BOX = (0.69, 0.43, 0.24), (0.30, 0.45, 0.26), (0.93, 0.92, 0.88)
    fx = ctx.X(kw["fixed"])
    out_x = -1.0 if ctx.X(kw["fixed"] + 1) < fx else 1.0   # outward (away from the wall)
    cy = ctx.Y(kw["pos"])
    sill_m = base + kw["sill"] * FT
    head_m = base + kw["head"] * FT

    # standing-seam copper hood shaped like the scullery's shed-with-hips: high at
    # the wall, sloping down to a front eave, the two ends hipped in (not gabled).
    proj, th = 2.0 * FT, 0.06                    # 24" projection
    drop = proj * (10 / 12)                      # 10/12 pitch (rise/run)
    hip = proj                                   # hip inset == projection -> 45° hip in plan
    z_lo = head_m + 1.1 * FT                      # eave kept above the window cornice top...
    z_hi = z_lo + drop                            # ...so the whole hood clears + covers the cornice
    hw = (kw["width"] / 2 + 1.5) * FT             # wide enough to cover the window + side trim
    ylo, yhi = cy - hw, cy + hw
    xf = fx + out_x * proj                   # front eave (projected out)
    top = [(xf, ylo, z_lo), (xf, yhi, z_lo),            # 0,1 front eave
           (fx, ylo, z_lo), (fx, yhi, z_lo),            # 2,3 wall, low (ends)
           (fx, ylo + hip, z_hi), (fx, yhi - hip, z_hi)]  # 4,5 ridge (inset)
    verts = top + [(x, y, z - th) for x, y, z in top]   # 6..11 soffit
    faces = [[4, 5, 1, 0], [2, 0, 4], [1, 3, 5], [2, 4, 5, 3],          # top: main slope, 2 hips, wall gable
             [10, 11, 7, 6], [8, 6, 10], [7, 9, 11], [8, 10, 11, 9],     # soffit
             [0, 1, 7, 6], [1, 3, 9, 7], [3, 2, 8, 9], [2, 0, 6, 8]]     # edges (front, sides, wall)
    add_brep(ctx, "Kitchen awning", verts, faces, COPPER, ifc_class="IfcBuildingElementProxy")
    # standing seams: raised ribs down the main slope (ridge -> front eave)
    rw, rh = 0.015, 0.04
    nseam = 6
    for k in range(nseam):
        u = (k + 0.5) / nseam
        ry = (ylo + hip) + u * (yhi - ylo - 2 * hip)
        ey = ylo + u * (yhi - ylo)
        fv = [(fx, ry - rw, z_hi), (fx, ry + rw, z_hi), (xf, ey - rw, z_lo), (xf, ey + rw, z_lo)]
        fv += [(x, y, z + rh) for x, y, z in fv]
        ff = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6]]
        add_brep(ctx, "Kitchen awning seam", fv, ff, COPPER, ifc_class="IfcBuildingElementProxy")

    # planter box on the wall below the sill: its top sits 6" below the glass,
    # with greenery filling the gap up to the glass.
    dining_sill = next((w["sill"] for r in rooms_cache.values() for w in r.get("windows", [])
                        if "Dining W" in w.get("name", "")), 2.5)
    box_top = sill_m - 0.5 * FT                  # 6" below the kitchen glass
    # bottom level with the dining windows' apron (sill 0.12 + apron 0.22 below
    # their glass), so the kitchen window assembly starts at the same height
    box_bot = base + dining_sill * FT - 0.34
    pdepth = 1.0 * FT
    pw = (kw["width"] / 2 - 0.25) * FT
    pcx = fx + out_x * pdepth / 2
    for nm, z0, hgt, col in (("Kitchen planter box", box_bot, box_top - box_bot, BOX),
                             ("Kitchen planter greenery", box_top, sill_m - box_top, GREEN)):
        b = make_box(ctx, "IfcBuildingElementProxy", nm, pdepth, 2 * pw, hgt, pcx, cy, z0, color=col)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)


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
                sill_ft, head_ft, leaf=True):
    """Cut an opening (door/window) into the host wall and add its filling.

    All inputs are in PLAN feet; the flip to IFC metres happens here.
    leaf=False makes a cased opening (a hole, no door panel) you can see through.
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
    if not leaf:
        return None  # cased opening: just the hole, no door panel
    fill = run("root.create_entity", m, ifc_class=fill_class, name=name)
    if hasattr(fill, "OverallHeight"):
        fill.OverallHeight = float(height)
    if hasattr(fill, "OverallWidth"):
        fill.OverallWidth = float(width_m)
    pd = 0.05
    prep = rect_rep(ctx, width_m, pd, height) if orient == "H" else rect_rep(ctx, pd, width_m, height)
    if fill_class == "IfcWindow":
        assign_color(ctx, prep, (0.6, 0.8, 0.92), transparency=0.7)  # see-through glass
    run("geometry.assign_representation", m, product=fill, representation=prep)
    run("geometry.edit_object_placement", m, product=fill, matrix=matrix(cx, cy, sill_m))
    run("feature.add_filling", m, opening=opening, element=fill)
    run("spatial.assign_container", m, products=[fill], relating_structure=ctx.storey)
    return fill


def add_doors(ctx, r):
    for d in r.get("doors", []):
        opening = d.get("opening", False)
        head = float(d.get("headFt", ctx.head_ft))   # tall built-in openings override the head
        cut_opening(ctx, "IfcDoor", d["name"], d["orient"], d["fixed"], d["pos"],
                    d["width"], 0.0, head, leaf=not opening)
        if opening:
            continue
        # Record hinge/swing for the viewer's swinging-leaf overlay.
        default_sign = -1 if d["orient"] == "H" else 1
        sw = d.get("swing")
        sign = default_sign if sw is None else (1 if str(sw) in ("pos", "+", "1") else -1)
        ctx.door_meta.append({
            "name": d["name"],
            "hingeMax": d.get("hinge", "min") == "max",
            "swingSign": sign,
        })


def add_windows(ctx, r):
    for w in r.get("windows", []):
        # Uniform head for every window (sills stay as authored).
        cut_opening(ctx, "IfcWindow", w["name"], w["orient"], w["fixed"], w["pos"],
                    w["width"], w["sill"], ctx.head_ft)
