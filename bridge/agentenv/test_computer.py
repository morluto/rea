"""Exercise the real computer helper with a local deployment-result fixture, never a live computer."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest


HELPER = Path(__file__).with_name("computer.py")
PACKAGE = '''from pathlib import Path
from types import SimpleNamespace as S
import os

def run_bundle(*args, **kwargs):
    env = S(environment_url="http://127.0.0.1:1", mcp_url="http://127.0.0.1:1/mcp",
            control_token=None, sandbox_id="fixture")
    run = S(error=None, failed_steps=[], context=S(deployed_envs=[env]))
    class Result:
        runs = [run] if not os.environ.get("NO_COMPUTER") else []
        def teardown(self):
            with Path(os.environ["DOWN_FILE"]).open("a") as output:
                output.write("completed\\n")
            remaining = ["fixture"] if os.environ.get("STILL_UP") else []
            return S(runs=[S(torn_down=S(still_up=remaining))])
    return Result()
'''

# Windows cannot deliver an external POSIX SIGTERM with Popen.send_signal.
# Raise it in CPython after the real helper installed both handlers instead.
WINDOWS_SIGNAL = '''import runpy, signal, sys, threading
helper, signum, bundle = sys.argv[1], int(sys.argv[2]), sys.argv[3]
original = signal.signal
def install(signum, handler):
    previous = original(signum, handler)
    if signum == signal.SIGINT:
        threading.Timer(0.5, lambda: signal.raise_signal(requested)).start()
    return previous
signal.signal = install
requested = signum
sys.argv = [helper, bundle]
runpy.run_path(helper, run_name="__main__")
'''


class ComputerHelperTests(unittest.TestCase):
    def run_helper(self, shutdown="eof", remaining=False, no_computer=False):
        with tempfile.TemporaryDirectory(prefix="rea-helper-") as folder:
            root = Path(folder)
            package = root / "agent_env"
            package.mkdir()
            (package / "__init__.py").write_text("")
            (package / "bundle.py").write_text(PACKAGE)
            down = root / "teardown"
            env = {**os.environ, "PYTHONPATH": str(root), "DOWN_FILE": str(down)}
            # Caller state must not select fixture failure modes by accident.
            env.pop("STILL_UP", None)
            env.pop("NO_COMPUTER", None)
            if remaining:
                env["STILL_UP"] = "1"
            if no_computer:
                env["NO_COMPUTER"] = "1"
            signum = getattr(signal, shutdown) if shutdown != "eof" else None
            arguments = [sys.executable, "-B", "-X", "utf8", str(HELPER), str(root)]
            if os.name == "nt" and signum is not None:
                wrapper = root / "raise-helper-signal.py"
                wrapper.write_text(WINDOWS_SIGNAL)
                arguments = [sys.executable, "-B", "-X", "utf8", str(wrapper), str(HELPER), str(int(signum)), str(root)]
            child = subprocess.Popen(arguments, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            # Bound readiness too: communicate() would close stdin and hide this regression.
            watchdog = threading.Timer(10, child.kill)
            watchdog.start()
            try:
                ready = child.stdout.readline()
                self.assertTrue(ready, "helper exited before its protocol line")
                message = json.loads(ready)
                if no_computer:
                    self.assertIn("error", message)
                else:
                    self.assertEqual(message["sandbox_id"], "fixture")
                if shutdown == "eof":
                    if not no_computer:
                        child.stdin.write(b"ignored stdin data\n" * 1000)
                        child.stdin.flush()
                        self.assertFalse(down.exists(), "data must not stand in for EOF")
                    child.stdin.close()
                elif os.name != "nt":
                    # Let the already-started reader block with the pipe still open.
                    threading.Event().wait(0.2)
                    child.send_signal(signum)
                child.wait(timeout=10)
                stderr = child.stderr.read().decode("utf-8")
                self.assertNotIn("_enter_buffered_busy", stderr)
                self.assertEqual(child.returncode, 2 if no_computer else 1 if remaining else 0, stderr)
                self.assertEqual(down.read_text(), "completed\n")
                if remaining:
                    self.assertIn("still up after the teardown", stderr)
            finally:
                watchdog.cancel()
                if child.poll() is None:
                    child.kill()
                    child.wait()
                child.stdin.close()
                child.stdout.close()
                child.stderr.close()
                watchdog.join()

    def test_eof_after_input(self):
        self.run_helper()

    def test_sigterm_with_stdin_open(self):
        self.run_helper("SIGTERM")

    def test_sigint_with_stdin_open(self):
        self.run_helper("SIGINT")

    def test_sigterm_retains_failed_teardown(self):
        self.run_helper("SIGTERM", remaining=True)

    def test_sigint_retains_failed_teardown(self):
        self.run_helper("SIGINT", remaining=True)

    def test_eof_retains_failed_teardown(self):
        self.run_helper(remaining=True)

    def test_no_computer_keeps_exit_two(self):
        self.run_helper(no_computer=True)


if __name__ == "__main__":
    unittest.main()
