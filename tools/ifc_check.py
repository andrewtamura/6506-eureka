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
import glob
import json

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
# Driven off what the ROOM FILES author, not off hard-coded sizes. The first version
# asserted the joinery numbers (0.33 casing, 0.148 deep) and every one of them failed
# the moment the foyer screen became steel — which is correct geometry failing a test
# that had baked in one construction. What actually has to hold is that the generated
# members agree with the spec and with EACH OTHER: one section throughout, stiles on
# the glass edges, rails meeting the glass.
print('\nGLAZED DOOR COMPOSITIONS')
specs = []
for rf in sorted(glob.glob('ifc/rooms/*.json')):
    for wspec in json.load(open(rf)).get('windows', []):
        if wspec.get('transom') or wspec.get('sidelight'):
            specs.append(wspec)
G = extents(gnd, lambda nm, p: ('Transom' in nm or 'Sidelight' in nm) and not nm.startswith('Opening'))

for wspec in specs:
    nm = wspec['name']
    steel = bool(wspec.get('steel'))
    CW = wspec.get('frameFt', 0.06 if steel else 0.33)
    DEP = wspec.get('frameDepFt', 0.10 if steel else 0.148)
    lo, hi = wspec['pos'] - abs(wspec['width']) / 2, wspec['pos'] + abs(wspec['width']) / 2
    sill, head = wspec['sill'], wspec['head']
    glass = G.get(nm)
    parts = {k: v for k, v in G.items() if k.startswith(nm + ' ')}
    label = f"{nm} [{'steel' if steel else 'joinery'}]"
    check(glass and near(glass[0], lo) and near(glass[1], hi)
          and near(glass[4], sill) and near(glass[5], head),
          f'{label}: glazed as authored, {lo:.3f}..{hi:.3f} x {sill:.2f}..{head:.2f}')
    check(parts, f'{label}: framed ({len(parts)} members)')
    if not parts:
        continue
    # ONE section throughout: every member is CW in its thin axis and DEP deep.
    bad = [k for k, v in parts.items()
           if not near(v[3] - v[2], DEP)
           or not (near(v[1] - v[0], CW) or near(v[5] - v[4], CW))]
    check(not bad, f'{label}: every member is one {CW} ft section, {DEP} ft deep'
                   + ('' if not bad else f' — off: {", ".join(sorted(bad))}'))
    # Rails meet the glass they bound.
    for key, edge, desc in (('bar', sill, 'bar tops out at the glass sill'),
                            ('sill', sill, 'sill tops out at the glass'),
                            ('rail', head, 'rail starts at the glass head')):
        v = parts.get(f'{nm} {key}')
        if v is None:
            continue
        check(near(v[5], edge) or near(v[4], edge), f'{label}: {desc} ({edge:.3f})')
    # Stiles sit on the glass edges and run its full height.
    stiles = [v for k, v in parts.items() if ' stile ' in k]
    check(stiles, f'{label}: {len(stiles)} stile(s)')
    for v in stiles:
        mid = (v[0] + v[1]) / 2
        check(min(abs(mid - lo), abs(mid - hi)) < 1e-3, f'{label}: stile on a glass edge ({mid:.3f})')
        check(near(v[4], sill) and near(v[5], head), f'{label}: stile runs the full height')
    # Steel is a LITE GRID, which is the whole point of it — thin lines, many panes.
    if steel:
        mv = [v for k, v in parts.items() if ' muntin V' in k]
        mh = [v for k, v in parts.items() if ' muntin H' in k]
        check(mv or mh, f'{label}: subdivided into lites ({len(mv)} vertical, {len(mh)} horizontal)')
        panes = (len(mv) + 1) * (len(mh) + 1)
        check(panes >= 4, f'{label}: {panes} panes')
        for v in mv:
            check(near(v[4], sill) and near(v[5], head), f'{label}: vertical muntin runs sill to head')

# --- EVERY WINDOW IS TRIMMED -----------------------------------------------------
# The trim program runs PER ROOM: a room without an `interior.paneling` block gets no
# casing, no stool, no apron and no baseboard, and its windows are raw holes in the
# plaster. Nothing downstream notices — the browser harness can only measure trim that
# exists, so a whole room of untrimmed windows reads as zero failures. The sitting room
# sat like that through every improvement made to the casing profile.
#
# Checked against the room files rather than the geometry, because that is where the
# omission lives.
print('\nEVERY WINDOW IS TRIMMED')
model = json.load(open('ifc/model.json'))
# A room can appear in several levels' lists (the extension rooms are carried by the
# level-2 shell too), so walk the union rather than each level's list.
stems = sorted({s for level in model['levels'] for s in level.get('rooms', [])})
for stem in stems:
    room = json.load(open(f'ifc/rooms/{stem}.json'))
    wins = [w for w in room.get('windows', []) if not w.get('blind')]
    if not wins:
        continue
    pan = (room.get('interior') or {}).get('paneling')
    check(bool(pan), f"{stem}: {len(wins)} window(s), and a trim program to case them"
                     + ('' if pan else ' — MISSING, they will be raw openings'))

# --- GLAZING FITS UNDER THE CORNICE ----------------------------------------------
# A room that carries the entablature seats its frieze directly ON the head line, and
# the crown tops out ~1.3 ft above that. So anything glazed on one of its walls has to
# stop at the head line: a transom above a door drives straight through the frieze, the
# bed mould and the crown, which is exactly what the foyer's steel screen did once the
# foyer got a trim program. Checked from the room files, because the collision is
# between a WINDOW's head and a PANELING option, and neither is geometry the browser
# harness can see as wrong — it would happily measure a cornice with a window through it.
print('\nGLAZING FITS UNDER THE CORNICE')
model_j = json.load(open('ifc/model.json'))
head_ft = model_j.get('headFt', 7.0)
stems_g = sorted({s for level in model_j['levels'] for s in level.get('rooms', [])})
rooms_g = {s: json.load(open(f'ifc/rooms/{s}.json')) for s in stems_g}
# walls that belong to a room with a cornice, keyed by (orient, fixed)
corniced = set()
for stem, room in rooms_g.items():
    pan = (room.get('interior') or {}).get('paneling')
    if not pan or pan.get('noCornice') is True:
        continue
    b = room['bounds']
    # The along-extent matters as well as the wall line: the dining room's north wall
    # and the vestibule's share the line z = 16.0833, and without this the front door's
    # transom — 20 ft away along it, and over a room that has noCornice — was reported
    # as driving through the dining room's cornice.
    xs, zs = sorted([b['x1'], b['x2']]), sorted([b['z1'], b['z2']])
    for orient, fixed, span in (('H', b['z1'], xs), ('H', b['z2'], xs),
                                ('V', b['x1'], zs), ('V', b['x2'], zs)):
        corniced.add((stem, orient, round(fixed, 3), span[0], span[1]))
bad = 0
for stem, room in rooms_g.items():
    for w in room.get('windows', []):
        if w.get('blind'):
            continue
        # A ROUND window has a centre and a radius rather than a width and a head; its
        # top is what would run through a cornice (the one in the house straddles the
        # head line by a foot, in a room with none).
        rnd = bool(w.get('round'))
        half = w.get('radiusFt', 1.0) if rnd else abs(w['width']) / 2
        top = w['centerFt'] + half if rnd else w['head']
        wlo, whi = w['pos'] - half, w['pos'] + half
        hit = [c for c in corniced if c[1] == w['orient'] and abs(c[2] - w['fixed']) < 0.3
               and min(whi, c[4]) - max(wlo, c[3]) > 0.05]
        if not hit:
            continue
        over = top - head_ft
        if over > 0.01:
            bad += 1
            check(False, f"{w['name']}: head {top} ft is {over:.2f} ft ABOVE the "
                         f"{head_ft} ft line, through {hit[0][0]}'s cornice")
check(bad == 0, f"no glazing runs up through a cornice ({len(corniced)} corniced walls checked)")

# --- A DOOR IN A SCREEN SHARES THE SCREEN'S GRID -----------------------------------
# The leaf derives its lite grid from `screen` in the door's own spec, and the sidelights
# beside it from their own `sill`/`liteFt`. Those are in DIFFERENT room files — the foyer
# door and the vestibule's sidelights — so nothing stops them drifting apart, and when
# they do the horizontals simply stop crossing the mullion. Checked here because it is a
# relationship between two specs; the browser harness can only see the result.
print('\nDOOR SHARES ITS SCREEN\'S GRID')
model_s = json.load(open('ifc/model.json'))
stems_s = sorted({s for level in model_s['levels'] for s in level.get('rooms', [])})
rooms_s = {s: json.load(open(f'ifc/rooms/{s}.json')) for s in stems_s}
screened = 0
for stem, room in rooms_s.items():
    for d in room.get('doors', []):
        sc = d.get('screen')
        if not sc:
            continue
        screened += 1
        # every sidelight on the same wall line, from any room
        mates = [w for r in rooms_s.values() for w in r.get('windows', [])
                 if w.get('sidelight') and w['orient'] == d['orient']
                 and abs(w['fixed'] - d['fixed']) < 0.3]
        check(bool(mates), f"{d['name']}: sits in a screen ({len(mates)} sidelight(s) on its wall)")
        for w in mates:
            check(abs(w['sill'] - sc.get('sillFt', -1)) < 0.01,
                  f"{d['name']} vs {w['name']}: same sill "
                  f"({sc.get('sillFt')} vs {w['sill']}) — the screen's bottom line")
            check(abs(w.get('liteFt', 1.55) - sc.get('liteFt', -1)) < 0.01,
                  f"{d['name']} vs {w['name']}: same lite size "
                  f"({sc.get('liteFt')} vs {w.get('liteFt')}) — so both divide alike")
check(screened > 0, f'a glazed screen with a door in it exists to check ({screened})')

# A DOOR IN A WALL THE VIEWER BUILDS is declared TWICE, and has to be. The under-stair
# box is the stair builder's drywall, so the HOLE is cut there, from the staircase item's
# `underDoor`; but the CASING, the baseboard break and the field break around it are the
# trim program's, and it only knows about openings listed as `doors` on the wall's
# `extraWalls` record. Two numbers, two files, one opening. Nothing at runtime notices
# them drifting — the casing simply stops lining up with the hole — so it is checked here.
print('\nUNDER-STAIR DOOR: HOLE AND CASING AGREE')
checked_ud = 0
for stem, room in rooms_s.items():
    for it in (room.get('interior') or {}).get('furniture', []):
        ud = it.get('underDoor')
        if not ud:
            continue
        half = ud.get('widthFt', 2.5) / 2
        lo, hi = ud['posFt'] - half, ud['posFt'] + half
        spans = [d for ew in ((room.get('interior') or {}).get('paneling') or {}).get('extraWalls', [])
                 for d in ew.get('doors', [])]
        check(len(spans) == 1,
              f"{stem}: the box's trim program carries exactly one opening ({len(spans)})")
        for a, b in spans:
            checked_ud += 1
            check(abs(min(a, b) - lo) < 0.01 and abs(max(a, b) - hi) < 0.01,
                  f"{stem}: the casing spans the hole "
                  f"({round(min(a, b), 3)}..{round(max(a, b), 3)} against {round(lo, 3)}..{round(hi, 3)})")
        # and the head has to sit ON the trim program's head line, or the casing's own
        # head member floats above or cuts through the opening.
        check(abs(ud.get('headFt', 7.0) - model_s['headHeight']) < 0.01,
              f"{stem}: the head is the house's head line "
              f"({ud.get('headFt')} against {model_s['headHeight']})")
check(checked_ud > 0, f'an under-stair door exists to check ({checked_ud})')

# THE REAR DECK AND YARD. Everything here is measured from the BUILT geometry — the
# clearances especially, because they are the whole point of the deck's dimensions and
# reading them back out of model.json would assert nothing. The property lines come from
# the built `Lot` slab, which add_lot makes exactly widthFt wide.
print('\nREAR DECK & YARD')
D = extents(ext, lambda nm, p: nm.startswith(('Deck', 'Hot tub', 'Yard fence', 'Lot wall')))
east_line, west_line = E['Lot'][0], E['Lot'][1]
_cfg = json.load(open('ifc/model.json'))['lot']
dk = _cfg['deck']; tb = dk['hotTub']; fn = _cfg['yardFence']
BASE = 2.5                                          # crawlspaceFt: the deck top, above grade
riser = BASE / dk['stepCount']
toe = (dk['stepCount'] - 1) * dk['treadFt'] + (dk['treadFt'] if dk.get('gradePaver') else 0)

# --- the deck's four edges. Only the WEST one is a setback; south and east both die
# on a lot wall, and the north edge is the thing that keeps the yard private.
w_clear = west_line - D['Deck - scullery'][1]
check(near(w_clear, dk['westClearFt']),
      f"WEST yard: {dk['westClearFt']} ft, deck edge to the west line ({w_clear:.4f})")
e_wall_in = D['Lot wall - east'][1]
check(near(D['Deck terrace E'][0], e_wall_in),
      f"the terrace runs to the SE corner, dying on the east wall ({D['Deck terrace E'][0]:.4f} vs {e_wall_in:.4f})")
# The north edge is the EXISTING deck's: the family room's south wall. Asserted against
# the other deck section rather than a typed number, because "keep it consistent" is a
# relationship between the two, and a terrace that crept north is the thing that cost
# the yard its privacy in the first place.
check(near(D['Deck terrace E'][3], D['Deck'][3], 0.01),
      f"and stops on the existing deck's north edge ({D['Deck terrace E'][3]:.4f} vs {D['Deck'][3]:.4f})")
check(D['Deck terrace E'][3] < -11.0,
      f"...which is south of the house's south wall, not up its side ({D['Deck terrace E'][3]:.4f})")
# ...and the west stair toe, the one flight that still projects into a setback.
w_toe = max(b[1] for nm, b in D.items() if nm.startswith('Deck step W'))
check(near(west_line - w_toe, dk['westClearFt'] - toe),
      f'clear ground west of the west stair toe ({west_line - w_toe:.4f} ft)')

# --- the steps: stepCount RISERS is stepCount-1 treads plus a flush grade paver, now
# on the terrace's NORTH edge, which is the only side that is not a wall or the house.
tre = sorted((nm for nm in D if nm.startswith('Deck step N')), key=lambda n: D[n][2])
check(len(tre) == dk['stepCount'],
      f"north flight is {dk['stepCount']} risers = {dk['stepCount'] - 1} treads + a grade paver ({len(tre)})")
tops = [D[nm][5] for nm in tre]
want = [BASE - (k + 1) * riser for k in range(dk['stepCount'] - 1)] + [0.0]
check(all(near(a, b, 0.02) for a, b in zip(tops, want)),
      f"...rising {riser * 12:.1f} in a tread ({', '.join(f'{t:.3f}' for t in tops)})")
# and they span the terrace's WHOLE width, which is what "full width" means
check(all(near(D[nm][0], D['Deck terrace E'][0], 0.02) and near(D[nm][1], D['Deck terrace E'][1], 0.02)
          for nm in tre),
      'and run the full width of the terrace, east wall to house')
check(min(D[nm][2] for nm in tre) >= D['Deck terrace E'][3] - 0.01,
      'descending NORTH off that edge, into the yard')

# --- the hot tub -------------------------------------------------------------------
wall_in = D['Lot wall - south'][3]                  # the CMU wall's INNER face
tub_s, tub_n = D['Hot tub surround S'][3], D['Hot tub surround N'][2]
tub_w, tub_e = D['Hot tub surround W'][0], D['Hot tub surround E'][1]
check(near(tub_s - wall_in, tb['fromWallIn'] / 12),
      f"tub sits {tb['fromWallIn']} in off the south wall's inner face ({(tub_s - wall_in) * 12:.2f} in)")
# ...and off the EAST wall too: it is cornered now, which is the most private spot on
# the lot — the one place enclosed by two 7 ft walls.
check(near(tub_e - e_wall_in, tb['fromEastWallIn'] / 12),
      f"and {tb['fromEastWallIn']} in off the east wall's ({(tub_e - e_wall_in) * 12:.2f} in)")
check(near(tub_n - tub_s, tb['sizeFt']) and near(tub_w - tub_e, tb['sizeFt']),
      f"tub is {tb['sizeFt']} x {tb['sizeFt']} ft ({tub_w - tub_e:.3f} x {tub_n - tub_s:.3f})")
# THE ENTRY SILL IS FLUSH WITH THE DECK. The tub is built in — what sits below deck
# level is the water — but there is no intermediate platform to step down onto first,
# so the decking and the stone band round the tub are one level.
check(near(D['Hot tub surround S'][5], BASE - riser * tb['recessRisers'], 0.02),
      f"the surround is level with the deck ({D['Hot tub surround S'][5]:.4f} vs {BASE:.4f} ft)")

# THE MESH TUB AND THE HOLE IT FILLS ARE IN DIFFERENT FILES. The vessel is a procedural
# three.js mesh (the furniture rule) and the well is IFC, so nothing at runtime notices
# them drifting apart — the tub would simply float or sink.
_fur = json.load(open('ifc/exterior.furniture.json'))['items']
hot = [i for i in _fur if i.get('type') == 'hot_tub']
check(len(hot) == 1, f'exactly one hot_tub in the viewer manifest ({len(hot)})')
if hot:
    h = hot[0]
    check(near(h['px'], (tub_w + tub_e) / 2, 0.02) and near(h['pz'], (tub_s + tub_n) / 2, 0.02),
          f"the mesh tub is centred on the IFC well ({h['px']}, {h['pz']})")
    check(near(h.get('wFt', 0), tb['sizeFt']) and near(h.get('dFt', 0), tb['sizeFt']),
          'the mesh tub is the size of the hole it fills')
    # The sill is a number the MESH owns (it is the top of the coping the builder draws)
    # and the deck is a number the IFC owns. They have to be the same, and nothing at
    # runtime would notice them drifting — the tub would just stand proud or sink.
    check(near(h.get('rimFt', 0), BASE, 0.02),
          f"its entry sill is at deck level ({h.get('rimFt')} vs {BASE} ft)")
    check(near(h.get('rimFt', 0), h.get('deckFt', -1), 0.001),
          f"...which is the deck the well was cut in ({h.get('rimFt')} vs {h.get('deckFt')})")

# --- NO GUARD RAILINGS -------------------------------------------------------------
named = [p for p in ext.by_type('IfcRailing') if (getattr(p, 'Name', '') or '').startswith('Deck')]
check(not named, f'no railing named Deck* survives ({len(named)})')
# ...and nothing renamed its way back on. Any railing standing INSIDE the deck footprint
# has to be a yard-fence member; this catches a rail that came back under another name.
R = extents(ext, lambda nm, p: p.is_a('IfcRailing'))
foot = (D['Deck terrace E'][0], D['Deck - scullery'][1], wall_in, D['Deck terrace E'][3])
intruders = sorted(nm for nm, b in R.items()
                   if not nm.startswith('Yard fence')
                   and b[0] > foot[0] - 0.01 and b[1] < foot[1] + 0.01
                   and b[2] > foot[2] - 0.01 and b[3] < foot[3] + 0.01 and b[5] > 0.1)
check(not intruders, 'no railing of any name stands on the deck'
                     + ('' if not intruders else f" \u2014 found {', '.join(intruders)}"))
# The paired PRESENCE check: an absence passes just as well when the builder that makes
# railings has quietly stopped running.
check(any(nm.startswith('Fence') for nm in R), f'...and the picket fence is still built ({len(R)} railings in all)')

# --- the yard fence ----------------------------------------------------------------
boards = {nm: b for nm, b in D.items() if nm.startswith('Yard fence board')}
check(len(boards) > 20, f'the yard fence is built board by board ({len(boards)} boards)')
if boards:
    run_lo = min(b[0] for b in boards.values()); run_hi = max(b[1] for b in boards.values())
    fence_line = (min(b[2] for b in boards.values()) + max(b[3] for b in boards.values())) / 2
    check(near(run_lo, east_line, 0.4), f'the fence reaches the east property line ({run_lo:.3f})')
    check(near(run_hi, -22.9167, 0.4), f"and starts at the extension's NE corner ({run_hi:.3f})")
    # Classified by the height each board STANDS ON, not by where it is in plan. The
    # first version split on the deck's east edge, which only worked while the fence
    # happened to cross it; once the terrace moved that test put 61 grade boards "on
    # the deck" and still passed its own height check for the wrong reason.
    bases = sorted({round(b[4], 3) for b in boards.values()})
    check(all(near(v, 0.0, 0.02) or near(v, BASE, 0.02) for v in bases),
          f"every board stands on grade or on the deck, nothing in between ({', '.join(f'{v:.2f}' for v in bases)} ft)")
    surface = fn.get('heightDatum', 'surface') == 'surface'
    if surface:
        bad = [nm for nm, b in boards.items() if not near(b[5] - b[4], fn['heightFt'], 0.02)]
        check(not bad, f"and is {fn['heightFt']} ft above it" + ('' if not bad else f' — {len(bad)} off'))
    else:
        bad = [nm for nm, b in boards.items() if not near(b[5], fn['heightFt'], 0.02)]
        check(not bad, f"and tops out at {fn['heightFt']} ft above grade" + ('' if not bad else f' — {len(bad)} off'))
    # The fence line and the deck's north edge were the same number until the terrace
    # was pulled back south for privacy. They are independent now, so the fence should
    # stand entirely on grade — and this is what would catch it silently climbing a
    # deck that grew back out under it.
    on_deck = [nm for nm, b in boards.items() if b[4] > 0.1]
    check(not on_deck,
          f'the fence stands clear of the deck ({len(on_deck)} boards on it; '
          f"deck north {D['Deck terrace E'][3]:.3f}, fence line {fence_line:.3f})")

# THE DRIVEWAY. Measured off the built slabs, and against the two things that actually
# constrain it: the level stretch of frontage it has to cross, and a car.
print('\nDRIVEWAY')
dv = _cfg.get('driveway') or {}
DV = extents(ext, lambda nm, p: nm.startswith(('Driveway', 'Park strip - north', 'Retaining wall - north')))
if dv and 'Driveway' in DV:
    pad = DV['Driveway']
    width = pad[1] - pad[0]
    check(near(width, dv['widthFt'], 0.02), f"the drive is {dv['widthFt']} ft wide ({width:.3f})")
    # The width assertion that means something: two cars SIDE BY SIDE. 20 on its own is
    # a number with no argument behind it.
    check(width >= 2 * dv['stallWidthFt'],
          f"which holds two {dv['stallWidthFt']} ft stalls side by side "
          f"({width / dv['stallWidthFt']:.2f} stalls)")
    # It has to be long enough to park on, not just a crossing.
    depth = pad[3] - pad[2]
    check(depth > 18, f'and is {depth:.2f} ft deep, so a car fits clear of the footway')
    # WHERE it sits is the whole point: hard against the east end of the retaining wall,
    # on the stretch where the public walk has climbed back to lot grade. West of that a
    # drive needs a step down AND a gap cut in the wall.
    wall_e = min(b[0] for nm, b in DV.items() if nm.startswith('Retaining wall - north'))
    check(near(pad[1], wall_e, 0.05),
          f"its west edge meets the retaining wall's east end ({pad[1]:.3f} vs {wall_e:.3f})")
    check(near(pad[5], 0.0, 0.02) and near(DV['Driveway apron'][5], 0.0, 0.02),
          f'drive and apron are both at lot grade, no step at the line ({pad[5]:.3f}, {DV["Driveway apron"][5]:.3f})')
    # The apron crosses the planting strip; the grass must actually stop for it rather
    # than the two sitting coplanar and z-fighting.
    grass = DV.get('Park strip - north level')
    check(grass is None or grass[1] <= pad[0] + 0.02,
          f"the planting strip stops at the apron, it does not run under it "
          f"({'none' if grass is None else f'{grass[1]:.3f} vs {pad[0]:.3f}'})")
    # ...and the drive runs from the yard fence, so cars park against it.
    check(near(pad[2], min(b[2] for nm, b in D.items() if nm.startswith('Yard fence')), 0.4),
          f'it starts at the yard fence ({pad[2]:.3f})')
else:
    check(False, 'a driveway is authored and built')


# ---------------------------------------------------------------------------------
# THE SIDE PORCH at the east wing's outside door. Everything here is measured off the
# built slabs and asserted against something that CONSTRAINS it — the wing it spans,
# the door it shelters, the riser every other flight on the lot uses — rather than
# against the number that went into it, which would assert nothing.
print('\nSIDE PORCH')
sp = _cfg.get('sidePorch') or {}
SP = extents(ext, lambda nm, p: nm.startswith('Side porch'))


def _parts(model, prefix):
    """Per-PRODUCT boxes. `extents` unions by name, which is what is wanted almost
    everywhere and is exactly wrong for the deck: its pieces share a name, so the union
    is the un-notched rect and the notch assertion below would pass on any build."""
    out = []
    for p in model.by_type('IfcProduct'):
        nm = getattr(p, 'Name', None) or ''
        if not nm.startswith(prefix):
            continue
        try:
            sh = ifcopenshell.geom.create_shape(S, p)
        except Exception:
            continue
        v = np.array(sh.geometry.verts).reshape(-1, 3)
        px, pz, y = -v[:, 0] / FT, v[:, 1] / FT, v[:, 2] / FT
        out.append((nm, (px.min(), px.max(), pz.min(), pz.max(), y.min(), y.max())))
    return out


def _rake_line(model, name, lo=True):
    """The bottom (lo) or top edge of a raking member, as a function of plan x.

    A prism carries vertices only at its two ends, so two points define the line — which
    is the only way to ask "how high is this band ABOVE THAT POINT". A bounding box
    cannot answer it: a raking member's box is the same whichever way it slopes, and
    every question here is about where one raking line meets another."""
    for p in model.by_type('IfcProduct'):
        if (getattr(p, 'Name', None) or '') != name:
            continue
        # HOLD THE SHAPE. `create_shape(...).geometry.verts` reads a buffer owned by a
        # temporary that is collected before numpy copies it, and the result is not an
        # error — it is plausible numbers with a vertex or two replaced by the origin,
        # which read here as a roof that rakes half as far as it does. extents() binds
        # the shape to a name for this reason; so must this.
        sh = ifcopenshell.geom.create_shape(S, p)
        v = np.array(sh.geometry.verts).reshape(-1, 3)
        px, y = -v[:, 0] / FT, v[:, 2] / FT
        a, b = px.min(), px.max()
        ya = y[px < a + 1e-4].min() if lo else y[px < a + 1e-4].max()
        yb = y[px > b - 1e-4].min() if lo else y[px > b - 1e-4].max()
        return lambda x, a=a, b=b, ya=ya, yb=yb: ya + (yb - ya) * (x - a) / (b - a)
    return None


EXT_W = ('ext_bath', 'wc', 'ext_vestibule', 'ext_laundry')
_wing = [json.load(open(f'ifc/rooms/{k}.json'))['bounds'] for k in EXT_W]
wing_e = min(min(b['x1'], b['x2']) for b in _wing)
wing_w = max(max(b['x1'], b['x2']) for b in _wing)
wing_n = max(max(b['z1'], b['z2']) for b in _wing)
wing_s = min(min(b['z1'], b['z2']) for b in _wing)
_door = [d for k in EXT_W for d in json.load(open(f'ifc/rooms/{k}.json')).get('doors', [])
         if d.get('orient') == 'H' and abs(d.get('fixed', 0.0) - wing_n) < 1e-6]

if sp and 'Side porch deck' in SP and len(_door) == 1:
    deck, cnpy = SP['Side porch deck'], SP['Side porch awning']
    door = _door[0]
    d_e, d_w = door['pos'] - door['width'] / 2, door['pos'] + door['width'] / 2

    # --- it spans the wing, which is what "~11 ft" meant. Both edges asserted: the
    # width alone would pass for a porch 11 ft long in the wrong place.
    check(near(deck[0], wing_e, 0.02),
          f"the deck's east edge is the wing's east wall ({deck[0]:.4f} vs {wing_e:.4f})")
    check(deck[1] >= wing_w - 1e-6,
          f"and its west edge reaches the primary's east wall ({deck[1]:.4f} vs {wing_w:.4f})")
    check(near(deck[1] - deck[0], wing_w - wing_e, 0.1),
          f'so it spans the wing, {wing_w - wing_e:.3f} ft ({deck[1] - deck[0]:.3f})')
    # It must TUCK UNDER the wall, not stop on the face of it: the massing blocks are
    # built at the room bounds and two boxes sharing a face plane z-fight.
    check(deck[2] < wing_n - 1e-6,
          f"its south edge runs under the wing's wall, not onto it ({deck[2]:.4f} < {wing_n})")
    check(near(deck[3] - wing_n, sp['depthFt'], 0.02),
          f"and it projects {sp['depthFt']} ft ({deck[3] - wing_n:.4f})")
    check(near(deck[5], BASE, 0.01), f'level with the finished floor ({deck[5]:.4f} ft)')

    # --- the flight. Same reckoning as the deck's: stepCount RISERS is stepCount - 1
    # treads plus a paver flush with grade.
    steps = sorted([(nm, b) for nm, b in _parts(ext, 'Side porch step')], key=lambda t: t[1][2])
    check(len(steps) == dk['stepCount'],
          f"{dk['stepCount']} risers -> {dk['stepCount']} slabs, treads plus the grade paver ({len(steps)})")
    tops = [b[5] for _, b in steps]
    check(all(near(tops[i] - tops[i + 1], riser, 0.01) for i in range(len(tops) - 2)) and near(tops[-1], 0.0, 0.01),
          f'even {riser * 12:.1f} in risers down to grade ({", ".join(f"{t:.3f}" for t in tops)})')
    # The riser is the DECK's, not one of its own: one lot, one stair rhythm.
    check(riser * 12 <= 7.75, f'which is inside the 7.75 in maximum ({riser * 12:.2f} in)')
    # The flight has to be at the DOOR, not merely on the porch somewhere.
    fl = steps[0][1]
    check(fl[0] <= door['pos'] <= fl[1],
          f"the flight is under the door ({fl[0]:.3f}..{fl[1]:.3f} holds {door['pos']})")
    check(fl[2] >= deck[3] - 0.02, f'and descends off the north edge ({fl[2]:.3f} vs {deck[3]:.3f})')
    # Its toe has to stay on the lot, and clear of the drive it lands beside.
    toe_n = max(b[3] for _, b in steps)
    check(toe_n < E['Lot'][3] - 10, f'the toe stays well inside the north line ({toe_n:.2f})')
    drv = DV.get('Driveway')
    check(drv is None or fl[1] < drv[0] or fl[0] > drv[1],
          f"and does not land in the driveway ({fl[0]:.2f}..{fl[1]:.2f} vs "
          f"{'none' if drv is None else f'{drv[0]:.2f}..{drv[1]:.2f}'})")

    # --- the awning. The point of it is the DOOR, so that is what it is measured
    # against; and it is FREE-STANDING, which is the assertion that matters most here
    # because the first build carried it on two posts landing on the deck.
    aw = sp['awning']
    check(cnpy[0] <= d_e + 1e-6 and cnpy[1] >= d_w - 1e-6,
          f"the awning covers the door's full {door['width']} ft ({cnpy[0]:.3f}..{cnpy[1]:.3f} "
          f"over {d_e:.3f}..{d_w:.3f})")
    check(near(cnpy[3] - wing_n, aw['projectFt'], 0.02),
          f"projecting {aw['projectFt']} ft off the wall ({cnpy[3] - wing_n:.3f})")
    check(cnpy[3] - wing_n >= 3.0,
          f'which is enough to stand at the door under ({cnpy[3] - wing_n:.2f} ft)')
    # FREE-STANDING: nothing in the assembly comes down to the deck. Measured as the
    # LOWEST point of the awning and its brackets together, which is the one number a
    # post or a leg would break no matter how it was named.
    assembly = _parts(ext, 'Side porch awning') + _parts(ext, 'Side porch bracket')
    low = min(b[4] for _, b in assembly)
    check(low - deck[5] > 3.0,
          f'and it stands free — nothing lands on the porch, lowest part {low - deck[5]:.2f} ft '
          f'above the deck ({len(assembly)} members)')
    # What actually has to clear your head is the UNDERSIDE OF THE OUTER EDGE, not the
    # height it is mounted at: the awning falls away from the wall, so the mounting
    # height is the generous end of it.
    check(cnpy[4] - deck[5] >= 7.0,
          f'you walk under its outer edge ({cnpy[4] - deck[5]:.2f} ft clear)')
    check(near(cnpy[5] - cnpy[4], aw['dropFt'] + aw['thickFt'], 0.02),
          f"it sheds away from the wall, {aw['dropFt']} ft over the projection "
          f"({cnpy[4]:.3f}..{cnpy[5]:.3f})")
    # A bracket has to reach BOTH ways — bear on the wall and meet the awning — or it
    # is a decoration hanging in the air.
    brk = _parts(ext, 'Side porch bracket')
    check(len(brk) == 2, f'a bracket at each end carries it ({len(brk)})')
    check(all(near(b[2], wing_n, 0.02) and b[5] >= cnpy[4] - 0.02 for _, b in brk),
          'each one bears on the wall and reaches the awning')
    check(all(b[0] >= cnpy[0] - 1e-6 and b[1] <= cnpy[1] + 1e-6 for _, b in brk),
          'and sits within its width, not buried in the house wall')

    # --- the guard and the handrail. The deck is 30 in over the yard, so its open
    # edges need one; the shut edges must NOT have one, and neither must the stair
    # opening, which is what an extent test on the guard alone would miss.
    gd = sp['guard']
    GR = extents(ext, lambda nm, p: nm.startswith(('Side porch guard', 'Side porch handrail',
                                                   'Side porch stair')))
    top_e, top_n = GR['Side porch guard top rail E'], GR['Side porch guard top rail N']
    check(near(top_e[5] - deck[5], gd['heightFt'], 0.01),
          f"the guard stands {gd['heightFt']} ft over the deck ({top_e[5] - deck[5]:.3f})")
    # The east run dies INTO the yard fence's terminal post rather than standing its own
    # 3 in away — the post is already 3.5 ft above this deck.
    _fp = [b for _, b in _parts(ext, 'Yard fence post')
           if b[0] <= wing_e + 0.3 and b[1] >= wing_e - 0.3]
    check(len(_fp) == 1 and near(top_e[2], _fp[0][3], 0.02),
          f"its east run dies into the fence post ({top_e[2]:.3f} vs "
          f"{'none' if not _fp else f'{_fp[0][3]:.3f}'})")
    # The east run ends on the north run's CENTRELINE, not on the edge of its box — a
    # rail is rw wide, so comparing end against edge is off by half a rail every time.
    check(top_n[2] - 1e-6 <= top_e[3] <= top_n[3] + 1e-6,
          f'and turns the corner into the north run ({top_e[3]:.3f} inside '
          f'{top_n[2]:.3f}..{top_n[3]:.3f})')
    # It must STOP at the head of the stair. Running on, it would fence off the way down.
    check(top_n[1] <= fl[0] + gd['postFt'] + 1e-6,
          f"the north run stops at the head of the stair ({top_n[1]:.3f} vs the flight's "
          f"east edge {fl[0]:.3f})")
    # ...and the two SHUT edges have none. Asserted as "every member sits on one of the
    # two open edges" rather than "none near the house": the east run reaches within
    # 6 in of the south wall where it dies into the fence post, so a proximity test
    # fails on the very member that is right.
    allg = _parts(ext, 'Side porch guard') + _parts(ext, 'Side porch baluster')
    e_line, n_line = wing_e + gd['postFt'] / 2, deck[3] - gd['postFt'] / 2
    stray = [nm for nm, b in allg
             if abs((b[0] + b[1]) / 2 - e_line) > 0.2 and abs((b[2] + b[3]) / 2 - n_line) > 0.2]
    check(not stray,
          f'every member sits on one of the two OPEN edges, none on a house wall '
          f'({len(allg)} members, {len(stray)} stray)')
    check(max(b[1] for _, b in allg) <= fl[0] + gd['postFt'] + 1e-6,
          'and none west of the stair head, where the deck runs on to the house')

    # THE 4 IN SPHERE RULE, between CONSECUTIVE balusters on every run — the raking one
    # included, where vertical balusters under a sloped rail are still governed by the
    # HORIZONTAL clear, so it is measured the same way as on the level runs.
    for tag, ax in (('Side porch baluster E', 2), ('Side porch baluster N', 0),
                    ('Side porch stair baluster', 2)):
        bs = sorted([b for _, b in _parts(ext, tag)], key=lambda b: b[ax])
        gaps = [bs[i + 1][ax] - bs[i][ax + 1] for i in range(len(bs) - 1)]
        check(len(bs) >= 4 and gaps and max(gaps) <= 4 / 12 + 1e-6,
              f'{tag.split()[-1]}: {len(bs)} balusters, widest opening '
              f'{max(gaps) * 12:.2f} in (4 in max)')

    # THE HANDRAIL. Its height is the guard's, carried down the rake, so the two make one
    # line: assert they MEET at the newel rather than asserting each against its own
    # number, which is how a step at the newel survives two passing checks.
    hr = GR['Side porch handrail']
    check(near(hr[5], top_n[5], 0.01),
          f"it leaves the guard's top rail at the same height ({hr[5]:.3f} vs {top_n[5]:.3f})")
    # It must fall at the FLIGHT's slope — a handrail that is not parallel to the
    # nosings is the one thing you feel underhand.
    # The rail's own THICKNESS is inside its bounding box, so the box's vertical extent
    # is the rise plus one rail. Subtract it, or a 9 in rail on a 3 ft run reads as a
    # slope 6% steeper than the stair it is supposed to be parallel to.
    slope = (hr[5] - hr[4] - gd['railThickFt']) / (hr[3] - hr[2])
    check(near(slope, riser / dk['treadFt'], 0.005),
          f'falling at the flight\'s own slope ({slope:.4f} vs {riser / dk["treadFt"]:.4f})')
    # Graspable height above the NOSING LINE, both ends, against the 34-38 in allowed.
    nose_hi, nose_lo = deck[5], deck[5] - riser * (hr[3] - hr[2]) / dk['treadFt']
    check(34 / 12 <= hr[5] - nose_hi <= 38 / 12 and 34 / 12 <= hr[4] - nose_lo <= 38 / 12,
          f'{(hr[5] - nose_hi) * 12:.1f} in over the nosing line at both ends (34-38 in)')
    nw = GR['Side porch stair newel']
    check(near(nw[4], 0.0, 0.02) and nw[2] >= steps[-1][1][2] - 1e-6,
          f'and its bottom newel stands on the grade paver ({nw[4]:.3f} ft)')

    # --- the yard fence's terminal post shares this corner BY CONSTRUCTION, so the
    # deck is punched around it. Paired with a positive control: without it, "no deck
    # piece overlaps the post" passes just as well when the fence stops being built.
    fposts = [b for nm, b in _parts(ext, 'Yard fence post')]
    corner = [b for b in fposts if b[0] <= wing_e + 0.3 and b[1] >= wing_e - 0.3]
    check(len(corner) == 1, f'the yard fence still ends on this corner ({len(corner)} post there)')
    if corner:
        c = corner[0]
        bad = [nm for nm, b in _parts(ext, 'Side porch deck')
               if b[0] < c[1] - 1e-6 and b[1] > c[0] + 1e-6 and b[2] < c[3] - 1e-6 and b[3] > c[2] + 1e-6]
        check(not bad, f'and the deck is notched around it, not through it ({len(bad)} overlaps)')
else:
    check(False, 'a side porch is authored, built, and serves exactly one exterior door')


# ---------------------------------------------------------------------------------
# THE WING'S ELEVATIONS. The one wall on the house that takes no windows became three:
# the T1-11 band, the waist course and the entablature now WRAP the wing. Read as two
# storeys the way the house itself is built — a clad band under the eaves, a waist at the
# floor line, plain stucco below carrying only the door, its awning and a round window.
#
# The three faces are NOT alike and the checks have to know it: north and south are rake
# walls with the roof FLUSH, so they carry a frieze and their heads rake; east is the
# shed's low eave with a real 1.5 ft overhang, so it carries no frieze and its head is the
# wall top. Everything is measured against derived lines — the built massing, the bays the
# rooms make, the second-floor line — never against the numbers in model.json.
print('\nWING ELEVATIONS')
we = _cfg.get('wingElevation') or {}
WE = extents(ext, lambda nm, p: nm.startswith('Wing'))
_fronting = [b for b in (json.load(open(f'ifc/rooms/{k}.json'))['bounds'] for k in EXT_W)
             if abs(max(b['z1'], b['z2']) - wing_n) < 1e-6]
_edges = sorted({v for b in _fronting for v in (b['x1'], b['x2'])})
party = _edges[1] if len(_edges) >= 3 else None
floor2 = BASE + model['storyHeight']            # the second-floor line, 12.5 ft

if we and party is not None and 'Wing frieze N' in WE:
    # --- THE ENTABLATURE on the two RAKE walls -------------------------------------
    roofline = _rake_line(ext, 'Massing - extension', lo=False)
    check(roofline is not None, 'the wing massing is measurable')
    for tag in ('N', 'S'):
        crown = _rake_line(ext, f'Wing cornice {tag}', lo=False)
        check(crown is not None, f'a raking entablature on the {tag} face')
        if crown and roofline:
            for end, x in (('east', wing_e), ('west', wing_w)):
                check(near(crown(x), roofline(x), 0.02),
                      f'{tag}: the cornice meets the wall top at the {end} end '
                      f'({crown(x):.3f} vs {roofline(x):.3f})')
            rise = roofline(wing_w) - roofline(wing_e)
            check(rise > 0.5 and near(crown(wing_w) - crown(wing_e), rise, 0.02),
                  f'{tag}: RAKING with the roof, not level across it ({rise:.3f} ft)')
    # The south run stops where the extension meets the primary — the same plane
    # continues, so nothing physical stops it and only this keeps it the wing's own.
    check(near(WE['Wing cornice S'][1], wing_w, 0.02) and near(WE['Wing frieze S'][1], wing_w, 0.02),
          f"the south entablature terminates at the primary junction "
          f"({WE['Wing cornice S'][1]:.3f} vs {wing_w:.3f})")
    # NO CORBELS, and no eave dentil course on the primary either: this house is plain
    # stucco with simple trim. Both absences PAIRED with the cornices still being built —
    # on its own, "no corbels" passes just as well for trim that stopped being made.
    check(not _parts(ext, 'Wing corbel') and not _parts(ext, 'Dentils'),
          'no corbels and no eave dentil course — ornament this building does not carry')

    # RETURNS AT BOTH EAST CORNERS, and NO CORNICE BETWEEN THEM. The east face is the low
    # eave and the roof already overhangs it 1.5 ft; a frieze there would drive through the
    # upper bath window's header. The returns say "the trim turns the corner and leaves",
    # which is what that face actually wants — but only if there is genuinely nothing in
    # between, so that absence is asserted too.
    rets = {t: WE.get(f'Wing cornice return {t}') for t in ('NE', 'SE')}
    check(all(rets.values()), f'the cornice returns round BOTH east corners '
                              f'({sum(1 for v in rets.values() if v)}/2)')
    if all(rets.values()):
        check(near(rets['NE'][5], rets['SE'][5], 0.01),
              f"both returns at the same height — the rake runs in px, so both rakes "
              f"start at the east wall top ({rets['NE'][5]:.3f})")
        for t, zf, sgn in (('NE', wing_n, +1), ('SE', wing_s, -1)):
            reach = abs(rets[t][2 if sgn > 0 else 3] - zf)
            check(near(reach, we['entablature']['returnFt'], 0.02),
                  f'{t} turns {we["entablature"]["returnFt"]} ft and stops ({reach:.2f})')
        mid = [nm for nm, b in _parts(ext, 'Wing cornice') + _parts(ext, 'Wing frieze')
               if not nm.endswith(('N', 'S')) and wing_s + 1.2 < (b[2] + b[3]) / 2 < wing_n - 1.2]
        check(not mid, f'and nothing between them along the east face ({len(mid)})')

    # --- THE WAIST COURSE, wrapping three faces ------------------------------------
    cl = we.get('cladding') or {}
    wN, wE, wS = (WE.get('Wing waist course N'), WE.get('Wing waist course E'),
                  WE.get('Wing waist course S'))
    check(cl and wN and wE and wS, 'a waist course divides the storeys, on three faces')
    if cl and wN and wE and wS:
        check(all(near(b[5], floor2, 0.01) for b in (wN, wE, wS)),
              f'the waist on the second-floor line, all three runs ({wN[5]:.3f})')
        check(wN[1] >= wing_w - 0.02 and wN[0] <= wing_e + 0.02,
              f'north run crossing the whole face ({wN[0]:.3f}..{wN[1]:.3f})')
        check(near(wE[2], wing_s, 0.1) and wE[3] >= wing_n - 0.02,
              f'east run down the whole east face ({wE[2]:.3f}..{wE[3]:.3f})')
        check(near(wS[3], wing_s, 0.1) and near(wS[1], wing_w, 0.02),
              f'south run continuing to the primary junction ({wS[0]:.3f}..{wS[1]:.3f})')

        # --- THE T1-11 BAND, wrapping the same three faces -------------------------
        faces = {t: _parts(ext, f'Wing cladding board {t}') for t in ('N', 'E', 'S')}
        # The backer is SPLIT on the east face (around the window), so union its pieces
        # rather than looking up a single name the way the north's would allow.
        def _union(parts):
            if not parts:
                return None
            bs = [b for _, b in parts]
            return (min(b[0] for b in bs), max(b[1] for b in bs), min(b[2] for b in bs),
                    max(b[3] for b in bs), min(b[4] for b in bs), max(b[5] for b in bs))
        backs = {t: _union(_parts(ext, f'Wing cladding backer {t}')) for t in ('N', 'E', 'S')}
        check(all(faces.values()) and all(backs.values()),
              f'a T1-11 band on all three faces '
              f'({", ".join(f"{t}:{len(v)}" for t, v in faces.items())} strips)')
        if all(faces.values()) and all(backs.values()):
            # ONE LEVEL BASE, ALL THE WAY ROUND. The single assertion that says "wrap"
            # rather than "three bands that happen to meet" — compared face to face, not
            # to the config that drew them.
            bases = {t: min(b[4] for _, b in v) for t, v in faces.items()}
            check(max(bases.values()) - min(bases.values()) < 0.01,
                  f'ONE level base all the way round '
                  f'({", ".join(f"{t} {v:.3f}" for t, v in sorted(bases.items()))})')
            lo = bases['N']
            check(all(near(b[4], lo, 0.01) for v in faces.values() for _, b in v
                      if b[4] < lo + 1.0),
                  'every full-height strip standing on it')
            # ...and the HEADS differ, deliberately. North and south die into their
            # friezes; east runs on to the wall top, 1.13 ft higher, because it has no
            # frieze. Pin the step so it cannot be mistaken for a defect later.
            for tag in ('N', 'S'):
                sof = _rake_line(ext, f'Wing frieze {tag}', lo=True)
                head = _rake_line(ext, f'Wing cladding backer {tag}0', lo=False)
                check(sof and head and near(head(wing_w), sof(wing_w), 0.02),
                      f'{tag}: head dying into the frieze ({head(wing_w):.3f} vs '
                      f'{sof(wing_w):.3f})')
            east_top = max(b[5] for _, b in faces['E'])
            check(near(east_top, roofline(wing_e), 0.02),
                  f'E: head at the WALL TOP instead, having no frieze to die into '
                  f'({east_top:.3f} vs {roofline(wing_e):.3f})')
            check(east_top - max(b[5] for _, b in faces['N'] if b[0] < wing_e + 1.0) > 0.5,
                  f'so the band steps up at the east corner, deliberately '
                  f'({east_top:.2f} ft)')

            _sof_S = _rake_line(ext, 'Wing frieze S', lo=True)
            _band_specs = {'N': (), 'E': ('east 1', 'east 2'),
                           'S': ('south 1', 'south 2')}

            # --- THE SPLIT ROUND THE UPPER WINDOWS --------------------------------
            # Five of them now — three on the east, two on the south — so the siding
            # splits five times. Measured against the BUILT windows and their trim, not
            # the specs that generated both, or the test and the geometry share a bug.
            for tag, ax, names in (('E', 2, ('east 1', 'east 2')),
                                   ('S', 0, ('south 1', 'south 2'))):
                sid = [b for _, b in faces[tag]] + \
                      [b for _, b in _parts(ext, f'Wing cladding skirt {tag}')]
                for w in names:
                    wb = [b for nm, b in _parts(ext, '') if nm.endswith(f'Ext {w}')]
                    check(wb, f'{tag}: upper "{w}" is built ({len(wb)} parts)')
                    if not wb:
                        continue
                    a0, a1 = min(b[ax] for b in wb), max(b[ax + 1] for b in wb)
                    y0, y1 = min(b[4] for b in wb), max(b[5] for b in wb)
                    hits = [b for b in sid
                            if b[ax + 1] > a0 and b[ax] < a1 and b[5] > y0 and b[4] < y1]
                    over = [b for b in sid
                            if b[ax + 1] > a0 and b[ax] < a1 and b[4] >= y1 - 1e-6]
                    check(not hits and over,
                          f'{tag}: the siding splits clear of "{w}" and closes above it '
                          f'({len(hits)} in the opening, {len(over)} over it)')
                    # AND IT SITS WHOLLY INSIDE THE BAND. This is the change that removed
                    # the straddle: a standard upper spans 15.0-18.5 and crosses the
                    # band's base at 16.37 however the band is sized, leaving its sill
                    # hanging on bare stucco. Trim included, and at the TIGHTEST bay
                    # rather than on average — the margin is 0.15 ft, so it needs a test.
                    # The band's head, per face: the east runs to the wall top (no
                    # frieze), the south dies into its own raking frieze soffit.
                    top = east_top if tag == 'E' else _sof_S((a0 + a1) / 2)
                    check(y0 > lo + 1e-9 and y1 < top + 1e-9,
                          f'{tag}: "{w}" wholly inside the band '
                          f'(+{y0 - lo:.3f} below, +{top - y1:.3f} above)')
                    # AND CLOSES UNDER IT where the sill rides above the base. The south
                    # transoms sit a foot up inside the band, and the split used to run
                    # the siding either side and over a window only — which left 0.65 ft
                    # of bare stucco in the siding beneath each one and a hole in the
                    # skirt. Both are asserted: strips standing on the base and reaching
                    # up to the sill board (with the shadow gap `openingSillFt` leaves),
                    # and a skirt with no gap across the window's span. Confirmed to fail
                    # on the build before the under-pieces existed.
                    if y0 > lo + 0.3:
                        under = [b for b in sid if b[ax + 1] > a0 and b[ax] < a1
                                 and near(b[4], lo, 0.01) and b[5] <= y0 + 1e-6]
                        reach = max((b[5] for b in under), default=lo)
                        check(under and y0 - reach < cl.get('openingSillFt', 0.35) * 0.3,
                              f'{tag}: ...and closes UNDER it, {len(under)} strips to '
                              f'{(y0 - reach) * 12:.2f} in of the sill board')
                        sk = sorted([b for _, b in _parts(ext, f'Wing cladding skirt {tag}')
                                     if b[ax + 1] > a0 - 0.5 and b[ax] < a1 + 0.5],
                                    key=lambda b: b[ax])
                        sgaps = [sk[i + 1][ax] - sk[i][ax + 1] for i in range(len(sk) - 1)]
                        check(sk and max(sgaps, default=0.0) < 0.01,
                              f'{tag}: the skirt runs on beneath it '
                              f'({len(sk)} pieces, widest gap {max(sgaps, default=0.0) * 12:.2f} in)')

            # GROOVES, per face, as the GAPS BETWEEN consecutive full-height strips —
            # what a groove is here, and the one thing separating this from the
            # board-and-batten it replaced. Only full-height strips: the pieces over the
            # window share an along-range with them and would read as overlaps.
            # Full-height means base ON the band's base AND head well above it: the pieces
            # under a raised sill stand on the base too, at 0.65 ft tall, and they share
            # an along-range with the strips either side just as the over-pieces do.
            for tag, ax in (('N', 0), ('E', 2), ('S', 0)):
                full = sorted([b for _, b in faces[tag]
                               if near(b[4], lo, 0.01) and b[5] - b[4] > 2.0],
                              key=lambda b: b[ax])
                gaps = [full[i + 1][ax] - full[i][ax + 1] for i in range(len(full) - 1)]
                fine = [g for g in gaps if g < 0.2]
                check(fine and all(near(g, cl['grooveFt'], 0.005) for g in fine),
                      f"{tag}: {len(fine)} grooves at {cl['grooveFt'] * 12:.2f} in "
                      f'({min(fine) * 12:.2f}-{max(fine) * 12:.2f} in)')
                # A wide gap is a WINDOW, not a groove. There should be exactly one per
                # upper window on that face — the north has none, the east three, the
                # south two — which is what ties the siding's splits back to the openings
                # that caused them rather than just counting holes.
                wide = [g for g in gaps if g >= 0.2]
                want = len(_band_specs.get(tag, ()))
                check(len(wide) == want,
                      f'{tag}: {len(wide)} wide gap(s), one per upper window ({want})')
            # The face must stand PROUD of its backer on every wall — that is what lets the
            # dark backer show through the grooves. Measured as distance from the wall
            # plane, so it holds whichever way the face looks out.
            def _proud(tag, ax, wall):
                b = faces[tag][0][1]
                return (abs((b[ax] + b[ax + 1]) / 2 - wall)
                        > abs((backs[tag][ax] + backs[tag][ax + 1]) / 2 - wall))
            check(_proud('N', 2, wing_n) and _proud('S', 2, wing_s) and _proud('E', 0, wing_e),
                  'the face standing proud of its backer on every wall, so the grooves show it')

        # --- IT IS A BAND, NOT A CLAD STOREY, with stucco between it and the waist.
        back = backs['N']
        check(back[4] - floor2 > 1.5,
              f'plain stucco between the band and the waist, so the waist reads as a '
              f'storey line and not the siding\'s base ({back[4] - floor2:.2f} ft)')
        check(back[5] - back[4] < 0.6 * model['storyHeight'],
              f'and the band is well under a storey tall ({back[5] - back[4]:.2f} ft '
              f'against {model["storyHeight"]})')

        # --- THE ROUND WINDOW in the lower east bay of the north face --------------
        ring, glass = WE.get('Wing round window ring'), WE.get('Wing round window glass')
        check(ring and glass, 'a round window in the lower east bay')
        if ring and glass:
            check(any((getattr(p, 'Name', None) or '') == 'Wing round window glass'
                      for p in ext.by_type('IfcWindow')),
                  'GLAZED — an IfcWindow, not the blind ornament that was removed here')
            check(near(ring[1] - ring[0], 2 * we['roundWindow']['radiusFt'], 0.02)
                  and near(ring[5] - ring[4], ring[1] - ring[0], 0.02),
                  f"{2 * we['roundWindow']['radiusFt']} ft across and ROUND "
                  f'({ring[1] - ring[0]:.3f} by {ring[5] - ring[4]:.3f})')
            check(near((ring[0] + ring[1]) / 2, (wing_e + party) / 2, 0.01),
                  f'centred on the east bay ({(ring[0] + ring[1]) / 2:.4f})')
            check(near((ring[4] + ring[5]) / 2, BASE + model['doorHeight'], 0.02),
                  f"on the door's head line, so the wall's two openings share a horizontal "
                  f"({(ring[4] + ring[5]) / 2:.2f})")

# ---------------------------------------------------------------------------------
# THE WING'S FENESTRATION. Its east and south walls used to carry two windows that sat
# 1.7 ft out of line with each other, because each was placed from INSIDE its own room
# and nothing made them stack outside. Only the north front was ever locked to its ground
# openings. These assertions are that rule, applied to the two faces that lacked it.
print('\nWING FENESTRATION')
_W = {}
for p in ext.by_type('IfcWindow'):
    nm = getattr(p, 'Name', None) or ''
    try:
        sh = ifcopenshell.geom.create_shape(S, p)
    except Exception:
        continue
    v = np.array(sh.geometry.verts).reshape(-1, 3)
    _W[nm] = (-v[:, 0] / FT, v[:, 1] / FT, v[:, 2] / FT)


def _ctr(nm, ax):
    a = _W[nm][ax]
    return (a.min() + a.max()) / 2


for face, ax, along, pairs in (
        ('east', 0, 1, [('Window - WC E', 'Upper - Ext east 1'),
                        ('Window - Bath E', 'Upper - Ext east 2')]),
        ('south', 1, 0, [('Window - WC S', 'Upper - Ext south 1'),
                         ('Window - Laundry S', 'Upper - Ext south 2')])):
    have = all(g in _W and u in _W for g, u in pairs)
    check(have, f'the {face} wall carries {len(pairs)} stacked bays')
    if not have:
        continue
    # THE WHOLE POINT: ground and upper share a centreline, measured centre to centre
    # rather than against the numbers that placed them. This is the 1.7 ft misalignment,
    # and nothing else would have caught it.
    for g, u in pairs:
        d = abs(_ctr(g, along) - _ctr(u, along))
        check(d < 0.01, f'{face}: "{u}" stacks on "{g}" ({d:.4f} ft apart)')
    # A row with one window off reads worse than no row, so the tiers must be uniform.
    for tier, names in (('ground', [g for g, _ in pairs]), ('upper', [u for _, u in pairs])):
        sills = {round(_W[n][2].min(), 3) for n in names}
        heads = {round(_W[n][2].max(), 3) for n in names}
        wides = {round(_W[n][along].max() - _W[n][along].min(), 3) for n in names}
        check(len(sills) == 1 and len(heads) == 1 and len(wides) == 1,
              f'{face} {tier}: one sill, head and width across the row '
              f'({sills.pop():.2f}/{heads.pop():.2f}, {wides.pop():.2f} ft wide)')
    # Evenly spaced, and the same margin at each end of the run they occupy.
    cs = sorted(_ctr(g, along) for g, _ in pairs)
    if len(cs) > 2:
        steps = [cs[i + 1] - cs[i] for i in range(len(cs) - 1)]
        check(max(steps) - min(steps) < 0.01, f'{face}: evenly spaced ({max(steps):.3f} ft)')

# PIERS — the wall LEFT between things. Nothing here measured density before, which is
# how the south wall came to carry 9.8 ft of trim in a 10.9 ft wall: two windows correctly
# stacked, correctly uniform, correctly on their bays, and 3.4 IN of wall at each corner.
# Every assertion passed. The wing's own north face is the reference: its roundel and door
# keep 1.2-1.7 ft at every corner and party line, so 1.0 ft is the floor.
#
# Measured on the TRIM, not the glass — trim spans the opening plus ~1.3 ft, and it is the
# trim that runs out of wall.
PIER_MIN = 1.0
for face, ax, wall, tiers in (
        ('south', 0, (wing_e, wing_w),
         {'ground': ('Window - WC S', 'Window - Laundry S'),
          'upper': ('Upper - Ext south 1', 'Upper - Ext south 2')}),
        ('east', 2, (wing_s, wing_n),
         {'ground': ('Window - WC E', 'Window - Bath E'),
          'upper': ('Upper - Ext east 1', 'Upper - Ext east 2')})):
    for tier, names in tiers.items():
        spans = []
        for n in names:
            parts = [b for nm, b in _parts(ext, '') if nm.endswith(n)]
            if parts:
                spans.append((min(b[ax] for b in parts), max(b[ax + 1] for b in parts)))
        check(len(spans) == len(names),
              f'{face} {tier}: {len(spans)} of {len(names)} openings measurable')
        if len(spans) != len(names):
            continue
        spans.sort()
        piers = ([spans[0][0] - wall[0]]
                 + [spans[i + 1][0] - spans[i][1] for i in range(len(spans) - 1)]
                 + [wall[1] - spans[-1][1]])
        check(min(piers) >= PIER_MIN,
              f'{face} {tier}: least pier {min(piers) * 12:.1f} in '
              f'({", ".join(f"{p * 12:.0f}" for p in piers)} in) — {PIER_MIN * 12:.0f} in min')
        # EAST IS SET OUT EQUAL: corner to trim, trim to trim, trim to corner all the
        # same. The minimum above passed happily on the old 59/34/17 in layout, so evenness
        # needs its own assertion. The GROUND row is the one set out — it is what the eye
        # measures the corners against — and the uppers take its centres, so their own
        # piers come out within an inch because their casing is narrower. That is the
        # tradeoff: shared centres beat identical piers on both tiers.
        if face == 'east':
            tol = 0.01 if tier == 'ground' else 0.1
            check(max(piers) - min(piers) < tol,
                  f'east {tier}: piers EQUAL to {tol * 12:.1f} in '
                  f'(spread {(max(piers) - min(piers)) * 12:.2f} in)')

# The south bays are the NORTH face's own two axes — the round window's and the door's —
# so the wing has two vertical lines every face it has answers to. Asserted against the
# built round window rather than a number, so the three faces cannot drift apart.
if 'Wing round window ring' in WE and 'Window - WC S' in _W:
    check(near(_ctr('Window - WC S', 0), (WE['Wing round window ring'][0]
                                          + WE['Wing round window ring'][1]) / 2, 0.01),
          "the south's east bay is the round window's axis "
          f"({_ctr('Window - WC S', 0):.4f})")
# BOTH SOUTH BAYS ARE GLAZED. The western one was blank while a laundry sat behind it;
# with a shower moving to that wall it earns a window. Asserted against the DOOR's axis on
# the north face, which is the bay line, so the pair cannot drift off the rhythm.
_fd = [d for k in EXT_W for d in json.load(open(f'ifc/rooms/{k}.json')).get('doors', [])
       if d.get('orient') == 'H' and abs(d.get('fixed', 0) - wing_n) < 1e-6]
_west_bay = [nm for nm in _W if _fd and abs(_ctr(nm, 0) - _fd[0]['pos']) < 0.2
             and _W[nm][1].max() < wing_s + 0.4]
check(_fd and _west_bay,
      f"the south's western bay is glazed again on the door's axis "
      f"({len(_west_bay)} windows at {_fd[0]['pos'] if _fd else '?'})")

# THE TRANSOMS. The whole point of raising them is that a shower moves to this wall, so
# what gets asserted is the SILL clearing standing eye level — not the window's existence.
# Measured on the GLASS: the apron and stool hang a foot below it and would mask a sill
# that had quietly dropped.
_FLOOR = BASE
for nm in ('Window - WC S', 'Window - Laundry S'):
    if nm not in _W:
        check(False, f'{nm} is built')
        continue
    sill, head = _W[nm][2].min() - _FLOOR, _W[nm][2].max() - _FLOOR
    check(sill >= 5.5, f'{nm}: sill {sill:.2f} ft above the floor, clear of standing '
                       f'eye level (5.5 ft min)')
    check(near(head, model['headHeight'], 0.02),
          f"...with its head still on the house's {model['headHeight']} ft line ({head:.2f})")

# THE UPPER TRANSOMS. The uppers cannot match the ground row's SILL — the frieze pins their
# head at 6.10 above the second floor (its soffit is 19.456 above grade at the low bay and
# the trim's header plus the siding's clearance land at 19.45) — so they match its GLASS:
# the same 2.0 x 1.25 light, landscape, carried up under the pinned head. Glass to glass,
# because that is what the eye compares. And the head still turns the corner onto the east
# uppers, which is the line someone "fixing" the south by moving its head would break.
for g, u in (('Window - WC S', 'Upper - Ext south 1'),
             ('Window - Laundry S', 'Upper - Ext south 2')):
    if g not in _W or u not in _W:
        continue
    gw, gh = _W[g][0].max() - _W[g][0].min(), _W[g][2].max() - _W[g][2].min()
    uw, uh = _W[u][0].max() - _W[u][0].min(), _W[u][2].max() - _W[u][2].min()
    check(near(gw, uw, 0.01) and near(gh, uh, 0.01),
          f'"{u}" is the same light as "{g}" ({uw:.2f} x {uh:.2f} against {gw:.2f} x {gh:.2f})')
    check(uh < uw - 0.3, f'...and landscape — a transom, not a small window ({uw:.2f} x {uh:.2f})')
if all(n in _W for n in ('Upper - Ext south 1', 'Upper - Ext east 1')):
    hs, he = _W['Upper - Ext south 1'][2].max(), _W['Upper - Ext east 1'][2].max()
    check(near(hs, he, 0.01), f'the upper head line turns the corner ({hs:.3f} south, {he:.3f} east)')

# EACH EAST WINDOW WHOLLY INSIDE ONE ROOM. This is the failure that forced the partition
# to move — equal piers put a window's trim through it — and it had never been asserted.
# Measured against the rooms as authored, so a later partition change cannot silently put
# a window through a wall again.
# Both east windows are in the BATH now: the partition between the old WC and bath is
# gone (the shower and the vanity share one open room) and the water closet is a
# compartment at the north end, past the second window.
_rooms = {k: json.load(open(f'ifc/rooms/{k}.json'))['bounds'] for k in EXT_W}
for nm, key in (('Window - WC E', 'ext_bath'), ('Window - Bath E', 'ext_bath')):
    tr = [b for n, b in _parts(ext, '') if n.endswith(nm)]
    if not tr:
        check(False, f'{nm} is built')
        continue
    lo, hi = min(b[2] for b in tr), max(b[3] for b in tr)
    z0, z1 = _rooms[key]['z1'], _rooms[key]['z2']
    check(z0 - 1e-6 <= lo and hi <= z1 + 1e-6,
          f'{nm} sits wholly inside {key} (trim {lo:.3f}..{hi:.3f} in {z0:.3f}..{z1:.3f})')

# THE WATER CLOSET IS A COMPARTMENT, and it has to be one a toilet fits across: 30 in
# clear is the code minimum, and with the vanity centred under the window at -0.74 the
# compartment wall has nowhere to go but 0.92, which leaves 31.5 in. Asserted on the
# authored bounds less the wall, so a vanity change that pushes the wall north fails
# here rather than building a 29 in room.
_WALL = 0.4583                                    # wall thickness, ft (two half-walls)
_wcb = _rooms['wc']
_wc_depth = abs(_wcb['z2'] - _wcb['z1']) - _WALL
check(_wc_depth >= 2.5, f'the water closet is {_wc_depth * 12:.1f} in clear front to back (30 min)')
check(near(_wcb['z2'], wing_n, 1e-6), 'and it sits against the north wall')
_bb = _rooms['ext_bath']
check(near(_bb['z1'], wing_s, 1e-6) and near(_bb['z2'], _wcb['z1'], 1e-6),
      f"the bath is one open room from the south wall to the compartment ({_bb['z1']:.3f}..{_bb['z2']:.3f})")

# THE WING'S POCKET DOORS. The laundry door's 3 ft in-swing stood in the middle of a 5 ft
# room a hand's width off the shower glass; the water closet's 28 in in-swing filled a
# 31 in compartment. Both slide now. Asserted for EVERY door in the wing authored
# `sliding`: the IfcDoor itself says it slides (OperationType), and the wall beyond the
# hinge jamb — the pocket — is at least a leaf's width before the room's corner. For a
# V door the pocket runs along pz toward the hinge (`max` = south here); for an H door
# along px (`max` = the east jamb, since IFC X = -px).
_wing_rooms = {k: json.load(open(f'ifc/rooms/{k}.json')) for k in EXT_W}
_sliders = [(k, d) for k, r in _wing_rooms.items() for d in r.get('doors', []) if d.get('sliding')]
check(len(_sliders) == 2, f'two pocket doors in the wing ({[d["name"] for _, d in _sliders]})')
for k, d in _sliders:
    ifc_d = next((x for x in gnd.by_type('IfcDoor') if (x.Name or '') == d['name']), None)
    check(ifc_d is not None and getattr(ifc_d, 'OperationType', None) == 'SLIDING_TO_LEFT',
          f"{d['name']}: the IfcDoor says it slides (OperationType {getattr(ifc_d, 'OperationType', None)})")
    b = _wing_rooms[k]['bounds']
    hinge_max = d.get('hinge') == 'max'
    if d['orient'] == 'V':
        # slides along pz; the pocket is the wall between the hinge jamb and the corner
        jamb = d['pos'] - d['width'] / 2 if hinge_max else d['pos'] + d['width'] / 2
        corner = min(b['z1'], b['z2']) + _WALL / 2 if hinge_max else max(b['z1'], b['z2']) - _WALL / 2
    else:
        jamb = d['pos'] - d['width'] / 2 if hinge_max else d['pos'] + d['width'] / 2
        corner = min(b['x1'], b['x2']) + _WALL / 2 if hinge_max else max(b['x1'], b['x2']) - _WALL / 2
    pocket = abs(jamb - corner)
    check(pocket >= d['width'],
          f"{d['name']}: {pocket:.2f} ft of wall beyond the {'east/south' if hinge_max else 'west/north'} "
          f"jamb for a {d['width']:.2f} ft leaf to slide into")

# THE ROUND WINDOW IS A REAL OPENING INTO THE WATER CLOSET. It began as ornament on the
# massing — a disc laid on the face — and the room file now authors it (`round: true`), so
# the ground model carries an IfcOpeningElement through the north wall and a glass
# IfcWindow in it, and the massing's ring derives from the same spec. Asserted both ways:
# the interior opening is where and how big the spec says, and the exterior ring is
# centred on it to 0.01 ft — one hole, seen from both sides.
_rw = next((w for w in json.load(open('ifc/rooms/wc.json'))['windows'] if w.get('round')), None)
check(_rw is not None, 'a round window is authored in the water closet')
if _rw:
    GW = extents(gnd, lambda nm, p: nm in ('Window - WC Round', 'Opening - Window - WC Round'))
    g_, o_ = GW.get('Window - WC Round'), GW.get('Opening - Window - WC Round')
    check(g_ is not None and o_ is not None,
          f'the ground model has the round IfcWindow and its IfcOpeningElement ({sorted(GW)})')
    if g_ and o_:
        check(near(g_[1] - g_[0], 2 * _rw['radiusFt'], 0.02) and near(g_[5] - g_[4], g_[1] - g_[0], 0.02),
              f"{2 * _rw['radiusFt']} ft across and ROUND ({g_[1] - g_[0]:.3f} by {g_[5] - g_[4]:.3f})")
        # ground.ifc is FLOOR-relative (its storey sits at 0; the viewer lifts it), where
        # the exterior model is at grade — so the interior centre is `centerFt` bare, and
        # the ring outside is `BASE` above it.
        check(near((g_[0] + g_[1]) / 2, _rw['pos'], 0.01)
              and near((g_[4] + g_[5]) / 2, _rw['centerFt'], 0.02),
              f"centred where authored ({(g_[0] + g_[1]) / 2:.4f}, {(g_[4] + g_[5]) / 2:.2f} ft above the floor)")
        check(near((g_[2] + g_[3]) / 2, wing_n, 0.05), f'in the north wall ({(g_[2] + g_[3]) / 2:.3f})')
        check(o_[3] - o_[2] > 0.4583, f'the void runs right through the wall ({o_[3] - o_[2]:.3f} ft deep)')
        _ring = globals().get('WE', {}).get('Wing round window ring')
        check(_ring is not None and near((_ring[0] + _ring[1]) / 2, (g_[0] + g_[1]) / 2, 0.01)
              and near((_ring[4] + _ring[5]) / 2, BASE + (g_[4] + g_[5]) / 2, 0.02),
              'the exterior ring and the interior opening are ONE hole (centres agree)')

# THE WATER CLOSET DOOR sits at the WEST end of the compartment wall — on the aisle past
# the vanity — with a casing return to the party wall, and in the compartment wall.
_wcd = next((d for d in json.load(open('ifc/rooms/wc.json'))['doors'] if d['name'] == 'Bath -> WC'), None)
check(_wcd is not None, 'the water closet has its door')
if _wcd:
    # The compartment's OWN west bound — the party wall with the vestibule — not the
    # wing's west edge (`wing_w`), which is the laundry's outer wall 5.5 ft further on.
    _ret = (max(_wcb['x1'], _wcb['x2']) - _WALL / 2) - (_wcd['pos'] + _wcd['width'] / 2)
    check(near(_wcd['fixed'], _wcb['z1'], 1e-6), 'in the compartment wall')
    check(0.45 <= _ret <= 0.6, f'{_ret * 12:.1f} in of casing return to the party wall (6 in wanted)')

# NO FRIEZE LIGHT ON THE EXTENSION. Its shed eave is 4 ft below the primary's frieze band,
# so one there floats in mid-air over its roof. The guard used to skip anything NAMED
# "Ext bath" and silently stopped working the moment these windows were renamed — it built
# five lights over open air. Paired with the primary still having its own, or this passes
# for a frieze band that stopped being built at all.
_fr = [nm for nm in _W if nm.startswith('Frieze - ')]
_stray = [nm for nm in _fr if _ctr(nm, 0) < wing_w - 0.5]
check(not _stray and len(_fr) >= 10,
      f'no frieze light on the extension, and the primary keeps its {len(_fr)} '
      f'({len(_stray)} stray)')

print('\n' + ('ALL CHECKS PASSED' if not fails else f'{len(fails)} FAILED'))
sys.exit(1 if fails else 0)
