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

# Ack at the read boundary. The baseline's BufferedReader already holds its lock
# when it calls FileIO.readall. The fixed helper reads the descriptor directly.
# Windows exercises the registered handlers with an in-process signal because
# Popen.send_signal cannot deliver an external POSIX SIGTERM on that platform.
SIGNAL_DRIVER = '''import os, runpy, signal, sys, threading
helper, signum, bundle, trigger = sys.argv[1:]
signum = int(signum)
stdin_fd = sys.stdin.fileno()
raw = sys.stdin.buffer.raw
original_readall = raw.readall
original_read = os.read
announced = False

def acknowledge():
    global announced
    if announced:
        return
    announced = True
    os.write(sys.stderr.fileno(), b"stdin-reader-ready\\n")
    if os.name == "nt":
        signal.raise_signal(signum)

def readall():
    acknowledge()
    return original_readall()

def read(fd, size):
    if fd == stdin_fd:
        acknowledge()
    return original_read(fd, size)

original_wait = threading.Event.wait

def wait_with_signal(event, timeout=None):
    # Thread.start waits without a timeout. Intercept the main thread's bounded EOF wait.
    if timeout is not None and threading.current_thread() is threading.main_thread():
        threading.Event.wait = original_wait
        with event._cond:
            os.write(sys.stderr.fileno(), b"wait-lock-held\\n")
            signal.raise_signal(signum)
    return original_wait(event, timeout)

if trigger == "wait-lock":
    threading.Event.wait = wait_with_signal
else:
    raw.readall = readall
    os.read = read
sys.argv = [helper, bundle]
runpy.run_path(helper, run_name="__main__")
'''


class ComputerHelperTests(unittest.TestCase):
    def run_helper(self, shutdown="eof", remaining=False, no_computer=False, *, hold_wait_lock=False):
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
            interpreter = [sys.executable, "-B", "-S", "-X", "utf8"]
            arguments = [*interpreter, str(HELPER), str(root)]
            if signum is not None:
                wrapper = root / "drive-helper-signal.py"
                wrapper.write_text(SIGNAL_DRIVER)
                trigger = "wait-lock" if hold_wait_lock else "read-entry"
                arguments = [*interpreter, str(wrapper), str(HELPER), str(int(signum)),
                             str(root), trigger]
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
                else:
                    marker = b"wait-lock-held" if hold_wait_lock else b"stdin-reader-ready"
                    self.assertEqual(child.stderr.readline().rstrip(b"\r\n"), marker)
                    if not hold_wait_lock and os.name != "nt":
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

    def test_sigint_with_stdin_open_retains_failed_teardown(self):
        self.run_helper("SIGINT", remaining=True)

    def test_signal_while_wait_holds_eof_event_lock(self):
        self.run_helper("SIGTERM", hold_wait_lock=True)

    def test_no_computer_keeps_exit_two(self):
        self.run_helper(no_computer=True)


if __name__ == "__main__":
    unittest.main()
