"""Run REA inside an agentenv build computer for REA on the host: capture the app, draft its task and export it.

REA sends this file's source through the computer's ``computer-exec/v1`` route as
``python3 -I -c <source> <command> <JSON arguments>``. JSON that would exceed the bytes Linux
passes as one string travels as several arguments, which this file joins before parsing. Each command prints
one JSON line and exits. ``start``
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
        conf.write(
            f'Dir::State::Lists "{lists}";\n'
            f'Dir::Cache "{root}/cache";\n'
            'Debug::NoLocking "true";\n'
            'APT::Update::Error-Mode "any";\n'
        )
    # apt keeps lists compressed as it fetched them, such as *_Packages.lz4 on Ubuntu.
    count = lambda: len([name for name in os.listdir(lists) if re.search(r"_Packages(\.\w+)?$", name)])  # noqa: E731
    # A marker left by an update that fetched nothing is not a success; download again.
    if os.path.exists(updated) and count() > 0:
        return {"lists": count(), "updated": False}
    log = os.path.join(root, "update.log")
    try:
        with open(log, "wb") as output:
            code = subprocess.run(["apt-get", "update"], env=_environment(work), stdin=subprocess.DEVNULL,
                                  stdout=output, stderr=subprocess.STDOUT, timeout=timeout).returncode
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"lists": count(), "updated": True, "error": f"{type(error).__name__}: {error}"}
    lists_fetched = count()
    if code == 0 and lists_fetched > 0:
        # Only a whole update that fetched lists is kept, so a failed or empty one runs again.
        open(updated, "w").close()
        return {"lists": lists_fetched, "updated": True, "exit_code": code}
    if code == 0:
        return {"lists": lists_fetched, "updated": True, "exit_code": code,
                "error": "apt-get update exited 0 without a package list"}
    return {"lists": lists_fetched, "updated": True, "exit_code": code,
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


def _within(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder + os.sep)


def _state_paths(values: list, work: str):
    """Each state path as an absolute path strictly under the home and outside REA's work folder, both as named
    and with its links resolved, or the refusal of the first that is not. The capture resolves the links again
    and retains what they lead to, so a link out of the home is refused here. Each passes on as named, so the
    capture keeps what its spelling means, such as a hidden settings folder."""
    home = os.path.normpath(os.path.expanduser("~"))
    real_home, real_work = os.path.realpath(home), os.path.realpath(work)
    spellings = {home, real_home}
    paths = []
    for value in values:
        relative = value[2:] if value.startswith("~/") else value
        path = os.path.normpath(os.path.join(home, relative))
        if ".." in relative.split("/") or not any(path.startswith(spelling + os.sep) for spelling in spellings):
            return None, f"The state path {value} is not under the computer's home, {home}."
        # Every link on the way is followed, a dangling one too; a path that does not exist yet resolves
        # through its nearest existing folder.
        resolved = os.path.realpath(path)
        if not resolved.startswith(real_home + os.sep):
            return None, f"The state path {value} leads through a link to {resolved}, which is not under the computer's home, {home}."
        if _within(path, work) or _within(resolved, real_work):
            return None, f"The state path {value} is in REA's work folder {work}, which every capture leaves out."
        paths.append(path)
    return paths, None


def start(arguments: dict) -> int:
    work, capture = os.path.abspath(arguments["work"]), os.path.abspath(arguments["capture"])
    rea = shutil.which("rea")
    if rea is None:
        return _say({"error": "REA is not installed in this computer; start the computer from a request, which installs it."})
    state_paths, refusal = _state_paths(arguments.get("state_paths", []), work)
    if refusal is not None:
        return _say({"refused": refusal})
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
    for path in state_paths:
        argv += ["--state-path", path]
    if arguments.get("package_file"):
        argv += ["--package-file", arguments["package_file"]]
    # Reading and writing, so the capture never reads the end of its input between requests.
    reader = os.open(control, os.O_RDWR)
    process = None
    try:
        try:
            with open(os.path.join(capture, "capture.out"), "wb") as out, \
                    open(os.path.join(capture, "progress.log"), "wb") as progress:
                process = subprocess.Popen(
                    ["sh", "-c", 'done=$1; shift; "$@"; code=$?; printf "%s" "$code" > "$done.tmp" && mv "$done.tmp" "$done"',
                     "sh", os.path.join(capture, "exit"), *argv],
                    cwd=os.path.expanduser("~"), env=_environment(work), stdin=reader, stdout=out, stderr=progress,
                    start_new_session=True)
        except Exception as cause:
            # Nothing will write exit. Record one and drop the FIFO, so stop does not wait on it.
            try:
                with open(os.path.join(capture, "exit"), "w", encoding="utf-8") as handle:
                    handle.write("1")
            except OSError:
                pass
            try:
                os.unlink(control)
            except OSError:
                pass
            return _say({"error": f"the capture did not start: {cause}"})
    finally:
        os.close(reader)
    if process is None:
        return _say({"error": "the capture did not start"})
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
    """Request a checkpoint and answer with the capture's acknowledgement line as it wrote it: the checkpoint's
    counts and up to ten of the files that changed, home-relative, with a count of the rest."""
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
    os.makedirs(os.path.dirname(arguments["stdout"]), exist_ok=True)
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


# The controller is sent with python -c, so a detached supervisor needs its
# own source. It alone holds the child process handle and signals its group.
LONG_RUN = r'''
import json, os, signal, subprocess, sys, threading, time
job = sys.argv[1]
result = {}
child = None
drainer = None
stderr_tail, stderr_errors = bytearray(), []

def drain(stream):
    try:
        while chunk := stream.read1(65536):
            stderr_tail.extend(chunk)
            del stderr_tail[:-4096]
    except OSError as error:
        stderr_errors.append(str(error))
    finally:
        try:
            stream.close()
        except OSError as error:
            stderr_errors.append(str(error))

def timed_out_marker():
    try:
        open(os.path.join(job, "timed_out"), "x").close()
    except FileExistsError:
        pass

try:
    request = json.loads("".join(sys.argv[2:]))
    if os.path.exists(os.path.join(job, "cancel")):
        result = {"absent": True}
    else:
        with open(request["stdout"], "wb") as out:
            child = subprocess.Popen(request["argv"], cwd=request["home"], stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=subprocess.PIPE, start_new_session=True)
            drainer = threading.Thread(target=drain, args=(child.stderr,), daemon=True)
            drainer.start()
            deadline = time.monotonic() + request["timeout_s"]
            interrupted = False
            timed_out = False
            while child.poll() is None:
                timed_out = timed_out or time.monotonic() >= deadline
                if not interrupted and (timed_out or os.path.exists(os.path.join(job, "cancel"))):
                    interrupted = True
                    if timed_out:
                        timed_out_marker()
                    try:
                        os.killpg(child.pid, signal.SIGINT)
                    except OSError:
                        pass
                time.sleep(0.2)
            # A descendant can still hold stderr after the leader exits. Do
            # not publish completion until that stream has actually closed.
            while drainer.is_alive():
                drainer.join(0.2)
                if time.monotonic() >= deadline:
                    timed_out = True
                    timed_out_marker()
            result = {"exit_code": child.returncode, "stdout_bytes": os.path.getsize(request["stdout"]),
                      "timed_out": timed_out, "cancelled": interrupted and not timed_out,
                      "stderr": bytes(stderr_tail).decode("utf-8", "replace")}
            if stderr_errors:
                result["error"] = f"The REA command's stderr could not be read: {stderr_errors[0]}"
except Exception as error:
    result["error"] = f"The REA command supervisor failed: {error}"
    # Keep the child handle until it exits, including when cancellation arrives
    # after an unexpected supervisor error.
    while child is not None and child.poll() is None:
        if os.path.exists(os.path.join(job, "cancel")):
            try:
                os.killpg(child.pid, signal.SIGINT)
            except OSError:
                pass
        time.sleep(0.2)
    if drainer is not None and drainer.ident is not None:
        drainer.join()
    if child is not None:
        result.setdefault("exit_code", child.returncode)
        result.setdefault("stderr", bytes(stderr_tail).decode("utf-8", "replace"))
        try:
            result.setdefault("stdout_bytes", os.path.getsize(request["stdout"]))
        except OSError:
            pass
if child is None or child.poll() is not None:
    temporary = os.path.join(job, "result.tmp")
    with open(temporary, "w", encoding="utf-8") as out:
        json.dump(result, out)
    os.replace(temporary, os.path.join(job, "result.json"))
'''


def run_begin(arguments: dict) -> int:
    """Start one long REA command in its own capture-owned job folder."""
    rea = shutil.which("rea")
    if rea is None:
        return _say({"error": "REA is not installed in this computer"})
    job = os.path.abspath(arguments["job"])
    os.makedirs(os.path.dirname(job), exist_ok=True)
    try:
        os.mkdir(job, 0o700)
    except FileExistsError:
        return _say({"refused": "the command job folder is already used"})
    process = None
    try:
        with open(os.path.join(job, "owner"), "x", encoding="ascii") as out:
            out.write(arguments["token"])
        for path, text in arguments.get("files", {}).items():
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)
        os.makedirs(os.path.dirname(arguments["stdout"]), exist_ok=True)
        request = json.dumps({"argv": [rea, *arguments["argv"]], "stdout": arguments["stdout"],
                              "home": os.path.expanduser("~"), "timeout_s": arguments["timeout_s"]})
        chunks = [request[i:i + 60000] for i in range(0, len(request), 60000)]
        with open(os.path.join(job, "supervisor.log"), "wb") as log:
            process = subprocess.Popen([sys.executable, "-I", "-c", LONG_RUN, job, *chunks], cwd=os.path.expanduser("~"),
                                       env=_environment(os.path.abspath(arguments["work"])), stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, start_new_session=True)
    except (OSError, ValueError) as error:
        stage = "did not start" if process is None else "started but its setup did not finish"
        result = {"error": f"The REA command supervisor {stage}: {error}"}
        if process is None:
            temporary = os.path.join(job, "result.tmp")
            with open(temporary, "w", encoding="utf-8") as out:
                json.dump(result, out)
            os.replace(temporary, os.path.join(job, "result.json"))
        return _say(result)
    return _say({"started": True})


def _run_result(job: str):
    try:
        with open(os.path.join(job, "result.json"), encoding="utf-8") as source:
            return json.load(source)
    except FileNotFoundError:
        return None


def _owns_run(job: str, token: str) -> bool:
    try:
        with open(os.path.join(job, "owner"), encoding="ascii") as owner:
            return owner.read() == token
    except OSError:
        return False


def run_poll(arguments: dict) -> int:
    job = os.path.abspath(arguments["job"])
    if not _owns_run(job, arguments["token"]):
        return _say({"error": "the command job ownership is not confirmed"})
    deadline = time.monotonic() + arguments.get("timeout_s", 30)
    while (result := _run_result(job)) is None and time.monotonic() < deadline:
        time.sleep(POLL_S)
    if result is None:
        pending = {"pending": True, "timed_out": os.path.exists(os.path.join(job, "timed_out"))}
        progress = _tail(os.path.join(job, "supervisor.log"))
        return _say({**pending, **({"progress": progress} if progress else {})})
    return _say({"finished": True, **result})


def run_cancel(arguments: dict) -> int:
    job = os.path.abspath(arguments["job"])
    os.makedirs(os.path.dirname(job), exist_ok=True)
    try:
        os.mkdir(job, 0o700)
    except FileExistsError:
        pass
    else:
        # A late begin cannot launch into a folder cancellation claimed.
        with open(os.path.join(job, "owner"), "x", encoding="ascii") as owner:
            owner.write(arguments["token"])
        return _say({"absent": True})
    if not _owns_run(job, arguments["token"]):
        return _say({"error": "the command job ownership is not confirmed"})
    with open(os.path.join(job, "cancel"), "a", encoding="utf-8"):
        pass
    return run_poll(arguments)


def listing(arguments: dict) -> int:
    """Every regular file under a folder, by its path relative to the home, with its size and SHA-256.

    The list goes to the file ``output`` names, outside the folder, and the answer gives its size: a large
    bundle's list outgrows the 1 MiB of stdout a command answers with, so REA reads it through ``data/get``.
    """
    home = os.path.expanduser("~")
    files, skipped = [], []

    def fail_walk(error: OSError) -> None:
        raise error

    for directory, folders, names in os.walk(os.path.abspath(arguments["root"]), onerror=fail_walk):
        folders.sort()
        # os.walk does not follow directory symlinks; disclose them to the consumer.
        for name in folders[:]:
            path = os.path.join(directory, name)
            if os.path.islink(path):
                skipped.append(os.path.relpath(path, home))
                folders.remove(name)
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


COMMANDS = {"start": start, "mark": mark, "stop": stop, "run": run, "list": listing,
            "run-begin": run_begin, "run-poll": run_poll, "run-cancel": run_cancel}

if __name__ == "__main__":
    sys.exit(COMMANDS[sys.argv[1]](json.loads("".join(sys.argv[2:]))))
