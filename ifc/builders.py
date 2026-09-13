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
        self.subfloors = []                           # [{name, rgb}] plywood-sheet subfloors the viewer re-renders
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
        add_slab(ctx, r, opening=r.get("floorOpening"))   # e.g. a stairwell void
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
    rh = roof.get("usableHeadroomFt", 7.0) * FT       # 7 ft room-wall / usable-headroom height
    du0 = max(0.0, (rh - eave) / pitch)               # inset where the slope reaches the room height
    flat_z = roof.get("flatCeilFt") * FT if roof.get("flatCeilFt") else None  # flat ceiling cap
    t = ctx.T

    for r in rooms:                                   # floor over the whole footprint
        add_slab(ctx, r, opening=r.get("floorOpening"))   # e.g. the stairwell void

    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

    # --- dormer wells: the x-ranges (and the y-band on each slope) where the
    # dormers cut THROUGH the sloped ceiling, so each dormer opens into the attic
    # room (rather than being capped off by a flat soffit above the alcove).
    ds = roof.get("dormers") or {}
    nbays = [ctx.X(px) for px in (aligned_front_bays(rooms, ds.get("count", 3)) or [])] \
        if ds.get("align") == "bays" else []
    nwd = ds.get("widthFt", 3.5) * FT
    n_holes = [(b - nwd / 2, b + nwd / 2) for b in nbays]
    # N dormers recess back from the eave (y2); the well spans the recessed face
    # (ny1) back to where the cheeks die into the slope (ny0).
    n_plate = ds.get("plateFt", 4.0) * FT
    ny1 = y2 - ds.get("recessFt", 0.0) * FT           # recessed dormer face
    ny0 = ny1 - n_plate / pitch                        # cheek eaves die into the slope
    # dormer ridge (pitch == main) dies DEEPER into the slope, at the gable apex; the
    # well is a pentagon (front rect [ny0,ny1] + valley triangle [n_apex,ny0]).
    n_apex = ny0 - nwd / 2 if n_holes else None        # = ny1 - zR/pitch
    ss = roof.get("shedDormer") or {}
    s_holes = []
    s_gable = None
    s_plate = ss.get("plateFt", 5.0) * FT
    sy0 = y1 + ss.get("recessFt", 0.0) * FT           # recessed (south) dormer face
    sy1 = sy0 + s_plate / pitch                         # cheeks / springline die into the slope
    if ss:
        if ss.get("spanFt"):                          # align the dormer to the stairwell walls
            sW = ss["spanFt"] * FT
        else:
            shalf = min(x2 - x1, y2 - y1) / 2.0
            sW = max(2.0 * FT, (x2 - x1) - 2 * shalf - 2 * ss.get("marginFt", 0.5) * FT)
        s_holes = [(cx - sW / 2, cx + sW / 2)]
        # The wide S dormer VAULTS: its two pitched planes rise from the springline
        # (plate, tied to the flat ceiling) to a ridge and die into the main roof
        # along valleys — a raised, open ceiling like the N dormer pockets (max
        # headroom), not a flat soffit. The ceiling opens a GABLE PENTAGON: the sloped
        # band [sy0..sy1] full width, then a triangular notch through the FLAT ceiling
        # from sy1 back to where the ridge dies (s_apex), so the vault reads all the
        # way up. `s_apex` sits past the flat edge because the ridge rises above the
        # 8.5 ft flat ceiling (the dormer projects above the room's dropped ceiling).
        pp = ss.get("pedimentPitch", ss.get("pitch", 0.33))
        s_zR = s_plate + (sW / 2) * pp                 # dormer ridge height (rel eave base)
        s_apex = sy0 + s_zR / pitch                    # where that ridge dies into the roof
        s_gable = (sy0, sy1, s_apex, cx - sW / 2, cx + sW / 2)

    # E / W hip dormer GABLE wells (the x<->y mirror of the N dormer pentagons):
    # (face, cheek, apex, yL, yR) — face = recessed front line, cheek = where the
    # cheek eaves die into the slope, apex = where the dormer ridge dies in (the
    # gable valley converges there). The same gable component as the N dormers.
    hd = roof.get("hipDormers") or {}
    e_well = w_well = None
    if hd:
        hwd = hd.get("widthFt", 4.0) * FT
        hpl = hd.get("plateFt", 4.5) * FT
        hrc = hd.get("recessFt", 2.5) * FT
        hzR = hpl + (hwd / 2) * pitch                                       # dormer ridge height
        yL, yR = cy - hwd / 2, cy + hwd / 2
        xEe = x2 - hrc; e_well = (xEe, xEe - hpl / pitch, xEe - hzR / pitch, yL, yR)   # east hip
        xEw = x1 + hrc; w_well = (xEw, xEw + hpl / pitch, xEw + hzR / pitch, yL, yR)   # west hip

    # sloped ceiling = the hip underside, springing from the eave (z = eave), with
    # the dormer wells cut OPEN so each dormer reads up into the attic room.
    cv, cf = _hip_ceiling_with_wells(x1, x2, y1, y2, eave, pitch,
                                     n_holes, ny0, ny1, s_holes, sy0, sy1, e_well, w_well, n_apex, flat_z,
                                     s_gable=s_gable)
    # Translucent so the 3/4 exhibit view reads INTO the room (floor + walls show
    # through) — i.e. you can see the habitable volume under the slope.
    add_brep(ctx, "Attic ceiling", cv, cf, CEIL, ifc_class="IfcCovering",
             predefined="CEILING", transparency=0.55)

    if eave > 0:
        # raised plate: full-height perimeter (exterior) walls at the eave...
        for nm, bx, by, xd, yd in [
            ("Plate wall S", cx, y1, abs(x2 - x1) + t, t),
            ("Plate wall N", cx, y2, abs(x2 - x1) + t, t),
            ("Plate wall W", x1, cy, t, abs(y2 - y1) + t),
            ("Plate wall E", x2, cy, t, abs(y2 - y1) + t),
        ]:
            w = make_box(ctx, "IfcWall", nm, xd, yd, eave, bx, by, 0.0, color=KNEE)
            run("spatial.assign_container", ctx.model, products=[w], relating_structure=ctx.storey)
        # (No 36" knee wall: the sloped ceiling runs down to the floor at the eaves,
        # so the low <knee triangles read as open behind-the-knee space. The eave
        # plate wall above + the roof still enclose them, so no daylight leaks in.)
        # `d` (the half-thickness slope rise) is still used by the 7 ft room walls.
        d = pitch * t / 2

        # 7 ft ROOM WALLS at the usable-headroom line (where the slope first reaches
        # the room height), with an open ALCOVE at each dormer so the window seats
        # stay accessible. The low triangles (knee walls + dormers + seats) sit
        # behind them. The ring closes around the WHOLE usable rectangle (N/S/E/W);
        # the bathroom partition (viewer-rendered) divides it into bath + main room,
        # so both ends get the same 7 ft treatment.
        ru = du0                                          # usable inset (computed up top)
        rx1, rx2, ry1r, ry2r = x1 + ru, x2 - ru, y1 + ru, y2 - ru
        # openings exactly frame each dormer, so the alcove cheek walls land on the
        # SAME edges as the dormer's own cheeks (no offset gap between them).
        nh, sh = list(n_holes), list(s_holes)
        eh = [(e_well[3], e_well[4])] if e_well else []
        wh = [(w_well[3], w_well[4])] if w_well else []

        def roomwall(nm, orient, line, a, b, inner, holes):
            segs, cur = [], a
            for h0, h1 in sorted(holes):
                if h0 - cur > 0.05 * FT:
                    segs.append((cur, h0))
                cur = max(cur, h1)
            if b - cur > 0.05 * FT:
                segs.append((cur, b))
            for s0, s1 in segs:
                if orient == "H":
                    poly = [(s0, line + inner * t / 2, 0.0), (s0, line - inner * t / 2, 0.0),
                            (s0, line - inner * t / 2, rh - d), (s0, line + inner * t / 2, rh + d)]
                    vec = (s1 - s0, 0.0, 0.0)
                else:
                    poly = [(line + inner * t / 2, s0, 0.0), (line - inner * t / 2, s0, 0.0),
                            (line - inner * t / 2, s0, rh - d), (line + inner * t / 2, s0, rh + d)]
                    vec = (0.0, s1 - s0, 0.0)
                v, f = _prism(poly, vec)
                add_brep(ctx, nm, v, f, KNEE, ifc_class="IfcWall")
        roomwall("Room wall N", "H", ry2r, rx1, rx2, -1, nh)
        roomwall("Room wall S", "H", ry1r, rx1, rx2, +1, sh)
        roomwall("Room wall E", "V", rx2, ry1r, ry2r, -1, eh)
        roomwall("Room wall W", "V", rx1, ry1r, ry2r, +1, wh)

        # (No alcove cheeks for any dormer — each dormer (add_dormers / add_hip_dormer
        # / the S vaulted shed) builds its OWN two full-height cheek walls + gable
        # ceiling for style="interior", and its ceiling well is a matching gable
        # pentagon, so the alcove sides + vault come from the dormer itself.)
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

    # The USABLE rectangle: the floor finish boundary is pulled in to where
    # the sloped ceiling reaches a standing-headroom height (so the finished floor
    # marks the genuinely usable area; the low-headroom band by the knee wall is
    # subfloor). inset = (headroom - eave) / pitch from each footprint edge.
    du = max(0.0, (roof.get("usableHeadroomFt", 7.0) * FT - eave) / pitch)
    ctx.attic_usable = (x1 + du, x2 - du, y1 + du, y2 - du)

    if roof.get("dormers"):
        dspec = roof["dormers"]
        bay_xs = None
        if dspec.get("align") == "bays":
            pos = aligned_front_bays(rooms, dspec.get("count", 3))
            bay_xs = [ctx.X(px) for px in pos] if pos else None
        add_dormers(ctx, x1, x2, y1, y2, pitch, dspec, base_z=eave, style="interior", bay_xs=bay_xs)
    if roof.get("shedDormer"):
        add_shed_dormer(ctx, x1, x2, y1, y2, pitch, roof["shedDormer"], base_z=eave, style="interior")
    if hd:
        add_hip_dormer(ctx, x1, x2, y1, y2, pitch, hd, side="east", base_z=eave, style="interior")
        add_hip_dormer(ctx, x1, x2, y1, y2, pitch, hd, side="west", base_z=eave, style="interior")


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


def add_dormers(ctx, x1, x2, y1, y2, pitch, spec, base_z=0.0, style="interior", bay_xs=None):
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
    TRIM = (0.93, 0.92, 0.88)                        # white trim (keystone)
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
    barrel = spec.get("roof") == "barrel"             # half-round vault vs. gable end
    ty, tx, tz = 0.12, 0.10, 0.10                     # member thicknesses (m)

    # near-full-width bays: pull the outer dormers in just enough to keep the
    # configured plate (outer cheek run from the side eave >= plate / pitch), then
    # spread the rest evenly between them. Fall back to even bays + a shrunk plate
    # only if the footprint is too narrow even for that.
    plate = spec.get("plateFt", 6.0) * FT
    spacing = spec.get("spacingFt", 0.0) * FT         # if set: fixed centre-to-centre, centred
    m_req = plate / pitch + 0.20 * FT                  # run from a side eave to the outer cheek
    c_w, c_e = x1 + m_req + wd / 2, x2 - m_req - wd / 2
    if bay_xs:                                         # explicit centres (e.g. aligned to window bays)
        bays = list(bay_xs)
    elif spacing > 0:
        ctr = (x1 + x2) / 2
        bays = [ctr + (i - (count - 1) / 2.0) * spacing for i in range(count)]
    elif count == 1:
        bays = [(x1 + x2) / 2]
    elif c_e > c_w:
        bays = [c_w + i * (c_e - c_w) / (count - 1) for i in range(count)]
    else:                                             # too narrow: even bays, plate shrunk to fit
        span = x2 - x1
        bays = [x1 + (i + 0.5) * span / count for i in range(count)]
        cap = min(min(cx - wd / 2 - x1, x2 - (cx + wd / 2)) for cx in bays) * pitch
        plate = min(plate, cap - 0.20 * FT)
    # window sill: explicit `sillFt` (above the dormer base — base sits on the knee
    # wall, so sillFt=0 puts the sill at the knee-wall top) or auto under the gable.
    sill_spec = spec.get("window", {}).get("sillFt")
    if sill_spec is not None:
        wsill = max(0.0, sill_spec * FT)
        whead = min(plate - 0.40 * FT, wsill + wh)
    else:
        whead = plate - 0.40 * FT                      # leave a band under the gable
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
        # The dormer internalizes its OWN complete framing. INTERIOR walls run all the
        # way down to the attic FLOOR (z0); EXTERIOR walls start at the dormer base on
        # the roof (z0=0, i.e. base_z). z0 is local (the prism/box add base_z back).
        z0 = -base_z if style == "interior" else 0.0
        # front WINDOW WALL: jambs + an apron below the sill + a head, framing the glass.
        box(f"{nm} jamb W", xL, xWL, z0, plate, WALL)
        box(f"{nm} jamb E", xWR, xR, z0, plate, WALL)
        box(f"{nm} sill", xWL, xWR, z0, wsill, WALL)
        box(f"{nm} head", xWL, xWR, whead, plate, WALL)
        # glazing, set just proud of the wall face (north = +Y)
        box(f"{nm} window", xWL, xWR, wsill, whead, GLASS,
            cls="IfcWindow", cy=yN + ty / 2, dy=0.05, tr=0.45)
        # CHEEK (side) walls. Interior: a FULL side wall floor->plate (so the dormer is
        # a completely enclosed pocket). Exterior: just the triangle above the roof slope.
        if style == "interior":
            prism(f"{nm} cheek W", [(xL, yN, z0), (xL, y_p, z0), (xL, y_p, plate), (xL, yN, plate)], (tx, 0, 0), WALL)
            prism(f"{nm} cheek E", [(xR, yN, z0), (xR, y_p, z0), (xR, y_p, plate), (xR, yN, plate)], (-tx, 0, 0), WALL)
        else:
            prism(f"{nm} cheek W", [(xL, yN, 0.0), (xL, yN, plate), (xL, y_p, plate)], (tx, 0, 0), WALL)
            prism(f"{nm} cheek E", [(xR, yN, 0.0), (xR, yN, plate), (xR, y_p, plate)], (-tx, 0, 0), WALL)
        if barrel and style != "interior":
            # half-round BARREL (exterior only): an arched front tympanum + a curved
            # vault roof springing from the cheek tops (plate) and dying into the slope.
            R, N = wd / 2, 14
            yF = yN + 0.75 * FT                         # eave: barrel overhangs the glass face by >=6"
            arc = []
            for i in range(N + 1):
                th = math.pi * i / N
                ax = cx - R * math.cos(th)
                az = plate + R * math.sin(th)          # height above base (springs from plate)
                ay = yN - az / pitch                    # where that height dies into the slope
                arc.append((ax, az, ay))
            prism(f"{nm} tympanum", [(ax, yN, az) for ax, az, ay in arc], (0, ty, 0), WALL)
            for i in range(N):
                ax0, az0, ay0 = arc[i]
                ax1, az1, ay1 = arc[i + 1]
                prism(f"{nm} barrel {i}", [(ax0, yF, az0), (ax1, yF, az1),
                      (ax1, ay1, az1), (ax0, ay0, az0)], (0, 0, tz), ROOF, cls="IfcRoof")
            zc = plate + R
            kb, kt = zc - 0.7 * FT, zc + 0.30 * FT
            wb, wt = 0.28 * FT, 0.42 * FT
            prism(f"{nm} keystone", [(cx - wb, yN, kb), (cx + wb, yN, kb),
                  (cx + wt, yN, kt), (cx - wt, yN, kt)], (0, ty + 0.10, 0), TRIM)
        else:
            # GABLE roof: a front gable triangle (above the window head) + two pitched
            # roof planes that run back and DIE INTO THE MAIN ROOF along the valleys —
            # the cheek eaves die at y_p, the ridge runs deeper and dies at y_r. This
            # is an authentic gable-into-roof junction (no flat back wall): the
            # connection into the main roof reads as a real valley, not a dark gable
            # end. The ceiling well is cut to the matching gable (pentagon) outline.
            prism(f"{nm} gable", [(xL, yN, plate), (xR, yN, plate), (cx, yN, zR)], (0, ty, 0), WALL)
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
    # spanFt aligns the dormer to a specific width (e.g. the stairwell walls below);
    # otherwise it fills the central ridge run less a margin each end.
    W_s = spec["spanFt"] * FT if spec.get("spanFt") else max(2.0 * FT, ridge_len - 2 * margin)
    xa, xb = cx - W_s / 2, cx + W_s / 2
    rooftype = spec.get("roof", "shed")
    P = spec.get("plateFt", 7.0) * FT                  # front-wall / flat-roof / cornice height (rel. eave)
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

    if rooftype == "pediment":
        # classical pedimented dormer: a window range under a horizontal cornice,
        # a low triangular pediment over it, and a PITCHED gable roof behind that
        # valleys cleanly into the main slope (no flat-roof / steep-slope clash).
        pp = spec.get("pedimentPitch", 0.33)           # shallow classical pediment slope
        plate = P                                       # springline / cornice line
        zR = plate + (W_s / 2) * pp                      # pediment peak = dormer ridge (rel base)
        y_p = yS + plate / pitch                         # cheek (springline) dies into main slope
        y_r = yS + zR / pitch                            # ridge dies into main slope
        whead = min(plate - 0.3 * FT, wsill + wh)
        wall_top = plate
        # cheeks (side walls): triangles whose lower edge rides the main roof slope,
        # so they sit ON the sloped ceiling (above the roof line only) and frame the
        # dormer pocket — they must NOT drop below the slope into the attic space.
        if style != "interior":   # exterior only; the alcove's flat drywall cheeks form the interior sides
            prism("Shed dormer cheek W", [(xa, yS, 0.0), (xa, yS, plate), (xa, y_p, plate)], (tx, 0, 0), WALL)
            prism("Shed dormer cheek E", [(xb, yS, 0.0), (xb, yS, plate), (xb, y_p, plate)], (-tx, 0, 0), WALL)
        if style == "interior":
            # inside the attic the dormer opens into a VAULTED gable ceiling: the two
            # pitched planes rise from the springline (plate) at the cheeks to the
            # ridge (zR) and DIE INTO THE MAIN SLOPE along the valleys (like the N
            # dormers), so the bay keeps maximum headroom and the ceiling drops to the
            # main roofline instead of a flat soffit. Full-height cheek walls enclose
            # the sides up to the springline; the gable triangle closes the front.
            z0 = -base_z
            prism("Shed dormer cheek W", [(xa, yS, z0), (xa, y_p, z0), (xa, y_p, plate), (xa, yS, plate)], (tx, 0, 0), WALL)
            prism("Shed dormer cheek E", [(xb, yS, z0), (xb, y_p, z0), (xb, y_p, plate), (xb, yS, plate)], (-tx, 0, 0), WALL)
            prism("Shed dormer ceiling W", [(xa, yS, plate), (cx, yS, zR), (cx, y_r, zR), (xa, y_p, plate)],
                  (0, 0, tz), ROOF, cls="IfcCovering")
            prism("Shed dormer ceiling E", [(xb, yS, plate), (cx, yS, zR), (cx, y_r, zR), (xb, y_p, plate)],
                  (0, 0, tz), ROOF, cls="IfcCovering")
            prism("Shed dormer gable inner", [(xa, yS, plate), (xb, yS, plate), (cx, yS, zR)], (0, ty, 0), WALL)
            # valley infill: past the springline the ridge rises ABOVE the flat ceiling,
            # so each valley edge (springline -> ridge) needs a thin vertical triangle
            # closing the gap between the flat-ceiling notch edge (at `plate`) and the
            # rising valley — otherwise the room reads through to the void above.
            for sx in (xa, xb):
                dxv, dyv = cx - sx, y_r - y_p
                L = math.hypot(dxv, dyv) or 1.0
                nvec = (-dyv / L * 0.05, dxv / L * 0.05, 0.0)
                prism("Shed dormer valley wall", [(sx, y_p, plate), (cx, y_r, plate), (cx, y_r, zR)], nvec, WALL)
        else:
            # gable roof: two planes meeting at the ridge, dying into the main slope
            prism("Shed dormer roof W", [(xa, yS, plate), (cx, yS, zR), (cx, y_r, zR), (xa, y_p, plate)],
                  (0, 0, tz), ROOF, cls="IfcRoof")
            prism("Shed dormer roof E", [(xb, yS, plate), (cx, yS, zR), (cx, y_r, zR), (xb, y_p, plate)],
                  (0, 0, tz), ROOF, cls="IfcRoof")
            # pediment face (tympanum) + classical cornices: a horizontal cornice over
            # the windows and a raking cornice up each slope, framing the triangle.
            prism("Pediment tympanum", [(xa, yS, plate), (xb, yS, plate), (cx, yS, zR)], (0, ty, 0), WALL)
            box("Pediment cornice", xa - 0.2, xb + 0.2, plate - 0.18, plate + 0.06, TRIM, cy=yS - 0.09, dy=ty + 0.34)
            for sx in (xa, xb):
                prism("Pediment rake", [(sx, yS, plate + 0.06), (cx, yS, zR + 0.06),
                      (cx, yS, zR - 0.16), (sx, yS, plate - 0.16)], (0, -0.18, 0), TRIM)
            # cornice returns: the eave cornice turns each bottom corner and runs a
            # short way back along the cheek, then stops (classic pedimented gable)
            ret = 0.9 * FT
            for sx, sgn in ((xa, -1.0), (xb, 1.0)):
                prism("Pediment cornice return", [(sx, yS, plate + 0.06), (sx, yS + ret, plate + 0.06),
                      (sx, yS + ret, plate - 0.18), (sx, yS, plate - 0.18)], (0.30 * sgn, 0, 0), TRIM)
            # acroterion at the apex: a small plinth carrying a pyramidal finial
            box("Pediment acroterion plinth", cx - 0.16, cx + 0.16, zR + 0.04, zR + 0.40,
                TRIM, cy=yS - 0.06, dy=ty + 0.20)
            fz0, fyc, hx, hy = zR + 0.40 + base_z, yS - 0.06, 0.18, 0.16
            av = [(cx - hx, fyc - hy, fz0), (cx + hx, fyc - hy, fz0), (cx + hx, fyc + hy, fz0),
                  (cx - hx, fyc + hy, fz0), (cx, fyc, fz0 + 0.34)]
            add_brep(ctx, "Pediment acroterion", av,
                     [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
                     TRIM, ifc_class="IfcBuildingElementProxy")
    elif rooftype == "pyramid":
        # square HIPPED cap: four slopes rising from the plate to a single apex
        # (a pavilion roof). Interior gets a flat ceiling at the plate, like the
        # pediment; the pyramid itself is an exterior-only feature.
        plate = P
        y_p = yS + plate / pitch                         # cheek / back die into the main slope
        whead = min(plate - 0.3 * FT, wsill + wh)
        wall_top = plate
        if style != "interior":
            prism("Shed dormer cheek W", [(xa, yS, 0.0), (xa, yS, plate), (xa, y_p, plate)], (tx, 0, 0), WALL)
            prism("Shed dormer cheek E", [(xb, yS, 0.0), (xb, yS, plate), (xb, y_p, plate)], (-tx, 0, 0), WALL)
        if style == "interior":
            prism("Shed dormer ceiling", [(xa, yS, plate), (xb, yS, plate), (xb, y_p, plate), (xa, y_p, plate)],
                  (0, 0, tz), ROOF, cls="IfcCovering")
        else:
            ph = (y_p - yS) / 2 * pitch                  # apex rise (front/back slopes at the main pitch)
            ax, ay, az = cx, (yS + y_p) / 2, plate + ph
            for nm, p0, p1 in (("Pyramid roof S", (xa, yS, plate), (xb, yS, plate)),
                               ("Pyramid roof N", (xb, y_p, plate), (xa, y_p, plate)),
                               ("Pyramid roof W", (xa, y_p, plate), (xa, yS, plate)),
                               ("Pyramid roof E", (xb, yS, plate), (xb, y_p, plate))):
                prism(nm, [p0, p1, (ax, ay, az)], (0, 0, tz), ROOF, cls="IfcRoof")
    elif rooftype == "flat":
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

    # front wall (faces south): full-width sill + head bands, a window ribbon
    # between. Distribute the windows across the (possibly widened) span with EVEN
    # jambs/mullions so they always fit the dormer — its span may have been
    # stretched to align with the stairwell walls below. Cap the glass at the spec
    # width and let any surplus widen the jambs evenly (rather than leaving the
    # fixed-width windows nearly touching).
    mull = win.get("mullionFt", 0.5) * FT              # minimum jamb around/between windows
    fit = (W_s - (nwin + 1) * mull) / nwin             # widest glass that fits with that jamb
    ww = max(0.8 * FT, min(ww, fit))
    gap = (W_s - nwin * ww) / (nwin + 1)               # equal jamb, left over
    box("Shed dormer sill", xa, xb, 0.0, wsill, WALL)
    box("Shed dormer head", xa, xb, whead, wall_top, WALL)
    edge = xa
    for i in range(nwin):
        wl = xa + gap + i * (ww + gap)
        wr = wl + ww
        box(f"Shed dormer jamb {i}", edge, wl, wsill, whead, WALL)
        box(f"Shed dormer window {i + 1}", wl, wr, wsill, whead, GLASS,
            cls="IfcWindow", cy=yS - ty / 2, dy=0.05, tr=0.45)
        edge = wr
    box("Shed dormer jamb end", edge, xb, wsill, whead, WALL)


def add_hip_dormer(ctx, x1, x2, y1, y2, pitch, spec, side="east", base_z=0.0, style="interior"):
    """A single GABLE dormer on an END-HIP slope (`side`='east'|'west'), facing out
    along x — the x<->y mirror of add_dormers. Front gable wall with a window, two
    cheek walls riding the hip slope, and a gable roof dying into the slope. Serves
    the attic exhibit (base_z=eave, light) and the exterior massing (base_z=eave
    elevation, charcoal)."""
    WALL = (0.87, 0.86, 0.83)
    ROOF = (0.30, 0.30, 0.33) if style == "exterior" else (0.93, 0.92, 0.90)
    GLASS = (0.42, 0.52, 0.60)
    TRIM = (0.93, 0.92, 0.88)                           # white trim (keystone)
    barrel = spec.get("roof") == "barrel"
    recess = spec.get("recessFt", 2.5) * FT
    east = side == "east"
    xE = (x2 - recess) if east else (x1 + recess)      # recessed front-wall line (IFC x)
    sgn = -1.0 if east else 1.0                         # toward the apex (up the slope)
    out = 1.0 if east else -1.0                         # outward (down the slope)
    base_z = base_z + pitch * recess
    cy = (y1 + y2) / 2.0
    wd = spec.get("widthFt", 4.0) * FT
    ww = spec.get("window", {}).get("widthFt", 3.0) * FT
    wh = spec.get("window", {}).get("heightFt", 3.0) * FT
    plate = spec.get("plateFt", 6.0) * FT
    ty, tx, tz = 0.12, 0.10, 0.10
    sill_spec = spec.get("window", {}).get("sillFt")
    if sill_spec is not None:
        wsill = max(0.0, sill_spec * FT)
        whead = min(plate - 0.40 * FT, wsill + wh)
    else:
        whead = plate - 0.40 * FT
        wsill = max(0.8 * FT, whead - wh)
    yL, yR = cy - wd / 2, cy + wd / 2
    yWL, yWR = cy - ww / 2, cy + ww / 2
    zR = plate + (wd / 2) * pitch
    x_p = xE + sgn * plate / pitch                      # cheek eaves die into the slope
    x_r = xE + sgn * zR / pitch                         # dormer ridge dies into the slope
    nm = f"Hip dormer {side}"

    def prism(name, poly, vec, color, cls="IfcWall", tr=0.0):
        v, f = _prism([(p[0], p[1], p[2] + base_z) for p in poly], vec)
        add_brep(ctx, name, v, f, color, ifc_class=cls, transparency=tr)

    def box(name, ya, yb, za, zb, color, cls="IfcWall", cxf=None, dx=ty, tr=0.0):
        if yb - ya <= 1e-6 or zb - za <= 1e-6:
            return
        p = make_box(ctx, cls, name, dx, yb - ya, zb - za,
                     (xE if cxf is None else cxf), (ya + yb) / 2, za + base_z, color=color, transparency=tr)
        run("spatial.assign_container", ctx.model, products=[p], relating_structure=ctx.storey)

    # The dormer internalizes its OWN complete framing (the same gable component as
    # the N dormers, mirrored x<->y). INTERIOR walls run to the attic FLOOR (z0);
    # EXTERIOR walls start at the dormer base on the roof. z0 is local (+base_z added).
    z0 = -base_z if style == "interior" else 0.0
    # front gable wall (faces out along x): a frame around the glazed opening
    box(f"{nm} jamb S", yL, yWL, z0, plate, WALL)
    box(f"{nm} jamb N", yWR, yR, z0, plate, WALL)
    box(f"{nm} sill", yWL, yWR, z0, wsill, WALL)
    box(f"{nm} head", yWL, yWR, whead, plate, WALL)
    box(f"{nm} window", yWL, yWR, wsill, whead, GLASS, cls="IfcWindow", cxf=xE + out * ty / 2, dx=0.05, tr=0.45)
    # CHEEK (side) walls. Interior: a FULL side wall floor->plate (a completely enclosed
    # pocket). Exterior: just the triangle above the roof slope.
    if style == "interior":
        prism(f"{nm} cheek S", [(xE, yL, z0), (x_p, yL, z0), (x_p, yL, plate), (xE, yL, plate)], (0, tx, 0), WALL)
        prism(f"{nm} cheek N", [(xE, yR, z0), (x_p, yR, z0), (x_p, yR, plate), (xE, yR, plate)], (0, -tx, 0), WALL)
    else:
        prism(f"{nm} cheek S", [(xE, yL, 0.0), (xE, yL, plate), (x_p, yL, plate)], (0, tx, 0), WALL)
        prism(f"{nm} cheek N", [(xE, yR, 0.0), (xE, yR, plate), (x_p, yR, plate)], (0, -tx, 0), WALL)
    if barrel and style != "interior":
        # half-round BARREL vault (same as the north dormers): arched tympanum +
        # curved vault springing from the cheek tops, dying into the main slope.
        R, N = wd / 2, 14
        xF = xE + out * 0.75 * FT                       # eave: barrel overhangs the glass face
        arc = []
        for i in range(N + 1):
            th = math.pi * i / N
            ay = cy - R * math.cos(th)
            az = plate + R * math.sin(th)
            ax = xE + sgn * az / pitch                  # where that height dies into the slope
            arc.append((ay, az, ax))
        prism(f"{nm} tympanum", [(xE, ay, az) for ay, az, ax in arc], (out * ty, 0, 0), WALL)
        for i in range(N):
            ay0, az0, ax0 = arc[i]
            ay1, az1, ax1 = arc[i + 1]
            prism(f"{nm} barrel {i}", [(xF, ay0, az0), (xF, ay1, az1),
                  (ax1, ay1, az1), (ax0, ay0, az0)], (0, 0, tz), ROOF, cls="IfcRoof")
        zc = plate + R
        kb, kt = zc - 0.7 * FT, zc + 0.30 * FT
        wb, wt = 0.28 * FT, 0.42 * FT
        prism(f"{nm} keystone", [(xE, cy - wb, kb), (xE, cy + wb, kb),
              (xE, cy + wt, kt), (xE, cy - wt, kt)], (out * (ty + 0.10), 0, 0), TRIM)
    else:
        # gable end + two roof planes meeting at the dormer ridge
        prism(f"{nm} gable", [(xE, yL, plate), (xE, yR, plate), (xE, cy, zR)], (out * ty, 0, 0), WALL)
        prism(f"{nm} roof S", [(xE, yL, plate), (xE, cy, zR), (x_r, cy, zR), (x_p, yL, plate)], (0, 0, tz), ROOF, cls="IfcRoof")
        prism(f"{nm} roof N", [(xE, yR, plate), (xE, cy, zR), (x_r, cy, zR), (x_p, yR, plate)], (0, 0, tz), ROOF, cls="IfcRoof")
    # return the ceiling-well rectangle (x-range toward the apex, y-range = dormer width)
    return (min(xE, x_p), max(xE, x_p), yL, yR)


def lot_lines(lot, bounds, half_wall_ft):
    """The four property lines, in plan feet, for an iterable of room `bounds`.

    The parcel is anchored to the BUILDING rather than the other way round:

        west   `westMarginFt` outside the house's west wall
        east   `widthFt` in from the west line
        south  `scullerySouthFt` off the scullery's south wall
        north  set by the FRONT YARD rather than by a parcel depth:
               `frontage.northYardFt` of clear ground between the outer FACE of
               the north exterior wall and the near face of the retaining wall
               standing on the line

    Room bounds are wall CENTRELINES, so `half_wall_ft` (half the house's wall
    thickness) is what turns the north bound into the north wall's face. Parcel
    depth is therefore derived, and comes back as the fifth value so the lot
    plane can be sized from it.
    """
    f = lot.get("frontage") or {}
    pxs = [v for r in bounds for v in (r["x1"], r["x2"])]
    pzs = [v for r in bounds for v in (r["z1"], r["z2"])]
    west = max(pxs) + lot["westMarginFt"]
    east = west - lot["widthFt"]
    south = min(pzs) - lot["scullerySouthFt"]
    north = (max(pzs) + half_wall_ft                     # north wall's outer face
             + f.get("northYardFt", 10)                  # clear front yard
             + f.get("wallThicknessIn", 10) / 12.0)      # retaining wall thickness
    return west, east, south, north, north - south


def rects_minus(rects, hole):
    """Each (x1, x2, z1, z2) in `rects`, split around `hole`. Plan feet, axis-aligned.

    At most four pieces per rect: the bands south and north of the hole, then the two
    side strips level with it. This exists so a hole in the deck is a PUNCH rather than
    another hand-written split — `add_deck` used to carry one pair of hard-coded rects
    per notch, which is why adding a third opening meant re-deriving all of them."""
    hx1, hx2 = min(hole[0], hole[1]), max(hole[0], hole[1])
    hz1, hz2 = min(hole[2], hole[3]), max(hole[2], hole[3])
    out = []
    for x1, x2, z1, z2 in rects:
        a1, a2 = min(x1, x2), max(x1, x2)
        b1, b2 = min(z1, z2), max(z1, z2)
        if hx2 <= a1 + 1e-9 or hx1 >= a2 - 1e-9 or hz2 <= b1 + 1e-9 or hz1 >= b2 - 1e-9:
            out.append((a1, a2, b1, b2))                 # no overlap
            continue
        cx1, cx2 = max(a1, hx1), min(a2, hx2)             # hole clipped to this rect
        cz1, cz2 = max(b1, hz1), min(b2, hz2)
        if cz1 > b1 + 1e-9:
            out.append((a1, a2, b1, cz1))
        if cz2 < b2 - 1e-9:
            out.append((a1, a2, cz2, b2))
        if cx1 > a1 + 1e-9:
            out.append((a1, cx1, cz1, cz2))
        if cx2 < a2 - 1e-9:
            out.append((cx2, a2, cz1, cz2))
    return out


EXT_WING = ("ext_bath", "wc", "ext_vestibule", "ext_laundry")   # the house's east extension
YARD_POST_FT = 0.5                                              # the yard fence's 6 in square posts


def wing_bays(rooms_cache):
    """The east wing's north wall, split into the bays the ROOMS behind it already make:
    a sorted list of plan-x edges, east first (px increases west).

    Shared because the elevation and the porch have to agree on it. The wall's centreline
    is the bath/vestibule party wall; an awning authored 6 in too wide straddled that line
    and drove through a member standing on it — a collision neither builder could see on
    its own, because each was measuring from a different end of the same wall. The member
    it hit has since gone, but the awning still takes its width from the bay rather than
    from a number, which is what kept the two in step."""
    B = {k: v["bounds"] for k, v in rooms_cache.items() if k in EXT_WING}
    if not B:
        return []
    wall_z = max(max(b["z1"], b["z2"]) for b in B.values())
    front = [b for b in B.values() if abs(max(b["z1"], b["z2"]) - wall_z) < 1e-6]
    return sorted({v for b in front for v in (b["x1"], b["x2"])})


def yard_fence_line(rooms_cache, half_wall_ft):
    """(line, x_start) for the rear-yard fence, in plan feet: the east wing's north
    wall FACE, and the wing's NE corner where the run begins before heading east.

    Bounds are wall CENTRELINES, so the bound itself would leave that corner half a
    wall proud of the fence. Shared for the same reason `deck_extent` is shared: the
    side porch lands on this very corner and its deck has to notch around the terminal
    post, and a line re-derived in two places is how a fence quietly stops meeting the
    thing it dies into."""
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    line = max(max(B[k]["z1"], B[k]["z2"]) for k in EXT_WING if k in B) + half_wall_ft
    x_start = min(min(B[k]["x1"], B[k]["x2"]) for k in EXT_WING if k in B)
    return line, x_start




def deck_extent(rooms_cache, lot, half_wall_ft):
    """The rear deck's four outer edges, in plan feet: (west, east, south, north).

    Derived here rather than inside `add_deck` because three other builders have to
    agree with it. The CMU lot wall's south leg and the picket fence both used to stop
    at the scullery's west wall; with the deck now running past that — and with every
    guard rail gone — the last few feet of deck edge would back onto a 36 in picket
    fence 8 in further south, which is a 30 in drop with a 6 in lip. The yard fence
    needs the same north line the terrace stops on.

    Only the WEST edge is a setback, authored as a clearance in `lot.deck`. South and
    east both die on the CMU lot wall's inner face — the deck runs to the SE corner.
    North is the EXISTING deck's north edge, the family room's south wall: taken any
    further north the terrace climbs the side of the house toward the front and the
    yard stops being private, which is the whole reason it stops here."""
    f = lot.get("deck") or {}
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    west, east, south, _, _ = lot_lines(lot, B.values(), half_wall_ft)
    wall_t = 8 / 12
    return (west - f.get("westClearFt", 15),
            east + wall_t,
            south + wall_t,
            min(B["family"]["z1"], B["family"]["z2"]))


def add_lot(ctx, lot, rooms):
    """A flat lot plane `widthFt` wide, positioned so the building sits
    `westMarginFt` inside the west line (west = +plan x) and the scullery
    `scullerySouthFt` off the south line (south = min plan z). Depth follows
    from the front yard — see lot_lines."""
    west, east, south, north, depth = lot_lines(
        lot, [r["bounds"] for r in rooms], ctx.T / FT / 2)
    cx, cz = (west + east) / 2, (south + north) / 2
    lotmesh = make_box(ctx, "IfcSlab", "Lot",
                       lot["widthFt"] * FT, depth * FT, 0.1,
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


def _hip_ceiling_with_wells(x1, x2, y1, y2, eave, pitch, n_wells, ny0, ny1, s_wells, sy0, sy1,
                            e_well=None, w_well=None, n_apex=None, flat_z=None, s_gable=None):
    """Hip-roof soffit (w>=d) decomposed into panels with dormer-well HOLES. The N
    slope gets GABLE (pentagon) wells (`n_wells` x-ranges, cheek line ny0, face ny1,
    ridge apex `n_apex`); the S slope rectangular wells (`s_wells` over [sy0,sy1]);
    and the E / W hips matching GABLE wells (`e_well` / `w_well` =
    (face, cheek, apex, yL, yR)). When `s_gable=(sy0, sy1, s_apex, xa, xb)` is given
    the wide S dormer VAULTS above the flat ceiling: the S slope opens fully over
    [sy0,sy1] (springline) and a TRIANGULAR notch is cut through the flat ceiling
    from sy1 back to the ridge apex, so the raised gable ceiling reads all the way up.
    Returns (verts, faces) for a one-sided (DoubleSide) surface, so the attic room
    reads up into each dormer."""
    yc = (y1 + y2) / 2.0
    half = (y2 - y1) / 2.0
    verts, faces = [], []

    def panel(corners, zf):
        idx = []
        for (px, py) in corners:
            verts.append((px, py, zf(px, py))); idx.append(len(verts) - 1)
        faces.append(idx)

    zN = lambda x, y: eave + pitch * (y2 - y)
    zS = lambda x, y: eave + pitch * (y - y1)
    zE = lambda x, y: eave + pitch * (x2 - x)
    zW = lambda x, y: eave + pitch * (x - x1)
    # FLAT-TOPPED hip: each slope rises only to where it reaches `flat_z`, then a
    # horizontal panel caps the centre (an 8.5 ft flat ceiling with sloped sides).
    # dH = plan run from each eave to the flat edge. The slope x/y functions already
    # trace the hip diagonals, so the flat edges fall out by evaluating them at the
    # flat boundary. With flat_z=None the slopes meet at the ridge (a full vault):
    # yTn/yTs collapse to yc and the E/W ends to a point, recovering the old hip.
    dH = (flat_z - eave) / pitch if flat_z is not None else 0.0
    fx1, fx2, fy1, fy2 = x1 + dH, x2 - dH, y1 + dH, y2 - dH      # flat rect
    yTn = fy2 if flat_z is not None else yc                       # N slope top edge (y)
    yTs = fy1 if flat_z is not None else yc                       # S slope top edge (y)
    xTe = fx2 if flat_z is not None else (x2 - half)              # E slope top edge (x)
    xTw = fx1 if flat_z is not None else (x1 + half)              # W slope top edge (x)
    if flat_z is not None:
        fz = lambda x, y: flat_z
        if s_gable:
            # flat ceiling with a TRIANGULAR notch on its S edge: base [sxa,sxb] at
            # fy1, apex (scx, s_apex) — the wide S dormer's ridge dies here, so the
            # notch opens the flat ceiling for the raised vault.
            _, _, s_apex, sxa, sxb = s_gable
            scx = (sxa + sxb) / 2.0
            panel([(fx1, fy1), (sxa, fy1), (sxa, fy2), (fx1, fy2)], fz)          # left strip
            panel([(sxb, fy1), (fx2, fy1), (fx2, fy2), (sxb, fy2)], fz)          # right strip
            panel([(sxa, s_apex), (sxb, s_apex), (sxb, fy2), (sxa, fy2)], fz)    # middle, N of apex
            panel([(sxa, fy1), (scx, s_apex), (sxa, s_apex)], fz)               # notch side W
            panel([(sxb, fy1), (sxb, s_apex), (scx, s_apex)], fz)               # notch side E
        else:
            panel([(fx1, fy1), (fx2, fy1), (fx2, fy2), (fx1, fy2)], fz)

    def long_slope(zf, xLf, xRf, y_eave, y_top, wells, w0, w1):
        wf, wn = (w0, w1) if abs(w0 - y_top) < abs(w1 - y_top) else (w1, w0)   # wf nearer top
        panel([(xLf(y_top), y_top), (xRf(y_top), y_top), (xRf(wf), wf), (xLf(wf), wf)], zf)  # top -> wells
        sw = sorted(wells)
        panel([(xLf(wf), wf), (sw[0][0], wf), (sw[0][0], wn), (xLf(wn), wn)], zf)   # left of wells
        for k in range(len(sw) - 1):                                                # between wells
            panel([(sw[k][1], wf), (sw[k + 1][0], wf), (sw[k + 1][0], wn), (sw[k][1], wn)], zf)
        panel([(sw[-1][1], wf), (xRf(wf), wf), (xRf(wn), wn), (sw[-1][1], wn)], zf)  # right of wells
        panel([(xLf(wn), wn), (xRf(wn), wn), (xRf(y_eave), y_eave), (xLf(y_eave), y_eave)], zf)  # wells -> eave

    def gable_band(zf, pt, edgeL, edgeR, d_eave, d_top, d_face, d_cheek, d_apex, wells):
        # Generic GABLE (pentagon) slope — the dormer dies into the main roof along two
        # valleys. `pt(d, w) -> (x, y)` maps the depth axis d (eave<->ridge) and the
        # width axis w to plan coords; edgeL/edgeR(d) are the slope's width-edges at
        # depth d. Bands top -> eave:
        #   top band    d_top..d_apex    full width (no holes)
        #   valley band d_apex..d_cheek  TRIANGULAR holes ([a,b] at d_cheek narrowing to
        #                                the apex (mid, d_apex) — the converging valleys)
        #   front band  d_cheek..d_face  RECTANGULAR holes [a,b] (under the cheeks)
        #   eave band   d_face..d_eave   full width (no holes)
        # Used for all 5 gable dormers: N (pt=(w,d)) and the E/W hips (pt=(d,w)).
        sw = sorted(wells)
        cws = [((a + b) / 2.0) for a, b in sw]
        P = pt
        panel([P(d_top, edgeL(d_top)), P(d_top, edgeR(d_top)), P(d_apex, edgeR(d_apex)), P(d_apex, edgeL(d_apex))], zf)
        # valley band: solid = trapezoid minus the converging triangles
        panel([P(d_apex, edgeL(d_apex)), P(d_cheek, edgeL(d_cheek)), P(d_cheek, sw[0][0]), P(d_apex, cws[0])], zf)
        for k in range(len(sw) - 1):
            panel([P(d_apex, cws[k]), P(d_cheek, sw[k][1]), P(d_cheek, sw[k + 1][0]), P(d_apex, cws[k + 1])], zf)
        panel([P(d_apex, cws[-1]), P(d_cheek, sw[-1][1]), P(d_cheek, edgeR(d_cheek)), P(d_apex, edgeR(d_apex))], zf)
        # front band: solid = strip minus the rectangular cheek footprints
        panel([P(d_cheek, edgeL(d_cheek)), P(d_cheek, sw[0][0]), P(d_face, sw[0][0]), P(d_face, edgeL(d_face))], zf)
        for k in range(len(sw) - 1):
            panel([P(d_cheek, sw[k][1]), P(d_cheek, sw[k + 1][0]), P(d_face, sw[k + 1][0]), P(d_face, sw[k][1])], zf)
        panel([P(d_cheek, sw[-1][1]), P(d_cheek, edgeR(d_cheek)), P(d_face, edgeR(d_face)), P(d_face, sw[-1][1])], zf)
        # eave band: full width below the dormer faces
        panel([P(d_face, edgeL(d_face)), P(d_face, edgeR(d_face)), P(d_eave, edgeR(d_eave)), P(d_eave, edgeL(d_eave))], zf)

    # E hip end (top edge at x=xTe). With a hip dormer it's a GABLE pentagon (same
    # component as the N dormers); otherwise the plain slope trapezoid / triangle.
    eLO, eUP = (lambda x: y1 + (x2 - x)), (lambda x: y2 - (x2 - x))
    if e_well:
        face, cheek, apex, bL, bR = e_well
        gable_band(zE, lambda d, w: (d, w), eLO, eUP, x2, xTe, face, cheek, apex, [(bL, bR)])
    elif flat_z is not None:
        panel([(x2, y1), (x2, y2), (xTe, fy2), (xTe, fy1)], zE)
    else:
        panel([(x2, y1), (x2, y2), (xTe, yc)], zE)
    # W hip end (top edge at x=xTw)
    wLO, wUP = (lambda x: y1 + (x - x1)), (lambda x: y2 - (x - x1))
    if w_well:
        face, cheek, apex, bL, bR = w_well
        gable_band(zW, lambda d, w: (d, w), wLO, wUP, x1, xTw, face, cheek, apex, [(bL, bR)])
    elif flat_z is not None:
        panel([(x1, y2), (x1, y1), (xTw, fy1), (xTw, fy2)], zW)
    else:
        panel([(x1, y2), (x1, y1), (xTw, yc)], zW)

    xLn, xRn = (lambda y: x1 + (y2 - y)), (lambda y: x2 - (y2 - y))
    xLs, xRs = (lambda y: x1 + (y - y1)), (lambda y: x2 - (y - y1))
    if n_wells and n_apex is not None:
        gable_band(zN, lambda d, w: (w, d), xLn, xRn, y2, yTn, ny1, ny0, n_apex, n_wells)
    elif n_wells:
        long_slope(zN, xLn, xRn, y2, yTn, n_wells, ny0, ny1)
    else:
        panel([(x1, y2), (x2, y2), (xRn(yTn), yTn), (xLn(yTn), yTn)], zN)
    if s_wells:
        long_slope(zS, xLs, xRs, y1, yTs, s_wells, sy0, sy1)
    else:
        panel([(x2, y1), (x1, y1), (xLs(yTs), yTs), (xRs(yTs), yTs)], zS)
    return verts, faces


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
            ewall = g.get("eaveWallFt", 0) * FT
            if ewall > 0:                          # belt course at the raised-plate base (frieze springs above it)
                bh, bp = 0.20, 0.08
                belt = make_box(ctx, "IfcBuildingElementProxy", f"Belt course - {key}",
                                w + 2 * bp, d + 2 * bp, bh, cx, cy, ez - ewall - bh / 2, color=TRIM)
                run("spatial.assign_container", ctx.model, products=[belt], relating_structure=ctx.storey)
            # dentil course running under the eave cornice (classical entablature
            # over the frieze). One product holds all the little blocks.
            dh, dpr, dw, dpitch = 0.22 * FT, 0.14 * FT, 0.34 * FT, 0.62 * FT
            dz = ez - ch - dh                      # tucked directly beneath the cornice band
            dents = []
            nx = max(1, round(w / dpitch))
            for i in range(nx):
                x = cx - w / 2 + (i + 0.5) * w / nx
                for fy in (cy + d / 2, cy - d / 2):
                    yc = fy + (dpr / 2 - 0.03) * (1 if fy > cy else -1)
                    dents.append(positioned_solid(ctx, dw, dpr + 0.06, dh, x, yc, dz))
            ny = max(1, round(d / dpitch))
            for i in range(ny):
                y = cy - d / 2 + (i + 0.5) * d / ny
                for fx in (cx + w / 2, cx - w / 2):
                    xc = fx + (dpr / 2 - 0.03) * (1 if fx > cx else -1)
                    dents.append(positioned_solid(ctx, dpr + 0.06, dw, dh, xc, y, dz))
            for s in dents:
                style_item(ctx, s, TRIM)
            dent = multi_solid_product(ctx, "IfcBuildingElementProxy", f"Dentils - {key}", dents)
            run("spatial.assign_container", ctx.model, products=[dent], relating_structure=ctx.storey)
        else:
            # lean-to wing: sloped ceiling, so the shed roof sits directly on top
            mv, mf = _filled_block(*surf(0.0), crawl)
            add_brep(ctx, f"Massing - {key}", mv, mf, WALL, ifc_class="IfcBuildingElementProxy")

        rv, rf = _roof_slab(*surf(oh), rt)
        add_brep(ctx, f"Roof - {key}", rv, rf, ROOF, predefined=("HIP_ROOF" if t == "hip" else "SHED_ROOF"))

        if t == "hip" and g.get("dormers"):           # mirror the attic dormers onto the massing
            dspec = g["dormers"]
            bay_xs = None
            if dspec.get("align") == "bays":
                pos = aligned_front_bays([rooms_cache[s] for s in g["rooms"]], dspec.get("count", 3))
                bay_xs = [ctx.X(px) for px in pos] if pos else None
            add_dormers(ctx, x1, x2, y1, y2, pitch, dspec, base_z=ez, style="exterior", bay_xs=bay_xs)
        if t == "hip" and g.get("shedDormer"):
            add_shed_dormer(ctx, x1, x2, y1, y2, pitch, g["shedDormer"], base_z=ez, style="exterior")
        if t == "hip" and g.get("hipDormers"):     # gable dormers on the E + W end hips
            add_hip_dormer(ctx, x1, x2, y1, y2, pitch, g["hipDormers"], side="east", base_z=ez, style="exterior")
            add_hip_dormer(ctx, x1, x2, y1, y2, pitch, g["hipDormers"], side="west", base_z=ez, style="exterior")

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
    """The rear terrace, level with the finished floor (= `base`, 30" above grade).

    An L along the south face of the house, now grown on both sides: WEST past the
    scullery to `deck.westClearFt` of the west line, and EAST off the house's east wall
    all the way to the SE corner, dying on the east lot wall exactly as its south edge
    dies on the south one. It keeps the EXISTING north edge — the family room's south
    wall — and does not climb the side of the house: taken further north the terrace
    approaches the front and the yard stops being private.

    There are NO guard rails anywhere. The open edge is the terrace's NORTH one, and
    that is a full-width flight of steps down to grade.

    A flight is `stepCount` RISERS, which is `stepCount - 1` treads plus a paver flush
    with grade. That is worth stating because the older inset flights emitted
    `stepCount` slabs: their top slab was level with the deck and filled the notch.
    Projected outward the same loop would put an extra tread's worth of deck past the
    edge and quietly eat 0.92 ft of the clearance this deck is dimensioned by."""
    if base <= 0:
        return
    DECK = (0.60, 0.47, 0.34)                       # warm deck wood
    d = lot.get("deck") or {}
    tub = d.get("hotTub") or {}
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    xlo = lambda b: min(b["x1"], b["x2"]); xhi = lambda b: max(b["x1"], b["x2"])
    zlo = lambda b: min(b["z1"], b["z2"])
    half_wall = ctx.T / FT / 2
    deck_west, deck_east, deck_south, deck_north = deck_extent(rooms_cache, lot, half_wall)
    ext_east = min(xlo(B[k]) for k in EXT_WING if k in B)
    house_south = zlo(B["family"])                  # family / extension south wall (plan z)
    scu = B["scullery"]
    scu_east, scu_south = xlo(scu), zlo(scu)

    def slab(name, x1, x2, z1, z2, z0, h, cls="IfcSlab", color=DECK):
        w, dp = abs(x2 - x1), abs(z2 - z1)
        if w <= 1e-6 or dp <= 1e-6 or h <= 1e-6:
            return
        b = make_box(ctx, cls, name, w * FT, dp * FT, h,
                     ctx.X((x1 + x2) / 2), ctx.Y((z1 + z2) / 2), z0, color=color)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    nst, tread = d.get("stepCount", 4), d.get("treadFt", 0.92)
    riser = base / nst

    # --- the hot tub's well: a square hole in the terrace with a surround one riser
    # down, so you step off the deck onto the coping and then into the water. Sized
    # and placed off the things it is actually measured from — the lot wall's inner
    # face and the terrace's own width — rather than absolute coordinates.
    # Tucked into the SE CORNER, 12 in off both lot walls — the most private spot on the
    # lot now that it is the one place enclosed by two 7 ft walls. The 12 in on each side
    # is exactly the surround, so the coping dies into both walls.
    ts = tub.get("sizeFt", 7.0)
    sur = tub.get("surroundFt", 1.0)
    tub_s = deck_south + tub.get("fromWallIn", 12) / 12
    tub_n = tub_s + ts
    tub_e = deck_east + tub.get("fromEastWallIn", 12) / 12
    tub_w = tub_e + ts
    tub_mid = (tub_e + tub_w) / 2
    well = (tub_w + sur, tub_e - sur, deck_south, tub_n + sur)    # S and E run to the edges

    # --- platform, declared as whole rects and then punched ---------------------
    # `Deck terrace E` is named apart from `Deck` on purpose: the alt lot puts a garage
    # in this yard, and hiding the new work there is a name match (see src/main.js).
    terrace = [(deck_east, ext_east, deck_south, deck_north)]
    for x1, x2, z1, z2 in rects_minus(terrace, well):
        slab("Deck terrace E", x1, x2, z1, z2, 0.0, base)
    slab("Deck", ext_east, scu_east, deck_south, house_south, 0.0, base)   # main section, notch filled

    slab("Deck - scullery", scu_east, deck_west, scu_south, deck_south, 0.0, base)

    # --- the tub surround, one riser down, as four named legs (ifc_check measures
    # the south one against the wall) ------------------------------------------
    sy = base - riser * tub.get("recessRisers", 1)
    slab("Hot tub surround S", tub_w + sur, tub_e - sur, tub_s - sur, tub_s, 0.0, sy)
    slab("Hot tub surround N", tub_w + sur, tub_e - sur, tub_n, tub_n + sur, 0.0, sy)
    slab("Hot tub surround W", tub_w, tub_w + sur, tub_s, tub_n, 0.0, sy)
    slab("Hot tub surround E", tub_e - sur, tub_e, tub_s, tub_n, 0.0, sy)

    # --- steps. NORTH: the terrace's open edge, the full width of it between the east
    # lot wall and the house, descending north into the yard. The south and east edges
    # are lot walls and the rest of the north edge is the house, so this is the only
    # side there is. WEST: the old inset flight, relocated to descend west off the new
    # edge — left inset it would have made the whole west extension stair and no deck.
    for k in range(nst - 1):
        h = base - (k + 1) * riser                   # k=0 is the top tread, one riser down
        slab(f"Deck step N{k}", deck_east, ext_east,
             deck_north + k * tread, deck_north + (k + 1) * tread, 0.0, h)
        slab(f"Deck step W{k}", deck_west + k * tread, deck_west + (k + 1) * tread,
             scu_south, deck_south, 0.0, h)
    if d.get("gradePaver", True):                    # a flush landing at the foot of each
        t0 = (nst - 1) * tread
        slab(f"Deck step N{nst - 1}", deck_east, ext_east,
             deck_north + t0, deck_north + t0 + tread, -0.05, 0.05)
        slab(f"Deck step W{nst - 1}", deck_west + t0, deck_west + t0 + tread,
             scu_south, deck_south, -0.05, 0.05)

    # --- the tub VESSEL is a procedural mesh, not an IFC proxy (CLAUDE.md's furniture
    # rule). Recorded to the viewer manifest the same way the porch lanterns are; the
    # hole above is what it drops into, and ifc_check asserts the two agree.
    ctx.furniture.append({
        "type": "hot_tub", "px": round(tub_mid, 4), "pz": round((tub_s + tub_n) / 2, 4),
        "wFt": ts, "dFt": ts,
        "rimFt": round(sy / FT, 4), "deckFt": round(base / FT, 4),
    })


def add_side_porch(ctx, lot, rooms_cache, base):
    """A small board porch at the east wing's outside door: a landing level with the
    floor, a flight down to grade, a guard and handrail, and a free-standing awning
    over the door.

    It fills the reentrant corner between the wing's north wall and the primary
    block's east wall, so it is sheltered on two sides before any roof is added. Kept
    plain on purpose — this is the side door off the drive, not a second front stoop,
    and `add_porch`'s stucco skirt and splayed cheek walls would make a ceremony of it.

    Four things are DERIVED, and each is why a number here is not a coordinate:

      - the DOOR is found by geometry — the one exterior opening on the wing's north
        wall — so moving it in the room file moves the steps and the awning with it;
      - the WIDTH is the wing's own, bound to bound, which is the ~11 ft asked for;
      - the flight and the awning are centred on the door and then SNAPPED flush to
        the primary's east wall, which they both land within a few inches of. Centred
        exactly, the stair would leave a 3 in sliver of deck against the house, which
        reads as a mistake where a flush edge reads as built;
      - the RISERS come from `lot.deck`, so every flight on the lot climbs alike.

    The south edge sits on the wing's BOUND rather than its wall face: the exterior
    massing blocks are built at the bounds, so the deck tucks under the finished wall
    exactly as `add_deck`'s terrace does. An overlap hides; a gap shows.

    The yard fence's terminal post stands on this porch's SE corner — they share a
    corner by construction, not by coincidence — so the deck is PUNCHED around it
    (`yard_fence_line`) instead of the two interpenetrating."""
    p = lot.get("sidePorch") or {}
    if base <= 0 or not p:
        return
    DECK = (0.60, 0.47, 0.34)                       # warm deck wood, as the rear deck
    ROOF = (0.30, 0.30, 0.33)                       # charcoal shingle, as the house
    d = lot.get("deck") or {}
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    if not all(k in B for k in EXT_WING):
        return
    half_wall = ctx.T / FT / 2
    px_e = min(min(B[k]["x1"], B[k]["x2"]) for k in EXT_WING)   # wing's east bound
    px_w = max(max(B[k]["x1"], B[k]["x2"]) for k in EXT_WING)   # ...and its west, on the house wall
    pz_s = max(max(B[k]["z1"], B[k]["z2"]) for k in EXT_WING)   # the wall the porch sits against

    door = None                                     # the wing's one exterior door
    for k in EXT_WING:
        for dr in rooms_cache[k].get("doors", []):
            if dr.get("orient") == "H" and abs(dr.get("fixed", 0.0) - pz_s) < 1e-6:
                door = dr
    if not door:
        return

    depth = p.get("depthFt", 5.0)
    pz_n = pz_s + depth
    nst, tread = d.get("stepCount", 4), d.get("treadFt", 0.92)
    riser = base / nst
    # A member that dies against a wall runs BURY into it rather than stopping ON its
    # face. Two opaque boxes sharing a face PLANE z-fight from the side they both face,
    # and every exterior material is DoubleSide in the viewer, so neither face is culled.
    # 0.6 in, inside a solid massing block, so nothing is visible either way.
    BURY = 0.05

    def slab(name, x1, x2, z1, z2, z0, h, cls="IfcSlab", color=DECK):
        w, dp = abs(x2 - x1), abs(z2 - z1)
        if w <= 1e-6 or dp <= 1e-6 or h <= 1e-6:
            return
        b = make_box(ctx, cls, name, w * FT, dp * FT, h,
                     ctx.X((x1 + x2) / 2), ctx.Y((z1 + z2) / 2), z0, color=color)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    def centred(width, snap=0.75):
        """A run of `width` centred on the door, clamped inside the porch and snapped
        flush to the primary's east wall when it lands within `snap` of it. Returns
        (east, west) — plan x increases WEST, so west is the larger number."""
        w = min(door["pos"] + width / 2, px_w)
        if px_w - w < snap:
            w = px_w
        return max(w - width, px_e), w

    def die_in(x):
        """`x` after burying it, if that edge landed on the primary's east wall."""
        return x + BURY if abs(x - px_w) < 1e-9 else x

    # --- the landing, punched around the yard fence's terminal post ---------------
    fz, fx = yard_fence_line(rooms_cache, half_wall)
    hp = YARD_POST_FT / 2
    for x1, x2, z1, z2 in rects_minus([(px_e, px_w + BURY, pz_s - BURY, pz_n)],
                                      (fx - hp, fx + hp, fz - hp, fz + hp)):
        slab("Side porch deck", x1, x2, z1, z2, 0.0, base)

    # --- the flight, descending north straight out of the door. `nst` RISERS is
    # nst - 1 treads plus a paver flush with grade, the same reckoning add_deck sets out.
    se, sw = centred(p.get("stepWidthFt", 5.0))
    for k in range(nst - 1):
        slab(f"Side porch step {k}", se, die_in(sw), pz_n + k * tread,
             pz_n + (k + 1) * tread, 0.0, base - (k + 1) * riser)
    if d.get("gradePaver", True):
        t0 = (nst - 1) * tread
        slab(f"Side porch step {nst - 1}", se, die_in(sw), pz_n + t0, pz_n + t0 + tread,
             -0.05, 0.05)

    # --- the guard and the stair handrail -----------------------------------------
    # The deck stands 30 in over the yard, so its two OPEN edges get a guard: the east
    # edge and the north edge as far as the head of the stair. South and west are house
    # walls. The east run's south end dies into the YARD FENCE'S TERMINAL POST, which
    # already stands 3.5 ft above this deck — standing a second post 3 in from it would
    # be a mistake rather than a detail.
    #
    # Every member sits on a centreline inset `postFt / 2` from the edge it guards, so
    # posts, rails and balusters share one line and the posts' outer faces are flush
    # with the deck. IfcRailing throughout, like the two fences — a railing is not a
    # walk-POV surface.
    #
    # The HANDRAIL'S HEIGHT IS NOT AUTHORED: it is the guard's own height carried down
    # the rake above the nosing line. That lands at 36 in, inside the 34-38 in a
    # handrail is allowed, and makes the guard's top rail and the handrail ONE line
    # broken only at the newel — two authored heights would meet at the newel with a
    # step in them and nothing would have caught it.
    g = p.get("guard") or {}
    if g:
        gh, pst = g.get("heightFt", 3.0), g.get("postFt", 0.29)
        rw, rt = g.get("railFt", 0.25), g.get("railThickFt", 0.12)
        bw, boc = g.get("balusterFt", 0.125), g.get("balusterOcFt", 0.42)
        bot = g.get("bottomClearFt", 0.25)
        rail_x = se + pst / 2              # the stair's open (east) side, inset onto the tread
        east_x = px_e + pst / 2            # the deck's east edge
        north_z = pz_n - pst / 2

        def newel(nm, xc, zc, y0, top):
            slab(nm, xc - pst / 2, xc + pst / 2, zc - pst / 2, zc + pst / 2,
                 y0, top - y0, cls="IfcRailing")

        def guard_run(axis, fixed, a, b, tag):
            """One straight run: bottom rail, top rail, balusters between. `axis` is the
            one it runs ALONG, `fixed` the other coordinate."""
            lo, hi = min(a, b), max(a, b)
            def put(nm, p1, p2, half, y0, h):
                if axis == "x":
                    slab(nm, p1, p2, fixed - half, fixed + half, y0, h, cls="IfcRailing")
                else:
                    slab(nm, fixed - half, fixed + half, p1, p2, y0, h, cls="IfcRailing")
            put(f"Side porch guard bottom rail {tag}", lo, hi, rw / 2,
                base + bot * FT, rt * FT)
            put(f"Side porch guard top rail {tag}", lo, hi, rw / 2,
                base + (gh - rt) * FT, rt * FT)
            # Divisions, not a fixed pitch: an even division that never EXCEEDS boc, so
            # the 4 in sphere rule holds whatever the run works out to.
            n = max(1, int(math.ceil((hi - lo) / boc)))
            for i in range(n):
                c = lo + (hi - lo) * (i + 0.5) / n
                put(f"Side porch baluster {tag}.{i}", c - bw / 2, c + bw / 2, bw / 2,
                    base + (bot + rt) * FT, (gh - bot - 2 * rt) * FT)

        top_y = base + (gh + 0.12) * FT
        newel("Side porch guard post 0", east_x, north_z, base, top_y)       # NE corner
        newel("Side porch guard post 1", rail_x, north_z, base, top_y)       # head of the stair
        guard_run("z", east_x, fz + hp, north_z, "E")                        # dies into the fence post
        guard_run("x", north_z, east_x, rail_x, "N")

        # --- the flight. `y_of` is the handrail's TOP: level over the landing, then
        # falling at the flight's own slope from the top nosing. riser is metres and
        # tread is plan feet, so the quotient is metres per plan-foot.
        def y_of(z):
            return base + gh * FT - (riser / tread) * max(0.0, z - pz_n)

        def rake(nm, za, zb, dy, h, half):
            """A member following the rake, `dy` ft below the handrail line and `h` thick."""
            y = lambda z: y_of(z) - dy * FT
            x0, x1 = ctx.X(rail_x - half), ctx.X(rail_x + half)
            poly = [(x0, ctx.Y(za), y(za)), (x0, ctx.Y(zb), y(zb)),
                    (x0, ctx.Y(zb), y(zb) - h * FT), (x0, ctx.Y(za), y(za) - h * FT)]
            v, faces = _prism(poly, (x1 - x0, 0, 0))
            add_brep(ctx, nm, v, faces, DECK, ifc_class="IfcRailing")

        z_foot = pz_n + (nst - 1) * tread + pst / 2      # centred on the grade paver
        newel("Side porch stair newel", rail_x, z_foot, 0.0, y_of(z_foot) + 0.12 * FT)
        rake("Side porch handrail", pz_n, z_foot, 0.0, rt, rw / 2)
        rake("Side porch stair bottom rail", pz_n, z_foot, gh - bot - rt, rt, rw / 2)
        # Balusters spaced IN PLAN, like the guard's runs — the openings here are
        # measured horizontally because the balusters are vertical, whatever the rail
        # above them does, so the sloped length is the wrong ruler. It is also the
        # tighter-looking mistake rather than the dangerous one: counting off the rake
        # put nine of them where seven carry the same 3.5 in clear, and broke the
        # rhythm the guard beside it is set out on.
        span = z_foot - pz_n
        n = max(1, int(math.ceil(span / boc)))
        for i in range(n):
            c = pz_n + span * (i + 0.5) / n
            slab(f"Side porch stair baluster {i}", rail_x - bw / 2, rail_x + bw / 2,
                 c - bw / 2, c + bw / 2, y_of(c) - (gh - bot - rt) * FT,
                 (gh - bot - 2 * rt) * FT, cls="IfcRailing")

    # --- the awning. FREE-STANDING: it projects off the wall on its own brackets and
    # nothing lands on the deck, so the porch floor and the head of the stair are clear.
    # Carried on posts it read as a doorframe — two uprights at the deck's north edge
    # framing the flight — which is a canopy, not the awning this wanted to be.
    #
    # It runs to the primary's east wall on the west rather than stopping a few inches
    # short: the door sits 2.7 ft off that wall, so anything wide enough to cover the
    # door reaches it anyway, and the alternative is a 3 in slot nobody would build.
    c = p.get("awning") or {}
    # Its width is the WEST BAY, not a number: the bay is the door's own room, so filling
    # it lands the awning exactly centred on the door with no snapping at all — and it
    # stops dead on the party wall instead of straddling it. Authored at 6.0 ft it
    # overhung that line by 6 in and drove through a member of the elevation standing on
    # it (see wing_bays).
    bays = wing_bays(rooms_cache)
    ce, cw = (bays[-2], bays[-1]) if len(bays) >= 3 else centred(c.get("widthFt", 6.0))
    prj, spring = c.get("projectFt", 4.0), c.get("springFt", 8.25)
    drop, thk = c.get("dropFt", 1.0), c.get("thickFt", 0.2)
    pz_o = pz_s + prj                               # the outer edge
    top_w, top_o = base + spring * FT, base + (spring - drop) * FT
    poly = [(ctx.X(ce), ctx.Y(pz_s - BURY), top_w),
            (ctx.X(die_in(cw)), ctx.Y(pz_s - BURY), top_w),
            (ctx.X(die_in(cw)), ctx.Y(pz_o), top_o),
            (ctx.X(ce), ctx.Y(pz_o), top_o)]
    v, faces = _prism(poly, (0, 0, -thk * FT))
    add_brep(ctx, "Side porch awning", v, faces, ROOF, predefined="SHED_ROOF")

    # Brackets: one at each end, a gusset off the WALL reaching up under the awning.
    # Inset from the ends rather than centred on them — the west end is the primary's
    # east wall, and a bracket centred there would be half buried inside the house.
    bt = c.get("bracketThickFt", 0.25)
    reach, bdrop = c.get("bracketReachFt", 2.75), c.get("bracketDropFt", 2.0)
    y_at = lambda z: top_w - (top_w - top_o) * (z - pz_s) / prj - thk * FT   # underside
    for i, x1 in enumerate((ce, cw - bt)):
        tri = [(ctx.X(x1), ctx.Y(pz_s), y_at(pz_s)),
               (ctx.X(x1), ctx.Y(pz_s), y_at(pz_s) - bdrop * FT),
               (ctx.X(x1), ctx.Y(pz_s + reach), y_at(pz_s + reach))]
        v, faces = _prism(tri, (ctx.X(x1 + bt) - ctx.X(x1), 0, 0))
        add_brep(ctx, f"Side porch bracket {i}", v, faces, DECK,
                 ifc_class="IfcBuildingElementProxy")


def add_wing_elevation(ctx, lot, rooms_cache, base, group=None):
    """The east wing's NORTH face — 10.9 ft wide by 19 ft of blank stucco, and the one
    wall on the house that takes no windows: the east bay is the bathroom on BOTH
    storeys and its window is on the east face.

    Read as TWO STOREYS, which is how the house itself is built:

        under the eaves   a band of T1-11, hung from the soffit, the full width
        at the floor line a waist course dividing the storeys
        elsewhere         plain stucco, carrying only the door and its awning
        at the top        a raking entablature

    It began as four quadrants over the two bays the rooms behind it make — the wall's
    centreline IS the bath/vestibule party wall, and the door sits dead centre of the
    west bay, so the door was always symmetrical, just not about the wall. That reading
    still explains why the door sits where it does, and `wing_bays` still serves the
    awning; but a full-height trellis held the east bay and it is gone, so the bays no
    longer divide the elevation and the belt course does.

    THE WALL TOP RAKES 1 IN 12 — 0.91 ft over 10.9 ft, high toward the primary. That is
    shallow enough that bare, the roof reads as having SLIPPED rather than sloped, and
    the wing had no eave trim whatever to say otherwise: the roof slab met the stucco
    with no overhang on this face, no fascia and no shadow line. The frieze and cornice
    rake with it and the corbels under them stand VERTICAL, and it is that contrast
    which makes a 5 degree slope read as deliberate.

    NOTHING HERE IS PLACED BY COORDINATE. The bays come from the rooms behind the wall;
    the wall top comes from the massing group's own storeys and pitch, so the trim
    cannot drift off the roof it follows; the waist is the second-floor line, taken as
    crawl + one storey; and the siding's head DIES INTO the frieze, raking with it rather
    than stopping level and leaving a wedge of blank wall widening toward the high end.
    Only the band's own height is authored, and only because this wall has nothing to
    derive it from — no windows, and the floor line is far too low to hang a band on."""
    spec = lot.get("wingElevation") or {}
    if not spec or base <= 0:
        return
    # The porch's wood for the JOINERY, the primary's white for the TRIM. The first is
    # measured: white sits 0.06 from this stucco and a thin white member read as a pencil
    # line on a 19 ft wall — the disappearing act addAltExtension documents for its cast
    # stone, on this same palette, and this is a NORTH wall, permanently in shade. The
    # entablature is the exception because it is not thin: it projects, so it reads as a
    # silhouette against the roof and the sky, exactly as the primary's own cornice does
    # — and matching that cornice is what ties the wing to the house.
    WOOD = (0.60, 0.47, 0.34)
    TRIM = (0.93, 0.92, 0.88)
    # The groove's shadow. A NEUTRAL dark, not the fence's brown: the face above it is
    # painted white now, and a warm backer would read as wood showing through a gap
    # rather than as a shadow line in a painted sheet.
    SHADOW = (0.35, 0.34, 0.32)
    BURY = 0.05                                     # plan ft INTO the wall, so no face is coplanar
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    if not all(k in B for k in EXT_WING):
        return
    wall_z = max(max(B[k]["z1"], B[k]["z2"]) for k in EXT_WING)
    edges = wing_bays(rooms_cache)
    if len(edges) < 3:
        return
    x_east, party, x_west = edges[0], edges[1], edges[-1]

    def part(nm, xa, xb, ya, yb, za, zb, color=WOOD):
        """px xa..xb, height ya..yb (metres), pz za..zb."""
        w, d, h = abs(xb - xa), abs(zb - za), yb - ya
        if w <= 1e-6 or d <= 1e-6 or h <= 1e-6:
            return
        pr = make_box(ctx, "IfcBuildingElementProxy", nm, w * FT, d * FT, h,
                      ctx.X((xa + xb) / 2), ctx.Y((za + zb) / 2), ya, color=color)
        run("spatial.assign_container", ctx.model, products=[pr], relating_structure=ctx.storey)

    def rake_band(nm, xa, xb, y_of, h, za, zb, color=WOOD):
        """A member whose TOP follows `y_of(px)` (metres), `h` ft deep, pz za..zb."""
        Za, Zb = ctx.Y(za), ctx.Y(zb)
        poly = [(ctx.X(xa), Za, y_of(xa)), (ctx.X(xb), Za, y_of(xb)),
                (ctx.X(xb), Za, y_of(xb) - h * FT), (ctx.X(xa), Za, y_of(xa) - h * FT)]
        v, faces = _prism(poly, (0, Zb - Za, 0))
        add_brep(ctx, nm, v, faces, color, ifc_class="IfcBuildingElementProxy")

    def rake_panel(nm, xa, xb, y_lo, y_of, za, zb, color=WOOD):
        """A field with a LEVEL base at `y_lo` and a head following `y_of(px)` — a
        trapezoid, not a band. rake_band sweeps a constant depth and so cannot describe
        a panel that stands on a level line under a raking one; that is every clad
        field on this wall."""
        Za, Zb = ctx.Y(za), ctx.Y(zb)
        poly = [(ctx.X(xa), Za, y_lo), (ctx.X(xb), Za, y_lo),
                (ctx.X(xb), Za, y_of(xb)), (ctx.X(xa), Za, y_of(xa))]
        v, faces = _prism(poly, (0, Zb - Za, 0))
        add_brep(ctx, nm, v, faces, color, ifc_class="IfcBuildingElementProxy")

    # --- where the wall stops. Taken from the massing group's OWN storeys and pitch, the
    # same arithmetic add_massing springs its roof from, so the trim cannot drift off the
    # roof it is supposed to follow.
    e = spec.get("entablature") or {}
    banded = bool(e and group)
    fz, fzp = e.get("friezeFt", 0.85), e.get("friezeProudFt", 0.12)
    cn, cnp = e.get("corniceFt", 0.28), e.get("corniceProudFt", 0.40)
    if banded:
        pitch = group.get("pitch", 0.0833)
        ez = (base + group.get("storeys", 1) * ctx.story
              - group.get("trimFt", 0) * FT + group.get("eaveWallFt", 0) * FT)
        wall_top = lambda px: ez + pitch * (px - x_east) * FT
        soffit = lambda px: wall_top(px) - (cn + fz) * FT
    else:                                           # no trim: everything stops at a level line
        _flat = spec.get("fallbackTopFt", 18.0) * FT
        wall_top = soffit = lambda px: _flat

    # --- the entablature, across both bays at the wall top -------------------------
    if banded:
        rake_band("Wing cornice", x_east - cnp, x_west, wall_top, cn,
                  wall_z - BURY, wall_z + cnp, TRIM)
        rake_band("Wing frieze", x_east, x_west, lambda px: wall_top(px) - cn * FT, fz,
                  wall_z - BURY, wall_z + fzp, TRIM)
        cbw, cbd, cbp = (e.get("corbelFt", 0.34), e.get("corbelDropFt", 0.50),
                         e.get("corbelProudFt", 0.32))
        n = max(1, int(round((x_west - x_east) / e.get("corbelOcFt", 1.35))))
        for i in range(n):
            c = x_east + (x_west - x_east) * (i + 0.5) / n
            top = wall_top(c) - cn * FT
            # WOOD, where the bands are white. A corbel is small and this is a north
            # wall in permanent shade, so its 2 in of extra projection casts nothing and
            # a white one is invisible against a white frieze — the render showed a flat
            # band where the primary's cornice shows its dentils. Colour is the only
            # lever this elevation has, and timber brackets under a painted eave both
            # read and belong to the joinery already on this wall.
            part(f"Wing corbel {i}", c - cbw / 2, c + cbw / 2, top - cbd * FT, top,
                 wall_z - BURY, wall_z + cbp, color=WOOD)
        # A short MITRED RETURN round the east corner. Trim that stops dead on a corner
        # reads as a flat pasted on the front; turning it 9 in and stopping is what makes
        # it read as going round — the same detail the under-stair crown needed. The east
        # face is the shed's LOW eave, so the return is LEVEL: it is the one wall of this
        # wing whose top is.
        ret = e.get("returnFt", 0.8)
        top = wall_top(x_east)
        part("Wing cornice return", x_east - cnp, x_east, top - cn * FT, top,
             wall_z - ret, wall_z + cnp, color=TRIM)
        part("Wing frieze return", x_east - fzp, x_east, top - (cn + fz) * FT,
             top - cn * FT, wall_z - ret, wall_z + fzp, color=TRIM)

    # --- the upper wall: a T1-11 band under the eaves, over a waist course ---------
    # A band of grooved plywood siding hanging from the roof, plain stucco below it, and
    # a WAIST COURSE lower down at the second-floor line dividing the storeys.
    #
    # T1-11 IS GROOVED, NOT BATTENED, and that is not a naming quibble: a batten stands
    # proud and a groove is cut in, so one is modelled by adding material and the other
    # by leaving a gap. The face is strips with the gaps between them over a dark backer
    # that shows through — a groove reads by its SHADOW and this north wall has none, so
    # the dark backer IS the shadow.
    #
    # Three things this got wrong first, all of them visible only in a render:
    #   - FRAMED OUT on all four sides by corner boards it read as a heavy panel bolted
    #     to the wall. The siding now runs corner to corner and the only trim is a thin
    #     skirt at its foot.
    #   - SPRUNG FROM THE SECOND-FLOOR LINE it stood 7 ft tall and read as a whole clad
    #     storey rather than a band under the eaves. It hangs from the soffit now.
    #   - WOOD-TONED it was never what the house is: this is painted siding, and it is
    #     the one white member this wall can carry, because the grooves give it texture
    #     where the oculus and the corbels had only relief and vanished.
    cl = spec.get("cladding") or {}
    if cl and banded:
        floor2 = base + ctx.story                   # the second-floor line, derived
        # The WAIST, low and thin, with stucco above AND below it. That is what makes it
        # read as a storey division rather than as the base of the siding — the job the
        # old belt course was doing twice and therefore doing badly.
        wf, wp = cl.get("waistFt", 0.30), cl.get("waistProudFt", 0.08)
        part("Wing waist course", x_east, x_west, floor2 - wf * FT, floor2,
             wall_z - BURY, wall_z + wp, color=TRIM)
        rt = cl.get("waistReturnFt", 0.8)
        part("Wing waist return", x_east - wp, x_east, floor2 - wf * FT, floor2,
             wall_z - rt, wall_z + wp, color=TRIM)

        # The band hangs from the soffit: `bandFt` is its height at the LOW end, so its
        # head rakes with the roof while its base stays level. A level base is what gives
        # the rake something to read against, the same trick the corbels play.
        lo = soffit(x_east) - cl.get("bandFt", 4.5) * FT
        sf, sp = cl.get("skirtFt", 0.25), cl.get("skirtProudFt", 0.10)
        part("Wing cladding skirt", x_east, x_west, lo - sf * FT, lo,
             wall_z - BURY, wall_z + sp, color=TRIM)

        # Backer, dark, showing through the grooves; face over it, corner to corner.
        z_back = wall_z + cl.get("backProudFt", 0.02)
        z_face = z_back + cl.get("faceProudFt", 0.06)
        rake_panel("Wing cladding backer", x_east, x_west, lo, soffit,
                   wall_z - BURY, z_back, color=SHADOW)
        # DIVISIONS that never exceed the authored spacing, the reckoning the guard's
        # balusters use, so the grooves stay even whatever the wall works out to. The
        # outermost strips run into the corners: a groove hard against a corner is an
        # open edge, not a groove.
        gw, goc = cl.get("grooveFt", 0.031), cl.get("grooveOcFt", 0.667)
        n = max(1, int(math.ceil(abs(x_west - x_east) / goc)))
        for i in range(n):
            a0 = x_east + (x_west - x_east) * i / n + (gw / 2 if i else 0.0)
            a1 = x_east + (x_west - x_east) * (i + 1) / n - (gw / 2 if i < n - 1 else 0.0)
            rake_panel(f"Wing cladding board {i}", a0, a1, lo, soffit,
                       z_back, z_face, color=TRIM)


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
    west, east, south, _, _ = lot_lines(lot, B.values(), ctx.T / FT / 2)
    # The south leg runs as far west as the DECK, not just to the scullery. With the
    # deck extended past the scullery's west wall and every guard rail gone, the last
    # few feet of deck edge would otherwise back onto a 36 in picket fence 8 in further
    # south — a 30 in drop with a 6 in lip.
    scu_west = max(max(B["scullery"]["x1"], B["scullery"]["x2"]),
                   deck_extent(rooms_cache, lot, ctx.T / FT / 2)[0])

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
    west, _, south, _, _ = lot_lines(lot, B.values(), ctx.T / FT / 2)
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
    # ...which is now the DECK's west edge, not the scullery's wall — see add_lot_wall.
    scu_west = max(scu_west, deck_extent(rooms_cache, lot, ctx.T / FT / 2)[0])
    run_fence("x", south, scu_west, west)            # south: end of CMU -> SW corner
    run_fence("z", west, south, north)               # west (side yard): SW corner -> north wall plane
    # north leg: extend east from the west line to the house's NW corner, with a
    # gated trellis arbor in the middle of the leg.
    xg = (house_west + west) / 2
    run_fence("x", north, house_west, xg - 1.75)     # house -> gate
    run_fence("x", north, xg + 1.75, west)           # gate -> west corner
    gate_trellis(xg, north)


def _front_door(rooms_cache):
    """The Front Door record (plan `pos` = x, `fixed` = the front wall's z)."""
    for r in rooms_cache.values():
        for d in r.get("doors", []):
            if "Front Door" in d.get("name", ""):
                return d
    return None


def _entry_stair_span(f, rooms_cache):
    """Plan-x span (low, high) the front entry stair occupies on the north line —
    the gap the retaining wall has to leave for it. None if there's no front door."""
    fd = _front_door(rooms_cache)
    if not fd:
        return None
    half = f.get("entryWalkWidthFt", 5.0) / 2.0
    return (fd["pos"] - half, fd["pos"] + half)


def _driveway_span(lot, x_flat):
    """Plan-x span (lo, hi) the driveway occupies on the north frontage — the gap the
    park strip has to leave for its apron. None if no driveway is authored.

    Anchored to `x_flat`, the station where the public walk has climbed back to lot
    grade and the retaining wall stops. That is not decoration: west of it a drive would
    have to step down to meet the walk AND have a gap cut in the wall, and east of it it
    simply runs out level. So the drive's west edge sits on it."""
    d = lot.get("driveway") or {}
    if not d:
        return None
    return (x_flat - d.get("widthFt", 20), x_flat)


def add_driveway(ctx, lot, rooms_cache):
    """A two-car driveway on the east front yard: a pad from the yard fence north to
    the property line, and an apron carrying it across the planting strip to the walk.

    Level throughout — see `_driveway_span` for why it sits where it does. It needs no
    curb cut: on this stretch the curb's top is already flush with the walk and the lot,
    and only its extra thickness stands proud on the street side."""
    d = lot.get("driveway") or {}
    if not d:
        return
    f = lot.get("frontage") or {}
    CONCRETE = (0.74, 0.73, 0.71)                    # matches the sidewalk
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    half_wall = ctx.T / FT / 2
    _, east, _, north, _ = lot_lines(lot, B.values(), half_wall)
    x_flat = east + f.get("northLevelFromEastFt", 25)
    span = _driveway_span(lot, x_flat)
    if not span:
        return
    lo, hi = span
    TH = f.get("pavingThicknessIn", 4) / 12.0
    STRIP = f.get("parkStripWidthFt", 9)
    # South end: the yard fence. The drive runs up to it and the cars park against it.
    fence_z = max(max(B[k]["z1"], B[k]["z2"]) for k in EXT_WING if k in B) + half_wall

    def paving(name, z1, z2):
        b = make_box(ctx, "IfcSlab", name, abs(hi - lo) * FT, abs(z2 - z1) * FT, TH * FT,
                     ctx.X((lo + hi) / 2), ctx.Y((z1 + z2) / 2), -TH * FT,
                     predefined="BASESLAB", color=CONCRETE)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    paving("Driveway", fence_z, north)               # the pad, fence to the property line
    paving("Driveway apron", north, north + STRIP)   # across the planting strip to the walk


def add_yard_fence(ctx, lot, rooms_cache, base):
    """A 6 ft stained BOARD fence closing the rear yard: from the east extension's NE
    corner, east along that wing's north wall face, to the east property line.

    Its first 15 ft ride the new deck terrace, so it is built in SEGMENTS, each datumed
    to the surface under it — 6 ft above the deck, 6 ft above grade beyond, stepping at
    the terrace edge. That step lands on a real line: deck edge, stair head and the
    east setback all coincide there. Surface-datumed is the default because privacy is
    measured from where you stand, and because with `add_deck`'s guard rails gone this
    fence is the only thing on the terrace's north edge; `heightDatum: "grade"` gives
    one flat top line instead, which over the deck is exactly 42 in.

    Flat boards, so no `add_brep`: the picket fence's pentagon prism exists only for its
    pointed tip, and a brep per board would cost real file size twice over (the alt lot
    is a second copy of this model). IfcRailing, so it is not a walk-POV surface —
    the same reason `add_picket_fence` uses it.

    Every board is NAMED WITH AN INDEX. `extents()` in tools/ifc_check.py unions
    products by name, so the identical "Fence picket" names in add_picket_fence collapse
    into one unmeasurable box; indexing is what lets the harness check heights per
    segment."""
    f = lot.get("yardFence") or {}
    if not f:
        return
    FENCE = (0.42, 0.30, 0.21)                       # stained wood
    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    half_wall = ctx.T / FT / 2
    _, east, _, _, _ = lot_lines(lot, B.values(), half_wall)
    _, deck_east, deck_south, deck_north = deck_extent(rooms_cache, lot, half_wall)
    # The fence line is the east wing's north wall FACE. NOT taken from deck_extent:
    # the deck's north edge and the fence line used to be the same number and are not
    # any more, which is exactly the kind of coincidence that silently moves a fence
    # when the deck moves. Shared with add_side_porch, which notches around the post
    # this run starts on.
    fence_z, x_start = yard_fence_line(rooms_cache, half_wall)

    H = f.get("heightFt", 6.0)
    Wb, oc = f.get("boardWidthIn", 5.5) / 12, f.get("boardOcIn", 5.75) / 12
    Tb = f.get("boardThickIn", 0.75) / 12
    post_oc, nrail = f.get("postSpacingFt", 6.0), f.get("railCount", 3)
    surface = f.get("heightDatum", "surface") == "surface"

    def box(name, x1, x2, z1, z2, z0, h):
        w, dp = abs(x2 - x1), abs(z2 - z1)
        if w <= 1e-6 or dp <= 1e-6 or h <= 1e-6:
            return
        b = make_box(ctx, "IfcRailing", name, w * FT, dp * FT, h,
                     ctx.X((x1 + x2) / 2), ctx.Y((z1 + z2) / 2), z0, color=FENCE)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    # East -> west, split where the fence climbs ONTO the deck — which it only does if
    # the deck reaches this far north. With the terrace stopped at the house's south
    # wall for privacy it no longer does, so this is one run on grade; the split stays
    # because the deck's north edge is a number that has already moved once.
    over_deck = deck_south - 1e-6 <= fence_z <= deck_north + 1e-6
    segs = ([(east, deck_east, 0.0), (deck_east, x_start, base)] if over_deck
            else [(east, x_start, 0.0)])
    for si, (lo, hi, y0) in enumerate(segs):
        if hi - lo <= 1e-6:
            continue
        top = (y0 + H * FT) if surface else (H * FT)
        if top - y0 <= 1e-6:
            continue
        # posts, both ends plus an even division at no more than postSpacingFt
        n = max(1, int(round((hi - lo) / post_oc)))
        for i in range(n + 1):
            xc = lo + (hi - lo) * i / n
            hp = YARD_POST_FT / 2
            box(f"Yard fence post {si}.{i}", xc - hp, xc + hp,
                fence_z - hp, fence_z + hp, y0, top - y0 + 0.08)
        # rails, spread between the base and the top
        for j in range(nrail):
            yc = y0 + (top - y0) * (j + 0.5) / nrail
            box(f"Yard fence rail {si}.{j}", lo, hi, fence_z - Tb / 2, fence_z + Tb / 2,
                yc - 0.06, 0.12)
        # boards, on the yard side of the rails
        i, c = 0, lo + oc / 2
        while c < hi - 1e-6:
            box(f"Yard fence board {si}.{i}", c - Wb / 2, c + Wb / 2,
                fence_z + Tb / 2, fence_z + Tb / 2 + Tb, y0, top - y0)
            c += oc
            i += 1


def add_street_frontage(ctx, lot, rooms_cache):
    """Public frontage along the NORTH and WEST lot lines (this is a corner lot):
    a retaining wall standing on the property line to hold the flat lot above the
    falling street grade, and beyond it the right-of-way stepped down to match.

    The two frontages carry the SAME bands in the OPPOSITE order, which is how the
    street actually reads here:

        north:  property line | park strip | sidewalk   | curb | street
        west:   property line | sidewalk   | park strip | curb | street

    Both total parkStrip + sidewalk (13 ft here), so the curb lines agree and the
    paved NW corner block — which is what carries a pedestrian between the inboard
    west walk and the outboard north one — needs no special casing.

    The property stands highest above the sidewalk at the NW corner; the drop dies
    out in both directions (to nothing part-way along the north line, and to a low
    step at the SW corner), which works out to a steady ~4% walk each way. Only the
    right-of-way falls — the lot itself stays flat at grade. Footings are not
    modelled, as with the CMU lot wall.

    Every sloping piece is emitted as its own CONVEX prism: `add_brep` orients faces
    by testing them against the solid's centroid, which is only valid for convex
    solids, so the L wrapping the corner must not be built as one shape.
    """
    f = lot.get("frontage") or {}
    # Blue is deliberately <= red on the paving: the viewer treats a bluish exterior
    # material as window glass and makes it glow at night (see extWindowMats).
    CONCRETE = (0.74, 0.73, 0.71)                    # sidewalk / curb
    GRASS = (0.46, 0.55, 0.34)                       # matches the lot plane
    STUCCO = (0.90, 0.88, 0.84)                      # matches the CMU lot wall

    B = {k: v["bounds"] for k, v in rooms_cache.items()}
    west, east, south, north, _ = lot_lines(lot, B.values(), ctx.T / FT / 2)

    nw = f.get("nwDropIn", 36) / 12.0                # drop at the NW corner (ft)
    sw = f.get("swDropIn", 12) / 12.0                # drop at the SW corner (ft)
    x_flat = east + f.get("northLevelFromEastFt", 25)  # north drop dies out here
    WALK = f.get("sidewalkWidthFt", 4)
    STRIP = f.get("parkStripWidthFt", 6)
    CURB = f.get("curbWidthIn", 6) / 12.0
    CURB_T = f.get("curbDepthIn", 6) / 12.0
    TH = f.get("pavingThicknessIn", 4) / 12.0
    WT = f.get("wallThicknessIn", 10) / 12.0

    def at01(t):
        return max(0.0, min(1.0, t))

    def drop_n(px):
        """Sidewalk grade (ft below the lot) on the north frontage at plan x."""
        return -nw * at01((px - x_flat) / (west - x_flat))

    def drop_w(pz):
        """Sidewalk grade (ft below the lot) on the west frontage at plan z."""
        return -(sw + (nw - sw) * at01((pz - south) / (north - south)))

    # Band edges, measured outward from each property line. The two frontages run
    # DIFFERENT orders: on the north the walk sits outboard, hard against the curb,
    # with the planting strip inboard against the property line; on the west the walk
    # is inboard against the retaining wall. Both bands total the same, so the outer
    # edges (n2/n3, w2/w3) — and with them the corner block — line up either way.
    n1, n2, n3 = north + STRIP, north + STRIP + WALK, north + STRIP + WALK + CURB
    w1, w2, w3 = west + WALK, west + WALK + STRIP, west + WALK + STRIP + CURB

    def paving(name, x1, x2, z1, z2, top, color, th=TH):
        """Level paving; `top` (ft) is the finished surface, `th` runs below it."""
        b = make_box(ctx, "IfcSlab", name, abs(x2 - x1) * FT, abs(z2 - z1) * FT, th * FT,
                     ctx.X((x1 + x2) / 2), ctx.Y((z1 + z2) / 2), (top - th) * FT,
                     predefined="BASESLAB", color=color)
        run("spatial.assign_container", ctx.model, products=[b], relating_structure=ctx.storey)

    def ramp_n(name, z1, z2, color, th=TH):
        """North band falling with drop_n, from the west line east to x_flat."""
        poly = [(ctx.X(west), ctx.Y(z1), drop_n(west) * FT),
                (ctx.X(west), ctx.Y(z2), drop_n(west) * FT),
                (ctx.X(x_flat), ctx.Y(z2), drop_n(x_flat) * FT),
                (ctx.X(x_flat), ctx.Y(z1), drop_n(x_flat) * FT)]
        v, fc = _prism(poly, (0, 0, -th * FT))
        add_brep(ctx, name, v, fc, color, ifc_class="IfcSlab", predefined="BASESLAB")

    def ramp_w(name, x1, x2, color, th=TH):
        """West band falling with drop_w, from the north line south to the SW corner."""
        poly = [(ctx.X(x1), ctx.Y(north), drop_w(north) * FT),
                (ctx.X(x2), ctx.Y(north), drop_w(north) * FT),
                (ctx.X(x2), ctx.Y(south), drop_w(south) * FT),
                (ctx.X(x1), ctx.Y(south), drop_w(south) * FT)]
        v, fc = _prism(poly, (0, 0, -th * FT))
        add_brep(ctx, name, v, fc, color, ifc_class="IfcSlab", predefined="BASESLAB")

    # --- NORTH frontage: falling run out to x_flat, then level to the east line
    ramp_n("Park strip - north", north, n1, GRASS)
    ramp_n("Sidewalk - north", n1, n2, CONCRETE)
    ramp_n("Curb - north", n2, n3, CONCRETE, th=CURB_T)
    # The level park strip, minus the gap the driveway's apron crosses. Split here for
    # the same reason the retaining wall is split around the entry stair: two slabs at
    # the same top would z-fight, and the grass has to actually stop at the paving.
    drv = _driveway_span(lot, x_flat)
    if drv:
        paving("Park strip - north level", drv[0], east, north, n1, 0.0, GRASS)
    else:
        paving("Park strip - north level", x_flat, east, north, n1, 0.0, GRASS)
    paving("Sidewalk - north level", x_flat, east, n1, n2, 0.0, CONCRETE)
    paving("Curb - north level", x_flat, east, n2, n3, 0.0, CONCRETE, th=CURB_T)

    # --- WEST frontage: falls the whole way (36" at the NW corner -> 12" at the SW)
    ramp_w("Sidewalk - west", west, w1, CONCRETE)
    ramp_w("Park strip - west", w1, w2, GRASS)
    ramp_w("Curb - west", w2, w3, CONCRETE, th=CURB_T)

    # --- NW corner: a paved return where the two walks meet, both curb lines
    # carried around it. Flat — both frontages are at the same -nw here.
    paving("Sidewalk - NW corner", west, w2, north, n2, -nw, CONCRETE)
    paving("Curb - NW corner north", west, w3, n2, n3, -nw, CONCRETE, th=CURB_T)
    paving("Curb - NW corner west", w2, w3, north, n2, -nw, CONCRETE, th=CURB_T)

    # --- retaining wall, outer face ON the property line and the thickness running
    # inward (the add_lot_wall convention). The top is held FLUSH with the lot grade
    # so the picket fence along the west line sits on top of it instead of fighting
    # a raised cap.
    def wall(name, poly, vec):
        v, fc = _prism(poly, vec)
        add_brep(ctx, name, v, fc, STUCCO, ifc_class="IfcWall")

    # North leg, broken by the front entry stair. In elevation it is a trapezoid
    # between two plan-x stations — full height at the corner, dying to nothing at
    # x_flat where the walk has climbed to meet the lot. At x_flat the two bottom
    # points coincide, so drop the duplicate and let it degenerate to a triangle.
    def wall_n(name, pa, pb):
        pts = [(ctx.X(pa), ctx.Y(north), drop_n(pa) * FT),
               (ctx.X(pa), ctx.Y(north), 0.0),
               (ctx.X(pb), ctx.Y(north), 0.0)]
        if abs(drop_n(pb)) > 1e-9:
            pts.append((ctx.X(pb), ctx.Y(north), drop_n(pb) * FT))
        wall(name, pts, (0, -WT * FT, 0))

    stair = _entry_stair_span(f, rooms_cache)          # (px_low, px_high) or None
    if stair:
        wall_n("Retaining wall - north west of entry", west, stair[1])
        wall_n("Retaining wall - north east of entry", stair[0], x_flat)
    else:
        wall_n("Retaining wall - north", west, x_flat)
    # west leg: a trapezoid — runs the full property line, 36" down to 12".
    wall("Retaining wall - west",
         [(ctx.X(west), ctx.Y(north), drop_w(north) * FT),
          (ctx.X(west), ctx.Y(south), drop_w(south) * FT),
          (ctx.X(west), ctx.Y(south), 0.0),
          (ctx.X(west), ctx.Y(north), 0.0)],
         (WT * FT, 0, 0))

    # --- front entry: a walk across the planting strip, then a flight up through
    # the gap left in the retaining wall, landing at the foot of the porch cascade.
    # Centred on the front door, so the whole route reads sidewalk -> walk -> steps
    # -> cascade -> door.
    fd = _front_door(rooms_cache)
    if stair and fd:
        sx0, sx1 = stair
        foot = drop_n(fd["pos"])                       # walk grade at the stair
        steps = f.get("entryStepCount", 3)
        rise = -foot / steps                           # 1.5 ft over 3 risers = 6" each
        TREAD = f.get("entryTreadFt", 1.0)
        # The porch cascade (add_porch) springs 3.0 ft off the front wall then runs
        # (nst-1) treads of 0.95 ft; its foot lands here. Keep in step with add_porch.
        porch_foot = fd["fixed"] + 3.0 + 4 * 0.95
        # Walk over the planting strip, following the street's cross-slope so it
        # meets the sidewalk flush. Lifted a hair so it doesn't z-fight the grass.
        LIFT = 0.02
        poly = [(ctx.X(sx0), ctx.Y(north), (drop_n(sx0) + LIFT) * FT),
                (ctx.X(sx0), ctx.Y(n1), (drop_n(sx0) + LIFT) * FT),
                (ctx.X(sx1), ctx.Y(n1), (drop_n(sx1) + LIFT) * FT),
                (ctx.X(sx1), ctx.Y(north), (drop_n(sx1) + LIFT) * FT)]
        v, fc = _prism(poly, (0, 0, -TH * FT))
        add_brep(ctx, "Entry walk - planting strip", v, fc, CONCRETE,
                 ifc_class="IfcSlab", predefined="BASESLAB")
        # Solid steps marching south off the property line. Each is carried well
        # below the walk so the flight reads as masonry, not floating treads, and
        # fills the wall opening behind it.
        for i in range(1, steps + 1):
            z_near = north - (i - 1) * TREAD
            z_far = north - i * TREAD
            if i == steps:                             # last tread runs on as a
                z_far = min(z_far, porch_foot)         # landing to meet the cascade
            top = foot + i * rise
            paving(f"Entry step {i}", sx0, sx1, z_far, z_near, top, CONCRETE,
                   th=top - (foot - 0.5))


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
    """(front_z, specs) for the second-floor windows. NORTH (front/street) is
    locked: one upper over each ground-floor front opening (the even 5-bay
    rhythm). The other three faces are the flexible ones:
      - WEST wall: one upper over every ground-floor west opening.
      - SOUTH wall: 2 uppers, 1 per wing (one per rear bedroom), skipping the
        central stair/landing bay.
      - EAST: one upper on the primary east wall (the stretch exposed north of the
        extension), plus TWO east-facing uppers on the extension's far wall (its
        second-floor bathroom).
    All 2.5' wide, sill 2.5' / head 6' above the second floor. Shared by the
    exterior massing's upper row and the second-floor shell so they stay in sync."""
    front_z = max(r["bounds"]["z2"] for r in rooms)   # North (street) wall — locked
    rear_z  = min(r["bounds"]["z1"] for r in rooms)    # South wall
    west_x  = max(r["bounds"]["x2"] for r in rooms)    # West exterior wall
    W, SILL, HEAD = 2.5, 2.5, 6.0
    specs = []
    def add(name, orient, fixed, pos, sill=SILL, width=W, head=HEAD):
        specs.append({"name": name, "orient": orient, "fixed": fixed, "pos": pos,
                      "width": width, "sill": sill, "head": head})
    # NORTH (locked): one upper over each ground-floor front opening (windows + door).
    # `transom` opts an opening OUT: a transom is part of the opening below it, not a
    # bay of its own. Without this the front door's transom — same wall, same plan-x —
    # added a second bay on top of the door's, which shifted aligned_front_bays and
    # moved an attic dormer and the window bench with it.
    for r in rooms:
        for o in r.get("windows", []) + r.get("doors", []):
            if o.get("opening") or o.get("transom"):
                continue
            if o["orient"] == "H" and abs(o["fixed"] - front_z) < 1e-3:
                add(f"Upper - {o['name']}", "H", front_z, o["pos"])
    # WEST: one upper over EVERY ground-floor west opening — four now, so the elevation
    # reads four over four with both rows symmetric about the facade centre. This used to
    # be capped at three because the second floor's west partitions (pz -1 and 6) split
    # that wall into three rooms and a fourth bay would have straddled one; the owner is
    # re-planning those partitions around the openings instead, so the openings lead and
    # the plan follows. Anchoring to the ground floor is the same idiom the locked NORTH
    # face uses, so the row keeps up if the bays move again.
    west_rooms = [r for r in rooms if abs(r["bounds"]["x2"] - west_x) < 1e-3]
    for i, pos in enumerate(sorted(w["pos"] for r in west_rooms for w in r.get("windows", [])
                                   if w["orient"] == "V" and abs(w["fixed"] - west_x) < 1e-3)):
        add(f"Upper - West {i + 1}", "V", west_x, pos)
    # Split the rooms into the primary block vs. the extension (which juts to the
    # east, i.e. lower x). The extension carries the second-floor bathroom.
    ext_rooms  = [r for r in rooms if r["bounds"]["x1"] < -12 - 1e-3]
    prim_rooms = [r for r in rooms if r["bounds"]["x1"] >= -12 - 1e-3]
    # SOUTH: 2 uppers, 1 per wing (one per rear bedroom), skipping the central
    # stair/landing bay (foyer x-range)
    foyer = next((r for r in rooms if r.get("_stem") == "foyer"), None)
    if foyer and prim_rooms:
        cx1, cx2 = foyer["bounds"]["x1"], foyer["bounds"]["x2"]     # central bay to avoid
        px1 = min(r["bounds"]["x1"] for r in prim_rooms)            # primary east/west extent
        px2 = max(r["bounds"]["x2"] for r in prim_rooms)
        CORR = 4.5   # keep clear of the landing wall at each wing's inner edge
        # one window per wing, centered in the OUTER (rear-bedroom) span
        for (a, b, tag) in ((px1, cx1 - CORR, "E"), (cx2 + CORR, px2, "W")):  # east wing, west wing
            add(f"Upper - South {tag}", "H", rear_z, (a + b) / 2)
    # EAST: single upper on the primary east wall (exposed only north of the extension)
    if ext_rooms and prim_rooms:
        east_prim_x = min(r["bounds"]["x1"] for r in prim_rooms)    # primary east edge (x=-12)
        ext_top = max(r["bounds"]["z2"] for r in ext_rooms)         # extension north edge
        add("Upper - East", "V", east_prim_x, (ext_top + front_z) / 2)
        # extension en-suite: ONE east-facing upper centred on the double vanity
        # (between its two flanking mirrors), lighting the vanity / main area.
        ext_x = min(r["bounds"]["x1"] for r in ext_rooms)    # far (east) wall
        # A narrower, taller transom over the double vanity: sill ~8 in above the
        # counter (3.72 ft), raised head (6.5 ft), narrower than the standard upper.
        add("Upper - Ext bath", "V", ext_x, -3.75, sill=3.72, width=2.0, head=6.5)
    return front_z, specs


def aligned_front_bays(rooms, count):
    """`count` north-wall opening plan-x positions, centred within the front
    bay rhythm — so the dormers line up over the (inner) window bays instead of
    landing between them. e.g. 3 dormers over a 5-bay front -> the inner 3 bays."""
    _, specs = second_floor_windows(rooms)
    xs = sorted(s["pos"] for s in specs if s["orient"] == "H")
    if not xs or count <= 0:
        return None
    if count >= len(xs):
        return xs
    start = (len(xs) - count) // 2
    return xs[start:start + count]


def add_shell_windows(ctx, rooms):
    """Cut the second-floor window openings into a shell, kept in sync with the
    exterior massing's upper row (same walls, positions, and size)."""
    _, specs = second_floor_windows(rooms)
    for w in specs:
        cut_opening(ctx, "IfcWindow", w["name"], w["orient"], w["fixed"], w["pos"],
                    w["width"], w["sill"], w["head"], leaf=True)


def add_bay_window(ctx, room, win, base=0.0, crawl=0.0):
    """A CANTED BAY projecting from an exterior wall: a solid apron below the sill,
    glazing on all three faces, corner boards, a frieze + cornice, and a
    standing-seam copper hip roof.

    Shared by the ground level (rooms/kitchen.py) and the exterior massing
    (add_fenestration), so the two read identically. `win["bay"]` carries:
      projFt    projection measured from the FINISHED EXTERIOR FACE, not the wall line
      angleDeg  splay of the returns off the wall face (90 would be a square box bay).
                A true 45 deg bay is arithmetically out at a 3 ft projection: its
                returns would eat 6 ft of a 7 ft opening and leave a 1 ft front light.
      roof      "copper" — a standing-seam hip, the scullery's shed-with-hips language.
    Only V walls (running along Z) are handled; that is all this house needs.
    """
    spec = win.get("bay") or {}
    P = spec.get("projFt", 3.0)
    ang = math.radians(spec.get("angleDeg", 60))
    fixed, pos, W = win["fixed"], win["pos"], abs(win["width"])
    sill, head = win["sill"], ctx.head_ft
    COPPER, GLASS = (0.69, 0.43, 0.24), (0.42, 0.52, 0.60)
    WALL, TRIM, FOUND = (0.90, 0.89, 0.86), (0.93, 0.92, 0.88), (0.55, 0.54, 0.52)

    b = room["bounds"]
    bx1, bx2 = sorted((b["x1"], b["x2"]))
    out = 1.0 if abs(fixed - bx2) < 1e-6 else -1.0     # outward, in plan px
    Tft = ctx.T / FT                                   # wall thickness, plan ft
    face = fixed + out * Tft / 2                       # finished exterior face
    front = face + out * P                             # bay front face
    r = P / math.tan(ang)                              # run along the wall, per return
    a_s, a_n = pos - W / 2, pos + W / 2                # opening jambs
    f_s, f_n = a_s + r, a_n - r                        # front-face corners
    FACES = [((face, a_s), (front, f_s)),              # south return
             ((front, f_s), (front, f_n)),             # front
             ((front, f_n), (face, a_n))]              # north return
    Cx, Cy = ctx.X((face + front) / 2), ctx.Y(pos)     # bay centroid, for outward normals
    Z = lambda ft: base + ft * FT

    def _frame(p0, p1):
        ax, ay = ctx.X(p0[0]), ctx.Y(p0[1])
        bx, by = ctx.X(p1[0]), ctx.Y(p1[1])
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        nx, ny = (dy / L, -dx / L) if L else (0.0, 0.0)
        mx, my = (ax + bx) / 2, (ay + by) / 2
        if (mx + nx - Cx) ** 2 + (my + ny - Cy) ** 2 < (mx - nx - Cx) ** 2 + (my - ny - Cy) ** 2:
            nx, ny = -nx, -ny                          # make the normal point AWAY from the bay
        return (ax, ay, dx, dy, L, math.atan2(dy, dx), nx, ny)

    def band(p0, p1, t, z0, z1, color, name, cls="IfcBuildingElementProxy",
             inset=0.0, shrink=0.0, transparency=0.0):
        """A box along p0->p1 (plan ft), `t` thick, z0..z1 (metres). Its OUTER surface
        lands on the segment; `inset` pushes it further in, `shrink` trims its ends."""
        ax, ay, dx, dy, L, th, nx, ny = _frame(p0, p1)
        if L < 1e-6 or z1 - z0 <= 1e-9 or L - shrink <= 0:
            return
        d = t / 2 + inset
        p = make_box(ctx, cls, name, L - shrink, t, z1 - z0,
                     ax + dx / 2 - nx * d, ay + dy / 2 - ny * d, z0,
                     color=color, rot=th, transparency=transparency)
        run("spatial.assign_container", ctx.model, products=[p], relating_structure=ctx.storey)

    def stud(p0, p1, u, t, wd, z0, z1, color, name):
        """A narrow upright at fraction `u` along the segment: corner boards, muntins."""
        ax, ay, dx, dy, L, th, nx, ny = _frame(p0, p1)
        if L < 1e-6:
            return
        p = make_box(ctx, "IfcBuildingElementProxy", name, wd, t, z1 - z0,
                     ax + dx * u - nx * t / 2, ay + dy * u - ny * t / 2, z0, color=color, rot=th)
        run("spatial.assign_container", ctx.model, products=[p], relating_structure=ctx.storey)

    WT = ctx.T
    # --- foundation: carry the bay down through the crawlspace to grade -------
    if crawl > 0:
        for i, (p0, p1) in enumerate(FACES):
            band(p0, p1, WT, base - crawl, base, FOUND, f"Bay foundation {i + 1}", cls="IfcSlab")
    # --- apron below the sill: plinth, panelled field, water-table cap --------
    # The plinth matters: without it the apron is a blank 3'4" face from grade to sill
    # and the whole bay reads as a turret. Bounded by the corner boards either side and
    # these two bands top and bottom, the field between them reads as a recessed panel.
    for i, (p0, p1) in enumerate(FACES):
        band(p0, p1, WT, Z(0), Z(sill), WALL, f"Bay apron {i + 1}", cls="IfcWall")
        band(p0, p1, WT + 0.10, Z(0), Z(0.45), TRIM, f"Bay plinth {i + 1}")
        band(p0, p1, WT + 0.10, Z(sill - 0.30), Z(sill - 0.18), TRIM, f"Bay water table {i + 1}")
    # --- glazing: clear sheets, NOT divided ----------------------------------
    # The bay is the one place in the house without muntins — a grid across three
    # canted faces fights the form and cuts the light the bay exists to bring in.
    # `muntins: true` on the window spec puts the house grid back if ever wanted;
    # everywhere else in add_fenestration the default runs the other way.
    h = head - sill
    for i, (p0, p1) in enumerate(FACES):
        band(p0, p1, 0.08, Z(sill), Z(head), GLASS, f"Bay glazing {i + 1}",
             cls="IfcWindow", inset=0.04, shrink=0.36, transparency=0.6)
        if not win.get("muntins", False):
            continue
        Lft = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        cols, rows = max(2, round(Lft / 1.3)), max(2, round(h / 1.4))
        for k in range(1, cols):
            stud(p0, p1, k / cols, 0.10, 0.06, Z(sill), Z(head), TRIM, f"Bay muntin {i + 1}")
        for j in range(1, rows):
            zc = Z(sill + h * j / rows)
            band(p0, p1, 0.10, zc - 0.025, zc + 0.025, TRIM, f"Bay muntin {i + 1}", shrink=0.36)
    # --- corner boards at the four plan corners -------------------------------
    for i, (p0, p1) in enumerate(FACES):
        if i == 0:
            stud(p0, p1, 0.0, 0.14, 0.25, Z(0), Z(head), TRIM, "Bay corner board 1")
        stud(p0, p1, 1.0, 0.14, 0.25, Z(0), Z(head), TRIM, f"Bay corner board {i + 2}")
    # --- entablature: frieze, then a projecting cornice -----------------------
    for i, (p0, p1) in enumerate(FACES):
        band(p0, p1, 0.14, Z(head), Z(head + 0.55), TRIM, f"Bay frieze {i + 1}")
        band(p0, p1, 0.30, Z(head + 0.55), Z(head + 0.85), TRIM, f"Bay cornice {i + 1}")
    # --- standing-seam copper hip ---------------------------------------------
    # Six-vertex topology carried over from the copper hood this replaces: two front
    # eave points, two jamb points at the wall, and a ridge at the wall directly
    # behind the front corners. On a canted plan that IS the hip — the main slope is
    # a parallelogram and the two returns become triangles.
    OH, PITCH, TH = 0.5, 8 / 12, 0.06
    z_lo = Z(head + 0.85)
    z_hi = z_lo + (P + Tft / 2 + OH) * PITCH * FT
    fx, xf = ctx.X(face), ctx.X(front + out * OH)
    ylo, yhi = ctx.Y(a_s - OH), ctx.Y(a_n + OH)
    yrs, yrn = ctx.Y(f_s), ctx.Y(f_n)
    top = [(xf, yrs, z_lo), (xf, yrn, z_lo),      # 0,1 front eave
           (fx, ylo, z_lo), (fx, yhi, z_lo),      # 2,3 wall, low
           (fx, yrs, z_hi), (fx, yrn, z_hi)]      # 4,5 ridge
    verts = top + [(x, y, z - TH) for x, y, z in top]
    faces = [[4, 5, 1, 0], [2, 0, 4], [1, 3, 5], [2, 4, 5, 3],
             [10, 11, 7, 6], [8, 6, 10], [7, 9, 11], [8, 10, 11, 9],
             [0, 1, 7, 6], [1, 3, 9, 7], [3, 2, 8, 9], [2, 0, 6, 8]]
    add_brep(ctx, "Bay roof", verts, faces, COPPER, ifc_class="IfcBuildingElementProxy")
    rw, rh = 0.015, 0.04                          # raised seams down the main slope
    for k in range(6):
        y = yrs + (yrn - yrs) * (k + 0.5) / 6
        fv = [(fx, y - rw, z_hi), (fx, y + rw, z_hi), (xf, y - rw, z_lo), (xf, y + rw, z_lo)]
        fv += [(x, yy, z + rh) for x, yy, z in fv]
        ff = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6]]
        add_brep(ctx, "Bay roof seam", fv, ff, COPPER, ifc_class="IfcBuildingElementProxy")


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
    # Blind-bay panel: a shade darker than GLASS, so it reads as a window in shadow
    # rather than a black hole. At (0.22, 0.23, 0.25) it was far darker than the
    # glazed bays either side and broke the three-bay rhythm it exists to complete.
    BLIND = (0.32, 0.37, 0.42)
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

    def _lites(style):
        """"<n>lite" -> the row count for a divided-light leaf. Always two columns,
        so 8lite is 2 x 4 and 10lite is 2 x 5. Parsed rather than enumerated, so a
        new count needs no code."""
        if isinstance(style, str) and style.endswith("lite") and style[:-4].isdigit():
            n = int(style[:-4])
            if n >= 2 and n % 2 == 0:
                return n // 2
        return None

    def door_leaf(name, orient, fixed, pos, w_ft, z0, z1, style="panel", paint=None):
        """An architectural stile-and-rail door leaf, built from boxes on the
        wall face (the solid massing sits behind it). A backing slab carries the
        IfcDoor; frame members + panels/glazing add relief on top.
          - "panel"   -> a raised six-panel door (2 cols x 3 rows).
          - "<n>lite" -> a divided-light glazed door, 2 columns by n/2 rows.
        Depths step outward (slab < panel/glass < frame < muntin) so panels read
        raised and the muntin grid sits proud of the glass. `paint` overrides the
        default stained-wood colour (e.g. "white" for a painted door)."""
        WOOD = {"white": (0.92, 0.92, 0.89)}.get(paint, (0.38, 0.24, 0.13))
        w, H = abs(w_ft), z1 - z0
        if H <= 0.1 or w <= 0:
            return
        STILE, TRAIL, BRAIL, MUN = 0.46, 0.46, 0.92, 0.10        # member sizes (ft)
        DOUBLE_FT = 1.2 / FT                                     # pair above this width
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
        rows = _lites(style)
        botm = (0.42 if (rows or style == "patio") else BRAIL) * FT   # bottom rail (m)
        fz0, fz1 = z0 + botm, z1 - TRAILm                        # inner field height (m)
        # frame relief (proud): stiles + top + bottom rails
        dbox(pos - (w - STILE) / 2, STILE, z0, z1, DFRAME, WOOD)
        dbox(pos + (w - STILE) / 2, STILE, z0, z1, DFRAME, WOOD)
        dbox(pos, fw, fz1, z1, DFRAME, WOOD)                     # top rail
        dbox(pos, fw, z0, fz0, DFRAME, WOOD)                     # bottom rail
        mh = MUN * FT / 2                                        # half muntin/rail thickness (m)
        if rows or style == "patio":
            # PAIRING and DIVISION are independent. A door wider than the double-door
            # threshold gets a centre meeting post and two glass fields; each field is
            # then divided (or not) on its own. Without this a 6'8" french door asked
            # for 8 lites drew ONE grid straight across the opening with no meeting
            # stile. The threshold is the viewer's DOUBLE (src/main.js) in feet, so
            # both files break a door into leaves at the same width.
            if w > DOUBLE_FT:
                CP = 0.5                                         # centre meeting post (ft)
                dbox(pos, CP, fz0, fz1, DFRAME, WOOD)
                pane = (fw - CP) / 2                             # one leaf's glass (ft)
                off = (CP + pane) / 2                            # pane centre from middle
                fields = ((pos - off, pane), (pos + off, pane))
            else:
                fields = ((pos, fw),)
            for cc, pane in fields:
                dbox(cc, pane, fz0, fz1, DPANE, GLASS)           # glazed field
                if not rows:                                     # "patio": undivided sheet
                    continue
                dbox(cc, MUN, fz0, fz1, DMUN, WOOD)              # 1 vertical -> 2 cols
                for j in range(1, rows):                         # rows-1 horizontal
                    zc = fz0 + j * (fz1 - fz0) / rows
                    dbox(cc, pane, zc - mh, zc + mh, DMUN, WOOD)
        elif style == "halfmoon":
            # A panelled door with a HALF-ROUND light in the top. The arch is stepped
            # from boxes here — this path only draws the exterior massing, and dbox is
            # all it has; the viewer cuts a true arc (see leafParts in src/main.js).
            r = fw / 2                                           # arch radius (ft)
            spring = fz1 - r * FT                                # springline
            LOCK = 0.5
            dbox(pos, fw, spring - LOCK * FT, spring, DFRAME, WOOD)          # lock rail under the arch
            dbox(pos, MUN, fz0, spring - LOCK * FT, DFRAME, WOOD)            # muntin -> two lower panels
            for cc in (pos - (fw + MUN) / 4, pos + (fw + MUN) / 4):
                dbox(cc, (fw - MUN) / 2 - 0.12, fz0 + 0.10 * FT,
                     spring - (LOCK + 0.10) * FT, DPANE, WOOD)               # raised panels
            N = 7
            for j in range(N):                                               # stepped half-round
                y0 = spring + j * (r * FT) / N
                y1 = spring + (j + 1) * (r * FT) / N
                mid = (j + 0.5) / N                                          # 0..1 up the arc
                half = r * math.sqrt(max(0.0, 1.0 - mid * mid))
                dbox(pos, 2 * half, y0, y1, DPANE, GLASS)
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

    def window(name, orient, fixed, pos, w, sill_m, head_m, trim="full", muntins=True,
               blind=False):
        """A glass panel with a classical surround + divided-light muntins. Trim
        styles distinguish the floors / facades:
          - "full" (side/rear ground): casing, a projecting sill + apron, and a
            projecting header cornice.
          - "lintel" (front ground): a flat lintel band + central keystone over a
            projecting sill + apron.
          - "upper": casing + a projecting sill (nothing below it) + a small
            cornice — lighter than the ground floor.
        A board/box runs along the wall axis (X for an H wall, Z for a V) and is
        centred on the wall face.
        `blind` makes a BLIND BAY: the same trim and sashes over a dark recessed panel
        instead of glass, and no opening in the wall (add_windows skips it). The classic
        device for a bay the elevation needs but the plan cannot give — here the
        kitchen/dining party wall lands on the west facade's centre line."""
        panel("IfcBuildingElementProxy" if blind else "IfcWindow", name,
              orient, fixed, pos, w, sill_m, head_m, BLIND if blind else GLASS)
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
        # jambs + head casing are common to every style (frieze lights stop at the
        # head — no reveal above — so they clear the dentil course).
        jamb_top = head_m if trim == "frieze" else head_top
        tbox(f"Casing - {name}", pos - (w + CW) / 2, CW, sill_m, jamb_top, 0.12)
        tbox(f"Casing - {name}", pos + (w + CW) / 2, CW, sill_m, jamb_top, 0.12)
        sill_bot = sill_m - 0.12
        if trim == "frieze":
            # short frieze light: just jambs + a slim sill; the dentil course above
            # reads as the head, so there is no projecting head cornice to collide.
            tbox(f"Sill - {name}", pos, w + 2 * CW, sill_m - 0.08, sill_m, 0.12)
        elif trim == "upper":
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
                if win.get("bay"):
                    add_bay_window(ctx, r, win, base=base, crawl=base)
                    continue
                window(win["name"], o, f, p, win["width"],
                       base + win["sill"] * FT, base + win["head"] * FT,
                       trim="lintel" if front else "full", muntins=win.get("muntins", True),
                       blind=win.get("blind", False))
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
        # Second-floor windows — SINGLE source (second_floor_windows), shared with the
        # level2 shell. Feed it the SAME 2-storey room set (primary + extension) the
        # shell uses, so the facade and the interior shell get identical openings.
        two_storey = list(prim["rooms"]) + list(groups.get("extension", {}).get("rooms", []))
        _, specs = second_floor_windows([rooms_cache[s] for s in two_storey])
        for w in specs:
            window(w["name"], w["orient"], w["fixed"], w["pos"], w["width"],
                   base + ctx.story + w["sill"] * FT, base + ctx.story + w["head"] * FT, trim="upper")
        # frieze-band attic lights set into the raised plate, one over each upper —
        # the smallest, shortest tier, so the graduated fenestration carries up the
        # wall (ground -> second -> frieze) and fills the band under the cornice.
        ewall_ft = prim.get("eaveWallFt", 0.0)
        if ewall_ft >= 1.5:
            band = base + 2 * ctx.story            # plate base = floor-2 top
            # short horizontal lights that tuck between the belt course and the
            # dentil course under the cornice (a classic frieze-window band).
            for w in specs:
                if "Ext bath" in w["name"]:      # extension is a shed roof — no frieze band
                    continue
                window(f"Frieze - {w['name']}", w["orient"], w["fixed"], w["pos"], 2.0,
                       band + 0.45 * FT, band + 1.10 * FT, trim="frieze", muntins=False)
        door = next((o for s in prim["rooms"] for o in rooms_cache[s].get("doors", [])
                     if "Front Door" in o.get("name", "")), None)
        if door:
            add_entry(ctx, door["pos"], front_z, door["width"], base)



def add_slab(ctx, r, opening=None):
    x1, x2, y1, y2 = ifc_bounds(ctx, r["bounds"])
    if not opening:
        slab = make_box(ctx, "IfcSlab", f"Slab - {r['name']}",
                        abs(x2 - x1), abs(y2 - y1), ctx.slab_t,
                        (x1 + x2) / 2, (y1 + y2) / 2, -ctx.slab_t, predefined="FLOOR")
        run("spatial.assign_container", ctx.model, products=[slab], relating_structure=ctx.storey)
        return slab
    # cut a rectangular hole (a stairwell): tile the slab as a frame of bands
    # around the opening. Inputs are PLAN feet; flip + sort into IFC metres.
    X1, X2 = sorted((x1, x2)); Y1, Y2 = sorted((y1, y2))
    ox1, ox2 = sorted((ctx.X(opening["x1"]), ctx.X(opening["x2"])))
    oy1, oy2 = sorted((ctx.Y(opening["z1"]), ctx.Y(opening["z2"])))
    ox1, ox2 = max(ox1, X1), min(ox2, X2)
    oy1, oy2 = max(oy1, Y1), min(oy2, Y2)
    bands = [(X1, X2, Y1, oy1), (X1, X2, oy2, Y2),       # south + north full-width bands
             (X1, ox1, oy1, oy2), (ox2, X2, oy1, oy2)]    # west + east side bands
    slabs = []
    for a, b, c, d in bands:
        if b - a < 1e-4 or d - c < 1e-4:
            continue
        s = make_box(ctx, "IfcSlab", f"Slab - {r['name']}", b - a, d - c, ctx.slab_t,
                     (a + b) / 2, (c + d) / 2, -ctx.slab_t, predefined="FLOOR")
        run("spatial.assign_container", ctx.model, products=[s], relating_structure=ctx.storey)
        slabs.append(s)
    return slabs


def add_hardwood_finish(ctx, r):
    """A flat hardwood FLOORING covering over the room footprint (tiled as a frame
    around any floorOpening, like the slab), recorded to plank_floors so the viewer
    re-renders it as instanced planks — the same hardwood the ground floor uses."""
    rgb = (0.55, 0.36, 0.18)
    x1, x2, y1, y2 = ifc_bounds(ctx, r["bounds"])
    X1, X2 = sorted((x1, x2)); Y1, Y2 = sorted((y1, y2))
    opening = r.get("floorOpening")
    if opening:
        ox1, ox2 = sorted((ctx.X(opening["x1"]), ctx.X(opening["x2"])))
        oy1, oy2 = sorted((ctx.Y(opening["z1"]), ctx.Y(opening["z2"])))
        ox1, ox2 = max(ox1, X1), min(ox2, X2)
        oy1, oy2 = max(oy1, Y1), min(oy2, Y2)
        rects = [(X1, X2, Y1, oy1), (X1, X2, oy2, Y2), (X1, ox1, oy1, oy2), (ox2, X2, oy1, oy2)]
    else:
        rects = [(X1, X2, Y1, Y2)]
    for i, (a, b, c, d) in enumerate(rects):
        if b - a < 1e-4 or d - c < 1e-4:
            continue
        name = f"{r['name']} - Hardwood Flooring" + (f" {i}" if opening else "")
        cov = make_box(ctx, "IfcCovering", name, b - a, d - c, 0.05 * FT,
                       (a + b) / 2, (c + d) / 2, 0.0, predefined="FLOORING", color=rgb)
        run("spatial.assign_container", ctx.model, products=[cov], relating_structure=ctx.storey)
        ctx.plank_floors.append({"name": name, "rgb": [round(c2, 4) for c2 in rgb]})


def add_tile_finish(ctx, r, pattern):
    """A flat tile FLOORING covering over the room footprint, recorded to
    tile_floors so the viewer re-renders it as an instanced mosaic (`pattern`).
    Used on levels (e.g. the shell 2nd floor) where a room's declarative
    interior.flooring isn't otherwise applied — lets the primary en-suite run one
    continuous tile pattern across its shared footprint rooms. The mosaic is
    globally anchored, so the per-room coverings tile seamlessly at their shared
    wall centerlines."""
    rgb = (0.85, 0.84, 0.80)                # light tile base (mosaic drawn over it)
    x1, x2, y1, y2 = ifc_bounds(ctx, r["bounds"])
    X1, X2 = sorted((x1, x2)); Y1, Y2 = sorted((y1, y2))
    opening = r.get("floorOpening")
    if opening:
        ox1, ox2 = sorted((ctx.X(opening["x1"]), ctx.X(opening["x2"])))
        oy1, oy2 = sorted((ctx.Y(opening["z1"]), ctx.Y(opening["z2"])))
        ox1, ox2 = max(ox1, X1), min(ox2, X2)
        oy1, oy2 = max(oy1, Y1), min(oy2, Y2)
        rects = [(X1, X2, Y1, oy1), (X1, X2, oy2, Y2), (X1, ox1, oy1, oy2), (ox2, X2, oy1, oy2)]
    else:
        rects = [(X1, X2, Y1, Y2)]
    for i, (a, b, c, d) in enumerate(rects):
        if b - a < 1e-4 or d - c < 1e-4:
            continue
        name = f"{r['name']} - Tile Flooring" + (f" {i}" if opening else "")
        cov = make_box(ctx, "IfcCovering", name, b - a, d - c, 0.05 * FT,
                       (a + b) / 2, (c + d) / 2, 0.0, predefined="FLOORING", color=rgb)
        run("spatial.assign_container", ctx.model, products=[cov], relating_structure=ctx.storey)
        ctx.tile_floors.append({"name": name, "pattern": pattern})


def _rect_minus(a, b, c, d, hole):
    """Rectangle [a,b]x[c,d] minus an axis-aligned `hole` (x1,x2,y1,y2, same metres),
    returned as a list of non-overlapping sub-rectangles (a frame of bands around the
    hole). No `hole` / no overlap -> the rectangle unchanged."""
    if not hole:
        return [(a, b, c, d)]
    hx1, hx2 = sorted((hole[0], hole[1])); hy1, hy2 = sorted((hole[2], hole[3]))
    ix1, ix2 = max(a, hx1), min(b, hx2); iy1, iy2 = max(c, hy1), min(d, hy2)
    if ix1 >= ix2 or iy1 >= iy2:
        return [(a, b, c, d)]
    out = []
    if iy1 > c: out.append((a, b, c, iy1))          # south band
    if d > iy2: out.append((a, b, iy2, d))          # north band
    if ix1 > a: out.append((a, ix1, iy1, iy2))      # west band
    if b > ix2: out.append((ix2, b, iy1, iy2))      # east band
    return out


def _floor_cover(ctx, basename, a, b, c, d, rgb, hole, kind):
    """Tile rect [a,b]x[c,d] (IFC metres) as IfcCovering FLOORING (minus `hole`).
    `kind` routes the viewer re-render: "plank" -> instanced hardwood planks,
    "sheet" -> 4x8 plywood subfloor sheets, None -> left as a flat IFC covering."""
    sink = {"plank": ctx.plank_floors, "sheet": ctx.subfloors}.get(kind)
    for i, (aa, bb, cc, dd) in enumerate(_rect_minus(a, b, c, d, hole)):
        if bb - aa < 1e-4 or dd - cc < 1e-4:
            continue
        name = f"{basename} {i}"
        cov = make_box(ctx, "IfcCovering", name, bb - aa, dd - cc, 0.05 * FT,
                       (aa + bb) / 2, (cc + dd) / 2, 0.0, predefined="FLOORING", color=rgb)
        run("spatial.assign_container", ctx.model, products=[cov], relating_structure=ctx.storey)
        if sink is not None:
            sink.append({"name": name, "rgb": [round(c2, 4) for c2 in rgb]})


def add_attic_floor_finish(ctx, r):
    """Attic floor finish: finished hardwood ONLY inside the USABLE rectangle
    (`ctx.attic_usable` — where the sloped ceiling clears standing headroom), and
    4x8 plywood SUBFLOOR everywhere beyond it (the low-headroom band by the knee
    walls + the storage triangles). They meet exactly at the usable-headroom line.
    Both tile around any floorOpening (the stairwell void)."""
    HARD = (0.55, 0.36, 0.18)               # finished oak (re-rendered as planks)
    SUB = (0.74, 0.64, 0.46)                # plywood subfloor (re-rendered as 4x8 sheets)
    x1, x2, y1, y2 = ifc_bounds(ctx, r["bounds"])
    X1, X2 = sorted((x1, x2)); Y1, Y2 = sorted((y1, y2))
    usable = getattr(ctx, "attic_usable", None)
    if not usable:
        add_hardwood_finish(ctx, r); return     # no usable rect -> full hardwood
    UX1, UX2 = sorted((usable[0], usable[1])); UY1, UY2 = sorted((usable[2], usable[3]))
    hx1, hx2 = max(UX1, X1), min(UX2, X2)        # usable rect clipped to this room
    hy1, hy2 = max(UY1, Y1), min(UY2, Y2)
    hole = None
    opening = r.get("floorOpening")
    if opening:
        ox1, ox2 = sorted((ctx.X(opening["x1"]), ctx.X(opening["x2"])))
        oy1, oy2 = sorted((ctx.Y(opening["z1"]), ctx.Y(opening["z2"])))
        hole = (ox1, ox2, oy1, oy2)
    if hx2 <= hx1 or hy2 <= hy1:                  # room entirely beyond the usable rect
        _floor_cover(ctx, f"{r['name']} - Subfloor", X1, X2, Y1, Y2, SUB, hole, "sheet")
        return
    _floor_cover(ctx, f"{r['name']} - Hardwood Flooring", hx1, hx2, hy1, hy2, HARD, hole, "plank")
    for j, band in enumerate([(X1, X2, Y1, hy1), (X1, X2, hy2, Y2),
                              (X1, hx1, hy1, hy2), (hx2, X2, hy1, hy2)]):
        a, b, c, d = band
        if b - a < 1e-4 or d - c < 1e-4:
            continue
        _floor_cover(ctx, f"{r['name']} - Subfloor {j}", a, b, c, d, SUB, hole, "sheet")


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
            # `doorStyle` reached only the exterior massing, so a glazed door read as a
            # plain slab from inside. The viewer's leaf needs it too.
            "style": d.get("doorStyle", "panel"),
        })
        # `openDeg` overrides the viewer's default 90 deg swing for this door only.
        # A leaf can only lie flat against its own wall if the wall RETURNS past the
        # jamb by at least the leaf width; where it does not, this is how far it goes.
        if d.get("openDeg") is not None:
            ctx.door_meta[-1]["openDeg"] = float(d["openDeg"])
        # A door set into a glazed SCREEN derives its lite grid from the screen rather
        # than from a lite count, so the horizontals cross the mullion. Same two numbers
        # add_glazed_frame uses for the sidelights beside it.
        if d.get("screen"):
            ctx.door_meta[-1]["screen"] = d["screen"]


def add_glazed_frame(ctx, r, w, sill, head):
    """Frame a fixed light — a TRANSOM over an opening, or a SIDELIGHT beside one —
    on the ROOM side of the wall.

    Sized off the same `casingFt` the wall-finish trim program uses, at the same
    projection, with stiles CENTRED on the opening edges the way post() centres a
    door casing. A door with sidelights and a transom is one composition, and the
    only way it reads as one is if every member is the same width and depth and the
    verticals line up.

    Which members each kind gets:
      transom   bar below + stiles + rail above. The bar is the single head member
                across the WHOLE composition, which is why wall-finish suppresses the
                door's own head casing wherever a transom spans it — otherwise the two
                stack, or worse land co-planar and z-fight.
      sidelight stiles + a rail at the sill. No top rail: the transom's bar is already
                the head member over it.
    """
    # STEEL: a Crittall-style screen — slim dark sections and mostly glass, subdivided
    # into lites by muntins on the same thin section. Painted joinery casing is the
    # default; steel is a different construction, not a recolour, so it takes its own
    # width, depth and colour and adds a lite grid the joinery version has no use for.
    steel = bool(w.get("steel"))
    TRIM = (0.17, 0.18, 0.19) if steel else (0.93, 0.92, 0.88)
    CW = w.get("frameFt", 0.06 if steel else 0.33)
    DEP = w.get("frameDepFt", 0.10 if steel else 0.148)
    b = r["bounds"]
    pos, W = w["pos"], abs(w["width"])
    half = ctx.T / FT / 2
    if w["orient"] != "H":
        return                                        # V walls would mirror this
    inward = -1 if abs(w["fixed"] - max(b["z1"], b["z2"])) < 1e-6 else 1
    face = w["fixed"] + inward * half
    cz = face + inward * DEP / 2

    def bar(name, cx, wide, z0, z1):
        pr = make_box(ctx, "IfcBuildingElementProxy", name, wide * FT, DEP * FT,
                      (z1 - z0) * FT, ctx.X(cx), ctx.Y(cz), z0 * FT, color=TRIM)
        run("spatial.assign_container", ctx.model, products=[pr],
            relating_structure=ctx.storey)

    # `abutsDoor` is the [lo, hi] plan-x of a door this light sits beside. That door's
    # CASING JAMB is already the mullion between them, so the stile on that side is
    # skipped — drawn, the two land co-planar in the same colour at the same depth and
    # z-fight. It also clamps the sill, which otherwise runs its casing return straight
    # across the bottom of the doorway. The door is authored in the neighbouring room's
    # file, so this cannot be discovered from `r` and has to be stated.
    door = w.get("abutsDoor")
    edges = [pos - W / 2, pos + W / 2]

    def near_door(x):
        return door is not None and min(abs(x - door[0]), abs(x - door[1])) < 0.4

    if w.get("transom"):
        bar(f"{w['name']} bar", pos, W + 2 * CW, sill - CW, sill)
        bar(f"{w['name']} rail", pos, W + 2 * CW, head, head + CW)
    else:                                             # sidelight: a sill, no top rail
        lo = edges[0] - (0 if near_door(edges[0]) else CW)
        hi = edges[1] + (0 if near_door(edges[1]) else CW)
        # Glazed to the FINISHED FLOOR there is no curb to sit under: the bottom member
        # rests ON the floor instead of below the glass line, which for sill 0 would put
        # it under the slab. Matches the door leaf, whose floor rail also sits at 0.
        z0 = sill - CW if sill >= CW else 0.0
        bar(f"{w['name']} sill", (lo + hi) / 2, hi - lo, z0, z0 + CW)
    # Named per side: plan px increases WEST, so the lower edge is the EAST stile.
    # They were both just "stile", and anything keying on the name (tools/ifc_check.py)
    # then saw one member spanning both and could not check either.
    for x, side in zip(edges, ("stile E", "stile W")):
        if not w.get("transom") and near_door(x) and not steel:
            continue                                  # the door casing is the mullion
        bar(f"{w['name']} {side}", x, CW, sill, head)

    # LITE GRID. Divisions are sized to a target pane and then evened out, so panes stay
    # square-ish whatever the light's proportions instead of one axis stretching.
    if steel:
        lw = w.get("liteFt", 1.55)
        cols = max(1, int(round(W / lw)))
        rows = max(1, int(round((head - sill) / (lw * 1.35))))
        for i in range(1, cols):
            bar(f"{w['name']} muntin V{i}", edges[0] + i * W / cols, CW, sill, head)
        for j in range(1, rows):
            y = sill + j * (head - sill) / rows
            bar(f"{w['name']} muntin H{j}", pos, W, y - CW / 2, y + CW / 2)


def add_windows(ctx, r):
    for w in r.get("windows", []):
        if w.get("blind"):
            continue          # blind bay: exterior trim only, the wall stays solid
        if w.get("bay"):      # bay window: cut the hole, the glazing is in the bay itself
            cut_opening(ctx, "IfcWindow", w["name"], w["orient"], w["fixed"], w["pos"],
                        w["width"], w["sill"], ctx.head_ft, leaf=False)
            continue
        # Uniform head for every window (sills stay as authored) — the whole house lines
        # up on one head line, so an authored `head` is deliberately IGNORED here.
        # A transom is the one real exception: it sits ABOVE that line, stacked on the
        # opening it belongs to, so it authors its own head. Without this carve-out a
        # transom with sill == head_ft came out ZERO HEIGHT, and both it and its opening
        # then failed to produce geometry at all — a silently missing window, not an error.
        # A transom authors its own head (it sits ABOVE the uniform head line); a
        # sidelight runs up TO that line like everything else, so it keeps the default.
        head = w["head"] if w.get("transom") else ctx.head_ft
        if head <= w["sill"]:
            # Loud, because the quiet version cost a debugging round: a zero-height
            # window still produces an IfcWindow and an IfcOpeningElement, so nothing
            # looks wrong until you notice the wall is solid where the glass should be.
            raise ValueError(
                f"{w['name']}: head {head} is not above sill {w['sill']} — the window "
                f"would be zero height. A transom sitting ON the head line must author "
                f"its own `head` and carry `transom: true`.")
        cut_opening(ctx, "IfcWindow", w["name"], w["orient"], w["fixed"], w["pos"],
                    w["width"], w["sill"], head)
        if w.get("transom") or w.get("sidelight"):
            add_glazed_frame(ctx, r, w, w["sill"], head)
