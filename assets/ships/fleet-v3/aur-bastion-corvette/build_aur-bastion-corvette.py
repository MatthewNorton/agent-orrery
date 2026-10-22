"""AUR Bastion Corvette (fleet v3 Workhorse): the owner's chunky patrol corvette built from its
parts: a dark windowed bow block, three chamfered hull segments with dark joints, an upper deck
with a windowed bridge under a sensor mast, three twin turrets, greebled decks, flanks and belly,
two big rounded engine pods with dark intakes and glowing nozzles on dark pylons, upper inboard
pods with their turrets, a keel and landing legs. Original geometry; see ../_shared/fleet_v3.py and
../_shared/kitbash.py. 90 m long, 60 m wide across the pods, 21 m tall with the mast.
"""

import os
import sys

sys.dont_write_bytecode = True
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "_shared"))

import fleet_v3 as F  # noqa: E402
import kitbash as K  # noqa: E402

Y, Z = K.Y, K.Z


def build(col, root, M):
    white, dark, accent, window = M["white"], M["dark"], M["accent"], M["window"]
    top = K.top

    # 1. Hull segments with dark joints, the dark bow block with its window slots, and the stern block.
    K.segments("Hull", ((31.0, 12.0), (9.0, -14.0), (-17.0, -38.0)), (30.0, 32.0, 29.0), 16.0, 0.0, 4.0, M, col, root, joint_inset=3.0)
    K.slab("Bow", (0.0, 38.0, 0.0), (20.0, 15.0, 13.0), dark, col, root, chamfer=2.5)
    K.slab("Bow_Brow", (0.0, 36.0, 7.0), (22.0, 10.0, 3.0), white, col, root, chamfer=1.0)
    K.window_run("Bow_Win", K.line_frames((-6.0, 45.5, 1.5), (6.0, 45.5, 1.5), Y, 3), 3.2, 2.4, window, col, root, proud=0.5)
    K.plate("Bow_Accent", K.Frame((0.0, 45.5, 0.0), Y), 0.0, -4.5, 16.0, 0.8, accent, col, root, proud=0.4)
    K.slab("Stern", (0.0, -40.5, 0.0), (24.0, 3.0, 12.0), dark, col, root, chamfer=1.5)
    K.greebles("Stern_Face", K.Frame((0.0, -42.0, 0.0), -Y), 20.0, 9.0, 8, 2.6, 5, M, col, root)

    # 2. Upper deck, the bridge with its visor and window bands, and the sensor mast.
    K.segments("Deck", ((28.0, 1.0), (-2.0, -30.0)), (18.0, 18.0), 8.0, 12.0, 2.0, M, col, root, joint_inset=2.0)
    K.slab("Bridge", (0.0, 20.0, 18.6), (12.0, 10.0, 5.2), white, col, root, chamfer=1.2)
    K.slab("Bridge_Visor", (0.0, 25.3, 19.0), (10.0, 1.2, 2.2), dark, col, root, chamfer=0.4)
    K.window_run("Bridge_Win_F", K.line_frames((-4.0, 25.9, 19.0), (4.0, 25.9, 19.0), Y, 4), 1.6, 1.3, window, col, root, proud=0.35)
    for side in (1, -1):
        K.flank_windows(f"Bridge_Win_{side}", side, 6.0, 23.5, 16.5, 19.0, 3, 1.6, 1.2, window, col, root, proud=0.35)
    K.antenna_cluster("Mast", K.Frame((0.0, 14.0, 21.2), Z), 9.0, 2.6, 5, M, col, root, seed=10)

    # 3. Stern turret, the dark hangar block, greeble fields on every face, accent lines, a dark lower deck.
    K.turret("Turret_2", top(16.0), 0.0, -24.0, 0.0, 3.8, M, col, root)
    K.capped_box("Hangar", top(16.0), 0.0, -5.0, 8.0, 9.0, 3.2, M, col, root, chamfer=0.8, cap_height=0.25)
    K.window_run("Hangar_Win", K.line_frames((-3.0, -0.4, 17.6), (3.0, -0.4, 17.6), Y, 3), 1.2, 0.9, window, col, root, proud=0.3)
    K.greebles("Deck_Top", K.Frame((0.0, 8.0, 16.0), Z), 12.0, 10.0, 8, 2.6, 20, M, col, root)
    K.slab("Underdeck", (0.0, -4.0, -6.5), (29.0, 56.0, 4.0), dark, col, root, chamfer=1.0)
    for side in (1, -1):
        K.plate(f"Bow_Side_Accent_{side}", K.flank(side, 10.0, 38.0, 3.0), 0.0, 0.0, 10.0, 0.8, accent, col, root, proud=0.35)
        K.greebles(f"Hull_Top_{side}", K.Frame((side * 10.6, -4.0, 8.0), Z), 3.2, 64.0, 12, 2.6, 30 + side, M, col, root)
        K.greebles(f"Flank_{side}", K.flank(side, 15.0, -4.0, 0.0), 66.0, 10.0, 18, 3.6, 40 + side, M, col, root)
        K.greebles(f"Under_{side}", K.Frame((side * 7.0, -4.0, -8.0), -Z), 10.0, 64.0, 14, 3.4, 50 + side, M, col, root)
        K.plate(f"Deck_Accent_{side}", top(16.0), side * 6.6, -1.0, 0.7, 50.0, accent, col, root, proud=0.25)
        K.plate(f"Hull_Accent_{side}", top(8.0), side * 13.0, -4.0, 0.7, 60.0, accent, col, root, proud=0.25)
        K.slab(f"Flank_Belt_{side}", (side * 15.2, -3.0, -3.5), (1.6, 60.0, 4.5), dark, col, root, chamfer=0.4)
        K.flank_windows(f"Flank_Win_{side}", side, 16.0, 24.0, -30.0, -3.5, 8, 2.2, 1.1, window, col, root, proud=0.4, drop=0.2, seed=55 + side)

    # 4. Engine pods: rounded white bodies with dark joints, intakes and nozzles, windows, plates, modules; pylons;
    #    shoulder thrusters; landing skids.
    for side in (1, -1):
        x = 23.0 * side
        K.slab(f"Pod_{side}", (x, -4.0, 0.0), (14.0, 46.0, 16.0), white, col, root, chamfer=4.0)
        for j, y in enumerate((2.0, -16.0)):
            K.slab(f"Pod_{side}_Joint_{j}", (x, y, 0.0), (12.5, 3.0, 14.0), dark, col, root, chamfer=1.0)
        K.slab(f"Pod_{side}_Intake", (x, 19.6, 0.0), (12.0, 3.2, 14.0), dark, col, root, chamfer=2.0)
        K.nozzle(f"Pod_{side}_Intake", (x, 21.2, 0.0), Y, 4.4, 0.6, M, col, root, sides=12, glow=0.6)
        K.slab(f"Pod_{side}_Shroud", (x, -28.6, 0.0), (13.5, 6.0, 16.0), dark, col, root, chamfer=2.0)
        K.plate(f"Pod_{side}_Shroud_Accent", K.flank(side, 29.75, -28.6, 0.0), 0.0, 0.0, 4.0, 6.0, accent, col, root, proud=0.4)
        K.nozzle(f"Pod_{side}", (x, -31.5, 0.0), -Y, 5.2, 1.8, M, col, root)
        K.slab(f"Pylon_{side}", (14.0 * side, -6.0, -1.0), (10.0, 16.0, 8.0), dark, col, root, chamfer=1.5)
        K.slab(f"Pylon_{side}_Fore", (14.0 * side, 10.0, 0.0), (8.0, 8.0, 6.0), dark, col, root, chamfer=1.2)
        K.flank_windows(f"Pod_Win_{side}", side, 30.0, 14.0, -22.0, 2.0, 7, 2.0, 1.0, window, col, root, proud=0.4, drop=0.15, seed=60 + side)
        K.plate(f"Pod_Plate_{side}", K.flank(side, 30.0, -4.0, 0.0), -6.0, -3.0, 10.0, 6.0, dark, col, root, proud=0.7)
        K.plate(f"Pod_Accent_{side}", K.Frame((x, -4.0, 8.0), Z), side * 2.4, 0.0, 0.7, 36.0, accent, col, root, proud=0.25)
        K.greebles(f"Pod_Top_{side}", K.Frame((x, -4.0, 8.0), Z), 6.0, 36.0, 9, 2.8, 70 + side, M, col, root)
        K.capped_box(f"Pod_Module_{side}", K.Frame((x, 4.0, 8.0), Z), 0.0, 0.0, 7.0, 12.0, 4.0, M, col, root, chamfer=1.0, cap_height=0.3)
        # Upper inboard pods on the shoulders, with the twin turrets the sheet mounts on their fronts.
        ux = 13.0 * side
        K.slab(f"Upper_Pod_{side}", (ux, -14.0, 11.5), (9.0, 28.0, 9.0), white, col, root, chamfer=2.5)
        K.slab(f"Upper_Pod_{side}_Joint", (ux, -10.0, 11.5), (8.0, 2.4, 8.0), dark, col, root, chamfer=0.8)
        K.slab(f"Upper_Pod_{side}_Intake", (ux, 0.4, 11.5), (7.6, 2.4, 7.6), dark, col, root, chamfer=1.2)
        K.slab(f"Upper_Pod_{side}_Shroud", (ux, -28.4, 11.5), (8.6, 2.8, 8.6), dark, col, root, chamfer=1.2)
        K.nozzle(f"Upper_Pod_{side}", (ux, -29.8, 11.5), -Y, 3.2, 1.4, M, col, root, sides=14)
        K.plate(f"Upper_Pod_{side}_Accent", K.flank(side, 17.5, -14.0, 11.5), 0.0, 0.0, 20.0, 0.6, accent, col, root, proud=0.3)
        K.flank_windows(f"Upper_Pod_Win_{side}", side, 17.5, -4.0, -22.0, 13.0, 4, 1.8, 0.9, window, col, root, proud=0.35, drop=0.1, seed=90 + side)
        K.turret(f"Upper_Turret_{side}", K.Frame((ux, -5.0, 16.0), Z), 0.0, 0.0, 0.0, 3.2, M, col, root)
        K.greebles(f"Upper_Pod_Top_{side}", K.Frame((ux, -18.0, 16.0), Z), 5.0, 14.0, 5, 2.2, 95 + side, M, col, root)
        # Landing legs: a hip block, a splayed strut and a foot under each quarter.
        for j, y in enumerate((17.0, -19.0)):
            K.cbox(f"Leg_{side}_{j}_Hip", K.Frame((9.0 * side, y, -8.0), -Z), 0.0, 0.0, 0.0, 2.6, 2.6, 1.2, dark, col, root, chamfer=0.3)
            K.rod(f"Leg_{side}_{j}", (9.0 * side, y, -8.6), (11.0 * side, y - 1.0, -13.5), 0.45, dark, col, root, sides=8)
            K.cbox(f"Leg_{side}_{j}_Foot", K.Frame((11.2 * side, y - 1.0, -13.6), -Z), 0.0, 0.0, 0.0, 3.0, 2.2, 0.7, dark, col, root, chamfer=0.15)
    K.slab("Keel", (0.0, -4.0, -9.0), (8.0, 52.0, 2.6), dark, col, root, chamfer=0.6)
    K.plate("Keel_Accent", K.Frame((0.0, -4.0, -10.3), -Z), 0.0, 0.0, 1.0, 40.0, accent, col, root, proud=0.3)


REQUIRED_PARTS = [
    {"name": "hull and bow", "object_names": ["Hull_White", "Hull_Dark", "Windows", "Livery"],
     "evidence": "Three 30-32 m wide chamfered hull segments with dark joints, a dark 20 x 15 m bow block with three window slots under a white brow, a stern block, an 18 m upper deck in two segments."},
    {"name": "bridge, mast and turrets", "object_names": ["Hull_White", "Hull_Dark", "Hull_Grey", "Windows"],
     "evidence": "12 x 10 m bridge with a dark visor and ten windows, a 9 m five-rod sensor mast, three twin-barrel turrets on the deck."},
    {"name": "surface detail", "object_names": ["Hull_Dark", "Hull_Grey", "Hull_White", "Livery"],
     "evidence": "About 110 greebles across the deck, hull-top strips, flanks, belly, pod tops and stern face; accent lines on the deck, hull and keel; flank window lines."},
    {"name": "engine pods and thrusters", "object_names": ["Hull_White", "Hull_Dark", "Glow", "Windows"],
     "evidence": "Two 14 x 46 x 16 m rounded pods at x=+-23 with dark joints, glowing intakes and nozzles, seven-window lines, plates, top modules, on dark pylons; two upper inboard pods with twin turrets; four landing legs."},
]

if __name__ == "__main__":
    F.run(SCRIPT_DIR, build, REQUIRED_PARTS, tile=6.0, title="AUR Bastion Corvette (fleet v3 Workhorse)")
