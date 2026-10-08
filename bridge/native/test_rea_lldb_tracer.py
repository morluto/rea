"""Source-owned tests for the LLDB bridge's bounded retention helpers."""

import importlib.util
import os
import sys
import tempfile
import types
import unittest


fake_lldb = sys.modules.setdefault("lldb", types.ModuleType("lldb"))
fake_lldb.LLDB_INVALID_ADDRESS = -1
fake_lldb.eLaunchFlagDebug = 2
fake_lldb.eLaunchFlagStopAtEntry = 4
spec = importlib.util.spec_from_file_location(
    "rea_lldb_tracer", os.path.join(os.path.dirname(__file__), "rea_lldb_tracer.py")
)
tracer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tracer)


class NativeTraceBudgetTests(unittest.TestCase):
    def test_aggregate_trace_budget_admits_exact_boundary_and_rejects_next_record(self):
        self.assertTrue(
            tracer._can_retain_trace(
                tracer.MAX_TRACE_BYTES - 10,
                tracer.MAX_TRACE_FRAMES - 2,
                10,
                2,
            )
        )
        self.assertFalse(
            tracer._can_retain_trace(
                tracer.MAX_TRACE_BYTES - 10,
                tracer.MAX_TRACE_FRAMES - 2,
                11,
                2,
            )
        )
        self.assertFalse(
            tracer._can_retain_trace(
                tracer.MAX_TRACE_BYTES - 10,
                tracer.MAX_TRACE_FRAMES - 2,
                10,
                3,
            )
        )

    def test_oversized_producer_string_is_rejected_before_serialization(self):
        self.assertTrue(tracer._fits_trace_budget("method", 1024))
        self.assertFalse(tracer._fits_trace_budget("m" * 2048, 1024))
        self.assertGreater(
            tracer._estimated_json_size("🙂"), len('"🙂"'.encode("utf-8"))
        )

    def test_launch_flags_preserve_default_debug_and_stop_at_entry(self):
        class Launch:
            flags = 10

            def GetLaunchFlags(self):
                return self.flags

            def SetLaunchFlags(self, flags):
                self.flags = flags

        launch = Launch()
        tracer._set_launch_flags(launch)
        self.assertEqual(launch.flags, 14)

    def test_output_pipe_counts_all_bytes_and_keeps_only_the_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo = os.path.join(directory, "stdout.fifo")
            capture = os.path.join(directory, "stdout.capture")
            sink = tracer._OutputPipe(fifo, capture, 5)
            sink.start()
            sink.mark_launched()
            writer = os.open(fifo, os.O_WRONLY)
            try:
                for index in range(100):
                    chunk = (b"hello world" if index == 0 else b"x" * 4096)
                    os.write(writer, chunk)
            finally:
                os.close(writer)
            sink.drain()
            sink.close(expected_exit=True)
            with open(capture, "rb") as retained:
                self.assertEqual(retained.read(), b"hello")
            self.assertEqual(sink.bytes, 11 + 99 * 4096)
            self.assertTrue(sink.truncated)
            self.assertTrue(sink.complete)

    def test_output_pipe_reports_incomplete_capture_after_unexpected_close(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo = os.path.join(directory, "stdout.fifo")
            capture = os.path.join(directory, "stdout.capture")
            sink = tracer._OutputPipe(fifo, capture, 5)
            sink.start()
            sink.mark_launched()
            sink.close(expected_exit=False)
            self.assertFalse(sink.complete)
            self.assertTrue(sink.truncated)

    def test_selector_location_report_uses_the_requested_method_type(self):
        class Symbol:
            def IsValid(self):
                return True

            def GetName(self):
                return "+[Greeter shared]"

        class FileSpec:
            def GetFilename(self):
                return "Fixture"

            def __str__(self):
                return "/tmp/Fixture"

        class Module:
            def IsValid(self):
                return True

            def GetFileSpec(self):
                return FileSpec()

        class Address:
            def GetModule(self):
                return Module()

            def GetSymbol(self):
                return Symbol()

            def GetFileAddress(self):
                return 1

            def GetLoadAddress(self, target):
                return 2

        class Location:
            def GetAddress(self):
                return Address()

        class Breakpoint:
            def GetNumLocations(self):
                return 1

            def GetLocationAtIndex(self, index):
                return Location()

        report = tracer._breakpoint_report(
            object(),
            [[Breakpoint()]],
            {
                "breakpoints": [
                    {
                        "kind": "objc-method",
                        "selector": "shared",
                        "method_type": "instance",
                    }
                ]
            },
        )
        self.assertEqual(report[0]["location_count"], 0)
        self.assertEqual(report[0]["locations"], [])


if __name__ == "__main__":
    unittest.main()
