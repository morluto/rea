"""Exercise the capture controller's filesystem inventory boundary."""

import errno
import hashlib
import json
import io
from contextlib import redirect_stdout
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from bridge.agentenv import capture


CONTROLLER = Path(__file__).with_name("capture.py")
# The supervisor finds same-session members through /proc only. Desktop build
# computers run Linux; other hosts cannot exercise that enumeration.
PROC_AVAILABLE = Path("/proc/self/stat").exists()


class CaptureListingTest(unittest.TestCase):
    def run_listing(self, root, output):
        return subprocess.run(
            [
                sys.executable,
                str(CONTROLLER),
                "list",
                json.dumps({"root": str(root), "output": str(output)}),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_directory_symlink_is_disclosed_without_following_it(self):
        with tempfile.TemporaryDirectory() as parent:
            parent = Path(parent)
            root = parent / "root"
            target = parent / "target"
            output = parent / "listing.json"
            root.mkdir()
            target.mkdir()
            (root / "present.txt").write_text("present")
            (target / "outside.txt").write_text("outside")
            try:
                (root / "linked").symlink_to(target, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlinks unavailable: {error}")
            result = self.run_listing(root, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            listing = json.loads(output.read_text())
            self.assertEqual(
                [item["path"] for item in listing["files"]],
                [os.path.relpath(root / "present.txt", Path.home())],
            )
            self.assertEqual(
                listing["skipped"], [os.path.relpath(root / "linked", Path.home())]
            )

    def test_missing_root_does_not_produce_an_empty_successful_inventory(self):
        with tempfile.TemporaryDirectory() as parent:
            parent = Path(parent)
            output = parent / "listing.json"
            result = self.run_listing(parent / "missing", output)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


class CaptureHandoffTest(unittest.TestCase):
    def test_stop_claims_a_missing_capture_directory(self):
        with tempfile.TemporaryDirectory() as parent:
            capture_dir = os.path.join(parent, "cap")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = capture.stop({"capture": capture_dir, "timeout_s": 1})
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"absent": True})
            self.assertTrue(os.path.isdir(capture_dir))

    def test_stop_waits_when_start_already_owns_the_directory(self):
        with tempfile.TemporaryDirectory() as parent:
            capture_dir = os.path.join(parent, "cap")
            os.mkdir(capture_dir)

            def finish():
                time.sleep(0.05)
                (Path(capture_dir) / "capture.out").write_bytes(b"")
                (Path(capture_dir) / "exit").write_text("0", encoding="utf-8")

            thread = threading.Thread(target=finish)
            thread.start()
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = capture.stop({"capture": capture_dir, "timeout_s": 2})
            thread.join()
            self.assertEqual(code, 0)
            payload = json.loads(stdout.getvalue())
            self.assertNotIn("absent", payload)
            self.assertEqual(payload["exit_code"], 0)

    def test_request_returns_false_when_the_fifo_write_fails(self):
        with tempfile.TemporaryDirectory() as parent:
            with (
                patch("bridge.agentenv.capture.os.O_NONBLOCK", 0, create=True),
                patch("bridge.agentenv.capture.os.open", return_value=7),
                patch("bridge.agentenv.capture.os.write", side_effect=BrokenPipeError),
                patch("bridge.agentenv.capture.os.close") as close,
            ):
                self.assertFalse(capture._request(parent, "stop"))
            close.assert_called_once_with(7)

    def test_stop_retries_until_a_reader_opens(self):
        with tempfile.TemporaryDirectory() as parent:
            capture_dir = os.path.join(parent, "cap")
            os.mkdir(capture_dir)
            control = os.path.join(capture_dir, "control")
            open(control, "wb").close()
            opened = threading.Event()
            attempts = []
            written = []
            real_open = os.open
            real_write = os.write

            def open_control(path, flags, *args, **kwargs):
                if os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(control)):
                    ready = opened.is_set()
                    attempts.append(ready)
                    if not ready:
                        raise OSError(errno.ENXIO, "no reader")
                return real_open(path, flags, *args, **kwargs)

            def write_control(fd, data):
                count = real_write(fd, data)
                written.append(data)
                return count

            def accept():
                time.sleep(0.05)
                opened.set()
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if any(b"stop\n" in chunk for chunk in written):
                        (Path(capture_dir) / "capture.out").write_bytes(b"")
                        (Path(capture_dir) / "exit").write_text("0", encoding="utf-8")
                        return
                    time.sleep(0.01)

            thread = threading.Thread(target=accept)
            thread.start()
            stdout = io.StringIO()
            with (
                patch("bridge.agentenv.capture.os.O_NONBLOCK", 0, create=True),
                patch("bridge.agentenv.capture.os.open", side_effect=open_control),
                patch("bridge.agentenv.capture.os.write", side_effect=write_control),
                redirect_stdout(stdout),
            ):
                code = capture.stop({"capture": capture_dir, "timeout_s": 2})
            thread.join()
            self.assertEqual(code, 0)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload.get("exit_code"), 0, payload)
            self.assertTrue(any(not ready for ready in attempts), attempts)
            self.assertTrue(any(attempts), attempts)

    def test_stop_bounds_an_interrupted_startup_to_one_timeout(self):
        with tempfile.TemporaryDirectory() as parent:
            capture_dir = os.path.join(parent, "cap")
            os.mkdir(capture_dir)
            started = time.monotonic()
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = capture.stop({"capture": capture_dir, "timeout_s": 0.3})
            elapsed = time.monotonic() - started
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(stdout.getvalue())["timed_out"])
            self.assertGreaterEqual(elapsed, 0.3)
            self.assertLess(elapsed, 0.55)

    def test_stop_returns_absent_again_after_it_claimed_the_directory(self):
        with tempfile.TemporaryDirectory() as parent:
            capture_dir = os.path.join(parent, "cap")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                first = capture.stop({"capture": capture_dir, "timeout_s": 2})
            self.assertEqual(first, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"absent": True})
            started = time.monotonic()
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                second = capture.stop({"capture": capture_dir, "timeout_s": 2})
            elapsed = time.monotonic() - started
            self.assertEqual(second, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"absent": True})
            self.assertLess(elapsed, 0.5)

    def test_stop_returns_absent_when_the_claim_appears_while_it_waits(self):
        with tempfile.TemporaryDirectory() as parent:
            capture_dir = os.path.join(parent, "cap")
            os.mkdir(capture_dir)

            def publish():
                time.sleep(0.05)
                descriptor = os.open(
                    os.path.join(capture_dir, "absent"),
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                os.close(descriptor)

            thread = threading.Thread(target=publish)
            thread.start()
            started = time.monotonic()
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = capture.stop({"capture": capture_dir, "timeout_s": 2})
            thread.join()
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"absent": True})
            self.assertLess(time.monotonic() - started, 1)


@unittest.skipIf(sys.platform == "win32", "desktop build computers use Linux")
class LongRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        rea = self.bin / "rea"
        rea.write_text(
            f"#!{sys.executable}\n"
            "import hashlib, json, os, signal, subprocess, sys, time\n"
            "signal.signal(signal.SIGINT, lambda *_: sys.exit(130))\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'wait':\n"
            "    open(sys.argv[2], 'w').close()\n"
            "    time.sleep(30)\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'stderr':\n"
            "    sys.stderr.write('x' * 100000 + 'TAIL')\n"
            "    print(hashlib.sha256(json.dumps(sys.argv[2:]).encode()).hexdigest())\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'hold':\n"
            "    held = subprocess.Popen([sys.executable, '-c', 'import os,sys,time\\nwhile not os.path.exists(sys.argv[1]): time.sleep(0.02)', sys.argv[2]], stdout=subprocess.DEVNULL, stderr=sys.stderr, start_new_session=True)\n"
            "    open(sys.argv[2] + '.pid.tmp', 'w').write(str(held.pid))\n"
            "    os.replace(sys.argv[2] + '.pid.tmp', sys.argv[2] + '.pid')\n"
            "    open(sys.argv[2] + '.leader.tmp', 'w').write(str(os.getpid()))\n"
            "    os.replace(sys.argv[2] + '.leader.tmp', sys.argv[2] + '.leader')\n"
            "    sys.exit(0)\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'group':\n"
            "    code = 'import os,signal,sys,time\\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\\ntemporary = sys.argv[1] + \".tmp\"\\nopen(temporary, \"w\").write(str(os.getpid()))\\nos.replace(temporary, sys.argv[1])\\nwhile not os.path.exists(sys.argv[2]): time.sleep(0.02)\\n'\n"
            "    held = subprocess.Popen([sys.executable, '-c', code, sys.argv[2] + '.pid', sys.argv[2]], stdout=subprocess.DEVNULL, stderr=sys.stderr)\n"
            "    open(sys.argv[2] + '.leader.tmp', 'w').write(str(os.getpid()))\n"
            "    os.replace(sys.argv[2] + '.leader.tmp', sys.argv[2] + '.leader')\n"
            "    while not os.path.exists(sys.argv[2] + '.pid'): time.sleep(0.02)\n"
            "    sys.exit(0)\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'drop':\n"
            "    code = 'import os,signal,sys,time\\nsignal.signal(signal.SIGINT, lambda *_: open(sys.argv[1] + \".sigint\", \"w\").close())\\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\\ntemporary = sys.argv[1] + \".tmp\"\\nopen(temporary, \"w\").write(str(os.getpid()))\\nos.replace(temporary, sys.argv[1])\\nwhile not os.path.exists(sys.argv[2]): time.sleep(0.02)\\nnull = os.open(\"/dev/null\", os.O_WRONLY)\\nos.dup2(null, 2)\\nos.close(null)\\nopen(sys.argv[1] + \".closed\", \"w\").close()\\nwhile not os.path.exists(sys.argv[3]): time.sleep(0.02)\\n'\n"
            "    held = subprocess.Popen([sys.executable, '-c', code, sys.argv[3] + '.pid', sys.argv[2], sys.argv[3]], stdout=subprocess.DEVNULL, stderr=sys.stderr)\n"
            "    open(sys.argv[3] + '.leader.tmp', 'w').write(str(os.getpid()))\n"
            "    os.replace(sys.argv[3] + '.leader.tmp', sys.argv[3] + '.leader')\n"
            "    while not os.path.exists(sys.argv[3] + '.pid'): time.sleep(0.02)\n"
            "    sys.exit(0)\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'resist':\n"
            "    signal.signal(signal.SIGINT, signal.SIG_IGN)\n"
            "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM})\n"
            "    open(sys.argv[2] + '.pid.tmp', 'w').write(str(os.getpid()))\n"
            "    os.replace(sys.argv[2] + '.pid.tmp', sys.argv[2] + '.pid')\n"
            "    while not os.path.exists(sys.argv[2]): time.sleep(0.02)\n"
            "print(os.environ.get('AGENTENV_CONTROL_TOKEN', 'no token'))\n"
        )
        rea.chmod(0o755)
        self.environment = {**os.environ, "HOME": str(self.root), "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
                            "AGENTENV_CONTROL_TOKEN": "not-for-the-child"}
        self.job = self.root / "job"
        self.output = self.root / "out.json"
        # Runs before the folder is removed: a descendant that never saw its
        # release file would otherwise poll a deleted path forever.
        self.addCleanup(self.release_descendant)

    def command(self, name, command_timeout=10, **values):
        result = subprocess.run([sys.executable, str(CONTROLLER), name, json.dumps(values)],
                                env=self.environment, text=True, capture_output=True, timeout=command_timeout, check=True)
        return json.loads(result.stdout)

    def begin(self, argv, timeout=60):
        return self.command("run-begin", job=str(self.job), work=str(self.root), stdout=str(self.output),
                            token="owner-token", argv=argv, files={}, timeout_s=timeout)

    def wait_until(self, ready, seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if ready():
                return True
            time.sleep(0.02)
        return False

    def release_descendant(self):
        for name in ("release", "release.stderr"):
            (self.root / name).touch()
        pid_path = self.root / "release.pid"
        if not pid_path.exists():
            return
        pid = int(pid_path.read_text())
        # The test holds no live handle to this descendant, so a pid alone does
        # not prove it is still ours; report a survivor rather than signal it.
        # An unreaped zombie has exited too (a container init may not reap it).
        exited = lambda: not self.process_exists(pid) or (  # noqa: E731
            PROC_AVAILABLE and self.leader_has_exited(pid)
        )
        if not self.wait_until(exited, seconds=2):
            self.fail(f"descendant pid {pid} did not exit after its release file appeared")

    @staticmethod
    def process_exists(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    def leader_has_exited(self, pid):
        try:
            data = Path(f"/proc/{pid}/stat").read_bytes()
        except FileNotFoundError:
            return True
        end = data.rfind(b")")
        if end < 0:
            return False
        fields = data[end + 2:].split()
        return bool(fields) and fields[0] == b"Z"

    def assert_process_gone(self, pid):
        deadline = time.monotonic() + 2
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            if time.monotonic() >= deadline:
                self.fail(f"pid {pid} still exists")
            time.sleep(0.05)

    def test_runs_and_reports_its_output(self):
        self.assertEqual(self.begin([]), {"started": True})
        result = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(self.output.read_text().strip(), "no token")

    def test_delivers_large_arguments_without_persisting_them_and_bounds_stderr(self):
        canary = "large-command-last-argument"
        arguments = [f"{index}-" + "x" * 4000 for index in range(20)] + [canary]
        digest = hashlib.sha256(json.dumps(arguments).encode()).hexdigest()
        self.assertEqual(self.begin(["stderr", *arguments]), {"started": True})

        result = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertTrue(result["finished"])
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(self.output.read_text().splitlines(), [digest, "no token"])
        self.assertEqual(result["stderr"], "x" * 4092 + "TAIL")
        self.assertFalse((self.job / "request.json").exists())
        for path in self.job.rglob("*"):
            if path.is_file():
                self.assertNotIn(canary.encode(), path.read_bytes(), str(path))

    def test_cancels_a_running_child_and_confirms_exit(self):
        ready = self.root / "ready"
        self.assertEqual(self.begin(["wait", str(ready)]), {"started": True})
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(ready.exists())
        result = self.command("run-cancel", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["exit_code"], 130)

    def test_cancel_before_late_start_claims_the_job(self):
        self.assertEqual(self.command("run-cancel", job=str(self.job), token="owner-token", timeout_s=1), {"absent": True})
        self.assertIn("already used", self.begin([])["refused"])
        self.assertFalse(self.output.exists())

    def test_cancel_refuses_a_folder_without_the_matching_owner(self):
        self.job.mkdir()
        (self.job / "owner").write_text("someone-else")
        result = self.command("run-cancel", job=str(self.job), token="owner-token", timeout_s=1)
        self.assertIn("ownership is not confirmed", result["error"])
        self.assertFalse((self.job / "cancel").exists())

    def test_reports_supervisor_output_if_completion_is_unconfirmed(self):
        self.job.mkdir()
        (self.job / "owner").write_text("owner-token")
        (self.job / "supervisor.log").write_text("supervisor failed")
        result = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=0)
        self.assertEqual(result["progress"], "supervisor failed")
        self.assertTrue(result["pending"])

    def test_reports_a_timed_out_child_that_has_not_stopped(self):
        release = self.start_resistant_child()
        try:
            self.assertTrue(self.wait_until((self.job / "timed_out").exists))
            self.assertTrue(self.wait_until((self.root / "release.pid").is_file))
            result = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=0)
            self.assertTrue(result["pending"])
            self.assertTrue(result["timed_out"])
        finally:
            release.touch()
            finished = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertTrue(finished["finished"] and finished["settled"])
        self.assertEqual(finished["exit_code"], 0)

    def start_foreign_stderr_holder(self, timeout):
        release = self.root / "release"
        self.assertEqual(self.begin(["hold", str(release)], timeout=timeout), {"started": True})
        pid_path = self.root / "release.pid"
        leader_path = self.root / "release.leader"
        self.assertTrue(self.wait_until(lambda: pid_path.exists() and leader_path.exists()))
        leader = int(leader_path.read_text())
        self.assertTrue(
            self.wait_until(lambda: not self.process_exists(leader)),
            f"supervised leader {leader} was not reaped",
        )
        return int(pid_path.read_text())

    def assert_unsettled_foreign_stderr(self, result, pid):
        self.assertTrue(result["finished"])
        self.assertFalse(result["settled"])
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("outside the supervised group", result["error"])
        self.assertEqual(os.getsid(pid), pid)
        self.assertTrue(self.process_exists(pid))

    def test_reports_incomplete_stderr_while_a_new_session_descendant_holds_the_pipe(self):
        pid = self.start_foreign_stderr_holder(timeout=1)
        result = self.command(
            "run-poll", job=str(self.job), token="owner-token", timeout_s=8, command_timeout=15,
        )
        self.assertTrue(result["timed_out"])
        self.assertFalse(result["cancelled"])
        self.assert_unsettled_foreign_stderr(result, pid)

    def test_cancel_during_inherited_stderr_drain_stays_unsettled(self):
        pid = self.start_foreign_stderr_holder(timeout=30)
        result = self.command(
            "run-cancel", job=str(self.job), token="owner-token", timeout_s=8, command_timeout=15,
        )
        self.assertTrue(result["cancelled"])
        self.assertFalse(result["timed_out"])
        self.assert_unsettled_foreign_stderr(result, pid)

    @unittest.skipUnless(PROC_AVAILABLE, "same-session enumeration reads /proc")
    def test_cancel_after_leader_exit_kills_a_same_session_child_holding_stderr(self):
        release = self.root / "release"
        self.assertEqual(self.begin(["group", str(release)], timeout=30), {"started": True})
        pid_path = self.root / "release.pid"
        leader_path = self.root / "release.leader"
        try:
            self.assertTrue(self.wait_until(lambda: pid_path.exists() and leader_path.exists()))
            leader = int(leader_path.read_text())
            child = int(pid_path.read_text())
            self.assertTrue(self.wait_until(lambda: self.leader_has_exited(leader)))
            self.assertEqual(os.getpgid(child), leader)
            self.assertEqual(os.getsid(child), leader)
            result = self.command(
                "run-cancel", job=str(self.job), token="owner-token", timeout_s=12, command_timeout=20,
            )
            self.assertTrue(result["finished"])
            self.assertTrue(result["cancelled"])
            self.assertTrue(result["settled"])
            self.assertEqual(result["exit_code"], 0)
            self.assert_process_gone(child)
        finally:
            release.touch()

    @unittest.skipUnless(PROC_AVAILABLE, "same-session enumeration reads /proc")
    def test_cancel_kills_a_same_session_child_that_closes_stderr(self):
        release = self.root / "release"
        stderr_release = self.root / "release.stderr"
        self.assertEqual(
            self.begin(["drop", str(stderr_release), str(release)], timeout=30),
            {"started": True},
        )
        pid_path = self.root / "release.pid"
        leader_path = self.root / "release.leader"
        closed_path = self.root / "release.pid.closed"
        interrupted_path = self.root / "release.pid.sigint"
        observed = {}

        def close_stderr():
            if not self.wait_until(lambda: interrupted_path.exists() or release.exists(), seconds=10):
                observed["error"] = "child did not acknowledge SIGINT"
                return
            if release.exists():
                return
            stderr_release.touch()
            if not self.wait_until(lambda: closed_path.exists(), seconds=5):
                observed["error"] = "child did not close stderr"
                return
            try:
                os.kill(int(pid_path.read_text()), 0)
            except ProcessLookupError:
                observed["alive_after_close"] = False
            else:
                observed["alive_after_close"] = True

        closer = threading.Thread(target=close_stderr, daemon=True)
        closer.start()
        try:
            self.assertTrue(self.wait_until(lambda: pid_path.exists() and leader_path.exists()))
            leader = int(leader_path.read_text())
            child = int(pid_path.read_text())
            self.assertTrue(self.wait_until(lambda: self.leader_has_exited(leader)))
            self.assertEqual(os.getpgid(child), leader)
            self.assertEqual(os.getsid(child), leader)
            result = self.command(
                "run-cancel", job=str(self.job), token="owner-token", timeout_s=12, command_timeout=20,
            )
            self.assertNotIn("error", observed, observed.get("error"))
            self.assertTrue(observed.get("alive_after_close"))
            self.assertTrue(result["finished"])
            self.assertTrue(result["cancelled"])
            self.assertTrue(result["settled"])
            self.assertEqual(result["exit_code"], 0)
            self.assert_process_gone(child)
        finally:
            stderr_release.touch()
            release.touch()
            closer.join(timeout=2)

    def start_resistant_child(self):
        release = self.root / "release"
        # Inherit the mask until the command installs both ignore handlers.
        # A slow startup can cross the real deadline before Python reaches them.
        previous_mask = signal.pthread_sigmask(
            signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM},
        )
        try:
            self.assertEqual(self.begin(["resist", str(release)], timeout=1), {"started": True})
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        return release

    def test_kills_a_leader_that_ignores_sigint_and_sigterm(self):
        self.start_resistant_child()
        result = self.command(
            "run-poll", job=str(self.job), token="owner-token", timeout_s=12, command_timeout=20,
        )
        self.assertTrue(result["finished"])
        self.assertTrue(result["timed_out"])
        self.assertTrue(result["settled"])
        self.assertFalse(result["cancelled"])
        self.assertTrue((self.root / "release.pid").is_file())
        self.assertEqual(result["exit_code"], -signal.SIGKILL)

    def test_failure_closing_supervisor_log_after_launch_does_not_claim_exit(self):
        ready = self.root / "ready"
        original_open = open
        original_popen = subprocess.Popen
        supervisors = []

        class FailingClose:
            def __init__(self, file):
                self.file = file

            def __enter__(self):
                return self.file

            def __exit__(self, *args):
                self.file.close()
                raise OSError("log close failed")

        def opening(path, *args, **kwargs):
            file = original_open(path, *args, **kwargs)
            return FailingClose(file) if str(path).endswith("supervisor.log") else file

        def spawning(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            supervisors.append(process)
            def cleanup():
                if process.poll() is None:
                    (self.job / "cancel").touch()
                    process.wait(timeout=5)
            self.addCleanup(cleanup)
            return process

        arguments = {"job": str(self.job), "work": str(self.root), "stdout": str(self.output),
                     "token": "owner-token", "argv": ["wait", str(ready)], "files": {}, "timeout_s": 60}
        with patch.dict(os.environ, self.environment, clear=True), patch("builtins.open", side_effect=opening), patch.object(capture.subprocess, "Popen", side_effect=spawning), redirect_stdout(io.StringIO()) as output:
            capture.run_begin(arguments)
        self.assertIn("started but its setup did not finish", json.loads(output.getvalue())["error"])
        import time
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(ready.exists())
        self.assertFalse((self.job / "result.json").exists())
        result = self.command("run-cancel", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertTrue(result["cancelled"])
        supervisors[0].wait(timeout=5)

    def test_run_cancel_returns_absent_again_on_retry_without_polling(self):
        first = self.command("run-cancel", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertEqual(first, {"absent": True})
        started = time.monotonic()
        second = self.command("run-cancel", job=str(self.job), token="owner-token", timeout_s=5)
        elapsed = time.monotonic() - started
        self.assertEqual(second, {"absent": True})
        self.assertLess(elapsed, 1.0)


if __name__ == "__main__":
    unittest.main()
