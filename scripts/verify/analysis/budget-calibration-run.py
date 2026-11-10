"""Observe one selected experiment's process group and descendant tree.

macOS has no cgroup peak counter. RSS is a sampled sum, not an exact kernel
peak or aggregate memory hard limit. Only the owned group is stopped early;
descendant-tree sampling is observational and does not confer signal authority.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import time


def process_snapshot():
    rows = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,rss="],
        text=True, capture_output=True, check=True,
    ).stdout.splitlines()
    return [tuple(map(int, row.split())) for row in rows]


def group_rss(group, snapshot=None):
    if snapshot is None:
        snapshot = process_snapshot()
    return [(pid, kib * 1024) for pid, _, pgid, kib in snapshot if pgid == group]


def tree_rss(root, snapshot):
    children = {}
    for pid, ppid, _, _ in snapshot:
        children.setdefault(ppid, []).append(pid)
    pending = [root]
    descendants = set()
    while pending:
        pid = pending.pop()
        if pid not in descendants:
            descendants.add(pid)
            pending.extend(children.get(pid, []))
    return [(pid, kib * 1024) for pid, _, _, kib in snapshot if pid in descendants]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=90)
    parser.add_argument("--memory-mib", type=int, default=1536)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command or options.timeout_seconds <= 0 or options.memory_mib <= 0:
        parser.error("Select an argv target and positive observation bounds")
    output = Path(options.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    stdout_path = output.with_suffix(".stdout")
    stderr_path = output.with_suffix(".stderr")
    peak = 0
    maximum_members = 0
    tree_peak = 0
    maximum_tree_members = 0
    samples = 0
    stopped = None
    usage = None
    status = None
    signal_errors = []
    observer_error = None
    started = time.monotonic()
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.Popen(
            command, cwd=options.cwd, stdout=stdout, stderr=stderr,
            start_new_session=True,
        )

        def reap():
            nonlocal status, usage
            if process.returncode is not None:
                return True
            pid, observed_status, observed_usage = os.wait4(process.pid, os.WNOHANG)
            if not pid:
                return False
            status, usage = observed_status, observed_usage
            process.returncode = os.waitstatus_to_exitcode(status)
            return True

        def root_exited():
            # Keep the session leader waitable until group cleanup finishes.
            # Its reserved PID prevents our process-group identity being reused.
            return os.waitid(
                os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT,
            ) is not None

        def group_has_work():
            exited = root_exited()
            return any(
                pid != process.pid or not exited
                for pid, _ in group_rss(process.pid)
            )

        def signal_owned_group(selected_signal):
            # A sample and the following signal are not atomic. A completed
            # root may still own live children. Do not reap it before their
            # cleanup, and preserve receipts when the OS refuses a signal.
            if not group_has_work():
                return
            try:
                os.killpg(process.pid, selected_signal)
            except ProcessLookupError:
                pass
            except OSError as error:
                signal_errors.append({
                    "signal": selected_signal.name,
                    "errno": error.errno,
                    "reason": str(error),
                })

        def stop_owned_group():
            signal_owned_group(signal.SIGTERM)
            time.sleep(0.2)
            signal_owned_group(signal.SIGKILL)
            deadline = time.monotonic() + 1
            while group_has_work() and time.monotonic() < deadline:
                time.sleep(0.02)
            reap()

        try:
            while True:
                if root_exited():
                    if group_has_work():
                        stopped = "target_exited_with_group_members"
                        stop_owned_group()
                    else:
                        reap()
                    break
                # One OS snapshot supplies both scopes. Ancestry is an
                # observation, never permission to signal detached children.
                snapshot = process_snapshot()
                members = group_rss(process.pid, snapshot)
                tree_members = tree_rss(process.pid, snapshot)
                samples += 1
                peak = max(peak, sum(rss for _, rss in members))
                maximum_members = max(maximum_members, len(members))
                tree_peak = max(tree_peak, sum(rss for _, rss in tree_members))
                maximum_tree_members = max(maximum_tree_members, len(tree_members))
                elapsed = time.monotonic() - started
                if peak > options.memory_mib * 1024 * 1024:
                    stopped = "sampled_group_rss_early_stop"
                elif elapsed > options.timeout_seconds:
                    stopped = "wall_deadline"
                if stopped:
                    stop_owned_group()
                    break
                time.sleep(0.02)
        except BaseException as error:
            observer_error = {"type": type(error).__name__, "reason": str(error)}
            stopped = stopped or "observer_error"
            stop_owned_group()
    remaining = group_rss(process.pid)
    receipt = {
        "schema": "rea-budget-calibration/v1",
        "argv": command,
        "cwd": options.cwd,
        "platform": platform.platform(),
        "elapsed_seconds": time.monotonic() - started,
        "cpu_seconds_waited_subtree": usage.ru_utime + usage.ru_stime if usage else None,
        "peak_process_group_rss_bytes_sampled": peak,
        "maximum_group_members_sampled": maximum_members,
        "peak_process_tree_rss_bytes_sampled": tree_peak,
        "maximum_tree_members_sampled": maximum_tree_members,
        "sample_count": samples,
        "sample_interval_seconds": 0.02,
        "memory_early_stop_bytes": options.memory_mib * 1024 * 1024,
        "memory_early_stop_scope": "owned_process_group",
        "wall_deadline_seconds": options.timeout_seconds,
        "wall_deadline_signal_scope": "owned_process_group",
        "stop_reason": stopped,
        "signal_errors": signal_errors,
        "observer_error": observer_error,
        "exit_code": process.returncode,
        "cleanup": "group_empty" if not remaining else "group_members_remaining",
        "cleanup_scope": "owned_process_group",
        "remaining_group_pids": [pid for pid, _ in remaining],
        "stdout": str(stdout_path),
        "stderr": str(stderr_path),
        "stdout_sha256": hashlib.sha256(stdout_path.read_bytes()).hexdigest(),
        "stderr_sha256": hashlib.sha256(stderr_path.read_bytes()).hexdigest(),
        "limitations": [
            "RSS scopes are simultaneous sums within each ps snapshot; short peaks can be missed.",
            "Shared pages can be counted in multiple members' RSS.",
            "Group RSS excludes descendants that leave this group; tree RSS includes detached descendants while PPID ancestry remains linked to the waitable root.",
            "Tree samples can miss exited, reparented, or orphaned descendants; no cumulative PID list or descendant signal authority is inferred.",
            "CPU is OS wait4 user+system usage of the waited subtree; sampler CPU is excluded.",
            "CPU excludes descendants the target did not wait for, including orphaned children.",
            "Memory early stop and cleanup signals apply only to the owned group, not the observed tree; neither RSS metric is a kernel hard limit.",
            "Wall time includes observation overhead; OS caches are not flushed.",
        ],
    }
    output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: receipt[key] for key in [
        "elapsed_seconds", "cpu_seconds_waited_subtree",
        "peak_process_group_rss_bytes_sampled", "exit_code", "cleanup", "stop_reason",
        "peak_process_tree_rss_bytes_sampled",
    ]}))
    return process.returncode if not stopped and not remaining and process.returncode is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
