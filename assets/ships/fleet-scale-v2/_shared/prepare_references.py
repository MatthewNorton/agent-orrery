"""Create transparent front-three-quarter crops from the generated turnarounds."""

from pathlib import Path

from PIL import Image, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SLUGS = (
    "aur-wisp-drone",
    "aur-lance-interceptor",
    "aur-wayfarer-shuttle",
    "aur-bastion-corvette",
    "aur-vigil-frigate",
    "aur-helix-destroyer",
    "aur-atlas-cruiser",
    "aur-ark-carrier",
    "aur-citadel-station",
)


def background_color(image):
    points = []
    for x in range(0, image.width, max(1, image.width // 32)):
        points.extend((image.getpixel((x, 0)), image.getpixel((x, image.height - 1))))
    for y in range(0, image.height, max(1, image.height // 32)):
        points.extend((image.getpixel((0, y)), image.getpixel((image.width - 1, y))))
    return tuple(sorted(pixel[channel] for pixel in points)[len(points) // 2] for channel in range(3))


def make_crop(slug):
    reference_dir = ROOT / slug / "references"
    source = ImageOps.exif_transpose(Image.open(reference_dir / f"{slug}-turnaround.png")).convert("RGB")
    crop = source.crop((0, 0, source.width // 2, source.height // 2))
    bg = background_color(crop)
    mask = Image.new("L", crop.size)
    mask.putdata([
        255 if sum((channel - bg[index]) ** 2 for index, channel in enumerate(pixel)) ** 0.5 > 24 else 0
        for pixel in crop.getdata()
    ])
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))
    bbox = mask.getbbox()
    if bbox:
        left, top, right, bottom = bbox
        pad_x = int((right - left) * 0.04)
        pad_y = int((bottom - top) * 0.04)
        bbox = (max(0, left - pad_x), max(0, top - pad_y), min(crop.width, right + pad_x), min(crop.height, bottom + pad_y))
        crop = crop.crop(bbox)
        mask = mask.crop(bbox)
    rgba = crop.convert("RGBA")
    rgba.putalpha(mask)
    output = reference_dir / f"{slug}-front-reference.png"
    rgba.save(output)
    print(output)


for asset_slug in SLUGS:
    make_crop(asset_slug)
