"""
The site's images, made from the repo's own: the screenshots (site/shots, from
scripts/dev/shots.mjs, which runs this too) as WebP at 2x and 1x, the app icon as
favicons, and the card link previews show (1200 x 630, set in Onest). The page's
addresses for them end in ?v= and a hash of each file, since images are cached for a year.
The README shows the same WebP files.

Run from the repo root after the screenshots or the icon change:
    python -I site/tools/assets.py
Needs Pillow (with WebP) and fontTools with brotli (to read Onest's woff2).
"""
import hashlib
import io
import re
import shutil
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "site" / "shots"
BUILD = ROOT / "apps" / "desktop" / "build"
FONT = ROOT / "apps" / "desktop" / "src" / "renderer" / "assets" / "fonts" / "Onest-latin.woff2"
OUT = ROOT / "site" / "public"
IMAGES = OUT / "images"

# The screenshots the page shows, by name: each a whole Chord window at 2x, 2880 x 1800
# (Settings, 1720 x 1240). The page gives them half that as width and height, and lets
# the browser pick the 2x file or the 1x one by the width it shows them at (srcset).
SCREENSHOTS = ["chord-light", "chord-dark", "command-bar", "split-view", "duet", "themes"]


def webp(name: str) -> None:
    """{name}-2880.webp and {name}-1440.webp (for Settings, -1720 and -860), the old ones gone.
    Without its screenshot in site/shots (a fresh clone), the WebP files already made stay."""
    if not (SHOTS / f"{name}.png").exists():
        print(f"site/shots/{name}.png isn't there: kept its WebP files")
        return
    for old in IMAGES.glob(f"{name}*.webp"):
        old.unlink()
    image = Image.open(SHOTS / f"{name}.png").convert("RGB")
    half = image.resize((image.width // 2, image.height // 2), Image.LANCZOS)
    for size in (image, half):
        size.save(IMAGES / f"{name}-{size.width}.webp", "WEBP", quality=84, method=6)


def onest(size: int, weight: int) -> ImageFont.FreeTypeFont:
    """Onest at a weight on its variable axis, read from the woff2 the app bundles."""
    font = TTFont(FONT)
    font.flavor = None
    data = io.BytesIO()
    font.save(data)
    data.seek(0)
    face = ImageFont.truetype(data, size)
    face.set_variation_by_axes([weight])
    return face


def rounded(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius, fill=255)
    out = image.convert("RGBA")
    out.putalpha(mask)
    return out


def card() -> None:
    """The link preview: the pale body of the icon, the mark and name, a line, and the window."""
    if not (SHOTS / "chord-light.png").exists():
        print("site/shots/chord-light.png isn't there: kept the card")
        return
    width, height = 1200, 630
    top, bottom = (250, 247, 255), (255, 237, 228)
    background = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(background)
    for y in range(height):
        t = y / (height - 1)
        draw.line([(0, y), (width, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    canvas = background.convert("RGBA")

    # The window, large, running off the right edge, over a soft shadow.
    shot = Image.open(SHOTS / "chord-light.png").convert("RGB")
    shot = shot.resize((760, round(760 * shot.height / shot.width)), Image.LANCZOS)
    shot = rounded(shot, 14)
    x, y = 520, 150
    shadow = Image.new("RGBA", (shot.width + 120, shot.height + 120), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((60, 72, 60 + shot.width, 72 + shot.height), 18, fill=(106, 75, 196, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    canvas.alpha_composite(shadow, (x - 60, y - 60))
    canvas.alpha_composite(shot, (x, y))

    mark = Image.open(BUILD / "icon.png").convert("RGBA").resize((132, 132), Image.LANCZOS)
    canvas.alpha_composite(mark, (64, 76))
    draw = ImageDraw.Draw(canvas)
    ink = (43, 31, 61)
    draw.text((70, 236), "Chord", font=onest(76, 650), fill=ink)
    draw.text((72, 336), "Tabs that play", font=onest(44, 600), fill=ink)
    draw.text((72, 390), "together.", font=onest(44, 600), fill=ink)
    draw.text((72, 474), "A calm, colorful browser.", font=onest(26, 450), fill=(96, 82, 118))
    draw.text((72, 512), "Free and open source.", font=onest(26, 450), fill=(96, 82, 118))
    canvas.convert("RGB").save(IMAGES / "card.png", "PNG", optimize=True)


def icons() -> None:
    shutil.copyfile(BUILD / "icon-32.svg", OUT / "favicon.svg")
    icon = Image.open(BUILD / "icon.png").convert("RGBA")
    # The body fills about 80% of the master: crop to it, as Windows and Linux icons are.
    body = icon.crop((100, 100, 924, 924))
    body.resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png", optimize=True)
    body.resize((32, 32), Image.LANCZOS).save(OUT / "favicon.png", optimize=True)


def stamp() -> None:
    """Each image's address in the page ends in ?v= and its hash: nginx.conf caches /images/ for a
    year, so a changed image needs a new address, and an unchanged one keeps its own."""
    page = OUT / "index.html"
    html = page.read_bytes().decode("utf-8")

    def versioned(match: re.Match[str]) -> str:
        name = match.group(1)
        digest = hashlib.sha256((IMAGES / name).read_bytes()).hexdigest()[:10]
        return f"/images/{name}?v={digest}"

    page.write_bytes(re.sub(r"/images/([\w.-]+)(?:\?v=\w+)?", versioned, html).encode("utf-8"))


def main() -> int:
    IMAGES.mkdir(parents=True, exist_ok=True)
    for name in SCREENSHOTS:
        webp(name)
    icons()
    card()
    stamp()
    for path in sorted(IMAGES.iterdir()):
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
