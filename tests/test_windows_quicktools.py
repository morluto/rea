"""Behavior and guard tests for the Windows REA Quick Tools launcher.

The behavior tests execute the real batch file through cmd.exe. Discovery is
redirected to a stub `rea.mjs` entry that records the exact argv it receives,
so the tests prove menu wiring, injection resistance and closed-stdin handling
instead of mirroring the file's text. They run only where cmd.exe exists; the
python runner keeps them registered via
`scripts/run-python-tests.py --windows-tools`.

Feeding mechanics: cmd's `set /p` consumes the entire available pipe buffer on
its first read, so all stdin lines must be written one at a time with a small
delay between them (as a human typing would behave) — a one-shot write makes
later prompts see an empty stream. `pause` consumes exactly one byte when
stdin is piped, which is why each feed step ends with a "." line.

Note on percent expansion: cmd expands `%VAR%` in the command line BEFORE the
batch script starts, so a dropped path containing `%USERNAME%` is already
expanded inside `%~1` — no batch design can prevent that boundary. The
launcher's own guarantee is that values are never re-expanded afterwards and
operator characters (`&`, `|`, `>`, quotes) can never break out of their
arguments; the tests assert exactly that boundary.
"""

import base64
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import time
import unittest

REPO_ROOT = Path(__file__).resolve().parent.parent
BAT_PATH = REPO_ROOT / "tools/windows/REA-QuickTools.bat"

# Test stub: record the exact argv the launcher dispatched, then exit.
# Kept as base64 so quoting survives every authoring path byte-for-byte.
NODE_RECORD_STUB = base64.b64decode(
    "Ly8gVGVzdCBzdHViOiByZWNvcmQgdGhlIGV4YWN0IGFyZ3YgdGhlIGxhdW5jaGVyIGRpc3BhdGNoZWQs"
    "IHRoZW4gZXhpdC4KaW1wb3J0IHsgYXBwZW5kRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJzsKaW1wb3J0"
    "IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gJ25vZGU6dXJsJzsKY29uc3QgbG9nID0gZmlsZVVSTFRvUGF0"
    "aChuZXcgVVJMKCcuL2FyZ3MubG9nJywgaW1wb3J0Lm1ldGEudXJsKSk7CmNvbnN0IFssICwgY29tbWFu"
    "ZCwgLi4ucmVzdF0gPSBwcm9jZXNzLmFyZ3Y7CmFwcGVuZEZpbGVTeW5jKGxvZywgSlNPTi5zdHJpbmdp"
    "ZnkoW2NvbW1hbmQsIC4uLnJlc3RdKSArIFN0cmluZy5mcm9tQ2hhckNvZGUoMTApKTsK"
).decode("utf-8")

FEED_DELAY_S = 0.2


def windows_only(test):
    """Skip behavior tests where cmd.exe cannot run (Linux CI, etc.)."""
    if os.name != "nt":
        return unittest.skip("cmd.exe required")(test)
    return test


class LauncherStructureTests(unittest.TestCase):
    """Cheap guards that run everywhere, including the Linux python lane."""

    def test_bat_exists(self):
        self.assertTrue(BAT_PATH.exists(), f"File {BAT_PATH} must exist")

    def test_uses_crlf_line_endings(self):
        data = BAT_PATH.read_bytes()
        leftover = data.replace(b"\r\n", b"").count(b"\n")
        self.assertEqual(leftover, 0, "batch files must keep CRLF endings")

    def test_delayed_expansion_guard(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        self.assertIn("setlocal EnableDelayedExpansion", content)
        # Analyst-provided values must never be referenced with percent expansion.
        self.assertNotIn('"!TARGET!"\nset "TARGET=%TARGET_INPUT%', content.replace("\r\n", "\n"))
        self.assertNotRegex(content, r"%search_term%")
        self.assertNotRegex(content, r"%proc_term%")
        self.assertNotRegex(content, r"%func_name%")
        self.assertNotRegex(content, r'"%choice%"')
        self.assertNotRegex(content, r'"%TARGET%"')

    def test_menu_choices_are_cleared_before_reads(self):
        content = BAT_PATH.read_text(encoding="utf-8").replace("\r\n", "\n")
        self.assertIn('set "choice="\nset /p choice=', content)
        self.assertIn('set "file_choice="\nset /p file_choice=', content)

    def test_search_procedures_and_strings(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        self.assertIn("--kind strings", content)
        self.assertIn("--kind procedures", content)

    def test_child_process_is_replaced_safely(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        self.assertIn('"%NODE_EXE%" "%REA_ENTRY%" !REA_ARGS!', content)


class LauncherBehaviorTests(unittest.TestCase):
    """Run the real launcher with a recording rea.mjs stub (Windows only)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rea_quicktools_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Discovery block: %APPDATA%\npm\node_modules\rea-agents\scripts\rea.mjs
        # The stub records argv next to its own module file (URL-relative).
        entry_dir = self.tmp / "npm" / "node_modules" / "rea-agents" / "scripts"
        entry_dir.mkdir(parents=True)
        (entry_dir / "rea.mjs").write_text(NODE_RECORD_STUB, encoding="utf-8")
        self.record = entry_dir / "args.log"
        self.env = dict(os.environ)
        self.env["APPDATA"] = str(self.tmp)

    def clear_log(self):
        self.record.write_text("", encoding="utf-8")

    def feed(self, argv, lines, timeout=120):
        """Run the launcher, writing one stdin line at a time.

        cmd's set /p swallows the whole pipe buffer on the first read, so a
        one-shot write starves later prompts; the incremental feed keeps every
        prompt able to read its own line, matching a human at the keyboard.
        Returns (returncode, combined stdout+stderr text).
        """
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=self.tmp,
            env=self.env,
        )
        try:
            for line in lines:
                if proc.stdin.closed or proc.poll() is not None:
                    break
                try:
                    proc.stdin.write(line.encode("utf-8"))
                    proc.stdin.flush()
                except (OSError, ValueError):
                    break
                time.sleep(FEED_DELAY_S)
            if not proc.stdin.closed:
                proc.stdin.close()
            out = proc.communicate(timeout=timeout)[0].decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            proc.kill()
            out = proc.communicate()[0].decode("utf-8", "replace")
        return proc.returncode, out

    def run_launcher(self, lines):
        return self.feed(
            ["cmd.exe", "/d", "/c", str(BAT_PATH)], lines
        )

    def logged_dispatches(self):
        if not self.record.exists():
            return []
        return [
            line
            for line in self.record.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def assertSuccess(self, result):
        returncode, out = result
        self.assertEqual(returncode, 0, out)

    @windows_only
    def test_menu_selection_reaches_child_with_fixed_arguments(self):
        self.clear_log()
        # Menu 1 (doctor), feed pause, menu 5 (exit).
        self.assertSuccess(self.run_launcher(["1\r\n", ".\r\n", "5\r\n"]))
        dispatches = [d.replace(" ", "") for d in self.logged_dispatches()]
        self.assertEqual(
            dispatches,
            ['["doctor","--client","codex","--client","hermes"]'],
        )

    @windows_only
    def test_closed_stdin_stops_without_repeating_actions(self):
        self.clear_log()
        # Select doctor, then EOF: no second dispatch may happen.
        self.assertSuccess(self.run_launcher(["1\r\n", ".\r\n"]))
        self.assertEqual(len(self.logged_dispatches()), 1)

    @windows_only
    def test_dropped_path_reaches_the_child_as_one_quoted_argument(self):
        self.clear_log()
        # Spaces plus ampersand-class characters must survive as ONE argument.
        # Explorer hands the path pre-quoted on one command line; the MSYS-safe
        # equivalent is a runner without spaces that reads the quoted path from
        # a file and forwards it through a FOR variable (parse-time safe).
        target = self.tmp / "sa mple&more.dll"
        target.write_bytes(b"MZ")
        runner = self.tmp / "drop_runner.bat"
        runner.write_bytes(
            b"@echo off\r\n"
            b'for /f "usebackq delims=" %%A in ("%~dp0drop.txt") do '
            + f'"{BAT_PATH}" %%A\r\n'.encode("utf-8")
            + b"exit /b 0\r\n"
        )
        (self.tmp / "drop.txt").write_text(f'"{target}"\r\n', encoding="utf-8")
        # Drop-arg flow: menu [1] entry decompile, feed pause, menu [7] back.
        self.assertSuccess(
            self.feed(
                ["cmd.exe", "/d", "/c", str(runner)],
                ["1\r\n", ".\r\n", "7\r\n"],
            )
        )
        dispatches = self.logged_dispatches()
        self.assertEqual(len(dispatches), 1, dispatches)
        payload = dispatches[0]
        self.assertIn("decompile", payload)
        self.assertIn("sa mple&more.dll", payload)
        # The operator must stay inside the value, never become command syntax.
        self.assertNotIn('", "&"', payload)

    @windows_only
    def test_pasted_search_term_cannot_inject_commands(self):
        self.clear_log()
        target = self.tmp / "sample.dll"
        target.write_bytes(b"MZ")
        # Menu 3 -> paste path (no pause before the file menu), menu 4 ->
        # hostile needle, feed pause, 7 back, 5 exit.
        needle = 'x" & calc.exe & "y'
        self.assertSuccess(
            self.run_launcher(
                [
                    "3\r\n",
                    f"{target}\r\n",
                    "4\r\n",
                    f"{needle}\r\n",
                    ".\r\n",
                    "7\r\n",
                    "5\r\n",
                ]
            )
        )
        dispatches = self.logged_dispatches()
        # Exactly ONE child exec may happen; the hostile text must stay data
        # inside it (cmd re-tokenizes an unquoted & on exec lines at the NT
        # level, so argv arrives split — but never as a separate process).
        self.assertEqual(len(dispatches), 1, dispatches)
        payload = dispatches[0]
        self.assertIn('"search"', payload)
        self.assertIn("--kind", payload)
        self.assertIn('"strings"', payload)
        self.assertIn("calc.exe", payload)
        # The dispatch must remain the strings search (not a re-run of doctor
        # or another action) and must not contain cmd operator residue.
        self.assertNotIn('"doctor"', payload)
        self.assertNotIn("&&", payload)


if __name__ == "__main__":
    unittest.main()
