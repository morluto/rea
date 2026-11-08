"""Run one solve of a bundle's task in a fresh agentenv computer for REA and print how it ended.

REA runs ``solve.py <bundle folder> <task> <model> <agent>`` with the agentenv runner's own interpreter, so
``agent_env`` imports. It runs the task once on this machine with ``run_bundle``, the solver deployed as the agent
and asked on the model, the endpoint taken from the environment or agentenv's config as a run takes it, and the
computer torn down as the run ends. It prints one JSON line: the run's outcome, instance id, seconds, each check's
result, the solver's turns and cost from its trajectory when that is a local file, and agentenv's version; or
``{"error": ...}`` when the task could not run. Everything else, agentenv's progress included, goes to stderr. It exits
0 after a run and 2 when none ran.
"""

from __future__ import annotations

import json
import os
import sys
from importlib import metadata
from pathlib import Path

#: The most characters of a check's description or a run's error REA keeps.
MAX_TEXT = 400


def _protocol():
    """A private copy of stdout for the JSON line; fd 1 then points at stderr, as do children that inherit it."""
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return protocol


def _say(protocol, value: dict) -> None:
    protocol.write(json.dumps(value) + "\n")
    protocol.flush()


def _field(value, name: str):
    """A field of agentenv's dataclasses, or of the dicts a stored context holds."""
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def _trajectory_end(context) -> tuple:
    """The solver's turns and cost from the last record of its local trajectory, or None for each."""
    for response in reversed(_field(context, "prompt_responses") or []):
        url = _field(response, "agent_trajectory_object_url") or ""
        if not url.startswith("file://"):
            continue
        try:
            records = json.loads(Path(url[len("file://"):]).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None, None
        last = records[-1] if isinstance(records, list) and records and isinstance(records[-1], dict) else {}
        turns, usd = last.get("num_turns"), last.get("total_cost_usd")
        return (turns if isinstance(turns, int) else None,
                float(usd) if isinstance(usd, (int, float)) and not isinstance(usd, bool) else None)
    return None, None


def _checks(context, task: str) -> list:
    """Each check's result as the task's verifier recorded it under the instance's verifications."""
    verifications = (_field(context, "metadata") or {}).get("verifications") or {}
    found = verifications.get(task) or next(iter(verifications.values()), {})
    results = found.get("results") if isinstance(found, dict) else None
    return [{"id": str(result.get("id")), "passed": result.get("result") is True,
             "description": str(result.get("description", ""))[:MAX_TEXT]}
            for result in results or [] if isinstance(result, dict)]


def _version() -> str | None:
    try:
        return metadata.version("agentenv-framework")
    except metadata.PackageNotFoundError:
        return None


def _cleanup(result) -> dict:
    """Only a returned teardown report can confirm what agentenv released."""
    if result is None:
        return {"unknown": True, "sandboxes": []}
    unknown, sandboxes = False, []
    for run in result.runs:
        report = getattr(run, "torn_down", None)
        if report is None:
            unknown = True
        else:
            sandboxes.extend({"id": item.sandbox_id, "type": item.sandbox_type} for item in report.still_up)
    return {"unknown": unknown, "sandboxes": sandboxes}


def main(argv: list[str]) -> int:
    protocol = _protocol()
    bundle, task, model, agent = argv[1:5]
    try:
        from agent_env.bundle import run_bundle
    except ImportError as error:
        _say(protocol, {"error": f"agent_env does not import with {sys.executable}: {error}",
                        "cleanup": {"unknown": False, "sandboxes": []}})
        return 2
    try:
        result = run_bundle(bundle, tasks=[task], model=model, agent=agent, sandbox="local", emulate=False,
                            on_progress=lambda line: print(line, file=sys.stderr, flush=True))
    except BaseException as error:  # noqa: BLE001 - a signal's RunInterrupted too; run_bundle tore its run down
        _say(protocol, {"error": f"{type(error).__name__}: {error}"[:MAX_TEXT * 4],
                        "cleanup": _cleanup(getattr(error, "result", None))})
        return 2
    run = result.runs[0] if result.runs else None
    if run is None:
        _say(protocol, {"error": "the bundle ran no task", "cleanup": _cleanup(result)})
        return 2
    turns, usd = _trajectory_end(run.context)
    error = getattr(run, "error", None)
    _say(protocol, {"outcome": run.outcome.value, "instance_id": run.instance_id,
                    "seconds": round(float(run.duration), 1), "checks": _checks(run.context, task),
                    "turns": turns, "usd": usd, "agentenv": _version(),
                    "error": None if error is None else f"{type(error).__name__}: {error}"[:MAX_TEXT],
                    "cleanup": _cleanup(result)})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
