"""Kitbash primitives for the fleet v3 hulls (conventions in fleet_v3.py: meters, forward +Y, up +Z,
X starboard). Every helper builds a closed pydata mesh in world space on an object with an identity
transform, so a hull can be joined per material at the end of its build without losing anything.
kitbash.py re-exports these and adds the composite details (window runs, greebles, pods, turrets).
"""

import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

import blender_asset_toolkit as bat

__all__ = [
    "TAU", "X", "Y", "Z", "O", "polar", "radial", "tangent", "Frame", "flank", "top", "mesh_object", "prism3d", "loft",
    "ring", "sided", "box_mesh", "chamfered_box_mesh", "cbox", "plate", "capped_box", "slab", "tube", "circle",
    "octagon", "drum", "spike", "rod", "disc", "arc_car", "line_frames", "arc_frames", "arc_frame",
]

TAU = math.tau
X, Y, Z = Vector((1.0, 0.0, 0.0)), Vector((0.0, 1.0, 0.0)), Vector((0.0, 0.0, 1.0))
O = (0.0, 0.0, 0.0)


def polar(r, t, z=0.0):
    """The point at radius r and angle t in the XY plane, at height z."""
    return Vector((r * math.cos(t), r * math.sin(t), z))


def radial(t):
    return Vector((math.cos(t), math.sin(t), 0.0))


def tangent(t):
    return Vector((-math.sin(t), math.cos(t), 0.0))


class Frame:
    """A surface frame: origin on the surface, `n` outward, `u`/`v` tangent; points are (a, b, h)."""

    __slots__ = ("o", "u", "v", "n")

    def __init__(self, origin, normal, up=None):
        n = Vector(normal).normalized()
        ref = Vector(up).normalized() if up is not None else (Z if abs(n.z) < 0.9 else Y)
        u = ref.cross(n)
        if u.length < 1e-6:
            ref = X if abs(n.x) < 0.9 else Y
            u = ref.cross(n)
        self.o, self.u, self.n = Vector(origin), u.normalized(), n
        self.v = n.cross(self.u).normalized()

    def at(self, a, b, h):
        return self.o + self.u * a + self.v * b + self.n * h

    def matrix(self):
        u, v, n, o = self.u, self.v, self.n, self.o
        return Matrix(((u.x, v.x, n.x, o.x), (u.y, v.y, n.y, o.y), (u.z, v.z, n.z, o.z), (0.0, 0.0, 0.0, 1.0)))

    def around(self, angle, distance):
        """A frame on the cylinder around this normal: `distance` out at `angle`, facing outward, b along the axis."""
        direction = self.u * math.cos(angle) + self.v * math.sin(angle)
        return Frame(self.o + direction * distance, direction, up=self.n)


def flank(side, x, y, z):
    """A frame on a flank face at `side * x`, facing outward: a runs along Y, b up."""
    return Frame((side * x, y, z), X * side)


def top(z):
    """A frame on a deck at height z on the centerline, facing up: a runs along X, b along Y."""
    return Frame((0.0, 0.0, z), Z)


# ---------- meshes ----------
def mesh_object(name, verts, faces, mat, col, parent, matrix=None, bevel=0.0):
    if matrix is not None:
        verts = [matrix @ Vector(v) for v in verts]
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    col.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    if bevel:
        bat.add_bevel(obj, bevel, segments=2)
    if parent:
        bat.parent_local(obj, parent)
    return obj


def prism3d(name, points, offset, mat, col, parent, bevel=0.0):
    """A planar polygon (3D points) extruded by `offset`."""
    off = Vector(offset)
    base = [Vector(p) for p in points]
    verts = [tuple(p) for p in base] + [tuple(p + off) for p in base]
    n = len(base)
    faces = [tuple(range(n)), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return mesh_object(name, verts, faces, mat, col, parent, bevel=bevel)


def loft(name, sections, mat, col, parent, bevel=0.0):
    """Sections of (y, [(x, z), ...]) rings of equal count along Y, as a capped tube."""
    return tube(name, [[(x, y, z) for x, z in points] for y, points in sections], mat, col, parent, bevel=bevel)


def ring(width, height, zc, c=0.5):
    """A chamfered-box cross-section in XZ whose chamfer takes fraction `c` of each half extent."""
    a, b = width / 2.0, height / 2.0
    return [
        (a, zc + b * c), (a * c, zc + b), (-a * c, zc + b), (-a, zc + b * c),
        (-a, zc - b * c), (-a * c, zc - b), (a * c, zc - b), (a, zc - b * c),
    ]


def sided(points, side):
    """Mirror a starboard polygon to port, keeping its winding."""
    return list(reversed([(-x, y, z) for x, y, z in points])) if side < 0 else points


def box_mesh(hx, hy, hz):
    verts = [(sx * hx, sy * hy, sz * hz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return verts, faces


def chamfered_box_mesh(hx, hy, hz, c):
    """A box with every edge chamfered by `c` (a plain box when c is 0): 6 face rectangles, 12 edge
    rectangles, 8 corner triangles."""
    if c <= 0:
        return box_mesh(hx, hy, hz)
    half = (hx, hy, hz)
    c = min(c, 0.9 * min(half))
    verts, index, faces = [], {}, []

    def key(axis, s, signs):
        o1, o2 = [i for i in range(3) if i != axis]
        return (axis, s, signs[o1], signs[o2])

    for axis in range(3):
        o1, o2 = [i for i in range(3) if i != axis]
        for s in (-1, 1):
            ids = []
            for s1, s2 in ((-1, -1), (-1, 1), (1, 1), (1, -1)):
                co = [0.0, 0.0, 0.0]
                co[axis], co[o1], co[o2] = s * half[axis], s1 * (half[o1] - c), s2 * (half[o2] - c)
                index[(axis, s, s1, s2)] = len(verts)
                verts.append(tuple(co))
                ids.append(index[(axis, s, s1, s2)])
            faces.append(tuple(ids))
    for a in range(3):
        for b in range(a + 1, 3):
            t = 3 - a - b
            for sa in (-1, 1):
                for sb in (-1, 1):
                    fa = [index[key(a, sa, {b: sb, t: st, a: sa})] for st in (-1, 1)]
                    fb = [index[key(b, sb, {a: sa, t: st, b: sb})] for st in (1, -1)]
                    faces.append(tuple(fa + fb))
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                signs = {0: sx, 1: sy, 2: sz}
                faces.append(tuple(index[key(axis, signs[axis], signs)] for axis in range(3)))
    return verts, faces


def cbox(name, frame, a, b, h0, sa, sb, sh, mat, col, parent, chamfer, sink=None):
    """A (chamfered) block standing on the frame at (a, b), from h0 up by sh; its base is buried by `sink`."""
    sink = 0.08 * sh if sink is None else sink
    hz = (sh + sink) / 2.0
    verts, faces = chamfered_box_mesh(sa / 2.0, sb / 2.0, hz, min(chamfer, 0.45 * min(sa, sb, 2 * hz)))
    return mesh_object(name, verts, faces, mat, col, parent, matrix=frame.matrix() @ Matrix.Translation((a, b, h0 - sink + hz)))


def plate(name, frame, a, b, sa, sb, mat, col, parent, proud=0.3, h0=0.0):
    return cbox(name, frame, a, b, h0, sa, sb, proud, mat, col, parent, chamfer=0.0)


def capped_box(prefix, frame, a, b, sa, sb, sh, M, col, parent, chamfer, cap_height=0.2):
    """A dark block with a smaller grey cap on top: the sheet's module shape."""
    return [cbox(prefix, frame, a, b, 0.0, sa, sb, sh, M["dark"], col, parent, chamfer=chamfer),
            cbox(prefix + "_Cap", frame, a, b, sh, sa * 0.65, sb * 0.65, sh * cap_height, M["grey"], col, parent, chamfer=chamfer * 0.25)]


def slab(name, center, dims, mat, col, parent, chamfer, rotation=(0.0, 0.0, 0.0)):
    """A world-space chamfered box; `rotation` is an XYZ Euler, so (0, 0, t) turns local X to the radial at t."""
    verts, faces = chamfered_box_mesh(dims[0] / 2.0, dims[1] / 2.0, dims[2] / 2.0, chamfer)
    return mesh_object(name, verts, faces, mat, col, parent, matrix=Matrix.Translation(center) @ Euler(rotation).to_matrix().to_4x4())


def tube(name, sections, mat, col, parent, closed=False, bevel=0.0):
    """Rings of equal vertex count joined by quads; capped unless `closed` joins the last ring to the first."""
    n = len(sections[0])
    verts = [tuple(p) for section in sections for p in section]
    faces = []
    count = len(sections)
    for s in range(count if closed else count - 1):
        a, b = s * n, ((s + 1) % count) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((a + i, a + j, b + j, b + i))
    if not closed:
        faces.append(tuple(range(n)))
        faces.append(tuple(range((count - 1) * n, count * n)))
    return mesh_object(name, verts, faces, mat, col, parent, bevel=bevel)


def circle(frame, a, b, h, r, sides):
    return [frame.at(a + r * math.cos(TAU * i / sides), b + r * math.sin(TAU * i / sides), h) for i in range(sides)]


def octagon(frame, w, h, c, height=0.0):
    a, b = w / 2.0, h / 2.0
    return [frame.at(x, y, height) for x, y in ((a, -b + c), (a, b - c), (a - c, b), (-a + c, b), (-a, b - c), (-a, -b + c), (-a + c, -b), (a - c, -b))]


def drum(name, frame, a, b, h0, r, h, mat, col, parent, sides=12, sink=None):
    sink = 0.06 * h if sink is None else sink
    return tube(name, [circle(frame, a, b, h0 - sink, r, sides), circle(frame, a, b, h0 + h, r, sides)], mat, col, parent)


def spike(name, frame, a, b, h0, r, length, mat, col, parent, sides=6):
    return tube(name, [circle(frame, a, b, h0, r, sides), circle(frame, a, b, h0 + length, r * 0.04, sides)], mat, col, parent)


def rod(name, p0, p1, r, mat, col, parent, sides=6):
    direction = Vector(p1) - Vector(p0)
    return drum(name, Frame(p0, direction), 0.0, 0.0, 0.0, r, direction.length, mat, col, parent, sides=sides, sink=0.0)


def disc(name, center, r, z0, z1, c, mat, col, parent, sides=32):
    """A chamfered Z-axis drum between absolute heights z0 and z1."""
    frame = Frame((center[0], center[1], 0.0), Z)
    return tube(name, [circle(frame, 0, 0, z0, r - c, sides), circle(frame, 0, 0, z0 + c, r, sides),
                       circle(frame, 0, 0, z1 - c, r, sides), circle(frame, 0, 0, z1, r - c, sides)], mat, col, parent)


def arc_car(name, R, zc, a0, a1, w, h, c, mat, col, parent, steps=6, closed=False):
    """A chamfered-rectangle section (w radial, h tall) swept along the circle of radius R from a0 to a1."""
    sections = []
    count = steps if closed else steps + 1
    for i in range(count):
        t = a0 + (a1 - a0) * i / steps
        sections.append(octagon(Frame(polar(R, t, zc), tangent(t), up=Z), w, h, c))
    return tube(name, sections, mat, col, parent, closed=closed)


# ---------- frames along lines and arcs ----------
def line_frames(p0, p1, normal, count):
    p0, d = Vector(p0), Vector(p1) - Vector(p0)
    n = Vector(normal).normalized()
    up = n.cross(d.normalized())
    return [Frame(p0 + d * ((i + 0.5) / count), n, up=up) for i in range(count)]


def arc_frames(center, r, z, a0, a1, count, outward=True, normal=None):
    frames = []
    for i in range(count):
        t = a0 + (a1 - a0) * (i + 0.5) / count
        out = radial(t)
        origin = Vector(center) + polar(r, t, z)
        frames.append(Frame(origin, out if outward else -out) if normal is None else Frame(origin, normal, up=out))
    return frames


def arc_frame(center, r, z, t, outward=True, normal=None):
    return arc_frames(center, r, z, t, t, 1, outward=outward, normal=normal)[0]
