"""Keep one agentenv computer up for REA until stdin closes or SIGTERM arrives.

REA runs ``computer.py <bundle folder> [task]`` with the agentenv runner's own interpreter, so ``agent_env``
imports. It deploys the bundle's task, ``smoke`` by default, on this machine with
``run_bundle(keep=True, emulate=False)``, prints one JSON line naming the computer's address, MCP URL, control
token and sandbox id, or ``{"error": ...}``, and tears the computer down once its stdin closes or it gets SIGTERM
or SIGINT. Everything else it or agentenv prints, a build's output included, goes to stderr. It exits 0 once
the teardown left nothing up, 1 when it did, and 2 when no computer came up.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading


def _protocol():
    """A private copy of stdout for the JSON line; fd 1 then points at stderr, as do children that inherit it."""
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return protocol


def _say(protocol, value: dict) -> None:
    protocol.write(json.dumps(value) + "\n")
    protocol.flush()


def _computer(result):
    """The run's deployed computer, or why there is none."""
    run = result.runs[0] if result.runs else None
    if run is None:
        return None, "the bundle ran no task"
    if run.error is not None or run.failed_steps:
        return None, f"the task failed: {run.error or run.failed_steps}"
    for env in run.context.deployed_envs:
        if env.environment_url and env.mcp_url and getattr(env, "sandbox_id", None):
            return env, None
    return None, "the task deployed no computer"


def _stop_at_eof(stop: threading.Event) -> None:
    """Watch the pipe without holding stdin's buffered lock during signal-driven interpreter shutdown."""
    while os.read(sys.stdin.fileno(), 64 * 1024):
        pass
    stop.set()


def main(argv: list[str]) -> int:
    protocol = _protocol()
    bundle, task = argv[1], argv[2] if len(argv) > 2 else "smoke"
    try:
        from agent_env.bundle import run_bundle
    except ImportError as error:
        _say(protocol, {"error": f"agent_env does not import with {sys.executable}: {error}"})
        return 2
    try:
        result = run_bundle(bundle, tasks=[task], keep=True, emulate=False, sandbox="local",
                            on_progress=lambda line: print(line, file=sys.stderr, flush=True))
    except BaseException as error:  # noqa: BLE001 - a signal's RunInterrupted too; run_bundle tore its runs down
        _say(protocol, {"error": f"{type(error).__name__}: {error}"})
        return 2
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    env, problem = _computer(result)
    try:
        if env is None:
            _say(protocol, {"error": problem})
        else:
            _say(protocol, {"base_url": env.environment_url, "mcp_url": env.mcp_url,
                            "control_token": env.control_token, "sandbox_id": env.sandbox_id})
            threading.Thread(target=_stop_at_eof, args=(stop,), daemon=True).start()
            while not stop.wait(0.5):
                pass
    finally:
        torn_down = result.teardown()
    still_up = [sandbox for run in torn_down.runs if run.torn_down is not None for sandbox in run.torn_down.still_up]
    if still_up:
        print(f"still up after the teardown: {still_up}", file=sys.stderr, flush=True)
        return 1
    return 0 if env is not None else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
