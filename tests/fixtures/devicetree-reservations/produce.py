"""Record libfdt's 64-bit reservation table and independently read it back."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent


def produce(arguments):
    library = arguments.libfdt_root.resolve()
    assert (library / "version_gen.h").read_text().strip() == '#define DTC_VERSION "DTC 1.8.1"'
    with tempfile.TemporaryDirectory(prefix="rea-libfdt-reservations-") as temporary:
        executable = Path(temporary) / "produce"
        subprocess.run(
            [arguments.compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
             "-I", str(library / "libfdt"), str(ROOT / "produce.c"),
             str(library / "libfdt/libfdt.a"), "-o", str(executable)],
            check=True,
        )
        cases = json.loads(subprocess.check_output([str(executable)], text=True))
    for case in cases:
        blob = bytes.fromhex(case.pop("blob_hex"))
        if arguments.keep_generated is not None:
            arguments.keep_generated.mkdir(parents=True, exist_ok=True)
            (arguments.keep_generated / f"libfdt-{case['version']}.dtb").write_bytes(blob)
    return {
        "libfdt_release": "1.8.1",
        "source_sha256": hashlib.sha256((ROOT / "produce.c").read_bytes()).hexdigest(),
        "cases": cases,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--libfdt-root", type=Path, required=True)
    parser.add_argument("--compiler", default="gcc")
    parser.add_argument("--keep-generated", type=Path)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    observed = produce(arguments)
    destination = ROOT / "oracle.json"
    if arguments.check:
        assert observed == json.loads(destination.read_text()), "libfdt reservation facts changed"
        print("libfdt reservation bytes and decoded values match the recorded oracle")
    else:
        destination.write_text(json.dumps(observed, indent=2) + "\n")
