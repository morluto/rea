"""Capture GCC inline-variable bindings with GNU readelf; never run the DSO."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
FLAGS = ["-std=c++17", "-shared", "-fPIC", "-Wl,--build-id=none"]
TYPES = {"OBJECT": "object", "TLS": "tls"}
NAMES = {"process_value", "thread_value"}


def command(*args):
    return subprocess.check_output(args, text=True, env={**os.environ, "LC_ALL": "C"})


def produce(compiler, readelf):
    variants = []
    with tempfile.TemporaryDirectory(prefix="rea-elf-inline-") as temporary:
        for name, extra in [("gnu_unique", []), ("weak", ["-fno-gnu-unique"])]:
            binary = Path(temporary) / f"{name}.so"
            subprocess.run(
                [compiler, *FLAGS, *extra, str(ROOT / "inline.cpp"), "-o", str(binary)],
                check=True,
            )
            contents = binary.read_bytes()
            assert contents[:6] == b"\x7fELF\x02\x01", "this witness requires ELF64 little endian"
            assert struct.unpack_from("<H", contents, 18)[0] == 62, "this witness requires x86-64"
            # Numeric input facts come from the actual ELF st_info byte, not
            # a copy of REA's binding table. readelf independently names them.
            section_offset = struct.unpack_from("<Q", contents, 40)[0]
            section_width, section_count = struct.unpack_from("<HH", contents, 58)
            dynamic = [
                offset for offset in range(section_offset, section_offset + section_width * section_count, section_width)
                if struct.unpack_from("<I", contents, offset + 4)[0] == 11
            ]
            assert len(dynamic) == 1
            symbol_offset = struct.unpack_from("<Q", contents, dynamic[0] + 24)[0]
            symbol_width = struct.unpack_from("<Q", contents, dynamic[0] + 56)[0]
            symbols = []
            for line in command(readelf, "--wide", "--dyn-syms", str(binary)).splitlines():
                match = re.fullmatch(
                    r"\s*(\d+):\s+([0-9a-fA-F]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)",
                    line,
                )
                if match is None or match[8] not in NAMES:
                    continue
                index, value, size, kind, binding, visibility, section, symbol = match.groups()
                assert visibility == "DEFAULT" and section != "UND"
                info = contents[symbol_offset + int(index) * symbol_width + 4]
                symbols.append({
                    "name": symbol,
                    "value": hex(int(value, 16)),
                    "size": size,
                    "raw_info": hex(info),
                    "type_code": info & 15,
                    "type": TYPES[kind],
                    "binding_code": info >> 4,
                    "binding": binding.lower(),
                    "visibility": "default",
                })
            assert {item["name"] for item in symbols} == NAMES
            variants.append({"name": name, "flags": extra, "os_abi": contents[7], "symbols": symbols})
    return {
        "compiler": command(compiler, "--version").splitlines()[0],
        "reference": command(readelf, "--version").splitlines()[0],
        "source_sha256": hashlib.sha256((ROOT / "inline.cpp").read_bytes()).hexdigest(),
        "flags": FLAGS,
        "variants": variants,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", default="g++")
    parser.add_argument("--readelf", default="readelf")
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    observed = produce(arguments.compiler, arguments.readelf)
    destination = ROOT / "oracle.json"
    if arguments.check:
        assert observed == json.loads(destination.read_text()), "producer facts changed"
        print("GCC/readelf fixture matches the recorded oracle")
    else:
        destination.write_text(json.dumps(observed, indent=2) + "\n")
