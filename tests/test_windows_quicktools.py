import os
import re
import unittest
from pathlib import Path

BAT_PATH = Path("tools/windows/REA-QuickTools.bat")

class TestWindowsQuickTools(unittest.TestCase):
    def test_bat_exists(self):
        self.assertTrue(BAT_PATH.exists(), f"File {BAT_PATH} must exist")

    def test_chcp_utf8(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        self.assertIn("chcp 65001", content, "BAT script must set code page 65001 for UTF-8")

    def test_env_fallbacks(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        self.assertIn("GHIDRA_INSTALL_DIR", content, "Script must check/set GHIDRA_INSTALL_DIR")
        self.assertIn("JAVA_HOME", content, "Script must check/set JAVA_HOME")

    def test_safe_target_quoting(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        # Check that TARGET is set cleanly from %~1 without outer extra quotes
        self.assertRegex(content, r'set\s+"TARGET=%~1"', 'Should use set "TARGET=%~1" pattern')
        # Check that rea decompile quotes "%TARGET%"
        self.assertIn('decompile "%TARGET%"', content, 'decompile must quote "%TARGET%"')
        self.assertIn('inspect-pe-resources "%TARGET%"', content, 'inspect-pe-resources must quote "%TARGET%"')

    def test_search_procedures_and_strings(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        self.assertIn('--kind strings', content, 'Should support searching strings')
        self.assertIn('--kind procedures', content, 'Should support searching procedures')

if __name__ == "__main__":
    unittest.main()
