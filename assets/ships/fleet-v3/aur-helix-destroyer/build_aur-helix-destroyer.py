"""AUR Helix Destroyer (fleet v3 Capital): a 450 m spinal destroyer built the way the owner's sheet
draws it: a stepped stack of chamfered hull segments with dark joints, a blunt windowed prow over a
dark jaw, three decks of panel detail with accent edges, twin turrets, flank channels with window
lines, sponsons, a conning tower under an antenna forest, and six layered engine pods aft.
Original geometry; see ../_shared/fleet_v3.py and ../_shared/kitbash.py.
"""

import os
import sys

sys.dont_write_bytecode = True
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "_shared"))

from mathutils import Vector  # noqa: E402

import fleet_v3 as F  # noqa: E402
import kitbash as K  # noqa: E402

Y, Z = K.Y, K.Z


def build(col, root, M):
    white, dark, grey, accent, window = M["white"], M["dark"], M["grey"], M["accent"], M["window"]
    top = K.top

    # 1. Three stepped decks of chamfered segments with dark joints, and the prow wedge over its jaw.
    lower = ((150.0, 96.0), (93.0, 36.0), (33.0, -28.0), (-31.0, -92.0), (-95.0, -148.0), (-151.0, -178.0))
    widths = (90.0, 96.0, 100.0, 100.0, 94.0, 84.0)
    K.segments("Hull", lower, widths, 36.0, 0.0, 9.0, M, col, root)
    deck = ((132.0, 82.0), (79.0, 22.0), (19.0, -40.0), (-43.0, -118.0))
    K.segments("Deck", deck, (58.0, 62.0, 62.0, 58.0), 16.0, 26.0, 4.0, M, col, root, joint_inset=4.0)
    K.segments("Spine", ((110.0, 40.0), (36.0, -46.0)), (30.0, 32.0), 10.0, 39.0, 2.5, M, col, root, joint_inset=3.0)
    prow = ((153.0, 90.0, 36.0, 0.0, 9.0), (195.0, 66.0, 28.0, 1.0, 7.0), (215.0, 40.0, 18.0, 2.0, 5.0), (226.0, 22.0, 11.0, 3.0, 3.0))
    K.tube("Prow", [K.octagon(K.Frame((0.0, y, zc), Y), w, h, c) for y, w, h, zc, c in prow], white, col, root)
    K.slab("Prow_Jaw", (0.0, 206.0, -9.0), (46.0, 40.0, 14.0), dark, col, root, chamfer=4.0)
    K.slab("Prow_Jaw_Lip", (0.0, 222.0, -6.0), (26.0, 14.0, 8.0), dark, col, root, chamfer=2.0)
    K.window_run("Prow_Win_F", K.line_frames((-8.0, 226.4, 4.0), (8.0, 226.4, 4.0), Y, 5), 2.6, 2.0, window, col, root, proud=0.8, sink=0.6)
    K.plate("Prow_Accent", K.Frame((0.0, 226.4, 0.0), Y), 0.0, -1.0, 16.0, 1.2, accent, col, root, proud=0.8)
    K.plate("Prow_Top_Plate", K.Frame((0.0, 178.0, 16.3), Z), 0.0, 0.0, 14.0, 36.0, dark, col, root, proud=1.6)
    K.plate("Prow_Top_Plate_Win", K.Frame((0.0, 178.0, 16.3), Z), 0.0, 0.0, 4.0, 22.0, window, col, root, proud=0.8, h0=1.6)
    K.greebles("Prow_Top", K.Frame((0.0, 190.0, 15.8), Z), 36.0, 40.0, 14, 7.0, 7, M, col, root)
    for side in (1, -1):
        normal = Vector((0.84 * side, 0.54, 0.0))  # the prow's sloped flank
        K.window_run(f"Prow_Win_{side}", K.line_frames((21.5 * side, 212.0, 5.0), (32.0 * side, 196.0, 5.5), normal, 4), 3.0, 1.8, window, col, root, proud=1.0, sink=0.8)
        K.plate(f"Prow_Side_Plate_{side}", K.Frame((28.0 * side, 203.0, -1.0), normal), 0.0, 0.0, 26.0, 9.0, dark, col, root, proud=1.8)
        K.plate(f"Prow_Side_Accent_{side}", K.Frame((37.5 * side, 188.0, 10.0), Vector((0.9 * side, 0.44, 0.0))), 0.0, 0.0, 22.0, 1.4, accent, col, root, proud=1.4)

    # 2. Accent edges, dark panel plates and greeble fields on every deck, the flanks and the belly.
    for i, (hi, lo) in enumerate(lower):
        for side in (1, -1):
            if i % 2 == 0:
                K.plate(f"Hull_Edge_{i}_{side}", top(18.0), side * (widths[i] / 2.0 - 11.5), (hi + lo) / 2.0, 1.8, (hi - lo) * 0.86, accent, col, root, proud=0.5)
                K.slab(f"Hull_Armor_{i}_{side}", (side * (widths[i] / 2.0 + 0.5), (hi + lo) / 2.0, 9.0), (3.0, (hi - lo) * 0.7, 7.0), dark, col, root, chamfer=0.8)
            else:
                K.plate(f"Hull_Channel_{i}_{side}", top(18.0), side * (widths[i] / 2.0 - 17.0), (hi + lo) / 2.0, 9.0, (hi - lo) * 0.62, dark, col, root, proud=1.0)
                K.plate(f"Hull_Channel_Win_{i}_{side}", top(18.0), side * (widths[i] / 2.0 - 17.0), (hi + lo) / 2.0, 3.0, (hi - lo) * 0.4, window, col, root, proud=0.6, h0=1.0)
    for i, (hi, lo) in enumerate(deck):
        for side in (1, -1):
            if i % 2 == 0:
                K.plate(f"Deck_Edge_{i}_{side}", top(34.0), side * 24.5, (hi + lo) / 2.0, 1.5, (hi - lo) * 0.8, accent, col, root, proud=0.4)
            else:
                K.plate(f"Deck_Channel_{i}_{side}", top(34.0), side * 21.0, (hi + lo) / 2.0, 7.0, (hi - lo) * 0.6, dark, col, root, proud=0.9)
    for i, y in enumerate((120.0, 60.0, 0.0, -60.0, -120.0)):
        for side in (1, -1):
            K.plate(f"Hull_Panel_{i}_{side}", top(18.0), side * 37.0, y, 12.0, 22.0, dark, col, root, proud=0.8)
    for side in (1, -1):
        K.greebles(f"Hull_Top_{side}", K.Frame((side * 38.0, -10.0, 18.0), Z), 14.0, 290.0, 46, 8.5, 10 + side, M, col, root)
        K.greebles(f"Deck_Top_{side}", K.Frame((side * 23.0, 5.0, 34.0), Z), 12.0, 240.0, 34, 7.0, 20 + side, M, col, root)
        K.greebles(f"Hull_Flank_{side}", K.flank(side, 50.0, -15.0, 2.0), 320.0, 12.0, 46, 9.0, 30 + side, M, col, root)
        K.greebles(f"Hull_Under_{side}", K.Frame((side * 24.0, -20.0, -18.0), -Z), 20.0, 280.0, 32, 9.0, 40 + side, M, col, root)
    K.greebles("Spine_Top", top(44.0), 24.0, 150.0, 20, 8.0, 50, M, col, root)
    K.plate("Spine_Channel", top(44.0), 0.0, 32.0, 10.0, 120.0, dark, col, root, proud=1.0)

    # 3. Flank channels: a dark belt with a window line, two sponsons a side with turrets and accents.
    for side in (1, -1):
        K.slab(f"Flank_Belt_{side}", (side * 49.5, -15.0, -6.0), (3.0, 330.0, 11.0), dark, col, root, chamfer=0.8)
        K.flank_windows(f"Flank_Win_{side}", side, 51.0, 145.0, -175.0, -6.0, 30, 5.0, 2.6, window, col, root, proud=0.8, drop=0.2, seed=60 + side)
        for j, y in enumerate((70.0, -60.0)):
            K.slab(f"Sponson_{side}_{j}", (side * 54.0, y, -4.0), (18.0, 64.0, 24.0), dark, col, root, chamfer=4.0)
            K.slab(f"Sponson_{side}_{j}_Cap", (side * 54.0, y, 9.0), (12.0, 40.0, 4.0), grey, col, root, chamfer=1.0)
            K.turret(f"Sponson_{side}_{j}_Turret", K.Frame((side * 54.0, y, 11.0), Z), 0.0, 0.0, 0.0, 7.0, M, col, root)
            K.flank_windows(f"Sponson_Win_{side}_{j}", side, 63.0, y + 22.0, y - 22.0, -4.0, 5, 4.0, 2.2, window, col, root, proud=0.6)
            K.plate(f"Sponson_Accent_{side}_{j}", K.flank(side, 63.0, y, -4.0), 0.0, -9.0, 50.0, 1.2, accent, col, root, proud=0.5)

    # 4. Twin-barrel turrets down the decks, a bow sensor cluster and bow rods.
    for i, (x, y, z) in enumerate(((0.0, 122.0, 34.0), (22.0, 62.0, 34.0), (-22.0, 62.0, 34.0), (22.0, -8.0, 34.0), (-22.0, -8.0, 34.0),
                                   (28.0, -162.0, 18.0), (-28.0, -162.0, 18.0))):
        K.turret(f"Turret_{i}", K.Frame((x, y, z), Z), 0.0, 0.0, 0.0, 9.0, M, col, root)
    K.antenna_cluster("Bow_Sensor", K.Frame((0.0, 168.0, 17.0), Z), 14.0, 5.0, 4, M, col, root, seed=80)
    for side in (1, -1):
        K.drum(f"Bow_Rod_{side}", K.Frame((side * 14.0, 185.0, 15.0), Z), 0.0, 0.0, 0.0, 0.5, 9.0, dark, col, root, sides=6)

    # 5. Conning tower: two tiers, a bridge with window bands on a neck, wings, and the antenna forest.
    K.slab("Tower_1", (0.0, -92.0, 44.0), (42.0, 52.0, 20.0), white, col, root, chamfer=5.0)
    K.slab("Tower_1_Band", (0.0, -92.0, 44.0), (46.0, 14.0, 16.0), dark, col, root, chamfer=3.0)
    K.slab("Tower_2", (0.0, -98.0, 61.0), (30.0, 36.0, 14.0), white, col, root, chamfer=4.0)
    K.slab("Bridge_Neck", (0.0, -76.0, 61.0), (24.0, 20.0, 14.0), dark, col, root, chamfer=3.0)
    K.slab("Bridge", (0.0, -80.0, 73.0), (36.0, 24.0, 10.0), white, col, root, chamfer=3.0)
    K.slab("Bridge_Visor", (0.0, -68.5, 74.0), (30.0, 3.0, 5.0), dark, col, root, chamfer=1.0)
    K.window_run("Bridge_Win_F", K.line_frames((-12.0, -66.9, 74.0), (12.0, -66.9, 74.0), Y, 6), 3.0, 2.4, window, col, root, proud=0.6)
    for side in (1, -1):
        K.flank_windows(f"Bridge_Win_{side}", side, 18.0, -72.0, -88.0, 74.0, 4, 3.0, 2.2, window, col, root, proud=0.6)
        K.slab(f"Tower_Wing_{side}", (side * 26.0, -96.0, 52.0), (12.0, 30.0, 12.0), dark, col, root, chamfer=2.5)
        K.plate(f"Tower_Wing_Cap_{side}", K.Frame((side * 26.0, -96.0, 58.0), Z), 0.0, 0.0, 8.0, 22.0, grey, col, root, proud=1.0)
    K.antenna_cluster("Tower_Mast", K.Frame((0.0, -104.0, 68.0), Z), 56.0, 16.0, 14, M, col, root, seed=70, rod_scale=1.6, mast_scale=1.3)
    K.greebles("Tower_Top", K.Frame((0.0, -84.0, 78.0), Z), 28.0, 16.0, 8, 4.0, 71, M, col, root)

    # 6. Six layered engine pods aft on dark pylons: two outboard, two upper and two lower inboard.
    for side in (1, -1):
        K.engine_pod(f"Pod_Outer_{side}", (side * 66.0, -128.0, -2.0), Y, 17.0, 150.0, M, col, root, seed=90 + side)
        K.engine_pod(f"Pod_Upper_{side}", (side * 40.0, -150.0, 28.0), Y, 12.5, 120.0, M, col, root, seed=92 + side)
        K.engine_pod(f"Pod_Lower_{side}", (side * 40.0, -150.0, -22.0), Y, 12.5, 120.0, M, col, root, seed=94 + side)
        K.slab(f"Pylon_{side}", (side * 50.0, -130.0, -2.0), (22.0, 56.0, 14.0), dark, col, root, chamfer=3.0)
        K.slab(f"Pylon_{side}_Upper", (side * 36.0, -150.0, 14.0), (14.0, 40.0, 14.0), dark, col, root, chamfer=3.0)

    # 7. Underside: keel, ventral fin with an accent edge, landing feet, and the greebled stern block.
    K.slab("Keel", (0.0, -20.0, -20.0), (30.0, 330.0, 5.0), dark, col, root, chamfer=1.5)
    K.slab("Ventral_Fin", (0.0, -120.0, -30.0), (4.0, 64.0, 22.0), white, col, root, chamfer=1.2)
    K.plate("Ventral_Fin_Edge", K.Frame((0.0, -120.0, -41.0), -Z), 0.0, 0.0, 2.5, 56.0, accent, col, root, proud=0.8)
    for side in (1, -1):
        for j, y in enumerate((-60.0, -140.0)):
            K.slab(f"Foot_{side}_{j}", (side * 28.0, y, -22.0), (12.0, 20.0, 9.0), dark, col, root, chamfer=2.0)
    K.slab("Stern", (0.0, -182.0, 0.0), (74.0, 10.0, 28.0), dark, col, root, chamfer=4.0)
    K.greebles("Stern_Face", K.Frame((0.0, -187.0, 0.0), -Y), 60.0, 20.0, 14, 6.0, 99, M, col, root)


REQUIRED_PARTS = [
    {"name": "stepped hull and prow", "object_names": ["Hull_White", "Hull_Dark", "Windows", "Livery"],
     "evidence": "Six lower, four deck and two spine segments (100 m wide, 36 m tall at amidships) with dark joints, a four-station prow wedge over a dark jaw with window bands, accent edges on alternate segments."},
    {"name": "surface detail", "object_names": ["Hull_Dark", "Hull_Grey", "Hull_White"],
     "evidence": "About 350 greebles on the deck strips, flanks, belly, spine and stern; dark panel plates; flank belts with 30-window lines; two sponsons a side with turrets."},
    {"name": "turrets and tower", "object_names": ["Hull_Dark", "Hull_Grey", "Windows"],
     "evidence": "Seven twin-barrel deck turrets plus four on sponsons; a two-tier conning tower with a windowed bridge, wings and a 56 m antenna forest of fourteen rods."},
    {"name": "engine pods", "object_names": ["Hull_White", "Hull_Dark", "Glow", "Livery"],
     "evidence": "Six layered pods aft (17 m outboard, 12.5 m inboard radius) with intakes, bands, shrouds, nozzles, glow discs, fins, pipes, stripes and window dashes, on dark pylons."},
]

if __name__ == "__main__":
    F.run(SCRIPT_DIR, build, REQUIRED_PARTS, tile=20.0, title="AUR Helix Destroyer (fleet v3 Capital)")
