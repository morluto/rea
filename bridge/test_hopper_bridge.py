"""Source-owned unit tests for bridge/hopper_bridge.py."""

import json
from pathlib import Path
import unittest

BRIDGE_PATH = Path(__file__).resolve().parent / "hopper_bridge.py"


def load_bridge():
    namespace = {"__file__": str(BRIDGE_PATH), "__name__": "rea_hopper_bridge"}
    exec(compile(BRIDGE_PATH.read_text(encoding="utf-8"), str(BRIDGE_PATH), "exec"), namespace)
    return namespace


class FakeInstruction:
    def __init__(self, mnemonic, args=()):
        self.mnemonic = mnemonic
        self.args = args

    def getInstructionLength(self):
        return 4

    def getInstructionString(self):
        return self.mnemonic

    def getArgumentCount(self):
        return len(self.args)

    def getFormattedArgument(self, index):
        return self.args[index]


class FakeBlock:
    def __init__(self, start, end):
        self.start = start
        self.end = end

    def getStartingAddress(self):
        return self.start

    def getEndingAddress(self):
        return self.end

    def getSuccessorCount(self):
        return 0


class FakeProcedure:
    def __init__(self, entry, segment, insns, callees=(), calls=()):
        self.entry = entry
        self.segment = segment
        self.insns = insns
        self.block = FakeBlock(entry, entry + len(insns) * 4)
        self.block_iter_calls = 0
        self.callees = list(callees)
        self.calls = list(calls)

    def getEntryPoint(self):
        return self.entry

    def getSegment(self):
        return self.segment

    def basicBlockIterator(self):
        self.block_iter_calls += 1
        return [self.block]

    def getBasicBlockAtAddress(self, address):
        return self.block if self.block.start <= address < self.block.end else None

    def getBasicBlockCount(self):
        return 1

    def signatureString(self):
        return "void fn_%x()" % self.entry

    def getLocalVariableList(self):
        return []

    def getAllCallees(self):
        return self.calls

    def getAllCallers(self):
        return []

    def getAllCallerProcedures(self):
        return []

    def getAllCalleeProcedures(self):
        return self.callees

    def decompile(self):
        return "return;"


class FakeCall:
    def __init__(self, source, target, kind=2):
        self.source = source
        self.target = target
        self.kind = kind

    def fromAddress(self):
        return self.source

    def toAddress(self):
        return self.target

    def type(self):
        return self.kind


class FakeSegment:
    TYPE_ASCII = 1
    TYPE_UNICODE = 2

    def __init__(self, start, length, names, strings=(), procedures=()):
        self.start = start
        self.length = length
        self.names = dict(names)
        self.strings = dict(strings)
        self.procedures = list(procedures)
        self.instructions = {}
        self.refs_from = {}
        self.named_addresses_calls = 0
        self.name_lookup_calls = []
        self.forbid_full_name_scan = False

    def getStartingAddress(self):
        return self.start

    def getLength(self):
        return self.length

    def getNamedAddresses(self):
        self.named_addresses_calls += 1
        if self.forbid_full_name_scan:
            raise AssertionError("full name scan must not run")
        return list(self.names.keys())

    def getNameAtAddress(self, address):
        self.name_lookup_calls.append(address)
        return self.names.get(address)

    def getStringsList(self):
        return [(display, address) for address, (display, _) in self.strings.items()]

    def getObjectLength(self, address):
        return len(self.strings[address][1])

    def readBytes(self, address, length):
        return self.strings[address][1][:length]

    def getTypeAtAddress(self, address):
        return FakeSegment.TYPE_ASCII

    def getProcedureCount(self):
        return len(self.procedures)

    def getProcedureAtIndex(self, index):
        return self.procedures[index]

    def getProcedureAtAddress(self, address):
        for proc in self.procedures:
            if proc.block.start <= address < proc.block.end:
                return proc
        return None

    def getInstructionAtAddress(self, address):
        return self.instructions.get(address)

    def getCommentAtAddress(self, address):
        return None

    def getInlineCommentAtAddress(self, address):
        return None

    def getReferencesFromAddress(self, address):
        return self.refs_from.get(address, [])

    def getReferencesOfAddress(self, address):
        return []


class FakeDocument:
    def __init__(self, segments, symbol_map=None):
        self.segments = list(segments)
        self.symbol_map = dict(symbol_map or {})

    def getSegmentsList(self):
        return self.segments

    def getSegmentAtAddress(self, address):
        for segment in self.segments:
            if segment.start <= address < segment.start + segment.length:
                return segment
        return None

    def getAddressForName(self, name):
        return self.symbol_map.get(name, -1)


class FakeApi:
    def require_analysis_complete(self, document, method):
        pass


class HopperBridgeTest(unittest.TestCase):
    def test_analyze_function_looks_up_outgoing_names_directly_and_reuses_addresses(self):
        bridge = load_bridge()
        names = {
            0x1000: "caller_fn",
            0x2000: "helper_target",
            0x2100: "",
            0x3000: "unrelated_name",
        }
        strings = {0x2200: ("hello", b"hello\x00")}
        seg = FakeSegment(0x1000, 0x3000, names, strings=strings)
        seg.forbid_full_name_scan = True
        proc = FakeProcedure(0x1000, seg, [0x1000, 0x1004, 0x1008, 0x100C])
        seg.procedures.append(proc)
        seg.instructions = {
            0x1000: FakeInstruction("bl", ("helper_target",)),
            0x1004: FakeInstruction("bl", ("helper_target",)),
            0x1008: FakeInstruction("adrp", ("hello",)),
            0x100C: FakeInstruction("ret"),
        }
        # Include repeated target 0x2000, empty-string name 0x2100, and unmapped target 0x99990.
        seg.refs_from[0x1000] = [0x2000, 0x99990]
        seg.refs_from[0x1004] = [0x2000, 0x2100]
        seg.refs_from[0x1008] = [0x2200]
        doc = FakeDocument([seg])

        dossier = bridge["_analyze_function"](doc, {"procedure": "0x1000"})

        self.assertEqual(seg.named_addresses_calls, 0)
        # _instruction_addresses runs once inside _analyze_function; _assembly_lines reuses it.
        # Note basicBlockIterator is called once in _instruction_addresses and once for CFG blocks.
        self.assertEqual(proc.block_iter_calls, 2)
        self.assertEqual(
            dossier["assembly"],
            [
                "0x1000: bl helper_target",
                "0x1004: bl helper_target",
                "0x1008: adrp hello",
                "0x100c: ret",
            ],
        )
        self.assertEqual(
            dossier["referenced_names"],
            [
                {"address": "0x2000", "value": "helper_target", "source_address": "0x1000"},
                {"address": "0x2000", "value": "helper_target", "source_address": "0x1004"},
                {"address": "0x2100", "value": "", "source_address": "0x1004"},
            ],
        )
        self.assertEqual(len(dossier["referenced_strings"]), 1)
        self.assertEqual(dossier["referenced_strings"][0]["value"], "hello")
        # 0x2000 was referenced twice, but looked up only once after deduplication.
        self.assertEqual(seg.name_lookup_calls.count(0x2000), 1)

    def test_analyze_function_leaf_skips_string_and_name_scans(self):
        bridge = load_bridge()
        seg = FakeSegment(0x1000, 0x1000, {0x1000: "leaf"}, strings={0x1800: ("unused", b"unused\x00")})
        seg.forbid_full_name_scan = True
        seg.getStringsList = lambda: (_ for _ in ()).throw(AssertionError("leaf should not scan strings"))
        proc = FakeProcedure(0x1000, seg, [0x1000])
        seg.procedures.append(proc)
        seg.instructions = {0x1000: FakeInstruction("ret")}
        doc = FakeDocument([seg])

        dossier = bridge["_analyze_function"](doc, {"procedure": "0x1000"})

        self.assertEqual(dossier["referenced_strings"], [])
        self.assertEqual(dossier["referenced_names"], [])
        self.assertEqual(seg.named_addresses_calls, 0)

    def test_list_names_with_address_avoids_full_inventory_scan(self):
        bridge = load_bridge()
        seg = FakeSegment(
            0x1000,
            0x1000,
            {0x1000: "alpha", 0x1020: "", 0x1040: "beta"},
        )
        seg.forbid_full_name_scan = True
        doc = FakeDocument([seg], symbol_map={"alpha": 0x1000})
        bridge["_api"] = lambda: FakeApi()
        bridge["_document"] = lambda name=None: doc

        self.assertEqual(
            bridge["_dispatch"]("list_names", {"address": "0x1000"}),
            [{"address": "0x1000", "value": "alpha"}],
        )
        self.assertEqual(
            bridge["_dispatch"]("list_names", {"address": "alpha"}),
            [{"address": "0x1000", "value": "alpha"}],
        )
        self.assertEqual(
            bridge["_dispatch"]("list_names", {"address": "0x1020"}),
            [{"address": "0x1020", "value": ""}],
        )
        self.assertEqual(bridge["_dispatch"]("list_names", {"address": "0x1010"}), [])
        self.assertEqual(bridge["_dispatch"]("list_names", {"address": "0x900000"}), [])
        with self.assertRaises(bridge["InvalidRequestError"]):
            bridge["_dispatch"]("list_names", {"address": "file-offset:0x0"})
        with self.assertRaises(bridge["InvalidRequestError"]):
            bridge["_dispatch"]("list_names", {"address": True})
        self.assertEqual(seg.named_addresses_calls, 0)

        seg.forbid_full_name_scan = False
        self.assertEqual(
            bridge["_dispatch"]("list_names", {}),
            [
                {"address": "0x1000", "value": "alpha"},
                {"address": "0x1020", "value": ""},
                {"address": "0x1040", "value": "beta"},
            ],
        )

    def test_json_ascii_bytes_and_caller_scan_page_match_json_dumps_exactly(self):
        bridge = load_bridge()
        samples = [
            None,
            True,
            False,
            0,
            -123456,
            "plain ascii",
            'quotes " and \\ slashes \b\f\n\r\t',
            "\x00\x0b\x1f\x7f\u0080\u2026\uffff😀",
            [],
            {},
            {"a": [1, True, None, "😀"], "b\n": {"nested": "\\"}},
            ("tuple", 42),
        ]
        for value in samples:
            self.assertEqual(
                bridge["_json_ascii_bytes"](value),
                len(json.dumps(value, ensure_ascii=True).encode("utf-8")),
                msg=f"mismatch for {value!r}",
            )

        seg = FakeSegment(0x1000, 0x2000, {0x1000: 'fn_"😀"\\a', 0x1100: "callee_fn"})
        callee_proc = FakeProcedure(0x1100, seg, [0x1100])
        caller_proc = FakeProcedure(
            0x1000,
            seg,
            [0x1000],
            callees=[callee_proc],
            calls=[FakeCall(0x1000, 0x1100, 2)],
        )
        seg.procedures.extend([caller_proc, callee_proc])
        doc = FakeDocument([seg])

        page = bridge["_caller_scan_page"](doc, {"start": 0})
        self.assertFalse(page["oversized"])
        self.assertEqual(page["next"], 2)
        self.assertEqual(len(page["items"][0]["references"]), 1)

        # Exceed CALLER_SCAN_ALLOWANCE_BYTES with escaped/non-ASCII text to test boundary parity.
        seg.names[0x1000] = "😀" * 50000
        oversized = bridge["_caller_scan_page"](doc, {"start": 0})
        self.assertTrue(oversized["oversized"])
        self.assertEqual(oversized["next"], 0)
        self.assertEqual(oversized["items"], [])

    def test_search_inventory_orders_numerically_across_segments_and_json_safe_reuses_clean_trees(self):
        bridge = load_bridge()
        high = FakeSegment(0x10000, 0x100, {0x10004: "high_name"}, strings={0x10010: ("s_high", b"s_high\x00")})
        low = FakeSegment(0x900, 0x100, {0x904: "low_name"}, strings={0x910: ("s_low", b"s_low\x00")})
        doc = FakeDocument([high, low])
        bridge["_api"] = lambda: FakeApi()
        bridge["_document"] = lambda name=None: doc

        self.assertEqual(
            [row["address"] for row in bridge["_dispatch"]("list_names", {})],
            ["0x904", "0x10004"],
        )
        self.assertEqual(
            [row["address"] for row in bridge["_dispatch"]("list_strings", {})],
            ["0x910", "0x10010"],
        )
        self.assertEqual(
            bridge["_dispatch"]("list_strings", {"address": "0x910"}),
            [row for row in bridge["_dispatch"]("list_strings", {}) if row["address"] == "0x910"],
        )

        clean = [{"address": "0x904", "value": "low_name", "nested": [1, True, None]}]
        self.assertIs(bridge["_json_safe"](clean), clean)
        self.assertIs(bridge["_json_safe"](clean[0]), clean[0])

        class Custom:
            def __str__(self):
                return "custom-value"

        dirty = [{"ok": 1}, {1: ("x", Custom())}]
        projected = bridge["_json_safe"](dirty)
        self.assertIsNot(projected, dirty)
        self.assertIs(projected[0], dirty[0])
        self.assertEqual(projected[1], {"1": ["x", "custom-value"]})
        self.assertEqual(bridge["_json_safe"]({"1": "a", 1: "b"}), {"1": "b"})


if __name__ == "__main__":
    unittest.main()
