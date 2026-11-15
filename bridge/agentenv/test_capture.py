"""Exercise the capture controller's filesystem inventory boundary."""

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
            "import os, signal, subprocess, sys, time\n"
            "signal.signal(signal.SIGINT, lambda *_: sys.exit(130))\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'wait':\n"
            "    open(sys.argv[2], 'w').close()\n"
            "    time.sleep(30)\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'ignore':\n"
            "    signal.signal(signal.SIGINT, signal.SIG_IGN)\n"
            "    open(sys.argv[2], 'w').close()\n"
            "    while not os.path.exists(sys.argv[3]): time.sleep(0.02)\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'stderr':\n"
            "    sys.stderr.write('x' * 100000 + 'TAIL')\n"
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
            "    code = 'import os,signal,sys,time\\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\\ntemporary = sys.argv[1] + \".tmp\"\\nopen(temporary, \"w\").write(str(os.getpid()))\\nos.replace(temporary, sys.argv[1])\\nwhile not os.path.exists(sys.argv[2]): time.sleep(0.02)\\nnull = os.open(\"/dev/null\", os.O_WRONLY)\\nos.dup2(null, 2)\\nos.close(null)\\nopen(sys.argv[1] + \".closed\", \"w\").close()\\nwhile not os.path.exists(sys.argv[3]): time.sleep(0.02)\\n'\n"
            "    held = subprocess.Popen([sys.executable, '-c', code, sys.argv[3] + '.pid', sys.argv[2], sys.argv[3]], stdout=subprocess.DEVNULL, stderr=sys.stderr)\n"
            "    open(sys.argv[3] + '.leader.tmp', 'w').write(str(os.getpid()))\n"
            "    os.replace(sys.argv[3] + '.leader.tmp', sys.argv[3] + '.leader')\n"
            "    while not os.path.exists(sys.argv[3] + '.pid'): time.sleep(0.02)\n"
            "    sys.exit(0)\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'resist':\n"
            "    signal.signal(signal.SIGINT, signal.SIG_IGN)\n"
            "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "    open(sys.argv[2], 'w').close()\n"
            "    while True: time.sleep(0.05)\n"
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

    def test_passes_large_command_without_persisting_its_arguments(self):
        self.assertEqual(self.begin(["done", *("x" * 4000 for _ in range(20))]), {"started": True})
        result = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse((self.job / "request.json").exists())

    def test_keeps_only_a_bounded_stderr_tail(self):
        self.assertEqual(self.begin(["stderr"]), {"started": True})
        result = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=5)
        self.assertEqual(len(result["stderr"]), 4096)
        self.assertTrue(result["stderr"].endswith("TAIL"))

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
        ready, release = self.root / "ready", self.root / "release"
        self.assertEqual(self.begin(["ignore", str(ready), str(release)], timeout=3), {"started": True})
        try:
            result = self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=4)
            self.assertTrue(result["pending"])
            self.assertTrue(result["timed_out"])
            self.assertTrue(ready.exists())
        finally:
            release.touch()
            self.command("run-poll", job=str(self.job), token="owner-token", timeout_s=5)

    def test_reports_incomplete_stderr_while_a_new_session_descendant_holds_the_pipe(self):
        release = self.root / "release"
        self.assertEqual(self.begin(["hold", str(release)], timeout=1), {"started": True})
        try:
            result = self.command(
                "run-poll", job=str(self.job), token="owner-token", timeout_s=8, command_timeout=15,
            )
            self.assertTrue(result["finished"])
            self.assertTrue(result["timed_out"])
            self.assertFalse(result["settled"])
            self.assertEqual(result["exit_code"], 0)
            self.assertIn("outside the supervised group", result["error"])
            pid = int((self.root / "release.pid").read_text())
            self.assertEqual(os.getsid(pid), pid)
            os.kill(pid, 0)
        finally:
            release.touch()

    def test_cancel_during_inherited_stderr_drain_stays_unsettled(self):
        release = self.root / "release"
        self.assertEqual(self.begin(["hold", str(release)], timeout=30), {"started": True})
        pid_path = self.root / "release.pid"
        leader_path = self.root / "release.leader"
        try:
            self.assertTrue(self.wait_until(lambda: pid_path.exists() and leader_path.exists()))
            leader = int(leader_path.read_text())
            self.assertTrue(self.wait_until(lambda: self.leader_has_exited(leader)))
            result = self.command(
                "run-cancel", job=str(self.job), token="owner-token", timeout_s=8, command_timeout=15,
            )
            self.assertTrue(result["finished"])
            self.assertTrue(result["cancelled"])
            self.assertFalse(result["settled"])
            self.assertEqual(result["exit_code"], 0)
            pid = int(pid_path.read_text())
            self.assertEqual(os.getsid(pid), pid)
            os.kill(pid, 0)
        finally:
            release.touch()

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
        observed = {}

        def close_stderr():
            if not self.wait_until(lambda: (self.job / "cancel").exists(), seconds=10):
                observed["error"] = "cancel file did not appear"
                return
            time.sleep(0.3)
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

    def test_kills_a_leader_that_ignores_sigint_and_sigterm(self):
        ready = self.root / "ready"
        self.assertEqual(self.begin(["resist", str(ready)], timeout=1), {"started": True})
        result = self.command(
            "run-poll", job=str(self.job), token="owner-token", timeout_s=12, command_timeout=20,
        )
        self.assertTrue(result["finished"])
        self.assertTrue(result["timed_out"])
        self.assertTrue(result["settled"])
        self.assertFalse(result.get("pending", False))
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


if __name__ == "__main__":
    unittest.main()
