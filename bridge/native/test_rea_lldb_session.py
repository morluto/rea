"""Tests for the REA LLDB persistent session daemon.

Contributed by Hardik Shah <hardik05@gmail.com> (https://fuzzing.in, @hardik05).
"""

import importlib.util
import os
import sys
import types
import unittest

fake_lldb = sys.modules.setdefault("lldb", types.ModuleType("lldb"))
if not hasattr(fake_lldb, "SBDebugger"):
    class MockSBDebugger:
        @staticmethod
        def Initialize():
            pass

        @staticmethod
        def Create():
            return MockSBDebugger()

        @staticmethod
        def Destroy(debugger):
            pass

        @staticmethod
        def StateAsCString(state):
            return "stopped"

        def SetAsync(self, flag):
            pass

        def IsValid(self):
            return True

        def GetVersionString(self):
            return "lldb-mock-version"

        def GetCommandInterpreter(self):
            class CI:
                def HandleCommand(self, cmd, res):
                    res.SetOutput("mock output")
            return CI()

    class MockSBCommandReturnObject:
        def __init__(self):
            self._out = ""
            self._err = ""

        def SetOutput(self, val):
            self._out = val

        def GetOutput(self):
            return self._out

        def GetOutputSize(self):
            return len(self._out)

        def GetError(self):
            return self._err

        def GetErrorSize(self):
            return len(self._err)

        def SetImmediateOutputFile(self, f):
            pass

        def SetImmediateErrorFile(self, f):
            pass

        def flush(self):
            pass

    class MockSBError:
        def __init__(self, fail=False, message=""):
            self._fail = fail
            self._message = message

        def Fail(self):
            return self._fail

        def Success(self):
            return not self._fail

        def GetCString(self):
            return self._message

    fake_lldb.SBDebugger = MockSBDebugger
    fake_lldb.SBCommandReturnObject = MockSBCommandReturnObject
    fake_lldb.SBError = MockSBError
    fake_lldb.eStateExited = 10
    fake_lldb.eStateDetached = 11

spec = importlib.util.spec_from_file_location(
    "rea_lldb_session", os.path.join(os.path.dirname(__file__), "rea_lldb_session.py")
)
session_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session_module)


class ReaLldbSessionDaemonTests(unittest.TestCase):
    def test_daemon_initializes_and_reports_status(self):
        daemon = session_module.ReaLldbSessionDaemon()
        status = daemon.status()
        self.assertEqual(status["state"], "ready")

    def test_daemon_execute_command(self):
        daemon = session_module.ReaLldbSessionDaemon()
        res = daemon.execute_command("version")
        self.assertEqual(res["command"], "version")
        self.assertEqual(res["completion_status"], "complete")
        self.assertFalse(res["output_truncated"])

    def test_daemon_execute_command_preserves_whitespace(self):
        daemon = session_module.ReaLldbSessionDaemon()
        orig_ci = daemon.debugger.GetCommandInterpreter()
        class WhitespaceCI:
            def HandleCommand(self, cmd, res):
                res.SetOutput("   \n  0x1000: 90 90 \n\n  ")
        daemon.debugger.GetCommandInterpreter = lambda: WhitespaceCI()
        try:
            res = daemon.execute_command("disassemble")
            self.assertEqual(res["output"], "   \n  0x1000: 90 90 \n\n  ")
            self.assertEqual(res["completion_status"], "complete")
        finally:
            daemon.debugger.GetCommandInterpreter = lambda: orig_ci

    def test_daemon_execute_command_truncation(self):
        daemon = session_module.ReaLldbSessionDaemon()
        daemon.MAX_OUTPUT_CHARS = 10
        res = daemon.execute_command("version")
        self.assertEqual(res["command"], "version")
        self.assertTrue(res["output_truncated"])
        self.assertEqual(len(res["output"]), 10)

    def test_daemon_close_lifecycle_launched(self):
        daemon = session_module.ReaLldbSessionDaemon()
        daemon.is_attached = False
        class MockProcess:
            def IsValid(self): return True
            def GetState(self): return 5 # Running
            def Kill(self): return fake_lldb.SBError()
        daemon.process = MockProcess()
        res = daemon.close()
        self.assertEqual(res["status"], "closed")
        self.assertEqual(res["target_state"], "terminated")

    def test_daemon_close_lifecycle_attached(self):
        daemon = session_module.ReaLldbSessionDaemon()
        daemon.is_attached = True
        class MockProcess:
            def IsValid(self): return True
            def GetState(self): return 5 # Running
            def Detach(self): return fake_lldb.SBError()
        daemon.process = MockProcess()
        res = daemon.close()
        self.assertEqual(res["status"], "closed")
        self.assertEqual(res["target_state"], "detached")

    def test_daemon_close_lifecycle_kill_failed(self):
        daemon = session_module.ReaLldbSessionDaemon()
        daemon.is_attached = False
        class MockProcess:
            def IsValid(self): return True
            def GetState(self): return 5 # Running
            def Kill(self): return fake_lldb.SBError(fail=True, message="kill permission denied")
        daemon.process = MockProcess()
        res = daemon.close()
        self.assertEqual(res["status"], "failed")
        self.assertEqual(res["target_state"], "unknown")

    def test_daemon_close_lifecycle_detach_failed(self):
        daemon = session_module.ReaLldbSessionDaemon()
        daemon.is_attached = True
        class MockProcess:
            def IsValid(self): return True
            def GetState(self): return 5 # Running
            def Detach(self): return fake_lldb.SBError(fail=True, message="detach failed")
        daemon.process = MockProcess()
        res = daemon.close()
        self.assertEqual(res["status"], "failed")
        self.assertEqual(res["target_state"], "unknown")


    def test_bounded_pipe_capture_limits_and_truncates(self):
        capture = session_module._BoundedPipeCapture(16)
        # Write 64 bytes into the pipe
        os.write(capture.w_fd, b"0123456789abcdef" * 4)
        out, truncated = capture.finish()
        self.assertEqual(out, "0123456789abcdef")
        self.assertEqual(len(out), 16)
        self.assertTrue(truncated)

    def test_bounded_pipe_capture_exact_fit(self):
        capture = session_module._BoundedPipeCapture(16)
        os.write(capture.w_fd, b"0123456789abcdef")
        out, truncated = capture.finish()
        self.assertEqual(out, "0123456789abcdef")
        self.assertFalse(truncated)


if __name__ == "__main__":
    unittest.main()
