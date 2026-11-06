"""Run REA inside an agentenv build computer for REA on the host: capture the app, draft its task and export it.

REA sends this file's source through the computer's ``computer-exec/v1`` route as
``python3 -I -c <source> <command> <JSON arguments>``; each command prints one JSON line and exits. ``start``
leaves the capture running on its own: its stdin is a FIFO it holds open for reading and writing, so it never
sees the end of its input, and ``mark`` and ``stop`` write their requests there and wait for the capture's own
acknowledgement on its progress log. A small shell around the capture writes its exit status to a file, the
mark a later command reads. REA runs as the session user in the home, with no ``AGENTENV_*`` variable, so
neither REA nor the app it launches holds the computer's control token, and with ``APT_CONFIG`` naming the
package lists ``start`` downloads as that user, so the capture finds the package's sources.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

POLL_S = 0.2
TAIL_BYTES = 4096


def _say(value: dict) -> int:
    print(json.dumps(value), flush=True)
    return 0


def _tail(path: str) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(max(0, os.path.getsize(path) - TAIL_BYTES))
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _environment(work: str) -> dict:
    environment = {name: value for name, value in os.environ.items() if not name.startswith("AGENTENV_")}
    environment["APT_CONFIG"] = os.path.join(work, "apt", "apt.conf")
    return environment


def _apt(work: str, timeout: float) -> dict:
    """Download the package lists into the work folder as the session user, until one update succeeds."""
    root = os.path.join(work, "apt")
    lists = os.path.join(root, "lists")
    updated = os.path.join(root, "updated")
    os.makedirs(os.path.join(lists, "partial"), exist_ok=True)
    os.makedirs(os.path.join(root, "cache", "archives", "partial"), exist_ok=True)
    with open(os.path.join(root, "apt.conf"), "w", encoding="utf-8") as conf:
        conf.write(f'Dir::State::Lists "{lists}";\nDir::Cache "{root}/cache";\nDebug::NoLocking "true";\n')
    # apt keeps lists compressed as it fetched them, such as *_Packages.lz4 on Ubuntu.
    count = lambda: len([name for name in os.listdir(lists) if re.search(r"_Packages(\.\w+)?$", name)])  # noqa: E731
    if os.path.exists(updated):
        return {"lists": count(), "updated": False}
    log = os.path.join(root, "update.log")
    try:
        with open(log, "wb") as output:
            code = subprocess.run(["apt-get", "update"], env=_environment(work), stdin=subprocess.DEVNULL,
                                  stdout=output, stderr=subprocess.STDOUT, timeout=timeout).returncode
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"lists": count(), "updated": True, "error": f"{type(error).__name__}: {error}"}
    if code == 0:
        # Only a whole update is kept, so a failed or partial one runs again on the next start.
        open(updated, "w").close()
        return {"lists": count(), "updated": True, "exit_code": code}
    return {"lists": count(), "updated": True, "exit_code": code,
            "error": f"apt-get update exited {code}: {_tail(log)[-1500:].strip()}"}


def _exit_code(capture: str):
    try:
        with open(os.path.join(capture, "exit"), encoding="utf-8") as handle:
            return int(handle.read().strip() or "-1")
    except (OSError, ValueError):
        return None


def _ended(capture: str, code: int) -> dict:
    """A capture that has exited: its status, the end of its progress log and its output's size, which REA reads
    whole for the Evidence or failure it ended with, whichever step was waiting on it."""
    return {"exited": code, "progress": _tail(os.path.join(capture, "progress.log")),
            "output_bytes": os.path.getsize(os.path.join(capture, "capture.out"))}


def _event_line(path: str, offset: int, kinds: set, name):
    """The first progress line after ``offset`` whose event is of one of ``kinds``, for ``name`` when given."""
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            lines = handle.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            event = json.loads(line)["rea_progress"]["event"]
        except (ValueError, KeyError, TypeError):
            continue
        if isinstance(event, dict) and event.get("kind") in kinds and (name is None or event.get("name") == name):
            return line
    return None


def _wait(capture: str, offset: int, kinds: set, name, timeout: float) -> dict:
    """Wait for the capture's event, or for it to exit, or for time to run out."""
    log = os.path.join(capture, "progress.log")
    deadline = time.monotonic() + timeout
    while True:
        line = _event_line(log, offset, kinds, name)
        if line is not None:
            return {"line": line}
        code = _exit_code(capture)
        if code is not None:
            return _ended(capture, code)
        if time.monotonic() > deadline:
            return {"timed_out": True, "progress": _tail(log)}
        time.sleep(POLL_S)


def start(arguments: dict) -> int:
    work, capture = os.path.abspath(arguments["work"]), os.path.abspath(arguments["capture"])
    rea = shutil.which("rea")
    if rea is None:
        return _say({"error": "REA is not installed in this computer; start the computer from a request, which installs it."})
    if os.path.exists(capture):
        return _say({"error": f"the capture folder {capture} is already used"})
    apt = _apt(work, arguments.get("apt_timeout_s", 600))
    try:
        os.makedirs(capture)
    except FileExistsError:
        return _say({"error": f"a stop claimed {capture} before the capture launched", "apt": apt})
    control = os.path.join(capture, "control")
    os.mkfifo(control, 0o600)
    argv = [rea, "capture-desktop-application", "--desktop-entry", arguments["desktop_entry"],
            "--output", os.path.join(capture, "capture"), "--exclude", work, "--json"]
    for value in arguments.get("arguments", []):
        argv += ["--argument", value]
    if arguments.get("package_file"):
        argv += ["--package-file", arguments["package_file"]]
    # Reading and writing, so the capture never reads the end of its input between requests.
    reader = os.open(control, os.O_RDWR)
    try:
        with open(os.path.join(capture, "capture.out"), "wb") as out, \
                open(os.path.join(capture, "progress.log"), "wb") as progress:
            process = subprocess.Popen(
                ["sh", "-c", 'done=$1; shift; "$@"; code=$?; printf "%s" "$code" > "$done.tmp" && mv "$done.tmp" "$done"',
                 "sh", os.path.join(capture, "exit"), *argv],
                cwd=os.path.expanduser("~"), env=_environment(work), stdin=reader, stdout=out, stderr=progress,
                start_new_session=True)
    finally:
        os.close(reader)
    waited = _wait(capture, 0, {"window_open"}, None, arguments.get("timeout_s", 120))
    return _say({"pid": process.pid, "apt": apt, **waited})


def _request(capture: str, line: str) -> bool:
    """Write one request to the running capture; False when nothing reads its FIFO any more."""
    try:
        fd = os.open(os.path.join(capture, "control"), os.O_WRONLY | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    return True


def mark(arguments: dict) -> int:
    capture, name = os.path.abspath(arguments["capture"]), arguments["name"]
    code = _exit_code(capture)
    log = os.path.join(capture, "progress.log")
    if code is not None:
        return _say(_ended(capture, code))
    # A checkpoint already taken, whose answer was lost, is answered from the capture's own log.
    taken = _event_line(log, 0, {"checkpoint"}, name)
    if taken is not None:
        return _say({"line": taken})
    offset = os.path.getsize(log)
    if not _request(capture, f"checkpoint {name}"):
        return _say({"error": "the capture is not reading its requests"})
    return _say(_wait(capture, offset, {"checkpoint", "checkpoint_refused"}, name, arguments.get("timeout_s", 600)))


def stop(arguments: dict) -> int:
    capture = os.path.abspath(arguments["capture"])
    if _exit_code(capture) is None and not os.path.exists(os.path.join(capture, "control")):
        # Never launched: claim the folder, so a start still on its way finds it used and launches nothing.
        os.makedirs(capture, exist_ok=True)
        return _say({"absent": True})
    if _exit_code(capture) is None:
        _request(capture, "stop")
    deadline = time.monotonic() + arguments.get("timeout_s", 600)
    while (code := _exit_code(capture)) is None and time.monotonic() < deadline:
        time.sleep(POLL_S)
    log = os.path.join(capture, "progress.log")
    if code is None:
        return _say({"timed_out": True, "progress": _tail(log)})
    output = os.path.join(capture, "capture.out")
    return _say({"exit_code": code, "progress": _tail(log), "output_bytes": os.path.getsize(output)})


def run(arguments: dict) -> int:
    """Run one REA command with its output in a file, after writing the files it reads."""
    rea = shutil.which("rea")
    if rea is None:
        return _say({"error": "REA is not installed in this computer"})
    for path, text in arguments.get("files", {}).items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
    with open(arguments["stdout"], "wb") as out:
        try:
            done = subprocess.run([rea, *arguments["argv"]], cwd=os.path.expanduser("~"),
                                  env=_environment(os.path.abspath(arguments["work"])), stdin=subprocess.DEVNULL, stdout=out,
                                  stderr=subprocess.PIPE, timeout=arguments.get("timeout_s", 1800))
        except subprocess.TimeoutExpired:
            return _say({"timed_out": True})
    return _say({"exit_code": done.returncode, "stdout_bytes": os.path.getsize(arguments["stdout"]),
                 "stderr": done.stderr[-TAIL_BYTES:].decode("utf-8", "replace")})


def listing(arguments: dict) -> int:
    """Every regular file under a folder, by its path relative to the home, with its size and SHA-256.

    The list goes to the file ``output`` names, outside the folder, and the answer gives its size: a large
    bundle's list outgrows the 1 MiB of stdout a command answers with, so REA reads it through ``data/get``.
    """
    home = os.path.expanduser("~")
    files, skipped = [], []
    for directory, folders, names in os.walk(os.path.abspath(arguments["root"])):
        folders.sort()
        for name in sorted(names):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, home)
            if os.path.islink(path) or not os.path.isfile(path):
                skipped.append(relative)
                continue
            digest = hashlib.sha256()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            files.append({"path": relative, "size": os.path.getsize(path), "sha256": digest.hexdigest()})
    output = os.path.abspath(arguments["output"])
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump({"files": files, "skipped": skipped}, handle)
    return _say({"listing_bytes": os.path.getsize(output)})


COMMANDS = {"start": start, "mark": mark, "stop": stop, "run": run, "list": listing}

if __name__ == "__main__":
    sys.exit(COMMANDS[sys.argv[1]](json.loads(sys.argv[2])))
