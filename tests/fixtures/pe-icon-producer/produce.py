"""Record real Pillow/windres/ld icon resources with an independent pefile oracle."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib

import pefile
import PIL
from PIL import Image


def digest(data):
    return hashlib.sha256(data).hexdigest()


def binutils_release(banner):
    # GNU tools print their upstream release as the final banner field. Build
    # and distributor text before it is provenance, not format compatibility.
    return banner.rsplit(None, 1)[-1]


def produce(windres, linker):
    if PIL.__version__ != "13.0.0" or pefile.__version__ != "2024.8.26":
        raise RuntimeError("requires Pillow==13.0.0 and pefile==2024.8.26")
    env = {**os.environ, "LC_ALL": "C"}
    versions = []
    for command in [windres, linker]:
        text = subprocess.check_output([command, "--version"], env=env, text=True, timeout=10).splitlines()[0]
        if binutils_release(text) != "2.44":
            raise RuntimeError(f"requires GNU binutils 2.44: {text}")
        versions.append(text)
    samples = []
    with tempfile.TemporaryDirectory(prefix="rea-pe-icons-") as temporary:
        root = Path(temporary)
        icon = root / "producer.ico"
        Image.new("RGBA", (256, 256), (17, 34, 51, 255)).save(
            icon, format="ICO", sizes=[(16, 16), (256, 256)], bitmap_format="bmp")
        with Image.open(icon) as image:
            assert image.ico.sizes() == {(16, 16), (256, 256)}
            for size in [(16, 16), (256, 256)]:
                assert image.ico.getimage(size).size == size
        ico = icon.read_bytes()
        ico_payloads = []
        for index in range(struct.unpack_from("<H", ico, 4)[0]):
            size, offset = struct.unpack_from("<II", ico, 6 + index * 16 + 8)
            ico_payloads.append(ico[offset:offset + size])
        source = root / "icons.rc"
        source.write_text('LANGUAGE 9,1\n1 ICON "producer.ico"\nLANGUAGE 17,1\n1 ICON "producer.ico"\n')
        for target, emulation, name in [
            ("pe-i386", "i386pe", "icons-pe32"),
            ("pe-x86-64", "i386pep", "icons-pe64"),
        ]:
            obj, carrier = root / (name + ".o"), root / (name + ".dll")
            subprocess.run([windres, "--preprocessor=/usr/bin/cpp", "-F", target,
                            "-O", "coff", "-i", str(source), "-o", str(obj)],
                           cwd=root, env=env, check=True, timeout=30)
            subprocess.run([linker, "-m", emulation, "--dll", "--entry", "0",
                            "--no-insert-timestamp", "-o", str(carrier), str(obj)],
                           cwd=root, env=env, check=True, timeout=30)
            raw = carrier.read_bytes()
            rows, groups = [], []
            with pefile.PE(data=raw) as pe:
                for type_entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
                    for name_entry in type_entry.directory.entries:
                        for language_entry in name_entry.directory.entries:
                            data = language_entry.data.struct
                            payload = pe.get_data(data.OffsetToData, data.Size)
                            row = {
                                "index": len(rows), "type": type_entry.id,
                                "name": name_entry.id, "language": language_entry.id,
                                "offset": pe.get_offset_from_rva(data.OffsetToData),
                                "size": data.Size, "sha256": digest(payload),
                            }
                            rows.append(row)
                            if type_entry.id != 14:
                                continue
                            reserved, kind, count = struct.unpack_from("<HHH", payload)
                            assert reserved == 0 and kind == 1 and count == 2
                            images = []
                            for i in range(count):
                                width, height, colors, reserved, planes, bits, length, resource_id = struct.unpack_from(
                                    "<BBBBHHIH", payload, 6 + i * 14)
                                images.append({
                                    "location": {"offset": row["offset"] + 6 + i * 14, "bytes": 14},
                                    "width": width, "height": height, "color_count": colors,
                                    "reserved": reserved, "planes": planes, "bit_count": bits,
                                    "declared_bytes": length, "resource_id": resource_id,
                                })
                            groups.append({"resource_index": row["index"], "images": images})
            for group in groups:
                language = rows[group["resource_index"]]["language"]
                for index, image in enumerate(group["images"]):
                    candidates = [row for row in rows if row["type"] == 3 and row["name"] == image["resource_id"]]
                    exact = next(row for row in candidates if row["language"] == language)
                    assert exact["size"] == image["declared_bytes"] == len(ico_payloads[index])
                    assert exact["sha256"] == digest(ico_payloads[index])
                    image.update(candidate_resource_indices=[row["index"] for row in candidates],
                                 same_language_resource_index=exact["index"], size_matches=True)
            samples.append({
                "name": carrier.name, "format": "pe32" if emulation == "i386pe" else "pe32-plus",
                "size": len(raw), "sha256": digest(raw),
                "deflate_base64": base64.b64encode(zlib.compress(raw, 9)).decode(),
                "resources": rows, "groups": groups,
            })
    return {"pillow": PIL.__version__, "pefile": pefile.__version__, "binutils": versions, "samples": samples}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--windres", default="x86_64-w64-mingw32-windres")
    parser.add_argument("--ld", default="ld")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    result = produce(args.windres, args.ld)
    target = Path(__file__).with_name("oracle.json")
    if args.check:
        recorded = json.loads(target.read_text())
        # Retain the recorded banners on disk, but compare upstream releases
        # independently of packaging/build branding when reproducing the facts.
        recorded["binutils"] = [binutils_release(text) for text in recorded["binutils"]]
        result["binutils"] = [binutils_release(text) for text in result["binutils"]]
        for old, new in zip(recorded["samples"], result["samples"], strict=True):
            assert zlib.decompress(base64.b64decode(old.pop("deflate_base64"))) == zlib.decompress(base64.b64decode(new.pop("deflate_base64")))
        assert recorded == result, "Producer facts differ from recorded oracle"
        print("Independent producer reproduces both complete PE files and all icon facts")
    else:
        target.write_text(json.dumps(result, indent=2) + "\n")
        print(target)
