"""Source-owned tests for the Hex-Rays IDA MCP query bridge.

The bridge runs inside IDA through execute_python. These tests execute it the
same way, as a script in a fresh namespace, against a small stand-in database
so reply shapes, paging and call classification are checked without IDA.
"""

import json
import os
import sys
import types
import unittest
from unittest import mock

SOURCE = os.path.join(os.path.dirname(__file__), "hexrays_queries.py")
BADADDR = 0xFFFFFFFFFFFFFFFF
XREF_FAR = 1


class Func:
    def __init__(self, start, end, name):
        self.start_ea, self.end_ea, self.name = start, end, name

    def size(self):
        return self.end_ea - self.start_ea


class StringItem:
    def __init__(self, ea, text):
        self.ea, self.text = ea, text

    def __str__(self):
        return self.text


class Xref:
    def __init__(self, frm, iscode, flow=False):
        self.frm, self.iscode, self.flow = frm, iscode, flow


FUNCS = [Func(0x1000, 0x1018, "main"), Func(0x2000, 0x2008, "helper")]
# address -> (text, is_call, code targets, data targets)
INSNS = {
    0x1000: ("push rbp", False, [], []),
    0x1004: ("call helper+4", True, [0x2004], []),
    0x1008: ("call cs:puts_ptr", True, [], [0x5000]),
    0x100C: ("call loc_3000", True, [0x3000], []),
    0x1010: ("call helper", True, [0x2000], []),
    # Inline data whose bytes decode as a call and that refers to an import.
    0x1014: ("dq offset exit", True, [], [0x5008]),
    0x2000: ("mov eax, 1", False, [], []),
    0x2004: ("retn", False, [], []),
}
DATA_HEADS = {0x1014}
IMPORTS = {0x5000: "puts", 0x5008: "exit"}
NAMES = {"main": 0x1000, "helper": 0x2000, "data_label": 0x4000}
XREFS = {0x2000: [Xref(0x1004, True), Xref(0x1ffc, True, flow=True), Xref(0x1004, True)]}
STRINGS = [(0x6000 + index, f"string {index}") for index in range(5)]
PSEUDOCODE = ["int main(void)", "{", "  helper();", "  return 0;", "}"]


def get_func(ea):
    return next((f for f in FUNCS if f.start_ea <= ea < f.end_ea), None)


def stand_ins():
    m = {name: types.ModuleType(name) for name in (
        "ida_auto", "ida_funcs", "ida_hexrays", "ida_idaapi", "ida_idp", "ida_lines",
        "ida_loader", "ida_nalt", "ida_name", "ida_segment", "ida_typeinf", "ida_ua",
        "ida_xref", "idautils", "idc",
    )}
    m["ida_auto"].auto_is_ok = lambda: True
    m["ida_idaapi"].BADADDR = BADADDR
    m["ida_funcs"].get_func = get_func
    m["ida_funcs"].get_func_name = lambda ea: next((f.name for f in FUNCS if f.start_ea == ea), "")
    m["ida_funcs"].get_func_qty = lambda: len(FUNCS)
    m["ida_funcs"].getn_func = lambda index: FUNCS[index]

    class DecompilationFailure(Exception):
        pass

    class Line:
        def __init__(self, line):
            self.line = line

    def decompile(ea):
        if ea != 0x1000:
            raise DecompilationFailure("decompilation failure at 0x2000")
        return types.SimpleNamespace(get_pseudocode=lambda: [Line(text) for text in PSEUDOCODE])

    m["ida_hexrays"].DecompilationFailure = DecompilationFailure
    m["ida_hexrays"].init_hexrays_plugin = lambda: True
    m["ida_hexrays"].decompile = decompile
    m["ida_lines"].tag_remove = lambda text: text
    m["ida_lines"].GENDSM_REMOVE_TAGS = 1
    m["ida_lines"].generate_disasm_line = lambda ea, flags: INSNS[ea][0]
    m["ida_loader"].PATH_TYPE_IDB = 1
    m["ida_loader"].get_path = lambda kind: "/private/input.i64"
    m["ida_nalt"].get_input_file_path = lambda: "/private/input"
    m["ida_nalt"].retrieve_input_file_sha256 = lambda: bytes.fromhex("ab" * 32)
    m["ida_nalt"].get_imagebase = lambda: 0x400000
    m["ida_nalt"].get_root_filename = lambda: "input"
    m["ida_nalt"].get_tinfo = lambda tif, ea: False
    m["ida_nalt"].get_import_module_qty = lambda: 1

    def enum_import_names(index, callback):
        for ea, name in IMPORTS.items():
            callback(ea, name, 0)

    m["ida_nalt"].enum_import_names = enum_import_names
    m["ida_name"].get_name_ea = lambda start, name: NAMES.get(name, BADADDR)
    m["ida_name"].get_name = lambda ea: {0x3000: "loc_3000"}.get(ea, "")
    segments = [types.SimpleNamespace(start_ea=0x1000, end_ea=0x3000, size=lambda: 0x2000)]
    m["ida_segment"].get_segm_qty = lambda: len(segments)
    m["ida_segment"].getnseg = lambda index: segments[index]
    m["ida_typeinf"].tinfo_t = object
    m["ida_typeinf"].GUESS_FUNC_OK = 1
    m["ida_typeinf"].guess_tinfo = lambda tif, ea: 0
    m["ida_typeinf"].func_type_data_t = object
    m["ida_ua"].insn_t = lambda: types.SimpleNamespace(ea=None)

    def decode_insn(insn, ea):
        insn.ea = ea
        return 4

    m["ida_ua"].decode_insn = decode_insn
    m["ida_idp"].is_call_insn = lambda insn: INSNS[insn.ea][1]
    m["ida_xref"].XREF_FAR = XREF_FAR
    m["idautils"].FuncItems = lambda start: [ea for ea in sorted(INSNS) if get_func(ea).start_ea == start]
    m["idautils"].CodeRefsFrom = lambda ea, flow: list(INSNS[ea][2])
    m["idautils"].DataRefsFrom = lambda ea: list(INSNS[ea][3])

    def xrefs_to(ea, flags=0):
        return [x for x in XREFS.get(ea, []) if not (flags & XREF_FAR and x.flow)]

    m["idautils"].XrefsTo = xrefs_to
    m["idautils"].Strings = lambda: [StringItem(ea, text) for ea, text in STRINGS]
    # Flags stand in for their address, so is_code can consult DATA_HEADS.
    m["idc"].get_full_flags = lambda ea: ea
    m["idc"].is_code = lambda flags: flags not in DATA_HEADS
    return m


class BridgeTest(unittest.TestCase):
    def setUp(self):
        modules = stand_ins()
        patcher = mock.patch.dict(sys.modules, modules)
        patcher.start()
        self.addCleanup(patcher.stop)
        with open(SOURCE, encoding="utf-8") as source:
            self.code = compile(source.read(), "<ida-mcp>", "exec")
        self.namespace = {}
        exec(self.code, self.namespace)

    def query(self, tool, arguments):
        # REA embeds JSON text in a Python string literal; json.dumps of a str
        # produces the same escapes JSON.stringify does for these inputs.
        line = f"_rea_query({json.dumps(tool)}, {json.dumps(json.dumps(arguments))})"
        return eval(line, self.namespace)

    def test_lookup_reports_entries_containment_and_missing_names(self):
        rows = self.query("lookup_funcs", {"queries": ["main", "0x2004", "data_label", "absent", 'a"\\\n ']})
        self.assertEqual(rows[0]["fn"], {"addr": "0x1000", "name": "main", "size": "0x18"})
        self.assertEqual(rows[1]["fn"]["addr"], "0x2000")
        self.assertEqual([row["error"] for row in rows[2:]], ["Not a function", "Not found", "Not found"])
        self.assertEqual(rows[4]["query"], 'a"\\\n ')

    def test_pages_advance_and_finish(self):
        first = self.query("decompile", {"addr": "0x1000", "offset": 0, "max_lines": 3})
        second = self.query("decompile", {"addr": "0x1000", "offset": 3, "max_lines": 3})
        self.assertEqual(first["cursor"], {"next": 3})
        self.assertEqual(second["cursor"], {"done": True})
        self.assertEqual(first["code"] + "\n" + second["code"], "\n".join(PSEUDOCODE))
        self.assertNotIn("error", first)
        functions = self.query("list_funcs", {"queries": {"offset": 1, "count": 5}})
        self.assertEqual(functions, [{"data": [{"addr": "0x2000", "name": "helper", "size": "0x8"}], "next_offset": None}])
        strings = self.query("find_regex", {"pattern": "(?s).*", "offset": 0, "limit": 4})
        self.assertEqual(strings["cursor"], {"next": 4})
        rest = self.query("find_regex", {"pattern": "(?s).*", "offset": 4, "limit": 4})
        self.assertEqual(rest, {"matches": [{"addr": "0x6004", "string": "string 4"}], "cursor": {"done": True}})

    def test_snapshot_retains_only_the_latest_enumeration(self):
        self.query("decompile", {"addr": "0x1000", "offset": 0, "max_lines": 1})
        self.query("disasm", {"addr": "0x1000", "offset": 0, "max_instructions": 1})
        self.assertEqual(list(self.namespace["_rea_pages"]), [("disasm", 0x1000)])

    def test_failures_are_explicit_rows(self):
        failed = self.query("decompile", {"addr": "0x2000", "offset": 0, "max_lines": 10})
        self.assertEqual(failed, {"code": None, "error": "decompilation failure at 0x2000", "cursor": {"done": True}})
        interior = self.query("disasm", {"addr": "0x1004", "offset": 0, "max_instructions": 10})
        self.assertEqual(interior["asm"], None)
        self.assertEqual(self.query("callees", {"addrs": ["0x1004"], "limit": 5}), [{"callees": None, "error": "Not a function"}])

    def test_callees_keep_every_direct_target(self):
        [row] = self.query("callees", {"addrs": ["0x1000"], "limit": 500})
        self.assertEqual(
            row,
            {
                "callees": [
                    {"addr": "0x2000", "name": "helper", "type": "internal"},
                    {"addr": "0x2004", "name": "helper", "type": "internal"},
                    {"addr": "0x3000", "name": "loc_3000", "type": "external"},
                    {"addr": "0x5000", "name": "puts", "type": "external"},
                ],
                "more": False,
            },
        )
        [capped] = self.query("callees", {"addrs": ["0x1000"], "limit": 1})
        self.assertTrue(capped["more"])
        self.assertEqual(len(capped["callees"]), 1)

    def test_callgraph_reports_function_entries_only(self):
        [row] = self.query("callgraph", {"roots": ["0x1000"], "max_depth": 0})
        # Interior, non-function and import targets are not graph edges.
        self.assertEqual(row["edges"], [{"from": "0x1000", "to": "0x2000", "type": "call"}])
        with self.assertRaises(ValueError):
            self.query("callgraph", {"roots": ["0x1000"], "max_depth": 1})

    def test_xrefs_exclude_ordinary_flow_and_duplicates(self):
        [row] = self.query("xrefs_to", {"addrs": ["0x2000"], "limit": 1000})
        self.assertEqual(
            row,
            {"xrefs": [{"addr": "0x1004", "type": "code", "fn": {"addr": "0x1000", "name": "main", "size": "0x18"}}], "more": False},
        )

    def test_health_and_survey_shapes(self):
        self.assertEqual(
            self.query("server_health", {}),
            {
                "status": "ok",
                "input_path": "/private/input",
                "input_sha256": "ab" * 32,
                "idb_path": "/private/input.i64",
                "imagebase": "0x400000",
                "auto_analysis_ready": True,
                "module": "input",
            },
        )
        # A database that recorded no input hash reports none, not an empty digest.
        sys.modules["ida_nalt"].retrieve_input_file_sha256 = lambda: None
        self.assertIsNone(self.query("server_health", {})["input_sha256"])
        survey = self.query("survey_binary", {"detail_level": "minimal"})
        self.assertEqual(survey["segments"], [{"start": "0x1000", "end": "0x3000", "size": "0x2000"}])
        self.assertEqual(survey["statistics"], {"total_segments": 1})


if __name__ == "__main__":
    unittest.main()
