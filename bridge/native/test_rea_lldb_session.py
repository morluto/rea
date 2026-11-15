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

        def GetError(self):
            return self._err

    fake_lldb.SBDebugger = MockSBDebugger
    fake_lldb.SBCommandReturnObject = MockSBCommandReturnObject
    fake_lldb.SBError = lambda: types.SimpleNamespace(Success=lambda: True, GetCString=lambda: "")
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

    def test_daemon_close_lifecycle(self):
        daemon = session_module.ReaLldbSessionDaemon()
        res = daemon.close()
        self.assertEqual(res["status"], "closed")


if __name__ == "__main__":
    unittest.main()
