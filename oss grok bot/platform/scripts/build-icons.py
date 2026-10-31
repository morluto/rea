"""Render the original geometric mascot as native app assets (optional Pillow tool)."""
from pathlib import Path
from math import sqrt
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def sphere(size, opaque=False):
    image = Image.new("RGBA", (size, size), "#f4f6f3" if opaque else (0, 0, 0, 0))
    pixels = image.load()
    scale = size / 256
    for y in range(int(236 * scale)):
        for x in range(size):
            nx, ny = (x / scale - 128) / 105, (y / scale - 119) / 105
            radius = nx * nx + ny * ny
            if radius <= 1:
                z = sqrt(1 - radius)
                light = max(0, nx * -.38 + ny * -.5 + z * .76)
                shine = max(0, nx * -.4 + ny * -.6 + z * .69) ** 28
                pixels[x, y] = (int(108 + 65 * light + 40 * shine),
                                int(133 + 59 * light + 35 * shine),
                                int(100 + 61 * light + 40 * shine), 255)
    draw = ImageDraw.Draw(image)
    def box(values):
        return tuple(round(value * scale) for value in values)
    draw.ellipse(box((88, 102, 99, 120)), fill="#283c2c")
    draw.ellipse(box((145, 102, 156, 120)), fill="#283c2c")
    draw.arc(box((111, 116, 136, 139)), 0, 180, fill="#334b34", width=round(4 * scale))
    return image


desktop = sphere(256)
desktop.save(ROOT / "apps/desktop/icon.png")
desktop.save(ROOT / "apps/desktop/icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
assets = ROOT / "apps/mobile/ios/App/App/Assets.xcassets"
sphere(1024, opaque=True).convert("RGB").save(assets / "AppIcon.appiconset/AppIcon-512@2x.png")
launch = Image.new("RGB", (2732, 2732), "#f4f6f3")
launch.paste(desktop, ((2732 - 256) // 2, (2732 - 256) // 2), desktop)
for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
    launch.save(assets / "Splash.imageset" / name)
print("Rendered original Windows and iOS app assets; no reference-app assets used.")
