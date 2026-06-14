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

import math
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


def _covering(ctx, r, name, predefined, thickness_ft, z_m, color=None):
    """Floor/ceiling covering over the room footprint, extended to the wall
    centerlines so floors run continuously through door openings/thresholds."""
    x1, x2, y1, y2 = B.ifc_bounds(ctx, r["bounds"])
    cov = B.make_box(ctx, "IfcCovering", name,
                     abs(x2 - x1), abs(y2 - y1),
                     thickness_ft * FT, (x1 + x2) / 2, (y1 + y2) / 2, z_m,
                     predefined=predefined, color=color)
    run("spatial.assign_container", ctx.model, products=[cov],
        relating_structure=ctx.storey)


WOODS = {"hardwood", "oak", "walnut"}


def _scale(rgb, f):
    return tuple(max(0.0, min(1.0, c * f)) for c in rgb)


def _hash(n):
    """Deterministic pseudo-random in [0,1) for irregular stagger/shade."""
    v = math.sin(n * 12.9898) * 43758.5453
    return v - math.floor(v)


def _plank_floor(ctx, r, base, material):
    """Realistic hardwood. Boards run East-West (along world X) and sit on a
    GLOBAL grid anchored in world coords, so they line up continuously from room
    to room. Per-row pseudo-random stagger + per-board shade variation break the
    regularity. A dark base shows through the joints as groove lines.

    The viewer re-renders these as one instanced mesh; we record the covering
    name + colour in ``ctx.plank_floors`` (written to floors.json) so the viewer
    finds them by an explicit manifest rather than guessing from the name."""
    # Extend to the wall centerlines (full bounds, no inset) so floors of
    # adjacent rooms meet under the walls and run continuously through door
    # openings/thresholds (the wall hides the overlap; openings reveal it).
    x1, x2, y1, y2 = B.ifc_bounds(ctx, r["bounds"])
    shades = [_scale(base, f) for f in (0.82, 0.9, 0.97, 1.05, 1.12, 0.86, 1.0)]
    groove = _scale(base, 0.30)
    th = 0.05 * FT
    pw, rgap = 0.5 * FT, 0.012 * FT     # board width 6" (across grain, N-S)
    seg, egap = 10.0 * FT, 0.03 * FT    # board length 10' (along grain, E-W)

    solids = []
    base_solid = B.positioned_solid(ctx, x2 - x1, y2 - y1, th * 0.5,
                                    (x1 + x2) / 2, (y1 + y2) / 2, 0.0)
    B.style_item(ctx, base_solid, groove)
    solids.append(base_solid)

    zt = th * 0.5
    # Rows indexed on a global grid (k = world-Y band) so adjacent rooms share
    # row lines; joints offset per row by a global pseudo-random stagger.
    for k in range(math.floor(y1 / pw), math.ceil(y2 / pw)):
        ry0, ry1 = max(k * pw, y1), min((k + 1) * pw, y2)
        depth = (ry1 - rgap) - ry0
        if depth < 0.03:
            continue
        cy = (ry0 + ry1 - rgap) / 2
        off = _hash(k) * seg
        for j in range(math.floor((x1 - off) / seg), math.ceil((x2 - off) / seg)):
            px0 = off + j * seg
            a, b = max(px0, x1), min(px0 + seg - egap, x2)
            if b - a < 0.05:
                continue
            s = B.positioned_solid(ctx, b - a, depth, th, (a + b) / 2, cy, zt)
            B.style_item(ctx, s, shades[int(_hash(k * 131.7 + j * 7.31) * len(shades)) % len(shades)])
            solids.append(s)

    name = f"{r['name']} - {material.title()} Flooring"
    cov = B.multi_solid_product(ctx, "IfcCovering", name, solids, predefined="FLOORING")
    run("spatial.assign_container", ctx.model, products=[cov], relating_structure=ctx.storey)
    ctx.plank_floors.append({"name": name, "rgb": [round(c, 4) for c in base]})


def _item_color(item, default):
    """Resolve an item's colour: explicit ``color`` [r,g,b] wins, else look up
    its ``material``, else the category default."""
    c = item.get("color")
    if c:
        return tuple(c)
    if item.get("material") or default:
        return material_color(item.get("material"), default)
    return None


def _rotate_plan(dx, dz, rad):
    """Rotate a plan-space offset (feet) by ``rad`` about the vertical axis."""
    c, s = math.cos(rad), math.sin(rad)
    return dx * c - dz * s, dx * s + dz * c


def _box(ctx, r, ifc_class, label, cx_ft, cz_ft, w_ft, d_ft, h_ft, base_ft,
         rot_rad, color, predefined=None):
    """Place one box (plan feet) and contain it in the storey."""
    prod = B.make_box(ctx, ifc_class, f"{r['name']} - {label}",
                      w_ft * FT, d_ft * FT, h_ft * FT,
                      ctx.X(cx_ft), ctx.Y(cz_ft), base_ft * FT + h_ft * FT / 2,
                      predefined=predefined, color=color, rot=rot_rad)
    run("spatial.assign_container", ctx.model, products=[prod], relating_structure=ctx.storey)
    return prod


def _box_item(ctx, r, ifc_class, name, item, default_h, predefined=None, default_color=None):
    """A furniture/fixture/rug item placed at a plan ``at`` point. Supports
    ``rot`` (degrees, about vertical), per-item ``color``/``material``, and an
    optional ``parts`` list of sub-boxes (offset dx/dz, size w/d/h, z, colour)
    for pieces made of several blocks (e.g. a table = top + legs)."""
    at = item.get("at", [0, 0])
    label = item.get("name") or item.get("type") or name
    # plan rotation -> IFC rotation (the cardinal flip reverses the turn sense)
    rot = math.radians(float(item.get("rot", 0))) * (ctx.xs * ctx.zs)
    color = _item_color(item, default_color)
    parts = item.get("parts")
    if parts:
        for i, p in enumerate(parts):
            ox, oz = _rotate_plan(float(p.get("dx", 0)), float(p.get("dz", 0)), rot)
            _box(ctx, r, ifc_class, f"{label} {i + 1}",
                 at[0] + ox / FT, at[1] + oz / FT,
                 float(p.get("w", 1)), float(p.get("d", 1)), float(p.get("h", 1)),
                 float(p.get("z", item.get("z", 0))), rot,
                 _item_color(p, color), predefined=predefined)
        return
    cz = float(item["z"]) if item.get("z") is not None else 0.0
    return _box(ctx, r, ifc_class, label, at[0], at[1],
                float(item.get("w", 2)), float(item.get("d", 2)), float(item.get("h", default_h)),
                cz, rot, color, predefined=predefined)


# Interior categories: one declarative table instead of a loop each. ``ceiling``
# items hang just below the ceiling. Add a category by adding a row here.
CATEGORIES = {
    "furniture": dict(ifc="IfcFurniture",    h=2.5,  label="Furniture", color=MATERIALS["walnut"]),
    "cabinetry": dict(ifc="IfcFurniture",    h=3.0,  label="Cabinetry", color=MATERIALS["oak"]),
    "lighting":  dict(ifc="IfcLightFixture", h=0.7,  label="Light",     color=(0.95, 0.9, 0.7),
                      ceiling=True, w=1.0, d=1.0),
    "rugs":      dict(ifc="IfcCovering",     h=0.05, label="Rug",       color=MATERIALS["carpet"],
                      predefined="FLOORING"),
}


def build_interior(ctx, r):
    interior = r.get("interior") or {}
    if not interior:
        return

    fl = interior.get("flooring")
    if fl:
        mat = (fl.get("material") or "").lower()
        color = material_color(mat, DEFAULT_FLOOR)
        if mat in WOODS:
            _plank_floor(ctx, r, color, mat)   # realistic staggered planks
        else:
            _covering(ctx, r, f"{r['name']} - {mat.title()} Flooring",
                      "FLOORING", 0.05, 0.0, color=color)
    cl = interior.get("ceiling")
    if cl:
        color = material_color(cl.get("material"), MATERIALS["plaster"])
        _covering(ctx, r, f"{r['name']} - Ceiling", "CEILING", 0.05, ctx.H - 0.05, color=color)

    for cat, spec in CATEGORIES.items():
        for item in interior.get(cat, []):
            it = dict(item)
            if spec.get("ceiling"):            # hang below the ceiling by default
                it.setdefault("z", (ctx.H / FT) - 0.8)
                it.setdefault("w", spec["w"]); it.setdefault("d", spec["d"])
            _box_item(ctx, r, spec["ifc"], item.get("type", spec["label"]), it, spec["h"],
                      predefined=spec.get("predefined"), default_color=spec["color"])
