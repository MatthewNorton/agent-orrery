"""AUR Ark Carrier (fleet v3 Flagship): the owner's wheel station under way, built from its parts:
a habitat ring of sixteen chamfered cars with dark couplers, two window lines, panel plates and
rails; four cardinal junction blocks with radial mast arrays; four three-beam spokes with dark
modules; a four-tier hub with window rings and turrets under a spire cluster; and an underside of
tiers, a keel array and four vertical engine pods. Original geometry; see ../_shared/fleet_v3.py
and ../_shared/kitbash.py. About 2.5 km across the masts and 1.35 km tall.
"""

import math
import os
import sys

sys.dont_write_bytecode = True
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "_shared"))

import fleet_v3 as F  # noqa: E402
import kitbash as K  # noqa: E402

R, RING_W, RING_H, RING_C, CARS = 760.0, 170.0, 190.0, 40.0, 16
GAP, COLLAR = math.radians(3.2), math.radians(1.5)
TAU, Z, O = K.TAU, K.Z, K.O


def build(col, root, M):
    white, dark, grey, accent, glass, window = M["white"], M["dark"], M["grey"], M["accent"], M["glass"], M["window"]
    outer, inner = R + RING_W / 2.0, R - RING_W / 2.0
    step = TAU / CARS

    # 1. The habitat ring: sixteen cars between dark collars and couplers, a curved dark window band on the
    #    outer face with two window lines, inner plates, rails, greebles and four arrays.
    for i in range(CARS):
        a0, a1 = i * step + GAP / 2.0, (i + 1) * step - GAP / 2.0
        mid = (a0 + a1) / 2.0
        K.arc_car(f"Ring_Car_{i}", R, 0.0, a0, a1, RING_W, RING_H, RING_C, white, col, root, steps=6)
        for k, a in enumerate((a0, a1 - COLLAR)):
            K.arc_car(f"Ring_Collar_{i}_{k}", R, 0.0, a, a + COLLAR, RING_W + 18.0, RING_H + 18.0, 48.0, dark, col, root, steps=2)
            K.arc_car(f"Ring_Collar_Accent_{i}_{k}", R, 0.0, a + COLLAR * 0.3, a + COLLAR * 0.7, RING_W + 22.0, RING_H + 22.0, 52.0, accent, col, root, steps=2)
        K.arc_car(f"Ring_Coupler_{i}", R, 0.0, a1 - 0.01, a1 + GAP + 0.01, RING_W - 44.0, RING_H - 50.0, 16.0, dark, col, root, steps=2)
        K.arc_car(f"Ring_Band_{i}", outer + 1.0, 0.0, a0 + COLLAR + 0.01, a1 - COLLAR - 0.01, 10.0, 76.0, 3.0, dark, col, root, steps=5)
        for j, z in enumerate((22.0, -22.0)):
            K.window_run(f"Ring_Win_{j}_{i}", K.arc_frames(O, outer + 6.0, z, a0 + COLLAR + 0.02, a1 - COLLAR - 0.02, 7), 17.0, 9.0, window, col, root, proud=2.5, drop=0.12, seed=50 * j + i)
        K.plate(f"Ring_Plate_{i}", K.arc_frame(O, outer, 66.0, mid), 0.0, 0.0, 80.0, 30.0, dark, col, root, proud=4.0)
        K.plate(f"Ring_Plate_Lo_{i}", K.arc_frame(O, outer, -66.0, mid), 0.0, 0.0, 60.0, 26.0, grey, col, root, proud=4.0)
        K.plate(f"Ring_Inner_{i}", K.arc_frame(O, inner, 0.0, mid, outward=False), 0.0, 0.0, 110.0, 80.0, dark, col, root, proud=7.0)
        K.window_run(f"Ring_Win_In_{i}", K.arc_frames(O, inner, 30.0, a0 + 0.03, a1 - 0.03, 5, outward=False), 15.0, 7.0, window, col, root, proud=2.5, drop=0.2, seed=100 + i)
        K.arc_greebles(f"Ring_Top_{i}", O, R - 58.0, R + 58.0, RING_H / 2.0, a0 + COLLAR + 0.02, a1 - COLLAR - 0.02, 11, 34.0, 200 + i, M, col, root)
        if i % 2 == 0:
            K.arc_greebles(f"Ring_Under_{i}", O, R - 50.0, R + 50.0, -RING_H / 2.0, a0 + COLLAR + 0.02, a1 - COLLAR - 0.02, 6, 32.0, 300 + i, M, col, root, normal=-Z)
        else:
            K.plate(f"Ring_Top_Plate_{i}", K.arc_frame(O, R + 20.0, RING_H / 2.0, mid, normal=Z), 0.0, 0.0, 150.0, 70.0, dark, col, root, proud=6.0)
    K.arc_car("Ring_Rail", R - 44.0, RING_H / 2.0 + 5.0, 0.0, TAU, 30.0, 12.0, 3.0, dark, col, root, steps=96, closed=True)
    K.arc_car("Ring_Rail_Under", R, -RING_H / 2.0 - 4.0, 0.0, TAU, 26.0, 9.0, 2.5, dark, col, root, steps=96, closed=True)
    for k in range(4):
        t = math.radians(45 + 90 * k)
        K.antenna_cluster(f"Ring_Array_{k}", K.Frame(K.polar(R, t, RING_H / 2.0 + 8.0), Z), 130.0, 34.0, 6, M, col, root, seed=400 + k)

    # 2. Junction blocks at the cardinal points: white shell, dark core, caps, window lines, radial mast arrays.
    for k, s, t, radial, _tangent in K.cardinals():
        c = radial * R
        K.slab(f"Junction_{s}", c, (290.0, 236.0, 256.0), white, col, root, chamfer=38.0, rotation=(0.0, 0.0, t))
        K.slab(f"Junction_{s}_Core", c, (340.0, 176.0, 196.0), dark, col, root, chamfer=22.0, rotation=(0.0, 0.0, t))
        K.slab(f"Junction_{s}_Cap", c + Z * 134.0, (170.0, 150.0, 28.0), grey, col, root, chamfer=6.0, rotation=(0.0, 0.0, t))
        K.slab(f"Junction_{s}_Keel", c - Z * 134.0, (150.0, 130.0, 24.0), dark, col, root, chamfer=6.0, rotation=(0.0, 0.0, t))
        face = K.Frame(c + radial * 170.0, radial)
        for j, z in enumerate((60.0, -60.0)):
            K.window_run(f"Junction_{s}_Win_{j}", K.line_frames(face.at(-80.0, z, 0.0), face.at(80.0, z, 0.0), radial, 6), 16.0, 8.0, window, col, root, proud=2.5)
        K.plate(f"Junction_{s}_Accent", face, 0.0, 0.0, 150.0, 8.0, accent, col, root, proud=2.5)
        K.antenna_cluster(f"Junction_{s}_Mast", K.Frame(c + radial * 170.0, radial, up=Z), 300.0, 46.0, 8, M, col, root, seed=500 + k)
        K.greebles(f"Junction_{s}_Top", K.Frame(c + Z * 148.0, Z, up=radial), 150.0, 130.0, 12, 28.0, 600 + k, M, col, root)

    # 3. Spokes: three white segments with dark joints, a dark beam each side, window lines, accents, modules, roots.
    inner_r, outer_r = 336.0, inner + 12.0
    length = outer_r - inner_r
    for k, s, t, radial, tangent in K.cardinals():
        c = radial * (inner_r + length / 2.0)
        for j, (t0, t1) in enumerate(((0.0, 0.31), (0.345, 0.655), (0.69, 1.0))):
            K.slab(f"Spoke_{s}_{j}", radial * (inner_r + length * (t0 + t1) / 2.0), (length * (t1 - t0), 136.0, 104.0), white, col, root, chamfer=24.0, rotation=(0.0, 0.0, t))
        for j, tj in enumerate((0.3275, 0.6725)):
            K.slab(f"Spoke_{s}_Joint_{j}", radial * (inner_r + length * tj), (22.0, 118.0, 88.0), dark, col, root, chamfer=8.0, rotation=(0.0, 0.0, t))
            K.slab(f"Spoke_{s}_Collar_{j}", radial * (inner_r + length * tj), (14.0, 150.0, 118.0), dark, col, root, chamfer=10.0, rotation=(0.0, 0.0, t))
        top = K.Frame(c + Z * 52.0, Z, up=radial)
        for side in (1, -1):
            K.slab(f"Spoke_{s}_Beam_{side}", c + tangent * (104.0 * side) - Z * 8.0, (length * 0.9, 62.0, 72.0), dark, col, root, chamfer=12.0, rotation=(0.0, 0.0, t))
            K.slab(f"Spoke_{s}_Beam_{side}_Cap", c + tangent * (104.0 * side) + Z * 28.0, (length * 0.5, 40.0, 10.0), grey, col, root, chamfer=2.0, rotation=(0.0, 0.0, t))
            face = c + tangent * (68.0 * side) + Z * 30.0
            K.window_run(f"Spoke_{s}_Win_{side}", K.line_frames(face - radial * (length * 0.42), face + radial * (length * 0.42), tangent * side, 12), 14.0, 7.0, window, col, root, proud=2.0, drop=0.15, seed=700 + 2 * k + (side > 0))
            K.plate(f"Spoke_{s}_Accent_{side}", top, side * 54.0, 0.0, 6.0, length * 0.84, accent, col, root, proud=1.5)
            K.plate(f"Spoke_{s}_Channel_{side}", top, side * 32.0, 0.0, 14.0, length * 0.8, dark, col, root, proud=2.0)
        K.greebles(f"Spoke_{s}_Top", top, 100.0, length * 0.92, 26, 26.0, 800 + k, M, col, root)
        for j, tj in enumerate((-0.12, 0.2)):
            K.capped_box(f"Spoke_{s}_Module_{j}", top, 0.0, tj * length, 96.0, 124.0, 54.0, M, col, root, chamfer=10.0)
            K.window_run(f"Spoke_{s}_Module_{j}_Win", K.line_frames(top.at(-48.0, tj * length - 40.0, 30.0), top.at(-48.0, tj * length + 40.0, 30.0), -top.u, 4), 12.0, 6.0, window, col, root, proud=2.0)
        K.slab(f"Spoke_{s}_Root", radial * (inner_r + 6.0), (110.0, 180.0, 140.0), dark, col, root, chamfer=16.0, rotation=(0.0, 0.0, t))
        K.antenna_cluster(f"Spoke_{s}_Array", K.Frame(c + radial * (length * 0.04) + Z * 52.0, Z), 80.0, 20.0, 5, M, col, root, seed=900 + k, rod_scale=1.4)

    # 4. The hub: four tiers with dark bands, window rings, plates, deck greebles and turrets, a dome and the spires.
    tiers = ((336.0, -62.0, 62.0, 16.0, white, 48, 12), (276.0, 62.0, 134.0, 12.0, white, 36, 10), (216.0, 134.0, 194.0, 10.0, grey, 28, 8), (154.0, 194.0, 238.0, 8.0, white, 20, 6))
    for j, (r, z0, z1, c, mat, wins, plates) in enumerate(tiers):
        K.disc(f"Hub_Tier_{j}", O, r, z0, z1, c, mat, col, root, sides=40)
        K.disc(f"Hub_Band_{j}", O, r + 3.0, z1 - 16.0, z1 - 4.0, 2.0, dark, col, root, sides=40)
        K.disc(f"Hub_Band_Lo_{j}", O, r + 2.0, z0 + 4.0, z0 + 10.0, 1.5, dark, col, root, sides=40)
        zc = (z0 + z1) / 2.0 - 4.0
        K.window_run(f"Hub_Win_{j}", K.arc_frames(O, r, zc, 0.0, TAU, wins), 18.0, 8.0, window, col, root, proud=2.5, drop=0.1, seed=1000 + j)
        for p in range(plates):
            face = K.arc_frame(O, r, zc, TAU * (p + 0.5) / plates)
            K.plate(f"Hub_Plate_{j}_{p}", face, 0.0, 0.0, 56.0, (z1 - z0) - 36.0, dark, col, root, proud=5.0)
            K.plate(f"Hub_Plate_Win_{j}_{p}", face, 0.0, 0.0, 34.0, 8.0, window, col, root, proud=2.5, h0=5.0)
    frame = K.Frame(O, Z)
    K.tube("Hub_Dome", [K.circle(frame, 0, 0, 238.0, 100.0, 32), K.circle(frame, 0, 0, 252.0, 94.0, 32), K.circle(frame, 0, 0, 268.0, 68.0, 32), K.circle(frame, 0, 0, 278.0, 30.0, 32)], glass, col, root)
    K.disc("Hub_Dome_Ring", O, 104.0, 236.0, 246.0, 2.0, dark, col, root, sides=32)
    K.antenna_cluster("Hub_Spires", K.Frame((0.0, 0.0, 276.0), Z), 500.0, 125.0, 14, M, col, root, seed=1100, rod_scale=2.4, mast_scale=1.4)
    K.arc_greebles("Hub_Deck_0", O, 286.0, 326.0, 62.0, 0.0, TAU, 44, 24.0, 1200, M, col, root)
    K.arc_greebles("Hub_Deck_1", O, 226.0, 266.0, 134.0, 0.0, TAU, 28, 22.0, 1201, M, col, root)
    K.arc_greebles("Hub_Deck_2", O, 164.0, 206.0, 194.0, 0.0, TAU, 18, 20.0, 1202, M, col, root)
    for p in range(8):
        K.turret(f"Hub_Turret_{p}", K.arc_frame(O, 306.0, 62.0, TAU * (p + 0.5) / 8.0, normal=Z), 0.0, 0.0, 0.0, 22.0, M, col, root)

    # 5. Underside: two tiers with a window ring, the keel spire array and four vertical engine pods on struts.
    K.disc("Hub_Under_0", O, 278.0, -124.0, -62.0, 12.0, white, col, root, sides=40)
    K.disc("Hub_Under_Band", O, 281.0, -118.0, -112.0, 1.5, dark, col, root, sides=40)
    K.window_run("Hub_Under_Win", K.arc_frames(O, 278.0, -92.0, 0.0, TAU, 36), 18.0, 8.0, window, col, root, proud=2.5, drop=0.1, seed=1300)
    K.disc("Hub_Under_1", O, 204.0, -176.0, -124.0, 10.0, dark, col, root, sides=40)
    K.disc("Hub_Under_2", O, 140.0, -206.0, -176.0, 8.0, grey, col, root, sides=32)
    K.antenna_cluster("Hub_Keel", K.Frame((0.0, 0.0, -206.0), -Z), 340.0, 72.0, 9, M, col, root, seed=1400, rod_scale=2.2, mast_scale=1.3)
    for k in range(4):
        t = math.radians(45 + 90 * k)
        K.engine_pod(f"Hub_Engine_{k}", K.polar(242.0, t, -228.0), Z, 44.0, 230.0, M, col, root, seed=1500 + k)
        K.slab(f"Hub_Engine_{k}_Strut", K.polar(200.0, t, -150.0), (90.0, 50.0, 60.0), dark, col, root, chamfer=8.0, rotation=(0.0, 0.0, t))
    K.arc_greebles("Hub_Under_Deck", O, 214.0, 266.0, -124.0, 0.0, TAU, 20, 22.0, 1600, M, col, root, normal=-Z)


REQUIRED_PARTS = [
    {"name": "habitat ring", "object_names": ["Hull_White", "Hull_Dark", "Windows", "Livery"],
     "evidence": "Sixteen 170 x 190 m chamfered cars on a 760 m radius with dark couplers, two outer and one inner window line per car, dark panel plates, accent end bands, top and underside rails, four antenna arrays."},
    {"name": "junctions and spokes", "object_names": ["Hull_White", "Hull_Dark", "Hull_Grey", "Windows"],
     "evidence": "Four 290 m junction blocks with dark cores, caps, keels, window lines and 300 m radial mast arrays; four 351 m spokes of three segments with joints, side beams, window lines, accents, two dark modules and a root block each."},
    {"name": "hub", "object_names": ["Hull_White", "Hull_Grey", "Hull_Dark", "Glass", "Windows"],
     "evidence": "Four chamfered tiers (336 to 154 m radius) with dark bands, 132 windows, 36 panel plates, deck greebles, eight twin turrets, a glass dome and a 500 m spire cluster of fourteen rods."},
    {"name": "underside and engines", "object_names": ["Hull_White", "Hull_Dark", "Glow", "Livery"],
     "evidence": "Two underside tiers with a window ring, a 340 m keel spire array and four 44 m radius vertical engine pods with glow discs on dark struts."},
]

if __name__ == "__main__":
    F.run(SCRIPT_DIR, build, REQUIRED_PARTS, tile=60.0, title="AUR Ark Carrier (fleet v3 Flagship)")
