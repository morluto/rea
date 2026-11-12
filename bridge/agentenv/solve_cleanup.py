"""Recover local sandboxes under one stopped solve's private agentenv root."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import subprocess
import sys
from pathlib import Path


def _docker(*args: str) -> str:
    command = os.environ.get("REA_DOCKER_COMMAND") or "docker"
    result = subprocess.run([command, *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"Docker {' '.join(args[:2])} failed: {result.stderr[-1000:]}")
    return result.stdout.strip()


async def cleanup(root: Path) -> None:
    # A helper has already stopped. agentenv lists the sandboxes under the root
    # (AGENT_ENV_LOCAL_SANDBOX_DIR); anything else there remains owned for inspection.
    if not any(root.iterdir()):
        return
    from agent_env.providers.sandbox_providers.local_docker.provider import (
        LocalSandboxProvider, local_sandbox_ids, remove_local_work_dir,
    )
    for sandbox_id in local_sandbox_ids():
        await LocalSandboxProvider().terminate_sandbox(sandbox_id)
        # The pinned provider reports incomplete teardown and retains the folder.
        # Keep REA's independent Docker/Linux checks before releasing that owner.
        if _docker("ps", "-aq", "--filter", f"name=^agent-{sandbox_id}$"):
            raise RuntimeError(f"Sandbox {sandbox_id} still has its agent container")
        if _docker("ps", "-aq", "--filter", f"label=agentenv.sandbox={sandbox_id}"):
            raise RuntimeError(f"Sandbox {sandbox_id} still has labeled containers")
        if _docker("network", "ls", "-q", "--filter", f"label=agentenv.sandbox={sandbox_id}"):
            raise RuntimeError(f"Sandbox {sandbox_id} still has labeled networks")
        if sys.platform != "linux":
            raise RuntimeError(f"Cannot verify host processes for sandbox {sandbox_id} on {sys.platform}")
        from agent_env.providers.sandbox_providers.local_docker.provider import _marked_pids
        if _marked_pids(sandbox_id):
            raise RuntimeError(f"Sandbox {sandbox_id} still has marked host processes")
        if remove_local_work_dir(sandbox_id) is None:
            raise RuntimeError(f"Could not confirm removal of sandbox {sandbox_id}'s work folder")
    leftover = sorted(entry.name for entry in root.iterdir())
    if leftover:
        raise RuntimeError(f"Unexpected sandbox root entries: {', '.join(leftover)}")


def main() -> int:
    try:
        with contextlib.redirect_stdout(sys.stderr):
            asyncio.run(cleanup(Path(os.environ["AGENT_ENV_LOCAL_SANDBOX_DIR"])))
        print(json.dumps({"ok": True}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
