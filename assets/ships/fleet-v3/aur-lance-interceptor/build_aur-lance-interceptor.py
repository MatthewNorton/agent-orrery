"""AUR Lance Interceptor (fleet v3 Scout): the owner's single-seat delta interceptor, kitbashed the
way the sheet draws it: a dart fuselage with a nose spike and pitots, dark cheek strakes with
accent chevrons and window dashes, a long dark canopy, a greebled spine with panel plates ending
in a sensor block and mast, delta wings with dark leading and trailing edges, panel plates,
greebles, accent stripes and swept outer spars ending in T skids, twin canted fins with dark
edges, stripes and caps, dark intake blocks with blue light bars ahead of two layered engine
pods, a keel, a ventral fin and sensor pods. Original geometry; see ../_shared/fleet_v3.py and
../_shared/kitbash.py. About 14.4 m long, 12.8 m across the skids, 3.3 m tall.
"""

import math
import os
import sys

sys.dont_write_bytecode = True
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "_shared"))

from mathutils import Vector  # noqa: E402

import fleet_v3 as F  # noqa: E402
import kitbash as K  # noqa: E402

Y, Z = K.Y, K.Z
STATIONS = [
    (7.2, 0.05, 0.05, 0.0), (6.2, 0.55, 0.38, 0.02), (4.8, 1.25, 0.78, 0.05),
    (3.2, 2.15, 1.2, 0.1), (1.6, 2.85, 1.48, 0.12), (0.0, 3.1, 1.55, 0.12),
    (-1.6, 2.9, 1.45, 0.1), (-3.4, 2.5, 1.3, 0.05), (-5.0, 2.05, 1.1, 0.0), (-5.6, 1.7, 0.9, 0.0),
]
ANHEDRAL = 0.52 / 4.3


def station(y):
    """The fuselage section (width, height, center z) at y, interpolated between stations."""
    for (y1, w1, h1, z1), (y0, w0, h0, z0) in zip(STATIONS, STATIONS[1:]):
        if y0 <= y <= y1:
            t = (y1 - y) / (y1 - y0)
            return w1 + (w0 - w1) * t, h1 + (h0 - h1) * t, z1 + (z0 - z1) * t
    return STATIONS[-1][1:]


def cheek(side, y):
    """A frame on the fuselage's vertical side face at y, facing outward and forward with the taper."""
    w, _, zc = station(y)
    slope = (station(y + 0.4)[0] - station(y - 0.4)[0]) / 1.6
    return K.Frame((side * w / 2.0, y, zc), (side, -slope, 0.0), up=Z)


def wing_z(x):
    return 0.1 - ANHEDRAL * (abs(x) - 1.1)


def wing_top(side, x, y):
    return K.Frame((side * x, y, wing_z(x)), (side * ANHEDRAL, 0.0, 1.0), up=Y)


def spine_top(y):
    return K.Frame((0.0, y, 0.96 - 0.05 * (0.4 - y)), (0.0, -0.05, 1.0), up=Y)


def shifted(points, normal, k):
    return [(x + normal[0] * k, y, z + normal[2] * k) for x, y, z in points]


def build(col, root, M):
    white, dark, grey, accent, glass, window = M["white"], M["dark"], M["grey"], M["accent"], M["glass"], M["window"]

    # 1. Fuselage dart with a nose spike and pitots, belly plate, canopy, cheek strakes, chevrons and windows.
    K.loft("Fuselage", [(y, K.ring(w, h, zc)) for y, w, h, zc in STATIONS], white, col, root, bevel=0.03)
    K.spike("Nose_Spike", K.Frame((0.0, 7.1, 0.0), Y), 0.0, 0.0, 0.0, 0.06, 0.9, dark, col, root)
    K.prism3d("Nose_Belly", [(0.0, 6.3, -0.15), (0.45, 4.6, -0.37), (0.5, 3.0, -0.52), (-0.5, 3.0, -0.52), (-0.45, 4.6, -0.37)],
              (0, 0, -0.04), dark, col, root)
    canopy_plan = [(0.0, 4.4), (0.42, 3.6), (0.42, 1.0), (0.0, 0.4), (-0.42, 1.0), (-0.42, 3.6)]
    K.prism3d("Canopy_Frame", [(x, y, 0.5) for x, y in canopy_plan], (0, 0, 0.12), dark, col, root, bevel=0.02)
    K.prism3d("Canopy_Glass", [(x * 0.86, y, 0.6) for x, y in canopy_plan], (0, 0, 0.42), glass, col, root, bevel=0.05)
    for side in (1, -1):
        K.rod(f"Pitot_{side}", (0.22 * side, 5.6, 0.1), (0.3 * side, 6.6, 0.14), 0.018, dark, col, root)
        for j, y in enumerate((5.2, 4.3, 3.4, 2.5, 1.6)):
            K.plate(f"Cheek_{side}_{j}", cheek(side, y), 0.0, -0.02, 0.7, 0.16 + 0.04 * j, dark, col, root, proud=0.04)
        K.plate(f"Chevron_{side}_1", cheek(side, 5.9), 0.0, 0.0, 0.5, 0.05, accent, col, root, proud=0.035)
        K.plate(f"Chevron_{side}_2", cheek(side, 2.0), 0.0, 0.12, 0.6, 0.05, accent, col, root, proud=0.035)
        K.window_run(f"Flank_Win_{side}", [cheek(side, y) for y in (0.9, 0.5, 0.1, -0.3)], 0.18, 0.08, window, col, root, proud=0.035)

    # 2. Spine: greebles behind the canopy, two dark panels with window dashes, the tail sensor block and mast.
    K.prism3d("Dorsal_Spine", [(-0.32, 0.4, 0.78), (0.32, 0.4, 0.78), (0.28, -5.2, 0.5), (-0.28, -5.2, 0.5)], (0, 0, 0.18), white, col, root, bevel=0.02)
    K.greebles("Spine_Greebles", spine_top(-1.2), 0.5, 2.0, 7, 0.3, 3, M, col, root)
    for j, y in enumerate((-3.0, -4.2)):
        K.plate(f"Spine_Panel_{j}", spine_top(y), 0.0, 0.0, 0.42, 0.7, dark, col, root, proud=0.04)
        K.plate(f"Spine_Panel_Win_{j}", spine_top(y), 0.0, 0.0, 0.16, 0.4, window, col, root, proud=0.03, h0=0.04)
    K.cbox("Tail_Block", spine_top(-5.0), 0.0, 0.0, 0.0, 0.5, 0.7, 0.3, dark, col, root, chamfer=0.05)
    K.antenna_cluster("Tail_Mast", K.Frame((0.0, -5.0, 0.98), Z), 0.8, 0.18, 3, M, col, root, seed=4, rod_scale=1.5, mast_scale=1.2)

    # 3. Wings: delta plates with dark leading and trailing edges, an accent stripe, panel plates, greebles,
    #    a tip accent, and the swept outer spar with its brace and T skid.
    for side in (1, -1):
        name = f"Wing_{side}"
        K.prism3d(name, K.sided([(1.1, 2.4, 0.1), (5.4, -3.2, -0.42), (5.4, -3.95, -0.42), (1.1, -4.3, 0.1)], side), (0, 0, -0.22), white, col, root, bevel=0.03)
        K.prism3d(name + "_Edge", K.sided([(1.15, 2.3, 0.1), (5.35, -3.18, -0.41), (5.35, -3.34, -0.41), (1.15, 2.08, 0.1)], side), (0, 0, 0.03), dark, col, root)
        K.prism3d(name + "_Trail", K.sided([(1.3, -4.1, wing_z(1.3) + 0.002), (5.3, -3.78, wing_z(5.3) + 0.002), (5.3, -3.92, wing_z(5.3) + 0.002), (1.3, -4.28, wing_z(1.3) + 0.002)], side), (0, 0, 0.03), dark, col, root)
        K.prism3d(name + "_Stripe", K.sided([(1.45, 1.95, 0.1), (5.05, -2.75, -0.335), (5.05, -3.02, -0.335), (1.45, 1.58, 0.1)], side), (0, 0, 0.035), accent, col, root)
        for j, (x, y, sa, sb, mat) in enumerate(((2.2, -1.8, 0.9, 1.1, dark), (3.4, -2.9, 0.8, 0.7, grey), (4.4, -3.4, 0.5, 0.4, dark), (1.9, -3.3, 0.5, 0.6, grey))):
            K.plate(f"{name}_Panel_{j}", wing_top(side, x, y), 0.0, 0.0, sa, sb, mat, col, root, proud=0.035)
        K.plate(f"{name}_Panel_Win", wing_top(side, 2.2, -1.8), 0.0, 0.0, 0.14, 0.5, window, col, root, proud=0.03, h0=0.035)
        K.greebles(f"{name}_Greebles", wing_top(side, 2.9, -2.2), 1.4, 1.6, 6, 0.3, 20 + side, M, col, root)
        K.plate(f"{name}_Tip_Accent", wing_top(side, 4.9, -3.55), 0.0, 0.0, 0.7, 0.07, accent, col, root, proud=0.035)
        tip = Vector((5.35 * side, -3.6, wing_z(5.35) - 0.1))
        end = Vector((6.4 * side, -6.0, wing_z(5.35) + 0.4))
        K.rod(f"{name}_Spar", tip, end, 0.07, dark, col, root, sides=8)
        K.rod(f"{name}_Spar_Brace", Vector((5.1 * side, -3.9, wing_z(5.1) - 0.2)), (end + tip) / 2.0, 0.04, dark, col, root, sides=6)
        K.cbox(f"{name}_Skid", K.Frame(end, Z), 0.0, 0.0, -0.08, 0.7, 0.16, 0.16, dark, col, root, chamfer=0.02)
        K.cbox(f"{name}_Skid_Post", K.Frame(end, Z), 0.0, 0.0, 0.0, 0.14, 0.14, 0.3, dark, col, root, chamfer=0.02)

    # 4. Twin fins on the wing roots: canted 25 degrees outward, swept, with a dark leading edge, an accent
    #    stripe, a dark cap and a dark base.
    cant = math.radians(25.0)
    for side in (1, -1):
        bx = 2.45

        def fp(y, h):
            return (bx + h * math.sin(cant), y, wing_z(bx) + h * math.cos(cant))

        normal = (side * math.cos(cant) * 0.12, 0.0, -math.sin(cant) * 0.12)

        def layer(name, pts, mat, sink=-0.15, scale=1.3, side=side, normal=normal, **kw):
            """A plate on the fin's face, sunk a little into it and proud of it by `scale`."""
            K.prism3d(name, shifted(K.sided(pts, side), normal, sink), (normal[0] * scale, 0.0, normal[2] * scale), mat, col, root, **kw)

        K.prism3d(f"Fin_{side}", K.sided([fp(-1.5, 0.0), fp(-3.6, 2.3), fp(-4.5, 2.3), fp(-4.4, 0.0)], side), normal, white, col, root, bevel=0.02)
        layer(f"Fin_{side}_Edge", [fp(-1.55, 0.05), fp(-3.6, 2.25), fp(-3.8, 2.25), fp(-1.9, 0.05)], dark)
        layer(f"Fin_{side}_Stripe", [fp(-2.4, 0.9), fp(-3.9, 2.0), fp(-4.1, 2.0), fp(-2.7, 0.9)], accent)
        layer(f"Fin_{side}_Cap", [fp(-3.6, 2.3), fp(-3.75, 2.75), fp(-4.4, 2.75), fp(-4.5, 2.3)], dark, bevel=0.015)
        layer(f"Fin_{side}_Base", [fp(-1.3, -0.05), fp(-1.3, 0.25), fp(-4.6, 0.25), fp(-4.6, -0.05)], dark, sink=-0.3, scale=1.6)

    # 5. Engines: dark intake blocks with grey lips, blue light bars and accents, layered pods behind them on pylons.
    for side in (1, -1):
        x = 1.75 * side
        K.slab(f"Pylon_{side}", (1.15 * side, -3.2, 0.1), (0.9, 2.4, 0.5), dark, col, root, chamfer=0.06)
        K.engine_pod(f"Engine_{side}", (x, -3.7, 0.2), Y, 0.6, 4.4, M, col, root, seed=30 + side, fins=False, windows=False)
        K.slab(f"Intake_{side}", (x, -1.05, 0.2), (1.3, 0.9, 1.25), dark, col, root, chamfer=0.18)
        K.slab(f"Intake_{side}_Lip", (x, -0.65, 0.2), (1.1, 0.14, 1.05), grey, col, root, chamfer=0.1)
        K.window_run(f"Intake_Win_{side}", K.line_frames((x - 0.32, -0.57, 0.2), (x + 0.32, -0.57, 0.2), Y, 4), 0.1, 0.5, window, col, root, proud=0.04)
        K.plate(f"Intake_Accent_{side}", K.flank(side, 2.4, -1.05, 0.2), 0.0, 0.0, 0.5, 0.06, accent, col, root, proud=0.03)

    # 6. Underside: keel, ventral fin, sensor pods and belly plates.
    K.slab("Keel", (0.0, -2.8, -0.82), (0.34, 2.6, 0.4), dark, col, root, chamfer=0.05)
    K.prism3d("Ventral_Fin", [(0.0, -2.4, -0.7), (0.0, -5.0, -1.45), (0.0, -5.5, -0.7)], (0.12, 0, 0), white, col, root, bevel=0.015)
    for side in (1, -1):
        K.slab(f"Sensor_Pod_{side}", (0.5 * side, 4.0, -0.34), (0.3, 0.9, 0.2), dark, col, root, chamfer=0.04)
        K.plate(f"Belly_Plate_{side}", K.Frame((0.55 * side, 0.5, -0.655), -Z), 0.0, 0.0, 0.5, 1.4, dark, col, root, proud=0.04)


REQUIRED_PARTS = [
    {"name": "fuselage dart", "object_names": ["Hull_White", "Hull_Dark", "Glass", "Livery", "Windows"],
     "evidence": "Ten-station loft from a 5 cm tip to a 3.1 m wide, 1.55 m tall body with a 0.9 m nose spike and pitots; canopy on the spine at 25-45% of length; five dark cheek strakes, two accent chevrons and four window dashes a side; a dark belly plate."},
    {"name": "spine and tail", "object_names": ["Hull_White", "Hull_Dark", "Hull_Grey", "Windows"],
     "evidence": "Dorsal spine with seven greebles behind the canopy, two dark panels with window dashes, a dark tail block under a 0.8 m three-rod mast."},
    {"name": "delta wings and fins", "object_names": ["Hull_White", "Hull_Dark", "Hull_Grey", "Livery"],
     "evidence": "Swept wings with 7 degree anhedral, dark leading and trailing edges, accent stripe, four panel plates, six greebles and a tip accent each; outer spars with braces to T skids; 2.3 m fins canted 25 degrees with dark edges, stripes, caps and bases."},
    {"name": "twin engines", "object_names": ["Hull_White", "Hull_Dark", "Hull_Grey", "Glow", "Windows", "Livery"],
     "evidence": "Two 0.6 m radius layered pods at x=+-1.75 on dark pylons behind 1.3 x 1.25 m dark intake blocks with grey lips, four blue light bars and an accent each."},
]

if __name__ == "__main__":
    F.run(SCRIPT_DIR, build, REQUIRED_PARTS, tile=2.4, title="AUR Lance Interceptor (fleet v3 Scout)")
