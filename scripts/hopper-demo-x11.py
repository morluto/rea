#!/usr/bin/env python3
"""Inspect or activate Hopper's version-pinned demo dialog on a private X display."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import tempfile
import threading
import time


# Keep this digest aligned with LinuxHopper.ts and rerun real-Hopper verification
# before accepting another vendor build.
SUPPORTED_HOPPER_SHA256 = {
    "0294ced141cc373468ee22d8343e7dac41980cb05a937994ca81c9f09afe7ded"
}
EXPECTED_SCREEN = (1280, 1024)
EXPECTED_DIALOG = (189, 370, 901, 284)
DEMO_CLICK = (305, 632)
PRIVATE_DISPLAY_UNAVAILABLE = 70
X11_AUTHORIZATION_FAILED = 71
UNSUPPORTED_HOPPER_BUILD = 72
INVALID_LAUNCH_COMMAND = 73
PROCESS_OWNERSHIP_MISMATCH = 74
HOPPER_EXITED_DURING_STARTUP = 75
UNSUPPORTED_DEMO_DIALOG = 76
UNEXPECTED_DISPLAY_GEOMETRY = 77
X11_INPUT_FAILED = 78
RUNTIME_DEPENDENCY_UNAVAILABLE = 79
X11_SOCKET_DIRECTORY_UNUSABLE = 80
DIAGNOSTIC_PREFIX = "REA_X11_DIAGNOSTIC_V1="
X11_SOCKET_DIRECTORY = Path("/tmp/.X11-unix")
XVFB_STDERR_LIMIT = 16 * 1024


class AdapterFailure(Exception):
    def __init__(
        self,
        code: int,
        reason: str,
        message: str,
        stderr_bytes: int = 0,
        stderr_truncated: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.stderr_bytes = stderr_bytes
        self.stderr_truncated = stderr_truncated

    def with_stderr(self, capture: BoundedStderr) -> AdapterFailure:
        self.stderr_bytes, self.stderr_truncated, _ = capture.snapshot()
        return self


class BoundedStderr:
    def __init__(self, stream: object) -> None:
        self._stream = stream
        self._retained = bytearray()
        self._bytes = 0
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        while True:
            chunk = self._stream.read(4096)
            if not chunk:
                return
            with self._lock:
                self._bytes += len(chunk)
                remaining = XVFB_STDERR_LIMIT - len(self._retained)
                if remaining > 0:
                    self._retained.extend(chunk[:remaining])

    def snapshot(self) -> tuple[int, bool, str]:
        with self._lock:
            retained = bytes(self._retained)
            total = self._bytes
        return total, total > len(retained), retained.decode("utf-8", "replace")

    def close(self) -> None:
        self._thread.join(timeout=0.5)


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p),
        ("root", ctypes.c_ulong),
        ("class_", ctypes.c_int),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--hopper")
    parser.add_argument("--socket")
    parser.add_argument(
        "--strategy",
        choices=("direct", "user-mount-namespace"),
        default="direct",
    )
    parser.add_argument("--mount-private-x11", action="store_true")
    parser.add_argument("--xvfb", default="/usr/bin/Xvfb")
    parser.add_argument("--xauth", default="/usr/bin/xauth")
    parser.add_argument("--display-number", type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser.parse_args()


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def descendants(pid: int) -> set[int]:
    found = {pid}
    changed = True
    while changed:
        changed = False
        for stat in Path("/proc").glob("[0-9]*/stat"):
            try:
                fields = stat.read_text().split()
                child = int(fields[0])
                parent = int(fields[3])
            except (OSError, ValueError, IndexError):
                continue
            if parent in found and child not in found:
                found.add(child)
                changed = True
    return found


def hopper_is_owned(leader: int, hopper: Path) -> bool:
    expected = hopper.resolve()
    for pid in descendants(leader):
        try:
            if Path(f"/proc/{pid}/exe").resolve() == expected:
                return True
        except OSError:
            continue
    return False


def windows(x11: ctypes.CDLL, display: int, root: int) -> list[tuple[int, int, int, int, int]]:
    found: list[tuple[int, int, int, int, int]] = []
    pending = [root]
    while pending:
        window = pending.pop()
        attributes = XWindowAttributes()
        if x11.XGetWindowAttributes(display, window, ctypes.byref(attributes)):
            if attributes.map_state == 2:
                found.append(
                    (window, attributes.x, attributes.y, attributes.width, attributes.height)
                )
        root_return = ctypes.c_ulong()
        parent_return = ctypes.c_ulong()
        children = ctypes.POINTER(ctypes.c_ulong)()
        count = ctypes.c_uint()
        if x11.XQueryTree(
            display,
            window,
            ctypes.byref(root_return),
            ctypes.byref(parent_return),
            ctypes.byref(children),
            ctypes.byref(count),
        ):
            pending.extend(children[index] for index in range(count.value))
            if children:
                x11.XFree(children)
    return found


def configure_x11(x11: ctypes.CDLL, xtst: ctypes.CDLL) -> None:
    window_pointer = ctypes.POINTER(ctypes.c_ulong)
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDisplayWidth.restype = ctypes.c_int
    x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDisplayHeight.restype = ctypes.c_int
    x11.XGetWindowAttributes.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.POINTER(XWindowAttributes),
    ]
    x11.XGetWindowAttributes.restype = ctypes.c_int
    x11.XQueryTree.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        window_pointer,
        window_pointer,
        ctypes.POINTER(window_pointer),
        ctypes.POINTER(ctypes.c_uint),
    ]
    x11.XQueryTree.restype = ctypes.c_int
    x11.XFree.argtypes = [ctypes.c_void_p]
    x11.XFree.restype = ctypes.c_int
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XFlush.restype = ctypes.c_int
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.restype = ctypes.c_int
    xtst.XTestFakeMotionEvent.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_ulong,
    ]
    xtst.XTestFakeMotionEvent.restype = ctypes.c_int
    xtst.XTestFakeButtonEvent.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_ulong,
    ]
    xtst.XTestFakeButtonEvent.restype = ctypes.c_int


def is_wsl() -> bool:
    for path in (Path("/proc/sys/kernel/osrelease"), Path("/proc/version")):
        try:
            if "microsoft" in path.read_text().lower():
                return True
        except OSError:
            continue
    return False


def socket_directory_state() -> tuple[str | None, bool | None, bool]:
    try:
        value = X11_SOCKET_DIRECTORY.lstat()
    except FileNotFoundError:
        try:
            read_only = bool(os.statvfs(X11_SOCKET_DIRECTORY.parent).f_flag & os.ST_RDONLY)
        except OSError:
            read_only = None
        return None, read_only, False
    except OSError:
        return None, None, False
    try:
        read_only = bool(os.statvfs(X11_SOCKET_DIRECTORY).f_flag & os.ST_RDONLY)
    except OSError:
        read_only = None
    return f"{stat.S_IMODE(value.st_mode):04o}", read_only, stat.S_ISDIR(value.st_mode)


def diagnostic(
    args: argparse.Namespace,
    operation: str,
    status: str,
    failure: AdapterFailure | None = None,
    capture: BoundedStderr | None = None,
) -> dict[str, object]:
    mode, read_only, _ = socket_directory_state()
    captured_bytes, captured_truncated, _ = (
        (0, False, "") if capture is None else capture.snapshot()
    )
    return {
        "schema_version": 1,
        "component": "hopper_private_display",
        "operation": operation,
        "status": status,
        "failure_code": None if failure is None else failure_name(failure.code),
        "reason": "ready" if failure is None else failure.reason,
        "socket_directory": str(X11_SOCKET_DIRECTORY),
        "socket_directory_mode": mode,
        "mount_read_only": read_only,
        "effective_socket_directory_mode": mode,
        "effective_mount_read_only": read_only,
        "wsl": is_wsl(),
        "strategy": args.strategy,
        "fallback_reason": None,
        "xvfb_stderr_bytes": captured_bytes
        if failure is None
        else failure.stderr_bytes,
        "xvfb_stderr_truncated": captured_truncated
        if failure is None
        else failure.stderr_truncated,
    }


def failure_name(code: int) -> str:
    return {
        PRIVATE_DISPLAY_UNAVAILABLE: "private_display_unavailable",
        X11_AUTHORIZATION_FAILED: "x11_authorization_failed",
        UNSUPPORTED_HOPPER_BUILD: "unsupported_hopper_build",
        INVALID_LAUNCH_COMMAND: "invalid_launch_command",
        PROCESS_OWNERSHIP_MISMATCH: "process_ownership_mismatch",
        HOPPER_EXITED_DURING_STARTUP: "hopper_exited_during_startup",
        UNSUPPORTED_DEMO_DIALOG: "unsupported_demo_dialog",
        UNEXPECTED_DISPLAY_GEOMETRY: "unexpected_display_geometry",
        X11_INPUT_FAILED: "x11_input_failed",
        RUNTIME_DEPENDENCY_UNAVAILABLE: "runtime_dependency_unavailable",
        X11_SOCKET_DIRECTORY_UNUSABLE: "x11_socket_directory_unusable",
    }[code]


def emit_diagnostic(value: dict[str, object]) -> None:
    print(
        DIAGNOSTIC_PREFIX + json.dumps(value, sort_keys=True, separators=(",", ":")),
        file=os.sys.stderr,
    )


def mount_private_x11() -> None:
    try:
        mounted = subprocess.run(
            [
                "/usr/bin/mount",
                "-t",
                "tmpfs",
                "-o",
                "mode=1777,nosuid,nodev",
                "rea-x11",
                str(X11_SOCKET_DIRECTORY),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=2,
        )
    except FileNotFoundError as error:
        raise AdapterFailure(
            RUNTIME_DEPENDENCY_UNAVAILABLE,
            "missing_mount",
            "mount executable unavailable",
        ) from error
    except subprocess.TimeoutExpired as error:
        raise AdapterFailure(
            X11_SOCKET_DIRECTORY_UNUSABLE,
            "mount_failed",
            "private X11 mount timed out",
        ) from error
    if mounted.returncode != 0:
        raise AdapterFailure(
            X11_SOCKET_DIRECTORY_UNUSABLE,
            "mount_failed",
            "private X11 mount failed",
        )
    mode, read_only, directory = socket_directory_state()
    if not directory or mode != "1777" or read_only is not False:
        raise AdapterFailure(
            X11_SOCKET_DIRECTORY_UNUSABLE,
            "mount_validation_failed",
            "private X11 mount validation failed",
        )


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def authorize_display(
    authority: Path,
    display_name: str,
    xauth_path: str,
) -> None:
    try:
        authorized = subprocess.run(
            [
                xauth_path,
                "-f",
                str(authority),
                "add",
                display_name,
                ".",
                secrets.token_hex(16),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=2,
        )
    except FileNotFoundError as error:
        raise AdapterFailure(
            RUNTIME_DEPENDENCY_UNAVAILABLE,
            "missing_xauth",
            "xauth executable unavailable",
        ) from error
    except subprocess.TimeoutExpired as error:
        raise AdapterFailure(
            X11_AUTHORIZATION_FAILED,
            "xauth_failed",
            "private X authorization timed out",
        ) from error
    if authorized.returncode != 0:
        raise AdapterFailure(
            X11_AUTHORIZATION_FAILED,
            "xauth_failed",
            "private X authorization failed",
        )
    try:
        authority.chmod(0o600)
    except OSError as error:
        raise AdapterFailure(
            X11_AUTHORIZATION_FAILED,
            "xauth_failed",
            "private X authorization file unavailable",
        ) from error


def classify_xvfb_failure(capture: BoundedStderr) -> AdapterFailure:
    stderr_bytes, stderr_truncated, text = capture.snapshot()
    mode, read_only, directory = socket_directory_state()
    if read_only is True:
        return AdapterFailure(
            X11_SOCKET_DIRECTORY_UNUSABLE,
            "socket_directory_read_only",
            "X11 socket directory is read-only",
            stderr_bytes,
            stderr_truncated,
        )
    if directory and mode != "1777":
        return AdapterFailure(
            X11_SOCKET_DIRECTORY_UNUSABLE,
            "socket_directory_mode",
            "X11 socket directory mode is not 1777",
            stderr_bytes,
            stderr_truncated,
        )
    if mode is not None and not directory:
        return AdapterFailure(
            X11_SOCKET_DIRECTORY_UNUSABLE,
            "socket_directory_type",
            "X11 socket path is not a directory",
            stderr_bytes,
            stderr_truncated,
        )
    lowered = text.lower()
    if "error while loading shared libraries" in lowered:
        return AdapterFailure(
            RUNTIME_DEPENDENCY_UNAVAILABLE,
            "missing_library",
            "Xvfb shared library unavailable",
            stderr_bytes,
            stderr_truncated,
        )
    if any(
        marker in lowered
        for marker in (
            "server is already active for display",
            "address already in use",
            "cannot establish any listening sockets",
        )
    ):
        return AdapterFailure(
            PRIVATE_DISPLAY_UNAVAILABLE,
            "address_collision",
            "private display address collision",
            stderr_bytes,
            stderr_truncated,
        )
    return AdapterFailure(
        PRIVATE_DISPLAY_UNAVAILABLE,
        "xvfb_startup_failed",
        "private X display unavailable",
        stderr_bytes,
        stderr_truncated,
    )


def start_xvfb(
    session: Path,
    args: argparse.Namespace,
) -> tuple[subprocess.Popen[bytes], str, Path, BoundedStderr]:
    authority = session / "Xauthority"
    collision: AdapterFailure | None = None
    for _ in range(3):
        display_number = args.display_number or (100 + secrets.randbelow(900))
        display_name = f":{display_number}"
        if Path(f"/tmp/.X11-unix/X{display_number}").exists() or Path(
            f"/tmp/.X{display_number}-lock"
        ).exists():
            collision = AdapterFailure(
                PRIVATE_DISPLAY_UNAVAILABLE,
                "address_collision",
                "private display address collision",
            )
            if args.display_number is not None:
                raise collision
            continue
        authorize_display(authority, display_name, args.xauth)
        try:
            process = subprocess.Popen(
                [
                    args.xvfb,
                    display_name,
                    "-screen",
                    "0",
                    "1280x1024x24",
                    "-nolisten",
                    "tcp",
                    "-auth",
                    str(authority),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as error:
            raise AdapterFailure(
                RUNTIME_DEPENDENCY_UNAVAILABLE,
                "missing_xvfb",
                "Xvfb executable unavailable",
            ) from error
        if process.stderr is None:
            stop_process(process)
            raise AdapterFailure(
                PRIVATE_DISPLAY_UNAVAILABLE,
                "xvfb_startup_failed",
                "Xvfb stderr unavailable",
            )
        capture = BoundedStderr(process.stderr)
        deadline = time.monotonic() + 2
        socket = Path(f"/tmp/.X11-unix/X{display_number}")
        while time.monotonic() < deadline and process.poll() is None:
            if socket.is_socket():
                return process, display_name, authority, capture
            time.sleep(0.05)
        stop_process(process)
        capture.close()
        failure = classify_xvfb_failure(capture)
        if failure.reason != "address_collision" or args.display_number is not None:
            raise failure
        collision = failure
    raise collision or AdapterFailure(
        PRIVATE_DISPLAY_UNAVAILABLE,
        "address_collision",
        "private display address collision",
    )


def run_probe(args: argparse.Namespace) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="rea-x11-probe-", dir="/tmp") as root:
        xvfb, _, _, capture = start_xvfb(Path(root), args)
        try:
            stop_process(xvfb)
            capture.close()
            return diagnostic(args, "probe", "ready", capture=capture)
        finally:
            stop_process(xvfb)
            capture.close()


def run_launch(args: argparse.Namespace) -> int:
    if args.hopper is None or args.socket is None:
        raise AdapterFailure(
            INVALID_LAUNCH_COMMAND,
            "invalid_launch_command",
            "missing Hopper launch coordinates",
        )
    hopper = Path(args.hopper)
    socket = Path(args.socket)
    try:
        supported = digest(hopper) in SUPPORTED_HOPPER_SHA256
    except OSError as error:
        raise AdapterFailure(
            INVALID_LAUNCH_COMMAND,
            "invalid_launch_command",
            "Hopper binary unavailable",
        ) from error
    if not supported:
        raise AdapterFailure(
            UNSUPPORTED_HOPPER_BUILD,
            "unsupported_hopper_build",
            "unsupported Hopper binary",
        )
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or Path(command[0]).resolve() != hopper.resolve():
        raise AdapterFailure(
            INVALID_LAUNCH_COMMAND,
            "invalid_launch_command",
            "invalid Hopper launch command",
        )
    xvfb, display_name, authority, capture = start_xvfb(socket.parent, args)
    child: subprocess.Popen[bytes] | None = None
    display: int | None = None
    try:
        hopper_environment = dict(os.environ)
        for name in ("WAYLAND_DISPLAY", "WAYLAND_SOCKET"):
            hopper_environment.pop(name, None)
        hopper_environment.update(
            {
                "DISPLAY": display_name,
                "XAUTHORITY": str(authority),
                "GDK_BACKEND": "x11",
                "QT_QPA_PLATFORM": "xcb",
                "XDG_SESSION_TYPE": "x11",
            }
        )
        child = subprocess.Popen(command, env=hopper_environment)
        leader = os.getpid()
        os.environ["XAUTHORITY"] = str(authority)

        try:
            x11 = ctypes.CDLL("libX11.so.6")
            xtst = ctypes.CDLL("libXtst.so.6")
        except OSError as error:
            raise AdapterFailure(
                RUNTIME_DEPENDENCY_UNAVAILABLE,
                "missing_library",
                "X11 runtime unavailable",
            ) from error
        configure_x11(x11, xtst)
        display = x11.XOpenDisplay(display_name.encode())
        if not display:
            raise AdapterFailure(
                PRIVATE_DISPLAY_UNAVAILABLE,
                "x11_connection_failed",
                "private X display unavailable",
            )
        root = x11.XDefaultRootWindow(display)
        if (
            x11.XDisplayWidth(display, 0),
            x11.XDisplayHeight(display, 0),
        ) != EXPECTED_SCREEN:
            raise AdapterFailure(
                UNEXPECTED_DISPLAY_GEOMETRY,
                "unexpected_display_geometry",
                "unexpected private display geometry",
            )

        deadline = time.monotonic() + 10
        observed: list[tuple[int, int, int, int, int]] = []
        while time.monotonic() < deadline:
            if socket.exists():
                x11.XCloseDisplay(display)
                display = None
                return child.wait()
            if not hopper_is_owned(leader, hopper):
                if child.poll() is None:
                    time.sleep(0.1)
                    continue
                raise AdapterFailure(
                    HOPPER_EXITED_DURING_STARTUP,
                    "hopper_exited_during_startup",
                    "owned Hopper process exited",
                )
            observed = windows(x11, display, root)
            if any(window[1:] == EXPECTED_DIALOG for window in observed):
                break
            time.sleep(0.1)
        else:
            if not hopper_is_owned(leader, hopper):
                raise AdapterFailure(
                    PROCESS_OWNERSHIP_MISMATCH,
                    "process_ownership_mismatch",
                    "Hopper process ownership mismatch",
                )
            raise AdapterFailure(
                UNSUPPORTED_DEMO_DIALOG,
                "unsupported_demo_dialog",
                "expected Hopper demo dialog not found",
            )

        input_results = (
            xtst.XTestFakeMotionEvent(display, -1, DEMO_CLICK[0], DEMO_CLICK[1], 0),
            xtst.XTestFakeButtonEvent(display, 1, True, 0),
            xtst.XTestFakeButtonEvent(display, 1, False, 0),
        )
        if not all(input_results):
            raise AdapterFailure(
                X11_INPUT_FAILED,
                "x11_input_failed",
                "private X input failed",
            )
        x11.XFlush(display)
        x11.XCloseDisplay(display)
        display = None
        return child.wait()
    except AdapterFailure as error:
        raise error.with_stderr(capture)
    finally:
        if display is not None:
            x11.XCloseDisplay(display)
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait()
        stop_process(xvfb)
        capture.close()


def main() -> int:
    args = parse_args()
    try:
        if args.mount_private_x11:
            mount_private_x11()
        if args.probe:
            emit_diagnostic(run_probe(args))
            return 0
        return run_launch(args)
    except AdapterFailure as error:
        emit_diagnostic(diagnostic(args, "probe" if args.probe else "launch", "error", error))
        return error.code
    except Exception:
        failure = AdapterFailure(
            PRIVATE_DISPLAY_UNAVAILABLE,
            "unexpected_failure",
            "private display adapter failed",
        )
        emit_diagnostic(diagnostic(args, "probe" if args.probe else "launch", "error", failure))
        return failure.code


if __name__ == "__main__":
    raise SystemExit(main())
