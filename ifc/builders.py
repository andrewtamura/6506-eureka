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
        self.H = cfg["wallHeight"] * FT             # wall / ceiling height (m)
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
             long_name=None, predefined=None, color=None, rot=0.0):
    """Create a product with a centered rectangular extruded body at (cx,cy,cz).

    If ``color`` (r,g,b in 0..1) is given, the body is shaded that colour.
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
        assign_color(ctx, rep, color)
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


def add_brep(ctx, name, verts, faces, color, predefined=None, ifc_class="IfcRoof"):
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
        assign_color(ctx, rep, color)
    kwargs = {"ifc_class": ifc_class, "name": name}
    if predefined:
        kwargs["predefined_type"] = predefined
    product = run("root.create_entity", m, **kwargs)
    run("geometry.assign_representation", m, product=product, representation=rep)
    run("geometry.edit_object_placement", m, product=product, matrix=matrix(0, 0, 0))
    run("spatial.assign_container", m, products=[product], relating_structure=ctx.storey)
    return product


def _hip_solid(x1, x2, y1, y2, eave, pitch, oh=0.0):
    """Hip-roof closed solid over a rectangle. Ridge runs along the longer side;
    equal-pitch hips inset the ridge by half the short span. An overhang `oh`
    (m) extends every eave out past the walls, dropping the eave edge by
    oh*pitch (the slopes simply continue), which keeps the ridge height and the
    wall-top intersection unchanged. Returns verts,faces."""
    if oh:
        x1 -= oh; x2 += oh; y1 -= oh; y2 += oh
        eave -= oh * pitch
    w, d = x2 - x1, y2 - y1
    if w >= d:
        half = d / 2.0; hr = eave + half * pitch; yc = (y1 + y2) / 2.0
        verts = [(x1, y1, eave), (x2, y1, eave), (x2, y2, eave), (x1, y2, eave),
                 (x1 + half, yc, hr), (x2 - half, yc, hr)]
        faces = [[0, 1, 5, 4], [2, 3, 4, 5], [1, 2, 5], [3, 0, 4], [0, 1, 2, 3]]
    else:
        half = w / 2.0; hr = eave + half * pitch; xc = (x1 + x2) / 2.0
        verts = [(x1, y1, eave), (x2, y1, eave), (x2, y2, eave), (x1, y2, eave),
                 (xc, y1 + half, hr), (xc, y2 - half, hr)]
        faces = [[0, 1, 4], [2, 3, 5], [1, 2, 5, 4], [3, 0, 4, 5], [0, 1, 2, 3]]
    return verts, faces


def _shed_solid(x1, x2, y1, y2, eave, pitch, high):
    """Mono-pitch (shed) closed solid; `high` ('x1'|'x2'|'y1'|'y2') is the raised
    eave that abuts the taller structure, sloping down to the opposite side."""
    if high in ("x1", "x2"):
        run_len = x2 - x1; rise = run_len * pitch
        z = (lambda x: eave + rise - (x - x1) / run_len * rise) if high == "x1" \
            else (lambda x: eave + (x - x1) / run_len * rise)
        top = [(x1, y1, z(x1)), (x2, y1, z(x2)), (x2, y2, z(x2)), (x1, y2, z(x1))]
    else:
        run_len = y2 - y1; rise = run_len * pitch
        z = (lambda y: eave + rise - (y - y1) / run_len * rise) if high == "y1" \
            else (lambda y: eave + (y - y1) / run_len * rise)
        top = [(x1, y1, z(y1)), (x2, y1, z(y1)), (x2, y2, z(y2)), (x1, y2, z(y2))]
    base = [(x1, y1, eave), (x2, y1, eave), (x2, y2, eave), (x1, y2, eave)]
    verts = base + top
    faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
    return verts, faces


def _shedhip_solid(x1, x2, y1, y2, eave, pitch, high, hip):
    """Shed (mono-pitch) closed solid whose two flanking ends are HIPPED (sloped
    inward by `hip`) instead of gabled. `high` is the raised eave (abutting the
    taller structure); the surface slopes down to the opposite side."""
    base = [(x1, y1, eave), (x2, y1, eave), (x2, y2, eave), (x1, y2, eave)]  # 0,1,2,3
    if high in ("y1", "y2"):
        hi = eave + (y2 - y1) * pitch
        yh = y1 if high == "y1" else y2
        verts = base + [(x1 + hip, yh, hi), (x2 - hip, yh, hi)]              # 4,5
        if high == "y2":   # high at y2, slopes to y1; hips at x1 / x2
            faces = [[0, 1, 2, 3], [4, 5, 1, 0], [3, 0, 4], [1, 2, 5], [3, 2, 5, 4]]
        else:              # high at y1, slopes to y2
            faces = [[0, 1, 2, 3], [4, 5, 2, 3], [0, 3, 4], [2, 1, 5], [0, 1, 5, 4]]
    else:
        hi = eave + (x2 - x1) * pitch
        xh = x1 if high == "x1" else x2
        verts = base + [(xh, y1 + hip, hi), (xh, y2 - hip, hi)]              # 4,5
        if high == "x2":   # high at x2, slopes to x1; hips at y1 / y2
            faces = [[0, 1, 2, 3], [4, 5, 3, 0], [0, 1, 4], [3, 2, 5], [1, 2, 5, 4]]
        else:              # high at x1, slopes to x2
            faces = [[0, 1, 2, 3], [4, 5, 2, 1], [1, 0, 4], [2, 3, 5], [0, 3, 5, 4]]
    return verts, faces


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

    def union(ids):
        rects = [ifc_bounds(ctx, rooms_cache[s]["bounds"]) for s in ids]
        return (min(r[0] for r in rects), max(r[1] for r in rects),
                min(r[2] for r in rects), max(r[3] for r in rects))

    rects = {k: union(g["rooms"]) for k, g in groups.items()}
    prim = rects.get("primary")
    for key, g in groups.items():
        x1, x2, y1, y2 = rects[key]
        eave = g.get("storeys", 1) * ctx.H - g.get("trimFt", 0) * FT
        cx, cy, w, d = (x1 + x2) / 2, (y1 + y2) / 2, abs(x2 - x1), abs(y2 - y1)
        if crawl > 0:                              # foundation band, grade -> floor
            cb = make_box(ctx, "IfcSlab", f"Crawlspace - {key}", w, d, crawl, cx, cy, 0.0,
                          predefined="BASESLAB", color=FOUND)
            run("spatial.assign_container", ctx.model, products=[cb], relating_structure=ctx.storey)
        block = make_box(ctx, "IfcBuildingElementProxy", f"Massing - {key}",
                         w, d, eave, cx, cy, crawl, color=WALL)
        run("spatial.assign_container", ctx.model, products=[block], relating_structure=ctx.storey)

        ez = crawl + eave                          # roof springs from the (raised) wall top
        t = g["type"]
        if t == "hip":
            v, f = _hip_solid(x1, x2, y1, y2, ez, g.get("pitch", 0.5), g.get("overhangFt", 0) * FT)
            pd = "HIP_ROOF"
        elif t == "shed":
            v, f = _shed_solid(x1, x2, y1, y2, ez, g.get("pitch", 1 / 12), _high_edge(rects[key], prim))
            pd = "SHED_ROOF"
        else:  # "shedhip"
            v, f = _shedhip_solid(x1, x2, y1, y2, ez, g.get("pitch", 0.45), _high_edge(rects[key], prim), abs(y2 - y1))
            pd = "SHED_ROOF"
        add_brep(ctx, f"Roof - {key}", v, f, ROOF, predefined=pd)

    if crawl > 0:
        add_porch(ctx, rooms_cache, crawl)


def add_porch(ctx, rooms_cache, base):
    """A small straight-run front porch: a landing at the raised threshold and a
    straight flight of steps down to grade, projecting out from the front door."""
    fd = None
    for r in rooms_cache.values():
        for d in r.get("doors", []):
            if "Front Door" in d.get("name", ""):
                fd = d
        if fd:
            break
    if not fd:
        return
    # front door is an H wall (fixed = plan z, pos = plan x); the house is on the
    # -Y (interior) side of the face, so the porch projects to +Y (outward/North).
    ix, fy = ctx.X(fd["pos"]), ctx.Y(fd["fixed"])
    WOOD = (0.62, 0.60, 0.56)
    pw = (fd["width"] + 3.0) * FT     # landing a bit wider than the door
    pd = 3.5 * FT                     # landing depth
    landing = make_box(ctx, "IfcSlab", "Porch landing", pw, pd, base, ix, fy + pd / 2, 0.0, color=WOOD)
    run("spatial.assign_container", ctx.model, products=[landing], relating_structure=ctx.storey)
    nsteps, tread = 4, 0.28
    riser = base / nsteps
    for k in range(1, nsteps):        # descending treads out to grade
        h = base - k * riser
        step = make_box(ctx, "IfcSlab", f"Porch step {k}", pw * 0.8, tread, h,
                        ix, fy + pd + (k - 0.5) * tread, 0.0, color=WOOD)
        run("spatial.assign_container", ctx.model, products=[step], relating_structure=ctx.storey)


def add_fenestration(ctx, groups, rooms_cache, base=0.0):
    """Low-fidelity windows + exterior door openings on the massing faces. The
    per-room windows/doors are reused: an opening is exterior when one side of
    its wall is inside a room and the other is open air. Windows become glass
    panels at the authored sill/head; exterior doors become dark opening panels
    (floor to door head). Only the ground-floor openings are placed — the upper
    storeys aren't modelled yet, so they stay blank."""
    GLASS = (0.42, 0.52, 0.60)   # muted blue-grey glazing
    DOOR = (0.18, 0.16, 0.15)    # dark opening
    DEPTH = 0.08                  # panel thickness (m)
    EPS = 0.35                    # plan feet just past the wall face

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

    for g in groups.values():
        for s in g["rooms"]:
            r = rooms_cache[s]
            for win in r.get("windows", []):
                o, f, p = win["orient"], win["fixed"], win["pos"]
                if not is_exterior(o, f, p):
                    continue
                panel("IfcWindow", win["name"], o, f, p, win["width"],
                      base + win["sill"] * FT, base + win["head"] * FT, GLASS)
            for d in r.get("doors", []):
                if d.get("opening"):          # interior cased opening, skip
                    continue
                o, f, p = d["orient"], d["fixed"], d["pos"]
                if not is_exterior(o, f, p):
                    continue
                panel("IfcDoor", d["name"], o, f, p, d["width"], base, base + ctx.door_h_ft * FT, DOOR)


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
