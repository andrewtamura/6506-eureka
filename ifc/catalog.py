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


def _place(ctx, r, prod, cx_m, cy_m, cz_m):
    run("geometry.edit_object_placement", ctx.model, product=prod,
        matrix=B.matrix(cx_m, cy_m, cz_m))
    run("spatial.assign_container", ctx.model, products=[prod],
        relating_structure=ctx.storey)


def _covering(ctx, r, name, predefined, thickness_ft, z_m):
    """Floor/ceiling covering: a thin slab over the room footprint."""
    x1, x2, y1, y2 = B.ifc_bounds(ctx, r["bounds"])
    inset = ctx.T / 2
    cov = B.make_box(ctx, "IfcCovering", name,
                     abs(x2 - x1) - 2 * inset, abs(y2 - y1) - 2 * inset,
                     thickness_ft * FT, (x1 + x2) / 2, (y1 + y2) / 2, z_m,
                     predefined=predefined)
    run("spatial.assign_container", ctx.model, products=[cov],
        relating_structure=ctx.storey)


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

    if interior.get("flooring"):
        _covering(ctx, r, f"{r['name']} - Flooring", "FLOORING", 0.05, 0.0)
    if interior.get("ceiling"):
        _covering(ctx, r, f"{r['name']} - Ceiling", "CEILING", 0.05, ctx.H - 0.05)

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
