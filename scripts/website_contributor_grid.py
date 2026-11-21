"""Build the README avatar grid from the same ordered profiles as the website."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import urlopen

from PIL import Image, ImageDraw, ImageOps
from PIL.PngImagePlugin import PngInfo


def avatar(person):
    url = urlsplit(person["avatar_url"])
    query = dict(parse_qsl(url.query))
    query["s"] = "64"
    address = urlunsplit(url._replace(query=urlencode(query)))
    with urlopen(address, timeout=30) as response, Image.open(BytesIO(response.read())) as image:
        return ImageOps.fit(image.convert("RGBA"), (40, 40), method=Image.Resampling.LANCZOS)


def write_avatar_grid(people, path):
    columns, step = 30, 42
    rows = (len(people) + columns - 1) // columns
    grid = Image.new("RGBA", (min(len(people), columns) * step, rows * step))
    mask = Image.new("L", (40, 40))
    ImageDraw.Draw(mask).ellipse((0, 0, 39, 39), fill=255)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for index, image in enumerate(pool.map(avatar, people)):
            grid.paste(image, (index % columns * step, index // columns * step), mask)
    metadata = PngInfo()
    metadata.add_text("contributor_ids", ",".join(str(person["id"]) for person in people))
    grid.save(path, format="PNG", pnginfo=metadata, optimize=True)
