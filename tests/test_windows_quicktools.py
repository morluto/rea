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
import json
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import threading
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
PROMPT_TIMEOUT_S = 20.0


def _safe_close(proc):
    """Close the child's stdin, tolerating an already-broken pipe."""
    try:
        proc.stdin.close()
    except (OSError, ValueError):
        pass


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
        # A .cmd shim fallback would re-expand analyst text through CALL.
        self.assertNotIn("REA_CMD", content)
        # Install paths containing ! are refused before delayed expansion
        # starts, and the dispatch runs inside that scope with !RARGS! so
        # operator characters stay data without any endlocal in the flow.
        self.assertIn('"%NODE_EXE%" "%REA_ENTRY%" !REA_ARGS!', content)
        self.assertIn("NO_BANG", content)

    def test_leading_dash_terms_use_the_pattern_selector(self):
        content = BAT_PATH.read_text(encoding="utf-8")
        # Options-shaped terms route through the documented selector, quoting
        # the value inside our own quotes for the CLI's --pattern=<value> form.
        self.assertIn("--pattern=!SEARCH_TERM!", content)
        self.assertIn("--pattern=!PROC_TERM!", content)
        self.assertIn("--procedure=!FUNC_NAME!", content)
        # Ampersand-free values are dispatched inside our own quotes (one argv
        # entry for multiword needles); &-bearing values dispatch raw because
        # they cannot cross a cmd boundary intact.
        # The selector crosses to the child inside a quoted FOR-carrier
        # (bytes preserved, one argv entry).
        self.assertIn('for %%P in ("--pattern=!SEARCH_TERM!")', content)
        self.assertIn('for %%P in ("--pattern=!PROC_TERM!")', content)
        self.assertIn('for %%P in ("--procedure=!FUNC_NAME!")', content)


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
        # Run the menu inline so the feeder can drive its stdin; the desktop
        # console relaunch is for interactive users only.
        self.env["REA_TEST_INLINE"] = "1"

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
                # Detach in a helper thread: closing synchronously and then
                # calling communicate() races its own flush of the closed
                # stream (ValueError) on Windows.
                closer = threading.Thread(target=_safe_close, args=(proc,))
                closer.start()
                closer.join(timeout=10)
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
    def test_leading_dash_search_is_routed_through_pattern_selector(self):
        self.clear_log()
        target = self.tmp / "sample.dll"
        target.write_bytes(b"MZ")
        # Menu 3 -> path, menu 5 -> procedures search for "--help".
        self.assertSuccess(
            self.run_launcher(
                [
                    "3\r\n",
                    f"{target}\r\n",
                    "5\r\n",
                    "--help\r\n",
                    ".\r\n",
                    "7\r\n",
                    "5\r\n",
                ]
            )
        )
        dispatches = self.logged_dispatches()
        self.assertEqual(len(dispatches), 1, dispatches)
        payload = dispatches[0]
        self.assertIn('"search"', payload)
        self.assertIn('"procedures"', payload)
        # The dash term must travel as the --pattern selector value, not as a
        # positional the CLI would misparse as an option.
        self.assertIn("--pattern=--help", payload.replace(" ", ""))
        self.assertNotIn('"--help"', payload)

    @windows_only
    def test_thai_multiword_selector_arrives_as_one_argument(self):
        # Regression: an ASCII-only allowlist flagged Thai letters as
        # metacharacters and dispatched the value unquoted, so Node saw
        # two pattern positionals and rejected the surplus argument.
        self.clear_log()
        target = self.tmp / "sample.dll"
        target.write_bytes(b"MZ")
        needle = "เข้าสู่ ระบบ"
        result = self.run_launcher(
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
        self.assertSuccess(result)
        dispatches = self.logged_dispatches()
        self.assertEqual(len(dispatches), 1, dispatches)
        argv = json.loads(dispatches[0])
        # The whole phrase must be ONE argv entry, not split on the
        # space; the CLI sees exactly one pattern positional.
        self.assertIn(needle, argv, argv)
        self.assertEqual(argv.count(needle), 1, argv)

    @windows_only
    def test_operator_bearing_selector_arrives_as_one_argument(self):
        # Regression: the allowlist sent & -bearing selectors down the
        # raw path, where cmd split the value into several argv entries.
        # Operators stay DATA here: one exec, one argument, no redirect.
        self.clear_log()
        target = self.tmp / "sample.dll"
        target.write_bytes(b"MZ")
        needle = "a & b > c"
        result = self.run_launcher(
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
        self.assertSuccess(result)
        dispatches = self.logged_dispatches()
        self.assertEqual(len(dispatches), 1, dispatches)
        argv = json.loads(dispatches[0])
        self.assertIn(needle, argv, argv)

    @windows_only
    def test_bang_bearing_selector_is_refused_not_mangled(self):
        # '!' is consumed by delayed expansion on any batch line, so no
        # batch transport preserves it. Running an altered selector
        # silently searches for the wrong text; refuse instead.
        self.clear_log()
        target = self.tmp / "sample.dll"
        target.write_bytes(b"MZ")
        needle = "a!b"
        result = self.run_launcher(
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
        self.assertSuccess(result)
        self.assertEqual(len(self.logged_dispatches()), 0)
        self.assertIn("ERROR", result[1])

    @windows_only
    def test_wildcard_selector_is_refused_not_expanded(self):
        # A quoted FOR-set element with * or ? is a FILENAME SET: cmd
        # enumerates the current directory and runs DO once per match,
        # sending filenames instead of the needle. Verified: '*.dll'
        # beside the target produced TWO dispatches naming the files.
        self.clear_log()
        target = self.tmp / "sample.dll"
        target.write_bytes(b"MZ")
        (self.tmp / "evil-match.dll").write_bytes(b"MZ")
        needle = "*.dll"
        result = self.run_launcher(
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
        self.assertSuccess(result)
        # Nothing may run from a wildcard needle: the carrier would
        # enumerate the filesystem, so the launcher refuses up front.
        self.assertEqual(len(self.logged_dispatches()), 0)
        self.assertIn("ERROR", result[1])

    @windows_only
    def test_pasted_search_term_cannot_inject_commands(self):
        self.clear_log()
        target = self.tmp / "sample.dll"
        target.write_bytes(b"MZ")
        # Menu 3 -> paste path (no pause before the file menu), menu 4 ->
        # hostile needle with a quote, feed pause, 7 back, 5 exit. A quote
        # alters argv parsing under every batch transport, so the launcher
        # must refuse it explicitly (no dispatch, no altered selector).
        needle = 'x" & calc.exe & "y'
        result = self.run_launcher(
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
        self.assertSuccess(result)
        dispatches = self.logged_dispatches()
        self.assertEqual(len(dispatches), 0, dispatches)
        self.assertIn("ERROR", result[1])


if __name__ == "__main__":
    unittest.main()
