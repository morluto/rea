"""Source-owned tests for the Unicorn bridge's hook and bound behavior.

Engine tests need unicorn 2.1.2 importable and are skipped otherwise (the
worker contract pins that version; the CI gate only requires the
mitmproxy/native/pwndbg bridge families). Validation and reply-size tests
run without the engine.

`run_emulation` installs process-wide resource limits, so engine tests
snapshot and restore them around every run: the test process is shared
with other bridge suites and must not keep a 60s CPU limit.
"""

import importlib.util
import os
import sys
import tempfile
import unittest

try:
    import unicorn
    import unicorn.x86_const as x86_const

    HAS_UNICORN = unicorn.__version__ == "2.1.2"
except ImportError:
    HAS_UNICORN = False

spec = importlib.util.spec_from_file_location(
    "emulate_function_impl",
    os.path.join(os.path.dirname(__file__), "emulate_function_impl.py"),
)
impl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(impl)

if HAS_UNICORN:
    impl.REGISTER_IDS = {
        "rax": x86_const.UC_X86_REG_RAX,
        "rbx": x86_const.UC_X86_REG_RBX,
        "rcx": x86_const.UC_X86_REG_RCX,
        "rdx": x86_const.UC_X86_REG_RDX,
        "rsi": x86_const.UC_X86_REG_RSI,
        "rdi": x86_const.UC_X86_REG_RDI,
        "rbp": x86_const.UC_X86_REG_RBP,
        "r8": x86_const.UC_X86_REG_R8,
        "r9": x86_const.UC_X86_REG_R9,
        "r10": x86_const.UC_X86_REG_R10,
        "r11": x86_const.UC_X86_REG_R11,
        "r12": x86_const.UC_X86_REG_R12,
        "r13": x86_const.UC_X86_REG_R13,
        "r14": x86_const.UC_X86_REG_R14,
        "r15": x86_const.UC_X86_REG_R15,
    }

CODE = 0x1000000
STACK = 0x7F000000
IMPORT = 0x3000000


def base_request(**overrides):
    request = {
        "architecture": "x86_64",
        "function_bytes": "",
        "code_address": "0x%x" % CODE,
        "registers": {},
        "memory": [],
        "stack_address": "0x%x" % STACK,
        "stack_size": 65536,
        "stubs": {},
        "stub_policy": "record",
        "budgets": {
            "instruction_cap": 1_000_000,
            "timeout_ms": 30_000,
            "address_space_bytes": 3 * 1024 * 1024 * 1024,
        },
    }
    request.update(overrides)
    return impl.validate_request(request)


def call_bytes(target):
    """E8 rel32 calling target from CODE, as hex."""
    offset = target - (CODE + 5)
    return "e8" + offset.to_bytes(4, "little", signed=True).hex()


@unittest.skipUnless(HAS_UNICORN, "unicorn 2.1.2 is required")
class UnicornEngineTests(unittest.TestCase):
    def setUp(self):
        try:
            import resource

            self._limits = {
                limit: resource.getrlimit(limit)
                for limit in (
                    resource.RLIMIT_AS,
                    resource.RLIMIT_CPU,
                    resource.RLIMIT_FSIZE,
                )
            }
            self._resource = resource
        except ImportError:
            self._limits = None

    def tearDown(self):
        if self._limits is not None:
            for limit, value in self._limits.items():
                try:
                    self._resource.setrlimit(limit, value)
                except (ValueError, OSError):
                    pass

    def run_request(self, request):
        # Snapshot and restore the process limits around the run itself;
        # setUp/tearDown provide the same guarantee at test boundaries.
        saved = None
        try:
            import resource

            saved = (
                resource,
                {
                    limit: resource.getrlimit(limit)
                    for limit in (
                        resource.RLIMIT_AS,
                        resource.RLIMIT_CPU,
                        resource.RLIMIT_FSIZE,
                    )
                },
            )
        except ImportError:
            pass
        try:
            return impl.run_emulation(unicorn, x86_const, request)
        finally:
            if saved is not None:
                module, values = saved
                for limit, value in values.items():
                    try:
                        module.setrlimit(limit, value)
                    except (ValueError, OSError):
                        pass
            # The hooks close over the Uc instance, forming a reference
            # cycle that refcounting alone cannot free; collect it so the
            # next run can reserve its translator buffer inside the cap.
            import gc

            gc.collect()

    def test_instruction_cap_reports_exactly_cap(self):
        req = base_request(
            function_bytes="90" * 15,
            budgets={
                "instruction_cap": 10,
                "timeout_ms": 30_000,
                "address_space_bytes": 3 * 1024 * 1024 * 1024,
            },
        )
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "instruction_budget_exhausted")
        self.assertEqual(reply["instructions_executed"], 10)

    def test_syscall_stop_policy_stops_instead_of_returning(self):
        # syscall; mov eax, 42; ret
        req = base_request(
            function_bytes="0f05b82a000000c3",
            registers={"rax": "0x3c"},
            stub_policy="stop",
        )
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "stubbed_call")
        self.assertEqual(len(reply["calls_hit"]), 1)
        self.assertEqual(reply["calls_hit"][0]["kind"], "syscall")
        self.assertEqual(reply["calls_hit"][0]["number"], 60)
        # The stop path never sets the stubbed return value.
        self.assertEqual(reply["registers"]["rax"], "0x3c")
        self.assertIsNone(reply["return_value"])

    def test_undeclared_import_returns_zero_and_records(self):
        # call IMPORT; mov eax, 42; ret
        req = base_request(function_bytes=call_bytes(IMPORT) + "b82a000000c3")
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "returned")
        self.assertEqual(reply["return_value"], "0x2a")
        self.assertEqual(len(reply["calls_hit"]), 1)
        call = reply["calls_hit"][0]
        self.assertEqual(call["kind"], "import")
        self.assertEqual(call["address"], "0x3000000")
        self.assertTrue(call["stubbed"])
        self.assertEqual(call["returned"], "0x0")

    def test_second_undeclared_import_on_same_page(self):
        # call IMPORT; call IMPORT+0x10; mov eax, 42; ret
        second = "e8" + (IMPORT + 0x10 - (CODE + 10)).to_bytes(
            4, "little", signed=True
        ).hex()
        req = base_request(
            function_bytes=call_bytes(IMPORT) + second + "b82a000000c3"
        )
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "returned")
        self.assertEqual(reply["return_value"], "0x2a")
        self.assertEqual(
            [call["address"] for call in reply["calls_hit"]],
            ["0x3000000", "0x3000010"],
        )
        self.assertTrue(
            all(call["returned"] == "0x0" for call in reply["calls_hit"])
        )

    def test_padding_write_is_reported(self):
        # mov byte ptr [rdi+1], 0xab; ret
        req = base_request(
            function_bytes="c64701abc3",
            registers={"rdi": "0x2000000"},
            memory=[{"address": "0x2000000", "bytes": "00"}],
        )
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "returned")
        self.assertFalse(reply["memory_diff_truncated"])
        writes = {
            write["address"]: write for write in reply["memory_writes"]
        }
        self.assertIn("0x2000001", writes)
        self.assertEqual(writes["0x2000001"]["after"], "ab")

    def test_full_64_bit_return_value_round_trips_as_hex(self):
        # movabs rax, 0xffffffffffffffff; ret — a JSON number cannot hold
        # this value exactly, so the reply must carry it as a hex string
        # (Greptile 2026-11-03 P1).
        req = base_request(function_bytes="48b8ffffffffffffffffc3")
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "returned")
        self.assertEqual(reply["return_value"], "0xffffffffffffffff")
        self.assertEqual(reply["registers"]["rax"], "0xffffffffffffffff")

    def test_call_records_are_capped_and_flagged(self):
        # mov ecx, 11000; loop: call IMPORT; sub ecx, 1; jnz loop; ret.
        # The declared stub records every call; retention stops at
        # MAX_CALL_RECORDS and the reply flags the truncation (Greptile
        # 2026-10-26 P1, partially fixed: the reply bound alone does not
        # stop the in-memory list from growing).
        req = base_request(
            function_bytes="b9f82a0000e8f6ffff0183e90175f6c3",
            stubs={"0x3000000": "0x0"},
        )
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "returned")
        self.assertTrue(reply["calls_truncated"])
        self.assertEqual(len(reply["calls_hit"]), impl.MAX_CALL_RECORDS)

    def test_declared_stub_still_returns_its_value(self):
        # call IMPORT; ret
        req = base_request(
            function_bytes=call_bytes(IMPORT) + "c3",
            stubs={"0x3000000": "0x7"},
        )
        reply = self.run_request(req)
        self.assertEqual(reply["stop_reason"], "returned")
        self.assertEqual(reply["return_value"], "0x7")
        self.assertEqual(len(reply["calls_hit"]), 1)
        self.assertEqual(reply["calls_hit"][0]["returned"], "0x7")


class UnicornValidationTests(unittest.TestCase):
    def test_small_stack_rejected(self):
        with self.assertRaises(impl.RequestError):
            base_request(function_bytes="c3", stack_size=7)

    def test_sentinel_page_region_rejected(self):
        with self.assertRaises(impl.RequestError):
            base_request(function_bytes="c3", code_address="0x0badf000")
        with self.assertRaises(impl.RequestError):
            base_request(function_bytes="c3", stack_address="0x0badf000")
        with self.assertRaises(impl.RequestError):
            base_request(
                function_bytes="c3", stubs={"0x0badf000": "0x0"}
            )

    def test_write_reply_refuses_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "reply.json")
            with self.assertRaises(impl.OutputTooLargeError):
                impl.write_reply(path, {"pad": "y" * (64 * 1024 * 1024)})
            self.assertFalse(os.path.exists(path))

    def test_resource_limits_apply_without_raising(self):
        # Smoke: installing the worker bounds must not fail the run setup.
        impl._apply_resource_limits(30_000)


if __name__ == "__main__":
    unittest.main()
