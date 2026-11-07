"""Run explicit local MCP and Codex comparisons; retain raw data outside the checkout."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import resource
import select
import signal
import subprocess
import sys
import tempfile
import time

import psutil


@contextmanager
def _defer_shutdown_signals():
    """Deliver graceful interruption only after an ownership transition settles."""
    signals = {signal.SIGINT, signal.SIGTERM}
    handlers, pending = {}, {}
    def defer(number, _frame):
        pending.setdefault(number, None)
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    try:
        for number in signals:
            handlers[number] = signal.signal(number, defer)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
    try:
        yield
    finally:
        failure = sys.exc_info()[1]
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
        try:
            for number, handler in handlers.items():
                signal.signal(number, handler)
        finally:
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous)
            except BaseException:
                if failure is None:
                    raise
        for number in pending:
            try:
                signal.raise_signal(number)
            except BaseException:
                if failure is None:
                    raise


class CleanupIncomplete(RuntimeError):
    """The retained process owner must be settled before another trial."""

    def __init__(self, message, child, ownership, owner):
        super().__init__(message)
        self.child = child  # Retain the direct-child handle for reaping after retry.
        self.ownership = ownership  # Persistence failure cannot release ownership.
        self.owner = owner  # The helper owns non-serializable identity evidence.


class OwnershipSession:
    """One live process owner; never reconstruct a failed trial from its manifest."""

    def __init__(self, node):
        self.child = None
        self.ownership = {}
        self.coverage = None
        self.cleaned = False
        self.closed = False
        self.shutdown_acknowledged = False
        self.shutdown_request = None
        self.preparation_failed = False
        self.final_diagnostics = None
        self.sequence = 0
        self.pending = b""
        self.errors = tempfile.TemporaryFile()
        self.helper = None
        try:
            with _defer_shutdown_signals():
                self.helper = subprocess.Popen(
                    [node, str(Path(__file__).with_name("benchmark-ownership.mjs"))],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors, bufsize=0,
                    start_new_session=True)
            self.ownership = self._response(0)["ownership"]
        except BaseException as cause:
            if self.helper is None:
                self.errors.close()
                raise
            self.preparation_failed = True
            try:
                self.close()
            except BaseException:
                raise CleanupIncomplete("Ownership helper preparation did not settle", None,
                                        self.ownership, self) from cause
            raise

    def _release_streams(self):
        streams = (self.helper.stdin, self.helper.stdout, self.errors)
        failure = None
        for stream in streams:
            try:
                stream.close()
            except BaseException as cause:
                if failure is None:
                    failure = cause
        self.closed = all(stream.closed for stream in streams)
        if failure is not None:
            raise failure

    def _response(self, wanted, timeout=60):
        deadline = time.monotonic() + timeout
        while True:
            while b"\n" in self.pending:
                with _defer_shutdown_signals():
                    line, self.pending = self.pending.split(b"\n", 1)
                    result = json.loads(line)
                    if result.get("id") != wanted:
                        if isinstance(result.get("id"), int) and result["id"] < wanted:
                            continue  # A timed-out earlier request cannot become this receipt.
                        raise RuntimeError("Ownership helper response identity mismatch")
                    if "error" in result:
                        if wanted == self.shutdown_request:
                            self.shutdown_request = None  # A received refusal did not accept close.
                        raise RuntimeError(result["error"])
                    self.coverage = result.get("evidence_coverage", self.coverage)
                    if wanted == self.shutdown_request:
                        self.shutdown_acknowledged = True
                    return result
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.helper.stdout], [], [], remaining)[0]:
                raise TimeoutError("Ownership helper response timed out; retain this session")
            # Waiting stays interruptible; consuming available bytes and their
            # receipt state must retain ownership before cancellation resumes.
            with _defer_shutdown_signals():
                chunk = os.read(self.helper.stdout.fileno(), 65536)
                self.pending += chunk
            if not chunk:
                raise RuntimeError("Ownership helper disappeared; its evidence cannot be restored from a manifest. "
                                   + self.diagnostics())
            if len(self.pending) > 16 * 1024**2:
                raise RuntimeError("Ownership helper response exceeds capture budget")

    def _request(self, operation):
        if self.shutdown_request is not None:
            if operation != "close":
                raise RuntimeError("Ownership helper shutdown is pending; retry close on this session")
            return self._response(self.shutdown_request)["result"]
        self.sequence += 1
        request = {"id": self.sequence, "operation": operation}
        if self.child is not None:
            request["leaderPid"] = self.child.pid
        message = (json.dumps(request) + "\n").encode()
        # Keep close identity and submission indivisible to graceful signals.
        # Deferred handlers deliver cancellation only after a possibly sent
        # request is retained, so retry consumes its receipt without replay.
        with _defer_shutdown_signals():
            if operation == "close":
                self.shutdown_request = self.sequence
            if self.helper.stdin.write(message) != len(message):
                raise OSError("Ownership helper request write was incomplete; retain this session")
        return self._response(self.sequence)["result"]

    def diagnostics(self):
        self.errors.seek(0)
        return self.errors.read(65536).decode("utf8", errors="replace")

    def _adopt(self, child):
        self.child = child
        self.ownership.update(leaderPid=child.pid, processGroupId=child.pid)

    def launch(self, command, **options):
        # The owner, not measure's local frame, retains a child before signals
        # resume or any fallible handshake/persistence runs.
        with _defer_shutdown_signals():
            self._adopt(subprocess.Popen(command, **options))
        return self.observe()

    def attach(self, child):
        self._adopt(child)
        return self.observe()

    def observe(self):
        return self._request("observe")

    def cleanup(self):
        result = self._request("cleanup")
        self.cleaned = result["cleaned"]
        return result

    def close(self):
        if self.closed:
            return
        if self.child is not None and not self.cleaned:
            raise RuntimeError("The retained target must be cleaned before closing its evidence owner")
        if not self.preparation_failed and not self.shutdown_acknowledged:
            self._request("close")
        self.helper.stdin.close()
        code = self.helper.wait(timeout=5)
        if self.final_diagnostics is None:
            self.final_diagnostics = self.diagnostics()
        self._release_streams()
        if code != 0 and not self.preparation_failed:
            raise RuntimeError("Ownership helper shutdown failed: " + self.final_diagnostics)


def measure(command, directory, prompt=None, timeout=600, *, node="node", memory_limit=6 * 1024**3):
    directory.mkdir(parents=True, exist_ok=False)
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    began = time.monotonic()
    owner = OwnershipSession(node)
    ownership = owner.ownership
    manifest = directory / "ownership.json"
    seen = {}
    peak = 0
    sample_count = 0
    denied_observations = 0
    timed_out = False
    cleanup = {"cleaned": False, "reason": "Cleanup has not run"}
    failure = None
    try:
        with (directory / "stdin.txt").open("w+") as input_stream, (directory / "stdout.log").open("w") as output, (directory / "process.stderr.log").open("w") as errors:
            if prompt:
                input_stream.write(prompt)
                input_stream.seek(0)
            workload_began = time.monotonic()
            owner.launch(command, stdin=input_stream,
                         stdout=output, stderr=errors, text=True, start_new_session=True,
                         env={**os.environ, "R2_COLOR": "0", "R2_UTF8": "0",
                              "REA_PROCESS_RUN_ID": ownership["runId"]})
            manifest.write_text(json.dumps(ownership, indent=2) + "\n")
            while owner.child.poll() is None:
                try:
                    parent = psutil.Process(owner.child.pid)
                    family = [parent, *parent.children(recursive=True)]
                except psutil.NoSuchProcess:
                    family = []
                rss = 0
                for process in family:
                    try:
                        with process.oneshot():
                            identity = (process.pid, process.create_time())
                            cpu = process.cpu_times()
                            rss += process.memory_info().rss
                            seen[identity] = max(seen.get(identity, 0), cpu.user + cpu.system)
                    except psutil.NoSuchProcess:
                        pass
                    except psutil.AccessDenied:
                        denied_observations += 1
                peak = max(peak, rss)
                sample_count += 1
                if time.monotonic() - workload_began > timeout or rss > memory_limit:
                    timed_out = True
                    break
                time.sleep(0.05)
    except BaseException as cause:
        failure = cause
    finally:
        cleanup_began = time.monotonic()
        try:
            cleanup = owner.cleanup() if owner.child is not None else {"cleaned": True}
            if cleanup["cleaned"]:
                if owner.child is not None:
                    owner.child.wait(timeout=5)
                owner.close()
        except BaseException as cause:
            cleanup = {"cleaned": False, "reason": str(cause)}
            if failure is None:
                failure = cause
        cleanup_seconds = time.monotonic() - cleanup_began
    code = owner.child.poll() if owner.child is not None else None
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    result = {
        "elapsed_seconds": time.monotonic() - began,
        "cpu_user_seconds": after.ru_utime - before.ru_utime,
        "cpu_system_seconds": after.ru_stime - before.ru_stime,
        "sampled_family_cpu_seconds": sum(seen.values()),
        "sampled_peak_family_rss_bytes": peak,
        "sample_interval_seconds": 0.05, "samples": sample_count,
        "observed_processes": len(seen),
        "denied_observations": denied_observations,
        "exit_code": code, "interrupted_by_limit": timed_out,
        "cleanup": cleanup, "cleanup_seconds": cleanup_seconds,
        "ownership_manifest": str(manifest),
        "ownership_helper_pid": owner.helper.pid,
        "measurement_scope": "elapsed and child CPU include owner startup/shutdown; sampled family CPU/RSS exclude the ownership helper",
    }
    try:
        (directory / "resources.json").write_text(json.dumps(result, indent=2) + "\n")
    except OSError as cause:
        if failure is None:
            failure = cause
    if not cleanup["cleaned"]:
        raise CleanupIncomplete(
            f"Owned cleanup is unverified; stopping trials. Retry through the retained owner session "
            f"(manifest at {manifest} cannot restore its evidence): {cleanup}", owner.child, ownership, owner) from failure
    if failure is not None:
        raise failure
    if timed_out:
        raise TimeoutError("Benchmark trial exceeded its time or memory limit; see " + str(directory / "resources.json"))
    if code != 0:
        raise RuntimeError(f"Benchmark child exited with status {code}; see {directory / 'resources.json'}")
    return result


def agent_command(config, lane, directory):
    native = lane.startswith("r2mcp")
    custom = config.get("servers", {}).get(lane)
    tools = custom["tools"] if custom else {
        "ghidra": ["open_binary", "procedure_pseudo_code", "procedure_assembly", "close_binary",
                   "search_strings", "xrefs", "resolve_containing_procedure", "procedure_callees", "analyze_function"],
        "r2-exec": ["execute_radare2_command"],
        "r2pipe2": ["start_radare2_session", "radare2_command", "close_radare2_session"],
        "r2mcp-raw": ["open_file", "run_command", "close_file"],
        "r2mcp-typed": ["open_file", "analyze", "decompile_function", "disassemble_function", "close_file",
                       "list_strings", "list_functions", "xrefs_to", "calculate"],
    }[lane]
    instruction = (
        "Use only the registered engine MCP tools for this static investigation. "
        "Do not run target code, write target bytes, fetch URLs, launch a GUI, or use other agents. "
        "Do not read source files or inspect other targets. Cite actual tool observations and addresses; "
        "use real REA Evidence IDs where provided, never invent them. "
        "Choose the analysis needed for the task; aa / analyze level 0 is basic analysis, "
        "and one-shot command processes do not retain analysis between calls. "
        "pdg is the available r2ghidra decompiler. "
        "Display policy is preconfigured: R2_COLOR=0, R2_UTF8=0, and embedded r2mcp startup sets "
        "scr.utf8=0 and asm.dwarf=false. Do not spend investigation calls checking display settings. "
        "Related read commands may be batched. Preserve unknowns and report tool failures. "
        "Close any opened analysis session before returning your answer."
    )
    if lane == "r2mcp-raw":
        instruction += (
            ' For run_command, encode an r2pipe2 request in the command string, '
            'for example {"cmd":"COMMAND","json":false,"trim":false}; '
            "retain the returned status and logs."
        )
    instruction += " " + config.get("instructions", "")
    workspace = directory / "workspace"
    workspace.mkdir(parents=True)
    settings = {
        "approval_policy": "never", "sandbox_mode": "read-only", "web_search": "disabled",
        "model_reasoning_effort": config["reasoning"], "developer_instructions": instruction,
        "features.multi_agent": False, "features.shell_tool": False,
        "features.unified_exec": False, "features.shell_snapshot": False,
        "mcp_servers.engine.command": custom["command"] if custom else config["r2mcp"] if native else config["node"],
        "mcp_servers.engine.args": custom["args"] if custom else (["-N", "-d", "pdg", "-c", "e asm.dwarf=false;e scr.utf8=0", *(["-r"] if lane == "r2mcp-raw" else [])]
                                    if native else [str(Path(config["rea3521"]) / "scripts/rea.mjs"), "mcp"]),
        "mcp_servers.engine.enabled_tools": tools,
        "mcp_servers.engine.required": True,
        "mcp_servers.engine.startup_timeout_sec": 60,
        "mcp_servers.engine.tool_timeout_sec": 600,
        "mcp_servers.engine.default_tools_approval_mode": "approve",
        "mcp_servers.engine.env.REA_LOG_LEVEL": "silent",
        "mcp_servers.engine.env.R2_COLOR": "0",
        "mcp_servers.engine.env.R2_UTF8": "0",
        "mcp_servers.engine.env.REA_R2_COMMAND": config["r2"],
        "mcp_servers.engine.env.GHIDRA_INSTALL_DIR": config["ghidra"],
        "mcp_servers.engine.env.JAVA_HOME": config["java"],
        "mcp_servers.engine.env.REA_ANALYSIS_PROVIDER": "ghidra",
    }
    for key, value in (custom or {}).get("env", {}).items():
        settings["mcp_servers.engine.env." + key] = value
    command = [config["codex"], "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
               "--strict-config", "--skip-git-repo-check", "--json", "--color", "never",
               "-m", config["model"], "-C", str(workspace),
               "--output-last-message", str(directory / "answer.txt")]
    for key, value in settings.items():
        command.extend(["-c", key + "=" + json.dumps(value)])
    command.append("-")
    # Custom environment values are runtime-only, without guessing secrecy from names.
    saved_settings = {**settings, **{
        "mcp_servers.engine.env." + key: "[not persisted]"
        for key in (custom or {}).get("env", {})
    }}
    (directory / "selected-settings.json").write_text(json.dumps(saved_settings, indent=2) + "\n")
    return command


def save_agent_summary(config, target, setup, directory, before_digest, failure):
    summary = {
        "requested_model": config["model"], "reasoning": config["reasoning"],
        "usage": [], "calls": [], "answer_path": str(setup / "answer.txt"),
        "target_sha256_before": before_digest, "target_sha256_after": None,
        "trial_status": "failed" if failure is not None else "completed",
        "correctness": "unknown",
    }
    try:
        if isinstance(failure, CleanupIncomplete):
            summary["target_sha256_after_unknown_reason"] = "Owned trial cleanup remains incomplete"
        else:
            summary["target_sha256_after"] = hashlib.sha256(Path(target["path"]).read_bytes()).hexdigest()
            summary["correctness"] = ("requires_source_oracle_review"
                                      if before_digest == summary["target_sha256_after"] else "artifact_changed")
        events = directory / "stdout.log"
        if events.exists():
            for line in events.read_text().splitlines():
                event = json.loads(line)
                if "usage" in event:
                    summary["usage"].append(event["usage"])
                item = event.get("item", {})
                if event.get("type") == "item.completed" and item.get("type") == "mcp_tool_call":
                    summary["calls"].append({key: item.get(key) for key in ["server", "tool", "arguments", "status", "error"]})
    except BaseException as cause:
        summary["summary_error"] = str(cause)
        summary["trial_status"] = "failed"
        raise
    finally:
        (directory / "agent-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary["target_sha256_after"] == before_digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("configuration", type=Path)
    parser.add_argument("mode", choices=["sdk", "agent"])
    parser.add_argument("--lanes", nargs="+")
    parser.add_argument("--targets", nargs="+")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--label", default="run")
    args = parser.parse_args()
    config = json.loads(args.configuration.read_text())
    if args.trials < 1:
        parser.error("--trials must be positive")
    unknown_lanes = set(args.lanes or ()) - set(config["lanes"])
    unknown_targets = set(args.targets or ()) - {target["id"] for target in config["targets"]}
    if unknown_lanes or unknown_targets:
        parser.error(f"Unknown selections: lanes={sorted(unknown_lanes)}, targets={sorted(unknown_targets)}")
    root = Path(config["output"]) / args.label
    root.mkdir(parents=True, exist_ok=True)
    lanes = args.lanes or config["lanes"]
    targets = [target for target in config["targets"] if not args.targets or target["id"] in args.targets]
    for trial in range(args.trials):
        # Alternate order to expose systematic first-run/cache effects.
        order = lanes if trial % 2 == 0 else list(reversed(lanes))
        for target in targets:
            for lane in order:
                directory = root / f"{args.mode}-{target['id']}-{lane}-{trial + 1}"
                if args.mode == "sdk":
                    command = [config["node"], config["sdk_driver"], str(args.configuration),
                               lane, target["id"], str(directory / "payload")]
                    result = measure(command, directory, node=config["node"])
                else:
                    setup = root / f"setup-{target['id']}-{lane}-{trial + 1}"
                    command = agent_command(config, lane, setup)
                    prompt = target["prompt"]
                    (setup / "prompt.txt").write_text(prompt)
                    before_digest = hashlib.sha256(Path(target["path"]).read_bytes()).hexdigest()
                    failure = None
                    try:
                        result = measure(command, directory, prompt=prompt, timeout=600, node=config["node"])
                    except BaseException as cause:
                        failure = cause
                        raise
                    finally:
                        try:
                            unchanged = save_agent_summary(config, target, setup, directory, before_digest, failure)
                        except BaseException as cause:
                            if failure is None:
                                raise
                            failure.add_note("Agent summary could not be completed: " + str(cause))
                    if not unchanged:
                        raise RuntimeError("Target changed during agent trial; stopping trials: " + target["path"])
                print(json.dumps({"mode": args.mode, "target": target["id"], "lane": lane,
                                  "trial": trial + 1, **result}), flush=True)


def run_cli():
    """Stop trials on failure, retaining the live owner through graceful exit."""
    draining = False
    interrupted = None

    def interrupt(number, _frame):
        nonlocal interrupted
        interrupted = interrupted or number
        if not draining:
            raise KeyboardInterrupt(f"Benchmark received signal {number}")

    def report(message):
        try:
            print(message, file=sys.stderr, flush=True)
        except OSError:
            pass  # A lost diagnostic peer cannot release cleanup authority.

    previous = {number: signal.signal(number, interrupt) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        main()
        return 0
    except CleanupIncomplete as failure:
        draining = True
        report(str(failure))
        owner = failure.owner
        while True:
            try:
                if owner.child is not None and not owner.cleaned:
                    if not owner.cleanup()["cleaned"]:
                        time.sleep(1)
                        continue
                if owner.child is not None:
                    owner.child.wait(timeout=5)
                owner.close()
                break
            except (Exception, KeyboardInterrupt):
                time.sleep(1)  # Keep this exact session; never replay the trial.
        report("Retained benchmark cleanup verified; no further trials were started")
        return 128 + interrupted if interrupted is not None else 1
    except KeyboardInterrupt:
        return 128 + interrupted if interrupted is not None else 130
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    raise SystemExit(run_cli())
