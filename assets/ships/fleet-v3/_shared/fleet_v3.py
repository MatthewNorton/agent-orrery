"""Shared build for the fleet v3 hulls: the fleet materials (three hull tones with authored
panel-line maps, livery, glow, glass, windows), the four-view QA rig and the export. Each hull's
script defines its geometry with kitbash.py and calls run().

Conventions: meters; forward is +Y, up is +Z, X is starboard (the app's manifest correction
rotateY=pi applies). Blender owns the hull surfaces (maps baked here into the GLB); the app tints
only `accent_livery`, `engine_glow` and faintly `canopy_glass` per provider, and lights
`window_light` its own way (kit/SPEC.md section 4).
"""

import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True

import numpy as np
from mathutils import Vector

SKILL_SCRIPTS = os.environ.get("IMAGE_TO_BLENDER_SKILL_SCRIPTS", "")
if SKILL_SCRIPTS and SKILL_SCRIPTS not in sys.path:
    sys.path.insert(0, SKILL_SCRIPTS)

import blender_asset_toolkit as bat  # noqa: E402
import portable_pbr_repair as ppr  # noqa: E402

SHARED_DIR = os.path.dirname(os.path.abspath(__file__))
if SHARED_DIR not in sys.path:
    sys.path.insert(0, SHARED_DIR)
import kitbash  # noqa: E402

TEXTURE_SIZE = 512
LENS = 50.0
REFERENCES = ["references/perspective-4x.png", "references/top-4x.png", "references/side-4x.png", "references/front-4x.png"]
# The ship points +Y, so the "front" cameras sit on the +Y side.
VIEW_DIRECTIONS = {
    "front_three_quarter": Vector((0.82, 1.0, 0.52)),
    "rear_three_quarter": Vector((-0.82, -1.0, 0.44)),
    "side_profile": Vector((1.0, 0.03, 0.18)),
    "top_or_underside": Vector((0.32, 0.42, 1.0)),
}

# The fleet palette: the key a build script uses, the material name the app expects, the joined
# object's name, the surface, and for the hull tones the authored panel-line map parameters.
# Glow and windows bake unit emission strength: the app owns how bright they are.
MATERIALS = {
    "white": dict(name="hull_white", joined="Hull_White", rgb=(0.86, 0.85, 0.82), metallic=0.08, roughness=0.42,
                  maps=dict(seam_darken=0.6, normal_strength=4.5, seed=11, seams_u=(0.0, 0.5), seams_v=(0.0, 0.34, 0.67), hatches=5)),
    "grey": dict(name="hull_grey", joined="Hull_Grey", rgb=(0.42, 0.43, 0.45), metallic=0.3, roughness=0.46,
                 maps=dict(seam_darken=0.45, normal_strength=3.8, seed=17, seams_u=(0.0, 0.33, 0.67), seams_v=(0.0, 0.5), hatches=4)),
    "dark": dict(name="hull_dark", joined="Hull_Dark", rgb=(0.075, 0.085, 0.105), metallic=0.55, roughness=0.5,
                 maps=dict(seam_darken=0.3, normal_strength=3.4, seed=23, seams_u=(0.0, 0.25, 0.5, 0.75), seams_v=(0.0, 0.5), hatches=3)),
    "accent": dict(name="accent_livery", joined="Livery", rgb=(0.93, 0.45, 0.16), metallic=0.2, roughness=0.38),
    "glow": dict(name="engine_glow", joined="Glow", rgb=(0.2, 0.6, 1.0), metallic=0.0, roughness=0.3, emission=(0.35, 0.7, 1.0)),
    "glass": dict(name="canopy_glass", joined="Glass", rgb=(0.025, 0.04, 0.07), metallic=0.0, roughness=0.12, coat=1.0),
    "window": dict(name="window_light", joined="Windows", rgb=(0.45, 0.7, 1.0), metallic=0.0, roughness=0.3, emission=(0.3, 0.58, 1.0)),
}
HERO_MATERIALS = [spec["name"] for spec in MATERIALS.values() if "maps" in spec]
JOINED_NAMES = {spec["name"]: spec["joined"] for spec in MATERIALS.values()}


# ---------- authored panel-line maps ----------
def _periodic_mask(coord, positions, half_width):
    mask = np.zeros_like(coord, dtype=np.float32)
    for p in positions:
        dist = np.abs(((coord - p + 0.5) % 1.0) - 0.5)
        mask = np.maximum(mask, (dist < half_width).astype(np.float32))
    return mask


def author_panel_maps(asset, texture_dir, mat, base_rgb, rough_base, metallic, tile, seam_darken, normal_strength, seed, seams_u, seams_v, hatches):
    """Panel seams, recessed hatches and rivets on a world-tiled cube projection; one tile = `tile` m."""
    size = TEXTURE_SIZE
    rng = np.random.default_rng(seed)
    coords = (np.arange(size, dtype=np.float32) + 0.5) / size
    u, v = np.meshgrid(coords, coords)
    px = 1.0 / size
    seam = np.maximum(_periodic_mask(u, seams_u, 14.0 * px), _periodic_mask(v, seams_v, 14.0 * px))
    height = np.ones((size, size), dtype=np.float32)
    hatch_mask = np.zeros((size, size), dtype=np.float32)
    for _ in range(hatches):
        x0, y0 = rng.uniform(0.04, 0.72), rng.uniform(0.04, 0.72)
        w, h = rng.uniform(0.14, 0.34), rng.uniform(0.08, 0.22)
        inside = (u > x0) & (u < x0 + w) & (v > y0) & (v < y0 + h)
        inner = (u > x0 + 7 * px) & (u < x0 + w - 7 * px) & (v > y0 + 7 * px) & (v < y0 + h - 7 * px)
        height[inside] -= 0.12
        hatch_mask = np.maximum(hatch_mask, inside.astype(np.float32))
        seam = np.maximum(seam, (inside & ~inner).astype(np.float32))
    height -= seam * 0.4
    rivet = np.zeros_like(seam)
    for p in seams_u:
        along = np.abs(((v * 8.0) % 1.0) - 0.5) < (4.0 * px * 8.0)
        near = np.abs(((u - p + 0.5) % 1.0) - 0.5) < (20.0 * px)
        far = np.abs(((u - p + 0.5) % 1.0) - 0.5) > (13.0 * px)
        rivet = np.maximum(rivet, (along & near & far).astype(np.float32))
    height += rivet * 0.08
    noise = ppr.periodic_noise(size, rng, 4)
    base = np.asarray(base_rgb, dtype=np.float32)
    color = base[None, None, :] * (1.0 - 0.07 * (noise[:, :, None] - 0.5))
    color = color * (1.0 - hatch_mask[:, :, None] * 0.3)
    color = color * (1.0 - seam[:, :, None] * seam_darken)
    color = color * (1.0 + rivet[:, :, None] * 0.12)
    color = np.clip(color, 0.003, 1.0)
    rough = np.clip(rough_base + 0.07 * (noise - 0.5) + seam * 0.18 - rivet * 0.1, 0.05, 0.95)
    metal = np.full((size, size), float(metallic), dtype=np.float32)
    normal = ppr.normal_from_height(height, normal_strength)
    prefix = ppr.safe_name(mat.name)
    texture_dir = Path(texture_dir)
    texture_dir.mkdir(parents=True, exist_ok=True)
    maps = (("base_color", "BaseColor", ppr.rgba(color), "sRGB"), ("normal", "Normal", ppr.rgba(normal), "Non-Color"),
            ("roughness", "Roughness", ppr.grayscale_rgba(rough), "Non-Color"), ("metallic", "Metallic", ppr.grayscale_rgba(metal), "Non-Color"))
    files = {key: texture_dir / f"{prefix}_{key.replace('_', '')}.png" for key, _, _, _ in maps}
    images = {key: ppr.save_image(f"{asset}_{prefix}_{label}", files[key], pixels, space) for key, label, pixels, space in maps}
    record = {"style": "coated", "fallback": [float(c) for c in base] + [1.0], "images": images, "files": [p.name for p in files.values()]}
    ppr.assign_portable_nodes(mat, record)
    mat["portable_style"] = "coated"
    mat["portable_tile_size"] = float(tile)
    for image in images.values():
        image.pack()


def materials(asset, texture_dir, tile):
    """The fleet palette as Blender materials, keyed as the build scripts use them."""
    out = {}
    for key, spec in MATERIALS.items():
        extra = {}
        if "emission" in spec:
            extra.update(emission_color=(*spec["emission"], 1.0), emission_strength=1.0)
        if "coat" in spec:
            extra.update(coat=spec["coat"])
        mat = bat.material(spec["name"], (*spec["rgb"], 1.0), metallic=spec["metallic"], roughness=spec["roughness"], **extra)
        if "maps" in spec:
            author_panel_maps(asset, texture_dir, mat, spec["rgb"], spec["roughness"], spec["metallic"], tile, **spec["maps"])
        out[key] = mat
    return out


# ---------- manifest, rig, export ----------
def provisional_manifest(asset, references, required_parts, note):
    # The skill's own template: the toolkit resolves its assets folder from its module path.
    template = os.path.join(os.path.dirname(os.path.dirname(bat.__file__)), "assets", "quality_manifest_template.json")
    with open(template, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    manifest["asset_name"] = asset
    manifest["reference_files"] = references
    manifest["target_runtimes"] = ["blender", "three.js", "babylon.js"]
    manifest["required_parts"] = [{"status": "PASS", **part} for part in required_parts]
    for key in manifest["quality_checks"]:
        manifest["quality_checks"][key]["evidence"] = note
    manifest["visual_comparison"]["primary_reference"] = references[0]
    manifest["visual_comparison"]["matched_render"] = f"{asset}_front_three_quarter.png"
    manifest["visual_comparison"]["comparison_sheet"] = f"{asset}_visual_comparison.png"
    manifest["visual_comparison"]["objective_report"] = f"{asset}_visual_comparison.json"
    manifest["visual_comparison"]["evidence"] = note
    manifest["real_time_design"]["required"] = True
    manifest["real_time_design"]["evidence"] = note
    for audit in manifest["view_audits"]:
        audit["render"] = f"{asset}_{audit['view']}.png"
        audit["notes"] = note
    manifest["known_limitations"] = [note]
    return manifest


def _quality_rig(studio, center, scale):
    distance = max(0.25, scale * 2.6)
    cameras = {}
    for view_name, direction in VIEW_DIRECTIONS.items():
        location = center + direction.normalized() * distance
        camera = bat.add_camera(f"Camera_{view_name}", studio, tuple(location), tuple(center), LENS)
        # A capital ship sits kilometers from its camera; the default clip range would cut it off.
        camera.data.clip_start = max(0.05, distance * 0.002)
        camera.data.clip_end = max(100.0, distance * 6.0)
        cameras[view_name] = camera
    energy = max(18.0, 72.0 * scale * scale)
    bat.add_area_light("Key_Softbox", studio, tuple(center + Vector((-.8, 1.25, 1.05)).normalized() * distance * .75), tuple(center), energy, scale * 1.4)
    bat.add_area_light("Fill_Softbox", studio, tuple(center + Vector((1.1, .55, .45)).normalized() * distance * .70), tuple(center), energy * .55, scale * 1.2, (.72, .84, 1.0))
    bat.add_area_light("Rim_Softbox", studio, tuple(center + Vector((-.65, -.95, .85)).normalized() * distance * .68), tuple(center), energy * .72, scale, (.82, .91, 1.0))
    bat.add_area_light("Top_Softbox", studio, tuple(center + Vector((0, 0, 1)) * distance * .65), tuple(center), energy * .18, scale * .9)
    return cameras


def run(script_dir, build, required_parts, tile, title):
    """Build the hull named by its folder: materials, geometry from `build(col, root, M)`, four QA renders, export."""
    asset = os.path.basename(os.path.abspath(script_dir))
    output_dir = os.path.abspath(os.environ.get("ASSET_OUTPUT_DIR", script_dir))
    os.makedirs(output_dir, exist_ok=True)
    bat.reset_scene()
    scene = bat.configure_scene(resolution=(1600, 1200), transparent=True)
    model_collection = bat.make_collection("MODEL_ONLY")
    studio_collection = bat.make_collection("STUDIO_NOT_EXPORTED")
    root = bat.create_root(asset, model_collection)
    M = materials(asset, os.path.join(output_dir, "textures"), tile)
    build(model_collection, root, M)
    # One mesh per material: a hull of a thousand kitbash pieces draws in a handful of calls.
    kitbash.join_by_material(model_collection, root, JOINED_NAMES)
    bat.set_hero_materials(HERO_MATERIALS)

    model_objects = bat.collect_objects([model_collection], include_children=True)
    lower, upper = ppr.evaluated_bounds(model_objects)
    dimensions = upper - lower
    center = (lower + upper) * 0.5
    cameras = _quality_rig(studio_collection, center, max(dimensions))

    for view_name, camera in cameras.items():
        bat.render_transparent(scene, os.path.join(output_dir, f"{asset}_{view_name}.png"), camera)

    note = "Provisional: first-fleet build, strict validation and visual comparison follow the owner's verdict."
    manifest = provisional_manifest(asset, REFERENCES, required_parts, note)
    manifest["declared_dimensions_m"] = {"x": round(dimensions.x, 3), "y": round(dimensions.y, 3), "z": round(dimensions.z, 3)}
    with open(os.path.join(output_dir, f"{asset}_quality_manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    exports = bat.export_asset(scene, root, model_objects, output_dir, asset, export_animation=False, viewer_title=title)
    bat.write_metrics(os.path.join(output_dir, f"{asset}_build_metrics.json"), model_objects, exports,
                      {"qa_views": list(cameras), "dimensions_m": [round(v, 3) for v in dimensions],
                       "hero_materials": HERO_MATERIALS, "portable_materials": bat.portable_material_names(), "texture_tile_m": tile})
    print("BUILD OK", asset, [round(v, 2) for v in dimensions], exports["glb"])
