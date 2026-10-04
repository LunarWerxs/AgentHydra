# Generates launcher/hydra-desk.ico: a dark rounded square with a three-headed hydra mark in the
# Claude clay color (#d97757). Multi-size ICO, 16 to 256. The small frames (16, 24, 32) get a bold
# "H" instead, because three necks turn to mud below 48 px.
#
#   python launcher/make-icon.py            (needs Pillow)
#
# After regenerating, re-run launcher/install-shortcuts.ps1 so Windows picks up the new icon.

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE / "hydra-desk.ico"

TILE = (31, 30, 29, 255)  # Claude Desktop dark surface
EDGE = (58, 55, 52, 255)  # hairline border so the tile reads on a dark taskbar
CLAY = (217, 119, 87, 255)  # #d97757

SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 4  # supersampling factor


def tile(n: int) -> tuple[Image.Image, ImageDraw.ImageDraw, int]:
    big = n * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = round(big * 0.22)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=EDGE)
    border = max(SS, round(big * 0.012))
    d.rounded_rectangle((border, border, big - 1 - border, big - 1 - border), radius=radius - border, fill=TILE)
    return img, d, big


def bezier(p0, p1, p2, steps=48):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))
    return pts


def stroke(d: ImageDraw.ImageDraw, pts, width: float) -> None:
    # Round-capped polyline: segments plus a disc at every joint.
    r = width / 2
    for a, b in zip(pts, pts[1:]):
        d.line((a, b), fill=CLAY, width=round(width))
    for x, y in pts:
        d.ellipse((x - r, y - r, x + r, y + r), fill=CLAY)


def hydra(n: int) -> Image.Image:
    img, d, s = tile(n)
    u = s / 100  # design grid: 100 x 100
    neck = 9 * u
    base = (50 * u, 80 * u)
    # Body: a low mound the three necks rise from.
    d.ellipse((30 * u, 72 * u, 70 * u, 88 * u), fill=CLAY)
    heads = [
        ((28 * u, 36 * u), (34 * u, 66 * u)),  # left: (head, curve control)
        ((50 * u, 24 * u), (50 * u, 50 * u)),  # centre
        ((72 * u, 36 * u), (66 * u, 66 * u)),  # right
    ]
    for head, ctrl in heads:
        stroke(d, bezier(base, ctrl, head), neck)
    for (hx, hy), _ in heads:
        r = 8.5 * u
        d.ellipse((hx - r, hy - r, hx + r, hy + r), fill=CLAY)
        # A dark eye dot keeps each head reading as a head, not a ball.
        e = 2.4 * u
        d.ellipse((hx - e, hy - e - 1 * u, hx + e, hy + e - 1 * u), fill=TILE)
    return img.resize((n, n), Image.LANCZOS)


def letter_h(n: int) -> Image.Image:
    img, d, s = tile(n)
    u = s / 100
    w = 17 * u  # stem width
    top, bot = 22 * u, 78 * u
    d.rectangle((24 * u, top, 24 * u + w, bot), fill=CLAY)
    d.rectangle((76 * u - w, top, 76 * u, bot), fill=CLAY)
    d.rectangle((24 * u, 50 * u - w / 2, 76 * u, 50 * u + w / 2), fill=CLAY)
    return img.resize((n, n), Image.LANCZOS)


def main() -> None:
    frames = [letter_h(n) if n <= 32 else hydra(n) for n in SIZES]
    largest = frames[-1]
    largest.save(OUT, format="ICO", sizes=[(n, n) for n in SIZES], append_images=frames[:-1])
    largest.save(HERE / "hydra-desk.png")  # handy for previews and the README
    with Image.open(OUT) as ico:
        print(f"wrote {OUT.name}: {sorted(ico.info.get('sizes', set()))}")


if __name__ == "__main__":
    main()
