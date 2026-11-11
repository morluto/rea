"""Producer admission regressions; no pwntools imports or target execution."""
from contextlib import nullcontext
import importlib.metadata
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


layout = runpy.run_path(str(Path(__file__).with_name("layout_impl.py")))


class UpstreamReached(RuntimeError):
    pass


class LayoutStorageTests(unittest.TestCase):
    def inspect(self, section_type, flags, section_stride=64, sections=None, shstrndx=0):
        described = sections if sections is not None else [
            types.SimpleNamespace(sh_type="SHT_NULL", sh_flags=0, sh_link=0),
            types.SimpleNamespace(sh_type=section_type, sh_flags=flags, sh_link=0),
        ]
        class Headers:
            header = types.SimpleNamespace(e_shoff=64, e_shentsize=section_stride, e_shstrndx=shstrndx)
            structs = types.SimpleNamespace(Elf_Shdr=types.SimpleNamespace(sizeof=lambda: 64))
            stream = object()

            def num_sections(self): return len(described)
            def num_segments(self): return 0
            def get_shstrndx(self): return self.header.e_shstrndx
            def _get_section_header(self, index):
                return described[index]

        class Elf:
            def __init__(self, *_args, **_kwargs):
                raise UpstreamReached("No artifact decoding or emulation is allowed in this test")

        modules = {name: types.ModuleType(name) for name in (
            "pwnlib", "pwnlib.context", "pwnlib.elf", "elftools", "elftools.common",
            "elftools.common.exceptions", "elftools.common.utils", "elftools.elf", "elftools.elf.elffile")}
        modules["pwnlib.context"].context = types.SimpleNamespace(local=lambda **_kwargs: nullcontext())
        modules["pwnlib.elf"].ELF = Elf
        modules["elftools.common.exceptions"].ELFError = type("ELFError", (Exception,), {})
        modules["elftools.elf.elffile"].ELFFile = lambda _stream: Headers()
        modules["elftools.common.utils"].struct_parse = lambda _struct, _stream, stream_pos: described[(stream_pos - 64) // max(section_stride, 1)]
        count = len(described)
        content = bytearray(64 + count * max(section_stride, 64))
        content[:7] = b"\x7fELF\x02\x01\x01"
        content[16:18] = (1).to_bytes(2, "little")  # ET_REL
        content[18:20] = (62).to_bytes(2, "little")
        content[40:48] = (64).to_bytes(8, "little")
        content[58:60] = section_stride.to_bytes(2, "little")
        content[60:62] = count.to_bytes(2, "little")
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "object.snapshot"
            snapshot.write_bytes(content)
            with patch.dict(sys.modules, modules), patch.object(importlib.metadata, "version", side_effect=layout["PACKAGES"].__getitem__):
                return layout["inspect_elf"](snapshot, Path(directory) / "cache")

    def test_compressed_interpreted_storage_refuses_before_upstream_decoding(self):
        for section_type in ("SHT_SYMTAB", "SHT_DYNSYM", "SHT_REL", "SHT_RELA", "SHT_RELR", "SHT_DYNAMIC"):
            with self.subTest(section_type=section_type):
                with self.assertRaises(layout["LayoutFailure"]) as raised:
                    self.inspect(section_type, 0x800)
                self.assertEqual(raised.exception.reason, "unsupported-target")
                self.assertEqual(raised.exception.args[0], f"ELF section 1 ({section_type}) is SHF_COMPRESSED; logical metadata and its source coordinates are not decoded by this profile.")
                with self.assertRaises(UpstreamReached):
                    self.inspect(section_type, 0)

    def test_unreferenced_compressed_string_table_remains_admitted(self):
        with self.assertRaises(UpstreamReached):
            self.inspect("SHT_STRTAB", 0x800)

    def test_consumed_compressed_string_tables_are_refused(self):
        name_table = [
            types.SimpleNamespace(sh_type="SHT_NULL", sh_flags=0, sh_link=0),
            types.SimpleNamespace(sh_type="SHT_STRTAB", sh_flags=0x800, sh_link=0),
        ]
        linked = [
            types.SimpleNamespace(sh_type="SHT_NULL", sh_flags=0, sh_link=0),
            types.SimpleNamespace(sh_type="SHT_SYMTAB", sh_flags=0, sh_link=2),
            types.SimpleNamespace(sh_type="SHT_STRTAB", sh_flags=0x800, sh_link=0),
        ]
        cases = (
            ("section-name", name_table, 1, 1),
            ("symbol-link", linked, 0, 2),
        )
        for label, sections, shstrndx, index in cases:
            with self.subTest(label=label):
                with self.assertRaises(layout["LayoutFailure"]) as raised:
                    self.inspect("SHT_NULL", 0, sections=sections, shstrndx=shstrndx)
                self.assertEqual(raised.exception.reason, "unsupported-target")
                self.assertEqual(
                    raised.exception.args[0],
                    f"ELF section {index} (SHT_STRTAB) is SHF_COMPRESSED; logical metadata and its source coordinates are not decoded by this profile.",
                )

    def test_uninterpreted_compressed_payload_does_not_change_admission(self):
        with self.assertRaises(UpstreamReached):
            self.inspect("SHT_PROGBITS", 0x800)

    def test_short_section_header_stride_refuses_before_raw_header_scan(self):
        for stride in (0, 1, 63):
            with self.subTest(stride=stride):
                with self.assertRaises(layout["LayoutFailure"]) as raised:
                    self.inspect("SHT_PROGBITS", 0, stride)
                self.assertEqual(raised.exception.reason, "format")
                self.assertIn("section-header entry", str(raised.exception))
        for stride in (64, 96):
            with self.subTest(stride=stride):
                with self.assertRaises(UpstreamReached):
                    self.inspect("SHT_PROGBITS", 0, stride)


if __name__ == "__main__":
    unittest.main()
