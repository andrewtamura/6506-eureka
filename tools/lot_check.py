#!/usr/bin/env python
"""Assert the lot's setbacks and street frontage against the GENERATED geometry.

    /tmp/ifcvenv/bin/python tools/lot_check.py

The lot bands are IFC entities, not viewer meshes, so this measures the .ifc files
that generate_ifc.py just wrote rather than the numbers that went into them. Three
traps cost a pass each while this was being written, all of them worth keeping:

  * `create_shape` returns LOCAL coordinates unless you ask for world ones. Half the
    frontage is built with make_box (local, centred on the origin) and half with
    add_brep (world, baked in), so without `use-world-coords` the two halves silently
    disagree and only the widths mean anything. Set it.
  * The IFC's vertical axis is z, so plan pz comes from vert[1], NOT -vert[1]. Getting
    that sign wrong mirrors the whole lot about the origin and still looks plausible,
    because the bands are symmetric in width.
  * The northmost WALL in exterior.ifc is a porch cheek at pz 20.35, not the house.
    The primary north exterior wall is in ground.ifc. Measure the yard from that one
    or you report a 6 ft yard for a 10 ft one.
"""
import sys
import numpy as np
import ifcopenshell
import ifcopenshell.geom

FT = 0.3048
S = ifcopenshell.geom.settings()
S.set('use-world-coords', True)

fails = []


def check(ok, msg):
    print(('  PASS  ' if ok else '  FAIL  ') + msg)
    if not ok:
        fails.append(msg)


def extents(model, keep):
    """{name: (pxLo, pxHi, pzLo, pzHi, yLo, yHi)} for products `keep(name)` accepts."""
    out = {}
    for p in model.by_type('IfcProduct'):
        nm = getattr(p, 'Name', None) or ''
        if not keep(nm, p):
            continue
        try:
            sh = ifcopenshell.geom.create_shape(S, p)
        except Exception:
            continue
        v = np.array(sh.geometry.verts).reshape(-1, 3)
        px, pz, y = -v[:, 0] / FT, v[:, 1] / FT, v[:, 2] / FT
        b = (px.min(), px.max(), pz.min(), pz.max(), y.min(), y.max())
        o = out.get(nm)
        out[nm] = b if not o else (min(o[0], b[0]), max(o[1], b[1]), min(o[2], b[2]),
                                   max(o[3], b[3]), min(o[4], b[4]), max(o[5], b[5]))
    return out


def near(a, b, tol=0.01):
    return abs(a - b) < tol


ext = ifcopenshell.open('ifc/exterior.ifc')
gnd = ifcopenshell.open('ifc/ground.ifc')

BANDS = ('Park strip', 'Sidewalk', 'Curb', 'Retaining wall', 'Lot')
E = extents(ext, lambda nm, p: nm.startswith(BANDS))

print('FRONTAGE BANDS')
# North frontage reads (property line) park strip, sidewalk, curb — walk outboard.
# West frontage reads (property line) sidewalk, park strip, curb — walk inboard.
# The bands are emitted twice on the north: a falling ramp and, east of where the
# drop dies out, a level run. Both must be the same width.
for nm, want, axis in (('Park strip - north', 9.0, 'pz'), ('Park strip - north level', 9.0, 'pz'),
                       ('Sidewalk - north', 4.0, 'pz'), ('Sidewalk - north level', 4.0, 'pz'),
                       ('Park strip - west', 9.0, 'px'), ('Sidewalk - west', 4.0, 'px')):
    lo, hi = (E[nm][2], E[nm][3]) if axis == 'pz' else (E[nm][0], E[nm][1])
    check(near(hi - lo, want), f'{nm} is {want:.0f} ft wide ({hi - lo:.4f})')

north = E['Retaining wall - west'][3]                  # north property line
check(near(E['Park strip - north'][2], north),
      f'park strip starts at the north property line ({north:.4f})')
check(near(E['Sidewalk - north'][2], E['Park strip - north'][3]),
      'north walk butts the park strip, no gap')
check(near(E['Curb - north'][2], E['Sidewalk - north'][3]),
      'north curb butts the walk, no gap')
# The two curb LINES are perpendicular — one is a pz, one a px — so they are not
# comparable to each other. What has to agree is the total width of the two bands,
# which is what squares up the paved NW corner block and lets it be a plain
# rectangle. (Asserting the raw curb values equal fails on a correct model.)
west_line = E['Retaining wall - west'][1]
n_total, w_total = E['Curb - north'][3] - north, E['Curb - west'][1] - west_line
check(near(n_total, w_total),
      f'both frontages are the same width, so the NW corner squares up ({n_total:.4f} / {w_total:.4f})')
check(near(n_total, 13.5), f'frontage is park strip + sidewalk + curb = 13.5 ft ({n_total:.4f})')
corner = E['Sidewalk - NW corner']
check(near(corner[0], west_line) and near(corner[2], north),
      'the NW corner block starts at both property lines')
check(near(corner[1], E['Park strip - west'][1]) and near(corner[3], E['Sidewalk - north'][3]),
      'the NW corner block runs out to both curb faces')

print('\nNORTH YARD')
# The PRIMARY north exterior wall — a full-storey house wall in ground.ifc, not the
# porch cheeks that stand 4 ft further north in exterior.ifc.
W = extents(gnd, lambda nm, p: p.is_a('IfcWall'))
wall_face = max(b[3] for b in W.values())
rw = min(v[2] for k, v in E.items() if k.startswith('Retaining wall - north'))
check(near(wall_face, 16.3125), f'primary north wall face at pz {wall_face:.4f}')
yard = rw - wall_face
check(near(yard, 10.0), f'CLEAR NORTH YARD is 10 ft, wall face to retaining wall ({yard:.4f})')
check(near(north - rw, 10 / 12), f'retaining wall is 10 in thick, outer face on the line ({north - rw:.4f})')

print('\n' + ('ALL CHECKS PASSED' if not fails else f'{len(fails)} FAILED'))
sys.exit(1 if fails else 0)
