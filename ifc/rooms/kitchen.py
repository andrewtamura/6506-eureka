"""Bespoke kitchen geometry.

The dining room's built-in butler's-pantry hutch (modelled as a viewer mesh, see
src/furniture.js) sits in a wide cased opening in the shared dining/kitchen wall
and is 18" deep, so it passes through the wall and protrudes into the kitchen.
On the kitchen side that protrusion reads as a full-height, finished bump-out.

Build that bump-out here as a finished box on the kitchen face of the z=2 wall:
16" deep, full wall height, spanning the cabinet width. (The hutch's own back
sits inside this box, so the kitchen only sees a clean plastered bump-out.)
"""
import builders as B
from ifcopenshell.api import run

# Must match the hutch placement in rooms/dining.json.
CABINET_CX_FT = 23.04      # plan-x centre of the built-in
CABINET_W_FT = 6.62        # bump-out width (>= hutch width, to cover its sides)
BUMP_DEPTH_FT = 16.0 / 12  # 16" proud of the finished kitchen wall face


def build(ctx, room):
    ft = B.FT
    kitchen_face = 2.0 - (ctx.T / ft) / 2          # plan-z of the finished kitchen wall face
    back = kitchen_face - BUMP_DEPTH_FT
    cz_ft = (kitchen_face + back) / 2
    box = B.make_box(
        ctx, "IfcWall", "Kitchen Cabinet Bump-out",
        CABINET_W_FT * ft, BUMP_DEPTH_FT * ft, ctx.H,
        ctx.X(CABINET_CX_FT), ctx.Y(cz_ft), 0.0,
        color=(0.93, 0.92, 0.90))
    run("spatial.assign_container", ctx.model, products=[box], relating_structure=ctx.storey)
