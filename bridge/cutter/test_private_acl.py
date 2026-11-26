"""The private ACL accepts SYSTEM when that SID is also the process user."""

import importlib.util
import os
import sys
import types
import unittest


def _install_host_stubs():
    cutter = types.ModuleType("cutter")
    cutter.CutterPlugin = type("CutterPlugin", (), {})
    sys.modules["cutter"] = cutter
    qtcore = types.ModuleType("PySide6.QtCore")
    qtcore.QObject = type("QObject", (), {})
    qtcore.Signal = lambda *_args: types.SimpleNamespace(connect=lambda _handler: None)
    qtcore.QCoreApplication = types.SimpleNamespace(applicationVersion=lambda: "Cutter test host")
    pyside = types.ModuleType("PySide6")
    pyside.QtCore = qtcore
    sys.modules["PySide6"] = pyside
    sys.modules["PySide6.QtCore"] = qtcore


_install_host_stubs()
spec = importlib.util.spec_from_file_location(
    "rea_cutter_bridge_acl", os.path.join(os.path.dirname(__file__), "rea_bridge.py")
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class PrivateAclTrusteeTests(unittest.TestCase):
    def test_system_user_satisfies_both_trustees(self):
        user, system = bridge._record_private_acl_trustee("S-1-5-18", "S-1-5-18", False, False)
        self.assertEqual((user, system), (True, True))

    def test_distinct_user_and_system_stay_separate(self):
        user, system = bridge._record_private_acl_trustee("S-1-5-21-1", "S-1-5-21-1", False, False)
        self.assertEqual((user, system), (True, False))
        user, system = bridge._record_private_acl_trustee("S-1-5-21-1", "S-1-5-18", user, system)
        self.assertEqual((user, system), (True, True))

    def test_unrelated_principal_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "unrelated principal"):
            bridge._record_private_acl_trustee("S-1-5-21-1", "S-1-5-21-2", False, False)


if __name__ == "__main__":
    unittest.main()
