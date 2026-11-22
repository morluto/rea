#!/usr/bin/env python3
"""Compare real LLD APS2/ordinary ELF witnesses against source symbols and bytes.

Requires GCC, LLD and a built REA. Never loads or executes a produced library.
"""
import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from oracle import Elf


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def verify(root, cc, lld, node):
    source = Path(__file__).with_name("aps2.c")
    module = (root / "dist/domain/android/androidJniLibrary.js").as_uri()
    inspect = (
        'import {readFile} from "node:fs/promises"; '
        f'import {{inspectAndroidJniLibrary}} from {json.dumps(module)}; '
        'console.log(JSON.stringify(await inspectAndroidJniLibrary(await readFile(process.argv[1]))));'
    )
    results = []
    qualification = {"variants": {}}
    with tempfile.TemporaryDirectory(prefix="rea-aps2-") as temporary:
        directory = Path(temporary)
        for bits, machine in ((32, "elf_i386"), (64, "elf_x86_64")):
            obj = directory / f"library{bits}.o"
            run(cc, f"-m{bits}", "-fPIC", "-ffreestanding", "-c", str(source), "-o", str(obj))
            for packing in ("none", "android", "android+relr"):
                library = directory / f"{packing}{bits}.so"
                run(lld, "-m", machine, "-shared", f"--pack-dyn-relocs={packing}", "--no-use-android-relr-tags", str(obj), "-o", str(library))
                data = library.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                elf = Elf(data)
                if packing == "android":
                    assert "APS2" in elf.encodings
                    assert any(group["flags"] & 2 for group in elf.packed_groups), "Producer must emit grouped offsets"
                    if bits == 64:
                        assert any(not group["flags"] & 8 for group in elf.packed_groups), "Producer must emit an addend-reset group"
                elif packing == "android+relr":
                    assert {"APS2", "RELR"} <= elf.encodings
                expected = [elf.entry(elf.symbols["methods"]["address"], index, name, signature, name)
                            for index, (name, signature) in enumerate((
                                ("first", "()V"), ("second", "(I)V"), ("third", "(J)V"), ("fourth", "([B)V")))]
                qualification["variants"].setdefault(packing, {"libraries": {}})["libraries"][str(bits)] = {
                    "path": str(library), "sha256": digest, "pointer_bytes": elf.width, "machine": elf.machine,
                    "exports": {name: {**symbol, "address": hex(symbol["address"])} for name, symbol in elf.exports.items()},
                    "tables": expected, "loads": elf.loads,
                }
                observed = json.loads(run(node, "--input-type=module", "-e", inspect, str(library)))
                assert observed["ok"], observed
                facts = observed["value"]
                entries = [entry for table in facts["tables"] for entry in table["entries"]]
                assert len(entries) == len(expected), facts
                assert facts["coverage"]["relocations_status"] == "partial", facts
                assert any("unresolved" in reason for reason in facts["unknowns"]), facts
                for actual, wanted in zip(entries, expected):
                    assert (actual["name"], actual["descriptor"], actual["function_address"]) == (
                        wanted["name"], wanted["descriptor"], wanted["function_address"])
                    for slot, oracle in zip(actual["slots"], wanted["slots"]):
                        assert slot["address"] == oracle["address"]
                        assert slot["file_offset"] == int(oracle["file_offset"], 16)
                        assert slot["value"] == oracle["resolved_word"]
                        expected_encoding = ("rela" if bits == 64 else "rel") if oracle["encoding"] == "APS2" else oracle["encoding"].lower()
                        assert slot["relocation"]["encoding"] == expected_encoding
                        if oracle["encoding"] == "APS2":
                            provenance = elf.packed_records[int(slot["address"], 16)]
                            assert slot["relocation"]["record_file_offset"] == provenance["file_offset"]
                            assert slot["relocation"]["packing"] == {"format": "aps2", "group_entry_index": provenance["entry_index"]}
                        else:
                            assert "packing" not in slot["relocation"]
                evidence = json.loads(run(node, str(root / "scripts/rea.mjs"),
                                          "inspect-native-initializers", str(library), "--json"))
                report = evidence["normalized_result"]
                constructor = next(entry for entry in report["entries"] if entry["kind"] == "init_array")
                assert constructor["resolution"] == ("relr" if packing == "android+relr" else "relative_addend"), report
                assert constructor["value_va"] == hex(elf.symbols["initialize"]["address"])
                assert hashlib.sha256(library.read_bytes()).hexdigest() == digest
                results.append({"bits": bits, "packing": packing, "jni_entries": len(entries),
                                "initializer": constructor["value_va"], "sha256": digest})
        (directory / "full-expectations.json").write_text(json.dumps(qualification))
        checked = json.loads(run(node, str(root / "tests/support/analysis-efficiency/android-jni-library.mjs"),
                                 "--parser", str(root / "dist/domain/android/androidJniLibrary.js"),
                                 "--fixture-root", str(directory), "--output", str(directory / "qualified.json")))
        assert checked["libraries"] == 6 and checked["verified_entries"] == 24, checked
    return {"variants": results, "qualification": checked}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--cc", default="gcc")
    parser.add_argument("--lld", default="ld.lld")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    print(json.dumps(verify(args.runtime_root.resolve(), args.cc, args.lld, args.node), indent=2))
