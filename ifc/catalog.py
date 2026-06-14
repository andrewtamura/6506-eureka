"""Interior-design catalog: turns a room's declarative ``interior`` block into
IFC elements. This is the shared vocabulary — add new item types here, and every
room can use them from its JSON.

Each room's ``interior`` block looks like::

    "interior": {
      "flooring":  { "material": "oak",     "thickness": 0.05 },
      "ceiling":   { "material": "plaster" },
      "furniture": [ { "type": "dining_table", "at": [x, z], "w": 6, "d": 3.5, "h": 2.5, "rot": 0 } ],
      "lighting":  [ { "type": "pendant", "at": [x, z] } ],
      "rugs":      [ { "at": [x, z], "w": 8, "d": 5 } ],
      "cabinetry": [ { "wall": "N", "from": 2, "to": 8, "depth": 2, "h": 3 } ]
    }

Positions/sizes are in PLAN feet (same convention as the room data); placement
goes through ``Ctx.X``/``Ctx.Y`` so it inherits the cardinal-orientation flip.
Geometry is intentionally simple (proxy boxes / coverings) — enough to read the
design intent; refine per item type as needed.
"""

from ifcopenshell.api import run
import builders as B

FT = B.FT

# Material name -> RGB (0..1). Extend as new finishes are needed.
MATERIALS = {
    "hardwood": (0.55, 0.36, 0.18),
    "oak":      (0.62, 0.44, 0.24),
    "walnut":   (0.36, 0.24, 0.16),
    "tile":     (0.85, 0.85, 0.82),
    "carpet":   (0.62, 0.60, 0.56),
    "concrete": (0.70, 0.70, 0.70),
    "plaster":  (0.94, 0.93, 0.91),
}
DEFAULT_FLOOR = MATERIALS["hardwood"]


def material_color(name, fallback):
    return MATERIALS.get((name or "").lower(), fallback)


def _place(ctx, r, prod, cx_m, cy_m, cz_m):
    run("geometry.edit_object_placement", ctx.model, product=prod,
        matrix=B.matrix(cx_m, cy_m, cz_m))
    run("spatial.assign_container", ctx.model, products=[prod],
        relating_structure=ctx.storey)


def _covering(ctx, r, name, predefined, thickness_ft, z_m, color=None):
    """Floor/ceiling covering: a thin slab over the room footprint."""
    x1, x2, y1, y2 = B.ifc_bounds(ctx, r["bounds"])
    inset = ctx.T / 2
    cov = B.make_box(ctx, "IfcCovering", name,
                     abs(x2 - x1) - 2 * inset, abs(y2 - y1) - 2 * inset,
                     thickness_ft * FT, (x1 + x2) / 2, (y1 + y2) / 2, z_m,
                     predefined=predefined, color=color)
    run("spatial.assign_container", ctx.model, products=[cov],
        relating_structure=ctx.storey)


WOODS = {"hardwood", "oak", "walnut"}


def _scale(rgb, f):
    return tuple(max(0.0, min(1.0, c * f)) for c in rgb)


def _plank_floor(ctx, r, base):
    """Realistic hardwood: staggered planks with per-board shade variation over a
    dark base, giving grain direction, board joints and groove lines."""
    x1, x2, y1, y2 = B.ifc_bounds(ctx, r["bounds"])
    m = ctx.T / 2
    x1, x2, y1, y2 = x1 + m, x2 - m, y1 + m, y2 - m
    shades = [_scale(base, f) for f in (0.86, 0.95, 1.0, 1.08, 0.9)]
    groove = _scale(base, 0.32)
    th = 0.05 * FT
    grain_x = (x2 - x1) >= (y2 - y1)           # planks run along the longer axis
    u0, u1, v0, v1 = (x1, x2, y1, y2) if grain_x else (y1, y2, x1, x2)
    pw, rgap = 0.5 * FT, 0.012 * FT            # board width 6", groove between rows
    seg, egap = 6.0 * FT, 0.03 * FT            # board length 6', end gap

    solids = []
    base_solid = B.positioned_solid(ctx, x2 - x1, y2 - y1, th * 0.5,
                                    (x1 + x2) / 2, (y1 + y2) / 2, 0.0)
    B.style_item(ctx, base_solid, groove)
    solids.append(base_solid)

    zt = th * 0.5
    v, ri = v0, 0
    while v < v1 - 1e-6:
        depth = min(pw, v1 - v) - rgap
        if depth < 0.03:
            break
        cv = v + depth / 2
        u = u0 - (ri % 3) * (seg / 3.0)        # stagger board joints row to row
        ci = 0
        while u < u1 - 1e-6:
            a, b = max(u, u0), min(u + seg - egap, u1)
            if b - a > 0.05:
                cu, length = (a + b) / 2, b - a
                if grain_x:
                    s = B.positioned_solid(ctx, length, depth, th, cu, cv, zt)
                else:
                    s = B.positioned_solid(ctx, depth, length, th, cv, cu, zt)
                B.style_item(ctx, s, shades[(ri * 5 + ci) % len(shades)])
                solids.append(s)
            u += seg
            ci += 1
        v += pw
        ri += 1

    cov = B.multi_solid_product(ctx, "IfcCovering",
                                f"{r['name']} - Hardwood Flooring", solids,
                                predefined="FLOORING")
    run("spatial.assign_container", ctx.model, products=[cov], relating_structure=ctx.storey)


def _box_item(ctx, r, ifc_class, name, item, default_h, predefined=None):
    """Generic box-shaped item (furniture, fixture, rug, cabinet) placed at a
    plan ``at`` point, sitting on the floor unless ``z`` is given."""
    at = item.get("at", [0, 0])
    w = float(item.get("w", 2)) * FT
    d = float(item.get("d", 2)) * FT
    h = float(item.get("h", default_h)) * FT
    base = item.get("z")
    cz = (base * FT) if base is not None else 0.0
    label = item.get("name") or item.get("type") or name
    prod = B.make_box(ctx, ifc_class, f"{r['name']} - {label}", w, d, h,
                      ctx.X(at[0]), ctx.Y(at[1]), cz + h / 2,
                      predefined=predefined)
    _place(ctx, r, prod, ctx.X(at[0]), ctx.Y(at[1]), cz)
    return prod


def build_interior(ctx, r):
    interior = r.get("interior") or {}
    if not interior:
        return

    fl = interior.get("flooring")
    if fl:
        mat = (fl.get("material") or "").lower()
        color = material_color(mat, DEFAULT_FLOOR)
        if mat in WOODS:
            _plank_floor(ctx, r, color)        # realistic staggered planks
        else:
            _covering(ctx, r, f"{r['name']} - {mat.title()} Flooring",
                      "FLOORING", 0.05, 0.0, color=color)
    cl = interior.get("ceiling")
    if cl:
        color = material_color(cl.get("material"), MATERIALS["plaster"])
        _covering(ctx, r, f"{r['name']} - Ceiling", "CEILING", 0.05, ctx.H - 0.05, color=color)

    for item in interior.get("furniture", []):
        _box_item(ctx, r, "IfcFurniture", item.get("type", "Furniture"), item, 2.5)
    for item in interior.get("cabinetry", []):
        _box_item(ctx, r, "IfcFurniture", item.get("type", "Cabinetry"), item, 3.0)
    for item in interior.get("lighting", []):
        # light fixtures hang just below the ceiling unless told otherwise
        it = dict(item)
        it.setdefault("z", (ctx.H / FT) - 0.8)
        it.setdefault("w", 1.0); it.setdefault("d", 1.0); it.setdefault("h", 0.7)
        _box_item(ctx, r, "IfcLightFixture", item.get("type", "Light"), it, 0.7)
    for item in interior.get("rugs", []):
        it = dict(item)
        it.setdefault("h", 0.05)
        _box_item(ctx, r, "IfcCovering", "Rug", it, 0.05, predefined="FLOORING")
