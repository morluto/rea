"""Real synthetic process trees; no Codex or reverse-engineering engine runs."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

import psutil

from benchmark import CleanupIncomplete, measure, OwnershipSession, main, agent_command


SLEEPER = "import time; time.sleep(30)"
TREE = f"""
import json, subprocess, sys, time
children = [subprocess.Popen([sys.executable, '-c', {SLEEPER!r}], start_new_session=detached)
            for detached in (False, True)]
print(json.dumps([p.pid for p in children]), flush=True)
time.sleep(.2)
memory = bytearray(128 * 1024**2) if sys.argv[1] == 'memory' else None
if sys.argv[1] != 'exit': time.sleep(30)
"""


class BenchmarkCleanupTest(unittest.TestCase):
    def test_custom_environment_values_are_runtime_only_including_default_overrides(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-settings-") as root:
            directory = Path(root)
            environment = {"SESSION": "opaque-transport-credential", "PRIVATE_VALUE": "marked-sensitive",
                           "GHIDRA_INSTALL_DIR": "/custom/provider", "API_KEY": "ordinary-selected-value"}
            config = {"codex": "codex", "model": "fixture", "reasoning": "low", "r2": "/selected/r2",
                      "ghidra": "/default/ghidra", "java": "/selected/java", "servers": {
                          "fixture": {"command": "provider", "args": ["serve"], "tools": ["inspect"],
                                      "env": environment, "sensitive": {"env": ["PRIVATE_VALUE"]}}}}
            command = agent_command(config, "fixture", directory)
            saved = (directory / "selected-settings.json").read_text()
            settings = json.loads(saved)
            for key, value in environment.items():
                self.assertIn("mcp_servers.engine.env." + key + "=" + json.dumps(value), command)
                self.assertNotIn(value, saved)
                self.assertEqual(settings["mcp_servers.engine.env." + key], "[not persisted]")
            self.assertEqual(settings["mcp_servers.engine.env.REA_R2_COMMAND"], config["r2"])
            self.assertEqual(settings["mcp_servers.engine.env.JAVA_HOME"], config["java"])
            self.assertEqual(settings["mcp_servers.engine.command"], "provider")
            self.assertEqual(config["servers"]["fixture"]["env"], environment)

    def test_agent_digest_mismatch_retains_both_hashes_and_stops_trials(self):
        cases = ("unchanged", "changed", "nonzero", "limit", "cancelled", "pending-cleanup",
                 "truncated-output", "missing-output", "missing-target", "failed-summary-write")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="rea-benchmark-digest-") as root:
                directory = Path(root)
                target = directory / "target"
                target.write_bytes(b"original")
                config = directory / "config.json"
                config.write_text(json.dumps({"node": "node", "model": "fixture", "reasoning": "low",
                    "lanes": ["fixture"], "targets": [{"id": "synthetic", "path": str(target), "prompt": "inspect"}],
                    "output": str(directory / "out")}))
                def prepare(_config, _lane, setup):
                    setup.mkdir()
                    return ["synthetic-agent"]
                failure = (None if case in ("unchanged", "changed") else
                           TimeoutError("Trial exceeded its limit") if case == "limit" else
                           KeyboardInterrupt("Caller cancelled") if case == "cancelled" else
                           CleanupIncomplete("Cleanup pending", object(), {"runId": "retained"}, object())
                           if case == "pending-cleanup" else RuntimeError("Agent exited nonzero"))
                changed = case != "unchanged"
                def measured(_command, trial, **_options):
                    trial.mkdir()
                    if case != "missing-output":
                        events = [json.dumps({"usage": {"tokens": 3}}), json.dumps({"type": "item.completed",
                            "item": {"type": "mcp_tool_call", "tool": "inspect", "status": "failed"}})]
                        if case == "truncated-output":
                            events.append('{"incomplete":')
                        (trial / "stdout.log").write_text("\n".join(events))
                    if changed:
                        target.write_bytes(b"changed")
                    if case == "missing-target":
                        target.unlink()
                    if failure is not None:
                        raise failure
                    return {"exit_code": 0}
                write_text = Path.write_text
                def persist(path, *args, **kwargs):
                    if case == "failed-summary-write" and path.name == "agent-summary.json":
                        raise OSError("Injected summary persistence failure")
                    return write_text(path, *args, **kwargs)
                with patch("benchmark.agent_command", side_effect=prepare), \
                     patch("benchmark.measure", side_effect=measured) as trials, \
                     patch.object(sys, "argv", ["benchmark.py", str(config), "agent", "--trials", "2"]), \
                     patch.object(Path, "write_text", persist), \
                     patch("builtins.print") as output:
                    if failure is not None:
                        with self.assertRaises(type(failure)) as raised:
                            main()
                        self.assertIs(raised.exception, failure)
                        output.assert_not_called()
                    elif changed:
                        with self.assertRaisesRegex(RuntimeError, "Target changed"):
                            main()
                        output.assert_not_called()
                    else:
                        main()
                        self.assertEqual(output.call_count, 2)
                self.assertEqual(trials.call_count, 1 if changed else 2)
                if case == "failed-summary-write":
                    self.assertIn("Injected summary persistence failure", failure.__notes__[0])
                    continue
                summary = json.loads((directory / "out/run/agent-synthetic-fixture-1/agent-summary.json").read_text())
                self.assertEqual(summary["target_sha256_before"], hashlib.sha256(b"original").hexdigest())
                if case in ("pending-cleanup", "missing-target"):
                    self.assertIsNone(summary["target_sha256_after"])
                    self.assertEqual(summary["correctness"], "unknown")
                    self.assertIn("target_sha256_after_unknown_reason" if case == "pending-cleanup" else "summary_error", summary)
                else:
                    self.assertEqual(summary["target_sha256_after"], hashlib.sha256(target.read_bytes()).hexdigest())
                    self.assertEqual(summary["correctness"], "artifact_changed" if changed else "requires_source_oracle_review")
                self.assertEqual(summary["trial_status"], "failed" if failure is not None else "completed")
                if case == "truncated-output":
                    self.assertIn("summary_error", summary)
                    self.assertTrue(failure.__notes__)
                if case not in ("missing-target", "missing-output"):
                    self.assertEqual(summary["usage"], [{"tokens": 3}])
                    self.assertEqual(summary["calls"][0]["tool"], "inspect")

    def test_nonzero_trial_exit_stops_trials_after_recording_resources(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-exit-") as root:
            directory = Path(root)
            config = directory / "config.json"
            config.write_text(json.dumps({"node": "node", "sdk_driver": "unused-driver", "lanes": ["fixture"],
                "targets": [{"id": "synthetic"}], "output": str(directory / "out")}))
            # Isolate trial failure semantics from the separately tested OS ownership boundary.
            owner = MagicMock(ownership={"runId": "synthetic"})
            owner.child.poll.return_value = 7
            owner.cleanup.return_value = {"cleaned": True}
            owner.helper.pid = 123
            with patch("benchmark.OwnershipSession", return_value=owner) as owners, \
                 patch.object(sys, "argv", ["benchmark.py", str(config), "sdk", "--trials", "2"]), \
                 patch("builtins.print") as output:
                with self.assertRaisesRegex(RuntimeError, "exited with status 7"):
                    main()
            owners.assert_called_once()
            owner.cleanup.assert_called_once()
            owner.close.assert_called_once()
            output.assert_not_called()
            first = directory / "out/run/sdk-synthetic-fixture-1"
            resources = json.loads((first / "resources.json").read_text())
            self.assertEqual(resources["exit_code"], 7)
            self.assertTrue(resources["cleanup"]["cleaned"])
            self.assertFalse((directory / "out/run/sdk-synthetic-fixture-2").exists())

    def test_signal_during_spawn_retains_helper_and_target_before_delivery(self):
        for stage in ("helper", "target"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(prefix="rea-benchmark-spawn-") as root:
                popen = subprocess.Popen
                processes = []
                interrupted = False
                def signal_after_spawn(command, *args, **kwargs):
                    nonlocal interrupted
                    child = popen(command, *args, **kwargs)
                    processes.append(child)
                    if not interrupted and (stage == "helper" or command[0] == sys.executable):
                        interrupted = True
                        os.kill(os.getpid(), signal.SIGINT)
                    return child
                try:
                    with patch("benchmark.subprocess.Popen", signal_after_spawn):
                        with self.assertRaises(KeyboardInterrupt):
                            measure([sys.executable, "-c", SLEEPER], Path(root) / "trial")
                    self.assertTrue(interrupted)
                    self.assertEqual(len(processes), 1 if stage == "helper" else 2)
                    self.assertTrue(all(child.poll() is not None for child in processes))
                finally:
                    # The regression fixture retains exact Popen handles even on the old code.
                    for child in reversed(processes):
                        if child.poll() is None:
                            child.terminate()
                        child.wait(timeout=10)
                        for stream in (child.stdin, child.stdout):
                            if stream is not None:
                                stream.close()

    def test_cli_retains_cleanup_through_repeated_signals_and_stops_trials(self):
        for interruption in (False, True):
            with self.subTest(interruption=interruption), tempfile.TemporaryDirectory(prefix="rea-benchmark-cli-") as root:
                directory = Path(root)
                release, state = directory / "release", directory / "state.json"
                driver = directory / "driver.mjs"
                driver.write_text("setInterval(() => {}, 1000);\n")
                config = directory / "config.json"
                config.write_text(json.dumps({"node": "node", "sdk_driver": str(driver), "lanes": ["fixture"],
                    "targets": [{"id": "synthetic"}], "output": str(directory / "out")}))
                script = f'''
import benchmark, json, sys
from pathlib import Path
cleanup, measure = benchmark.OwnershipSession.cleanup, benchmark.measure
interruption = {interruption!r}
def deny(owner):
    global interruption
    if not Path({str(release)!r}).exists():
        owner.observe()
        Path({str(state)!r}).write_text(json.dumps({{"child": owner.child.pid, "helper": owner.helper.pid}}))
        if interruption:
            interruption = False
            raise KeyboardInterrupt("interrupted during final cleanup")
        return {{"cleaned": False, "reason": "injected cleanup denial"}}
    return cleanup(owner)
def bounded(*args, **kwargs):
    kwargs["timeout"] = .2
    return measure(*args, **kwargs)
benchmark.OwnershipSession.cleanup = deny
benchmark.measure = bounded
sys.argv = ["benchmark.py", {str(config)!r}, "sdk", "--trials", "2"]
raise SystemExit(benchmark.run_cli())
'''
                host = subprocess.Popen([sys.executable, "-c", script], cwd=Path(__file__).parent,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                        start_new_session=True)
                try:
                    deadline = time.monotonic() + 10
                    while not state.exists():
                        self.assertIsNone(host.poll())
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(.02)
                    time.sleep(1.2)  # Cross a denied automatic retry.
                    owners = json.loads(state.read_text())
                    self.assertNotEqual(os.getpgid(owners["helper"]), os.getpgid(host.pid))
                    os.killpg(host.pid, signal.SIGINT)  # Terminal Ctrl-C targets the entire foreground group.
                    host.send_signal(signal.SIGTERM)
                    host.send_signal(signal.SIGINT)
                    time.sleep(.2)
                    self.assertIsNone(host.poll())
                    self.assertTrue(all(psutil.pid_exists(pid) for pid in owners.values()))
                    release.touch()
                    output, errors = host.communicate(timeout=15)
                    self.assertIn(host.returncode, (130, 143))
                    self.assertIn("Retained benchmark cleanup verified", errors)
                    self.assertEqual(output, "")
                    self.assertFalse((directory / "out/run/sdk-synthetic-fixture-2").exists())
                    self.assertFalse(any(psutil.pid_exists(pid) for pid in owners.values()))
                finally:
                    release.touch()
                    try:
                        host.communicate(timeout=20)
                    except subprocess.TimeoutExpired:
                        host.kill()  # Exact owned test host; helper EOF still owns released cleanup.
                        host.communicate(timeout=5)

    def test_helper_eof_and_graceful_signal_retain_the_same_evidence_owner(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-eof-") as root:
            directory = Path(root)
            denied = directory / "denied"
            hook = directory / "hook.mjs"
            host_module = Path(__file__).resolve().parents[2] / "dist/process/ProcessOwnershipObservation.js"
            hook.write_text(f'''
import {{ existsSync }} from "node:fs";
import {{ systemProcessOwnershipHost as host }} from {json.dumps(host_module.as_uri())};
const list = host.listProcesses;
host.listProcesses = (...args) => {{
  if (existsSync({json.dumps(str(denied))})) throw new Error("injected process inspection denial");
  return list.apply(host, args);
}};
''')
            with patch.dict(os.environ, {"NODE_OPTIONS": "--import=" + str(hook)}):
                owner = OwnershipSession("node")
            child = None
            descendants = []
            try:
                child = subprocess.Popen([sys.executable, "-c", TREE, "timeout"], start_new_session=True,
                    env={**os.environ, "REA_PROCESS_RUN_ID": owner.ownership["runId"]}, stdout=subprocess.PIPE, text=True)
                descendants = json.loads(child.stdout.readline())
                owner.attach(child)
                denied.touch()
                owner.helper.stdin.close()
                time.sleep(1.2)
                owner.helper.terminate()  # Graceful signal must not lose its ledger either.
                time.sleep(.2)
                self.assertIsNone(owner.helper.poll())
                self.assertIsNone(child.poll())
                denied.unlink()
                owner.helper.wait(timeout=15)
                child.wait(timeout=5)
                self.assertEqual(owner.helper.returncode, 143)
                for pid in descendants:
                    self.assertFalse(psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)
            finally:
                denied.unlink(missing_ok=True)
                if not owner.helper.stdin.closed:
                    owner.helper.stdin.close()
                owner.helper.wait(timeout=20)
                if child is not None:
                    child.wait(timeout=5)
                    child.stdout.close()
                owner._release_streams()

    def test_failed_final_stream_close_retries_without_rereading_closed_diagnostics(self):
        owner = OwnershipSession("node")
        close = owner.errors.close
        attempts = 0
        def deny_once():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError("injected final stream close failure")
            close()
        try:
            with patch.object(owner.errors, "close", deny_once):
                with self.assertRaises(OSError):
                    owner.close()
                self.assertFalse(owner.closed)
                self.assertTrue(owner.shutdown_acknowledged)
                owner.close()
            self.assertTrue(owner.closed)
        finally:
            owner.close()

    def test_interruption_after_close_write_keeps_the_pending_receipt(self):
        owner = OwnershipSession("node")
        write = owner.helper.stdin.write
        def interrupt_after_write(message):
            write(message)
            raise KeyboardInterrupt("interrupted after close submission")
        try:
            with patch.object(owner.helper.stdin, "write", interrupt_after_write):
                with self.assertRaises(KeyboardInterrupt):
                    owner.close()
            self.assertEqual(owner.shutdown_request, 1)
            with patch.object(owner.helper.stdin, "write", side_effect=AssertionError("close must not replay")):
                owner.close()
            self.assertTrue(owner.closed)
        finally:
            owner.close()

    def test_signal_immediately_before_close_write_is_delivered_after_submission(self):
        owner = OwnershipSession("node")
        write = owner.helper.stdin.write
        before_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        def interrupt_before_write(message):
            os.kill(os.getpid(), signal.SIGINT)
            return write(message)
        try:
            with patch.object(owner.helper.stdin, "write", interrupt_before_write):
                with self.assertRaises(KeyboardInterrupt):
                    owner.close()
            self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK, set()), before_mask)
            self.assertEqual(owner.shutdown_request, 1)
            owner.helper.stdin.close()
            owner.helper.wait(timeout=5)
            with patch.object(owner.helper.stdin, "write", side_effect=AssertionError("close must not replay")):
                owner.close()
            self.assertTrue(owner.closed)
        finally:
            if not owner.helper.stdin.closed:
                owner.helper.stdin.close()
            owner.helper.wait(timeout=5)
            owner._release_streams()

    def test_signal_during_close_receipt_retains_bytes_or_acknowledgement(self):
        for stage in ("read", "parse"):
            with self.subTest(stage=stage):
                owner = OwnershipSession("node")
                read, loads = os.read, json.loads
                interrupted = False
                def interrupt_read(fd, size):
                    nonlocal interrupted
                    data = read(fd, size)
                    if stage == "read" and fd == owner.helper.stdout.fileno() and data:
                        interrupted = True
                        os.kill(os.getpid(), signal.SIGINT)
                    return data
                def interrupt_parse(data, *args, **kwargs):
                    nonlocal interrupted
                    result = loads(data, *args, **kwargs)
                    if stage == "parse" and result.get("id") == 1:
                        interrupted = True
                        os.kill(os.getpid(), signal.SIGINT)
                    return result
                try:
                    with patch("benchmark.os.read", interrupt_read), patch("benchmark.json.loads", interrupt_parse):
                        with self.assertRaises(KeyboardInterrupt):
                            owner.close()
                    self.assertTrue(interrupted)
                    with patch.object(owner.helper.stdin, "write", side_effect=AssertionError("close must not replay")):
                        owner.close()
                    self.assertTrue(owner.shutdown_acknowledged)
                    self.assertTrue(owner.closed)
                    self.assertEqual(owner.sequence, 1)
                finally:
                    if not owner.helper.stdin.closed:
                        owner.helper.stdin.close()
                    owner.helper.wait(timeout=5)
                    owner._release_streams()

    def test_failures_before_target_launch_reap_prepared_helper(self):
        for stage in ("file-open", "prompt-write", "spawn"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(prefix="rea-benchmark-prepare-") as root:
                cause = OSError("injected " + stage)
                original_open, original_popen = Path.open, subprocess.Popen
                original_close = OwnershipSession.close
                owners = []

                def fail_open(path, *args, **kwargs):
                    if stage == "file-open" and path.name == "stdout.log":
                        raise cause
                    if stage == "prompt-write" and path.name == "stdin.txt":
                        stream = MagicMock()
                        stream.__enter__.return_value.write.side_effect = cause
                        return stream
                    return original_open(path, *args, **kwargs)

                def fail_spawn(command, *args, **kwargs):
                    if stage == "spawn" and command[0] == sys.executable:
                        raise cause
                    return original_popen(command, *args, **kwargs)

                def record_close(owner):
                    owners.append(owner)
                    return original_close(owner)

                with patch.object(Path, "open", fail_open), patch("benchmark.subprocess.Popen", fail_spawn), patch.object(OwnershipSession, "close", record_close):
                    with self.assertRaises(OSError) as raised:
                        measure([sys.executable, "-c", SLEEPER], Path(root) / "trial", prompt="input")
                self.assertIs(raised.exception, cause)
                self.assertEqual(len(owners), 1)
                self.assertIsNone(owners[0].child)
                self.assertTrue(owners[0].closed)
                self.assertEqual(owners[0].helper.returncode, 0)

    def test_attachment_timeout_retains_child_and_discards_only_its_late_receipt(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-attach-") as root:
            cause = TimeoutError("injected attachment response timeout")
            original_response = OwnershipSession._response
            owners = []

            def interrupt_attachment(owner, wanted, timeout=60):
                if wanted == 1:
                    owners.append(owner)
                    self.assertEqual(owner.ownership["leaderPid"], owner.child.pid)
                    raise cause
                return original_response(owner, wanted, timeout)

            with patch.object(OwnershipSession, "_response", interrupt_attachment):
                with self.assertRaises(TimeoutError) as raised:
                    measure([sys.executable, "-c", SLEEPER], Path(root) / "trial")
            self.assertIs(raised.exception, cause)
            self.assertEqual(owners[0].sequence, 3)  # observe, cleanup, close
            self.assertTrue(owners[0].cleaned)
            self.assertTrue(owners[0].closed)
            self.assertIsNotNone(owners[0].child.returncode)
            self.assertEqual(owners[0].helper.returncode, 0)

    def test_acknowledged_shutdown_retries_only_reaping(self):
        owner = OwnershipSession("node")
        try:
            with patch.object(owner.helper, "wait", side_effect=subprocess.TimeoutExpired("ownership helper", 5)), patch.object(owner, "_request", wraps=owner._request) as request:
                with self.assertRaises(subprocess.TimeoutExpired):
                    owner.close()
                self.assertTrue(owner.shutdown_acknowledged)
                self.assertTrue(owner.helper.stdin.closed)
                self.assertFalse(owner.closed)
                request.assert_called_once_with("close")
            with patch.object(owner, "_request", side_effect=AssertionError("shutdown must not send another request")):
                owner.close()
            self.assertTrue(owner.closed)
            self.assertEqual(owner.helper.returncode, 0)
        finally:
            owner.close()

    def test_unacknowledged_shutdown_consumes_late_receipt_without_resending(self):
        owner = OwnershipSession("node")
        try:
            with patch.object(owner, "_response", side_effect=TimeoutError("delayed close receipt")):
                with self.assertRaises(TimeoutError):
                    owner.close()
            owner.helper.stdin.close()  # Permit exit after the real helper sends its late receipt.
            owner.helper.wait(timeout=5)
            self.assertFalse(owner.shutdown_acknowledged)
            with patch.object(owner.helper.stdin, "write", side_effect=AssertionError("close must not be replayed")):
                owner.close()
            self.assertTrue(owner.shutdown_acknowledged)
            self.assertTrue(owner.closed)
            self.assertEqual(owner.sequence, 1)
        finally:
            if not owner.closed:
                owner.helper.stdin.close()
                owner.helper.wait(timeout=5)
                owner._release_streams()

    def test_explicit_close_refusal_releases_only_the_pending_request(self):
        owner = OwnershipSession("node")
        try:
            owner.shutdown_request = owner.sequence = 1
            owner.pending = b'{"id":1,"error":"injected close refusal"}\n'
            with self.assertRaisesRegex(RuntimeError, "injected close refusal"):
                owner.close()
            self.assertIsNone(owner.shutdown_request)
            self.assertFalse(owner.closed)
            owner.close()
            self.assertTrue(owner.closed)
            self.assertEqual(owner.sequence, 2)
        finally:
            owner.close()

    def test_failed_preparation_preserves_diagnostic_and_retries_unbound_reaping(self):
        for interrupt_wait in (False, True):
            with self.subTest(interrupt_wait=interrupt_wait):
                original_popen = subprocess.Popen
                helpers = []

                def prepare_failure(*args, **kwargs):
                    helper = original_popen(*args, **kwargs)
                    helpers.append(helper)
                    if interrupt_wait:
                        wait = helper.wait
                        attempts = 0

                        def interrupt_once(*args, **kwargs):
                            nonlocal attempts
                            attempts += 1
                            if attempts == 1:
                                raise subprocess.TimeoutExpired("preparing helper", 5)
                            return wait(*args, **kwargs)
                        helper.wait = interrupt_once
                    return helper

                with patch("benchmark.subprocess.Popen", prepare_failure):
                    with self.assertRaises(CleanupIncomplete if interrupt_wait else RuntimeError) as raised:
                        OwnershipSession(sys.executable)  # Python rejects the actual JS helper before preparation.
                failure = raised.exception
                if interrupt_wait:
                    self.assertIsNone(failure.owner.child)
                    failure.owner.close()
                    self.assertTrue(failure.owner.closed)
                    failure = failure.__cause__
                self.assertIn("SyntaxError", str(failure))
                self.assertIsNotNone(helpers[0].returncode)
                self.assertTrue(helpers[0].stdout.closed)

    def test_lost_helper_preserves_known_ownership_without_recreating_ledger(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-lost-") as root:
            original_observe = OwnershipSession.observe
            owners = []

            def lose_helper(owner):
                result = original_observe(owner)
                owners.append(owner)
                owner.helper.kill()  # Forced loss; graceful signals retain cleanup authority.
                owner.helper.wait(timeout=5)
                return result

            try:
                with patch.object(OwnershipSession, "observe", lose_helper):
                    with self.assertRaises(CleanupIncomplete) as raised:
                        for name in ("first", "second"):
                            measure([sys.executable, "-c", SLEEPER], Path(root) / name, timeout=.2)
                self.assertFalse((Path(root) / "second").exists())
                self.assertEqual(len(owners), 1)
                owner = owners[0]
                self.assertIs(raised.exception.owner, owner)
                self.assertIs(raised.exception.ownership, owner.ownership)
                self.assertIs(raised.exception.child, owner.child)
                self.assertIsNone(owner.child.poll())
                self.assertFalse(owner.cleaned)
                with self.assertRaises((BrokenPipeError, RuntimeError)):
                    owner.cleanup()
                self.assertEqual(len(owners), 1)
            finally:
                # The fixture has exactly one child, whose live Popen handle is
                # retained even after intentional loss of the evidence helper.
                for owner in owners:
                    owner.child.terminate()
                    try:
                        owner.child.wait(timeout=5)
                    finally:
                        if owner.child.poll() is None:
                            owner.child.kill()
                            owner.child.wait(timeout=5)
                        owner._release_streams()
                    self.assertTrue(owner.closed)

    def test_limits_and_leader_exit_clean_children_including_detached_groups(self):
        for mode in ("timeout", "memory", "exit"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="rea-benchmark-test-") as root:
                directory = Path(root) / "trial"
                def run():
                    return measure([sys.executable, "-c", TREE, mode], directory,
                                   timeout=1 if mode == "timeout" else 10,
                                   memory_limit=64 * 1024**2 if mode == "memory" else 6 * 1024**3)
                if mode == "exit":
                    result = run()
                else:
                    with self.assertRaises(TimeoutError):
                        run()
                    result = json.loads((directory / "resources.json").read_text())
                self.assertEqual(result["interrupted_by_limit"], mode != "exit")
                self.assertTrue(result["cleanup"]["cleaned"])
                for pid in json.loads((directory / "stdout.log").read_text()):
                    self.assertFalse(psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)

    def test_unverified_cleanup_retains_manifest_and_stops_subsequent_trials(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-denied-") as root:
            first = Path(root) / "first"
            second = Path(root) / "second"

            snapshots = []

            def deny_cleanup(owner):
                owner.observe()
                snapshots.append(owner.coverage["snapshotCount"])
                return {"cleaned": False, "reason": "injected identity inspection denial"}

            try:
                with patch.object(OwnershipSession, "cleanup", deny_cleanup):
                    with self.assertRaises(CleanupIncomplete) as raised:
                        for directory in (first, second):
                            measure([sys.executable, "-c", SLEEPER], directory, timeout=.2)
                self.assertFalse(second.exists())
                self.assertFalse(json.loads((first / "resources.json").read_text())["cleanup"]["cleaned"])
                owner = raised.exception.owner
                helper_pid = owner.helper.pid
                self.assertIsNone(owner.helper.poll())
                owner.observe()
                self.assertGreater(owner.coverage["snapshotCount"], snapshots[0])
                self.assertEqual(owner.helper.pid, helper_pid)
                self.assertGreater(owner.coverage["retainedOwned"], 0)
            finally:
                self.assertEqual(raised.exception.ownership, json.loads((first / "ownership.json").read_text()))
                self.assertTrue(raised.exception.owner.cleanup()["cleaned"])
                raised.exception.child.wait(timeout=5)
                raised.exception.owner.close()
                self.assertEqual(raised.exception.owner.helper.returncode, 0)

    def test_failed_manifest_writes_preserve_cleanup_and_retry_without_files(self):
        for partial in (False, True):
            for denied in (False, True):
                with self.subTest(partial=partial, denied=denied), tempfile.TemporaryDirectory(prefix="rea-benchmark-write-") as root:
                    first, second = Path(root) / "first", Path(root) / "second"
                    write_text = Path.write_text
                    owner = None
                    original_cleanup = OwnershipSession.cleanup
                    cleanup_results = []
                    children = []
                    raised = None

                    def failed_write(path, data, *args, **kwargs):
                        if path.name == "ownership.json":
                            # Wait for acknowledged children before injecting the disk failure.
                            deadline = time.monotonic() + 5
                            while not children:
                                output = (first / "stdout.log").read_text()
                                if output.endswith("\n"):
                                    children.extend(json.loads(output))
                                elif time.monotonic() >= deadline:
                                    raise AssertionError("Synthetic process tree did not start")
                                else:
                                    time.sleep(.01)
                            if partial:
                                write_text(path, "{\"runId\":")
                            raise OSError("injected manifest write failure")
                        if path.name == "resources.json" and denied:
                            raise OSError("injected diagnostics write failure")
                        return write_text(path, data, *args, **kwargs)

                    def inspect_cleanup(session):
                        nonlocal owner
                        owner = session
                        result = ({"cleaned": False, "reason": "injected inspection denial"}
                                  if denied else original_cleanup(session))
                        cleanup_results.append(result)
                        return result

                    try:
                        with patch.object(Path, "write_text", failed_write), patch.object(OwnershipSession, "cleanup", inspect_cleanup):
                            with self.assertRaises(CleanupIncomplete if denied else OSError) as raised:
                                for directory in (first, second):
                                    measure([sys.executable, "-c", TREE, "timeout"], directory)
                        self.assertFalse(second.exists())
                        self.assertEqual(cleanup_results[0]["cleaned"], not denied)
                        if denied:
                            self.assertIs(raised.exception.owner, owner)
                            self.assertIs(raised.exception.ownership, owner.ownership)
                            self.assertRegex(str(raised.exception.__cause__), "manifest write failure")
                            self.assertIsNone(raised.exception.child.poll())
                        else:
                            self.assertRegex(str(raised.exception), "manifest write failure")
                            self.assertTrue(owner.closed)
                            self.assertEqual(owner.helper.returncode, 0)
                            for pid in [owner.ownership["leaderPid"], *children]:
                                self.assertFalse(psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)
                        if partial:
                            with self.assertRaises(json.JSONDecodeError):
                                json.loads((first / "ownership.json").read_text())
                        else:
                            self.assertFalse((first / "ownership.json").exists())
                    finally:
                        # No manifest is needed for retry, even after both writes failed.
                        if owner is not None and not owner.closed:
                            self.assertTrue(owner.cleanup()["cleaned"])
                        if denied and isinstance(getattr(raised, "exception", None), CleanupIncomplete):
                            raised.exception.child.wait(timeout=5)
                        if owner is not None:
                            owner.close()

    def test_large_prompt_does_not_block_limit_monitoring(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-stdin-") as root:
            directory = Path(root) / "trial"
            with self.assertRaises(TimeoutError):
                measure([sys.executable, "-c", SLEEPER], directory,
                        prompt="x" * 2 * 1024**2, timeout=.2)
            result = json.loads((directory / "resources.json").read_text())
            self.assertTrue(result["interrupted_by_limit"])
            self.assertTrue(result["cleanup"]["cleaned"])


if __name__ == "__main__":
    unittest.main()
