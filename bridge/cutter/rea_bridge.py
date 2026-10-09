"""REA's experimental local bridge plugin for Cutter.

Install this file in Cutter's user plugin directory. The bridge is REA-owned
IPC, not an upstream Cutter transport. It binds to loopback and requires a
per-process random token stored in a user-only descriptor file.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import stat
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

import cutter

try:
    from PySide6.QtCore import QObject, Signal
except ImportError:
    from PySide2.QtCore import QObject, Signal


MAX_FRAME_BYTES = 16 * 1024 * 1024
SOCKET_TIMEOUT_SECONDS = 20
AUTH_FRAME_TIMEOUT_SECONDS = 1
MAX_DESCRIPTOR_BYTES = 64 * 1024


def _windows_api() -> tuple[Any, Any]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetFileAttributesW.restype = wintypes.DWORD
    kernel32.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, wintypes.LPVOID]
    kernel32.CreateDirectoryW.restype = wintypes.BOOL
    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                     wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                   ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    kernel32.WriteFile.restype = wintypes.BOOL
    kernel32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    kernel32.FlushFileBuffers.restype = wintypes.BOOL
    kernel32.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    kernel32.MoveFileExW.restype = wintypes.BOOL
    kernel32.DeleteFileW.argtypes = [wintypes.LPCWSTR]
    kernel32.DeleteFileW.restype = wintypes.BOOL
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID,
                                              wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = [wintypes.LPVOID, ctypes.POINTER(wintypes.LPWSTR)]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi32.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                                ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.LPVOID),
                                                ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.LPVOID),
                                                ctypes.POINTER(wintypes.LPVOID)]
    advapi32.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi32.GetSecurityDescriptorControl.argtypes = [wintypes.LPVOID, ctypes.POINTER(wintypes.WORD),
                                                       ctypes.POINTER(wintypes.DWORD)]
    advapi32.GetSecurityDescriptorControl.restype = wintypes.BOOL
    advapi32.EqualSid.argtypes = [wintypes.LPVOID, wintypes.LPVOID]
    advapi32.EqualSid.restype = wintypes.BOOL
    advapi32.GetAclInformation.argtypes = [wintypes.LPVOID, wintypes.LPVOID, wintypes.DWORD, ctypes.c_int]
    advapi32.GetAclInformation.restype = wintypes.BOOL
    advapi32.GetAce.argtypes = [wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID)]
    advapi32.GetAce.restype = wintypes.BOOL
    advapi32.IsValidSid.argtypes = [wintypes.LPVOID]
    advapi32.IsValidSid.restype = wintypes.BOOL
    advapi32.GetLengthSid.argtypes = [wintypes.LPVOID]
    advapi32.GetLengthSid.restype = wintypes.DWORD
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    return kernel32, advapi32


def _windows_user_sid_text() -> str:
    kernel32, advapi32 = _windows_api()
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        required = wintypes.DWORD()
        advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(required))
        if required.value == 0:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(required.value)
        if not advapi32.GetTokenInformation(token, 1, buffer, required, ctypes.byref(required)):
            raise ctypes.WinError(ctypes.get_last_error())

        class SID_AND_ATTRIBUTES(ctypes.Structure):
            _fields_ = [("Sid", wintypes.LPVOID), ("Attributes", wintypes.DWORD)]

        class TOKEN_USER(ctypes.Structure):
            _fields_ = [("User", SID_AND_ATTRIBUTES)]

        sid = ctypes.cast(buffer, ctypes.POINTER(TOKEN_USER)).contents.User.Sid
        text = wintypes.LPWSTR()
        if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return text.value
        finally:
            kernel32.LocalFree(text)
    finally:
        kernel32.CloseHandle(token)


def _verify_windows_private_path(path: Path, directory: bool) -> None:
    kernel32, advapi32 = _windows_api()
    attributes = kernel32.GetFileAttributesW(str(path))
    if attributes == 0xFFFFFFFF:
        raise ctypes.WinError(ctypes.get_last_error())
    if attributes & 0x400 or bool(attributes & 0x10) != directory:
        raise RuntimeError("Cutter bridge path is a reparse point or has the wrong object type")

    class ACL_SIZE_INFORMATION(ctypes.Structure):
        _fields_ = [("AceCount", wintypes.DWORD), ("AclBytesInUse", wintypes.DWORD), ("AclBytesFree", wintypes.DWORD)]

    class ACE_HEADER(ctypes.Structure):
        _fields_ = [("AceType", wintypes.BYTE), ("AceFlags", wintypes.BYTE), ("AceSize", wintypes.WORD)]

    class SID_HEADER(ctypes.Structure):
        _fields_ = [("Revision", wintypes.BYTE), ("SubAuthorityCount", wintypes.BYTE),
                    ("IdentifierAuthority", wintypes.BYTE * 6)]

    class ACCESS_ALLOWED_ACE(ctypes.Structure):
        _fields_ = [("Header", ACE_HEADER), ("Mask", wintypes.DWORD), ("SidStart", wintypes.DWORD)]

    owner = wintypes.LPVOID()
    dacl = wintypes.LPVOID()
    descriptor = wintypes.LPVOID()
    result = advapi32.GetNamedSecurityInfoW(
        str(path), 1, 0x1 | 0x4, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor),
    )
    if result != 0:
        raise ctypes.WinError(result)
    try:
        control = wintypes.WORD()
        revision = wintypes.DWORD()
        if not advapi32.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not control.value & 0x1000 or not dacl:
            raise RuntimeError("Cutter bridge ACL must be present and protected from inheritance")

        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            required = wintypes.DWORD()
            advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(required))
            token_user = ctypes.create_string_buffer(required.value)
            if not advapi32.GetTokenInformation(token, 1, token_user, required, ctypes.byref(required)):
                raise ctypes.WinError(ctypes.get_last_error())

            class SID_AND_ATTRIBUTES(ctypes.Structure):
                _fields_ = [("Sid", wintypes.LPVOID), ("Attributes", wintypes.DWORD)]

            class TOKEN_USER(ctypes.Structure):
                _fields_ = [("User", SID_AND_ATTRIBUTES)]

            current_sid = ctypes.cast(token_user, ctypes.POINTER(TOKEN_USER)).contents.User.Sid
            if not advapi32.EqualSid(owner, current_sid):
                raise RuntimeError("Cutter bridge path owner does not match the current user")
        finally:
            kernel32.CloseHandle(token)

        info = ACL_SIZE_INFORMATION()
        if not advapi32.GetAclInformation(dacl, ctypes.byref(info), ctypes.sizeof(info), 2) or info.AceCount != 2:
            raise RuntimeError("Cutter bridge ACL must allow only the current user and SYSTEM")
        expected_user = _windows_user_sid_text()
        user_allowed = False
        system_allowed = False
        for index in range(info.AceCount):
            ace_pointer = wintypes.LPVOID()
            if not advapi32.GetAce(dacl, index, ctypes.byref(ace_pointer)):
                raise ctypes.WinError(ctypes.get_last_error())
            header = ctypes.cast(ace_pointer, ctypes.POINTER(ACE_HEADER)).contents
            if header.AceType != 0 or header.AceSize < ctypes.sizeof(ACE_HEADER) + ctypes.sizeof(wintypes.DWORD) + ctypes.sizeof(SID_HEADER):
                raise RuntimeError("Cutter bridge ACL contains a malformed or unsupported ACE")
            ace_address = ctypes.cast(ace_pointer, ctypes.c_void_p).value
            if ace_address is None:
                raise RuntimeError("Cutter bridge ACL returned a null ACE")
            sid_pointer = ctypes.c_void_p(ace_address + ctypes.sizeof(ACE_HEADER) + ctypes.sizeof(wintypes.DWORD))
            sid_header = ctypes.cast(sid_pointer, ctypes.POINTER(SID_HEADER)).contents
            sid_size = ctypes.sizeof(SID_HEADER) + sid_header.SubAuthorityCount * ctypes.sizeof(wintypes.DWORD)
            if sid_size > header.AceSize - ctypes.sizeof(ACE_HEADER) - ctypes.sizeof(wintypes.DWORD) or not advapi32.IsValidSid(sid_pointer) or advapi32.GetLengthSid(sid_pointer) != sid_size:
                raise RuntimeError("Cutter bridge ACL contains an invalid SID")
            ace = ctypes.cast(ace_pointer, ctypes.POINTER(ACCESS_ALLOWED_ACE)).contents
            sid_text = wintypes.LPWSTR()
            if ace.Mask != 0x001F01FF or ace.Header.AceFlags != 0x03:
                raise RuntimeError("Cutter bridge ACL contains an unsupported ACE")
            if not advapi32.ConvertSidToStringSidW(sid_pointer, ctypes.byref(sid_text)):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                if sid_text.value == expected_user:
                    user_allowed = True
                elif sid_text.value == "S-1-5-18":
                    system_allowed = True
                else:
                    raise RuntimeError("Cutter bridge ACL allows an unrelated principal")
            finally:
                kernel32.LocalFree(sid_text)
        if not user_allowed or not system_allowed:
            raise RuntimeError("Cutter bridge ACL must allow only the current user and SYSTEM")
    finally:
        kernel32.LocalFree(descriptor)


def _windows_security_attributes() -> tuple[Any, Any]:
    kernel32, advapi32 = _windows_api()
    sid = _windows_user_sid_text()
    sddl = f"O:{sid}G:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)"
    descriptor = wintypes.LPVOID()
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", wintypes.LPVOID), ("bInheritHandle", wintypes.BOOL)]

    attributes = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), descriptor, False)
    return kernel32, (descriptor, attributes)


def _ensure_windows_bridge_directory(directory: Path) -> None:
    directory.parent.mkdir(parents=True, exist_ok=True)
    if not directory.exists():
        kernel32, (descriptor, attributes) = _windows_security_attributes()
        try:
            if not kernel32.CreateDirectoryW(str(directory), ctypes.byref(attributes)):
                error = ctypes.get_last_error()
                if error != 183:
                    raise ctypes.WinError(error)
        finally:
            kernel32.LocalFree(descriptor)
    _verify_windows_private_path(directory, True)


def _ensure_posix_bridge_directory(directory: Path) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise RuntimeError("Cutter bridge directory requires no-follow directory handles")
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        directory_info = os.fstat(descriptor)
        if directory_info.st_uid != os.getuid():
            raise RuntimeError("Cutter bridge directory must be owned by the current user")
        os.fchmod(descriptor, 0o700)
        directory_info = os.fstat(descriptor)
        if stat.S_IMODE(directory_info.st_mode) != 0o700:
            raise RuntimeError("Cutter bridge directory must have mode 0700")
    finally:
        os.close(descriptor)


def _write_windows_descriptor(directory: Path, destination: Path, payload: bytes) -> None:
    if len(payload) > MAX_DESCRIPTOR_BYTES:
        raise RuntimeError("Cutter bridge descriptor exceeds its byte limit")
    kernel32, (security_descriptor, attributes) = _windows_security_attributes()
    temporary = directory / f".{destination.name}.{uuid.uuid4().hex}.tmp"
    handle = wintypes.HANDLE()
    try:
        handle = kernel32.CreateFileW(str(temporary), 0x40000000 | 0x00020000 | 0x00040000,
                                      0x1 | 0x2 | 0x4, ctypes.byref(attributes), 1, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        _verify_windows_private_path(temporary, False)
        if payload:
            data = ctypes.create_string_buffer(payload)
            written = wintypes.DWORD()
            if not kernel32.WriteFile(handle, data, len(payload), ctypes.byref(written), None) or written.value != len(payload):
                raise ctypes.WinError(ctypes.get_last_error())
        if not kernel32.FlushFileBuffers(handle):
            raise ctypes.WinError(ctypes.get_last_error())
        kernel32.CloseHandle(handle)
        handle = wintypes.HANDLE()
        if not kernel32.MoveFileExW(str(temporary), str(destination), 0x1 | 0x8):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if handle and handle != wintypes.HANDLE(-1).value:
            kernel32.CloseHandle(handle)
        kernel32.DeleteFileW(str(temporary))
        kernel32.LocalFree(security_descriptor)


def _bridge_directory() -> Path:
    configured = os.environ.get("REA_CUTTER_BRIDGE_DIR")
    if configured:
        return Path(configured).expanduser()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local_app_data:
        return Path(local_app_data) / "REA" / "CutterBridge"
    return Path.home() / ".cache" / "rea" / "cutter-bridge"


class _RequestDispatcher(QObject):
    dispatch = Signal(object, object)

    def __init__(self) -> None:
        super().__init__()
        self.dispatch.connect(self._handle)
        self.generation = 0
        self.current_file = self._read_current_file()
        try:
            self.cutter_version = str(cutter.core().getVersionInformation())
        except Exception:
            self.cutter_version = None

    @staticmethod
    def _read_current_file() -> str | None:
        try:
            value = cutter.core().currentlyOpenFile()
            return str(value) if value else None
        except Exception:
            return None

    def _handle(self, request: dict[str, Any], reply: dict[str, Any]) -> None:
        if request["_cancelled"].is_set():
            reply.update({"ok": False, "error": "request-cancelled-before-execution", "execution_state": "not_started"})
            request["_event"].set()
            return
        self._refresh_document_identity()
        if request.get("kind") == "status":
            reply.update({
                "ok": True,
                "session_id": request.get("session_id"),
                "current_file": self.current_file,
                "document_generation": self.generation,
                "cutter_version": self.cutter_version,
                "identity_status": "partial",
            })
            request["_event"].set()
            return
        if request.get("expected_generation") != self.generation:
            reply.update({"ok": False, "error": "active-document-generation-changed"})
            request["_event"].set()
            return
        command = request.get("command")
        if not isinstance(command, str) or not command.strip():
            reply.update({"ok": False, "error": "invalid-command"})
            request["_event"].set()
            return
        reply["execution_state"] = "running"
        try:
            output = cutter.cmdj(command) if request.get("json") is True else cutter.cmd(command)
            command_error = None
        except Exception as error:
            output = None
            command_error = str(error)
        self._refresh_document_identity()
        if command_error is None:
            reply.update({
                "ok": True,
                "output": output,
                "current_file": self.current_file,
                "document_generation": self.generation,
                "cutter_version": self.cutter_version,
                "identity_status": "partial",
                "execution_state": "complete",
            })
        else:
            reply.update({
                "ok": False,
                "error": command_error,
                "current_file": self.current_file,
                "document_generation": self.generation,
                "cutter_version": self.cutter_version,
                "identity_status": "partial",
                "execution_state": "unknown",
                "message": "The command raised an exception; it may have produced partial effects. Do not retry automatically.",
            })
        request["_event"].set()

    def _refresh_document_identity(self) -> None:
        current_file = self._read_current_file()
        if current_file != self.current_file:
            self.current_file = current_file
            self.generation += 1


class _BridgeServer(threading.Thread):
    def __init__(self, dispatcher: _RequestDispatcher) -> None:
        super().__init__(name="rea-cutter-bridge", daemon=True)
        self.dispatcher = dispatcher
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.server.settimeout(0.5)
        self.port = self.server.getsockname()[1]
        self.session_id = str(uuid.uuid4())
        self.token = secrets.token_urlsafe(32)
        self.poisoned = False
        self.directory = _bridge_directory()
        self.descriptor = self.directory / f"cutter-{os.getpid()}-{self.session_id}.json"

    def publish(self) -> None:
        if os.name == "nt":
            _ensure_windows_bridge_directory(self.directory)
        else:
            _ensure_posix_bridge_directory(self.directory)
        if os.name == "nt" and (self.directory.is_symlink() or not self.directory.is_dir()):
            raise RuntimeError("Cutter bridge directory must be a real directory")
        payload = {
            "session_id": self.session_id,
            "pid": os.getpid(),
            "host": "127.0.0.1",
            "port": self.port,
            "token": self.token,
            "document_generation": self.dispatcher.generation,
            "current_file": self.dispatcher.current_file,
            "cutter_version": self.dispatcher.cutter_version,
            "identity_status": "partial",
        }
        if os.name == "nt":
            _write_windows_descriptor(self.directory, self.descriptor, json.dumps(payload).encode("utf-8"))
            return
        descriptor, temporary_path = tempfile.mkstemp(prefix=f".{self.descriptor.name}.", dir=self.directory)
        try:
            os.fchmod(descriptor, 0o600)
            descriptor_info = os.fstat(descriptor)
            if descriptor_info.st_uid != os.getuid() or stat.S_IMODE(descriptor_info.st_mode) & 0o077:
                raise RuntimeError("Cutter bridge descriptor must be owned by the current user with mode 0600")
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(payload))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, self.descriptor)
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
            raise

    def run(self) -> None:
        try:
            self.publish()
        except Exception:
            self.server.close()
            return
        while True:
            try:
                connection, _ = self.server.accept()
            except socket.timeout:
                if getattr(self, "stopping", False):
                    break
                continue
            except OSError:
                break
            with connection:
                connection.settimeout(AUTH_FRAME_TIMEOUT_SECONDS)
                authenticated = False
                try:
                    data = bytearray()
                    frame_started = time.monotonic()
                    while b"\n" not in data and len(data) <= MAX_FRAME_BYTES:
                        remaining = AUTH_FRAME_TIMEOUT_SECONDS - (time.monotonic() - frame_started)
                        if remaining <= 0:
                            raise socket.timeout("authentication frame timed out")
                        connection.settimeout(remaining)
                        part = connection.recv(65536)
                        if not part:
                            break
                        data.extend(part)
                    if len(data) > MAX_FRAME_BYTES:
                        self._send(connection, {"ok": False, "error": "frame-limit-exceeded"})
                        continue
                    request = json.loads(bytes(data).split(b"\n", 1)[0])
                    if not isinstance(request, dict) or request.get("token") != self.token:
                        self._send(connection, {"ok": False, "error": "authentication-failed"})
                        continue
                    authenticated = True
                    connection.settimeout(SOCKET_TIMEOUT_SECONDS)
                    if self.poisoned:
                        self._send(connection, {"ok": False, "error": "session-poisoned-after-ui-timeout"})
                        continue
                    request["session_id"] = self.session_id
                    event = threading.Event()
                    cancelled = threading.Event()
                    reply: dict[str, Any] = {}
                    request["_event"] = event
                    request["_cancelled"] = cancelled
                    self.dispatcher.dispatch.emit(request, reply)
                    if not event.wait(SOCKET_TIMEOUT_SECONDS):
                        cancelled.set()
                        self.poisoned = True
                        self._send(connection, {
                            "ok": False,
                            "error": "ui-thread-request-timeout",
                            "execution_state": "unknown",
                            "message": "The UI operation may still complete after this timeout; restart Cutter before issuing further commands.",
                        })
                    else:
                        self._send(connection, reply)
                except socket.timeout:
                    if authenticated:
                        self._send(connection, {
                            "ok": False,
                            "error": "request-timeout",
                            "execution_state": "unknown",
                            "message": "The command may have produced partial or persistent effects. Do not retry automatically.",
                        })
                except Exception as error:
                    self._send(connection, {"ok": False, "error": str(error)})
        self.server.close()
        try:
            self.descriptor.unlink(missing_ok=True)
        except OSError:
            pass

    @staticmethod
    def _send(connection: socket.socket, value: dict[str, Any]) -> None:
        if not _within_response_limit(value):
            value = {
                "ok": False,
                "error": "response-limit-exceeded",
                "execution_state": value.get("execution_state", "unknown"),
                "output_truncated": True,
                "message": "The command completed or may have completed, but its result exceeded the bridge response limit. Do not retry automatically.",
            }
        parts: list[bytes] = []
        encoded_size = 0
        for part in json.JSONEncoder(ensure_ascii=False).iterencode(value):
            encoded_part = part.encode("utf-8")
            encoded_size += len(encoded_part)
            if encoded_size > MAX_FRAME_BYTES:
                fallback = {
                    "ok": False,
                    "error": "response-limit-exceeded",
                    "execution_state": value.get("execution_state", "unknown"),
                    "output_truncated": True,
                    "message": "The command completed or may have completed, but its result exceeded the bridge response limit. Do not retry automatically.",
                }
                parts = [json.dumps(fallback, separators=(",", ":")).encode("utf-8")]
                break
            parts.append(encoded_part)
        encoded = b"".join(parts)
        try:
            connection.sendall(encoded + b"\n")
        except OSError:
            # A disconnected caller must not terminate the bridge thread or
            # prevent later commands from being served.
            pass

    def stop(self) -> None:
        self.stopping = True
        try:
            self.server.close()
        except OSError:
            pass


class ReaCutterPlugin(cutter.CutterPlugin):
    name = "REA Local Bridge"
    description = "Local REA analysis bridge for the active Cutter session"
    version = "1.0"
    author = "REA"

    def __init__(self) -> None:
        super().__init__()
        self._dispatcher: _RequestDispatcher | None = None
        self._bridge: _BridgeServer | None = None

    def setupPlugin(self) -> None:
        return

    def setupInterface(self, main: Any) -> None:
        self._dispatcher = _RequestDispatcher()
        self._bridge = _BridgeServer(self._dispatcher)
        self._bridge.start()

    def terminate(self) -> None:
        if self._bridge is not None:
            self._bridge.stop()
            self._bridge.join(timeout=2)
            self._bridge = None
        self._dispatcher = None


def create_cutter_plugin() -> ReaCutterPlugin:
    return ReaCutterPlugin()


def _within_response_limit(value: Any) -> bool:
    pending = [value]
    seen: set[int] = set()
    size = 0
    while pending:
        current = pending.pop()
        if isinstance(current, str):
            size += 2
            if current.isascii():
                size += len(current)
                size += current.count('"') + current.count("\\")
                size += sum(5 for character in current if ord(character) < 0x20)
            else:
                size += 4 * len(current)
                size += current.count('"') + current.count("\\")
                size += sum(5 for character in current if ord(character) < 0x20)
        elif isinstance(current, dict):
            identity = id(current)
            if identity in seen:
                return False
            seen.add(identity)
            size += 2 + 4 * len(current)
            if size > MAX_FRAME_BYTES:
                return False
            pending.extend(current.keys())
            pending.extend(current.values())
        elif isinstance(current, (list, tuple)):
            identity = id(current)
            if identity in seen:
                return False
            seen.add(identity)
            size += 2 + 2 * len(current)
            if size > MAX_FRAME_BYTES:
                return False
            pending.extend(current)
        else:
            size += 16
        if size > MAX_FRAME_BYTES:
            return False
    return True
