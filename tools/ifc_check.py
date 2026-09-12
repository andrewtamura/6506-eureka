#!/usr/bin/env python
"""Assert GENERATOR-built geometry against the .ifc files it just wrote.

    /tmp/ifcvenv/bin/python tools/ifc_check.py

Covers the lot (setbacks, street frontage) and the glazed door compositions
(transom and sidelight frames). Both are things tools/kitchen-check.mjs cannot see
properly: it measures the BUILT MESHES in the viewer, and fragments merges IFC
products that share a material into one mesh — so a four-member transom frame
reads as a single box, and which boxes merge changes as soon as anything nearby is
added. Those assertions were rewritten three times chasing that. Members are
individually addressable here and stay that way.

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


# --- GLAZED DOOR COMPOSITIONS ---------------------------------------------------
# A door, its casing, any sidelights and any transom are ONE composition. It only
# reads as one if every member shares a width and depth and the verticals line up,
# so the assertions are about agreement between members, not absolute sizes.
print('\nGLAZED DOOR COMPOSITIONS')
CW, DEP = 0.33, 0.148            # casingFt, and the casing's 0.045 m projection
G = extents(gnd, lambda nm, p: ('Transom' in nm or 'Sidelight' in nm) and not nm.startswith('Opening'))


def members(prefix, suffix):
    return [(k, v) for k, v in G.items() if k.startswith(prefix) and k.endswith(suffix)]


for door, tname, opening in (('front door', 'Transom - Front Door', (8.0, 11.0)),
                             ('foyer door', 'Transom - Foyer', (6.5, 12.5))):
    bar = G.get(f'{tname} bar')
    rail = G.get(f'{tname} rail')
    glass = G.get(tname)
    stiles = [v for k, v in G.items() if k.startswith(tname) and ' stile ' in k]
    check(bar and rail and glass and len(stiles) == 2,
          f'{door}: transom has a bar, two stiles, a rail and glazing')
    if not (bar and rail and glass and len(stiles) == 2):
        continue
    # One head member, a casing deep, sitting on the door head and carrying the sill.
    check(near(bar[5] - bar[4], CW) and near(rail[5] - rail[4], CW),
          f'{door}: bar and rail are one casing width ({bar[5] - bar[4]:.3f} / {rail[5] - rail[4]:.3f})')
    check(near(bar[1] - bar[0], rail[1] - rail[0]),
          f'{door}: bar and rail the same width, {bar[1] - bar[0]:.3f} ft — no step')
    check(near(bar[5], glass[4]), f'{door}: the bar tops out at the glass sill ({bar[5]:.3f})')
    check(near(rail[4], glass[5]), f'{door}: the rail starts at the glass head ({rail[4]:.3f})')
    # Stiles centred on the glass edges, the way post() centres a door casing.
    for v in stiles:
        mid = (v[0] + v[1]) / 2
        check(min(abs(mid - glass[0]), abs(mid - glass[1])) < 1e-3,
              f'{door}: stile centred on a glass edge ({mid:.3f})')
    check(all(near(v[5] - v[4], glass[5] - glass[4]) for v in stiles),
          f'{door}: stiles run the full height of the glass')
    check(all(near(v[3] - v[2], DEP) for v in [bar, rail] + stiles),
          f'{door}: every member projects one casing depth ({DEP})')

# SIDELIGHTS flanking the foyer door. Their INNER stile is deliberately absent — the
# door's casing jamb is the mullion there, and drawing both lands two identical boxes
# co-planar. So each sidelight has exactly ONE stile, on its outer edge.
for side, inner in (('Sidelight - Foyer E', 8.0), ('Sidelight - Foyer W', 11.0)):
    glass, sill = G.get(side), G.get(f'{side} sill')
    stiles = [v for k, v in G.items() if k.startswith(side) and ' stile ' in k]
    check(glass and sill and len(stiles) == 1,
          f'{side}: glazing, a sill and ONE stile ({len(stiles)} stiles — the door casing is the other mullion)')
    if not (glass and sill and len(stiles) == 1):
        continue
    mid = (stiles[0][0] + stiles[0][1]) / 2
    check(abs(mid - inner) > 1.0, f'{side}: its stile is the OUTER one ({mid:.3f}, door edge {inner})')
    check(near(sill[5], glass[4]), f'{side}: sill tops out at the glass ({sill[5]:.3f})')
    # The sill must not run its casing return across the bottom of the doorway.
    lo, hi = min(sill[0], sill[1]), max(sill[0], sill[1])
    check(lo >= 6.4 and hi <= 12.6 and not (lo < 11.0 < hi and lo < 8.0),
          f'{side}: sill stops at the door, {lo:.3f}..{hi:.3f}')

print('\n' + ('ALL CHECKS PASSED' if not fails else f'{len(fails)} FAILED'))
sys.exit(1 if fails else 0)
