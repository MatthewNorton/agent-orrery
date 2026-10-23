"""Kitbash details for the fleet v3 hulls on top of the primitives in primitives.py (re-exported
here, so a build script needs only `import kitbash as K`): window runs, flank windows, nozzles, hull
segments, greeble fields, antenna clusters, layered engine pods, twin turrets, the cardinal points
and the per-material join. The pieces are the ones the owner's sheet is made of.
"""

import math
import random

import bpy
from mathutils import Vector

import blender_asset_toolkit as bat
from primitives import *  # noqa: F401,F403  (primitives.__all__: the hull scripts reach them as K.<name>)


# ---------- details ----------
def window_run(prefix, frames, w, h, mat, col, parent, proud=0.4, drop=0.0, seed=0, sink=None):
    rng = random.Random(seed)
    return [cbox(f"{prefix}_{i}", frame, 0.0, 0.0, 0.0, w, h, proud, mat, col, parent, chamfer=0.0, sink=sink)
            for i, frame in enumerate(frames) if not (drop and rng.random() < drop)]


def flank_windows(prefix, side, x, y0, y1, z, count, w, h, mat, col, parent, **kw):
    """A window line along Y on a flank face at `side * x`, from y0 to y1 at height z."""
    return window_run(prefix, line_frames((side * x, y0, z), (side * x, y1, z), X * side, count), w, h, mat, col, parent, **kw)


def nozzle(prefix, origin, direction, r, depth, M, col, parent, sides=16, glow=0.85):
    """A grey ring drum pointing along `direction` with a glow disc just beyond its mouth."""
    frame = Frame(origin, direction)
    return [drum(f"{prefix}_Nozzle", frame, 0.0, 0.0, 0.0, r, depth, M["grey"], col, parent, sides=sides),
            drum(f"{prefix}_Glow", frame, 0.0, 0.0, depth, r * glow, 0.4, M["glow"], col, parent, sides=sides)]


def segments(prefix, segs, widths, height, zc, chamfer, M, col, parent, joint_inset=6.0):
    """Chamfered hull segments along Y (bow first, each (y_hi, y_lo)) with dark joints filling the gaps."""
    out = []
    for i, (hi, lo) in enumerate(segs):
        out.append(slab(f"{prefix}_{i}", (0.0, (hi + lo) / 2.0, zc), (widths[i], hi - lo, height), M["white"], col, parent, chamfer=chamfer))
        if i + 1 < len(segs):
            next_hi = segs[i + 1][0]
            out.append(slab(f"{prefix}_Joint_{i}", (0.0, (lo + next_hi) / 2.0, zc), (min(widths[i], widths[i + 1]) - joint_inset, (lo - next_hi) + 4.0, height - joint_inset),
                            M["dark"], col, parent, chamfer=chamfer * 0.5))
    return out


def cardinals():
    """The four cardinal points E, N, W, S: (index, letter, angle, radial, tangent)."""
    for k, s in enumerate("ENWS"):
        t = math.radians(90 * k)
        yield k, s, t, radial(t), tangent(t)


KINDS = (("block", 0.36), ("plate", 0.18), ("drum", 0.14), ("rod", 0.1), ("vent", 0.14), ("twin", 0.08))


def greeble(prefix, frame, a, b, unit, rng, M, col, parent):
    """One detail at (a, b): a block, a plate, a drum, a rod, a vent slot or a twin block."""
    roll, kind = rng.random(), KINDS[-1][0]
    for name, weight in KINDS:
        roll -= weight
        if roll <= 0:
            kind = name
            break
    dark = M["dark"] if rng.random() < 0.8 else M["grey"]
    if kind == "block":
        sa, sb, sh = unit * rng.uniform(0.45, 0.95), unit * rng.uniform(0.45, 0.95), unit * rng.uniform(0.18, 0.5)
        return [cbox(prefix, frame, a, b, 0.0, sa, sb, sh, dark, col, parent, chamfer=0.12 * min(sa, sb, sh))]
    if kind == "plate":
        light = M["white"] if rng.random() < 0.5 else M["grey"]
        return [cbox(prefix, frame, a, b, 0.0, unit * rng.uniform(0.6, 1.1), unit * rng.uniform(0.6, 1.1), unit * 0.08, light, col, parent, chamfer=0.0)]
    if kind == "drum":
        return [drum(prefix, frame, a, b, 0.0, unit * rng.uniform(0.15, 0.3), unit * rng.uniform(0.2, 0.5), dark, col, parent, sides=10)]
    if kind == "rod":
        return [drum(prefix, frame, a, b, 0.0, unit * 0.035, unit * rng.uniform(0.9, 1.8), M["dark"], col, parent, sides=6)]
    if kind == "vent":
        sa, sb = (unit * 0.9, unit * 0.16) if rng.random() < 0.5 else (unit * 0.16, unit * 0.9)
        return [cbox(prefix, frame, a, b, 0.0, sa, sb, unit * 0.12, M["dark"], col, parent, chamfer=0.0)]
    s, off = unit * 0.32, unit * 0.22
    return [cbox(prefix + "a", frame, a - off, b, 0.0, s, s, unit * 0.3, dark, col, parent, chamfer=0.05 * s),
            cbox(prefix + "b", frame, a + off, b, 0.0, s, s, unit * 0.3, dark, col, parent, chamfer=0.05 * s)]


def _scatter(prefix, rng, na, nb, count, place, size, M, col, parent):
    """About `count` greebles over an na x nb jittered grid; `place(fi, fj)` maps grid fractions to (frame, a, b)."""
    p, out = min(1.0, count / float(na * nb)), []
    for i in range(na):
        for j in range(nb):
            if rng.random() > p:
                continue
            frame, a, b = place((i + 0.5 + rng.uniform(-0.25, 0.25)) / na, (j + 0.5 + rng.uniform(-0.25, 0.25)) / nb)
            out += greeble(f"{prefix}_{len(out)}", frame, a, b, size, rng, M, col, parent)
    return out


def greebles(prefix, frame, ea, eb, count, unit, seed, M, col, parent):
    """About `count` details scattered over an ea x eb patch of the frame."""
    na, nb = max(1, int(round(ea / unit))), max(1, int(round(eb / unit)))
    return _scatter(prefix, random.Random(seed), na, nb, count, lambda fi, fj: (frame, -ea / 2.0 + fi * ea, -eb / 2.0 + fj * eb),
                    min(unit, ea / na, eb / nb), M, col, parent)


def arc_greebles(prefix, center, r0, r1, z, a0, a1, count, unit, seed, M, col, parent, normal=Z):
    """Details on an annulus (or a car top) between radii r0..r1 and angles a0..a1 at height z."""
    rm = (r0 + r1) / 2.0
    nt, nr = max(1, int(round((a1 - a0) * rm / unit))), max(1, int(round((r1 - r0) / unit)))
    return _scatter(prefix, random.Random(seed), nt, nr, count,
                    lambda fi, fj: (arc_frame(center, r0 + (r1 - r0) * fj, z, a0 + (a1 - a0) * fi, normal=normal), 0.0, 0.0),
                    min(unit, (a1 - a0) * rm / nt, (r1 - r0) / nr), M, col, parent)


def antenna_cluster(prefix, frame, height, spread, rods, M, col, parent, seed=0, rod_scale=1.0, mast_scale=1.0):
    """A stepped main mast with collars, cross arms and a tip, ringed by thinner rods and a dish."""
    rng, dark, H, ms = random.Random(seed), M["dark"], height, mast_scale
    out = [drum(f"{prefix}_Mast_1", frame, 0, 0, 0.0, 0.05 * H * ms, 0.42 * H, dark, col, parent, sides=8),
           drum(f"{prefix}_Mast_2", frame, 0, 0, 0.42 * H, 0.034 * H * ms, 0.33 * H, dark, col, parent, sides=8),
           drum(f"{prefix}_Mast_3", frame, 0, 0, 0.75 * H, 0.02 * H * ms, 0.25 * H, dark, col, parent, sides=8),
           spike(f"{prefix}_Tip", frame, 0, 0, H, 0.02 * H * ms, 0.12 * H, dark, col, parent),
           drum(f"{prefix}_Collar_1", frame, 0, 0, 0.40 * H, 0.085 * H * ms, 0.035 * H, M["grey"], col, parent, sides=8),
           drum(f"{prefix}_Collar_2", frame, 0, 0, 0.73 * H, 0.06 * H * ms, 0.03 * H, M["grey"], col, parent, sides=8),
           cbox(f"{prefix}_Arm_1", frame, 0, 0, 0.30 * H, 0.34 * H, 0.03 * H, 0.03 * H, dark, col, parent, chamfer=0.0),
           cbox(f"{prefix}_Arm_2", frame, 0, 0, 0.58 * H, 0.03 * H, 0.26 * H, 0.03 * H, dark, col, parent, chamfer=0.0)]
    for i in range(rods):
        angle, distance = rng.uniform(0.0, TAU), spread * rng.uniform(0.35, 1.0)
        a, b = distance * math.cos(angle), distance * math.sin(angle)
        h, r = H * rng.uniform(0.3, 0.8), H * rng.uniform(0.008, 0.016) * rod_scale
        out.append(drum(f"{prefix}_Rod_{i}", frame, a, b, 0.0, r, h, dark, col, parent, sides=6))
        out.append(drum(f"{prefix}_Rod_{i}_Cap", frame, a, b, h, r * 2.2, 0.02 * H, dark, col, parent, sides=6))
        if i % 3 == 0:
            out.append(spike(f"{prefix}_Rod_{i}_Tip", frame, a, b, h + 0.02 * H, r, 0.1 * H, dark, col, parent))
        elif i % 3 == 1:
            out.append(tube(f"{prefix}_Rod_{i}_Dish", [circle(frame, a, b, h + 0.02 * H, 0.012 * H, 10), circle(frame, a, b, h + 0.05 * H, 0.07 * H, 10)], dark, col, parent))
    return out


def engine_pod(prefix, origin, forward, radius, length, M, col, parent, seed=0, sides=16, fins=True, windows=True):
    """A layered nacelle: white body, dark intake, bands, aft shroud, nozzle and glow disc, fins, pipes, a stripe."""
    frame, r, L = Frame(origin, Vector(forward)), radius, length
    rng = random.Random(seed)
    sec = lambda h, rr: circle(frame, 0, 0, h, rr, sides)
    out = [tube(f"{prefix}_Body", [sec(-0.40 * L, 0.96 * r), sec(-0.36 * L, r), sec(0.34 * L, r), sec(0.42 * L, 0.9 * r), sec(0.47 * L, 0.72 * r)], M["white"], col, parent),
           tube(f"{prefix}_Intake", [sec(0.44 * L, 0.74 * r), sec(0.5 * L, 0.68 * r), sec(0.52 * L, 0.5 * r)], M["dark"], col, parent),
           tube(f"{prefix}_Shroud", [sec(-0.36 * L, 0.98 * r), sec(-0.40 * L, 1.07 * r), sec(-0.52 * L, 1.07 * r), sec(-0.55 * L, 0.96 * r)], M["dark"], col, parent),
           tube(f"{prefix}_Nozzle", [sec(-0.54 * L, 0.9 * r), sec(-0.62 * L, 0.78 * r)], M["dark"], col, parent),
           tube(f"{prefix}_Glow", [sec(-0.60 * L, 0.7 * r), sec(-0.615 * L, 0.7 * r)], M["glow"], col, parent)]
    for i, h in enumerate((-0.12 * L, 0.14 * L)):
        out.append(tube(f"{prefix}_Band_{i}", [sec(h - 0.02 * L, 1.03 * r), sec(h + 0.02 * L, 1.03 * r)], M["dark"], col, parent))
    if fins:
        for i in range(4):
            fr = frame.around(math.radians(45 + 90 * i), 0.95 * r)
            out.append(cbox(f"{prefix}_Fin_{i}", fr, 0.0, -0.05 * L, 0.0, 0.05 * r, 0.42 * L, 0.3 * r, M["dark"], col, parent, chamfer=0.01 * r))
    for i, angle in enumerate((math.radians(70), math.radians(110))):
        fr = frame.around(angle, 1.02 * r)
        out.append(drum(f"{prefix}_Pipe_{i}", Frame(fr.o, frame.n), 0.0, 0.0, -0.3 * L, 0.07 * r, 0.62 * L, M["dark"], col, parent, sides=8, sink=0.0))
    out.append(cbox(f"{prefix}_Stripe", frame.around(math.radians(90), r), 0.0, 0.02 * L, 0.0, 0.12 * r, 0.5 * L, 0.03 * r, M["accent"], col, parent, chamfer=0.0))
    for i in range(3):
        fr = frame.around(rng.uniform(0.0, TAU), r)
        out.append(cbox(f"{prefix}_Panel_{i}", fr, 0.0, rng.uniform(-0.25, 0.2) * L, 0.0, 0.5 * r, 0.16 * L, 0.03 * r, M["dark"], col, parent, chamfer=0.0))
    if windows:
        for i, angle in enumerate((0.0, math.pi)):
            fr = frame.around(angle, r)
            frames = [Frame(fr.at(0.0, -0.28 * L + 0.48 * L * (k + 0.5) / 6, 0.0), fr.n, up=frame.n) for k in range(6)]
            out += window_run(f"{prefix}_Win_{i}", frames, 0.12 * r, 0.05 * L, M["window"], col, parent, proud=0.03 * r, drop=0.15, seed=seed + i)
    return out


def turret(prefix, frame, a, b, h0, size, M, col, parent):
    """A twin-barrel turret: chamfered base, ring, head and two barrels along the frame's b axis."""
    s, dark = size, M["dark"]
    out = [cbox(f"{prefix}_Base", frame, a, b, h0, 1.1 * s, 1.1 * s, 0.3 * s, dark, col, parent, chamfer=0.1 * s),
           drum(f"{prefix}_Ring", frame, a, b, h0 + 0.3 * s, 0.42 * s, 0.25 * s, M["grey"], col, parent, sides=12),
           cbox(f"{prefix}_Head", frame, a, b, h0 + 0.55 * s, 0.8 * s, 0.9 * s, 0.4 * s, dark, col, parent, chamfer=0.08 * s)]
    for i, off in enumerate((-0.16 * s, 0.16 * s)):
        out.append(rod(f"{prefix}_Barrel_{i}", frame.at(a + off, b + 0.3 * s, h0 + 0.75 * s), frame.at(a + off, b + 1.5 * s, h0 + 0.75 * s), 0.06 * s, dark, col, parent, sides=8))
    return out


# ---------- join ----------
def join_by_material(col, root, names):
    """Apply modifiers, then join every mesh in `col` into one object per material under `root`,
    named by `names` (material name -> object name)."""
    objects = [obj for obj in col.objects if obj.type == "MESH"]
    bat.select_only(objects, objects[0])
    bpy.ops.object.convert(target="MESH")
    groups = {}
    for obj in objects:
        name = obj.data.materials[0].name if obj.data.materials else "none"
        groups.setdefault(name, []).append(obj)
    joined = []
    for name, members in groups.items():
        target = bpy.data.objects.new(names.get(name, name), bpy.data.meshes.new(names.get(name, name) + "_Mesh"))
        col.objects.link(target)
        bat.select_only(members + [target], target)
        bpy.ops.object.join()
        bat.parent_local(target, root)
        joined.append(target)
    return joined
