#!/usr/bin/env python3
"""Inspect or activate Hopper's version-pinned demo dialog on a private X display."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
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


class AdapterFailure(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


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
    parser.add_argument("--hopper", required=True)
    parser.add_argument("--socket", required=True)
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


def start_xvfb(session: Path) -> tuple[subprocess.Popen[bytes], str, Path]:
    authority = session / "Xauthority"
    for _ in range(20):
        display_number = 100 + secrets.randbelow(900)
        display_name = f":{display_number}"
        if Path(f"/tmp/.X11-unix/X{display_number}").exists():
            continue
        cookie = secrets.token_hex(16)
        try:
            subprocess.run(
                [
                    "/usr/bin/xauth", "-f", str(authority), "add",
                    display_name, ".", cookie,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise AdapterFailure(
                X11_AUTHORIZATION_FAILED, "private X authorization failed"
            ) from error
        authority.chmod(0o600)
        process = subprocess.Popen(
            [
                "/usr/bin/Xvfb",
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
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 2
        socket = Path(f"/tmp/.X11-unix/X{display_number}")
        while time.monotonic() < deadline and process.poll() is None:
            if socket.exists():
                return process, display_name, authority
            time.sleep(0.05)
        if process.poll() is None:
            process.terminate()
        process.wait()
    raise AdapterFailure(PRIVATE_DISPLAY_UNAVAILABLE, "private X display unavailable")


def main() -> int:
    args = parse_args()
    hopper = Path(args.hopper)
    socket = Path(args.socket)
    if digest(hopper) not in SUPPORTED_HOPPER_SHA256:
        raise AdapterFailure(UNSUPPORTED_HOPPER_BUILD, "unsupported Hopper binary")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or Path(command[0]).resolve() != hopper.resolve():
        raise AdapterFailure(INVALID_LAUNCH_COMMAND, "invalid Hopper launch command")
    xvfb, display_name, authority = start_xvfb(socket.parent)
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
                RUNTIME_DEPENDENCY_UNAVAILABLE, "X11 runtime unavailable"
            ) from error
        configure_x11(x11, xtst)
        display = x11.XOpenDisplay(display_name.encode())
        if not display:
            raise AdapterFailure(PRIVATE_DISPLAY_UNAVAILABLE, "private X display unavailable")
        root = x11.XDefaultRootWindow(display)
        if (
            x11.XDisplayWidth(display, 0),
            x11.XDisplayHeight(display, 0),
        ) != EXPECTED_SCREEN:
            raise AdapterFailure(
                UNEXPECTED_DISPLAY_GEOMETRY, "unexpected private display geometry"
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
                    HOPPER_EXITED_DURING_STARTUP, "owned Hopper process exited"
                )
            observed = windows(x11, display, root)
            if any(window[1:] == EXPECTED_DIALOG for window in observed):
                break
            time.sleep(0.1)
        else:
            if not hopper_is_owned(leader, hopper):
                raise AdapterFailure(
                    PROCESS_OWNERSHIP_MISMATCH, "Hopper process ownership mismatch"
                )
            raise AdapterFailure(
                UNSUPPORTED_DEMO_DIALOG, "expected Hopper demo dialog not found"
            )

        input_results = (
            xtst.XTestFakeMotionEvent(display, -1, DEMO_CLICK[0], DEMO_CLICK[1], 0),
            xtst.XTestFakeButtonEvent(display, 1, True, 0),
            xtst.XTestFakeButtonEvent(display, 1, False, 0),
        )
        if not all(input_results):
            raise AdapterFailure(X11_INPUT_FAILED, "private X input failed")
        x11.XFlush(display)
        x11.XCloseDisplay(display)
        display = None
        return child.wait()
    finally:
        if display is not None:
            x11.XCloseDisplay(display)
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait()
        if xvfb.poll() is None:
            xvfb.terminate()
            try:
                xvfb.wait(timeout=2)
            except subprocess.TimeoutExpired:
                xvfb.kill()
                xvfb.wait()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AdapterFailure as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(error.code) from None
