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
    def inspect(self, section_type, flags, section_stride=64):
        class Headers:
            header = types.SimpleNamespace(e_shoff=64, e_shentsize=section_stride, e_shstrndx=0)
            structs = types.SimpleNamespace(Elf_Shdr=types.SimpleNamespace(sizeof=lambda: 64))
            stream = object()

            def num_sections(self): return 2
            def num_segments(self): return 0
            def get_shstrndx(self): return 0
            def _get_section_header(self, index):
                return types.SimpleNamespace(sh_type="SHT_NULL" if index == 0 else section_type,
                                             sh_flags=0 if index == 0 else flags)

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
        modules["elftools.common.utils"].struct_parse = lambda _struct, _stream, stream_pos: Headers()._get_section_header((stream_pos - 64) // max(section_stride, 1))
        content = bytearray(64 + 2 * max(section_stride, 64))
        content[:7] = b"\x7fELF\x02\x01\x01"
        content[16:18] = (1).to_bytes(2, "little")  # ET_REL
        content[18:20] = (62).to_bytes(2, "little")
        content[40:48] = (64).to_bytes(8, "little")
        content[58:60] = section_stride.to_bytes(2, "little")
        content[60:62] = (2).to_bytes(2, "little")
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "object.snapshot"
            snapshot.write_bytes(content)
            with patch.dict(sys.modules, modules), patch.object(importlib.metadata, "version", side_effect=layout["PACKAGES"].__getitem__):
                return layout["inspect_elf"](snapshot, Path(directory) / "cache")

    def test_compressed_interpreted_storage_refuses_before_upstream_decoding(self):
        for section_type in ("SHT_STRTAB", "SHT_SYMTAB", "SHT_DYNSYM", "SHT_REL", "SHT_RELA", "SHT_RELR", "SHT_DYNAMIC"):
            with self.subTest(section_type=section_type):
                with self.assertRaises(layout["LayoutFailure"]) as raised:
                    self.inspect(section_type, 0x800)
                self.assertEqual(raised.exception.reason, "unsupported-target")
                self.assertIn("SHF_COMPRESSED", str(raised.exception))
                with self.assertRaises(UpstreamReached):
                    self.inspect(section_type, 0)

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
