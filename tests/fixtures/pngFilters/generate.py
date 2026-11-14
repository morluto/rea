"""Regenerate portable PNG filter vectors; requires Pillow 13.0.0, not REA.

PNG encoding follows https://www.w3.org/TR/png-3/#9Filters. Pillow must
independently decode every image to the exact intended RGB/RGBA samples.
Run from any directory; normal tests read the checked-in vectors only.
Apply the repository JSON formatter to vectors.json after regenerating.
"""

import base64
import hashlib
import io
import json
import pathlib
import struct
import zlib

from PIL import Image, __version__


def chunk(kind, payload):
    data = kind + payload
    return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data))


def png(pixels, channels, filters):
    rows = []
    stride = 6 * channels
    for y, kind in enumerate(filters):
        row = bytearray([kind])
        for x in range(stride):
            a = pixels[y * stride + x - channels] if x >= channels else 0
            b = pixels[(y - 1) * stride + x] if y else 0
            c = pixels[(y - 1) * stride + x - channels] if y and x >= channels else 0
            prediction = a + b - c
            distances = [abs(prediction - value) for value in (a, b, c)]
            paeth = (a, b, c)[distances.index(min(distances))]
            predictor = (0, a, b, (a + b) // 2, paeth)[kind]
            row.append((pixels[y * stride + x] - predictor) % 256)
        rows.append(row)
    header = struct.pack(">IIBBBBB", 6, 6, 8, 2 if channels == 3 else 6, 0, 0, 0)
    encoded = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
               + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))
    image = Image.open(io.BytesIO(encoded))
    assert image.mode == ("RGB" if channels == 3 else "RGBA")
    assert image.tobytes() == pixels
    return base64.b64encode(encoded).decode("ascii")


vectors = []
for channels in (3, 4):
    pixels = bytearray(hashlib.shake_256(b"rea-png-filter-oracle").digest(36 * channels))
    # Paeth ties at row 4, pixel 1: above/upper-left and left/upper-left.
    for y, x, values in ((3, 0, (20, 20)), (3, 1, (40, 10)), (4, 0, (10, 40))):
        pixels[(y * 6 + x) * channels:(y * 6 + x) * channels + 2] = bytes(values)
    original = bytes(pixels)
    pixels[-channels] ^= 0x20
    changed = bytes(pixels)
    vectors.append({
        "mode": "RGB" if channels == 3 else "RGBA",
        "decoded_sha256": hashlib.sha256(original).hexdigest(),
        "filters": [4, 1, 2, 3, 4, 0],
        "reference": png(original, channels, [0] * 6),
        "filtered": png(original, channels, [4, 1, 2, 3, 4, 0]),
        "changed": png(changed, channels, [4, 1, 2, 3, 4, 0]),
        "delta": abs(changed[-channels] - original[-channels]),
    })

pathlib.Path(__file__).with_name("vectors.json").write_text(
    json.dumps({"oracle": "Pillow " + __version__, "vectors": vectors}, indent=2) + "\n"
)
print("Pillow", __version__, "verified all 6 PNGs, 36 pixels each, exact full samples")
