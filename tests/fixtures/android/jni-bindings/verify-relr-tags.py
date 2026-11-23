#!/usr/bin/env python3
"""Qualify LLD's two RELR tag families through JNI facts and the public CLI.

Requires GCC, LLD with --use-android-relr-tags, and a built REA checkout.
Libraries are freestanding x86 layout witnesses, never loaded or executed.
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
    source = Path(__file__).with_name("relr-tags.c")
    module = (root / "dist/domain/android/androidJniLibrary.js").as_uri()
    inspect = (
        'import {readFile} from "node:fs/promises"; '
        f'import {{inspectAndroidJniLibrary}} from {json.dumps(module)}; '
        'console.log(JSON.stringify(await inspectAndroidJniLibrary(await readFile(process.argv[1]))));'
    )
    results = []
    with tempfile.TemporaryDirectory(prefix="rea-relr-tags-") as temporary:
        directory = Path(temporary)
        for bits, machine in ((32, "elf_i386"), (64, "elf_x86_64")):
            obj = directory / f"library{bits}.o"
            run(cc, f"-m{bits}", "-fPIC", "-ffreestanding", "-c", str(source), "-o", str(obj))
            for family in ("standard", "android"):
                library = directory / f"{family}{bits}.so"
                flag = "--use-android-relr-tags" if family == "android" else "--no-use-android-relr-tags"
                run(lld, "-m", machine, "-shared", "--pack-dyn-relocs=relr", flag, str(obj), "-o", str(library))
                data = library.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                elf = Elf(data)
                dynamic = next(s for s in elf.sections if s["type"] == 6)
                tags = dict(elf.unpack(elf.word * 2, at) for at in range(
                    dynamic["offset"], dynamic["offset"] + dynamic["size"], elf.width * 2))
                selected = (0x6FFFE000, 0x6FFFE001, 0x6FFFE003) if family == "android" else (36, 35, 37)
                assert all(tag in tags for tag in selected), (family, tags)
                relr = next(s for s in elf.sections if s["type"] == (0x6FFFFF00 if family == "android" else 19))
                assert any(elf.unpack(elf.word, at)[0] & 1 for at in range(
                    relr["offset"], relr["offset"] + relr["size"], elf.width)), "Witness must include a bitmap"
                expected = [elf.entry(elf.symbols["methods"]["address"], index, name, signature, name)
                            for index, (name, signature) in enumerate((("first", "()V"), ("second", "(I)V")))]
                observed = json.loads(run(node, "--input-type=module", "-e", inspect, str(library)))
                assert observed["ok"], observed
                facts = observed["value"]
                assert facts["coverage"]["relocations_status"] == "complete", facts
                entries = [entry for table in facts["tables"] for entry in table["entries"]]
                assert len(entries) == len(expected), entries
                for actual, wanted in zip(entries, expected):
                    assert (actual["name"], actual["descriptor"], actual["function_address"]) == (
                        wanted["name"], wanted["descriptor"], wanted["function_address"])
                    for slot, oracle in zip(actual["slots"], wanted["slots"]):
                        assert slot["address"] == oracle["address"]
                        assert slot["file_offset"] == int(oracle["file_offset"], 16)
                        assert slot["value"] == oracle["resolved_word"]
                        assert slot["relocation"]["encoding"] == "relr"
                evidence = json.loads(run(node, str(root / "scripts/rea.mjs"),
                                          "inspect-native-initializers", str(library), "--json"))
                report = evidence["normalized_result"]
                constructor = next(entry for entry in report["entries"] if entry["kind"] == "init_array")
                assert constructor["resolution"] == "relr", report
                assert constructor["value_va"] == hex(elf.symbols["initialize"]["address"])
                assert constructor["slot_va"] in {hex(address) for address in elf.overlay}
                assert hashlib.sha256(library.read_bytes()).hexdigest() == digest
                results.append({"bits": bits, "tags": family, "jni_entries": len(entries),
                                "initializer": constructor["value_va"], "sha256": digest})
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--cc", default="gcc")
    parser.add_argument("--lld", default="ld.lld")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    print(json.dumps(verify(args.runtime_root.resolve(), args.cc, args.lld, args.node), indent=2))
