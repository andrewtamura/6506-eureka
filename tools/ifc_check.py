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
        half = abs(w['width']) / 2
        wlo, whi = w['pos'] - half, w['pos'] + half
        hit = [c for c in corniced if c[1] == w['orient'] and abs(c[2] - w['fixed']) < 0.3
               and min(whi, c[4]) - max(wlo, c[3]) > 0.05]
        if not hit:
            continue
        over = w['head'] - head_ft
        if over > 0.01:
            bad += 1
            check(False, f"{w['name']}: head {w['head']} ft is {over:.2f} ft ABOVE the "
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

# --- the two clearances the deck is dimensioned by ---------------------------------
w_clear = west_line - D['Deck - scullery'][1]
e_clear = D['Deck terrace E'][0] - east_line
check(near(w_clear, dk['westClearFt']),
      f"WEST yard: {dk['westClearFt']} ft, deck edge to the west line ({w_clear:.4f})")
check(near(e_clear, dk['eastClearFt']),
      f"EAST yard: {dk['eastClearFt']} ft, terrace edge to the east line ({e_clear:.4f})")
# ...and the same distances to the STAIR TOES, which is the ground you can actually
# stand on. A flight projects past the edge it descends from, so the platform figure
# alone would hide the encroachment entirely.
w_toe = max(b[1] for nm, b in D.items() if nm.startswith('Deck step W'))
e_toe = min(b[0] for nm, b in D.items() if nm.startswith('Deck step E'))
check(near(west_line - w_toe, dk['westClearFt'] - toe),
      f'clear ground west of the stair toe ({west_line - w_toe:.4f} ft)')
check(near(e_toe - east_line, dk['eastClearFt'] - toe),
      f'clear ground east of the stair toe ({e_toe - east_line:.4f} ft)')

# --- the steps: stepCount RISERS is stepCount-1 treads plus a flush grade paver -----
tre = sorted((nm for nm in D if nm.startswith('Deck step E')), key=lambda n: D[n][0], reverse=True)
check(len(tre) == dk['stepCount'],
      f"east flight is {dk['stepCount']} risers = {dk['stepCount'] - 1} treads + a grade paver ({len(tre)})")
tops = [D[nm][5] for nm in tre]
want = [BASE - (k + 1) * riser for k in range(dk['stepCount'] - 1)] + [0.0]
check(all(near(a, b, 0.02) for a, b in zip(tops, want)),
      f"...rising {riser * 12:.1f} in a tread ({', '.join(f'{t:.3f}' for t in tops)})")
# and they span the terrace's WHOLE north-south run, which is what "full width" means
check(all(near(D[nm][2], D['Deck terrace E'][2], 0.02) and near(D[nm][3], D['Deck terrace E'][3], 0.02)
          for nm in tre),
      'and run the full depth of the terrace, edge to edge')

# --- the hot tub -------------------------------------------------------------------
wall_in = D['Lot wall - south'][3]                  # the CMU wall's INNER face
tub_s, tub_n = D['Hot tub surround S'][3], D['Hot tub surround N'][2]
tub_w, tub_e = D['Hot tub surround W'][0], D['Hot tub surround E'][1]
check(near(tub_s - wall_in, tb['fromWallIn'] / 12),
      f"tub sits {tb['fromWallIn']} in off the south wall's inner face ({(tub_s - wall_in) * 12:.2f} in)")
check(near(tub_n - tub_s, tb['sizeFt']) and near(tub_w - tub_e, tb['sizeFt']),
      f"tub is {tb['sizeFt']} x {tb['sizeFt']} ft ({tub_w - tub_e:.3f} x {tub_n - tub_s:.3f})")
check(near(BASE - D['Hot tub surround S'][5], riser * tb['recessRisers'], 0.02),
      f"its surround is recessed exactly {tb['recessRisers']} riser below the deck "
      f"({(BASE - D['Hot tub surround S'][5]) * 12:.2f} in)")

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
    check(near(h.get('rimFt', 0), BASE - riser * tb['recessRisers'], 0.02),
          f"its rim lands on the surround, not on the deck ({h.get('rimFt')} ft)")

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
    check(near(run_lo, east_line, 0.4), f'the fence reaches the east property line ({run_lo:.3f})')
    check(near(run_hi, -22.9167, 0.4), f"and starts at the extension's NE corner ({run_hi:.3f})")
    edge = D['Deck terrace E'][0]
    on_deck = {nm: b for nm, b in boards.items() if b[0] > edge - 1e-6}
    on_grade = {nm: b for nm, b in boards.items() if b[1] < edge + 1e-6}
    check(len(on_deck) + len(on_grade) == len(boards),
          f'every board is wholly on the deck or wholly on grade ({len(on_deck)} + {len(on_grade)}'
          f' of {len(boards)}) \u2014 the step is at the deck edge, not adrift')
    surface = fn.get('heightDatum', 'surface') == 'surface'
    for label, grp, y0 in (('over the deck', on_deck, BASE), ('on grade', on_grade, 0.0)):
        if not grp:
            continue
        top = fn['heightFt'] + y0 if surface else fn['heightFt']
        bad = [nm for nm, b in grp.items() if not (near(b[4], y0, 0.02) and near(b[5], top, 0.02))]
        check(not bad, f"{len(grp)} boards {label} run {y0:.2f} to {top:.2f} ft"
                       + ('' if not bad else f' \u2014 {len(bad)} off'))

print('\n' + ('ALL CHECKS PASSED' if not fails else f'{len(fails)} FAILED'))
sys.exit(1 if fails else 0)
